// @ts-check
/**
 * Claude Limits — today's-budget math.
 *
 * The usage API exposes only a 5-hour and a 7-day bucket; there is no daily
 * limit. "Today's budget" is derived: split the weekly allowance across the
 * seven 24h periods of the cycle, then show how much of today's slice is gone.
 *
 * Getting "how much was spent today" right needs the weekly % as it stood at
 * the start of the current period, so this module keeps its own snapshot log
 * (one record per period, first+last value seen with timestamps) and derives
 * today's spend as a difference. Prior versions read only the statusline's
 * `usage_log.json`, which is written solely while an interactive TUI renders
 * its prompt — with CloudCLI / headless `claude -p` runs nothing ever wrote
 * it, so the log stayed empty and the code fell back to spreading the whole
 * weekly total evenly over the elapsed days. That fallback reports the cycle's
 * *average* day, so the meter jumped to ~60% the second a new period started,
 * with nothing actually spent yet.
 *
 * Pure functions take `now` and the log contents as arguments so they can be
 * unit-tested; the I/O wrapper at the bottom is what the server calls.
 */

import fs from 'node:fs';

const DAY = 86400;

/** Weekly allowance per 24h period, in weekly-%. */
const BASE = 100 / 7;

/**
 * A snapshot older than this (relative to the period boundary) makes today's
 * number an estimate rather than a measurement.
 */
const GRACE_SEC = 300;

/** Keep just over a cycle's worth of snapshots. */
const RETAIN_DAYS = 9;

/** Don't rewrite the log more often than this unless the value changed. */
const MIN_WRITE_INTERVAL_SEC = 30;

// ── Snapshot log ───────────────────────────────────────────────────────

/**
 * @typedef {Object} PeriodRecord
 * @property {number} ps        Period start, epoch seconds.
 * @property {number} firstPct  Weekly % at the first snapshot of the period.
 * @property {number} firstTs   When that first snapshot was taken.
 * @property {number} lastPct   Weekly % at the most recent snapshot.
 * @property {number} lastTs    When that snapshot was taken.
 */

/**
 * @typedef {Object} History
 * @property {number} v
 * @property {PeriodRecord[]} periods
 */

/** @returns {History} */
export function emptyHistory() {
  return { v: 1, periods: [] };
}

/**
 * Read our snapshot log. Never throws: a missing/corrupt file just means "no
 * history yet", which the math degrades gracefully into.
 * @param {string} file @returns {History}
 */
export function readHistory(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return emptyHistory();
  }
  const periods = Array.isArray(raw && raw.periods) ? raw.periods : [];
  return {
    v: 1,
    periods: periods
      .map((p) => ({
        ps: Number(p && p.ps),
        firstPct: Number(p && p.firstPct),
        firstTs: Number(p && p.firstTs),
        lastPct: Number(p && p.lastPct),
        lastTs: Number(p && p.lastTs),
      }))
      .filter(
        (p) =>
          Number.isFinite(p.ps) && p.ps > 0 &&
          Number.isFinite(p.firstPct) && Number.isFinite(p.firstTs) &&
          Number.isFinite(p.lastPct) && Number.isFinite(p.lastTs),
      )
      .sort((a, b) => a.ps - b.ps),
  };
}

/**
 * Write atomically — the frontend polls every few seconds and the statusline
 * may read alongside us, so no reader should ever see a half-written file.
 * @param {string} file @param {History} history
 */
export function writeHistory(file, history) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(history));
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
  }
}

/**
 * Read the statusline's own rolling log (read-only, legacy fallback). Only its
 * previous-period record is useful to us: it holds the last weekly % the
 * statusline saw before today began.
 * @param {string} file @returns {{ps:number, used_pct:number}[]}
 */
export function readLegacyLog(file) {
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((e) => ({ ps: Number(e && e.ps), used_pct: Number(e && e.used_pct) }))
      .filter((e) => Number.isFinite(e.ps) && e.ps > 0 && Number.isFinite(e.used_pct));
  } catch {
    return [];
  }
}

/**
 * Fold a fresh reading into the history. Mutates `history`.
 * @param {History} history
 * @param {{periodStart:number, pct:number, nowSec:number}} s
 * @returns {boolean} whether anything changed (i.e. whether to persist)
 */
