// @ts-check
/**
 * Claude Limits — backend subprocess.
 *
 * Runs as a CloudCLI plugin server (restricted env: PATH, HOME, NODE_ENV,
 * PLUGIN_NAME). It reads the local Claude OAuth token from disk, calls the
 * Anthropic usage endpoint that powers `/usage`, normalizes the response into
 * a claude.ai-style shape, caches it, and serves it to the frontend via RPC.
 *
 * The frontend calls:
 *   GET /limits          -> cached (<= CACHE_TTL_MS old) or fresh
 *   GET /limits?force=1  -> always fresh
 *
 * We never rotate the refresh token (that would break Claude Code's login).
 * We just read the freshest access token Claude Code has written to disk.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Config ─────────────────────────────────────────────────────────────

/** Endpoint that returns plan usage limits. Override with CLAUDE_LIMITS_ENDPOINT. */
const USAGE_ENDPOINT =
  process.env.CLAUDE_LIMITS_ENDPOINT || 'https://api.anthropic.com/api/oauth/usage';

/** Beta header Claude Code sends for OAuth-scoped endpoints. */
const OAUTH_BETA = 'oauth-2025-04-20';

/**
 * How long a live result is reused before we hit the API again. Kept well
 * below the frontend's shortest selectable refresh interval so a user-chosen
 * poll rate always gets fresh data; this only de-dupes bursts (e.g. several
 * tabs/renders asking at once).
 */
const CACHE_TTL_MS = 5_000;

/** Where Claude Code stores its OAuth credentials. */
const CREDS_PATH =
  process.env.CLAUDE_LIMITS_CREDS ||
  path.join(os.homedir(), '.claude', '.credentials.json');

/**
 * The statusline's rolling weekly-budget log. We only READ it (the statusline
 * writes it on every prompt render) to compute the exact same daily budget.
 */
const USAGE_LOG_PATH =
  process.env.CLAUDE_LIMITS_USAGE_LOG ||
  path.join(os.homedir(), '.claude', 'usage_log.json');

// ── Credentials ────────────────────────────────────────────────────────

/**
 * Read the current OAuth credentials from disk on every (uncached) call so we
 * always use the freshest access token Claude Code has written.
 * @returns {{ accessToken: string|null, subscriptionType: string|null, scopes: string[] }}
 */
function readCredentials() {
  let raw;
  try {
    raw = fs.readFileSync(CREDS_PATH, 'utf8');
  } catch {
    return { accessToken: null, subscriptionType: null, scopes: [] };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { accessToken: null, subscriptionType: null, scopes: [] };
  }
  // Known shape: { claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes, subscriptionType } }
  // Be liberal: also accept a flatter shape just in case.
  const o = json.claudeAiOauth || json.oauth || json;
  const accessToken =
    o.accessToken || o.access_token || o.token || null;
  const subscriptionType =
    o.subscriptionType || o.subscription_type || o.plan || null;
  const scopes = Array.isArray(o.scopes) ? o.scopes : [];
  return { accessToken, subscriptionType, scopes };
}

// ── Normalization ──────────────────────────────────────────────────────

/**
 * First numeric value found among `keys` on `obj`. Accepts numeric strings.
 * @param {any} obj @param {string[]} keys @returns {number|null}
 */
