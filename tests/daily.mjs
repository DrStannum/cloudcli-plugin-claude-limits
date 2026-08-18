// Unit tests for the "Today's budget" math (dist/daily.js). Pure functions get
// `now` and the log contents passed in, so no clock/filesystem mocking beyond a
// tmp file for the I/O wrapper.  Run: node tests/daily.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  computeDailyFrom, computeDaily, recordSnapshot, readHistory, writeHistory,
  cyclePosition, emptyHistory,
} = await import(path.join(PLUGIN, 'dist/daily.js'));

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ~${b})`);

const DAY = 86400;
const S = 1000;

// A cycle that started 3 days ago; the current period opened `openedAgoSec` ago.
function scenario(openedAgoSec) {
  const nowMs = 1_800_000_000_000;              // fixed clock, no Date.now()
  const now = nowMs / 1000;
  const periodStart = now - openedAgoSec;
  const cycleStart = periodStart - 3 * DAY;
  return { nowMs, now, periodStart, cycleStart, wkResetMs: (cycleStart + 7 * DAY) * S };
}

// ── 1. The reported bug: a new period with an empty history must read ~0%, ──
//      not the cycle average the old spread-it-out fallback produced (~61%).
{
  const s = scenario(6 * 60);
  const history = emptyHistory();
  recordSnapshot(history, { periodStart: s.periodStart, pct: 42, nowSec: s.now });
  const d = computeDailyFrom({ wkCur: 42, wkResetMs: s.wkResetMs, nowMs: s.nowMs, history });
  // Only the 6 unobserved minutes count against today: (360/86400) * (42/4).
  near(d.todayUsed, 0.044, 0.02, 'fresh period: today ~0%, not the cycle average');
  ok(d.usedPct < 2, `fresh period: bar under 2%, got ${d.usedPct.toFixed(1)}%`);
  ok(d.estimated === true, 'past the 5-min grace, the number is flagged as an estimate');
  ok(/^\d+\/\d+%$/.test(d.valueText), `valueText format, got ${d.valueText}`);
  ok(d.resetsAtMs === (s.periodStart + DAY) * S, 'resets at the end of the period');

  // A backend that was already running when the period rolled over snapshots
  // within seconds, and that counts as measured.
  const live = emptyHistory();
  const s2 = scenario(20);
  recordSnapshot(live, { periodStart: s2.periodStart, pct: 42, nowSec: s2.now });
  const d2 = computeDailyFrom({ wkCur: 42, wkResetMs: s2.wkResetMs, nowMs: s2.nowMs, history: live });
  ok(d2.estimated === false, 'a snapshot within the 5-min grace is not an estimate');
  ok(d2.todayUsed < 0.01, `rolled-over period starts at zero, got ${d2.todayUsed}`);
}

// ── 2. Baseline carried over from the previous period ───────────────────
{
  const s = scenario(4 * 3600);
  const history = emptyHistory();
  // Yesterday's last reading, taken a minute before the boundary.
  history.periods.push({
    ps: s.periodStart - DAY, firstPct: 20, firstTs: s.periodStart - DAY + 60,
    lastPct: 30, lastTs: s.periodStart - 60,
  });
  recordSnapshot(history, { periodStart: s.periodStart, pct: 36, nowSec: s.now });
  const d = computeDailyFrom({ wkCur: 36, wkResetMs: s.wkResetMs, nowMs: s.nowMs, history });
  near(d.todayUsed, 6, 0.05, 'today = current weekly minus yesterday-end baseline');
  ok(d.estimated === false, 'baseline within grace of the boundary is exact');
  // 30% spent over 3 prior days vs 42.9% budgeted -> the leftover rolls forward.
  near(d.todayBudget, 100 / 7 + (3 * (100 / 7) - 30) / 4, 0.01, 'unused allowance rolls into today');
}

// ── 3. First period of a cycle: baseline is a known zero ────────────────
{
  const nowMs = 1_800_000_000_000;
  const now = nowMs / 1000;
  const periodStart = now - 2 * 3600;
  const wkResetMs = (periodStart + 7 * DAY) * S;   // day 0 of the cycle
  const history = emptyHistory();
  recordSnapshot(history, { periodStart, pct: 9, nowSec: now });
  const d = computeDailyFrom({ wkCur: 9, wkResetMs, nowMs, history });
  ok(cyclePosition(wkResetMs, nowMs).daysElapsed === 0, 'day 0 of the cycle');
  near(d.todayUsed, 9, 0.001, 'everything spent this cycle was spent today');
  ok(d.estimated === false, 'the post-reset zero is an exact baseline');
  near(d.todayBudget, 100 / 7, 0.001, 'day 0 budget is a plain seventh');
}

// ── 4. Cold start late in the day degrades to the old spread-it-out guess ──
{
  const s = scenario(23.9 * 3600);
  const history = emptyHistory();
  recordSnapshot(history, { periodStart: s.periodStart, pct: 42, nowSec: s.now });
  const d = computeDailyFrom({ wkCur: 42, wkResetMs: s.wkResetMs, nowMs: s.nowMs, history });
  near(d.todayUsed, 42 / 4, 0.2, 'no coverage of the day -> cycle average, as before');
  ok(d.estimated === true, 'flagged as an estimate');
}

// ── 5. Half-covered day: measured spend plus a priced-in unmeasured stretch ──
{
  const s = scenario(12 * 3600);
  const history = emptyHistory();
  // Backend started 12h into the period at 38%, weekly is 41% now.
  history.periods.push({
    ps: s.periodStart, firstPct: 38, firstTs: s.periodStart + 12 * 3600,
    lastPct: 41, lastTs: s.now,
  });
  const d = computeDailyFrom({ wkCur: 41, wkResetMs: s.wkResetMs, nowMs: s.nowMs, history });
  near(d.todayUsed, 3 + 0.5 * (41 / 4), 0.05, 'measured 3% + half a day priced at the cycle average');
  ok(d.estimated === true, 'partial coverage is an estimate');
}

// ── 6. Weekly counter dropped below the baseline (reset / window slid) ──
{
  const s = scenario(3600);
  const history = emptyHistory();
  history.periods.push({
    ps: s.periodStart - DAY, firstPct: 80, firstTs: s.periodStart - DAY,
    lastPct: 90, lastTs: s.periodStart - 30,
  });
  const d = computeDailyFrom({ wkCur: 4, wkResetMs: s.wkResetMs, nowMs: s.nowMs, history });
  ok(d.todayUsed >= 0 && d.todayUsed <= 4, `never negative or above the weekly total, got ${d.todayUsed}`);
  ok(d.estimated === true, 'a stale baseline is flagged');
}

// ── 7. The statusline log still works as a fallback baseline ────────────
{
  const s = scenario(3 * 3600);
  const history = emptyHistory();
  recordSnapshot(history, { periodStart: s.periodStart, pct: 33, nowSec: s.now });
  const legacy = [{ ps: s.periodStart - DAY, used_pct: 25 }];
  const d = computeDailyFrom({ wkCur: 33, wkResetMs: s.wkResetMs, nowMs: s.nowMs, history, legacy });
  near(d.todayUsed, 8, 0.01, 'statusline log sits on the boundary -> plain difference');
  ok(d.estimated === true, 'the statusline log has no timestamp, so it is approximate');
}

// ── 8. recordSnapshot bookkeeping ───────────────────────────────────────
{
  const now = 1_800_000_000;
  const h = emptyHistory();
  ok(recordSnapshot(h, { periodStart: now - 3600, pct: 10, nowSec: now }) === true, 'first snapshot writes');
  ok(recordSnapshot(h, { periodStart: now - 3600, pct: 10, nowSec: now + 5 }) === false, 'same value within 30s is a no-op');
  ok(recordSnapshot(h, { periodStart: now - 3600, pct: 11, nowSec: now + 6 }) === true, 'a changed value writes');
  ok(h.periods[0].firstPct === 10 && h.periods[0].firstTs === now, 'the period-open baseline is preserved');

  recordSnapshot(h, { periodStart: now - 3600, pct: 2, nowSec: now + 10 });
  ok(h.periods[0].firstPct === 2, 'a drop re-anchors the baseline');

  h.periods.unshift({ ps: now - 10 * DAY, firstPct: 1, firstTs: now - 10 * DAY, lastPct: 5, lastTs: now - 10 * DAY });
  recordSnapshot(h, { periodStart: now - 3600, pct: 3, nowSec: now + 60 });
  ok(!h.periods.some((p) => p.ps === now - 10 * DAY), 'snapshots older than 9 days are pruned');
}

// ── 9. I/O wrapper round-trips through disk ─────────────────────────────
{
  const file = path.join(os.tmpdir(), `cl-hist-${process.pid}.json`);
  try { fs.unlinkSync(file); } catch { /* fresh run */ }
  const missing = path.join(os.tmpdir(), 'cl-no-such-usage-log.json');
  const nowMs = 1_800_000_000_000;
  const wkResetMs = (nowMs / 1000 - 3 * DAY + 7 * DAY) * S;

  const d1 = computeDaily(30, wkResetMs, { historyPath: file, legacyPath: missing, nowMs });
  ok(fs.existsSync(file), 'history file created');
  ok(d1.estimated === false, 'first call anchors at the period boundary');

  // Two hours later, 4 more weekly-% spent.
  const d2 = computeDaily(34, wkResetMs, { historyPath: file, legacyPath: missing, nowMs: nowMs + 2 * 3600 * S });
  near(d2.todayUsed, 4, 0.05, 'second call measures the difference against the stored baseline');

  const persisted = readHistory(file);
  ok(persisted.periods.length === 1 && persisted.periods[0].lastPct === 34, 'snapshot persisted');
  ok(readHistory(path.join(os.tmpdir(), 'cl-nope.json')).periods.length === 0, 'missing file -> empty history');
  fs.writeFileSync(file, 'not json');
  ok(readHistory(file).periods.length === 0, 'corrupt file -> empty history');
  writeHistory(file, persisted);
  ok(readHistory(file).periods.length === 1, 'writeHistory round-trips');
  fs.unlinkSync(file);
}

if (errs.length) { console.error('FAILED:\n- ' + errs.join('\n- ')); process.exit(1); }
console.log('daily: ALL ASSERTIONS PASSED');
