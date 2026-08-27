// @ts-check
/**
 * Claude — frontend tab.
 *
 * A single full-width dashboard combining what used to be three separate
 * plugins' tabs:
 *   1. Plan usage limits (Claude Limits)      — countdown timers + bars
 *   2. Token/cost history (Claude Usage)      — stat tiles, daily chart, by
 *      model / by project breakdowns
 *   3. Active Claude sessions (Session Manager) — table with kill/resume/cleanup
 *
 * DOM is built once in mount(); render(state) only updates nodes in place —
 * the same pattern cloudcli-system-monitor/dist/index.js uses, so hover state
 * and in-flight kill confirmations survive a data poll instead of being wiped
 * by an innerHTML rebuild.
 *
 * Two independent timers: a data poll (interval selectable, persisted in
 * localStorage — same key/values the old Claude Limits tab used) and a
 * `setInterval(1000)` that only re-renders the H:MM:SS countdown text, so the
 * seconds digit ticks without re-fetching anything.
 *
 * Language follows the host panel's own setting (`localStorage.userLanguage`,
 * re-read on every poll — there is no change event) and defaults to English,
 * exactly like cloudcli-system-monitor.
 */

/** Auto-refresh interval used until the user picks another one. Same default
 *  and localStorage key the pre-2.0 Claude Limits tab used, so an existing
 *  choice carries over. */
const DEFAULT_REFRESH_MS = 180_000;
const LS_REFRESH_KEY = 'cloudcli-claude-limits:refreshMs';
const REFRESH_OPTIONS = [10_000, 30_000, 60_000, 180_000, 300_000, 0];

/** The host panel's own language setting. */
const HOST_LANG_KEY = 'userLanguage';

/** Usage sub-tab filter state (period / grouping / breakdown), persisted. */
const LS_USAGE_KEY = 'cloudcli-claude-limits:usageFilters';
const PERIOD_PRESETS = ['today', '7d', '30d', 'all', 'custom'];
const GROUP_BYS = ['day', 'week', 'month', 'session'];
/** Rows rendered in the Usage table before it is truncated. */
const MAX_TABLE_ROWS = 300;

/** Severity thresholds for a usage meter: [warning, critical]. */
const T_LIMIT = [75, 90];

/** Kill needs a second click within this window, or it disarms. */
const KILL_CONFIRM_MS = 4000;

// ── Strings ────────────────────────────────────────────────────────────

function ruPlural(n, f) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return f[2];
  if (b > 1 && b < 5) return f[1];
  if (b === 1) return f[0];
  return f[2];
}

const STRINGS = {
  en: {
    locale: 'en-US',
    title: 'Claude',
    refresh: 'Refresh',
    interval: 'Refresh every',
    intervalOption: (ms) => (ms === 0 ? 'Off' : ms >= 60000 ? `${ms / 60000}m` : `${ms / 1000}s`),
    lastUpdated: (s) => `Updated ${s}`,
    cached: ' · cached',
    justNow: 'just now',
    agoSec: (s) => `${s}s ago`,
    agoMin: (m) => `${m}m ago`,

    limitSession: 'Current session',
    limitDaily: "Today's budget",
    limitAllModels: 'All models',
    remaining: (p) => (p == null ? 'remaining' : `remaining · ${p}%`),
    resetsAt: (s) => `Resets ${s}`,
    resetsNow: 'Resets now',
    used: (p) => `${p}% used`,
    estimated: ' (est.)',
    noLimitData: 'No limit data.',
    limitsError: '⚠ Could not load usage limits',

    statTotal: 'Total tokens',
    statOutput: 'Output tokens',
    statCost: 'Est. cost',
    statSessions: 'Sessions',

    histTitle: 'Daily tokens (30 days)',
    histEmpty: 'No token usage recorded yet.',
    histTip: (date, tok, cost) => `${date}<br><b>${tok}</b> tokens · ${cost}`,

    byModel: 'By model',
    byProject: 'By project',
    bySession: 'Top sessions',
    noData: 'No data.',
    historyError: '⚠ Could not load usage history',

    sessionsTitle: 'Active sessions',
    sessTotal: (n) => `${n} ${n === 1 ? 'session' : 'sessions'}`,
    thSession: 'Session',
    thStatus: 'Status',
    thModel: 'Model',
    thUptime: 'Uptime',
    thCpu: 'CPU',
    thMem: 'Mem',
    thActions: 'Actions',
    sessNone: 'No Claude sessions are running.',
    sessionsError: '⚠ Could not load sessions',
    stWorking: 'working',
    stWaiting: (d) => `waiting ${d}`,
    stQuiet: (d) => `quiet ${d}`,
    stUnknown: 'unknown',
    stResumed: 'resumed',
    stNoProc: 'no process',
    durSec: (s) => `${s}s`,
    durMin: (m) => `${m}m`,
    durHM: (hh, mm) => `${hh}h ${mm}m`,
    durDH: (dd, hh) => `${dd}d ${hh}h`,
    durHour: (hh) => `${hh}h`,
    durDay: (dd) => `${dd}d`,

    kill: 'Kill',
    killConfirm: 'Confirm?',
    resume: 'Resume',
    cleanup: 'Cleanup',
    cleaningUp: 'Cleaning…',

    toastKillSent: (pid) => `Sent SIGTERM to PID ${pid}`,
    toastKillFailed: (m) => `Kill failed: ${m}`,
    toastResumeSent: (pid) => `Resumed (PID ${pid})`,
    toastResumeFailed: (m) => `Resume failed: ${m}`,
    toastCleanupDone: (del, comp) =>
      del || comp
        ? `Cleanup: ${[del ? `${del} orphaned session${del !== 1 ? 's' : ''}` : null, comp ? `${comp} log${comp !== 1 ? 's' : ''} compressed` : null].filter(Boolean).join(', ')}`
        : 'Cleanup: nothing to do',
    toastCleanupFailed: (m) => `Cleanup failed: ${m}`,

    tabDashboard: 'Dashboard',
    tabUsage: 'Usage',
    fPeriod: 'Period',
    fGroup: 'Group by',
    fProject: 'Project',
    fModel: 'Model',
    fRange: 'Custom range',
    periodToday: 'Today',
    period7d: '7d',
    period30d: '30d',
    periodAll: 'All time',
    periodCustom: 'Custom',
    groupDay: 'Day',
    groupWeek: 'Week',
    groupMonth: 'Month',
    groupSession: 'Session',
    allProjects: 'All projects',
    allModels: 'All models',
    dateSep: '\u2192',
    statMessages: 'Messages',
    usageChart: 'Tokens per period',
    usageTable: 'Breakdown',
    usageEmpty: 'No usage in this range.',
    usageLoading: 'Loading\u2026',
    usageError: '\u26a0 Could not load usage',
    usageRange: (from, to) => `${from} \u2013 ${to}`,
    showingRows: (n, total) => (n < total ? `showing ${n} of ${total}` : `${total} rows`),
    thPeriod: 'Period',
    thInput: 'Input',
    thOutput: 'Output',
    thCacheW: 'Cache create',
    thCacheR: 'Cache read',
    thTotal: 'Total',
    thCost: 'Cost',
    thMessages: 'Msgs',
    thSessionId: 'Session',
    thProject: 'Project',
    thStart: 'Start',
    thEnd: 'End',
    thDuration: 'Duration',
    thModels: 'Models',
    copyId: 'Copy the full session id',
    openSession: 'Open this session in the panel',
    toastIdCopied: 'Session id copied',
    toastCopyFailed: 'Could not copy — select the id and copy it manually',
  },

  ru: {
    locale: 'ru-RU',
    title: 'Claude',
    refresh: 'Обновить',
    interval: 'Обновлять каждые',
    intervalOption: (ms) => (ms === 0 ? 'Выкл' : ms >= 60000 ? `${ms / 60000} мин` : `${ms / 1000} с`),
    lastUpdated: (s) => `Обновлено ${s}`,
    cached: ' · кэш',
    justNow: 'сейчас',
    agoSec: (s) => `${s} с назад`,
    agoMin: (m) => `${m} мин назад`,

    limitSession: 'Текущая сессия',
    limitDaily: 'Бюджет на сегодня',
    limitAllModels: 'Все модели',
    remaining: (p) => (p == null ? 'осталось' : `осталось · ${p}%`),
    resetsAt: (s) => `Сброс ${s}`,
    resetsNow: 'Сброс сейчас',
    used: (p) => `${p}% использовано`,
    estimated: ' (оценка)',
    noLimitData: 'Нет данных о лимитах.',
    limitsError: '⚠ Не удалось загрузить лимиты',

    statTotal: 'Всего токенов',
    statOutput: 'Токенов на выход',
    statCost: 'Оценка стоимости',
    statSessions: 'Сессий',

    histTitle: 'Токены по дням (30 дней)',
    histEmpty: 'Использование токенов ещё не зафиксировано.',
    histTip: (date, tok, cost) => `${date}<br><b>${tok}</b> токенов · ${cost}`,

    byModel: 'По моделям',
    byProject: 'По проектам',
    bySession: 'Топ сессий',
    noData: 'Нет данных.',
    historyError: '⚠ Не удалось загрузить историю',

    sessionsTitle: 'Активные сессии',
    sessTotal: (n) => `${n} ${ruPlural(n, ['сессия', 'сессии', 'сессий'])}`,
    thSession: 'Сессия',
    thStatus: 'Статус',
    thModel: 'Модель',
    thUptime: 'Аптайм',
    thCpu: 'CPU',
    thMem: 'Память',
    thActions: 'Действия',
    sessNone: 'Активных сессий Claude нет.',
    sessionsError: '⚠ Не удалось загрузить сессии',
    stWorking: 'работает',
    stWaiting: (d) => `ждёт ${d}`,
    stQuiet: (d) => `молчит ${d}`,
    stUnknown: 'неизвестно',
    stResumed: 'продолжена',
    stNoProc: 'нет процесса',
    durSec: (s) => `${s} с`,
    durMin: (m) => `${m} мин`,
    durHM: (hh, mm) => `${hh} ч ${mm} мин`,
    durDH: (dd, hh) => `${dd} дн ${hh} ч`,
    durHour: (hh) => `${hh} ч`,
    durDay: (dd) => `${dd} дн`,

    kill: 'Убить',
    killConfirm: 'Точно?',
    resume: 'Продолжить',
    cleanup: 'Очистить',
    cleaningUp: 'Чистим…',

    toastKillSent: (pid) => `SIGTERM отправлен PID ${pid}`,
    toastKillFailed: (m) => `Ошибка kill: ${m}`,
    toastResumeSent: (pid) => `Сессия продолжена (PID ${pid})`,
    toastResumeFailed: (m) => `Ошибка resume: ${m}`,
    toastCleanupDone: (del, comp) =>
      del || comp
        ? `Очистка: ${[del ? `${del} ${ruPlural(del, ['сессия', 'сессии', 'сессий'])} удалено` : null, comp ? `${comp} ${ruPlural(comp, ['журнал', 'журнала', 'журналов'])} сжато` : null].filter(Boolean).join(', ')}`
        : 'Очистка: нечего чистить',
    toastCleanupFailed: (m) => `Ошибка очистки: ${m}`,

    tabDashboard: 'Дашборд',
    tabUsage: 'Расход',
    fPeriod: 'Период',
    fGroup: 'Группировка',
    fProject: 'Проект',
    fModel: 'Модель',
    fRange: 'Свой диапазон',
    periodToday: 'Сегодня',
    period7d: '7 дн',
    period30d: '30 дн',
    periodAll: 'За всё время',
    periodCustom: 'Свой',
    groupDay: 'День',
    groupWeek: 'Неделя',
    groupMonth: 'Месяц',
    groupSession: 'Сессия',
    allProjects: 'Все проекты',
    allModels: 'Все модели',
    dateSep: '\u2192',
    statMessages: 'Сообщений',
    usageChart: 'Токены по периодам',
    usageTable: 'Разбивка',
    usageEmpty: 'В этом диапазоне расхода нет.',
    usageLoading: 'Загрузка\u2026',
    usageError: '\u26a0 Не удалось загрузить расход',
    usageRange: (from, to) => `${from} \u2013 ${to}`,
    showingRows: (n, total) =>
      n < total
        ? `показано ${n} из ${total}`
        : `${total} ${ruPlural(total, ['строка', 'строки', 'строк'])}`,
    thPeriod: 'Период',
    thInput: 'Вход',
    thOutput: 'Выход',
    thCacheW: 'Запись кэша',
    thCacheR: 'Чтение кэша',
    thTotal: 'Всего',
    thCost: 'Стоимость',
    thMessages: 'Сообщ.',
    thSessionId: 'Сессия',
    thProject: 'Проект',
    thStart: 'Начало',
    thEnd: 'Конец',
    thDuration: 'Длительность',
    thModels: 'Модели',
    copyId: 'Скопировать полный id сессии',
    openSession: 'Открыть эту сессию в панели',
    toastIdCopied: 'ID сессии скопирован',
    toastCopyFailed: 'Не удалось скопировать — выделите id и скопируйте вручную',
  },
};

