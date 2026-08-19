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
import { computeDaily } from './daily.js';
import { aggregate, parseTranscriptLine, projectLabel } from './history.js';
import { readClaudeSessions } from './sessions.js';
import { getContext, killSession, resumeSession, cleanup } from './sessionActions.js';

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
 * Our own snapshot log of the weekly %, written on every live fetch. It is what
 * makes "today's budget" a measurement instead of a guess — see dist/daily.js.
 */
const HISTORY_PATH =
  process.env.CLAUDE_LIMITS_HISTORY ||
  path.join(os.homedir(), '.claude', 'cloudcli-claude-limits-history.json');

/**
 * The statusline's rolling weekly-budget log. READ-ONLY, and only as a
 * fallback baseline: the statusline writes it while rendering an interactive
 * prompt, so it stays empty for CloudCLI and headless `claude -p` sessions.
 */
const USAGE_LOG_PATH =
  process.env.CLAUDE_LIMITS_USAGE_LOG ||
  path.join(os.homedir(), '.claude', 'usage_log.json');

/** Root of the transcripts read by /history and the session inventory. */
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// ── Credentials ────────────────────────────────────────────────────────

/**
 * Read the current OAuth credentials from disk on every (uncached) call so we
 * always use the freshest access token Claude Code has written.
 * @returns {{ accessToken: string|null, subscriptionType: string|null, rateLimitTier: string|null, scopes: string[] }}
 */
function readCredentials() {
  let raw;
  try {
    raw = fs.readFileSync(CREDS_PATH, 'utf8');
  } catch {
    return { accessToken: null, subscriptionType: null, rateLimitTier: null, scopes: [] };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { accessToken: null, subscriptionType: null, rateLimitTier: null, scopes: [] };
  }
  // Known shape: { claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier } }
  // Be liberal: also accept a flatter shape just in case.
  const o = json.claudeAiOauth || json.oauth || json;
  const accessToken =
    o.accessToken || o.access_token || o.token || null;
  const subscriptionType =
    o.subscriptionType || o.subscription_type || o.plan || null;
  // e.g. "default_claude_max_20x" — the only place the plan's rate-limit
  // multiplier is available locally; the /oauth/usage response's own
  // plan/tier fields don't reliably carry it.
  const rateLimitTier =
    o.rateLimitTier || o.rate_limit_tier || null;
  const scopes = Array.isArray(o.scopes) ? o.scopes : [];
  return { accessToken, subscriptionType, rateLimitTier, scopes };
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
 * @param {any} raw @param {{subscriptionType: string|null, rateLimitTier: string|null}} creds
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

  /** @type {import('../src/types').Meter|null} */
  let session = null;
  /** @type {import('../src/types').Meter[]} */
  let weekly = [];

  // Preferred source: `raw.limits[]`, a flat list of self-describing entries
  // ({kind, percent, resets_at, scope}). This is what tells us which model
  // Anthropic is currently spotlighting with its own weekly cap — right now
  // that's Fable, but the point is we never hardcode a name: whatever
  // `weekly_scoped` entry (and its `scope.model.display_name`) the API sends
  // is the one we show. The older flat `seven_day_<model>` keys have started
  // coming back as opaque rotating codenames (`nimbus_quill`,
  // `omelette_promotional`, ...) that no longer say which model they mean, so
  // they're kept only as a fallback below for API shapes without `limits[]`.
  const limitsArr = raw && typeof raw === 'object' && Array.isArray(raw.limits) ? raw.limits : null;

  if (limitsArr && limitsArr.length) {
    for (const entry of limitsArr) {
      if (!entry || typeof entry !== 'object') continue;
      const pctVal = usedPct(entry);
      const resets = resetMs(entry);
      if (entry.kind === 'session') {
        session = { label: 'Current session', usedPct: pctVal, resetsAtMs: resets, kind: 'session' };
      } else if (entry.kind === 'weekly_all') {
        weekly.push({ label: 'All models', usedPct: pctVal, resetsAtMs: resets, kind: 'weekly' });
      } else if (entry.kind === 'weekly_scoped') {
        const modelName = entry.scope && entry.scope.model && entry.scope.model.display_name;
        weekly.push({
          label: modelName ? String(modelName) : 'Weekly',
          usedPct: pctVal,
          resetsAtMs: resets,
          kind: 'weekly',
        });
      }
      // Other/future `kind`s are left alone rather than guessed at.
    }
  }

  if (!session || !weekly.length) {
    // --- legacy fallback: flat five_hour / seven_day* keys, regex-guessed ---
    if (!session) {
      const sessionKey = Object.keys(root).find((k) =>
        /^(five[_-]?hour|5[_-]?hour|session|current)/i.test(k),
      );
      const sNode = sessionKey ? root[sessionKey] : null;
      session = sNode
        ? { label: 'Current session', usedPct: usedPct(sNode), resetsAtMs: resetMs(sNode), kind: 'session' }
        : null;
    }
    if (!weekly.length) {
      const weeklyKeys = Object.keys(root).filter((k) =>
        /^(seven[_-]?day|7[_-]?day|week)/i.test(k),
      );
      weekly = weeklyKeys
        .map((k) => ({
          label: weeklyLabel(k),
          usedPct: usedPct(root[k]),
          resetsAtMs: resetMs(root[k]),
          kind: 'weekly',
        }))
        .filter((m) => m.usedPct != null || m.resetsAtMs != null);
    }
  }

  // "All models" first, then the rest as-is.
  weekly.sort((a, b) => (a.label === 'All models' ? -1 : b.label === 'All models' ? 1 : 0));

  // --- plan label ---
  const rawPlan =
    (raw && typeof raw === 'object' &&
      (raw.plan || raw.tier || raw.subscription || raw.subscription_type || raw.plan_type)) ||
    null;
  const plan =
    prettyPlan(rawPlan, creds.rateLimitTier) || prettyPlan(creds.subscriptionType, creds.rateLimitTier);

  // Host of the machine the plugin backend runs on — the TUI header shows it
  // as a shell-style `limits@<host>` prompt. The frontend can't read this
  // itself: in the browser `location.hostname` is whatever domain was used to
  // reach the panel, not the server's own name.
  return { plan, session, weekly, host: os.hostname() || null, fetchedAt: Date.now() };
}