function firstNum(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

/**
 * Normalize a percent value to 0..100. Some fields are fractions (0..1).
 * @param {number|null} n @returns {number|null}
 */
function toPercent(n) {
  if (n == null) return null;
  // Heuristic: a non-integer between 0 and 1 is a fraction -> scale to %.
  if (n > 0 && n <= 1 && !Number.isInteger(n)) n = n * 100;
  if (n < 0) n = 0;
  if (n > 100) n = 100;
  return n;
}

/**
 * Normalize a reset timestamp (epoch seconds, epoch ms, or ISO string) to ms.
 * @param {any} node @returns {number|null}
 */
function resetMs(node) {
  if (!node || typeof node !== 'object') return null;
  const keys = ['resets_at', 'reset_at', 'resetsAt', 'resetAt', 'reset', 'expires_at'];
  for (const k of keys) {
    const v = node[k];
    if (v == null) continue;
    if (typeof v === 'number' && Number.isFinite(v)) return numToMs(v);
    if (typeof v === 'string' && v.trim() !== '') {
      if (/^\d+$/.test(v.trim())) return numToMs(Number(v));
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

/** @param {number} n @returns {number|null} */
function numToMs(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e15) return Math.round(n / 1000); // microseconds -> ms
  if (n > 1e12) return Math.round(n);         // already ms
  if (n > 1e9) return Math.round(n * 1000);   // seconds -> ms
  return null;
}

/** @param {any} node @returns {number|null} */
function usedPct(node) {
  return toPercent(
    firstNum(node, [
      'used_percentage',
      'utilization',
      'used_pct',
      'usedPercent',
      'percent_used',
      'percentage',
      'percent',
      'used',
    ]),
  );
}

/**
 * Turn a `seven_day*` key into a human label.
 * @param {string} key @returns {string}
 */
function weeklyLabel(key) {
  const k = key.toLowerCase();
  if (/opus/.test(k)) return 'Opus';
  if (/fable/.test(k)) return 'Fable';
  if (/sonnet/.test(k)) return 'Sonnet';
  if (/haiku/.test(k)) return 'Haiku';
  // plain seven_day / week -> the aggregate bucket
  if (/^(seven[_-]?day|7[_-]?day|week(ly)?)$/.test(k)) return 'All models';
  // fallback: humanize the suffix after the period marker
  const suffix = k.replace(/^(seven[_-]?day|7[_-]?day|week(ly)?)[_-]?/, '');
  if (!suffix) return 'All models';
  return suffix.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Map a raw usage response into the claude.ai-style shape.
 * @param {any} raw @param {{subscriptionType: string|null}} creds
 * @returns {import('../src/types').Limits}
 */
function normalize(raw, creds) {
  // The statusline receives this under `rate_limits`; the HTTP response may put
  // the buckets at the top level. Support both.
  const root =
    raw && typeof raw === 'object' && raw.rate_limits && typeof raw.rate_limits === 'object'
      ? raw.rate_limits
      : raw && typeof raw === 'object'
        ? raw
        : {};

  // --- session (5-hour) ---
  const sessionKey = Object.keys(root).find((k) =>
    /^(five[_-]?hour|5[_-]?hour|session|current)/i.test(k),
  );
  const sNode = sessionKey ? root[sessionKey] : null;
  /** @type {import('../src/types').Meter|null} */
  const session = sNode
    ? { label: 'Current session', usedPct: usedPct(sNode), resetsAtMs: resetMs(sNode), kind: 'session' }
    : null;

  // --- weekly buckets (seven_day*) ---
  const weeklyKeys = Object.keys(root).filter((k) =>
    /^(seven[_-]?day|7[_-]?day|week)/i.test(k),
  );
  /** @type {import('../src/types').Meter[]} */
  const weekly = weeklyKeys.map((k) => ({
    label: weeklyLabel(k),
    usedPct: usedPct(root[k]),
    resetsAtMs: resetMs(root[k]),
    kind: 'weekly',
  }));
  // "All models" first, then the rest as-is.
  weekly.sort((a, b) => (a.label === 'All models' ? -1 : b.label === 'All models' ? 1 : 0));

  // --- plan label ---
  const rawPlan =
    (raw && typeof raw === 'object' &&
      (raw.plan || raw.tier || raw.subscription || raw.subscription_type || raw.plan_type)) ||
    null;
  const plan = prettyPlan(rawPlan) || prettyPlan(creds.subscriptionType);

  // Host of the machine the plugin backend runs on — the TUI header shows it
  // as a shell-style `limits@<host>` prompt. The frontend can't read this
  // itself: in the browser `location.hostname` is whatever domain was used to
  // reach the panel, not the server's own name.
  return { plan, session, weekly, host: os.hostname() || null, fetchedAt: Date.now() };
}

/** @param {any} p @returns {string|null} */
function prettyPlan(p) {
  if (!p || typeof p !== 'string') return null;
  const k = p.toLowerCase();
  if (k.includes('max')) {
    // e.g. "max", "max_5x", "max_20x"
    const m = k.match(/(\d+)\s*x/);
    return m ? `Max (${m[1]}x)` : 'Max';
  }
  if (k.includes('pro')) return 'Pro';
  if (k.includes('team')) return 'Team';
  if (k.includes('free')) return 'Free';
  return p.charAt(0).toUpperCase() + p.slice(1);
}

// ── Daily budget (replicates the statusline "24" segment) ──────────────

/**
 * Read the statusline's rolling weekly-budget log (read-only).
 * @returns {{ps:number, used_pct:number}[]}
 */
function readUsageLog() {
  try {
    const arr = JSON.parse(fs.readFileSync(USAGE_LOG_PATH, 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((e) => ({ ps: Number(e && e.ps), used_pct: Number(e && e.used_pct) }))
      .filter((e) => Number.isFinite(e.ps) && e.ps > 0 && Number.isFinite(e.used_pct));
  } catch {
    return [];
  }
}

/**
 * Compute today's rolling budget exactly like ~/.claude/statusline-command.sh
 * (the "24" segment): anchor 24h periods to the weekly reset, derive prior
 * spend from the log, then distribute the remaining weekly budget over the
 * remaining days. Numbers match the statusline's `tu/tb%`.
 *
 * @param {number|null} wkCur     weekly "All models" used_percentage (0..100)
 * @param {number|null} wkResetMs weekly reset time in ms (null → weekday fallback)
 * @returns {import('../src/types').DailyMeter|null}
 */
function computeDaily(wkCur, wkResetMs) {
  if (wkCur == null) return null;
  const DAY = 86400;
  const now = Math.floor(Date.now() / 1000);

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
    const dt = new Date();
    const iso = ((dt.getDay() + 6) % 7) + 1;
    daysElapsed = iso - 1;
    periodStart = Math.floor(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime() / 1000);
    cycleStart = periodStart - daysElapsed * DAY;
  }
  const daysRemaining = 7 - daysElapsed;

  // prev_spend: cumulative positive deltas of prior periods in this cycle.
  const prior = readUsageLog()
    .filter((e) => e.ps >= cycleStart && e.ps < periodStart)
    .sort((a, b) => a.ps - b.ps);
  let prevSpend = 0;
  let prevVal = 0;
  for (const e of prior) {
    let delta = e.used_pct - prevVal;
    if (delta < 0) delta = 0;
    prevSpend += delta;
    prevVal = e.used_pct;
  }

  const base = 100 / 7;
  let coldStart = false;
  let todayUsed;
  let prevAssumed;
  if (daysElapsed > 0 && wkCur > 0 && (prevSpend === 0 || prevSpend >= wkCur)) {
    // No prior-day logs, OR the delta-summed prevSpend is >= the current
    // weekly total — which is impossible (you can't have spent more before
    // today than the running total includes now) and means Anthropic's
    // rolling 7-day % dipped between snapshots (old usage aged out of the
    // window), making the log's day-over-day deltas untrustworthy for this
    // cycle. Fall back to spreading the current total evenly across the
    // elapsed days instead of trusting the bogus delta-sum.
    coldStart = true;
    todayUsed = wkCur / (daysElapsed + 1);
    prevAssumed = wkCur - todayUsed;
  } else {
    todayUsed = wkCur - prevSpend;
    if (todayUsed < 0) todayUsed = 0;
    prevAssumed = prevSpend;
  }

  const expected = daysElapsed * base;
  const leftover = expected - prevAssumed;
  let todayBudget = base + leftover / daysRemaining;
  if (todayBudget < 0) todayBudget = 0;

  let barPct = todayBudget > 0 ? (todayUsed * 100) / todayBudget : 100;
  if (barPct > 100) barPct = 100;

  const periodEnd = periodStart + DAY;
  return {
    label: "Today's budget",
    kind: 'daily',
    usedPct: barPct,
    resetsAtMs: periodEnd * 1000,
    estimated: coldStart,
    // Matches the statusline's "$tu/$tb%" — without this the frontend falls
    // back to plain "N% used" (the used/budget ratio), which reads as stuck
    // at 0% whenever today's usage hasn't caught up to the rolling budget.
    valueText: `${Math.trunc(todayUsed)}/${Math.trunc(todayBudget)}%`,
    todayUsed,
    todayBudget,
    deltaPct: todayUsed - todayBudget,
  };
}

// ── Fetch + cache ──────────────────────────────────────────────────────

/** @type {import('../src/types').LimitsResponse|null} */
let cache = null;

/**
 * @param {boolean} force
 * @returns {Promise<import('../src/types').LimitsResponse>}
 */
async function getLimits(force) {
  if (!force && cache && cache.ok && cache.data && Date.now() - cache.data.fetchedAt < CACHE_TTL_MS) {
    return { ...cache, source: 'cache' };
  }

  const creds = readCredentials();
  if (!creds.accessToken) {
    return fail('no_credentials', `No Claude OAuth token found at ${CREDS_PATH}. Sign in with a Claude Pro/Max subscription in Claude Code.`);
  }

  let res;
  try {
    res = await fetch(USAGE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': OAUTH_BETA,
        'anthropic-version': '2023-06-01',
        'User-Agent': 'cloudcli-claude-limits/1.0',
        Accept: 'application/json',
      },
    });
  } catch (err) {
    return fail('network', `Could not reach ${USAGE_ENDPOINT}: ${errMsg(err)}`);
  }

  const bodyText = await res.text();
  /** @type {any} */
  let raw = null;
  try {
    raw = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    raw = { _nonJsonBody: bodyText.slice(0, 2000) };
  }

  if (!res.ok) {
    const code = res.status === 401 || res.status === 403 ? 'unauthorized' : 'http_error';
    const hint =
      code === 'unauthorized'
        ? 'Token expired or missing the user:profile scope. Use Claude Code briefly (it refreshes the token), then Refresh.'
        : `Endpoint returned HTTP ${res.status}. If this persists, the usage URL may have changed — see README.`;
    return {
      ok: false,
      code,
      status: res.status,
      error: hint,
      raw,
      source: 'live',
      endpoint: USAGE_ENDPOINT,
    };
  }

  const data = normalize(raw, creds);
  const allModels = data.weekly.find((w) => w.label === 'All models') || data.weekly[0] || null;
  data.daily = allModels ? computeDaily(allModels.usedPct, allModels.resetsAtMs) : null;
  const out = /** @type {import('../src/types').LimitsResponse} */ ({
    ok: true,
    data,
    raw,
    status: res.status,
    source: 'live',
    endpoint: USAGE_ENDPOINT,
  });
  cache = out;
  return out;
}

/**
 * @param {import('../src/types').LimitsResponse['code']} code
 * @param {string} error
 * @returns {import('../src/types').LimitsResponse}
 */
function fail(code, error) {
  return { ok: false, code, error, source: 'live', endpoint: USAGE_ENDPOINT };
}

/** @param {unknown} e @returns {string} */
function errMsg(e) {
  return e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
}

// ── HTTP server ────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname.replace(/\/+$/, '') === '/limits') {
    const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
    try {
      const out = await getLimits(force);
      res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify(fail('http_error', errMsg(err))));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.end(JSON.stringify({ ok: true, service: 'cloudcli-claude-limits', endpoint: USAGE_ENDPOINT }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr !== 'string') {
    // Required readiness signal for the host.
    console.log(JSON.stringify({ ready: true, port: addr.port }));
  }
});
