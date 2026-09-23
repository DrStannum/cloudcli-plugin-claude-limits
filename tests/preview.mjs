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

// Served from cache, 7 minutes old, standing in for a rate-limited upstream:
// the shape a dashboard spends most of its life in now that a live reading is
// reused for 10 minutes. It also puts the "Кеш от HH:MM" marker in the shots.
const limits = {
  ok: true,
  source: 'cache',
  status: 200,
  endpoint: 'https://api.anthropic.com/api/oauth/usage',
  data: {
    plan: 'Max (5x)',
    host: 'example-host',
    session: { label: 'Current session', usedPct: 42, resetsAtMs: now + 3 * 3600e3 + 12 * 60e3, kind: 'session' },
    daily: {
      label: "Today's budget", kind: 'daily', usedPct: 58, resetsAtMs: now + 9 * 3600e3,
      estimated: false, valueText: '28% \u2192 42%', todayUsed: 8, todayBudget: 14, deltaPct: -6,
      dayStartPct: 28.4, ceilingPct: 42.8,
    },
    weekly: [
      { label: 'All models', usedPct: 65, resetsAtMs: now + 3 * 86400e3, kind: 'weekly' },
      { label: 'Opus', usedPct: 22, resetsAtMs: now + 3 * 86400e3, kind: 'weekly' },
      { label: 'Fable', usedPct: 91, resetsAtMs: now + 3 * 86400e3, kind: 'weekly' },
    ],
    fetchedAt: now - 7 * 60e3,
  },
};

// Synthetic transcripts, fed through the *real* dist/history.js aggregation
// rather than hand-built totals — so the preview exercises the same code path
// the backend does, including the Usage view's period/session grouping and its
// project/model filters. Deterministic (a fixed-seed LCG, no Math.random), so
// re-running produces the same page byte-for-byte apart from the clock.

const PROJECTS = [
  ['cloudcli-claude-limits', 1.0],
  ['agentmemory', 0.85],
  ['infra-scripts', 0.4],
  ['lovecraft-cron', 0.15],
  ['telegram-bot-connector', 0.1],
];
const MODELS = [
  ['claude-sonnet-4-5', 0.6],
  ['claude-opus-4-5', 0.3],
  ['claude-haiku-4-5', 0.1],
];

/** Fixed-seed LCG — the preview must not move between runs. */
let seed = 20260826;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function pick(weighted) {
  const total = weighted.reduce((a, [, w]) => a + w, 0);
  let x = rnd() * total;
  for (const [v, w] of weighted) {
    x -= w;
    if (x <= 0) return v;
  }
  return weighted[weighted.length - 1][0];
}

const SPAN_DAYS = 75; // enough history for the "All time" / monthly views
const SESSIONS = [];
let msgSeq = 0;
for (let i = 0; i < 140; i++) {
  const project = pick(PROJECTS);
  const model = pick(MODELS);
  // Bias sessions towards recent days so the daily chart ramps rather than
  // sitting flat.
  const dayAgo = Math.floor(SPAN_DAYS * rnd() * rnd());
  const startMs = now - dayAgo * DAY + Math.floor(rnd() * 12 * 3600e3);
  const turns = 2 + Math.floor(rnd() * 28);
  const entries = [];
  for (let k = 0; k < turns; k++) {
    const input = 60 + Math.floor(rnd() * 900);
    entries.push({
      id: `msg_${String(msgSeq++).padStart(5, '0')}`,
      timestamp: new Date(startMs + k * (40_000 + Math.floor(rnd() * 200_000))).toISOString(),
      model,
      tokens: {
        input,
        output: Math.round(input * (0.4 + rnd())),
        cacheCreate: Math.round(input * (2 + rnd() * 12)),
        cacheRead: Math.round(input * (30 + rnd() * 260)),
      },
    });
  }
  SESSIONS.push({
    // Shaped like a real transcript file name (the backend passes the .jsonl
    // basename through as the session id).
    id: `0000${String(i).padStart(4, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`,
    project,
    entries,
  });
}

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