/**
 * @param {any} p plan/tier/subscription string, e.g. "max", "max_20x"
 * @param {string|null} [tierHint] rateLimitTier fallback, e.g. "default_claude_max_20x",
 *   used for the multiplier when `p` itself doesn't carry one.
 * @returns {string|null}
 */
function prettyPlan(p, tierHint) {
  if (!p || typeof p !== 'string') return null;
  const k = p.toLowerCase();
  const numFrom = (s) => {
    const m = s && s.match(/(\d+)\s*x/);
    return m ? m[1] : null;
  };
  if (k.includes('max')) {
    // e.g. "max", "max_5x", "max_20x" — or, failing that, the rate-limit tier.
    const n = numFrom(k) || numFrom(typeof tierHint === 'string' ? tierHint.toLowerCase() : '');
    return n ? `Max (${n}x)` : 'Max';
  }
  if (k.includes('pro')) return 'Pro';
  if (k.includes('team')) return 'Team';
  if (k.includes('free')) return 'Free';
  return p.charAt(0).toUpperCase() + p.slice(1);
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
  data.daily = allModels
    ? computeDaily(allModels.usedPct, allModels.resetsAtMs, {
        historyPath: HISTORY_PATH,
        legacyPath: USAGE_LOG_PATH,
      })
    : null;
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

// ── History (token/cost aggregation) ──────────────────────────────────

/**
 * Per-file parse cache keyed by mtime, so repeated polls only re-read changed
 * transcripts. Ported from cloudcli-plugin-claude-usage/src/server.ts.
 * @type {Map<string, {mtimeMs: number, entries: import('./history.js').UsageEntry[]}>}
 */
const historyFileCache = new Map();

/** @param {string} file */
function readSessionFile(file) {
  const mtimeMs = fs.statSync(file).mtimeMs;
  const cached = historyFileCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.entries;
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const e = parseTranscriptLine(line);
    if (e) entries.push(e);
  }
  historyFileCache.set(file, { mtimeMs, entries });
  return entries;
}

/** @param {number} days */
function getHistory(days) {
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  const sessions = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    // no transcripts at all — aggregate over nothing, frontend shows empty state
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const project = projectLabel(dir.name);
    let files = [];
    try {
      files = fs.readdirSync(path.join(projectsDir, dir.name)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        sessions.push({ project, entries: readSessionFile(path.join(projectsDir, dir.name, f)) });
      } catch {
        /* unreadable file — skip */
      }
    }
  }
  return aggregate(sessions, days, Date.now());
}

// ── Request bodies ─────────────────────────────────────────────────────

/** @param {import('http').IncomingMessage} req @param {import('http').ServerResponse} res */
function readJsonBody(req, res) {
  return new Promise((resolve) => {
    let body = '';
    const MAX_BODY = 4096;
    let aborted = false;
    req.on('data', (d) => {
      body += d;
      if (body.length > MAX_BODY) {
        aborted = true;
        res.writeHead(413);
        res.end(JSON.stringify({ ok: false, error: 'Request too large' }));
        req.socket.destroy();
        resolve(null);
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve(undefined); // signals "bad json" to the caller
      }
    });
  });
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

  if (req.method === 'GET' && url.pathname.replace(/\/+$/, '') === '/history') {
    try {
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
      res.end(JSON.stringify(getHistory(days)));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: errMsg(err) }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.replace(/\/+$/, '') === '/sessions') {
    try {
      res.end(JSON.stringify({ ok: true, sessions: readClaudeSessions(null) }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: errMsg(err) }));
    }
    return;
  }

  const contextMatch = url.pathname.match(/^\/sessions\/(\d+)\/context\/?$/);
  if (req.method === 'GET' && contextMatch) {
    try {
      const { status, body } = await getContext(parseInt(contextMatch[1], 10));
      res.writeHead(status);
      res.end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: errMsg(err) }));
    }
    return;
  }

  const killMatch = url.pathname.match(/^\/sessions\/(\d+)\/kill\/?$/);
  if (req.method === 'POST' && killMatch) {
    try {
      const { status, body } = killSession(parseInt(killMatch[1], 10));
      res.writeHead(status);
      res.end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: errMsg(err) }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.replace(/\/+$/, '') === '/sessions/resume') {
    const parsed = await readJsonBody(req, res);
    if (parsed === null) return; // readJsonBody already responded (413)
    if (parsed === undefined) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: 'bad json' }));
      return;
    }
    try {
      const { status, body } = resumeSession(parsed);
      res.writeHead(status);
      res.end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: errMsg(err) }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.replace(/\/+$/, '') === '/sessions/cleanup') {
    try {
      const { status, body } = await cleanup();
      res.writeHead(status);
      res.end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: errMsg(err) }));
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
