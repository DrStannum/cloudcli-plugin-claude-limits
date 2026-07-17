// @ts-check
/**
 * Claude Limits — frontend tab.
 *
 * Renders the plan usage limits (current session + weekly buckets) laid out
 * like the official claude.ai "Plan usage limits" panel. Data comes from the
 * backend over api.rpc('GET', 'limits').
 *
 * Two views: the default "Panel" (claude.ai-style bars) and "TUI" (ASCII
 * terminal-style countdown timers with block progress bars). Both follow the
 * host app's light/dark theme.
 *
 * @typedef {import('../src/types').PluginAPI} PluginAPI
 * @typedef {import('../src/types').PluginContext} PluginContext
 * @typedef {import('../src/types').LimitsResponse} LimitsResponse
 * @typedef {import('../src/types').Limits} Limits
 * @typedef {import('../src/types').Meter} Meter
 */

const FONT =
  "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const TUI_FONT =
  "ui-monospace, SFMono-Regular, 'JetBrains Mono', 'Fira Code', Menlo, Consolas, 'Liberation Mono', monospace";

/** Font size the TUI bars are drawn at; the char-width probe must match it. */
const BAR_FONT_SIZE = '0.8rem';

/** Auto-refresh interval used until the user picks another one. */
const DEFAULT_REFRESH_MS = 180_000;

/** Selectable auto-refresh intervals. */
const REFRESH_OPTIONS = [
  { ms: 10_000, label: '10s' },
  { ms: 30_000, label: '30s' },
  { ms: 60_000, label: '1m' },
  { ms: 180_000, label: '3m' },
  { ms: 300_000, label: '5m' },
  { ms: 0, label: 'Off' },
];

const LS_KEY = 'cloudcli-claude-limits:refreshMs';

/** Bar width (in characters) used before/without a live measurement. */
const FALLBACK_BAR_COLS = 48;
const FALLBACK_COMPACT_COLS = 28;

// ── Theme ──────────────────────────────────────────────────────────────

/** @param {boolean} dark */
function colors(dark) {
  return dark
    ? {
        bg: '#1b1b1f',
        heading: '#f3f3f5',
        text: '#e6e6ea',
        muted: '#9a9aa6',
        link: '#88aaf5',
        trackBlue: '#2c3550',
        fillBlue: '#5b8def',
        trackGray: '#2b2b33',
        border: '#2b2b33',
        btnHover: '#26262e',
        inputBg: '#26262e',
      }
    : {
        bg: '#ffffff',
        heading: '#141413',
        text: '#26251f',
        muted: '#6b6b74',
        link: '#2f6fdd',
        trackBlue: '#dbe7fb',
        fillBlue: '#3f6fd8',
        trackGray: '#ececec',
        border: '#eeeeee',
        btnHover: '#f4f4f2',
        inputBg: '#ffffff',
      };
}

/** Terminal palette for the TUI tab — follows the host theme. @param {boolean} dark */
function tuiColors(dark) {
  return dark
    ? {
        bg: '#0e0f13',
        headerBg: '#14161c',
        panelBg: '#111319',
        border: '#2a2f38',
        text: '#e7e7ea',
        dim: '#7d838d',
        accent: '#e7e7ea',
        // The ░ glyph is only ~25% ink, so the track needs a lifted colour to
        // stay visible as a bar rather than fading into the card.
        trackChar: '#4d5665',
        warn: '#ffb454',
        inputBg: '#14161c',
      }
    : {
        bg: '#fbfbf9',
        headerBg: '#f1f1ed',
        panelBg: '#ffffff',
        border: '#d5d5cf',
        text: '#1a1a18',
        dim: '#71716b',
        accent: '#1a1a18',
        trackChar: '#a8a8a0',
        warn: '#b4530a',
        inputBg: '#ffffff',
      };
}

// ── Formatting ─────────────────────────────────────────────────────────