// The daily card has three shapes and only one of them can be in the main
// screenshots: the plain single bar above, plus the two the carry-forward rule
// produces. `?daily=carry|over` swaps those in so they can be looked at too.
const dailyVariants = {
  // Day 4 of the cycle (0-based 3, ceiling 4/7 = 57%) with only 20% spent so
  // far: 1.6 days' allowance carried in, so the bar gets two green divisions
  // (a whole day and a 60% one) next to today's own share, 40% of which is
  // gone.
  carry: {
    ...limits.data.daily, usedPct: 15.3, valueText: '20% \u2192 57%',
    todayUsed: 5.71, todayBudget: 37.14, deltaPct: -31.43, dayStartPct: 20, ceilingPct: 57.14,
  },
  // The widest the split can get: last day of a cycle nothing was spent in,
  // so six untouched days carry in beside today's own share. Worth a look
  // because it is where the legend runs out of room.
  carryMax: {
    ...limits.data.daily, usedPct: 0.6, valueText: '0% \u2192 100%',
    todayUsed: 0.6, todayBudget: 100, deltaPct: -99.4, dayStartPct: 0, ceilingPct: 100,
  },
  // Day 5 (ceiling 5/7 = 71%) after a heavy start: today's budget is 10.4% and
  // 15% is already gone, a third of tomorrow's share borrowed in advance.
  over: {
    ...limits.data.daily, usedPct: 100, valueText: '61% \u2192 71%',
    todayUsed: 15, todayBudget: 10.43, deltaPct: 4.57, dayStartPct: 61, ceilingPct: 71.43,
  },
};

