# Claude — CloudCLI UI plugin

Adds a **Claude** tab: a single full-width dashboard combining plan usage
limits, 30-day token/cost history, and active-session management — what used
to be three separate plugins (Claude Limits, Claude Usage, Session Manager).

![what it looks like](preview.html)

> Open `preview.html` in a browser for a static look with sample data
> (`node tests/preview.mjs` regenerates it and takes Playwright screenshots).

## What's on the tab

1. **Plan usage limits** — one card per meter (current 5-hour session,
   today's rolling budget, weekly "All models", and any per-model weekly
   bucket that's actually been used). Each card shows a live `H:MM:SS`
   countdown to reset (ticking every second, independent of the data poll)
   plus a CSS progress bar colored by how close to the limit it is.
2. **Stat tiles** — total tokens, output tokens, estimated cost, and session
   count over the last 30 days.
3. **Daily tokens (30 days)** — a bar chart, bar height proportional to that
   day's token total.
4. **By model / by project** — ranked breakdowns of the same 30-day window.
5. **Active sessions** — every Claude CLI session currently running or
   recently open on this host, with **Kill**, **Resume** (detached sessions
   only), and a **Cleanup** action (deletes orphaned session records, gzips
   transcripts untouched for 30+ days).

Both light/dark theme (follows the host panel) and English/Russian
(`localStorage.userLanguage`, re-read on every poll — there's no change
event) are supported. The container is intentionally full-width, not capped
like a narrow sidebar panel.

**Refresh every** (top-right) sets the data-poll interval — 10s / 30s / 1m /
3m / 5m / Off, defaulting to **3m**, persisted in `localStorage` under
`cloudcli-claude-limits:refreshMs` (same key the pre-2.0 tab used). The
countdown timers tick on their own 1-second timer and don't trigger a
re-fetch.

### Killing a session

The **Kill** button requires a second click to confirm: the first click
turns it into "Confirm?" for a few seconds (or until you click elsewhere,
which cancels it); the second click actually sends `SIGTERM` (escalating to
`SIGKILL` after 2s if the process is still alive). A toast confirms the
result.

## How it works

```
┌ dist/server.js (Node subprocess, has HOME) ───────────────────────────────┐
│  GET  /limits            → dist/server.js + dist/daily.js  (unchanged math) │
│  GET  /history?days=30   → dist/history.js + dist/pricing.js               │
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
└──────────────────────────────────────────────────────────────────────────┘
```

### Plan usage limits (`GET /limits`)

Unchanged from the pre-2.0 plugin. The backend reads
`~/.claude/.credentials.json` for the OAuth access token, calls
`https://api.anthropic.com/api/oauth/usage`, normalizes the response
(`normalize()` in `dist/server.js`), and derives "today's budget"
(`dist/daily.js`) from its own snapshot log at
`~/.claude/cloudcli-claude-limits-history.json` (see that file's header
comment for the math — nothing here changed). Cached 5s;
`GET /limits?force=1` skips the cache. It never rotates the refresh token.

### Token/cost history (`GET /history?days=30`)

Ported from the `cloudcli-plugin-claude-usage` plugin (TypeScript → plain
JS, same logic): walks `~/.claude/projects/**/*.jsonl`, parses each line
that carries a `message.usage` block (`dist/history.js`), estimates cost
per-model from a static price table (`dist/pricing.js`), and aggregates by
day / model / project, deduping by `message.id`. Per-file parse results are
cached by `mtimeMs`, so a poll only re-reads transcripts that actually
changed.

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
dist/daily.js          # today's-budget math (unchanged since 1.x)
dist/history.js        # token/cost aggregation (ported from claude-usage)
dist/pricing.js        # per-model $/M-token table (ported from claude-usage)
dist/sessions.js        # read-only session inventory (ported from system-monitor)
dist/sessionActions.js # kill/resume/cleanup/context (ported from session-manager)
dist/index.js           # frontend: the 5-section dashboard              (authoritative)
src/types.d.ts          # PluginAPI / Limits types (for editor intellisense)
probe.mjs               # standalone /limits endpoint checker
preview.html            # generated static preview of the dashboard
tests/daily.mjs         # unit tests for dist/daily.js
tests/smoke.mjs         # backend integration test (mock upstream + isolated fake $HOME)
tests/preview.mjs       # regenerates preview.html + Playwright screenshots (light/dark × en/ru)
icon.svg
```

`dist/` is hand-written ESM and is **committed on purpose** — CloudCLI runs
`npm install --ignore-scripts` on a cloned plugin and never runs a build, so
a plugin that needs compiling would install broken.

Run the tests:

```bash
npm test                  # all three
node tests/daily.mjs      # today's-budget math
node tests/smoke.mjs      # backend end-to-end: /limits, /history, /sessions, action routes
node tests/preview.mjs    # dashboard render check + screenshots (needs Playwright)
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