/** "Resets in 4 hr 55 min" @param {number|null} ms */
function fmtResetsIn(ms) {
  if (ms == null) return '';
  const diff = ms - Date.now();
  if (diff <= 0) return 'Resets now';
  const totalMin = Math.round(diff / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `Resets in ${h} hr ${m} min`;
  return `Resets in ${m} min`;
}

/** "Resets Sat 12:59 PM" @param {number|null} ms */
function fmtResetsAt(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  let day = '';
  let time = '';
  try {
    day = d.toLocaleDateString([], { weekday: 'short' });
    time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    day = d.toDateString();
    time = d.toTimeString().slice(0, 5);
  }
  return `Resets ${day} ${time}`;
}

/** "just now" / "3 min ago" @param {number} ms */
function fmtUpdated(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} hr ago`;
}

/** @param {number|null} pct */
function pctText(pct) {
  if (pct == null) return '—';
  return `${Math.round(pct)}% used`;
}

/** @param {string} s */
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}

/** @param {number} n */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 24h "HH:MM:SS" clock @param {number} ms */
function fmtClock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Big digit countdown, e.g. "4:55:00" or "3d 0:00:00" @param {number|null} diffMs */
function fmtCountdown(diffMs) {
  if (diffMs == null) return '--:--:--';
  if (diffMs <= 0) return '0:00:00';
  let totalSec = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSec / 86400);
  totalSec -= days * 86400;
  const h = Math.floor(totalSec / 3600);
  totalSec -= h * 3600;
  const m = Math.floor(totalSec / 60);
  totalSec -= m * 60;
  const s = totalSec;
  const hPart = days > 0 ? `${days}d ${h}` : `${h}`;
  return `${hPart}:${pad2(m)}:${pad2(s)}`;
}

// ── Rendering (Panel view) ────────────────────────────────────────────

/**
 * One meter block (title, subtitle, bar + percent).
 * @param {Meter} m @param {ReturnType<typeof colors>} c @param {number} [mt] top margin px
 */
function meterHTML(m, c, mt) {
  const pct = m.usedPct == null ? 0 : Math.max(0, Math.min(100, m.usedPct));
  const used = m.usedPct != null && m.usedPct > 0;
  const track = used ? c.trackBlue : c.trackGray;
  const fill = c.fillBlue;

  let subtitle;
  if (m.kind === 'session' || m.kind === 'daily') {
    subtitle = fmtResetsIn(m.resetsAtMs);
  } else if (m.usedPct === 0) {
    subtitle = `You haven't used ${esc(m.label)} yet`;
  } else {
    subtitle = fmtResetsAt(m.resetsAtMs);
  }

  const rightText = `${m.valueText ? esc(m.valueText) : pctText(m.usedPct)}${m.estimated ? ' ~' : ''}`;

  return `
    <div style="margin-top:${mt == null ? 26 : mt}px">
      <div style="font-size:1.15rem;font-weight:600;color:${c.heading};letter-spacing:-0.01em">${esc(m.label)}</div>
      <div style="font-size:0.9rem;color:${c.muted};margin-top:5px">${subtitle}</div>
      <div style="display:flex;align-items:center;gap:18px;margin-top:12px">
        <div style="flex:1;height:10px;border-radius:999px;background:${track};overflow:hidden">
          <div style="height:100%;width:${pct}%;min-width:${used ? '10px' : '0'};background:${fill};border-radius:999px;transition:width .5s cubic-bezier(.16,1,.3,1)"></div>
        </div>
        <div style="font-size:0.98rem;color:${c.muted};white-space:nowrap;flex-shrink:0">${rightText}</div>
      </div>
    </div>`;
}

/**
 * @param {Limits} data @param {ReturnType<typeof colors>} c
 */
function panelHTML(data, c) {
  const planBadge = data.plan
    ? `<span style="font-size:1.05rem;font-weight:500;color:${c.muted};margin-left:10px">${esc(data.plan)}</span>`
    : '';

  const sessionBlock = data.session
    ? meterHTML(data.session, c, 34)
    : `<div style="margin-top:34px">
         <div style="font-size:1.15rem;font-weight:600;color:${c.heading}">Current session</div>
         <div style="font-size:0.9rem;color:${c.muted};margin-top:5px">No session data.</div>
       </div>`;

  const dailyBlock = data.daily ? meterHTML(data.daily, c) : '';

  // Show only the aggregate weekly ("All models") plus any per-model/other
  // bucket that has actually been used — hide zero Opus/Sonnet/Fable/Cowork/…
  const visibleWeekly = data.weekly.filter(
    (m) => m.label === 'All models' || (m.usedPct != null && m.usedPct > 0),
  );
  const weeklyBlocks = visibleWeekly.length
    ? visibleWeekly.map((m) => meterHTML(m, c)).join('')
    : `<div style="font-size:0.9rem;color:${c.muted};margin-top:20px">No weekly data returned.</div>`;

  return `
    <div style="font-size:1.5rem;font-weight:700;color:${c.heading};letter-spacing:-0.02em">
      Plan usage limits${planBadge}
    </div>

    ${sessionBlock}
    ${dailyBlock}

    <div style="margin-top:44px">
      <div style="font-size:1.35rem;font-weight:700;color:${c.heading};letter-spacing:-0.02em">Weekly limits</div>
    </div>
    ${weeklyBlocks}
  `;
}

