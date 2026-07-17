// Frontend TUI-tab render check: mounts with the real mount() and asserts the
// TUI is the default view, the ASCII countdown/bar markup, the refresh-interval
// field, and that the TUI palette follows the host light/dark theme.
// Run: node tests/tui.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEl, installDom, fire } from './shim.mjs';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const { store: stored } = installDom({ localStorage: true });

const mod = await import(path.join(PLUGIN, 'dist/index.js'));
const now = Date.now();
const sample = {
  ok: true, source: 'live', status: 200,
  endpoint: 'https://api.anthropic.com/api/oauth/usage',
  data: {
    plan: 'Max (5x)',
    host: 'example-host',
    session: { label: 'Current session', usedPct: 78, resetsAtMs: now + (4 * 3600 + 55 * 60) * 1000, kind: 'session' },
    daily: { label: "Today's budget", kind: 'daily', usedPct: 40, resetsAtMs: now + 8 * 3600 * 1000, valueText: '6/8%', todayUsed: 6, todayBudget: 8, deltaPct: -2 },
    weekly: [
      { label: 'All models', usedPct: 65, resetsAtMs: now + 3 * 86400e3, kind: 'weekly' },
      { label: 'Fable', usedPct: 12, resetsAtMs: now + 3 * 86400e3, kind: 'weekly' },
    ],
    fetchedAt: now,
  },
};

let failed = false;
function must(label, cond) {
  if (!cond) { console.error(`FAIL ${label}`); failed = true; }
}

/** Mounts and returns { html, col, root } — TUI is the default tab. */
async function mountTui(theme, payload = sample) {
  const container = makeEl();
  const api = { context: { theme, project: null, session: null }, onContextChange: () => () => {}, rpc: async () => payload };
  mod.mount(container, api);
  await new Promise((r) => setTimeout(r, 20));
  const root = container.children[0];
  const col = root.children[0];
  return { html: col.innerHTML, col, root, container };
}

// ── dark theme ────────────────────────────────────────────────────────
const dark = await mountTui('dark');

must('TUI renders on mount without clicking a tab (it is the default)', dark.html.includes('limits@'));
must('TUI tab is marked active in the tab bar', /id="cl-tab-tui"[^>]*border-bottom:2px solid/.test(dark.html));

for (const s of [
  'limits@example-host', '5-HOUR SESSION', "TODAY'S BUDGET", 'WEEKLY / ALL MODELS',
  'REMAINING', 'RESETS ', 'Max (5x)', 'Fable',
  'id="cl-interval"', 'REFRESH EVERY',
]) must(`TUI contains "${s}"`, dark.html.includes(s));

must('header shows the backend hostname, not a hardcoded name', !dark.html.includes('sncode'));

must('TUI has block-character bars', dark.html.includes('█') && dark.html.includes('░'));
must('TUI has the big H:MM:SS session countdown', /4:5[45]:\d\d/.test(dark.html));
// The big countdown already carries seconds; the separate readout was removed.
must('no separate seconds-to-reset row', !dark.html.includes('SEC TO RESET'));
must('bars are full-width (width:100%)', dark.html.includes('width:100%;white-space:nowrap'));
must('dark TUI uses the dark terminal bg', dark.root.style.background === '#0e0f13');
must('3m is the default selected interval', dark.html.includes('value="180000" selected'));
must('3m is offered in the interval list', dark.html.includes('>3M</option>'));

// Bar char counts should match the fallback col count while unmeasurable.
const barCells = dark.html.match(/█+/g) || [];
must('session bar is drawn with many cells (full width)', barCells.some((b) => b.length > 20));

// ── light theme ───────────────────────────────────────────────────────
const light = await mountTui('light');
must('light TUI uses the light terminal bg', light.root.style.background === '#fbfbf9');
must('light TUI still renders the timers', light.html.includes('5-HOUR SESSION') && /4:5[45]:\d\d/.test(light.html));
must('light TUI bg differs from dark TUI bg', light.root.style.background !== dark.root.style.background);

// ── switching to Panel and back still works ───────────────────────────
const both = await mountTui('dark');
fire(both.col, 'cl-tab-panel');
must('Panel tab renders the claude.ai-style panel', both.col.innerHTML.includes('Plan usage limits'));
must('Panel tab replaces the TUI view', !both.col.innerHTML.includes('limits@misha'));
fire(both.col, 'cl-tab-tui');
must('switching back to TUI works', both.col.innerHTML.includes('limits@example-host'));
mod.unmount(both.container);

// ── host header falls back when the backend reports no hostname ───────
const noHost = await mountTui('dark', { ...sample, data: { ...sample.data, host: null } });
must('falls back to a host label when backend sends none', /limits@[\w.-]+ ~/.test(noHost.html));
must('fallback host is not the literal "null"', !noHost.html.includes('limits@null'));
mod.unmount(noHost.container);

// ── interval field persists the choice ────────────────────────────────
const sel = light.col.querySelector('#cl-interval');
sel.value = '10000';
sel._listeners.change[sel._listeners.change.length - 1]();
must('interval choice written to localStorage', stored['cloudcli-claude-limits:refreshMs'] === '10000');
must('interval field reflects the new choice', light.col.innerHTML.includes('value="10000" selected'));

mod.unmount(dark.container);
mod.unmount(light.container);

if (failed) process.exit(1);
console.log('tui: render OK (dark + light, full-width bars, interval field)');