export function recordSnapshot(history, { periodStart, pct, nowSec }) {
  let changed = false;

  const cutoff = nowSec - RETAIN_DAYS * DAY;
  const kept = history.periods.filter((p) => p.ps >= cutoff);
  if (kept.length !== history.periods.length) {
    history.periods = kept;
    changed = true;
  }

  const cur = history.periods.find((p) => p.ps === periodStart);
  if (!cur) {
    history.periods.push({
      ps: periodStart, firstPct: pct, firstTs: nowSec, lastPct: pct, lastTs: nowSec,
    });
    history.periods.sort((a, b) => a.ps - b.ps);
    return true;
  }

  // A drop means the weekly counter reset or usage aged out of the window;
  // the old baseline would make today's difference negative, so re-anchor.
  if (pct < cur.firstPct) {
    cur.firstPct = pct;
    cur.firstTs = nowSec;
    changed = true;
  }
  if (pct !== cur.lastPct || nowSec - cur.lastTs >= MIN_WRITE_INTERVAL_SEC) {
    cur.lastPct = pct;
    cur.lastTs = nowSec;
    changed = true;
  }
  return changed;
}

// ── Cycle position ─────────────────────────────────────────────────────

/**
 * Where `now` sits in the weekly cycle. 24h periods are anchored to the weekly
 * reset (period 0 starts at reset-7d), matching the statusline.
 * @param {number|null} wkResetMs @param {number} nowMs
 * @returns {{cycleStart:number, daysElapsed:number, daysRemaining:number, periodStart:number}}
 */
export function cyclePosition(wkResetMs, nowMs) {
  const now = Math.floor(nowMs / 1000);
  let cycleStart;
  let daysElapsed;
  let periodStart;
  if (wkResetMs != null) {
    const wkReset = Math.round(wkResetMs / 1000);
    cycleStart = wkReset - 7 * DAY;
    let d = Math.floor((now - cycleStart) / DAY);
    if (d < 0) d = 0;
    if (d > 6) d = 6;
    daysElapsed = d;
    periodStart = cycleStart + daysElapsed * DAY;
  } else {
    // Fallback: anchor to local midnight + ISO weekday (Mon=1 … Sun=7).
    const dt = new Date(nowMs);
    const iso = ((dt.getDay() + 6) % 7) + 1;
    daysElapsed = iso - 1;
    periodStart = Math.floor(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime() / 1000);
    cycleStart = periodStart - daysElapsed * DAY;
  }
  return { cycleStart, daysElapsed, daysRemaining: 7 - daysElapsed, periodStart };
}

// ── Baseline selection ─────────────────────────────────────────────────

/**
 * The weekly % as it stood when the current period began. Candidates are the
 * newest snapshot before the boundary and the oldest one after it; the closer
 * in time wins, since whichever side it falls on the error is bounded by how
 * far it sits from the boundary.
 *
 * @param {History} history
 * @param {{ps:number, used_pct:number}[]} legacy
 * @param {{cycleStart:number, daysElapsed:number, periodStart:number}} pos
 * @returns {{pct:number, ts:number, approx:boolean, source:string}|null}
 */
export function pickBaseline(history, legacy, pos) {
  const { periodStart, daysElapsed } = pos;
  /** @type {{pct:number, ts:number, approx:boolean, source:string}[]} */
  const candidates = [];

  // Day 0 of a cycle starts right after the weekly reset, so the baseline is
  // exactly 0 at exactly the boundary — no snapshot needed.
  if (daysElapsed === 0) {
    candidates.push({ pct: 0, ts: periodStart, approx: false, source: 'cycle-reset' });
  }

  // Newest snapshot taken before the boundary.
  let pre = null;
  for (const p of history.periods) {
    if (p.ps < periodStart && p.lastTs <= periodStart && (!pre || p.lastTs > pre.lastTs)) pre = p;
  }
  if (pre) candidates.push({ pct: pre.lastPct, ts: pre.lastTs, approx: false, source: 'prev-period' });

  // First snapshot taken inside the current period.
  const cur = history.periods.find((p) => p.ps === periodStart);
  if (cur) candidates.push({ pct: cur.firstPct, ts: cur.firstTs, approx: false, source: 'period-open' });

  // The statusline's log has no timestamps — its previous-period record is the
  // last value that period saw, so treat it as sitting on the boundary, but
  // flag it: it may have been written many hours earlier.
  const legacyPrev = legacy.find((e) => e.ps === periodStart - DAY);
  if (legacyPrev) {
    candidates.push({ pct: legacyPrev.used_pct, ts: periodStart, approx: true, source: 'statusline-log' });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const d = Math.abs(a.ts - periodStart) - Math.abs(b.ts - periodStart);
    if (d !== 0) return d;
    return Number(a.approx) - Number(b.approx); // prefer a timestamped source
  });
  return candidates[0];
}

