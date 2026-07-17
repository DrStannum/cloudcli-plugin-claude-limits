/**
 * CloudCLI Plugin API type definitions (from the official starter) plus the
 * shapes this plugin passes over RPC. Kept as a .d.ts so the hand-written
 * `dist/*.js` files get editor intellisense via `// @ts-check` + JSDoc.
 */

/** Current application context provided to the plugin frontend. */
export interface PluginContext {
  theme: 'dark' | 'light';
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
}

/** The API object received in mount(container, api). */
export interface PluginAPI {
  readonly context: PluginContext;
  onContextChange(callback: (ctx: PluginContext) => void): () => void;
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
}

/** A single meter row (session, daily budget, or one weekly bucket). */
export interface Meter {
  /** e.g. "Current session", "All models", "Fable", "Today's budget". */
  label: string;
  /** 0..100, or null when unknown. For the daily row this is the budget-used bar %. */
  usedPct: number | null;
  /** Reset time as epoch milliseconds, or null. */
  resetsAtMs: number | null;
  /** "session"/"daily" → relative "Resets in Xh Ym"; "weekly" → absolute day+time. */
  kind: 'session' | 'weekly' | 'daily';
  /** Overrides the default "N% used" right-hand text. */
  valueText?: string;
  /** Mark the value as an estimate (statusline cold-start "~"). */
  estimated?: boolean;
}

/** The daily rolling-budget row (mirrors the statusline "24" segment). */
export interface DailyMeter extends Meter {
  kind: 'daily';
  /** Weekly-% consumed today so far. */
  todayUsed: number;
  /** Weekly-% budgeted for today. */
  todayBudget: number;
  /** todayUsed - todayBudget (>0 = over budget). */
  deltaPct: number;
}

/** Normalized limits payload returned by the backend. */
export interface Limits {
  plan: string | null;
  session: Meter | null;
  /** Rolling daily budget, shown between session and weekly. */
  daily?: DailyMeter | null;
  weekly: Meter[];
  /** Hostname of the server running the backend; shown in the TUI header. */
  host?: string | null;
  fetchedAt: number;
}

/** Envelope returned by GET /limits. */
export interface LimitsResponse {
  ok: boolean;
  data?: Limits;
  /** Raw upstream JSON, for the debug view / adjusting the normalizer. */
  raw?: unknown;
  /** Upstream HTTP status when the fetch reached the API. */
  status?: number;
  /** Machine-readable failure reason. */
  code?: 'no_credentials' | 'no_token' | 'unauthorized' | 'http_error' | 'network' | 'parse';
  error?: string;
  /** Where the data came from. */
  source: 'live' | 'cache';
  endpoint: string;
}