/**
 * @param {LimitsResponse} r @param {ReturnType<typeof colors>} c
 */
function errorHTML(r, c) {
  const icon = r.code === 'no_credentials' ? '🔒' : '⚠️';
  const title =
    r.code === 'no_credentials'
      ? 'No Claude subscription token found'
      : r.code === 'unauthorized'
        ? 'Not authorized'
        : 'Could not load usage limits';
  return `
    <div style="font-size:1.5rem;font-weight:700;color:${c.heading};letter-spacing:-0.02em">Plan usage limits</div>
    <div style="margin-top:28px;padding:20px;border:1px solid ${c.border};border-radius:12px;background:${c.bg}">
      <div style="font-size:1.05rem;font-weight:600;color:${c.heading}">${icon} ${esc(title)}</div>
      <div style="font-size:0.92rem;color:${c.muted};margin-top:8px;line-height:1.5">${esc(r.error || 'Unknown error.')}</div>
      ${r.status ? `<div style="font-size:0.8rem;color:${c.muted};margin-top:8px">HTTP ${r.status} · ${esc(r.endpoint || '')}</div>` : ''}
    </div>`;
}

/** @param {ReturnType<typeof colors>} c */
function skeletonHTML(c) {
  const sk = (extra) =>
    `<div style="background:${c.trackGray};border-radius:6px;animation:cl-pulse 1.4s ease infinite;${extra}"></div>`;
  const block = `<div style="margin-top:26px">
      ${sk('height:16px;width:38%')}
      ${sk('height:11px;width:26%;margin-top:8px')}
      ${sk('height:10px;border-radius:999px;margin-top:12px')}
    </div>`;
  return `<style>@keyframes cl-pulse{0%,100%{opacity:.55}50%{opacity:.9}}</style>
    ${sk('height:26px;width:60%')}
    ${block}${block}${block}`;
}

/**
 * @param {LimitsResponse} r @param {ReturnType<typeof colors>} c
 */
function debugHTML(r, c) {
  if (!r.raw) return '';
  let pretty;
  try {
    pretty = JSON.stringify(r.raw, null, 2);
  } catch {
    pretty = String(r.raw);
  }
  return `
    <details style="margin-top:32px">
      <summary style="cursor:pointer;font-size:0.82rem;color:${c.muted};user-select:none">Raw API response (debug)</summary>
      <pre style="margin-top:10px;padding:12px;background:${c.trackGray};border-radius:8px;overflow:auto;max-height:260px;font-size:0.72rem;color:${c.text};font-family:ui-monospace,monospace">${esc(pretty)}</pre>
    </details>`;
}

// ── Rendering (TUI view) ──────────────────────────────────────────────

/**
 * Block-character bar filling `cols` characters.
 * @param {number} pct @param {number} cols @param {ReturnType<typeof tuiColors>} c @param {string} [id]
 */
function barHTML(pct, cols, c, id) {
  const filled = Math.round((pct / 100) * cols);
  return `<span${id ? ` id="${id}"` : ''} style="display:block;width:100%;white-space:nowrap;overflow:hidden;font-size:${BAR_FONT_SIZE};line-height:1.2"><span style="color:${c.accent}">${'█'.repeat(filled)}</span><span style="color:${c.trackChar}">${'░'.repeat(Math.max(0, cols - filled))}</span></span>`;
}

/**
 * One big ASCII-timer card: title, USED badge, big H:MM:SS countdown,
 * full-width block progress bar, reset time.
 * @param {string} title @param {Meter} meter @param {number} now
 * @param {ReturnType<typeof tuiColors>} c @param {number} cols
 * @param {{barId?: string}} [opts]
 */