// ── The meter ──────────────────────────────────────────────────────────

/**
 * Build the "Today's budget" meter from a weekly reading plus history.
 *
 * @param {{wkCur:number|null, wkResetMs:number|null, nowMs:number, history:History, legacy?:{ps:number, used_pct:number}[]}} a
 * @returns {import('../src/types').DailyMeter|null}
 */
export function computeDailyFrom({ wkCur, wkResetMs, nowMs, history, legacy = [] }) {
  if (wkCur == null) return null;

  const pos = cyclePosition(wkResetMs, nowMs);
  const { daysElapsed, daysRemaining, periodStart } = pos;
  const baseline = pickBaseline(history, legacy, pos);

  // Average daily spend so far this cycle — used to price the stretch of time
  // between the baseline snapshot and the period boundary, which no snapshot
  // covers. With no baseline at all the whole day is unmeasured, and this
  // degrades exactly into the old "spread the total over elapsed days" number.
  const avgDaily = wkCur / (daysElapsed + 1);

  let todayUsed;
  let estimated;
  if (!baseline) {
    todayUsed = avgDaily;
    estimated = true;
  } else {
    const measured = wkCur - baseline.pct;
    // Negative means the weekly counter fell below the baseline (reset or the
    // rolling window moved); the baseline is meaningless then.
    if (measured < 0) {
      todayUsed = avgDaily;
      estimated = true;
    } else {
      // >0 when the baseline predates the boundary (it includes spend that
      // belongs to yesterday), <0 when it was taken after the period opened
      // (it misses spend from the start of today).
      const gapSec = periodStart - baseline.ts;
      todayUsed = measured - (gapSec / DAY) * avgDaily;
      estimated = Math.abs(gapSec) > GRACE_SEC || baseline.approx;
    }
  }
  if (todayUsed < 0) todayUsed = 0;
  if (todayUsed > wkCur) todayUsed = wkCur;

  // Whatever wasn't spent today went to the earlier days of the cycle; any
  // allowance they left unused rolls forward into today's slice.
  const prevSpend = wkCur - todayUsed;
  const leftover = daysElapsed * BASE - prevSpend;
  let todayBudget = BASE + leftover / daysRemaining;
  if (todayBudget < 0) todayBudget = 0;

  let barPct = todayBudget > 0 ? (todayUsed * 100) / todayBudget : 100;
  if (barPct > 100) barPct = 100;

  return {
    label: "Today's budget",
    kind: 'daily',
    usedPct: barPct,
    resetsAtMs: (periodStart + DAY) * 1000,
    estimated,
    // Matches the statusline's "$tu/$tb%" — without this the frontend falls
    // back to plain "N% used" (the used/budget ratio), which reads as stuck
    // at 0% whenever today's usage hasn't caught up to the rolling budget.
    valueText: `${Math.trunc(todayUsed)}/${Math.trunc(todayBudget)}%`,
    todayUsed,
    todayBudget,
    deltaPct: todayUsed - todayBudget,
  };
}

/**
 * I/O wrapper: record the current reading, then compute the meter.
 *
 * @param {number|null} wkCur      weekly "All models" used %
 * @param {number|null} wkResetMs  weekly reset, epoch ms
 * @param {{historyPath:string, legacyPath:string, nowMs?:number}} paths
 * @returns {import('../src/types').DailyMeter|null}
 */
export function computeDaily(wkCur, wkResetMs, { historyPath, legacyPath, nowMs = Date.now() }) {
  if (wkCur == null) return null;
  const pos = cyclePosition(wkResetMs, nowMs);
  const history = readHistory(historyPath);
  const changed = recordSnapshot(history, {
    periodStart: pos.periodStart,
    pct: wkCur,
    nowSec: Math.floor(nowMs / 1000),
  });
  if (changed) writeHistory(historyPath, history);
  return computeDailyFrom({
    wkCur, wkResetMs, nowMs, history, legacy: readLegacyLog(legacyPath),
  });
}