/** `userLanguage` if it is one we speak, else English — matches the host's own rule. */
function resolveLang() {
  try {
    const v = localStorage.getItem(HOST_LANG_KEY);
    if (v && STRINGS[v]) return v;
  } catch {
    /* storage can be blocked; English is the host's fallback too */
  }
  return 'en';
}

/** @type {typeof STRINGS.en} */
let t = STRINGS.en;

// ── Styles ─────────────────────────────────────────────────────────────

const CSS = `
.cld-root {
  --page: #f6f6f4;
  --card: #ffffff;
  --border: rgba(11,11,11,0.10);
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #898781;
  --accent: #2a78d6;
  --accent-soft: #86b6ef;
  --warning: #fab219;
  --critical: #d03b3b;
  --ok: #1a9c6b;
  --track-mix: 16%;
  color-scheme: light;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden; /* setting only overflow-y makes browsers treat the x-axis as
    'auto' too (spec quirk) — a single overflowing descendant would otherwise drag
    the whole page sideways instead of clipping. Wide content (the sessions table)
    gets its own local scroller instead, see .cld-tbl-wrap. */
  box-sizing: border-box;
  background: var(--page);
  color: var(--ink);
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.45;
}
.cld-root[data-theme="dark"] {
  --page: #141417;
  --card: #1b1b1f;
  --border: rgba(255,255,255,0.10);
  --ink: #ffffff;
  --ink-2: #c3c2b7;
  --muted: #898781;
  --accent: #3987e5;
  --accent-soft: #184f95;
  --ok: #2fbf87;
  --track-mix: 20%;
  color-scheme: dark;
}

/* No max-width: this tab is meant to fill the whole panel width. */
.cld-wrap { width: 100%; margin: 0; padding: 24px 28px 56px; box-sizing: border-box; }
/* Vertical rhythm between the dashboard's blocks (header, limits, stats,
   histogram, by-model/project, sessions) — margins collapse with any block's
   own top margin (e.g. .cld-section-title), so the larger one wins. */
.cld-wrap > * + * { margin-top: 24px; }

.cld-head { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
.cld-title { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; margin: 0; }
.cld-plan { font-size: 0.95rem; font-weight: 500; color: var(--muted); margin-left: 10px; }
.cld-head-right { margin-left: auto; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cld-stamp { font-size: 0.8rem; color: var(--muted); white-space: nowrap; }
.cld-btn {
  display: inline-flex; align-items: center; justify-content: center;
  height: 30px; padding: 0 12px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--card); color: var(--ink-2); cursor: pointer; font-size: 0.78rem; font-weight: 500;
  transition: background .15s, opacity .15s;
}
.cld-btn:hover { background: color-mix(in srgb, var(--ink) 6%, var(--card)); }
.cld-btn:disabled { opacity: .5; cursor: not-allowed; }
.cld-icon-btn { width: 30px; padding: 0; }
.cld-sel {
  font-family: inherit; font-size: 0.78rem; color: var(--ink-2);
  background: var(--card); border: 1px solid var(--border); border-radius: 8px;
  padding: 4px 6px; cursor: pointer;
}

.cld-card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: 14px; padding: 16px 18px 18px; min-width: 0;
}
.cld-card-h { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
.cld-card-t { font-size: 0.92rem; font-weight: 600; letter-spacing: -0.01em; }
.cld-card-s { font-size: 0.78rem; color: var(--muted); margin-left: auto; text-align: right; white-space: nowrap; }

/* Limits row */
.cld-limits-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
.cld-countdown { font-size: 1.7rem; font-weight: 700; letter-spacing: -0.01em; margin: 8px 0 0; font-variant-numeric: tabular-nums; }
.cld-countdown-sub { font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-bottom: 10px; }
.cld-track { height: 8px; border-radius: 999px; overflow: hidden; margin: 6px 0 8px; background: color-mix(in srgb, var(--fill, var(--accent)) var(--track-mix), var(--card)); }
.cld-fill { height: 100%; border-radius: 999px; background: var(--fill, var(--accent)); transition: width .45s cubic-bezier(.16,1,.3,1), background-color .3s ease; }
.cld-limit-foot { display: flex; justify-content: space-between; font-size: 0.76rem; color: var(--muted); }
.cld-limit-foot .cld-warn { color: var(--warning); }
.cld-limit-foot .cld-crit { color: var(--critical); }

/* Stat tiles */
.cld-stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; }
.cld-stat-val { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; }
.cld-stat-label { font-size: 0.68rem; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; margin-top: 4px; }

/* Histogram */
.cld-chart { display: flex; gap: 2px; align-items: flex-end; height: 110px; margin-top: 8px; position: relative; }
.cld-bar { flex: 1 1 0; display: flex; align-items: flex-end; height: 100%; min-width: 0; cursor: default; }
.cld-bar > i { display: block; width: 100%; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 0; transition: background-color .15s; }
.cld-bar:hover > i { background: var(--accent-soft); }
.cld-chart-cap { display: flex; justify-content: space-between; font-size: 0.72rem; color: var(--muted); margin-top: 6px; }
.cld-tip {
  position: fixed; z-index: 20; pointer-events: none; transform: translate(-50%, -100%);
  background: var(--ink); color: var(--page); border-radius: 8px; padding: 6px 10px;
  font-size: 0.74rem; line-height: 1.35; white-space: nowrap; box-shadow: 0 4px 14px rgba(0,0,0,0.22);
  opacity: 0; transition: opacity .1s; margin-top: -8px;
}
.cld-tip.show { opacity: 1; }
.cld-tip b { font-weight: 700; }

/* By model / by project */
.cld-mp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.cld-mp-row { display: flex; justify-content: space-between; gap: 10px; padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 0.8rem; }
.cld-mp-row:last-child { border-bottom: none; }
.cld-mp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.cld-mp-tok { color: var(--muted); flex-shrink: 0; }
.cld-mp-cost { color: var(--accent); flex-shrink: 0; width: 64px; text-align: right; }

@media (max-width: 720px) {
  .cld-mp-grid { grid-template-columns: 1fr; }
}

@media (max-width: 640px) {
  .cld-wrap { padding: 16px 14px 40px; }
  .cld-sess-name, .cld-sess-sub { max-width: 46vw; }
  /* CPU/Mem are the least essential columns — drop them first so the table
     fits (or comes close to fitting) without horizontal scrolling at all. */
  table.cld-tbl th:nth-child(5), table.cld-tbl td:nth-child(5),
  table.cld-tbl th:nth-child(6), table.cld-tbl td:nth-child(6) { display: none; }
}

/* Sessions table */
.cld-sess-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
/* Scrolls internally on narrow screens instead of widening the card (and with
   it .cld-wrap / .cld-root) past the viewport — see the .cld-root comment. */
.cld-tbl-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 -18px; padding: 0 18px; }
table.cld-tbl { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
table.cld-tbl th {
  text-align: left; font-weight: 500; color: var(--muted); font-size: 0.72rem;
  letter-spacing: 0.04em; text-transform: uppercase;
  padding: 0 10px 8px 0; border-bottom: 1px solid var(--border); white-space: nowrap;
}
table.cld-tbl td { padding: 8px 10px 8px 0; border-bottom: 1px solid var(--border); vertical-align: middle; }
table.cld-tbl tr:last-child td { border-bottom: none; }
.cld-sess-name { font-weight: 500; color: var(--ink); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cld-sess-sub { display: block; color: var(--muted); font-weight: 400; font-size: 0.74rem; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cld-badge {
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  padding: 2px 9px 2px 7px; border-radius: 999px; font-size: 0.74rem; font-weight: 500;
  color: var(--tone, var(--ink-2)); background: color-mix(in srgb, var(--tone, var(--muted)) 14%, var(--card));
}
.cld-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tone, var(--muted)); flex-shrink: 0; }
.cld-actions { display: flex; gap: 6px; }
.cld-btn-sm { height: 26px; padding: 0 10px; font-size: 0.72rem; border-radius: 6px; }
.cld-btn-danger { border-color: color-mix(in srgb, var(--critical) 50%, var(--border)); color: var(--critical); background: color-mix(in srgb, var(--critical) 8%, var(--card)); }
.cld-btn-danger.cld-armed { background: var(--critical); color: #fff; border-color: var(--critical); }
.cld-btn-ok { border-color: color-mix(in srgb, var(--ok) 50%, var(--border)); color: var(--ok); background: color-mix(in srgb, var(--ok) 8%, var(--card)); }
.cld-empty { text-align: center; padding: 24px; color: var(--muted); font-size: 0.85rem; }

.cld-err { border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; font-size: 0.82rem; color: var(--warning); background: var(--card); }

.cld-toast {
  position: fixed; bottom: 20px; right: 20px; z-index: 9999;
  background: var(--card); color: var(--ink); border: 1px solid var(--border);
  padding: 10px 16px; border-radius: 8px; font-size: 0.82rem; max-width: 360px;
  box-shadow: 0 4px 20px rgba(0,0,0,.25);
}
@media (prefers-reduced-motion: reduce) {
  .cld-fill, .cld-bar > i { transition: none; }
}

/* Sub-tabs (Dashboard / Usage). One CloudCLI plugin gets exactly one top-level
   tab slot, so the second view lives in here rather than next to it. */
.cld-tabs { display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); }
.cld-tab {
  border: none; background: transparent; color: var(--muted);
  font: inherit; font-size: 0.8rem; font-weight: 500;
  padding: 5px 14px; border-radius: 7px; cursor: pointer;
}
.cld-tab:hover { color: var(--ink-2); }
.cld-tab[aria-selected="true"] { background: color-mix(in srgb, var(--accent) 14%, var(--card)); color: var(--accent); }
/* Same vertical rhythm the wrap gives its own children, now that the sections
   are one level deeper. */
.cld-view > * + * { margin-top: 24px; }

/* Usage filter bar */
.cld-filters { display: flex; flex-wrap: wrap; gap: 14px 20px; align-items: flex-end; }
.cld-fgroup { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.cld-flabel { font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.cld-seg { display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--border); border-radius: 9px; background: var(--page); flex-wrap: wrap; }
.cld-seg > button {
  border: none; background: transparent; color: var(--ink-2);
  font: inherit; font-size: 0.76rem; padding: 4px 11px; border-radius: 6px; cursor: pointer;
}
.cld-seg > button:hover { background: color-mix(in srgb, var(--ink) 6%, var(--page)); }
.cld-seg > button[aria-pressed="true"] { background: var(--accent); color: #fff; }
.cld-dates { display: flex; gap: 6px; align-items: center; font-size: 0.76rem; color: var(--muted); }
.cld-date {
  font: inherit; font-size: 0.76rem; color: var(--ink-2);
  background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 4px 8px;
}
.cld-sel-wide { max-width: 220px; }

/* Usage table */
table.cld-tbl th.cld-sortable { cursor: pointer; user-select: none; }
table.cld-tbl th.cld-sortable:hover { color: var(--ink-2); }
table.cld-tbl th.cld-sorted { color: var(--accent); }
table.cld-tbl th.cld-num, table.cld-tbl td.cld-num { text-align: right; font-variant-numeric: tabular-nums; padding-right: 14px; }
table.cld-tbl td.cld-num { color: var(--ink-2); }
table.cld-tbl td.cld-num-total { color: var(--ink); font-weight: 500; }
table.cld-tbl td.cld-num-cost { color: var(--accent); }
.cld-cell-ell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cld-sid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.76rem; }
/* Session id: a copy button plus a link to the host panel's own /session/:id
   route — the same href CloudCLI's own recent-conversation list uses. Kept
   side by side so the id reads as one control. */
.cld-sid-cell { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
.cld-sid-btn {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.76rem;
  border: 1px solid var(--border); border-radius: 6px; background: var(--page);
  color: var(--ink-2); padding: 1px 7px; cursor: pointer; line-height: 1.5;
  transition: background .15s, color .15s, border-color .15s;
}
.cld-sid-btn:hover {
  background: color-mix(in srgb, var(--accent) 12%, var(--card));
  color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}
.cld-sid-btn.cld-copied {
  background: color-mix(in srgb, var(--ok) 16%, var(--card));
  color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--border));
}
.cld-open {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border-radius: 5px;
  color: var(--muted); text-decoration: none;
}
.cld-open:hover { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--card)); }
/* The ranked "Top sessions" rows carry the id control, so they need a little
   more room between the columns than the plain by-model/by-project rows. */
.cld-mp-row .cld-sid-cell + .cld-mp-name { margin-left: 2px; }
@media (prefers-reduced-motion: reduce) { .cld-sid-btn { transition: none; } }
.cld-table-foot { font-size: 0.74rem; color: var(--muted); margin-top: 10px; }
`;

