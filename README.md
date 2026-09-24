# Claude — CloudCLI UI plugin

Adds a **Claude** tab: a single full-width dashboard combining plan usage
limits, 30-day token/cost history, and active-session management — what used
to be three separate plugins (Claude Limits, Claude Usage, Session Manager) —
plus a **Usage** view for asking "what is eating my tokens?" across arbitrary
date ranges, groupings, projects and sessions.

![what it looks like](preview.html)

> Open `preview.html` in a browser for a static look with sample data
> (`node tests/preview.mjs` regenerates it and takes Playwright screenshots).

## What's on the tab

The tab has two sub-views, switched from the header (a CloudCLI plugin gets
exactly one top-level tab slot, so the second view lives inside the first).

### Dashboard (the default view)

Deliberately short — three blocks, all "what is happening right now":

1. **Plan usage limits** — one card per meter (current 5-hour session,
   today's rolling budget, weekly "All models", and any per-model weekly
   bucket that's actually been used). Each card shows a live `H:MM:SS`
   countdown to reset (ticking every second, independent of the data poll)
   plus a CSS progress bar colored by how close to the limit it is.
2. **Daily tokens (30 days)** — a bar chart, bar height proportional to that
   day's token total.
3. **Active sessions** — every Claude CLI session currently running or
   recently open on this host, with **Kill**, **Resume** (detached sessions
   only), and a **Cleanup** action (deletes orphaned session records, gzips
   transcripts untouched for 30+ days).

Totals, "By model" and "By project" used to live here over a hardcoded
30-day window; as of 2.1 they are on the Usage view — joined by "Top
sessions" — where they answer to its period and filters instead.

### Killing a session

The **Kill** button requires a second click to confirm: the first click
turns it into "Confirm?" for a few seconds (or until you click elsewhere,
which cancels it); the second click actually sends `SIGTERM` (escalating to
`SIGKILL` after 2s if the process is still alive). A toast confirms the
result.

### Usage

A second view for spend analysis, modelled on `ccusage`'s
`daily` / `weekly` / `monthly` / `session` reports:

- **Period** — Today / 7d (the default) / 30d / All time, or a custom
  `since`–`until` range from two date pickers. All bucketing is UTC.
- **Group by** — Day / Week / Month / Session. Weeks are ISO-8601 (Monday
  start, week 1 is the one containing the first Thursday), months are
  calendar months. The bar chart and the table both follow the grouping;
  session grouping has no time axis, so it drops the chart.
- **Project** / **Model** — drill into one project or one model and every
  number on the view, chart included, narrows to it. The dropdowns are built
  from what the *unfiltered* range contains, so a filter can always be
  cleared again.
- **Totals** — total tokens, output tokens, estimated cost, sessions and
  messages for the selected range and filters.
- **By model / by project / top sessions** — ranked breakdowns of the same
  range; the quickest read on where the spend went. "Top sessions" lists the
  ten transcripts that burned the most tokens in the period.
- **The session id is a control** — in the "Top sessions" card and in the
  table, the shortened id is a button that copies the **full** id to the
  clipboard, and the `↗` next to it links to the panel's own
  `/session/<id>` route, which opens that conversation. (A plugin only
  receives `{context, onContextChange, rpc}` — there is no navigation API —
  so this is a plain `<a href>`, the same one CloudCLI's own recent-
  conversation list uses. Copying falls back to a hidden `<textarea>` when
  the panel isn't served from a secure context.)
- **The table** — input / output / cache-create / cache-read / total tokens,
  cost, and message count per bucket; in session mode also the (shortened)
  session id, project, start, end, duration, and models used. Every column
  sorts — click once for the biggest consumer first, again to flip. Sessions
  default to total-tokens descending, periods to chronological.

The chosen period and grouping persist in `localStorage` under
`cloudcli-claude-limits:usageFilters`. The Usage query only runs for a tab
someone is actually looking at — opening the plugin costs nothing extra.

### Theme, language, refresh

Both light/dark theme (follows the host panel) and English/Russian
(`localStorage.userLanguage`, re-read on every poll — there's no change
event) are supported. The container is intentionally full-width, not capped
like a narrow sidebar panel.

The interval dropdown (top-right, next to Refresh; tooltip *Refresh every*)
sets the data-poll interval — 10s / 30s / 1m / 3m / 5m / Off, defaulting to **3m**, persisted in `localStorage` under
`cloudcli-claude-limits:refreshMs` (same key the pre-2.0 tab used). The
limits reading is never older than the interval, with a 3-minute floor: the
shorter settings refresh the sessions table that often, but the rate-limited
usage endpoint is asked at most once every 3 minutes. The countdown timers
tick on their own 1-second timer and don't trigger a re-fetch.

## How it works

```
┌ dist/server.js (Node subprocess, has HOME) ───────────────────────────────┐
│  GET  /limits            → dist/server.js + dist/daily.js  (unchanged math) │
│  GET  /history?days=30   → dist/history.js + dist/pricing.js               │
│  GET  /usage?since=…&groupBy=…  → same aggregate(), arbitrary window       │
│  GET  /sessions          → dist/sessions.js (readClaudeSessions)           │
│  GET  /sessions/:pid/context → dist/sessionActions.js                      │
│  POST /sessions/:pid/kill    → dist/sessionActions.js                      │
│  POST /sessions/resume       → dist/sessionActions.js                      │
│  POST /sessions/cleanup      → dist/sessionActions.js                      │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │ api.rpc('GET'/'POST', ...)
┌ dist/index.js (tab frontend) ──────────────────────────────────────────────┐
│  DOM built once in mount(); render(state) updates it in place.             │
│  Data poll (selectable interval) + a separate 1s countdown-only tick.      │
│  Two sub-views: Dashboard (polled) and Usage (its own filtered query).     │
└──────────────────────────────────────────────────────────────────────────┘
```

### Plan usage limits (`GET /limits`)

Unchanged from the pre-2.0 plugin. The backend reads
`~/.claude/.credentials.json` for the OAuth access token, calls
`https://api.anthropic.com/api/oauth/usage`, normalizes the response
(`normalize()` in `dist/server.js`), and derives "today's budget"
(`dist/daily.js`) from its own snapshot log at
`~/.claude/cloudcli-claude-limits-history.json` (see that file's header
comment for the math: a plain 1/7 a day, with unspent allowance
carrying forward whole rather than being spread over the days still to
come).

The "Today's budget" card captions that band rather than a bare ratio:
`28% → 42%` means the weekly counter stood at 28% when today's period
opened (periods are anchored to the weekly reset, not to local midnight)
and may reach 42% — `(N+1)/7` on day N — before it closes. The bar fills
that stretch: how far today's spend has travelled from the left number
towards the right one. A leading `~` marks a day whose starting reading
was reconstructed rather than measured; the tooltip says so.

Because unspent allowance carries forward, today's budget is often not one
plain day — and then the bar breaks into one division per 24h period it
covers, each with an instant-hover tooltip:

* **Days carried in.** Every earlier day that wasn't spent out adds a green
  division *before* today's own share — oldest first, so the row still fills
  left to right. Green is the allowance still standing; today's spend covers
  it from the left, oldest money first, and today's own 1/7 share is the
  last division, still empty for as long as a carried day is left (a day
  left 60% unspent is still an unspent day, so it gets its own division,
  green over 60% of its width). The legend reads e.g. `+2d` · `+17%` ·
  `0%`: two days carried in, 17 weekly points of them still standing, and
  today's own share untouched. A carried day spent out drops off the row and
  out of the budget the card measures (its `remaining` included) — once the
  last one goes, the card is back to a plain bar over today's own share.
* **Tomorrow borrowed against.** Past the whole budget the overrun comes out
  of tomorrow's share, which joins the row as a last division showing how
  much of it is already gone, and the caption band gains the next period's
  ceiling (`61% → 71% → 85%`). No such division on the cycle's last day —
  its ceiling is already 100% and the weekly reset follows.

Cached an hour — the numbers move slowly and a dashboard left open all day
should not poll the endpoint every few seconds (the API rate-limits). Every
live reading, forced or not, replaces the cache in memory and on disk. One
exception keeps the daily meter honest: today's budget is measured against
the weekly % at the start of the current 24h period, and that reading only
happens on a live fetch, so a call is let through whenever a new period has
opened since the last one — at most one extra request a day.
The auto-refresh poll sends its interval as `GET /limits?maxAge=<ms>`, which
narrows that hour to the interval (never below 3 minutes, `MIN_LIVE_INTERVAL_MS`)
— without it the poll only re-read the cache and "Refresh every 5m" sat at
"updated 55 min ago". With auto-refresh Off the hour applies.
The Refresh button sends `GET /limits?force=1`, which skips the cache; the
header stamp shows the data's real age, plus a quiet `Cached at 13:59` when
the answer came from there (its tooltip names the upstream error, if any).
`daily.js`'s `GRACE_SEC` is kept above this TTL, since snapshots are only
taken on a live fetch. It never rotates the refresh token.

The cache is what the dashboard falls back on whenever a live attempt fails:
a 429 (or an expired token, or an unreachable endpoint) serves the last good
reading with `source: 'cache'` and a `staleError`, instead of replacing every
card with an error box — that only happens when there is nothing cached at
all. Failures are followed by a one-minute backoff, since hammering a
rate-limited endpoint is what keeps it rate-limited. The frontend holds the
same line: it keeps the last response that carried data, so a failed poll (or
a backend that is restarting) leaves the cards standing and raises a
`⚠ Refresh failed` badge next to the stamp — with the upstream error in its
tooltip — rather than swapping the dashboard for an error box. The badge
clears itself on the first successful read, and the Refresh icon spins while
an attempt is in flight, so a press that fails still looks like a press. The reading is also
written to `~/.claude/cloudcli-claude-limits-cache.json` and read back at
startup (`CLAUDE_LIMITS_CACHE` overrides the path), so a
`systemctl restart cloudcli` doesn't leave the panel blank until the endpoint
lets us back in.

The plan label ("Max (20x)") comes from `GET /api/oauth/profile`
(`CLAUDE_LIMITS_PROFILE_ENDPOINT`), cached 24h and persisted with the reading.
The usage payload carries no plan field, and `~/.claude/.credentials.json`
keeps the tier it was written with at login — an account upgraded from Max 5x
to 20x kept being labelled 5x until the next sign-in. The credentials file is
still the fallback when the profile can't be reached. Only the derived label
is stored; the rest of the profile (name, email, org) is read and dropped.

### Token/cost history (`GET /history` and `GET /usage`)

Ported from the `cloudcli-plugin-claude-usage` plugin (TypeScript → plain
JS, same logic): walks `~/.claude/projects/**/*.jsonl`, parses each line
that carries a `message.usage` block (`dist/history.js`), estimates cost
per-model from a static price table (`dist/pricing.js`), and aggregates by
day / week / month / model / project / session, deduping by `message.id`.
Per-file parse results are cached by `mtimeMs`, so a poll only re-reads
transcripts that actually changed. Each transcript's file name is carried
through as the session id.

Both routes are the same handler over the same `aggregate()` and the same
parse cache; they differ only in what an argument-less call means:

| Route | Default window |
|---|---|
| `GET /history` | the last **30 days** (the pre-2.1 contract, unchanged) |
| `GET /usage` | **all** recorded history |

Shared query parameters:

| Param | Values | Notes |
|---|---|---|
| `days` | `1`–`3650` | window of N days ending today; ignored if a range is given |
| `since`, `until` | `YYYY-MM-DD` | UTC, both **inclusive** |
| `groupBy` | `day` \| `week` \| `month` \| `session` | default `day` |
| `project`, `model` | exact name | narrows the aggregation, not the facet lists |

The response carries `daily` (always a zero-filled day series, which is what
the dashboard chart draws), `periods` (the requested grouping, also
zero-filled), `bySession`, `byModel`, `byProject`, `facets` (every project
and model in the *unfiltered* window), `range`, `filters`, and `totals`.
Zero-filled series are capped at the most recent 800 buckets.

### Sessions (`GET /sessions` and the action routes)

`dist/sessions.js` is a straight port of `cloudcli-system-monitor`'s session
inventory: it cross-references `/proc/<pid>` (live `claude` processes),
`~/.claude/sessions/*.json` (the CLI's own session records), and
`~/.claude/projects/**/*.jsonl` mtimes (to also show sessions that are
between turns — CloudCLI only runs a session's process for the duration of
one turn). **Privacy**: raw process command lines are parsed internally but
never returned over RPC — only two whitelisted, pattern-validated fields
(`--model`, `--resume`) ever leave that module.

`dist/sessionActions.js` (ported from `cloudcli-plugin-session-manager`)
implements kill / resume / cleanup / context, with one addition the donor
didn't have: **kill and resume are re-validated against
`readClaudeSessions()`** — the exact same read-only inventory `GET
/sessions` shows in the UI — instead of a separate, looser check built just
for the action route. An arbitrary pid or a made-up `(sessionId, cwd)` pair
is rejected before anything is signaled or spawned. `resume` always spawns
`claude --resume <id>` as the fixed OS user from `CLAUDE_LIMITS_RESUME_USER`
(defaulting to whoever runs the plugin backend) — never a client-supplied
user.

## Install / enable

Pure ESM JS, **zero dependencies** — no build or `npm install` needed;
`dist/` is committed and ships ready to run.

**From GitHub** — CloudCLI installs plugins by `git clone`:

1. In CloudCLI UI open **Settings → Plugins → Install from URL**.
2. Paste `https://github.com/DrStannum/cloudcli-plugin-claude-limits.git`.
3. Enable **Claude**, then open the tab from the sidebar.

**Manually** — clone or copy the folder into
`~/.claude-code-ui/plugins/cloudcli-claude-limits/`, then enable it in
**Settings → Plugins**. The plugin's internal `name`
(`cloudcli-claude-limits`) and its directory are unchanged from the 1.x
"Claude Limits" release on purpose, so an existing install keeps its
enabled/disabled state in `~/.claude-code-ui/plugins.json` across the
upgrade — only the tab's display name changed, to **Claude**.

## Verify the /limits endpoint (recommended once)

```bash
node ~/.claude-code-ui/plugins/cloudcli-claude-limits/probe.mjs
```

Prints the HTTP status and the raw response. See the Troubleshooting table
below for what 401/403/404 mean.

You can point `/limits` at a different URL or credentials file without
editing code:

```bash
CLAUDE_LIMITS_ENDPOINT="https://.../usage"
CLAUDE_LIMITS_CREDS="/path/to/.credentials.json"
```

## Environment variables

| Variable | Default | Affects |
|---|---|---|
| `CLAUDE_LIMITS_ENDPOINT` | `https://api.anthropic.com/api/oauth/usage` | `/limits` |
| `CLAUDE_LIMITS_CREDS` | `~/.claude/.credentials.json` | `/limits` |
| `CLAUDE_LIMITS_HISTORY` | `~/.claude/cloudcli-claude-limits-history.json` | `/limits` (daily-budget snapshot log) |
| `CLAUDE_LIMITS_USAGE_LOG` | `~/.claude/usage_log.json` | `/limits` (read-only legacy fallback) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | `/history` (project transcripts root) |
| `CLAUDE_LIMITS_SESSION_HOMES` | current user's home | `/sessions/*` action routes (comma-separated home dirs) |
| `CLAUDE_LIMITS_RESUME_USER` | the plugin backend's OS user | `/sessions/resume` (who `claude --resume` runs as) |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "No Claude subscription token found" | Not signed in with Pro/Max in Claude Code, or creds not at `~/.claude/.credentials.json`. |
| "Not authorized" (401/403) | Token expired / missing `user:profile`. Run Claude Code, then Refresh. |
| Limits load but a weekly bucket is missing/mislabeled | The API added a new `seven_day_*` key — extend `weeklyLabel()` in `dist/server.js`. |
| History is empty | No `~/.claude/projects/**/*.jsonl` transcripts in the last 30 days, or `CLAUDE_CONFIG_DIR` points elsewhere. |
| A session can't be resumed | Resume only works for **detached** sessions (no live process) with a known `sessionId` + `cwd`; a live session's process is what you'd `kill`, not `resume`. |
| Kill/Resume returns 403 | The pid or (sessionId, cwd) pair isn't in `readClaudeSessions()` — by design, this rejects anything the sessions table itself doesn't show. |

## Files

```
manifest.json          # slot:"tab", entry+server, author, homepage
package.json           # metadata + test scripts (no deps, no build)
LICENSE                # MIT
dist/server.js         # backend: dispatch for all routes                (authoritative)
dist/daily.js          # today's-budget math (1/7 a day, leftover carries forward)
dist/history.js        # token/cost aggregation (ported from claude-usage)
dist/pricing.js        # per-model $/M-token table (ported from claude-usage)
dist/sessions.js        # read-only session inventory (ported from system-monitor)
dist/sessionActions.js # kill/resume/cleanup/context (ported from session-manager)
dist/index.js           # frontend: the Dashboard + Usage sub-views       (authoritative)
src/types.d.ts          # PluginAPI / Limits types (for editor intellisense)
probe.mjs               # standalone /limits endpoint checker
preview.html            # generated static preview of the dashboard
tests/daily.mjs         # unit tests for dist/daily.js
tests/history.mjs       # unit tests for dist/history.js (ranges, week/month/session grouping, filters)
tests/smoke.mjs         # backend integration test (mock upstream + isolated fake $HOME)
tests/preview.mjs       # regenerates preview.html + Playwright screenshots (light/dark × en/ru,
                        #   + Usage, + the daily card's carry/overrun splits via ?daily=)
icon.svg
```

`dist/` is hand-written ESM and is **committed on purpose** — CloudCLI runs
`npm install --ignore-scripts` on a cloned plugin and never runs a build, so
a plugin that needs compiling would install broken.

Run the tests:

```bash
npm test                  # all four
node tests/daily.mjs      # today's-budget math
node tests/history.mjs    # usage aggregation: ranges, groupings, sessions, filters
node tests/smoke.mjs      # backend end-to-end: /limits, /history, /sessions, action routes
node tests/preview.mjs    # dashboard + Usage render check & screenshots (needs Playwright)
```

## Security notes

- The backend reads your local Claude OAuth token **from disk** and sends it
  only to the Anthropic usage endpoint. It is never exposed to the frontend.
- No token is ever written back; the credentials file is read-only from here.
- Session command lines are parsed server-side but never returned raw — see
  the Sessions section above.
- Kill/resume are re-validated against the same read-only session inventory
  the UI displays, on top of the donor plugins' own input validation.
- Zero third-party dependencies.

## License

MIT © 2026 DrStannum — see [LICENSE](LICENSE).
