// @ts-check
/**
 * Renders the new dashboard tab outside CloudCLI so it can actually be
 * looked at, following the same approach as cloudcli-system-monitor's
 * tests/preview.mjs: serve dist/ + a generated preview.html over a tiny
 * local static server (so the page's `import './dist/index.js'` resolves —
 * file:// blocks ES module imports), mount against a mock host api backed by
 * deterministic hand-built fixtures (limits/history/sessions — none of which
 * depend on live host state, unlike system-monitor's CPU/mem sampler, so no
 * real backend needs to be booted here), and screenshot both themes × both
 * languages.
 *
 *   node tests/preview.mjs            -> preview.html + screenshots
 *   node tests/preview.mjs --no-shot  -> skip playwright, just build the page
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(here, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fixtures ───────────────────────────────────────────────────────────
// Deterministic (no Math.random / no live host reads) so re-running this
// script produces the same screenshots and preview.html byte-for-byte.

const now = Date.now();
const DAY = 86_400_000;

const limits = {
  ok: true,
  source: 'live',
  status: 200,
  endpoint: 'https://api.anthropic.com/api/oauth/usage',
  data: {
    plan: 'Max (5x)',
    host: 'example-host',
    session: { label: 'Current session', usedPct: 42, resetsAtMs: now + 3 * 3600e3 + 12 * 60e3, kind: 'session' },
    daily: {
      label: "Today's budget", kind: 'daily', usedPct: 58, resetsAtMs: now + 9 * 3600e3,
      estimated: false, valueText: '8/14%', todayUsed: 8, todayBudget: 14, deltaPct: -6,
    },
    weekly: [
      { label: 'All models', usedPct: 65, resetsAtMs: now + 3 * 86400e3, kind: 'weekly' },
      { label: 'Opus', usedPct: 22, resetsAtMs: now + 3 * 86400e3, kind: 'weekly' },
      { label: 'Fable', usedPct: 91, resetsAtMs: now + 3 * 86400e3, kind: 'weekly' },
    ],
    fetchedAt: now,
  },
};

function zeroTok() {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}
function addTok(a, b) {
  a.input += b.input; a.output += b.output; a.cacheCreate += b.cacheCreate; a.cacheRead += b.cacheRead;
}
function tokTotal(tk) {
  return tk.input + tk.output + tk.cacheCreate + tk.cacheRead;
}

const daily = [];
for (let i = 29; i >= 0; i--) {
  const date = new Date(now - i * DAY).toISOString().slice(0, 10);
  // A gentle wave plus a ramp, so the chart has real shape without randomness.
  const base = 6000 + 4500 * Math.sin(i / 3.3) + (29 - i) * 220;
  const input = Math.max(0, Math.round(base));
  const output = Math.round(input * 0.35);
  const tokens = { input, output, cacheCreate: Math.round(input * 0.1), cacheRead: Math.round(input * 0.4) };
  const cost = (input * 3 + output * 15 + tokens.cacheCreate * 3.75 + tokens.cacheRead * 0.3) / 1e6;
  daily.push({ date, tokens, cost });
}
// A couple of quiet early days, to show the chart doesn't force a nonzero floor.
daily[0].tokens = zeroTok();
daily[0].cost = 0;

const byModelSrc = [
  ['claude-sonnet-4-5', 0.62],
  ['claude-opus-4-5', 0.28],
  ['claude-haiku-4-5', 0.10],
];
const byProjectSrc = [
  ['cloudcli-claude-limits', 0.4],
  ['agentmemory', 0.35],
  ['infra-scripts', 0.15],
  ['lovecraft-cron', 0.06],
  ['telegram-bot-connector', 0.04],
];
const totalsTokens = daily.reduce((acc, d) => { addTok(acc, d.tokens); return acc; }, zeroTok());
const totalsCost = daily.reduce((acc, d) => acc + d.cost, 0);

function splitBy(src, tokTotalAll, costTotal) {
  return src.map(([key, share]) => {
    const tokens = {
      input: Math.round(totalsTokens.input * share),
      output: Math.round(totalsTokens.output * share),
      cacheCreate: Math.round(totalsTokens.cacheCreate * share),
      cacheRead: Math.round(totalsTokens.cacheRead * share),
    };
    return { key, tokens, cost: costTotal * share };
  });
}

const history = {
  daily,
  byModel: splitBy(byModelSrc, totalsTokens, totalsCost).map(({ key, ...v }) => ({ model: key, ...v })),
  byProject: splitBy(byProjectSrc, totalsTokens, totalsCost).map(({ key, ...v }) => ({ project: key, ...v })),
  totals: { tokens: totalsTokens, cost: totalsCost, sessions: 37, messages: 812 },
};

const sessions = [
  {
    pid: 8421, user: 'root', name: 'cloudcli-claude-limits', cwd: '/srv/workspaces/demo-project-1',
    project: 'demo-project-1', sessionId: '00000000-0000-4000-8000-000000000001', version: '2.1.0',
    entrypoint: 'sdk-ts', model: 'claude-sonnet-4-5', resumed: false, detached: false,
    uptimeSec: 5400, idleSec: 8, status: 'working', cpuPct: 34.2, rss: 512 * 1024 * 1024, threads: 11,
  },
  {
    pid: 8390, user: 'root', name: 'agentmemory', cwd: '/srv/workspaces/demo-project-2',
    project: 'demo-project-2', sessionId: '00000000-0000-4000-8000-000000000002', version: '2.1.0',
    entrypoint: 'cli', model: 'claude-opus-4-5', resumed: true, detached: false,
    uptimeSec: 19800, idleSec: 340, status: 'waiting', cpuPct: 0.4, rss: 301 * 1024 * 1024, threads: 9,
  },
  {
    pid: 8123, user: 'deploy', name: 'infra-scripts', cwd: '/srv/workspaces/demo-project-3',
    project: 'demo-project-3', sessionId: '00000000-0000-4000-8000-000000000003', version: '2.0.4',
    entrypoint: 'cli', model: 'claude-sonnet-4-5', resumed: false, detached: false,
    uptimeSec: 42000, idleSec: 5400, status: 'quiet', cpuPct: 0.0, rss: 190 * 1024 * 1024, threads: 6,
  },
  {
    pid: null, user: 'root', name: 'demo-project-4', cwd: '/srv/workspaces/demo-project-4',
    project: 'demo-project-4', sessionId: '00000000-0000-4000-8000-000000000004', version: '2.1.0',
    entrypoint: null, model: null, resumed: false, detached: true,
    uptimeSec: null, idleSec: 610, status: 'waiting', cpuPct: null, rss: null, threads: null,
  },
];

const FIXTURES = { limits, history, sessions: { ok: true, sessions } };

// ── preview.html ───────────────────────────────────────────────────────

const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Claude — preview</title>
<style>
  html, body { margin: 0; height: 100%; }
  #app { height: 100vh; }
</style>
</head>
<body>
<div id="app"></div>
<script type="module">
  import { mount } from './dist/index.js';

  // Deterministic fixtures — this page is a design preview, so nothing here
  // is live (no real limits/history/sessions data is read or shown).
  const FIXTURES = ${JSON.stringify(FIXTURES)};
  const q = new URLSearchParams(location.search);
  const theme = q.get('theme') === 'dark' ? 'dark' : 'light';
  document.body.style.background = theme === 'dark' ? '#141417' : '#f6f6f4';

  // The tab reads the host panel's own language key. 'ru' sets it; anything
  // else clears it, exercising the same default-to-English path the host
  // takes when the setting was never touched.
  if (q.get('lang') === 'ru') localStorage.setItem('userLanguage', 'ru');
  else localStorage.removeItem('userLanguage');

  mount(document.getElementById('app'), {
    context: { theme, project: null, session: null },
    onContextChange: () => () => {},
    rpc: async (method, path) => {
      const p = String(path).replace(/^\\//, '').split('?')[0];
      if (p === 'limits') return FIXTURES.limits;
      if (p === 'history') return FIXTURES.history;
      if (p === 'sessions') return FIXTURES.sessions;
      // Action routes (kill/resume/cleanup): never actually exercised by this
      // preview — clicking Kill only arms the two-step confirm, it is not
      // followed through here.
      return { ok: true };
    },
  });
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(rootDir, 'preview.html'), html);
console.log('Wrote preview.html');

// ── serve + screenshot ─────────────────────────────────────────────────

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'preview.html';
  const file = path.join(rootDir, rel);
  if (!file.startsWith(rootDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const webPort = server.address().port;
console.log(`  preview served at http://127.0.0.1:${webPort}/preview.html`);

if (process.argv.includes('--no-shot')) {
  console.log('  (--no-shot: leaving the server up for 10 min)');
  await sleep(600_000);
  process.exit(0);
}

/** playwright is installed globally on this box; resolve it if not a local dep. */
async function loadPlaywright() {
  let mod;
  try {
    mod = await import('playwright');
  } catch {
    const { execSync } = await import('node:child_process');
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    mod = await import(path.join(globalRoot, 'playwright', 'index.js'));
  }
  return mod.chromium ? mod : mod.default;
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const COMBOS = [
  { theme: 'light', lang: 'en' },
  { theme: 'dark', lang: 'en' },
  { theme: 'light', lang: 'ru' },
  { theme: 'dark', lang: 'ru' },
];
let firstRunErrors = [];
for (const { theme, lang } of COMBOS) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1400 }, deviceScaleFactor: 2 });
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${webPort}/preview.html?theme=${theme}&lang=${lang}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600); // let the bar/meter transitions settle

  if (theme === 'light' && lang === 'en') {
    // Content assertions, once, in English: every section rendered something
    // meaningful rather than an empty/error state.
    // textContent, not innerText: stat-tile labels are CSS text-transform:
    // uppercase for display, which innerText reflects but the source text
    // (what we actually want to assert on) does not.
    const text = await page.evaluate(() => document.body.textContent);
    const must = [
      'Claude', 'Max (5x)', 'Current session', "Today's budget", 'All models',
      'Total tokens', 'Output tokens', 'Est. cost', 'Sessions',
      'Daily tokens (30 days)', 'By model', 'By project', 'Active sessions',
      'claude-sonnet-4-5', 'cloudcli-claude-limits', 'demo-project-1',
    ];
    const missing = must.filter((s) => !text.includes(s));
    if (missing.length) firstRunErrors = missing;

    // Exercise the two-step Kill confirm: first click arms it, a click
    // elsewhere disarms it — no kill is ever actually sent (rpc stub above
    // returns {ok:true} for any action route but this flow never reaches it).
    const armed = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Kill');
      if (!btn) return null;
      btn.click();
      return btn.textContent;
    });
    console.log(`  kill-confirm arm: ${armed === 'Confirm?' ? 'OK ("Confirm?")' : `UNEXPECTED (${armed})`}`);
    const disarmed = await page.evaluate(() => {
      document.body.click();
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Confirm?' || b.textContent === 'Kill');
      return btn ? btn.textContent : null;
    });
    console.log(`  kill-confirm disarm on outside click: ${disarmed === 'Kill' ? 'OK' : `UNEXPECTED (${disarmed})`}`);
  }

  const out = path.join(here, `preview-${theme}-${lang}.png`);
  await page.screenshot({ path: out, fullPage: true });
  console.log(`  ${theme}/${lang}: ${out}${errors.length ? `  ⚠ ${errors.length} console error(s)` : ''}`);
  for (const e of errors) console.log(`      ${e}`);
  await page.close();
}
await browser.close();
server.close();

if (firstRunErrors.length) {
  console.error('MISSING content:\n- ' + firstRunErrors.join('\n- '));
  process.exit(1);
}
console.log('preview: OK');