// ── Formatting ─────────────────────────────────────────────────────────

function num(n, d = 1) {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(t.locale, { maximumFractionDigits: d });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Big digit countdown, e.g. "4:55:00" or "3d 0:00:00". @param {number|null} diffMs */
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

/** "Resets Sat 12:59 PM" @param {number|null} ms */
function fmtResetsAt(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  let day = '';
  let time = '';
  try {
    day = d.toLocaleDateString(t.locale, { weekday: 'short' });
    time = d.toLocaleTimeString(t.locale, { hour: 'numeric', minute: '2-digit' });
  } catch {
    day = d.toDateString();
    time = d.toTimeString().slice(0, 5);
  }
  return `${day} ${time}`;
}

/** "Mon, Aug 18" from a YYYY-MM-DD string (parsed at UTC noon to dodge TZ day-shift). */
function fmtChartDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T12:00:00Z`);
  try {
    return d.toLocaleDateString(t.locale, { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function ago(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 45) return t.justNow;
  if (s < 3600) return t.agoSec(Math.floor(s / 60) === 0 ? s : Math.floor(s / 60));
  return t.agoMin(Math.floor(s / 3600));
}

/** Compact duration: 45s / 12m / 3h 10m / 2d 4h. @param {number} sec */
function dur(sec) {
  if (!Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return t.durSec(s);
  if (s < 3600) return t.durMin(Math.floor(s / 60));
  if (s < 86400) return t.durHM(Math.floor(s / 3600), Math.floor((s % 3600) / 60));
  return t.durDH(Math.floor(s / 86400), Math.floor((s % 86400) / 3600));
}

/** A coarser step for the status pill. @param {number} sec */
function durCoarse(sec) {
  if (!Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return t.durSec(s);
  if (s < 3600) return t.durMin(Math.floor(s / 60));
  if (s < 86400) return t.durHour(Math.floor(s / 3600));
  return t.durDay(Math.floor(s / 86400));
}

function bytes(b) {
  if (!Number.isFinite(b)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${num(v, v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function pct(p, d = 0) {
  return p == null ? '—' : `${num(p, d)}%`;
}

function fmtTokens(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function fmtCost(n) {
  return n == null ? '—' : `$${n.toFixed(2)}`;
}

function totalOf(tok) {
  return tok ? tok.input + tok.output + tok.cacheCreate + tok.cacheRead : 0;
}

/**
 * Severity by threshold: [warning, critical]. Never the only carrier of
 * state — callers pair the returned class with a label.
 * @param {number|null} value @param {number[]} thr
 */
function severity(value, thr) {
  if (value == null) return { color: 'var(--accent)', level: 'ok' };
  if (value >= thr[1]) return { color: 'var(--critical)', level: 'crit' };
  if (value >= thr[0]) return { color: 'var(--warning)', level: 'warn' };
  return { color: 'var(--accent)', level: 'ok' };
}

function errMsg(e) {
  return e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
}

// ── DOM helpers ────────────────────────────────────────────────────────

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Card shell: title + right-aligned subtitle. */
function card() {
  const el = h('div', 'cld-card');
  const head = h('div', 'cld-card-h');
  const title = h('div', 'cld-card-t');
  const sub = h('div', 'cld-card-s');
  head.append(title, sub);
  el.append(head);
  return { el, title, sub };
}

/** Track + fill meter, fill colored by severity. */
function meter() {
  const track = h('div', 'cld-track');
  const fill = h('div', 'cld-fill');
  fill.style.width = '0%';
  track.appendChild(fill);
  return {
    track,
    set(value, color) {
      track.style.setProperty('--fill', color);
      fill.style.width = `${value == null ? 0 : Math.max(0, Math.min(100, value))}%`;
    },
  };
}

/** One limit meter card: title, live countdown, progress bar, reset/used footer. */
function limitCard() {
  const c = card();
  c.el.classList.add('cld-limit-card');
  const countdown = h('div', 'cld-countdown', '--:--:--');
  const countdownSub = h('div', 'cld-countdown-sub');
  const mt = meter();
  const foot = h('div', 'cld-limit-foot');
  const footLeft = h('span');
  const footRight = h('span');
  foot.append(footLeft, footRight);
  c.el.append(countdown, countdownSub, mt.track, foot);
  return { ...c, countdown, countdownSub, meter: mt, footLeft, footRight };
}

// ── Toast ──────────────────────────────────────────────────────────────

function toast(msg) {
  const el = h('div', 'cld-toast', msg);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Session status ─────────────────────────────────────────────────────

/** @param {{status:string, idleSec:number|null}} s */
function statusInfo(s) {
  const tone = s.status === 'working' ? 'var(--accent)' : s.status === 'quiet' ? 'var(--warning)' : 'var(--muted)';
  const label =
    s.status === 'working'
      ? t.stWorking
      : s.status === 'waiting'
        ? t.stWaiting(durCoarse(s.idleSec ?? NaN))
        : s.status === 'quiet'
          ? t.stQuiet(durCoarse(s.idleSec ?? NaN))
          : t.stUnknown;
  return { tone, label };
}

// ── Mount ──────────────────────────────────────────────────────────────

export function mount(container, api) {
  let lang = resolveLang();
  t = STRINGS[lang];

  const style = h('style');
  style.textContent = CSS;
  container.appendChild(style);

  const root = h('div', 'cld-root');
  const wrap = h('div', 'cld-wrap');
  root.appendChild(wrap);
  container.appendChild(root);

  // ── header
  const head = h('div', 'cld-head');
  const titleBox = h('div');
  const title = h('h1', 'cld-title');
  const titleText = h('span', undefined, t.title);
  const plan = h('span', 'cld-plan');
  title.append(titleText, plan);
  titleBox.append(title);
  const right = h('div', 'cld-head-right');
  const stamp = h('span', 'cld-stamp', '');
  const intervalLabel = h('label');
  Object.assign(intervalLabel.style, { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.78rem', color: 'var(--muted)' });
  const intervalSpan = h('span');
  const rateSel = /** @type {HTMLSelectElement} */ (h('select', 'cld-sel'));
  for (const ms of REFRESH_OPTIONS) {
    const opt = /** @type {HTMLOptionElement} */ (h('option'));
    opt.value = String(ms);
    rateSel.append(opt);
  }
  intervalLabel.append(intervalSpan, rateSel);
  const refreshBtn = h('button', 'cld-btn cld-icon-btn');
  refreshBtn.innerHTML =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/></svg>';
  right.append(stamp, intervalLabel, refreshBtn);
  const tabs = h('div', 'cld-tabs');
  const tabDashBtn = h('button', 'cld-tab');
  const tabUsageBtn = h('button', 'cld-tab');
  tabDashBtn.type = 'button';
  tabUsageBtn.type = 'button';
  tabs.append(tabDashBtn, tabUsageBtn);
  head.append(titleBox, tabs, right);
  wrap.append(head);

  // The two sub-views. Only one is in the layout at a time; the tab switcher
  // above toggles them.
  const viewDash = h('div', 'cld-view');
  const viewUsage = h('div', 'cld-view cld-usage-view');
  viewUsage.style.display = 'none';
  wrap.append(viewDash, viewUsage);

  // ── Section 1: limits
  const limitsGrid = h('div', 'cld-limits-grid');
  viewDash.append(limitsGrid);
  /** @type {Map<string, ReturnType<typeof limitCard> & {resetsAtMs: number|null, kind: string}>} */
  const limitEls = new Map();
  const limitsErrBox = h('div', 'cld-err');
  limitsErrBox.style.display = 'none';
  viewDash.append(limitsErrBox);

  // ── Section 2: histogram
  // (The totals tiles and the by-model / by-project rankings that used to sit
  //  here moved to the Usage sub-tab, where they answer to its period and
  //  project/model filters instead of a hardcoded 30 days.)
  const histCard = card();
  const chart = h('div', 'cld-chart');
  const chartCap = h('div', 'cld-chart-cap');
  const chartCapFrom = h('span');
  const chartCapTo = h('span');
  chartCap.append(chartCapFrom, chartCapTo);
  const histEmpty = h('div', 'cld-empty');
  histEmpty.style.display = 'none';
  histCard.el.append(chart, chartCap, histEmpty);
  viewDash.append(histCard.el);
  /** @type {{el: HTMLElement, bar: HTMLElement}[]} */
  let histBars = [];

  // Floating hover tooltip for chart bars — instant on hover, unlike the
  // browser's native `title` (which has a ~1s delay before it shows).
  const chartTip = h('div', 'cld-tip');
  document.body.appendChild(chartTip);
  function positionChartTip(ev, barEl) {
    const r = barEl.getBoundingClientRect();
    chartTip.style.left = `${ev.clientX}px`;
    chartTip.style.top = `${r.top}px`;
  }
  function showChartTip(ev, barEl) {
    chartTip.innerHTML = t.histTip(barEl.dataset.tipDate || '', barEl.dataset.tipTok || '', barEl.dataset.tipCost || '');
    positionChartTip(ev, barEl);
    chartTip.classList.add('show');
  }
  function hideChartTip() {
    chartTip.classList.remove('show');
  }

  // ── Section 3: sessions
  const sessCard = h('div', 'cld-card');
  const sessHead = h('div', 'cld-sess-head');
  const sessTitle = h('div', 'cld-card-t');
  const sessSub = h('span', 'cld-card-s');
  const cleanupBtn = h('button', 'cld-btn', t.cleanup);
  Object.assign(cleanupBtn.style, { marginLeft: 'auto' });
  sessHead.append(sessTitle, sessSub, cleanupBtn);
  const sessTbl = h('table', 'cld-tbl');
  const sessThead = h('thead');
  const sessHeadRow = h('tr');
  const sessThs = [t.thSession, t.thStatus, t.thModel, t.thUptime, t.thCpu, t.thMem, t.thActions].map((label) => h('th', undefined, label));
  sessHeadRow.append(...sessThs);
  sessThead.append(sessHeadRow);
  const sessBody = h('tbody');
  sessTbl.append(sessThead, sessBody);
  const sessTblWrap = h('div', 'cld-tbl-wrap');
  sessTblWrap.append(sessTbl);
  const sessEmpty = h('div', 'cld-empty');
  sessEmpty.style.display = 'none';
  sessCard.append(sessHead, sessTblWrap, sessEmpty);
  viewDash.append(sessCard);
  /** @type {Map<string, any>} */
  const sessRowEls = new Map();

  // ── Usage sub-tab ────────────────────────────────────────────────────
  // Everything below builds the second view: a filter bar, four stat tiles,
  // a per-period bar chart, and a sortable table. Same hand-rolled `h()` DOM
  // as the rest of the file — the table body is the only part rebuilt from
  // scratch on each render, because its row count and column set both change
  // with the grouping.

  /** Segmented control; exactly one value is pressed at a time. */
  function segmented(values, onPick) {
    const box = h('div', 'cld-seg');
    const btns = values.map((v) => {
      const b = h('button');
      b.type = 'button';
      b.dataset.value = v;
      b.addEventListener('click', () => onPick(v));
      box.append(b);
      return b;
    });
    return {
      box,
      relabel(fn) {
        btns.forEach((b, i) => (b.textContent = fn(values[i])));
      },
      select(v) {
        btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v)));
      },
    };
  }

  /** Labelled column in the filter bar. */
  function fgroup(control) {
    const el = h('div', 'cld-fgroup');
    const label = h('div', 'cld-flabel');
    el.append(label, control);
    return { el, label };
  }

  /** UTC YYYY-MM-DD, matching the backend's UTC bucketing. */
  function isoDay(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  const DEFAULT_USAGE_FILTERS = {
    preset: '7d',
    since: isoDay(Date.now() - 29 * 86_400_000),
    until: isoDay(Date.now()),
    groupBy: 'day',
    project: '',
    model: '',
  };

  function readUsageFilters() {
    const f = { ...DEFAULT_USAGE_FILTERS };
    try {
      const raw = localStorage.getItem(LS_USAGE_KEY);
      if (!raw) return f;
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        if (PERIOD_PRESETS.includes(p.preset)) f.preset = p.preset;
        if (GROUP_BYS.includes(p.groupBy)) f.groupBy = p.groupBy;
        if (typeof p.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.since)) f.since = p.since;
        if (typeof p.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.until)) f.until = p.until;
        // Project/model are free-form strings from the data; they may no
        // longer exist, in which case the select falls back to "all".
        if (typeof p.project === 'string') f.project = p.project;
        if (typeof p.model === 'string') f.model = p.model;
      }
    } catch {
      /* storage unavailable or corrupt — defaults are fine */
    }
    return f;
  }

  function writeUsageFilters() {
    try {
      localStorage.setItem(LS_USAGE_KEY, JSON.stringify(usage.filters));
    } catch {
      /* non-fatal */
    }
  }

  const usage = {
    filters: readUsageFilters(),
    /** @type {any} */
    data: null,
    /** @type {{col: string, dir: 1|-1}|null} null = the mode's own default */
    sort: null,
    loading: false,
    loaded: false,
  };

  // ── filter bar
  const usageFilterCard = h('div', 'cld-card');
  const filterBar = h('div', 'cld-filters');
  usageFilterCard.append(filterBar);
  viewUsage.append(usageFilterCard);

  const periodSeg = segmented(PERIOD_PRESETS, (v) => {
    usage.filters.preset = v;
    onFiltersChanged();
  });
  const periodGroup = fgroup(periodSeg.box);

  const dates = h('div', 'cld-dates');
  const sinceInput = /** @type {HTMLInputElement} */ (h('input', 'cld-date'));
  sinceInput.type = 'date';
  const untilInput = /** @type {HTMLInputElement} */ (h('input', 'cld-date'));
  untilInput.type = 'date';
  const dateSep = h('span');
  dates.append(sinceInput, dateSep, untilInput);
  const datesGroup = fgroup(dates);
  for (const [input, key] of /** @type {[HTMLInputElement, 'since'|'until'][]} */ ([
    [sinceInput, 'since'],
    [untilInput, 'until'],
  ])) {
    input.addEventListener('change', () => {
      if (!input.value) return;
      usage.filters[key] = input.value;
      // Editing a date is an implicit switch to the custom preset.
      usage.filters.preset = 'custom';
      onFiltersChanged();
    });
  }

  const groupSeg = segmented(GROUP_BYS, (v) => {
    usage.filters.groupBy = v;
    usage.sort = null; // each mode has its own sensible default column
    onFiltersChanged();
  });
  const groupGroup = fgroup(groupSeg.box);

  const projectSel = /** @type {HTMLSelectElement} */ (h('select', 'cld-sel cld-sel-wide'));
  const projectGroup = fgroup(projectSel);
  const modelSel = /** @type {HTMLSelectElement} */ (h('select', 'cld-sel cld-sel-wide'));
  const modelGroup = fgroup(modelSel);
  projectSel.addEventListener('change', () => {
    usage.filters.project = projectSel.value;
    onFiltersChanged();
  });
  modelSel.addEventListener('change', () => {
    usage.filters.model = modelSel.value;
    onFiltersChanged();
  });

  filterBar.append(periodGroup.el, datesGroup.el, groupGroup.el, projectGroup.el, modelGroup.el);

  // ── stat tiles
  const usageStats = h('div', 'cld-stats-grid');
  viewUsage.append(usageStats);
  function usageTile() {
    const el = h('div', 'cld-card');
    const val = h('div', 'cld-stat-val', '—');
    const label = h('div', 'cld-stat-label');
    el.append(val, label);
    usageStats.append(el);
    return { val, label };
  }
  const uStatTotal = usageTile();
  const uStatOutput = usageTile();
  const uStatCost = usageTile();
  const uStatSessions = usageTile();
  const uStatMessages = usageTile();

  // ── chart
  const usageChartCard = card();
  const usageChart = h('div', 'cld-chart');
  const usageChartCap = h('div', 'cld-chart-cap');
  const usageCapFrom = h('span');
  const usageCapTo = h('span');
  usageChartCap.append(usageCapFrom, usageCapTo);
  usageChartCard.el.append(usageChart, usageChartCap);
  viewUsage.append(usageChartCard.el);

  // ── by model / by project
  // Same ranked-row widget the dashboard used to carry, but fed by the Usage
  // range and its filters — so "what is eating my tokens" is answerable for
  // any period, not just the last 30 days.
  const usageMpGrid = h('div', 'cld-mp-grid');
  const usageModelCard = card();
  const usageModelRows = h('div');
  usageModelCard.el.append(usageModelRows);
  const usageProjectCard = card();
  const usageProjectRows = h('div');
  usageProjectCard.el.append(usageProjectRows);
  const usageSessionCard = card();
  const usageSessionRows = h('div');
  usageSessionCard.el.append(usageSessionRows);
  usageMpGrid.append(usageModelCard.el, usageProjectCard.el, usageSessionCard.el);
  viewUsage.append(usageMpGrid);

  // ── table
  const usageTableCard = h('div', 'cld-card cld-usage');
  const usageTableHead = h('div', 'cld-sess-head');
  const usageTableTitle = h('div', 'cld-card-t');
  const usageTableSub = h('span', 'cld-card-s');
  usageTableHead.append(usageTableTitle, usageTableSub);
  const usageTbl = h('table', 'cld-tbl');
  const usageThead = h('thead');
  const usageHeadRow = h('tr');
  usageThead.append(usageHeadRow);
  const usageTbody = h('tbody');
  usageTbl.append(usageThead, usageTbody);
  const usageTblWrap = h('div', 'cld-tbl-wrap');
  usageTblWrap.append(usageTbl);
  const usageEmptyEl = h('div', 'cld-empty');
  const usageFoot = h('div', 'cld-table-foot');
  usageTableCard.append(usageTableHead, usageTblWrap, usageEmptyEl, usageFoot);
  viewUsage.append(usageTableCard);

  // ── column definitions
  // `get` is the sort key, `cell` the rendered text, `cls` an extra td class.
  const PERIOD_COLS = [
    { key: 'period', label: () => t.thPeriod, get: (r) => r.startMs, cell: (r) => fmtPeriod(r) },
    { key: 'input', num: true, label: () => t.thInput, get: (r) => r.tokens.input, cell: (r) => num(r.tokens.input, 0) },
    { key: 'output', num: true, label: () => t.thOutput, get: (r) => r.tokens.output, cell: (r) => num(r.tokens.output, 0) },
    { key: 'cacheCreate', num: true, label: () => t.thCacheW, get: (r) => r.tokens.cacheCreate, cell: (r) => num(r.tokens.cacheCreate, 0) },
    { key: 'cacheRead', num: true, label: () => t.thCacheR, get: (r) => r.tokens.cacheRead, cell: (r) => num(r.tokens.cacheRead, 0) },
    { key: 'total', num: true, cls: 'cld-num-total', label: () => t.thTotal, get: (r) => totalOf(r.tokens), cell: (r) => num(totalOf(r.tokens), 0) },
    { key: 'cost', num: true, cls: 'cld-num-cost', label: () => t.thCost, get: (r) => r.cost ?? 0, cell: (r) => fmtCost(r.cost) },
    { key: 'messages', num: true, label: () => t.thMessages, get: (r) => r.messages, cell: (r) => num(r.messages, 0) },
  ];

  const SESSION_COLS = [
    {
      key: 'session', label: () => t.thSessionId, get: (r) => r.sessionId || '',
      render: (td, r) => td.append(sessionIdCell(r)),
    },
    { key: 'project', label: () => t.thProject, get: (r) => r.project, cell: (r) => r.project, cls: 'cld-cell-ell', title: (r) => r.project },
    { key: 'start', label: () => t.thStart, get: (r) => r.startMs, cell: (r) => fmtStamp(r.startMs) },
    { key: 'end', label: () => t.thEnd, get: (r) => r.endMs, cell: (r) => fmtStamp(r.endMs) },
    { key: 'duration', num: true, label: () => t.thDuration, get: (r) => r.durationMs, cell: (r) => dur(r.durationMs / 1000) },
    { key: 'input', num: true, label: () => t.thInput, get: (r) => r.tokens.input, cell: (r) => num(r.tokens.input, 0) },
    { key: 'output', num: true, label: () => t.thOutput, get: (r) => r.tokens.output, cell: (r) => num(r.tokens.output, 0) },
    { key: 'cacheCreate', num: true, label: () => t.thCacheW, get: (r) => r.tokens.cacheCreate, cell: (r) => num(r.tokens.cacheCreate, 0) },
    { key: 'cacheRead', num: true, label: () => t.thCacheR, get: (r) => r.tokens.cacheRead, cell: (r) => num(r.tokens.cacheRead, 0) },
    { key: 'total', num: true, cls: 'cld-num-total', label: () => t.thTotal, get: (r) => totalOf(r.tokens), cell: (r) => num(totalOf(r.tokens), 0) },
    { key: 'cost', num: true, cls: 'cld-num-cost', label: () => t.thCost, get: (r) => r.cost ?? 0, cell: (r) => fmtCost(r.cost) },
    { key: 'models', label: () => t.thModels, get: (r) => r.models.join(','), cell: (r) => r.models.map(shortModel).join(', '), cls: 'cld-cell-ell', title: (r) => r.models.join(', ') },
  ];

  /**
   * Copy `text`, preferring the async clipboard API and falling back to a
   * throwaway <textarea> when the panel isn't served from a secure context.
   * @param {string} text @returns {Promise<boolean>}
   */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through to the legacy path */
    }
    try {
      const ta = /** @type {HTMLTextAreaElement} */ (h('textarea'));
      ta.value = text;
      ta.setAttribute('readonly', '');
      Object.assign(ta.style, { position: 'fixed', top: '-1000px', opacity: '0' });
      document.body.appendChild(ta);
      ta.select();
      const done = document.execCommand('copy');
      ta.remove();
      return done;
    } catch {
      return false;
    }
  }

  /**
   * The session id as a copy button plus a link to the host's /session/:id
   * route. Shared by the "Top sessions" card and the Breakdown table so the
   * two behave identically.
   *
   * The link is a plain <a>, not a router call: a plugin only ever gets
   * {context, onContextChange, rpc} — there is no navigation API — so an
   * unknown id fails exactly the way the host's own stale links already do.
   * @param {any} r a bySession row @returns {HTMLElement}
   */
  function sessionIdCell(r) {
    const cell = h('span', 'cld-sid-cell');
    const id = r.sessionId ? String(r.sessionId) : '';
    if (!id) {
      cell.append(h('span', 'cld-sid', '—'));
      return cell;
    }
    const btn = h('button', 'cld-sid-btn', shortId(id));
    btn.type = 'button';
    btn.title = `${id}\n${t.copyId}`;
    btn.setAttribute('aria-label', `${t.copyId}: ${id}`);
    /** @type {ReturnType<typeof setTimeout>|null} */
    let revert = null;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const done = await copyText(id);
      toast(done ? t.toastIdCopied : t.toastCopyFailed);
      if (!done) return;
      btn.classList.add('cld-copied');
      if (revert) clearTimeout(revert);
      revert = setTimeout(() => btn.classList.remove('cld-copied'), 1200);
    });
    const link = /** @type {HTMLAnchorElement} */ (h('a', 'cld-open'));
    link.href = `/session/${encodeURIComponent(id)}`;
    link.title = t.openSession;
    link.setAttribute('aria-label', t.openSession);
    link.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>';
    cell.append(btn, link);
    return cell;
  }

  /** Ranked "Top sessions" rows: id control, project, tokens, cost. */
  function renderSessionRanked(container, rows) {
    container.innerHTML = '';
    if (!rows || !rows.length) {
      container.append(h('div', 'cld-empty', t.noData));
      return;
    }
    for (const r of rows) {
      const row = h('div', 'cld-mp-row');
      const name = h('div', 'cld-mp-name', r.project);
      name.title = `${r.project} · ${fmtStamp(r.startMs)} · ${dur(r.durationMs / 1000)}`;
      row.append(sessionIdCell(r), name, h('div', 'cld-mp-tok', fmtTokens(totalOf(r.tokens))));
      row.append(h('div', 'cld-mp-cost', fmtCost(r.cost)));
      container.append(row);
    }
  }

  /** First segment of a session UUID — enough to tell rows apart. */
  function shortId(id) {
    return id ? String(id).split('-')[0] : '—';
  }
  /** "claude-sonnet-4-5" -> "sonnet-4-5"; the vendor prefix is noise here. */
  function shortModel(m) {
    return String(m).replace(/^claude-/, '');
  }
  /** "Aug 18, 14:05" */
  function fmtStamp(ms) {
    if (!Number.isFinite(ms)) return '—';
    try {
      return new Date(ms).toLocaleString(t.locale, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    }
  }
  /** Human label for one bucket of the current grouping. */
  function fmtPeriod(r) {
    const g = usage.filters.groupBy;
    if (g === 'day') return fmtChartDate(r.key);
    if (g === 'month') {
      try {
        return new Date(`${r.key}-15T12:00:00Z`).toLocaleDateString(t.locale, { month: 'long', year: 'numeric' });
      } catch {
        return r.key;
      }
    }
    // Weeks: the ISO key plus the Monday it starts on, which is what makes it
    // readable — "2026-W35" on its own says nothing about the calendar.
    return `${r.key} · ${fmtChartDate(isoDay(r.startMs))}`;
  }

  const usageThs = [];
  function rebuildHeader(cols) {
    usageHeadRow.innerHTML = '';
    usageThs.length = 0;
    const sort = effectiveSort(cols);
    for (const c of cols) {
      const th = h('th', `cld-sortable${c.num ? ' cld-num' : ''}${sort.col === c.key ? ' cld-sorted' : ''}`);
      th.textContent = c.label() + (sort.col === c.key ? (sort.dir < 0 ? ' ↓' : ' ↑') : '');
      th.addEventListener('click', () => {
        const cur = effectiveSort(cols);
        // Same column flips direction; a new column starts descending for
        // numbers (biggest consumer first) and ascending for text/time.
        usage.sort =
          cur.col === c.key
            ? { col: c.key, dir: /** @type {1|-1} */ (-cur.dir) }
            : { col: c.key, dir: /** @type {1|-1} */ (c.num ? -1 : 1) };
        renderUsage();
      });
      usageHeadRow.append(th);
      usageThs.push(th);
    }
  }

  /** The user's pick, or the mode default: sessions by total desc, periods by time asc. */
  function effectiveSort(cols) {
    if (usage.sort && cols.some((c) => c.key === usage.sort.col)) return usage.sort;
    return usage.filters.groupBy === 'session'
      ? { col: 'total', dir: /** @type {1|-1} */ (-1) }
      : { col: 'period', dir: /** @type {1|-1} */ (1) };
  }

  // ── query + load
  function usageQuery() {
    const f = usage.filters;
    const q = new URLSearchParams();
    q.set('groupBy', f.groupBy);
    const today = isoDay(Date.now());
    const back = (n) => isoDay(Date.now() - n * 86_400_000);
    if (f.preset === 'today') {
      q.set('since', today);
      q.set('until', today);
    } else if (f.preset === '7d') {
      q.set('since', back(6));
      q.set('until', today);
    } else if (f.preset === '30d') {
      q.set('since', back(29));
      q.set('until', today);
    } else if (f.preset === 'custom') {
      if (f.since) q.set('since', f.since);
      if (f.until) q.set('until', f.until);
    }
    // 'all' sends neither bound; the backend then starts at the oldest entry.
    if (f.project) q.set('project', f.project);
    if (f.model) q.set('model', f.model);
    return q.toString();
  }

  function onFiltersChanged() {
    writeUsageFilters();
    loadUsage();
  }

  async function loadUsage() {
    usage.loading = true;
    renderUsage();
    let data;
    try {
      data = await api.rpc('GET', `usage?${usageQuery()}`);
    } catch (e) {
      data = { error: errMsg(e) };
    }
    usage.data = data;
    usage.loading = false;
    usage.loaded = true;
    renderUsage();
  }

  /** Rebuild the two breakdown dropdowns from the range's facets. */
  function syncFacetSelect(sel, values, allLabel, current) {
    // Keep a filter the current range no longer contains, so switching periods
    // can't silently drop it.
    const opts = ['', ...values];
    if (current && !opts.includes(current)) opts.push(current);
    const want = opts.join(' ');
    if (sel.dataset.opts !== want) {
      sel.innerHTML = '';
      for (const v of opts) {
        const o = /** @type {HTMLOptionElement} */ (h('option'));
        o.value = v;
        o.textContent = v || allLabel;
        sel.append(o);
      }
      sel.dataset.opts = want;
    } else {
      sel.options[0].textContent = allLabel; // language switch
    }
    sel.value = current;
  }

  function renderUsage() {
    // Static bits first — they also have to follow a language switch.
    tabDashBtn.textContent = t.tabDashboard;
    tabUsageBtn.textContent = t.tabUsage;
    periodGroup.label.textContent = t.fPeriod;
    datesGroup.label.textContent = t.fRange;
    groupGroup.label.textContent = t.fGroup;
    projectGroup.label.textContent = t.fProject;
    modelGroup.label.textContent = t.fModel;
    dateSep.textContent = t.dateSep;
    periodSeg.relabel((v) =>
      v === 'today' ? t.periodToday : v === '7d' ? t.period7d : v === '30d' ? t.period30d : v === 'all' ? t.periodAll : t.periodCustom,
    );
    groupSeg.relabel((v) =>
      v === 'day' ? t.groupDay : v === 'week' ? t.groupWeek : v === 'month' ? t.groupMonth : t.groupSession,
    );
    periodSeg.select(usage.filters.preset);
    groupSeg.select(usage.filters.groupBy);
    sinceInput.value = usage.filters.since;
    untilInput.value = usage.filters.until;
    // Dimmed rather than hidden: the inputs stay clickable, and touching one
    // is itself the way to switch to the custom preset.
    datesGroup.el.style.opacity = usage.filters.preset === 'custom' ? '1' : '0.55';
    uStatTotal.label.textContent = t.statTotal;
    uStatOutput.label.textContent = t.statOutput;
    uStatCost.label.textContent = t.statCost;
    uStatSessions.label.textContent = t.statSessions;
    uStatMessages.label.textContent = t.statMessages;
    usageChartCard.title.textContent = t.usageChart;
    usageModelCard.title.textContent = t.byModel;
    usageProjectCard.title.textContent = t.byProject;
    usageSessionCard.title.textContent = t.bySession;
    usageTableTitle.textContent = t.usageTable;

    const d = usage.data;
    const ok = d && !d.error && d.totals && Array.isArray(d.periods);
    if (!ok) {
      for (const tile of [uStatTotal, uStatOutput, uStatCost, uStatSessions, uStatMessages]) {
        tile.val.textContent = '—';
      }
      renderRankedRows(usageModelRows, null, (r) => r.model);
      renderRankedRows(usageProjectRows, null, (r) => r.project);
      renderSessionRanked(usageSessionRows, null);
      usageChartCard.el.style.display = 'none';
      usageTblWrap.style.display = 'none';
      usageFoot.textContent = '';
      usageEmptyEl.style.display = '';
      usageEmptyEl.textContent = usage.loading
        ? t.usageLoading
        : d && d.error
          ? `${t.usageError} — ${d.error}`
          : t.usageEmpty;
      usageChartCard.sub.textContent = '';
      usageTableSub.textContent = '';
      return;
    }

    syncFacetSelect(projectSel, (d.facets && d.facets.projects) || [], t.allProjects, usage.filters.project);
    syncFacetSelect(modelSel, (d.facets && d.facets.models) || [], t.allModels, usage.filters.model);

    uStatTotal.val.textContent = fmtTokens(totalOf(d.totals.tokens));
    uStatOutput.val.textContent = fmtTokens(d.totals.tokens.output);
    uStatCost.val.textContent = fmtCost(d.totals.cost);
    uStatSessions.val.textContent = num(d.totals.sessions, 0);
    uStatMessages.val.textContent = num(d.totals.messages, 0);

    renderRankedRows(usageModelRows, d.byModel, (r) => r.model);
    renderRankedRows(usageProjectRows, (d.byProject || []).slice(0, 10), (r) => r.project);
    // bySession already comes back sorted by total tokens, descending — this
    // card is just its head, for "which sessions ate the period".
    renderSessionRanked(usageSessionRows, (d.bySession || []).slice(0, 10));

    const rangeText = t.usageRange(isoDay(d.range.sinceMs), isoDay(d.range.untilMs - 1));
    usageChartCard.sub.textContent = rangeText;

    // Chart: the grouped series. Hidden for session grouping — sessions have
    // no shared time axis to lay bars out on.
    const bySession = usage.filters.groupBy === 'session';
    const periods = d.periods || [];
    if (bySession || !periods.length || d.totals.messages === 0) {
      usageChartCard.el.style.display = 'none';
    } else {
      usageChartCard.el.style.display = '';
      usageChart.innerHTML = '';
      const max = Math.max(1, ...periods.map((p) => totalOf(p.tokens)));
      periods.forEach((p, i) => {
        const el = h('div', 'cld-bar');
        const bar = h('i');
        el.append(bar);
        const tok = totalOf(p.tokens);
        bar.style.height = `${tok > 0 ? Math.max(Math.round((tok / max) * 100), 3) : 0}%`;
        bar.style.opacity = String(0.45 + 0.55 * (i / periods.length));
        el.dataset.tipDate = fmtPeriod(p);
        el.dataset.tipTok = tok.toLocaleString(t.locale);
        el.dataset.tipCost = fmtCost(p.cost);
        el.addEventListener('mouseenter', (ev) => showChartTip(ev, el));
        el.addEventListener('mousemove', (ev) => positionChartTip(ev, el));
        el.addEventListener('mouseleave', hideChartTip);
        usageChart.append(el);
      });
      usageCapFrom.textContent = periods[0].key;
      usageCapTo.textContent = periods[periods.length - 1].key;
    }

    // Table. Empty buckets are dropped here (they are still drawn in the
    // chart, where the gap is the point).
    const cols = bySession ? SESSION_COLS : PERIOD_COLS;
    const rows = bySession ? (d.bySession || []).slice() : periods.filter((p) => p.messages > 0);
    const sort = effectiveSort(cols);
    const col = cols.find((c) => c.key === sort.col) || cols[0];
    rows.sort((a, b) => {
      const va = col.get(a);
      const vb = col.get(b);
      const cmp = typeof va === 'string' ? String(va).localeCompare(String(vb), t.locale) : va - vb;
      return cmp * sort.dir;
    });

    rebuildHeader(cols);
    usageTbody.innerHTML = '';
    const shown = rows.slice(0, MAX_TABLE_ROWS);
    for (const r of shown) {
      const tr = h('tr');
      for (const c of cols) {
        const cls = [c.num ? 'cld-num' : null, c.cls || null].filter(Boolean).join(' ');
        const td = h('td', cls || undefined, c.render ? undefined : c.cell(r));
        if (c.render) c.render(td, r);
        if (c.title) td.title = c.title(r);
        tr.append(td);
      }
      usageTbody.append(tr);
    }
    usageTblWrap.style.display = rows.length ? '' : 'none';
    usageEmptyEl.style.display = rows.length ? 'none' : '';
    usageEmptyEl.textContent = t.usageEmpty;
    usageTableSub.textContent = rangeText;
    usageFoot.textContent = rows.length ? t.showingRows(shown.length, rows.length) : '';
  }

  // ── tab switching
  let activeTab = 'dashboard';
  function selectTab(name) {
    activeTab = name === 'usage' ? 'usage' : 'dashboard';
    viewDash.style.display = activeTab === 'dashboard' ? '' : 'none';
    viewUsage.style.display = activeTab === 'usage' ? '' : 'none';
    tabDashBtn.setAttribute('aria-selected', String(activeTab === 'dashboard'));
    tabUsageBtn.setAttribute('aria-selected', String(activeTab === 'usage'));
    // The Usage query can span all of history, unlike the dashboard's fixed
    // 30 days — so it only ever runs for a tab someone is looking at.
    if (activeTab === 'usage' && !usage.loaded && !usage.loading) loadUsage();
  }
  tabDashBtn.addEventListener('click', () => selectTab('dashboard'));
  tabUsageBtn.addEventListener('click', () => selectTab('usage'));

  // ── state
  const state = { limits: null, history: null, sessions: [] };
  let loading = true;
  /** @type {ReturnType<typeof setInterval>|null} */
  let dataTimer = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let tickTimer = null;

  function readRefreshMs() {
    try {
      const stored = localStorage.getItem(LS_REFRESH_KEY);
      if (stored == null || stored === '') return DEFAULT_REFRESH_MS;
      const v = Number(stored);
      if (Number.isFinite(v) && REFRESH_OPTIONS.includes(v)) return v;
    } catch {
      /* storage unavailable */
    }
    return DEFAULT_REFRESH_MS;
  }
  function writeRefreshMs(ms) {
    try {
      localStorage.setItem(LS_REFRESH_KEY, String(ms));
    } catch {
      /* non-fatal */
    }
  }
  let refreshMs = readRefreshMs();
  rateSel.value = String(refreshMs);

  function applyStaticText() {
    titleText.textContent = t.title;
    intervalSpan.textContent = t.interval;
    Array.from(rateSel.options).forEach((opt, i) => {
      opt.textContent = t.intervalOption(REFRESH_OPTIONS[i]);
    });
    refreshBtn.title = t.refresh;
    refreshBtn.setAttribute('aria-label', t.refresh);
    histCard.title.textContent = t.histTitle;
    histEmpty.textContent = t.histEmpty;
    sessTitle.textContent = t.sessionsTitle;
    cleanupBtn.textContent = cleanupBtn.dataset.busy === '1' ? t.cleaningUp : t.cleanup;
    sessThs[0].textContent = t.thSession;
    sessThs[1].textContent = t.thStatus;
    sessThs[2].textContent = t.thModel;
    sessThs[3].textContent = t.thUptime;
    sessThs[4].textContent = t.thCpu;
    sessThs[5].textContent = t.thMem;
    sessThs[6].textContent = t.thActions;
    sessEmpty.textContent = t.sessNone;
    // The Usage view has no separate static pass — its labels are all set at
    // the top of renderUsage(), which is idempotent and cheap when idle.
    renderUsage();
  }

  function applyTheme() {
    root.dataset.theme = api.context.theme === 'dark' ? 'dark' : 'light';
  }

  // ── limits render
  function limitKey(kind, label) {
    return `${kind}:${label}`;
  }

  function renderLimits() {
    const r = state.limits;
    if (!r) return;
    if (!r.ok || !r.data) {
      limitsGrid.style.display = 'none';
      limitsErrBox.style.display = '';
      limitsErrBox.textContent = `${t.limitsError}${r.error ? ` — ${r.error}` : ''}`;
      return;
    }
    limitsGrid.style.display = '';
    limitsErrBox.style.display = 'none';

    const d = r.data;
    plan.textContent = d.plan || '';

    /** @type {{key:string, label:string, meterObj:any}[]} */
    const entries = [];
    if (d.session) entries.push({ key: limitKey('session', 'session'), label: t.limitSession, meterObj: d.session });
    if (d.daily) entries.push({ key: limitKey('daily', 'daily'), label: t.limitDaily, meterObj: d.daily });
    const visibleWeekly = (d.weekly || []).filter((m) => m.label === 'All models' || (m.usedPct != null && m.usedPct > 0));
    for (const m of visibleWeekly) {
      const label = m.label === 'All models' ? t.limitAllModels : m.label;
      entries.push({ key: limitKey('weekly', m.label), label, meterObj: m });
    }

    const seen = new Set();
    for (const entry of entries) {
      seen.add(entry.key);
      let c = limitEls.get(entry.key);
      if (!c) {
        c = /** @type {any} */ (limitCard());
        limitEls.set(entry.key, c);
        limitsGrid.append(c.el);
      }
      c.title.textContent = entry.label;
      const m = entry.meterObj;
      const pctVal = m.usedPct == null ? null : Math.max(0, Math.min(100, m.usedPct));
      c.countdownSub.textContent = t.remaining(pctVal == null ? null : Math.round(100 - pctVal));
      const sev = severity(pctVal, T_LIMIT);
      c.meter.set(pctVal, sev.color);
      c.resetsAtMs = m.resetsAtMs;
      const valueText = m.valueText ? m.valueText : t.used(pctVal == null ? '—' : Math.round(pctVal));
      c.footLeft.textContent = m.resetsAtMs != null ? t.resetsAt(fmtResetsAt(m.resetsAtMs)) : '';
      c.footRight.textContent = valueText + (m.estimated ? t.estimated : '');
      c.footRight.className = sev.level === 'crit' ? 'cld-crit' : sev.level === 'warn' ? 'cld-warn' : '';
      c.countdown.textContent = fmtCountdown(m.resetsAtMs != null ? m.resetsAtMs - Date.now() : null);
    }
    for (const [key, c] of limitEls) {
      if (!seen.has(key)) {
        c.el.remove();
        limitEls.delete(key);
      }
    }
  }

  function tickCountdowns() {
    for (const c of limitEls.values()) {
      c.countdown.textContent =
        c.resetsAtMs != null && c.resetsAtMs - Date.now() <= 0 ? t.resetsNow : fmtCountdown(c.resetsAtMs != null ? c.resetsAtMs - Date.now() : null);
    }
  }

  // ── histogram render (the dashboard's only /history consumer)
  function renderHistory() {
    const hRaw = state.history;
    const ok = hRaw && Array.isArray(hRaw.daily) && hRaw.totals;
    if (!ok) {
      chart.style.display = 'none';
      chartCap.style.display = 'none';
      histEmpty.style.display = '';
      histEmpty.textContent = hRaw && hRaw.error ? `${t.historyError} — ${hRaw.error}` : t.histEmpty;
      return;
    }

    const totals = hRaw.totals;
    const daily = hRaw.daily;
    if (!daily.length || totals.messages === 0) {
      chart.style.display = 'none';
      chartCap.style.display = 'none';
      histEmpty.style.display = '';
      histEmpty.textContent = t.histEmpty;
    } else {
      chart.style.display = '';
      chartCap.style.display = '';
      histEmpty.style.display = 'none';
      if (histBars.length !== daily.length) {
        chart.innerHTML = '';
        histBars = daily.map(() => {
          const el = h('div', 'cld-bar');
          const bar = h('i');
          el.append(bar);
          el.addEventListener('mouseenter', (ev) => showChartTip(ev, el));
          el.addEventListener('mousemove', (ev) => positionChartTip(ev, el));
          el.addEventListener('mouseleave', hideChartTip);
          chart.append(el);
          return { el, bar };
        });
      }
      const max = Math.max(1, ...daily.map((d) => totalOf(d.tokens)));
      daily.forEach((d, i) => {
        const tok = totalOf(d.tokens);
        const hPct = Math.round((tok / max) * 100);
        const { bar, el } = histBars[i];
        bar.style.height = `${tok > 0 ? Math.max(hPct, 3) : 0}%`;
        bar.style.opacity = String(0.45 + 0.55 * (i / daily.length));
        el.dataset.tipDate = fmtChartDate(d.date);
        el.dataset.tipTok = tok.toLocaleString(t.locale);
        el.dataset.tipCost = fmtCost(d.cost);
      });
      chartCapFrom.textContent = daily[0]?.date ?? '';
      chartCapTo.textContent = daily[daily.length - 1]?.date ?? '';
    }
  }

  /** @param {HTMLElement} container @param {any[]|null} rows @param {(r:any)=>string} nameOf */
  function renderRankedRows(container, rows, nameOf) {
    container.innerHTML = '';
    if (!rows || !rows.length) {
      container.append(h('div', 'cld-empty', t.noData));
      return;
    }
    for (const r of rows) {
      const row = h('div', 'cld-mp-row');
      const name = h('div', 'cld-mp-name', nameOf(r));
      name.title = nameOf(r);
      const tok = h('div', 'cld-mp-tok', fmtTokens(totalOf(r.tokens)));
      const cost = h('div', 'cld-mp-cost', fmtCost(r.cost));
      row.append(name, tok, cost);
      container.append(row);
    }
  }

  // ── sessions render
  function sessionKey(s) {
    return s.pid != null ? `pid:${s.pid}` : `sid:${s.sessionId || s.name}`;
  }

  function buildSessionRow() {
    const tr = h('tr');
    const nameTd = h('td');
    const nameEl = h('div', 'cld-sess-name');
    const subEl = h('div', 'cld-sess-sub');
    nameTd.append(nameEl, subEl);
    const statusTd = h('td');
    const badge = h('span', 'cld-badge');
    const dot = h('i', 'cld-dot');
    const badgeLabel = h('span');
    badge.append(dot, badgeLabel);
    statusTd.append(badge);
    const modelTd = h('td');
    const uptimeTd = h('td');
    const cpuTd = h('td');
    const memTd = h('td');
    const actionsTd = h('td');
    const actions = h('div', 'cld-actions');
    const killBtn = h('button', 'cld-btn cld-btn-sm cld-btn-danger', t.kill);
    killBtn.dataset.state = 'idle';
    const resumeBtn = h('button', 'cld-btn cld-btn-sm cld-btn-ok', t.resume);
    actions.append(killBtn, resumeBtn);
    actionsTd.append(actions);
    tr.append(nameTd, statusTd, modelTd, uptimeTd, cpuTd, memTd, actionsTd);
    sessBody.append(tr);
    return { tr, nameEl, subEl, badge, dot, badgeLabel, modelTd, uptimeTd, cpuTd, memTd, killBtn, resumeBtn, session: null };
  }

  function revertKillBtn(entry) {
    if (entry.killTimer) {
      clearTimeout(entry.killTimer);
      entry.killTimer = null;
    }
    entry.killBtn.dataset.state = 'idle';
    entry.killBtn.textContent = t.kill;
    entry.killBtn.classList.remove('cld-armed');
    if (pendingKillEntry === entry) pendingKillEntry = null;
  }

  /** @type {any} */
  let pendingKillEntry = null;

  function armKill(entry) {
    if (pendingKillEntry && pendingKillEntry !== entry) revertKillBtn(pendingKillEntry);
    pendingKillEntry = entry;
    entry.killBtn.dataset.state = 'confirm';
    entry.killBtn.textContent = t.killConfirm;
    entry.killBtn.classList.add('cld-armed');
    entry.killTimer = setTimeout(() => revertKillBtn(entry), KILL_CONFIRM_MS);
  }

  async function doKill(pid) {
    try {
      const r = await api.rpc('POST', `sessions/${pid}/kill`);
      if (r && r.ok) toast(t.toastKillSent(pid));
      else toast(t.toastKillFailed((r && r.error) || 'unknown error'));
    } catch (e) {
      toast(t.toastKillFailed(errMsg(e)));
    }
    setTimeout(() => load(false), 1500);
  }

  async function doResume(session) {
    if (!session.sessionId || !session.cwd) return;
    try {
      const r = await api.rpc('POST', 'sessions/resume', { sessionId: session.sessionId, cwd: session.cwd });
      if (r && r.ok) toast(t.toastResumeSent(r.pid));
      else toast(t.toastResumeFailed((r && r.error) || 'unknown error'));
    } catch (e) {
      toast(t.toastResumeFailed(errMsg(e)));
    }
    setTimeout(() => load(false), 1500);
  }

  function renderSessions() {
    const sessions = Array.isArray(state.sessions) ? state.sessions : [];
    sessSub.textContent = sessions.length ? t.sessTotal(sessions.length) : '';
    sessTblWrap.style.display = sessions.length ? '' : 'none';
    sessEmpty.style.display = sessions.length ? 'none' : '';
    sessEmpty.textContent = t.sessNone;

    const seen = new Set();
    for (const s of sessions) {
      const key = sessionKey(s);
      seen.add(key);
      let entry = sessRowEls.get(key);
      if (!entry) {
        entry = buildSessionRow();
        sessRowEls.set(key, entry);
        entry.killBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const pid = entry.session && entry.session.pid;
          if (pid == null) return;
          if (entry.killBtn.dataset.state === 'confirm') {
            revertKillBtn(entry);
            doKill(pid);
          } else {
            armKill(entry);
          }
        });
        entry.resumeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (entry.session) doResume(entry.session);
        });
      }
      entry.session = s;
      entry.nameEl.textContent = s.name || (s.cwd ? s.cwd.split('/').pop() : `pid ${s.pid}`);
      entry.nameEl.title = s.cwd || '';
      const metaBits = [s.cwd, s.resumed ? t.stResumed : null].filter(Boolean);
      entry.subEl.textContent = metaBits.join(' · ');
      entry.subEl.title = s.cwd || '';

      const info = statusInfo(s);
      entry.badge.style.setProperty('--tone', info.tone);
      entry.badgeLabel.textContent = info.label;

      entry.modelTd.textContent = s.model || '—';
      entry.uptimeTd.textContent = s.detached ? t.stNoProc : dur(s.uptimeSec ?? NaN);
      entry.cpuTd.textContent = s.cpuPct == null ? '—' : pct(s.cpuPct, 1);
      entry.memTd.textContent = s.rss == null ? '—' : bytes(s.rss);

      entry.killBtn.style.display = s.pid != null ? '' : 'none';
      const resumable = Boolean(s.detached && s.sessionId && s.cwd);
      entry.resumeBtn.style.display = resumable ? '' : 'none';
    }
    for (const [key, entry] of sessRowEls) {
      if (!seen.has(key)) {
        if (pendingKillEntry === entry) pendingKillEntry = null;
        entry.tr.remove();
        sessRowEls.delete(key);
      }
    }
  }

  // ── top-level render
  function render() {
    applyTheme();
    stamp.textContent = loading && !state.limits ? '' : state.limits && state.limits.ok && state.limits.data ? t.lastUpdated(ago(state.limits.data.fetchedAt)) + (state.limits.source === 'cache' ? t.cached : '') : '';
    renderLimits();
    renderHistory();
    renderSessions();
    if (activeTab === 'usage') renderUsage();
  }

  // ── loading
  async function load(force) {
    if (force) loading = true;
    const current = resolveLang();
    if (current !== lang) {
      lang = current;
      t = STRINGS[lang];
      applyStaticText();
    }
    const [limitsR, historyR, sessionsR] = await Promise.all([
      api.rpc('GET', `limits${force ? '?force=1' : ''}`).catch((e) => ({ ok: false, error: errMsg(e) })),
      api.rpc('GET', 'history?days=30').catch((e) => ({ error: errMsg(e) })),
      api.rpc('GET', 'sessions').catch((e) => ({ ok: false, error: errMsg(e) })),
    ]);
    state.limits = limitsR;
    state.history = historyR;
    state.sessions = sessionsR && sessionsR.ok && Array.isArray(sessionsR.sessions) ? sessionsR.sessions : [];
    loading = false;
    render();
    // The Usage view has its own query; keep it in step with the poll, but
    // only once it has been opened at least once.
    if (activeTab === 'usage' && usage.loaded && !usage.loading) loadUsage();
  }

  function armDataTimer() {
    if (dataTimer) {
      clearInterval(dataTimer);
      dataTimer = null;
    }
    if (refreshMs > 0) dataTimer = setInterval(() => load(false), refreshMs);
  }

  rateSel.addEventListener('change', () => {
    const ms = Number(rateSel.value);
    if (!Number.isFinite(ms)) return;
    refreshMs = ms;
    writeRefreshMs(ms);
    armDataTimer();
    if (ms) load(true);
  });
  refreshBtn.addEventListener('click', () => load(true));

  cleanupBtn.addEventListener('click', async () => {
    cleanupBtn.disabled = true;
    cleanupBtn.dataset.busy = '1';
    cleanupBtn.textContent = t.cleaningUp;
    try {
      const r = await api.rpc('POST', 'sessions/cleanup');
      if (r && r.ok) toast(t.toastCleanupDone(r.deletedSessions || 0, r.compressedLogs || 0));
      else toast(t.toastCleanupFailed((r && r.error) || 'unknown error'));
    } catch (e) {
      toast(t.toastCleanupFailed(errMsg(e)));
    }
    cleanupBtn.disabled = false;
    delete cleanupBtn.dataset.busy;
    cleanupBtn.textContent = t.cleanup;
    load(false);
  });

  // Clicking anywhere outside an armed kill button disarms it. The button's
  // own click handler stops propagation, so this only ever fires for a
  // genuine "clicked elsewhere" — including the first arming click never
  // reaching here.
  function outsideClick(e) {
    if (pendingKillEntry && e.target !== pendingKillEntry.killBtn) revertKillBtn(pendingKillEntry);
  }
  document.addEventListener('click', outsideClick);

  applyTheme();
  applyStaticText();
  selectTab('dashboard');
  render();
  load(true);
  armDataTimer();

  tickTimer = setInterval(tickCountdowns, 1000);

  const unsub = api.onContextChange(() => render());

  /** @type {any} */ (container)._cldCleanup = () => {
    if (dataTimer) clearInterval(dataTimer);
    if (tickTimer) clearInterval(tickTimer);
    document.removeEventListener('click', outsideClick);
    chartTip.remove();
    unsub();
  };
}

/** @param {HTMLElement} container */
export function unmount(container) {
  const cleanup = /** @type {any} */ (container)._cldCleanup;
  if (typeof cleanup === 'function') cleanup();
  delete (/** @type {any} */ (container)._cldCleanup);
  container.innerHTML = '';
}
