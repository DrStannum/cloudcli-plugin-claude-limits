// Backend integration test: spawns dist/server.js against a mock upstream, a
// fake credentials file, and an isolated temp $HOME (so /history, /sessions
// and /sessions/cleanup never touch the real ~/.claude directory), then
// asserts every route's response shape. No network / no real credentials
// required, and nothing here kills a real process or spawns `su`.
// Run: node tests/smoke.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── isolated fake $HOME ──────────────────────────────────────────────────
// /history and /sessions/cleanup derive their paths from os.homedir(), which
// on POSIX Node reads the HOME env var — so pointing HOME at a scratch
// directory keeps every filesystem side effect (including cleanup's deletes
// and gzips) confined to files this test creates and removes itself.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-smoke-home-'));
const claudeDir = path.join(tmpHome, '.claude');
fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
const projectDir = path.join(claudeDir, 'projects', '-tmp-cl-smoke-project');
fs.mkdirSync(projectDir, { recursive: true });

const tmp = path.join(os.tmpdir(), 'cl-fake-creds.json');
// Keep the backend's snapshot log out of the real ~/.claude during tests.
const histFile = path.join(os.tmpdir(), `cl-smoke-history-${process.pid}.json`);
const noLegacy = path.join(os.tmpdir(), 'cl-smoke-no-statusline-log.json');
fs.writeFileSync(tmp, JSON.stringify({
  claudeAiOauth: { accessToken: 'test-token', subscriptionType: 'max_5x', scopes: ['user:profile'] },
}));

// A recent transcript entry for /history to aggregate.
const recentLine = JSON.stringify({
  type: 'assistant',
  timestamp: new Date().toISOString(),
  message: {
    id: 'msg_smoke_1',
    model: 'claude-sonnet-4-5',
    usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
});
fs.writeFileSync(path.join(projectDir, '11111111-1111-4111-8111-111111111111.jsonl'), recentLine + '\n');

// An old transcript (mtime > 30 days) for /sessions/cleanup to gzip.
const oldFile = path.join(projectDir, '22222222-2222-4222-8222-222222222222.jsonl');
fs.writeFileSync(oldFile, JSON.stringify({
  type: 'assistant',
  timestamp: new Date(Date.now() - 40 * 86400e3).toISOString(),
  message: { id: 'msg_smoke_old', model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
}) + '\n');
const old = new Date(Date.now() - 40 * 86400e3);
fs.utimesSync(oldFile, old, old);

// An orphaned session record (pid that certainly isn't running) for
// /sessions/cleanup to delete.
const DEAD_PID = 999999;
fs.writeFileSync(path.join(claudeDir, 'sessions', `${DEAD_PID}.json`), JSON.stringify({
  pid: DEAD_PID, sessionId: 'dead-session', cwd: '/does/not/exist',
}));

const nowSec = Math.floor(Date.now() / 1000);
// Weekly reset placed so that the current 24h period opened a minute ago —
// the "nothing spent today yet" case that used to read as the cycle average.
const satIso = new Date((nowSec + 3 * 86400 - 60) * 1000).toISOString();
const fableMs = Date.now() + 3 * 86400e3;

const upstream = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    plan: 'max_5x',
    rate_limits: {
      five_hour: { used_percentage: 1, resets_at: nowSec + 17700 },   // epoch seconds
      seven_day: { used_percentage: 65, resets_at: satIso },          // ISO string
      seven_day_fable: { used_percentage: 0, resets_at: fableMs },    // epoch ms
    },
  }));
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upPort = upstream.address().port;

