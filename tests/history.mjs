// Unit tests for the usage aggregation (dist/history.js): the legacy
// "last N days" contract, arbitrary since/until ranges, week/month grouping,
// per-session rollups, and the project/model filters. Everything is pure —
// `nowMs` is injected, nothing touches the clock or the filesystem.
// Run: node tests/history.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { aggregate, historyOptions, isoWeekKey, dayKey, monthKey, parseTranscriptLine, projectLabel } =
  await import(path.join(PLUGIN, 'dist/history.js'));

const errs = [];
const ok = (c, m) => {
  if (!c) errs.push(m);
};
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ~${b})`);

/** Fixed clock: Wednesday 2026-08-26 10:00 UTC. */
const NOW = Date.parse('2026-08-26T10:00:00Z');

let seq = 0;
const tok = (input, output = 0, cw = 0, cr = 0) => ({
  input,
  output,
  cacheCreate: cw,
  cacheRead: cr,
});
const entry = (iso, model, tokens, id) => ({
  id: id ?? `m${seq++}`,
  timestamp: iso,
  model,
  tokens,
});

const OPUS = 'claude-opus-4-1';   // 15 / 75 / 18.75 / 1.5 per M
const SONNET = 'claude-sonnet-5'; //  3 / 15 /  3.75 / 0.3 per M

/** Two projects, three transcripts, spread over two months. */
function fixture() {
  seq = 0;
  return [
    {
      id: 'aaaaaaaa-1111-4000-8000-000000000001',
      project: 'alpha',
      entries: [
        entry('2026-08-26T09:00:00Z', OPUS, tok(1000, 100, 10, 5)),
        entry('2026-08-26T09:30:00Z', OPUS, tok(2000, 200, 20, 10)),
        entry('2026-08-24T12:00:00Z', SONNET, tok(500, 50, 0, 0)),
      ],
    },
    {
      id: 'bbbbbbbb-2222-4000-8000-000000000002',
      project: 'beta',
      entries: [
        entry('2026-08-20T08:00:00Z', SONNET, tok(300, 30, 0, 0)),
        entry('2026-07-15T08:00:00Z', SONNET, tok(700, 70, 0, 0)),
      ],
    },
    {
      id: 'cccccccc-3333-4000-8000-000000000003',
      project: 'alpha',
      entries: [
        // Malformed timestamp: skipped everywhere, and must not create a session row.
        entry('not-a-date', SONNET, tok(9999, 9999, 9999, 9999)),
      ],
    },
  ];
}

// ── 1. The pre-2.1 contract: aggregate(sessions, days, nowMs) ───────────
{
  const r = aggregate(fixture(), 30, NOW);
  eq(r.daily.length, 30, 'legacy call still returns exactly `days` buckets');
  eq(r.daily[0].date, '2026-07-28', 'window starts days-1 before today (UTC)');
  eq(r.daily[29].date, '2026-08-26', 'window ends on today');
  eq(r.totals.messages, 4, 'the July entry is outside a 30-day window');
  eq(r.totals.sessions, 2, 'two transcripts were active in the window');
  eq(r.byModel[0].model, OPUS, 'byModel is ranked by total tokens, biggest first');
  eq(r.byProject.map((p) => p.project).join(','), 'alpha,beta', 'byProject is ranked too');
  // Zero-filled days really are zero, not missing.
  const quiet = r.daily.find((d) => d.date === '2026-08-25');
  eq(quiet.tokens.input, 0, 'a day with no usage is present and zeroed');
  eq(quiet.cost, 0, 'a zero-filled day costs nothing');
  // Cost: 3000 input + 300 output + 30 cache-write + 15 cache-read on Opus 4.1,
  // plus 800 input + 80 output on Sonnet.
  const wantOpus = (3000 * 15 + 300 * 75 + 30 * 18.75 + 15 * 1.5) / 1e6;
  const wantSonnet = (800 * 3 + 80 * 15) / 1e6;
  near(r.totals.cost, wantOpus + wantSonnet, 1e-9, 'total cost matches the price table');
}

// ── 2. Explicit since/until, inclusive start / exclusive end ────────────
{
  const r = aggregate(fixture(), {
    sinceMs: Date.parse('2026-08-24T00:00:00Z'),
    untilMs: Date.parse('2026-08-26T00:00:00Z'), // excludes the 26th entirely
    nowMs: NOW,
  });
  eq(r.daily.length, 2, 'two-day range yields two buckets');
  eq(r.totals.messages, 1, 'only the Aug 24 entry falls inside');
  eq(r.daily[0].date, '2026-08-24', 'first bucket is the since day');
  eq(r.daily[1].messages, 0, 'the 25th is zero-filled');
  eq(r.range.sinceMs, Date.parse('2026-08-24T00:00:00Z'), 'the range is echoed back');
}

// ── 3. All time: no days, no since -> starts at the oldest entry ────────
{
  const r = aggregate(fixture(), { nowMs: NOW });
  eq(r.range.sinceMs, Date.parse('2026-07-15T08:00:00Z'), 'all-time starts at the earliest entry');
  eq(r.totals.messages, 5, 'all-time counts every parseable entry');
  eq(r.totals.sessions, 2, 'the transcript with only a bad timestamp is not an active session');
  ok(r.daily.length >= 42, `all-time day series spans the whole range, got ${r.daily.length}`);
}

// ── 4. Week grouping ───────────────────────────────────────────────────
{
  const r = aggregate(fixture(), { nowMs: NOW, groupBy: 'week' });
  eq(r.groupBy, 'week', 'groupBy is echoed back');
  const keys = r.periods.map((p) => p.key);
  ok(
    keys.every((k, i) => i === 0 || k > keys[i - 1]),
    'week buckets are ascending and unique',
  );
  eq(keys[0], isoWeekKey(Date.parse('2026-07-15T00:00:00Z')), 'first week holds the oldest entry');
  eq(keys[keys.length - 1], '2026-W35', 'last week is the one containing today');
  const w35 = r.periods.find((p) => p.key === '2026-W35');
  eq(w35.messages, 3, 'Aug 24 (Mon) and Aug 26 share one ISO week');
  eq(w35.startMs, Date.parse('2026-08-24T00:00:00Z'), 'ISO weeks start on Monday, UTC');
  const w34 = r.periods.find((p) => p.key === '2026-W34');
  eq(w34.messages, 1, 'Aug 20 belongs to the previous ISO week');
  // A week with no usage at all still shows up, at zero.
  ok(
    r.periods.some((p) => p.messages === 0),
    'quiet weeks are zero-filled rather than dropped',
  );
  eq(r.periods.reduce((a, p) => a + p.messages, 0), 5, 'week buckets account for every entry');
}

// ── 5. Month grouping ──────────────────────────────────────────────────
{
  const r = aggregate(fixture(), { nowMs: NOW, groupBy: 'month' });
  eq(r.periods.map((p) => p.key).join(','), '2026-07,2026-08', 'one bucket per calendar month');
  eq(r.periods[0].messages, 1, 'July holds a single entry');
  eq(r.periods[1].messages, 4, 'August holds the rest');
  eq(r.periods[1].startMs, Date.parse('2026-08-01T00:00:00Z'), 'months start on the 1st, UTC');
  eq(r.periods[1].endMs, Date.parse('2026-09-01T00:00:00Z'), 'and end at the next 1st');
}

// ── 6. Per-session rollup ──────────────────────────────────────────────
{
  const r = aggregate(fixture(), { nowMs: NOW, groupBy: 'session' });
  eq(r.bySession.length, 2, 'one row per transcript that had usage in the window');
  const [top, second] = r.bySession;
  eq(top.sessionId, 'aaaaaaaa-1111-4000-8000-000000000001', 'rows are sorted by total tokens, desc');
  eq(top.project, 'alpha', 'the project comes from the transcript directory');
  eq(top.messages, 3, 'message count is per session');
  eq(top.models.join(','), `${OPUS},${SONNET}`, 'models used are listed and sorted');
  eq(top.startMs, Date.parse('2026-08-24T12:00:00Z'), 'start is the earliest entry, not the first line');
  eq(top.endMs, Date.parse('2026-08-26T09:30:00Z'), 'end is the latest entry');
  eq(top.durationMs, top.endMs - top.startMs, 'duration is end - start');
  eq(top.tokens.input, 3500, 'session token totals add up');
  eq(second.sessionId, 'bbbbbbbb-2222-4000-8000-000000000002', 'the smaller session sorts second');
  // The session series has no time axis, so `periods` stays a day series.
  eq(r.groupBy, 'session', 'groupBy=session is reported as such');
}

// ── 7. A session outside the window produces no row ─────────────────────
{
  const r = aggregate(fixture(), {
    sinceMs: Date.parse('2026-08-26T00:00:00Z'),
    untilMs: Date.parse('2026-08-27T00:00:00Z'),
    nowMs: NOW,
    groupBy: 'session',
  });
  eq(r.bySession.length, 1, 'only the transcript with same-day usage shows up');
  eq(r.bySession[0].messages, 2, 'and only its in-window entries are counted');
}

// ── 8. Filters, and facets that survive them ───────────────────────────
{
  const all = aggregate(fixture(), { nowMs: NOW });
  eq(all.facets.projects.join(','), 'alpha,beta', 'facets list every project in the window');
  eq(all.facets.models.join(','), `${OPUS},${SONNET}`, 'and every model');

  const byProject = aggregate(fixture(), { nowMs: NOW, project: 'beta' });
  eq(byProject.totals.messages, 2, 'the project filter narrows the totals');
  eq(byProject.byProject.length, 1, 'and the breakdown');
  eq(byProject.facets.projects.join(','), 'alpha,beta', 'but NOT the facet list — you must be able to switch back');
  eq(byProject.filters.project, 'beta', 'the active filter is echoed back');

  const byModel = aggregate(fixture(), { nowMs: NOW, model: OPUS });
  eq(byModel.totals.messages, 2, 'the model filter narrows the totals');
  eq(byModel.totals.tokens.input, 3000, 'and the token sums');
  eq(byModel.totals.sessions, 1, 'a session with no matching entries is not counted as active');

  const both = aggregate(fixture(), { nowMs: NOW, project: 'beta', model: OPUS });
  eq(both.totals.messages, 0, 'filters compose (beta never used Opus)');
}

// ── 9. Dedup by message id, across transcripts ─────────────────────────
{
  const dupe = [
    { id: 's1', project: 'alpha', entries: [entry('2026-08-26T09:00:00Z', OPUS, tok(100), 'same')] },
    { id: 's2', project: 'beta', entries: [entry('2026-08-26T09:00:00Z', OPUS, tok(100), 'same')] },
  ];
  const r = aggregate(dupe, 30, NOW);
  eq(r.totals.messages, 1, 'the same message id is only counted once');
  eq(r.bySession.length, 1, 'and the duplicate transcript gets no session row');
}

// ── 10. ISO week / day / month keys ────────────────────────────────────
{
  eq(isoWeekKey(Date.parse('2026-01-01T00:00:00Z')), '2026-W01', 'Jan 1 2026 (Thu) is week 1');
  eq(isoWeekKey(Date.parse('2025-12-29T00:00:00Z')), '2026-W01', 'the Monday before it is also week 1');
  eq(isoWeekKey(Date.parse('2025-12-28T00:00:00Z')), '2025-W52', 'the Sunday before that is last year’s week 52');
  eq(isoWeekKey(Date.parse('2026-08-26T23:59:59Z')), '2026-W35', 'end-of-day stays in the same week');
  eq(dayKey(NOW), '2026-08-26', 'day keys are UTC ISO dates');
  eq(monthKey(NOW), '2026-08', 'month keys are YYYY-MM');
}

// ── 11. Query-param parsing shared by /history and /usage ──────────────
{
  const q = (s) => new URLSearchParams(s);
  eq(JSON.stringify(historyOptions(q(''), 30)), JSON.stringify({ groupBy: 'day', days: 30 }), '/history defaults to 30 days');
  eq(JSON.stringify(historyOptions(q(''), null)), JSON.stringify({ groupBy: 'day' }), '/usage defaults to all time');

  const ranged = historyOptions(q('since=2026-08-01&until=2026-08-07&groupBy=week'), 30);
  eq(ranged.sinceMs, Date.parse('2026-08-01T00:00:00Z'), 'since is parsed as a UTC midnight');
  eq(ranged.untilMs, Date.parse('2026-08-08T00:00:00Z'), 'until is inclusive, so the window end is the next midnight');
  eq(ranged.days, undefined, 'an explicit range wins over days');
  eq(ranged.groupBy, 'week', 'groupBy passes through');

  eq(historyOptions(q('groupBy=nonsense'), 30).groupBy, 'day', 'an unknown groupBy falls back to day');
  eq(historyOptions(q('since=08/01/2026'), 30).sinceMs, undefined, 'a non-ISO date is ignored');
  eq(historyOptions(q('days=-5'), 30).days, 30, 'a negative days falls back to the default');
  eq(historyOptions(q('days=99999'), 30).days, 3650, 'days is clamped');
  eq(historyOptions(q('project=alpha&model=x'), 30).project, 'alpha', 'project passes through');
  eq(historyOptions(q('project=&model='), 30).model, undefined, 'empty filters are dropped');
}

// ── 12. Transcript parsing (unchanged, guarded against regressions) ─────
{
  const line = JSON.stringify({
    timestamp: '2026-08-26T09:00:00Z',
    message: { id: 'msg_1', model: OPUS, usage: { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 7, cache_read_input_tokens: 8 } },
  });
  const e = parseTranscriptLine(line);
  eq(e.id, 'msg_1', 'a usage line parses');
  eq(e.tokens.cacheRead, 8, 'cache-read tokens are picked up');
  eq(parseTranscriptLine('{}'), null, 'a line without usage is skipped');
  eq(parseTranscriptLine('not json {"usage"'), null, 'unparseable JSON is skipped');
  eq(
    parseTranscriptLine(JSON.stringify({ timestamp: 'x', message: { id: 'a', model: '<synthetic>', usage: {} } })),
    null,
    'synthetic messages are skipped',
  );
  eq(projectLabel('-home-user-projects-Foo'), 'Foo', 'project labels drop the path prefix');
}

if (errs.length) {
  console.error(`history: ${errs.length} FAILURE(S)\n- ` + errs.join('\n- '));
  process.exit(1);
}
console.log('history: ALL ASSERTIONS PASSED');