function tuiBlock(title, meter, now, c, cols, opts) {
  opts = opts || {};
  const pct = meter.usedPct == null ? 0 : Math.max(0, Math.min(100, meter.usedPct));
  const pctStr = meter.usedPct == null ? '--' : `${Math.round(meter.usedPct)}`;
  const diffMs = meter.resetsAtMs != null ? meter.resetsAtMs - now : null;
  const countdown = fmtCountdown(diffMs);
  const resetClockStr = meter.resetsAtMs != null ? fmtClock(meter.resetsAtMs) : '--:--:--';
  const valueText = meter.valueText ? esc(meter.valueText) : `${pctStr}%`;

  return `
    <div style="border:1px solid ${c.border};border-radius:6px;padding:16px 20px;margin-top:16px;background:${c.panelBg}">
      <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:0.72rem;letter-spacing:0.1em;color:${c.dim}">
        <span>[ ${esc(title)} ]</span>
        <span style="color:${c.text}">${valueText} USED${meter.estimated ? ' ~' : ''}</span>
      </div>
      <div style="text-align:center;margin-top:20px;font-size:2.5rem;font-weight:700;letter-spacing:0.03em;color:${c.text};font-variant-numeric:tabular-nums">${countdown}</div>
      <div style="text-align:center;margin-top:2px;font-size:0.65rem;letter-spacing:0.3em;color:${c.dim}">REMAINING</div>
      <div style="margin-top:18px">${barHTML(pct, cols, c, opts.barId)}</div>
      <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:0.72rem;color:${c.dim}">
        <span>RESETS ${resetClockStr}</span>
        <span>${pctStr}% USED</span>
      </div>
    </div>`;
}

/**
 * Compact row for extra used weekly buckets (Opus/Fable/…): label, then a bar
 * filling the rest of the row.
 * @param {Meter} meter @param {ReturnType<typeof tuiColors>} c @param {number} cols @param {string} [barId]
 */
function tuiCompactRow(meter, c, cols, barId) {
  const pct = meter.usedPct == null ? 0 : Math.max(0, Math.min(100, meter.usedPct));
  return `
    <div style="display:flex;align-items:center;gap:10px;margin-top:8px;font-size:0.76rem">
      <span style="width:96px;color:${c.text};flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(meter.label)}</span>
      <span style="flex:1;min-width:0">${barHTML(pct, cols, c, barId)}</span>
      <span style="width:34px;text-align:right;color:${c.dim};flex-shrink:0">${Math.round(pct)}%</span>
    </div>`;
}

/**
 * @param {Limits} data @param {ReturnType<typeof tuiColors>} c @param {number} now
 * @param {number} cols @param {number} compactCols
 */
function tuiPanelHTML(data, c, now, cols, compactCols) {
  const planText = data.plan ? esc(data.plan) : 'UNKNOWN';
  // Falls back to the domain the panel was opened on when the backend didn't
  // report a hostname.
  const host =
    data.host ||
    (typeof location !== 'undefined' && location.hostname ? location.hostname : 'localhost');
  const header = `
    <div style="border:1px solid ${c.border};border-radius:6px;padding:10px 16px;display:flex;align-items:center;gap:16px;font-size:0.75rem;letter-spacing:0.06em;color:${c.dim};background:${c.headerBg}">
      <span style="color:${c.text}">limits@${esc(host)} ~</span>
      <span style="margin-left:auto">[ PLAN: <span style="color:${c.text}">${planText}</span> ]</span>
      <span style="font-variant-numeric:tabular-nums;color:${c.text}">${fmtClock(now)}</span>
    </div>`;

  const blocks = [];
  if (data.session)
    blocks.push(tuiBlock('5-HOUR SESSION', data.session, now, c, cols, { barId: 'cl-bar-0' }));
  else
    blocks.push(`
      <div style="border:1px solid ${c.border};border-radius:6px;padding:20px;margin-top:16px;color:${c.dim};font-size:0.8rem">No session data.</div>`);

  if (data.daily)
    blocks.push(
      tuiBlock("TODAY'S BUDGET", data.daily, now, c, cols, data.session ? {} : { barId: 'cl-bar-0' }),
    );

  const allModels = data.weekly.find((m) => m.label === 'All models') || null;
  if (allModels) blocks.push(tuiBlock('WEEKLY / ALL MODELS', allModels, now, c, cols));

  const extraWeekly = data.weekly.filter((m) => m !== allModels && m.usedPct != null && m.usedPct > 0);
  const extraRows = extraWeekly.length
    ? `<div style="margin-top:18px;font-size:0.68rem;letter-spacing:0.12em;color:${c.dim}">[ OTHER WEEKLY BUCKETS ]</div>${extraWeekly
        .map((m, i) => tuiCompactRow(m, c, compactCols, i === 0 ? 'cl-cbar-0' : undefined))
        .join('')}`
    : '';

  return header + blocks.join('') + extraRows;
}