const child = spawn('node', [path.join(PLUGIN, 'dist/server.js')], {
  env: {
    PATH: process.env.PATH, HOME: tmpHome, NODE_ENV: 'production',
    PLUGIN_NAME: 'cloudcli-claude-limits',
    CLAUDE_LIMITS_CREDS: tmp,
    CLAUDE_LIMITS_ENDPOINT: `http://127.0.0.1:${upPort}/usage`,
    CLAUDE_LIMITS_HISTORY: histFile,
    CLAUDE_LIMITS_USAGE_LOG: noLegacy,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => (stderr += d));
const port = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('no ready signal; stderr=' + stderr)), 5000);
  child.stdout.on('data', (d) => {
    buf += d;
    const line = buf.split('\n').find((l) => l.includes('"ready"'));
    if (line) { clearTimeout(t); resolve(JSON.parse(line).port); }
  });
});

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ── /limits (unchanged behavior) ──────────────────────────────────────
const r = await (await fetch(`http://127.0.0.1:${port}/limits`)).json();
ok(r.ok === true, 'ok true');
ok(r.data?.plan === 'Max (5x)', `plan "Max (5x)", got ${r.data?.plan}`);
ok(r.data?.session?.usedPct === 1, `session pct 1, got ${r.data?.session?.usedPct}`);
ok(r.data?.session?.resetsAtMs > 1e12, 'session resetsAtMs from seconds');
const all = r.data.weekly.find((w) => w.label === 'All models');
const fable = r.data.weekly.find((w) => w.label === 'Fable');
ok(r.data.weekly[0]?.label === 'All models', 'All models first');
ok(all?.usedPct === 65, `All models 65, got ${all?.usedPct}`);
ok(all?.resetsAtMs > 1e12, 'All models resetsAtMs from ISO');
ok(fable?.usedPct === 0, `Fable 0, got ${fable?.usedPct}`);
ok(fable?.resetsAtMs > 1e12, 'Fable resetsAtMs from ms');
ok(
  typeof r.data?.daily?.valueText === 'string' && /^\d+\/\d+%$/.test(r.data.daily.valueText),
  `daily valueText "used/budget%" (statusline "$tu/$tb%" format), got ${r.data?.daily?.valueText}`,
);
// The weekly reset in the mock puts us at the very start of a period, so
// nothing has been spent today yet — the pre-fix code reported the cycle
// average here instead (weekly 65% -> ~13%).
ok(r.data?.daily?.todayUsed < 0.1, `daily todayUsed ~0 at a period boundary, got ${r.data?.daily?.todayUsed}`);
ok(r.data?.daily?.estimated === false, 'daily measured, not estimated');
ok(fs.existsSync(histFile), 'backend persisted its snapshot log');
ok(
  r.data?.host === os.hostname(),
  `host is this server's hostname "${os.hostname()}", got ${r.data?.host}`,
);
const r2 = await (await fetch(`http://127.0.0.1:${port}/limits`)).json();
ok(r2.source === 'cache', `2nd call cached, got ${r2.source}`);
const r3 = await (await fetch(`http://127.0.0.1:${port}/limits?force=1`)).json();
ok(r3.source === 'live', `force call live, got ${r3.source}`);

// ── /limits via the structured `raw.limits[]` shape ─────────────────────
// Anthropic's live response (confirmed 2026-08-19) carries a self-describing
// `limits[]` array alongside the legacy flat keys; its `weekly_scoped` entry
// names the spotlighted model via `scope.model.display_name` (currently
// "Fable" on this account) instead of a guessable key name — the flat
// `seven_day_*` keys have started coming back as opaque rotating codenames
// that no longer say which model they mean. This must be read generically,
// so the mock below deliberately uses a model name ("Nova") that appears
// nowhere in the backend's code, proving nothing is hardcoded.
{
  const histFile2 = path.join(os.tmpdir(), `cl-smoke-history2-${process.pid}.json`);
  const upstream2 = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      limits: [
        { kind: 'session', percent: 12, resets_at: new Date(Date.now() + 3600e3).toISOString() },
        { kind: 'weekly_all', percent: 40, resets_at: satIso },
        {
          kind: 'weekly_scoped', percent: 77, resets_at: satIso,
          scope: { model: { id: 'nova-1', display_name: 'Nova' } },
        },
      ],
    }));
  });
  await new Promise((r) => upstream2.listen(0, '127.0.0.1', r));
  const upPort2 = upstream2.address().port;
  const child2 = spawn('node', [path.join(PLUGIN, 'dist/server.js')], {
    env: {
      PATH: process.env.PATH, HOME: tmpHome, NODE_ENV: 'production',
      PLUGIN_NAME: 'cloudcli-claude-limits',
      CLAUDE_LIMITS_CREDS: tmp,
      CLAUDE_LIMITS_ENDPOINT: `http://127.0.0.1:${upPort2}/usage`,
      CLAUDE_LIMITS_HISTORY: histFile2,
      CLAUDE_LIMITS_USAGE_LOG: noLegacy,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr2 = '';
  child2.stderr.on('data', (d) => (stderr2 += d));
  const port2 = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('no ready signal; stderr=' + stderr2)), 5000);
    child2.stdout.on('data', (d) => {
      buf += d;
      const line = buf.split('\n').find((l) => l.includes('"ready"'));
      if (line) { clearTimeout(t); resolve(JSON.parse(line).port); }
    });
  });
  const r4 = await (await fetch(`http://127.0.0.1:${port2}/limits`)).json();
  ok(r4.data?.session?.usedPct === 12, `limits[]: session pct from kind:session, got ${r4.data?.session?.usedPct}`);
  const all2 = r4.data?.weekly?.find((w) => w.label === 'All models');
  const nova = r4.data?.weekly?.find((w) => w.label === 'Nova');
  ok(all2?.usedPct === 40, `limits[]: All models from kind:weekly_all, got ${all2?.usedPct}`);
  ok(!!nova, 'limits[]: an unrecognized model name from scope.model.display_name still surfaces (not hardcoded)');
  ok(nova?.usedPct === 77, `limits[]: scoped model pct, got ${nova?.usedPct}`);
  child2.kill(); upstream2.close();
  try { fs.unlinkSync(histFile2); } catch { /* never created */ }
}

