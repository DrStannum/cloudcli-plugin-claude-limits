// Panel-tab render check: runs the real mount() against a minimal DOM shim with
// sample data, switches to the Panel tab (TUI is the default view), asserts key
// fragments, and (re)generates preview.html.
// Run: node tests/preview.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEl, installDom, fire } from './shim.mjs';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

installDom();

const mod = await import(path.join(PLUGIN, 'dist/index.js'));
const now = Date.now();
const sample = {
  ok: true, source: 'live', status: 200,
  endpoint: 'https://api.anthropic.com/api/oauth/usage',
  data: {
    plan: 'Max (5x)',
    host: 'example-host',
    session: { label: 'Current session', usedPct: 1, resetsAtMs: now + 17700 * 1000, kind: 'session' },
    weekly: [
      { label: 'All models', usedPct: 65, resetsAtMs: now + 3 * 86400e3, kind: 'weekly' },
      { label: 'Fable', usedPct: 12, resetsAtMs: now + 3 * 86400e3, kind: 'weekly' },
    ],
    fetchedAt: now,
  },
};

const container = makeEl();
const api = { context: { theme: 'light', project: null, session: null }, onContextChange: () => () => {}, rpc: async () => sample };
mod.mount(container, api);
await new Promise((r) => setTimeout(r, 20));
const col = container.children[0].children[0];

// TUI is the default tab, so the Panel view has to be selected first.
if (!col.innerHTML.includes('limits@')) {
  console.error('MISSING: TUI is supposed to be the default tab, but it did not render');
  process.exit(1);
}
fire(col, 'cl-tab-panel');
const html = col.innerHTML;
mod.unmount(container);

const must = [
  'Plan usage limits', 'Max (5x)', 'Current session', 'Resets in 4 hr 55 min', '1% used',
  'Weekly limits', 'All models', '65% used',
  'Fable', '12% used', 'Last updated: just now',
  'id="cl-tab-panel"', 'id="cl-tab-tui"',
  'Refresh every', 'value="180000" selected', '>3m</option>',
];
const missing = must.filter((s) => !html.includes(s));
if (missing.length) { console.error('MISSING:\n- ' + missing.join('\n- ')); process.exit(1); }

fs.writeFileSync(path.join(PLUGIN, 'preview.html'),
  `<!doctype html><meta charset="utf-8"><title>Claude Limits — preview</title>
<body style="margin:0;background:#f3f3f0"><div style="max-width:520px;margin:40px auto;background:#fff;border:1px solid #eee;border-radius:16px;overflow:hidden">${html}</div></body>`);
console.log('preview: Panel render OK, wrote preview.html');
