// @ts-check
/**
 * Claude Usage — token/cost history aggregation.
 *
 * Ported 1:1 from cloudcli-plugin-claude-usage/src/history.ts (TypeScript ->
 * plain JS, same parsing/aggregation logic, no math changes).
 *
 * @typedef {{input: number, output: number, cacheCreate: number, cacheRead: number}} TokenCounts
 * @typedef {{id: string, timestamp: string, model: string, tokens: TokenCounts}} UsageEntry
 * @typedef {{id?: string, project: string, entries: UsageEntry[]}} SessionEntries
 */

import { estimateCost } from './pricing.js';

/** @param {unknown} v @returns {number} */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Parse one transcript JSONL line; null when it carries no billable usage.
 * @param {string} line @returns {UsageEntry|null}
 */
export function parseTranscriptLine(line) {
  if (!line.includes('"usage"')) return null; // fast path
  /** @type {any} */
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const msg = obj && obj.message;
  const usage = msg && msg.usage;
  if (!msg || !msg.id || !msg.model || !usage || typeof obj.timestamp !== 'string') return null;
  if (msg.model === '<synthetic>') return null;
  return {
    id: msg.id,
    timestamp: obj.timestamp,
    model: msg.model,
    tokens: {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheCreate: num(usage.cache_creation_input_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
    },
  };
}

/**
 * "-home-user-projects-Foo" -> "Foo"; falls back to the trimmed dir name.
 * @param {string} dirName @returns {string}
 */
export function projectLabel(dirName) {
  const m = dirName.match(/-projects-(.+)$/);
  return m ? m[1] : dirName.replace(/^-/, '');
}

/** @returns {TokenCounts} */
function zero() {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}

/** @param {TokenCounts} a @param {TokenCounts} b */
function add(a, b) {
  a.input += b.input;
  a.output += b.output;
  a.cacheCreate += b.cacheCreate;
  a.cacheRead += b.cacheRead;
}

/** @param {TokenCounts} t @returns {number} */
function totalOf(t) {
  return t.input + t.output + t.cacheCreate + t.cacheRead;
}

// ── Period keys ────────────────────────────────────────────────────────
// All bucketing is UTC, like the pre-existing daily series: transcripts carry
// ISO timestamps and the dashboard has never claimed a local-timezone day.

const DAY_MS = 86_400_000;

/** Start of the UTC day containing `ms`. @param {number} ms @returns {number} */
function dayStart(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Start of the ISO week (Monday) containing `ms`. @param {number} ms @returns {number} */
function weekStart(ms) {
  const d = dayStart(ms);
  const dow = (new Date(d).getUTCDay() + 6) % 7; // Mon = 0
  return d - dow * DAY_MS;
}

/** Start of the UTC month containing `ms`. @param {number} ms @returns {number} */
function monthStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** "2026-08-26" @param {number} ms @returns {string} */
export function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "2026-08" @param {number} ms @returns {string} */
export function monthKey(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

/**
 * "2026-W35" — ISO-8601 week numbering (weeks start Monday, week 1 is the one
 * containing the first Thursday of the year), matching `ccusage weekly`.
 * @param {number} ms @returns {string}
 */
export function isoWeekKey(ms) {
  const d = new Date(dayStart(ms));
  const dow = (d.getUTCDay() + 6) % 7; // Mon = 0
  // The Thursday of this week decides which ISO year the week belongs to.
  const thu = new Date(d.getTime() + (3 - dow) * DAY_MS);
  const year = thu.getUTCFullYear();
  const week1Thu = new Date(Date.UTC(year, 0, 4));
  const week1Mon = week1Thu.getTime() - ((week1Thu.getUTCDay() + 6) % 7) * DAY_MS;
  const week = 1 + Math.round((thu.getTime() - 3 * DAY_MS - week1Mon) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** @type {Record<string, {start:(ms:number)=>number, key:(ms:number)=>string, next:(ms:number)=>number}>} */
const GROUPERS = {
  day: { start: dayStart, key: dayKey, next: (ms) => ms + DAY_MS },
  week: { start: weekStart, key: isoWeekKey, next: (ms) => ms + 7 * DAY_MS },
  month: {
    start: monthStart,
    key: monthKey,
    next: (ms) => {
      const d = new Date(ms);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    },
  },
};

/** Hard stop on the zero-filled series so an "all time" range can't explode. */
const MAX_BUCKETS = 800;

/**
 * Zero-filled ascending bucket series over [sinceMs, untilMs).
 * Only the most recent MAX_BUCKETS are kept if the range is absurdly long.
 * @param {Map<string, {tokens: TokenCounts, cost: number, messages: number}>} filled
 * @param {'day'|'week'|'month'} groupBy @param {number} sinceMs @param {number} untilMs
 */
function series(filled, groupBy, sinceMs, untilMs) {
  const g = GROUPERS[groupBy];
  const out = [];
  let cursor = g.start(sinceMs);
  for (let i = 0; cursor < untilMs && i < MAX_BUCKETS * 4; i++) {
    const end = g.next(cursor);
    const key = g.key(cursor);
    const b = filled.get(key);
    out.push({
      key,
      date: key, // back-compat alias: the daily chart reads `.date`
      startMs: cursor,
      endMs: end,
      tokens: b ? b.tokens : zero(),
      cost: b ? b.cost : 0,
      messages: b ? b.messages : 0,
    });
    cursor = end;
  }
  return out.length > MAX_BUCKETS ? out.slice(out.length - MAX_BUCKETS) : out;
}

/**
 * Aggregate usage over a window.
 *
 * Two call styles, both supported:
 *   aggregate(sessions, 30, Date.now())      — legacy: last N days ending today
 *   aggregate(sessions, {sinceMs, untilMs, groupBy, project, model, nowMs})
 *
 * `sinceMs` is inclusive, `untilMs` exclusive. With neither `sinceMs` nor
 * `days` given the window starts at the earliest entry on record ("all time").
 *
 * @param {SessionEntries[]} sessions
 * @param {number|{days?:number, sinceMs?:number, untilMs?:number, nowMs?:number,
 *   groupBy?:'day'|'week'|'month'|'session', project?:string|null, model?:string|null}} daysOrOpts
 * @param {number} [nowMsArg]
 */
export function aggregate(sessions, daysOrOpts, nowMsArg) {
  const opts = typeof daysOrOpts === 'number' ? { days: daysOrOpts } : daysOrOpts || {};
  const nowMs = Number.isFinite(opts.nowMs)
    ? /** @type {number} */ (opts.nowMs)
    : Number.isFinite(nowMsArg)
      ? /** @type {number} */ (nowMsArg)
      : Date.now();
  const groupBy = GROUPERS[opts.groupBy || ''] ? /** @type {'day'|'week'|'month'} */ (opts.groupBy) : 'day';
  const projectFilter = opts.project || null;
  const modelFilter = opts.model || null;

  // ── window
  const untilMs = Number.isFinite(opts.untilMs)
    ? /** @type {number} */ (opts.untilMs)
    : dayStart(nowMs) + DAY_MS; // through the end of today (exclusive)
  const lastDayStart = dayStart(untilMs - 1);
  let sinceMs;
  if (Number.isFinite(opts.sinceMs)) sinceMs = /** @type {number} */ (opts.sinceMs);
  else if (opts.days) sinceMs = lastDayStart - (opts.days - 1) * DAY_MS;
  else sinceMs = earliestTimestamp(sessions) ?? lastDayStart;
  if (sinceMs > untilMs) sinceMs = untilMs;

  const seen = new Set();
  /** @type {Map<string, {tokens: TokenCounts, cost: number, messages: number}>} */
  const byDay = new Map();
  /** @type {Map<string, {tokens: TokenCounts, cost: number, messages: number}>} */
  const byPeriod = new Map();
  /** @type {Map<string, {tokens: TokenCounts, cost: number|null}>} */
  const byModel = new Map();
  /** @type {Map<string, {tokens: TokenCounts, cost: number|null}>} */
  const byProject = new Map();
  /** @type {any[]} */
  const bySession = [];
  // Every project/model seen in the *unfiltered* window — the frontend builds
  // its filter dropdowns from these, so they must not shrink when a filter is
  // applied (otherwise you could never switch back).
  const facetProjects = new Set();
  const facetModels = new Set();
  const totals = { tokens: zero(), cost: 0, sessions: 0, messages: 0 };

  for (const session of sessions) {
    let sessionActive = false;
    /** @type {any} */
    let sessionAgg = null;
    for (const e of session.entries) {
      const ts = Date.parse(e.timestamp);
      if (!Number.isFinite(ts) || ts < sinceMs || ts >= untilMs) continue;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      facetProjects.add(session.project);
      facetModels.add(e.model);
      if (projectFilter && session.project !== projectFilter) continue;
      if (modelFilter && e.model !== modelFilter) continue;
      sessionActive = true;

      const cost = estimateCost(e.model, e.tokens);
      totals.messages += 1;
      add(totals.tokens, e.tokens);
      totals.cost += cost ?? 0;

      bump(byDay, dayKey(ts), e.tokens, cost);
      if (groupBy !== 'day') bump(byPeriod, GROUPERS[groupBy].key(ts), e.tokens, cost);

      for (const [map, key] of /** @type {[Map<string,{tokens:TokenCounts,cost:number|null}>, string][]} */ ([
        [byModel, e.model],
        [byProject, session.project],
      ])) {
        const b = map.get(key) ?? { tokens: zero(), cost: null };
        add(b.tokens, e.tokens);
        if (cost !== null) {
          b.cost = (b.cost ?? 0) + cost;
        }
        map.set(key, b);
      }

      if (!sessionAgg) {
        sessionAgg = {
          sessionId: session.id || null,
          project: session.project,
          startMs: ts,
          endMs: ts,
          tokens: zero(),
          cost: 0,
          messages: 0,
          models: new Set(),
        };
      }
      // Transcript lines are appended in order, but a resumed session can
      // interleave; take the true min/max rather than first/last seen.
      if (ts < sessionAgg.startMs) sessionAgg.startMs = ts;
      if (ts > sessionAgg.endMs) sessionAgg.endMs = ts;
      add(sessionAgg.tokens, e.tokens);
      sessionAgg.cost += cost ?? 0;
      sessionAgg.messages += 1;
      sessionAgg.models.add(e.model);
    }
    if (sessionActive) totals.sessions += 1;
    if (sessionAgg) {
      bySession.push({
        ...sessionAgg,
        durationMs: sessionAgg.endMs - sessionAgg.startMs,
        models: [...sessionAgg.models].sort(),
      });
    }
  }

  bySession.sort((a, b) => totalOf(b.tokens) - totalOf(a.tokens));

  const daily = series(byDay, 'day', sinceMs, untilMs);

  /** @param {Map<string, {tokens: TokenCounts, cost: number|null}>} m */
  const rank = (m) =>
    [...m.entries()]
      .sort((a, b) => totalOf(b[1].tokens) - totalOf(a[1].tokens))
      .map(([key, v]) => ({ key, tokens: v.tokens, cost: v.cost }));

  return {
    daily,
    // The series the caller asked to group by. For groupBy=day it is the same
    // array as `daily`; for session there is no time series, so it stays empty.
    periods: groupBy === 'day' ? daily : series(byPeriod, groupBy, sinceMs, untilMs),
    groupBy: opts.groupBy === 'session' ? 'session' : groupBy,
    range: { sinceMs, untilMs },
    filters: { project: projectFilter, model: modelFilter },
    facets: { projects: [...facetProjects].sort(), models: [...facetModels].sort() },
    bySession,
    byModel: rank(byModel).map(({ key, ...v }) => ({ model: key, ...v })),
    byProject: rank(byProject).map(({ key, ...v }) => ({ project: key, ...v })),
    totals,
  };
}

/**
 * @param {Map<string, {tokens: TokenCounts, cost: number, messages: number}>} map
 * @param {string} key @param {TokenCounts} tokens @param {number|null} cost
 */
function bump(map, key, tokens, cost) {
  const b = map.get(key) ?? { tokens: zero(), cost: 0, messages: 0 };
  add(b.tokens, tokens);
  b.cost += cost ?? 0;
  b.messages += 1;
  map.set(key, b);
}

/** Oldest parseable timestamp across all sessions, or null. @param {SessionEntries[]} sessions */
function earliestTimestamp(sessions) {
  let min = null;
  for (const s of sessions) {
    for (const e of s.entries) {
      const ts = Date.parse(e.timestamp);
      if (Number.isFinite(ts) && (min === null || ts < min)) min = ts;
    }
  }
  return min;
}

/**
 * Turn `/history` + `/usage` query params into aggregate() options.
 *
 * `days` alone is the pre-2.1 contract and still behaves identically (a window
 * of N days ending today). `since`/`until` are inclusive YYYY-MM-DD dates and
 * win over `days`; with neither, the window is all recorded history.
 * @param {URLSearchParams} q @param {number|null} defaultDays
 */
export function historyOptions(q, defaultDays) {
  /** @param {string|null} v */
  const dateMs = (v) => {
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const ms = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(ms) ? ms : null;
  };
  const since = dateMs(q.get('since'));
  const until = dateMs(q.get('until'));
  const groupBy = ['day', 'week', 'month', 'session'].includes(String(q.get('groupBy')))
    ? String(q.get('groupBy'))
    : 'day';
  const rawDays = Number(q.get('days'));
  const days =
    Number.isFinite(rawDays) && rawDays > 0
      ? Math.min(Math.max(Math.floor(rawDays), 1), 3650)
      : defaultDays;

  /** @type {any} */
  const opts = { groupBy };
  if (since != null) opts.sinceMs = since;
  // `until` names a day the caller wants included; the window end is exclusive.
  if (until != null) opts.untilMs = until + 86_400_000;
  if (since == null && until == null && days != null) opts.days = days;
  const project = q.get('project');
  const model = q.get('model');
  if (project) opts.project = project;
  if (model) opts.model = model;
  return opts;
}