// ── /history ─────────────────────────────────────────────────────────
const hist = await (await fetch(`http://127.0.0.1:${port}/history?days=30`)).json();
ok(Array.isArray(hist.daily) && hist.daily.length === 30, `history: 30-day series, got ${hist.daily?.length}`);
// Only the recent entry falls inside the 30-day window — the 40-day-old one
// (there to exercise /sessions/cleanup below) is correctly excluded.
ok(hist.totals?.messages === 1, `history: only the in-window fixture message counted, got ${hist.totals?.messages}`);
ok(hist.totals?.tokens?.input === 1000, `history: input tokens summed, got ${hist.totals?.tokens?.input}`);
const byModelSonnet = hist.byModel?.find((m) => m.model === 'claude-sonnet-4-5');
ok(!!byModelSonnet, 'history: byModel has the fixture model');
ok(hist.byProject?.length >= 1, 'history: byProject has at least one project');
const todayRow = hist.daily[hist.daily.length - 1];
ok(todayRow && todayRow.tokens.input >= 1000, `history: today's bucket has the recent entry, got ${JSON.stringify(todayRow)}`);

// ── /sessions ────────────────────────────────────────────────────────
const sess = await (await fetch(`http://127.0.0.1:${port}/sessions`)).json();
ok(sess.ok === true, 'sessions: ok true');
ok(Array.isArray(sess.sessions), 'sessions: sessions is an array');

// ── action routes: no real kill, no real resume, only reject-bad-input ──
const killBad = await fetch(`http://127.0.0.1:${port}/sessions/${DEAD_PID}/kill`, { method: 'POST' });
const killBadBody = await killBad.json();
ok(killBad.status === 403, `kill on an unknown pid is rejected with 403, got ${killBad.status}`);
ok(killBadBody.ok === false, 'kill on an unknown pid: ok false');

// A pid distinct from DEAD_PID (which has a fixture session record on
// purpose, for the cleanup test below) and with no session record at all.
const NO_RECORD_PID = 999998;
const ctxBad = await fetch(`http://127.0.0.1:${port}/sessions/${NO_RECORD_PID}/context`);
ok(ctxBad.status === 404, `context for a pid with no session record is 404, got ${ctxBad.status}`);

const resumeBadFormat = await fetch(`http://127.0.0.1:${port}/sessions/resume`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'not-a-uuid!!', cwd: '/tmp' }),
});
ok(resumeBadFormat.status === 400, `resume with a malformed sessionId is rejected, got ${resumeBadFormat.status}`);

const resumeUnknown = await fetch(`http://127.0.0.1:${port}/sessions/resume`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: '00000000-0000-4000-8000-000000000000', cwd: '/does/not/exist' }),
});
const resumeUnknownBody = await resumeUnknown.json();
ok(resumeUnknown.status === 403, `resume for a sessionId/cwd readClaudeSessions() doesn't know is rejected, got ${resumeUnknown.status}`);
ok(resumeUnknownBody.ok === false, 'resume for an unknown session: ok false');

// ── /sessions/cleanup (isolated $HOME only) ─────────────────────────────
ok(fs.existsSync(path.join(claudeDir, 'sessions', `${DEAD_PID}.json`)), 'cleanup fixture: orphaned session record exists before cleanup');
ok(fs.existsSync(oldFile), 'cleanup fixture: old transcript exists before cleanup');
const cleanupRes = await fetch(`http://127.0.0.1:${port}/sessions/cleanup`, { method: 'POST' });
const cleanupBody = await cleanupRes.json();
ok(cleanupRes.status === 200, `cleanup: 200, got ${cleanupRes.status}`);
ok(cleanupBody.ok === true, 'cleanup: ok true');
ok(cleanupBody.deletedSessions === 1, `cleanup: deleted the one orphaned session record, got ${cleanupBody.deletedSessions}`);
ok(cleanupBody.compressedLogs === 1, `cleanup: compressed the one 30+ day old transcript, got ${cleanupBody.compressedLogs}`);
ok(!fs.existsSync(path.join(claudeDir, 'sessions', `${DEAD_PID}.json`)), 'cleanup: orphaned session record removed');
ok(!fs.existsSync(oldFile) && fs.existsSync(`${oldFile}.gz`), 'cleanup: old transcript gzipped in place');

child.kill(); upstream.close(); fs.unlinkSync(tmp);
try { fs.unlinkSync(histFile); } catch { /* never created */ }
fs.rmSync(tmpHome, { recursive: true, force: true });
if (errs.length) { console.error('FAILED:\n- ' + errs.join('\n- ')); process.exit(1); }
console.log('smoke: ALL ASSERTIONS PASSED');