const FIXTURES = { limits, dailyVariants, sessions: { ok: true, sessions }, transcripts: SESSIONS };

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
  // The same aggregation the backend runs — dist/history.js is dependency-free
  // ESM, so the preview can call it directly instead of faking its output.
  import { aggregate, historyOptions } from './dist/history.js';

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

  // ?daily=carry|over — the same reading, in the two states the carry-forward
  // rule can put today's budget in.
  const daily = FIXTURES.dailyVariants[q.get('daily')];
  if (daily) FIXTURES.limits.data.daily = daily;

  mount(document.getElementById('app'), {
    context: { theme, project: null, session: null },
    onContextChange: () => () => {},
    rpc: async (method, path) => {
      const [p, qs] = String(path).replace(/^\\//, '').split('?');
      // window.__failLimits lets the test simulate a rate-limited backend
      // without a second fixture: the tab must keep the reading it has.
      if (p === 'limits' && window.__failLimits) {
        return { ok: false, code: 'http_error', status: 429, source: 'live', error: 'Endpoint returned HTTP 429.' };
      }
      if (p === 'limits') return FIXTURES.limits;
      if (p === 'sessions') return FIXTURES.sessions;
      if (p === 'history' || p === 'usage') {
        // Exactly what dist/server.js does for these two routes.
        const opts = historyOptions(new URLSearchParams(qs || ''), p === 'history' ? 30 : null);
        return aggregate(FIXTURES.transcripts, opts, Date.now());
      }
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
/** The daily card's carry-forward states, each in one theme/language pair. */
const DAILY_SHOTS = [
  { variant: 'carry', theme: 'light', lang: 'ru' },
  { variant: 'carry', theme: 'dark', lang: 'en' },
  { variant: 'carryMax', theme: 'light', lang: 'ru' },
  { variant: 'over', theme: 'light', lang: 'en' },
  { variant: 'over', theme: 'dark', lang: 'ru' },
];

/** Combos that also get a Usage-tab screenshot. */
const USAGE_SHOTS = [
  { theme: 'light', lang: 'en' },
  { theme: 'dark', lang: 'ru' },
];
let firstRunErrors = [];
for (const { theme, lang } of COMBOS) {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1400 },
    deviceScaleFactor: 2,
    // The Usage view's session-id button writes to the clipboard; without the
    // grant Chromium denies it and we'd be asserting the fallback path only.
    permissions: ['clipboard-read', 'clipboard-write'],
  });
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
    // Totals, By model and By project live on the Usage sub-tab now, and are
    // asserted there instead.
    const must = [
      'Claude', 'Max (5x)', 'Current session', "Today's budget", 'All models',
      'Daily tokens (30 days)', 'Active sessions',
      'claude-sonnet-4-5', 'cloudcli-claude-limits', 'demo-project-1',
    ];
    const missing = must.filter((s) => !text.includes(s));
    if (missing.length) firstRunErrors.push(...missing);

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

    // A cached reading names the clock time it was taken at, and carries the
    // papered-over upstream error in its tooltip.
    const cacheMark = await page.evaluate(() => {
      const el = document.querySelector('.cld-stamp-cache');
      return el ? { text: el.textContent, title: el.title } : null;
    });
    const cacheOk = cacheMark && /^Cached at \d{1,2}:\d{2}/.test(cacheMark.text);
    console.log(`  cache stamp: ${cacheOk ? `OK ("${cacheMark.text}")` : `UNEXPECTED (${JSON.stringify(cacheMark)})`}`);
    if (!cacheOk) firstRunErrors.push('cache stamp');

    // A failed refresh keeps every card and says so. The reported bug was the
    // opposite: pressing Refresh during a 429 replaced the whole dashboard
    // with an error box.
    const failed = await page.evaluate(async () => {
      window.__failLimits = true;
      document.querySelector('.cld-icon-btn').click();
      await new Promise((r) => setTimeout(r, 300));
      const badge = document.querySelector('.cld-stale');
      const grid = document.querySelector('.cld-limits-grid');
      const err = document.querySelector('.cld-err');
      return {
        badge: badge && badge.style.display !== 'none' ? badge.textContent : null,
        badgeTitle: badge ? badge.title : '',
        cards: grid ? grid.children.length : 0,
        gridHidden: grid ? grid.style.display === 'none' : true,
        errShown: err ? err.style.display !== 'none' : false,
        keptNumbers: document.body.textContent.includes('28% → 42%'),
      };
    });
    const failOk =
      failed.badge === '⚠ Refresh failed' && failed.cards === 5 && !failed.gridHidden &&
      !failed.errShown && failed.keptNumbers && failed.badgeTitle.includes('429');
    console.log(`  failed refresh keeps the cards: ${failOk ? `OK ("${failed.badge}", ${failed.cards} cards)` : `UNEXPECTED (${JSON.stringify(failed)})`}`);
    if (!failOk) firstRunErrors.push('failed refresh');

    // …and a recovering backend clears the warning.
    const recovered = await page.evaluate(async () => {
      window.__failLimits = false;
      document.querySelector('.cld-icon-btn').click();
      await new Promise((r) => setTimeout(r, 300));
      const badge = document.querySelector('.cld-stale');
      return badge ? badge.style.display === 'none' : false;
    });
    console.log(`  warning clears once it succeeds: ${recovered ? 'OK' : 'UNEXPECTED'}`);
    if (!recovered) firstRunErrors.push('stale badge stuck');
  }

  const out = path.join(here, `preview-${theme}-${lang}.png`);
  await page.screenshot({ path: out, fullPage: true });
  console.log(`  ${theme}/${lang}: ${out}${errors.length ? `  ⚠ ${errors.length} console error(s)` : ''}`);

  // ── the Usage sub-tab, in the two combos that cover both themes and both
  //    languages between them (a 2x2 here would only add near-duplicate PNGs).
  if (USAGE_SHOTS.some((c) => c.theme === theme && c.lang === lang)) {
    const tabLabel = lang === 'ru' ? 'Расход' : 'Usage';
    await page.evaluate((label) => {
      const btn = [...document.querySelectorAll('.cld-tab')].find((b) => b.textContent === label);
      if (btn) btn.click();
    }, tabLabel);
    await page.waitForTimeout(400);

    if (lang === 'en') {
      // ── the session-id control in the "Top sessions" card: the button
      //    carries the full id and copies it, the link points at the host
      //    panel's own /session/:id route.
      const idCtl = await page.evaluate(() => {
        const card = document.querySelector('.cld-usage-view .cld-mp-grid > div:nth-child(3)');
        const btn = card && card.querySelector('.cld-sid-btn');
        const link = card && card.querySelector('a.cld-open');
        if (!btn || !link) return null;
        return { short: btn.textContent, title: btn.title.split('\n')[0], href: link.getAttribute('href') };
      });
      if (!idCtl) {
        firstRunErrors.push('top-sessions card has no session-id button/link');
      } else {
        const hrefOk = idCtl.href === `/session/${idCtl.title}`;
        const shortOk = idCtl.title.startsWith(idCtl.short) && idCtl.title.length > idCtl.short.length;
        console.log(
          `  usage session-id link -> ${idCtl.href}: ${hrefOk && shortOk ? 'OK' : 'UNEXPECTED'}`,
        );
        if (!hrefOk) firstRunErrors.push(`session link href is ${idCtl.href}, want /session/${idCtl.title}`);
        if (!shortOk) firstRunErrors.push('the button shows a shortened id but must carry the full one');

        const copied = await page.evaluate(async () => {
          const btn = document.querySelector('.cld-usage-view .cld-mp-grid > div:nth-child(3) .cld-sid-btn');
          btn.click();
          await new Promise((r) => setTimeout(r, 250));
          return { marked: btn.classList.contains('cld-copied'), clip: await navigator.clipboard.readText() };
        });
        const copyOk = copied.marked && copied.clip === idCtl.title;
        console.log(`  usage session-id copy: ${copyOk ? 'OK' : `UNEXPECTED (${JSON.stringify(copied)})`}`);
        if (!copyOk) firstRunErrors.push('clicking the session id did not copy the full id');
      }

      // groupBy=session exercises the widest column set and the session
      // aggregation; leave it selected for the screenshot.
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.cld-seg button')].find((b) => b.textContent === 'Week');
        if (btn) btn.click();
      });
      await page.waitForTimeout(300);
      const weekOk = await page.evaluate(() =>
        [...document.querySelectorAll('.cld-usage tbody tr td:first-child')].some((td) => /\d{4}-W\d{2}/.test(td.textContent)),
      );
      console.log(`  usage groupBy=week rows: ${weekOk ? 'OK' : 'UNEXPECTED (no ISO week keys)'}`);
      if (!weekOk) firstRunErrors.push('groupBy=week produced no ISO-week rows');

      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.cld-seg button')].find((b) => b.textContent === 'Session');
        if (btn) btn.click();
      });
      await page.waitForTimeout(300);
      const usageText = await page.evaluate(() => document.querySelector('.cld-usage-view').textContent);
      const missing = [
        'Period', 'Group by', 'All projects', 'All models', 'Cache create', 'Duration', 'Breakdown',
        // Moved here from the dashboard in 2.1.
        'Total tokens', 'Output tokens', 'Est. cost', 'Sessions', 'Messages', 'By model', 'By project', 'Top sessions',
      ].filter((x) => !usageText.includes(x));
      if (missing.length) firstRunErrors.push(...missing.map((m) => `usage: ${m}`));

      // The totals tiles and the two ranked cards moved here from the
      // dashboard in 2.1, and the whole point of the move is that they answer
      // to the Usage filters. Selecting one project must shrink all three.
      const readWidgets = () =>
        page.evaluate(() => ({
          total: document.querySelector('.cld-usage-view .cld-stat-val').textContent,
          models: document.querySelectorAll('.cld-usage-view .cld-mp-grid > div:nth-child(1) .cld-mp-row').length,
          projects: document.querySelectorAll('.cld-usage-view .cld-mp-grid > div:nth-child(2) .cld-mp-row').length,
          sessions: document.querySelectorAll('.cld-usage-view .cld-mp-grid > div:nth-child(3) .cld-mp-row').length,
        }));
      const before = await readWidgets();
      await page.evaluate(() => {
        const sel = document.querySelectorAll('.cld-usage-view select')[0];
        sel.value = [...sel.options].map((o) => o.value).filter(Boolean)[0];
        sel.dispatchEvent(new Event('change'));
      });
      await page.waitForTimeout(400);
      const after = await readWidgets();
      const filtered =
        after.projects === 1 &&
        before.projects > 1 &&
        after.total !== before.total &&
        after.sessions > 0 &&
        after.sessions <= before.sessions;
      console.log(
        `  usage project filter drives the moved widgets: ${filtered ? 'OK' : 'UNEXPECTED'}` +
          ` (total ${before.total}->${after.total}, by-project rows ${before.projects}->${after.projects},` +
          ` top-session rows ${before.sessions}->${after.sessions})`,
      );
      if (!filtered) firstRunErrors.push('project filter did not narrow the totals / by-project card');
      // Clear it again so the screenshot below shows the unfiltered view.
      await page.evaluate(() => {
        const sel = document.querySelectorAll('.cld-usage-view select')[0];
        sel.value = '';
        sel.dispatchEvent(new Event('change'));
      });
      await page.waitForTimeout(400);

      // Sorting: clicking Cost twice must flip the order of the first row.
      const sortFlips = await page.evaluate(() => {
        const th = [...document.querySelectorAll('.cld-usage thead th')].find((x) => x.textContent.startsWith('Cost'));
        const first = () => document.querySelector('.cld-usage tbody tr td:first-child')?.textContent;
        // (In session mode this cell holds the id button — its text is still
        //  the shortened id, so it remains a usable order fingerprint.)
        const a = first();
        th.click();
        const b = first();
        return a !== b;
      });
      console.log(`  usage cost sort toggles: ${sortFlips ? 'OK' : 'UNEXPECTED (order unchanged)'}`);
    }

    const usageOut = path.join(here, `preview-usage-${theme}-${lang}.png`);
    await page.screenshot({ path: usageOut, fullPage: true });
    console.log(`  ${theme}/${lang} usage: ${usageOut}`);
  }

  for (const e of errors) console.log(`      ${e}`);
  await page.close();
}

