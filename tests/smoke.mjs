// Backend integration test: spawns dist/server.js against a mock upstream and a
// fake credentials file, then asserts the normalized output. No network / no
// real credentials required.  Run: node tests/smoke.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), 'cl-fake-creds.json');
fs.writeFileSync(tmp, JSON.stringify({
  claudeAiOauth: { accessToken: 'test-token', subscriptionType: 'max_5x', scopes: ['user:profile'] },
}));

const nowSec = Math.floor(Date.now() / 1000);
const satIso = new Date(Date.now() + 3 * 86400e3).toISOString();
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
    PATH: process.env.PATH, HOME: os.homedir(), NODE_ENV: 'production',
    PLUGIN_NAME: 'cloudcli-claude-limits',
    CLAUDE_LIMITS_CREDS: tmp,
    CLAUDE_LIMITS_ENDPOINT: `http://127.0.0.1:${upPort}/usage`,
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

const r = await (await fetch(`http://127.0.0.1:${port}/limits`)).json();
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
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
ok(
  r.data?.host === os.hostname(),
  `host is this server's hostname "${os.hostname()}", got ${r.data?.host}`,
);
const r2 = await (await fetch(`http://127.0.0.1:${port}/limits`)).json();
ok(r2.source === 'cache', `2nd call cached, got ${r2.source}`);
const r3 = await (await fetch(`http://127.0.0.1:${port}/limits?force=1`)).json();
ok(r3.source === 'live', `force call live, got ${r3.source}`);

child.kill(); upstream.close(); fs.unlinkSync(tmp);
if (errs.length) { console.error('FAILED:\n- ' + errs.join('\n- ')); process.exit(1); }
console.log('smoke: ALL ASSERTIONS PASSED');