/** @param {LimitsResponse} r @param {ReturnType<typeof tuiColors>} c */
function tuiErrorHTML(r, c) {
  const title =
    r.code === 'no_credentials'
      ? 'NO TOKEN FOUND'
      : r.code === 'unauthorized'
        ? 'NOT AUTHORIZED'
        : 'LOAD FAILED';
  return `
    <div style="border:1px solid ${c.border};border-radius:6px;padding:20px;margin-top:16px;background:${c.panelBg}">
      <div style="font-size:0.85rem;letter-spacing:0.08em;color:${c.warn}">[ ERROR: ${esc(title)} ]</div>
      <div style="font-size:0.78rem;color:${c.dim};margin-top:10px;line-height:1.5">${esc(r.error || 'Unknown error.')}</div>
    </div>`;
}

/** @param {ReturnType<typeof tuiColors>} c */
function tuiSkeletonHTML(c) {
  return `<div style="border:1px solid ${c.border};border-radius:6px;padding:24px;margin-top:16px;text-align:center;color:${c.dim};letter-spacing:0.15em;font-size:0.8rem">LOADING…</div>`;
}

// ── Shared chrome ─────────────────────────────────────────────────────

/** @param {boolean} isTui @param {{text:string,border:string,muted?:string,dim?:string}} c */
function tabBarHTML(isTui, c) {
  const mutedColor = c.muted != null ? c.muted : c.dim;
  const activeStyle = `color:${c.text};border-bottom:2px solid ${c.text};font-weight:600`;
  const inactiveStyle = `color:${mutedColor};border-bottom:2px solid transparent`;
  return `
    <div style="display:flex;gap:22px;border-bottom:1px solid ${c.border};margin-bottom:10px">
      <button id="cl-tab-panel" style="background:none;border:none;cursor:pointer;padding:8px 2px;font-size:0.85rem;font-family:${FONT};${isTui ? inactiveStyle : activeStyle}">Panel</button>
      <button id="cl-tab-tui" style="background:none;border:none;cursor:pointer;padding:8px 2px;font-size:0.85rem;font-family:${TUI_FONT};letter-spacing:0.05em;${isTui ? activeStyle : inactiveStyle}">TUI</button>
    </div>`;
}

/**
 * The "Refresh every" select.
 * @param {number} refreshMs @param {{text:string,border:string,inputBg:string,muted?:string,dim?:string}} c
 * @param {boolean} isTui
 */
function intervalFieldHTML(refreshMs, c, isTui) {
  const mutedColor = c.muted != null ? c.muted : c.dim;
  const opts = REFRESH_OPTIONS.map(
    (o) =>
      `<option value="${o.ms}"${o.ms === refreshMs ? ' selected' : ''}>${isTui ? o.label.toUpperCase() : o.label}</option>`,
  ).join('');
  const label = isTui ? 'REFRESH EVERY' : 'Refresh every';
  return `
    <label style="display:flex;align-items:center;gap:8px;font-size:${isTui ? '0.68rem' : '0.85rem'};color:${mutedColor};${isTui ? 'letter-spacing:0.05em' : ''}">
      <span>${label}</span>
      <select id="cl-interval" style="font-family:${isTui ? TUI_FONT : FONT};font-size:${isTui ? '0.68rem' : '0.8rem'};color:${c.text};background:${c.inputBg};border:1px solid ${c.border};border-radius:${isTui ? '4px' : '6px'};padding:3px 6px;cursor:pointer">${opts}</select>
    </label>`;
}

// ── Mount ──────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} container
 * @param {PluginAPI} api
 */