// ── the daily card's two carry-forward states ──────────────────────────
// Just the limits row, not the whole page: these shots exist to show the
// divided bar, and the rest of the dashboard is already covered above.
for (const { variant, theme, lang } of DAILY_SHOTS) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${webPort}/preview.html?theme=${theme}&lang=${lang}&daily=${variant}`, { waitUntil: 'networkidle' });
  // Every card owns a (hidden) split container; wait for one with bars in it.
  await page.waitForSelector('.cld-limits-grid .cld-split > .cld-track');
  await page.waitForTimeout(700); // let the bar widths finish animating
  // Each division draws the standing allowance first, the spend over it.
  const bars = await page.$$eval('.cld-limits-grid .cld-split:not([style*="none"]) > .cld-track', (els) =>
    els.map((el) => `${el.children[1].style.width} of ${el.children[0].style.width}`),
  );
  const out = path.join(here, `preview-daily-${variant}-${theme}-${lang}.png`);
  await page.locator('.cld-limits-grid').screenshot({ path: out });
  console.log(`  daily/${variant} ${theme}/${lang}: [${bars.join(', ')}] -> ${out}`);
  if (variant === 'carry' && bars.length !== 3) firstRunErrors.push(`daily=carry drew ${bars.length} divisions, expected 3`);
  if (variant === 'carryMax' && bars.length !== 7) firstRunErrors.push(`daily=carryMax drew ${bars.length} divisions, expected 7`);
  if (variant === 'over' && bars.length !== 2) firstRunErrors.push(`daily=over drew ${bars.length} divisions, expected 2`);
  await page.close();
}

await browser.close();
server.close();

if (firstRunErrors.length) {
  console.error('MISSING content:\n- ' + firstRunErrors.join('\n- '));
  process.exit(1);
}
console.log('preview: OK');