export function mount(container, api) {
  /** @type {LimitsResponse|null} */
  let last = null;
  let loading = true;
  /** @type {'panel'|'tui'} */
  let activeTab = 'tui';
  let refreshMs = readRefreshMs();
  let barCols = FALLBACK_BAR_COLS;
  let compactCols = FALLBACK_COMPACT_COLS;
  /** Width of one monospace bar char, measured lazily from the live DOM. */
  let charW = 0;
  /** Guards the measure → re-render → measure cycle. */
  let measuring = false;
  /** @type {ReturnType<typeof setInterval>|null} */
  let timer = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let secTimer = null;
  /** @type {any} */
  let resizeObs = null;

  const root = document.createElement('div');
  Object.assign(root.style, {
    height: '100%',
    overflowY: 'auto',
    boxSizing: 'border-box',
    fontFamily: FONT,
  });
  container.appendChild(root);

  const col = document.createElement('div');
  Object.assign(col.style, {
    maxWidth: '480px',
    margin: '0 auto',
    padding: '40px 28px 56px',
  });
  root.appendChild(col);

  /** @returns {number} */
  function readRefreshMs() {
    try {
      if (typeof localStorage === 'undefined') return DEFAULT_REFRESH_MS;
      const stored = localStorage.getItem(LS_KEY);
      // Guard the null → Number(null) === 0 trap: 0 is a real choice ("Off"),
      // so an absent key must not read as one.
      if (stored == null || stored === '') return DEFAULT_REFRESH_MS;
      const v = Number(stored);
      if (Number.isFinite(v) && REFRESH_OPTIONS.some((o) => o.ms === v)) return v;
    } catch {
      /* storage unavailable (private mode / shim) — fall through */
    }
    return DEFAULT_REFRESH_MS;
  }

  /** @param {number} ms */
  function writeRefreshMs(ms) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, String(ms));
    } catch {
      /* non-fatal: the choice just won't survive a reload */
    }
  }

  /** Width of one '█' at the bar's font size, or 0 when unmeasurable. */
  function measureCharW() {
    if (charW) return charW;
    const probe = document.createElement('span');
    if (!probe || typeof probe.getBoundingClientRect !== 'function') return 0;
    probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;white-space:pre;font-family:${TUI_FONT};font-size:${BAR_FONT_SIZE};line-height:1.2`;
    probe.textContent = '█'.repeat(100);
    root.appendChild(probe);
    const w = probe.getBoundingClientRect().width / 100;
    if (typeof probe.remove === 'function') probe.remove();
    if (w > 0) charW = w;
    return charW;
  }

  /**
   * Fit a bar's char count to its rendered width.
   * @param {string} id @param {number} fallback @returns {number|null} new col count, or null
   */
  function measureCols(id, fallback) {
    const el = col.querySelector(`#${id}`);
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const w = el.getBoundingClientRect().width;
    const cw = measureCharW();
    if (!w || !cw) return null;
    const cols = Math.max(8, Math.floor(w / cw));
    return cols === fallback ? null : cols;
  }

  function attachTabHandlers() {
    const bp = col.querySelector('#cl-tab-panel');
    const bt = col.querySelector('#cl-tab-tui');
    if (bp)
      bp.addEventListener('click', () => {
        if (activeTab !== 'panel') {
          activeTab = 'panel';
          render();
        }
      });
    if (bt)
      bt.addEventListener('click', () => {
        if (activeTab !== 'tui') {
          activeTab = 'tui';
          render();
        }
      });
    const sel = /** @type {any} */ (col.querySelector('#cl-interval'));
    if (sel)
      sel.addEventListener('change', () => {
        const ms = Number(sel.value);
        if (!Number.isFinite(ms)) return;
        refreshMs = ms;
        writeRefreshMs(ms);
        armTimer();
        render();
        if (ms) load(true);
      });
  }

  function render() {
    const c = colors(api.context.theme === 'dark');
    const tc = tuiColors(api.context.theme === 'dark');
    const isTui = activeTab === 'tui';
    const active = isTui ? tc : c;

    root.style.background = active.bg;
    root.style.color = active.text;
    col.style.maxWidth = isTui ? '640px' : '480px';
    col.style.fontFamily = isTui ? TUI_FONT : FONT;

    const tabs = tabBarHTML(isTui, active);

    if (loading && !last) {
      col.innerHTML = tabs + (isTui ? tuiSkeletonHTML(tc) : skeletonHTML(c));
      attachTabHandlers();
      return;
    }

    const r = last;
    if (!r) {
      col.innerHTML = tabs;
      attachTabHandlers();
      return;
    }

    const intervalField = intervalFieldHTML(refreshMs, active, isTui);

    if (isTui) {
      const body =
        r.ok && r.data ? tuiPanelHTML(r.data, tc, Date.now(), barCols, compactCols) : tuiErrorHTML(r, tc);
      const updated = r.ok && r.data ? fmtUpdated(r.data.fetchedAt).toUpperCase() : '';
      const footer = `
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:20px;padding-top:14px;border-top:1px solid ${tc.border};font-size:0.68rem;color:${tc.dim};letter-spacing:0.05em">
          <span>${r.ok ? `LAST SYNC ${updated}` : 'NOT LOADED'}${r.source === 'cache' ? ' · CACHED' : ''}</span>
          ${intervalField}
          <button id="cl-refresh-tui" title="Refresh" aria-label="Refresh"
            style="margin-left:auto;background:none;border:1px solid ${tc.border};border-radius:4px;color:${tc.text};cursor:pointer;font-family:${TUI_FONT};font-size:0.68rem;padding:4px 10px;letter-spacing:0.05em">[ R ] REFRESH</button>
        </div>`;
      col.innerHTML = tabs + body + footer;
      const btn = col.querySelector('#cl-refresh-tui');
      if (btn) btn.addEventListener('click', () => load(true));
    } else {
      const body = r.ok && r.data ? panelHTML(r.data, c) : errorHTML(r, c);
      const updated = r.ok && r.data ? fmtUpdated(r.data.fetchedAt) : '';
      const footer = `
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:40px;padding-top:16px;border-top:1px solid ${c.border}">
          <span style="font-size:0.85rem;color:${c.muted}">${r.ok ? `Last updated: ${updated}` : 'Not loaded'}${r.source === 'cache' ? ' · cached' : ''}</span>
          ${intervalField}
          <button id="cl-refresh" title="Refresh" aria-label="Refresh"
            style="margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:none;border-radius:8px;background:transparent;color:${c.muted};cursor:pointer;transition:background .15s">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/>
            </svg>
          </button>
        </div>`;
      col.innerHTML = tabs + body + footer + debugHTML(r, c);
      const btn = col.querySelector('#cl-refresh');
      if (btn) {
        btn.addEventListener('mouseenter', () => (btn.style.background = c.btnHover));
        btn.addEventListener('mouseleave', () => (btn.style.background = 'transparent'));
        btn.addEventListener('click', () => load(true));
      }
    }

    attachTabHandlers();

    // The bars are made of monospace glyphs, so "full width" means fitting the
    // char count to the measured width. Re-render once if the fit changed.
    if (isTui && !measuring) {
      const main = measureCols('cl-bar-0', barCols);
      const comp = measureCols('cl-cbar-0', compactCols);
      if (main != null) barCols = main;
      if (comp != null) compactCols = comp;
      if (main != null || comp != null) {
        measuring = true;
        render();
        measuring = false;
      }
    }
  }

  /** @param {boolean} force */
  async function load(force) {
    if (force) {
      loading = true;
      // keep last panel visible, just spin conceptually
    }
    try {
      const r = /** @type {LimitsResponse} */ (
        await api.rpc('GET', `limits${force ? '?force=1' : ''}`)
      );
      last = r;
    } catch (err) {
      last = {
        ok: false,
        code: 'network',
        error: err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err),
        source: 'live',
        endpoint: '',
      };
    } finally {
      loading = false;
      render();
    }
  }

  function armTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (refreshMs > 0) timer = setInterval(() => load(false), refreshMs);
  }

  render();
  load(false);
  armTimer();

  // Re-render every second so the TUI countdowns tick live without waiting
  // for the next data poll.
  secTimer = setInterval(() => {
    if (activeTab === 'tui') render();
  }, 1000);

  if (typeof ResizeObserver !== 'undefined') {
    // Width only: render() changes the content height, so reacting to height
    // here would feed back into itself.
    let lastW = 0;
    resizeObs = new ResizeObserver((entries) => {
      const w = entries[0] && entries[0].contentRect ? entries[0].contentRect.width : 0;
      if (w === lastW) return;
      lastW = w;
      if (activeTab === 'tui') render();
    });
    resizeObs.observe(col);
  }

  const unsub = api.onContextChange(() => render());

  /** @type {any} */ (container)._clCleanup = () => {
    if (timer) clearInterval(timer);
    if (secTimer) clearInterval(secTimer);
    if (resizeObs) resizeObs.disconnect();
    unsub();
  };
}

/** @param {HTMLElement} container */
export function unmount(container) {
  const cleanup = /** @type {any} */ (container)._clCleanup;
  if (typeof cleanup === 'function') cleanup();
  delete (/** @type {any} */ (container)._clCleanup);
  container.innerHTML = '';
}
