# Claude Limits — CloudCLI UI plugin

Adds a **Claude Limits** tab that shows your plan usage — the current 5‑hour
session, today's rolling budget, and the weekly buckets (All models +
per‑model) — with progress bars, reset times, and a manual refresh.

Two views, switchable via the tabs at the top of the panel. Both follow the
host app's light/dark theme.

- **Panel** — laid out like the official claude.ai *“Plan usage limits”* panel.
- **TUI** (default) — retro terminal style: each of the three core meters (5‑hour
  session, today's budget, weekly all‑models) is rendered as a big `H:MM:SS`
  countdown with a full-width block-character (`█░`) progress bar. The
  countdowns re-render every second while that tab is open, so the seconds
  digit ticks live. The header is a shell-style `limits@<host>` prompt, where
  `<host>` is the backend's `os.hostname()` — the frontend can't read that
  itself, since in the browser `location.hostname` is whatever domain the
  panel was opened on, not the server's own name.

  The bars are made of monospace glyphs, so “full width” means fitting the
  character count to the measured width: `mount()` measures one `█` once,
  divides the bar element's width by it, and re-renders at the fitted count.
  A `ResizeObserver` (width changes only — reacting to height would feed back
  into itself) refits on resize. Without a real layout (SSR/tests) it falls
  back to a fixed column count.

**Refresh every** (footer, both tabs) sets the auto-refresh interval —
10s / 30s / 1m / 3m / 5m / Off, defaulting to **3m**, persisted in `localStorage`
under `cloudcli-claude-limits:refreshMs`. The backend cache TTL is deliberately
below the shortest interval (see `CACHE_TTL_MS` in `dist/server.js`) so the
chosen rate always yields fresh data rather than a cache hit.

![what it looks like](preview.html)

> Open `preview.html` in a browser to see the Panel layout with sample data.
> The TUI view is what the tab opens on; it's live in-app (the countdowns tick
> and the bars measure themselves), so it isn't captured in a static preview.

---

## Why a tab (and not a bottom‑right widget)

CloudCLI’s plugin API only exposes the **`tab`** slot — plugins *“cannot appear
outside the tab area”* and must not touch the built‑in UI. A floating pill in
the sidebar plus a modal would require injecting into the host DOM (technically
possible, since plugin frontends run unsandboxed in the host page, but
unsupported and fragile across updates). This plugin takes the **sanctioned
route**: the sidebar tab *is* the entry point, and the tab content *is* the full
panel. Click the tab → see everything from the screenshot.

## How it works

```
┌ dist/server.js (Node subprocess, has HOME) ──────────────────────────┐
│  reads ~/.claude/.credentials.json  →  Bearer <accessToken>          │
│  GET https://api.anthropic.com/api/oauth/usage                       │
│  normalizes → { plan, session, daily, weekly[], host }  (+ raw)      │
│  dist/daily.js derives "today" + logs snapshots (see below)          │
│  caches 5s, serves GET /limits  (GET /limits?force=1 skips cache)    │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ api.rpc('GET','limits')
┌ dist/index.js (tab frontend) ────────────────────────────────────────┐
│  TUI + Panel tabs, polls every 3m (configurable), Refresh button     │
└──────────────────────────────────────────────────────────────────────┘
```

The backend re‑reads the token file on every (uncached) request, so it always
uses the freshest token Claude Code has written. It **never rotates the refresh
token** — that would break your Claude Code login.

Data shape is taken from Claude Code’s own statusline input:
`rate_limits.five_hour.{used_percentage,resets_at}` (session) and
`rate_limits.seven_day*.{used_percentage,resets_at}` (weekly). `resets_at` may be
epoch seconds, epoch ms, or an ISO string — all handled.

### Today’s budget

The API has no daily limit — only a 5‑hour and a 7‑day bucket. “Today’s budget”
is derived: the weekly allowance is split across the seven 24h periods of the
cycle (anchored to the weekly reset), unspent allowance from earlier days rolls
forward, and the bar shows how much of today’s slice is gone.

Knowing *today’s* spend needs the weekly % as it stood when the period opened,
so the backend keeps its own snapshot log at
`~/.claude/cloudcli-claude-limits-history.json` (one record per period — first
and last reading with timestamps, pruned after 9 days, written atomically).
Today’s spend is then a difference against the snapshot closest to the period
boundary. Any stretch of the day no snapshot covers is priced at the cycle’s
average day, and the value is marked as an estimate (`~` next to the number).

Set `CLAUDE_LIMITS_HISTORY` to move that file. The statusline’s own
`~/.claude/usage_log.json` is still read (never written) as a fallback baseline;
it only gets written while an interactive Claude Code TUI renders its prompt, so
for CloudCLI and headless `claude -p` usage it is typically empty or stale.

## Install / enable

It’s **pure ESM JS with zero dependencies** — no build or `npm install` needed;
`dist/` is committed and ships ready to run.

**From GitHub** — CloudCLI installs plugins by `git clone`:

1. In CloudCLI UI open **Settings → Plugins → Install from URL**.
2. Paste `https://github.com/DrStannum/cloudcli-plugin-claude-limits.git`
   (an `https://` or `git@` URL; the repo must have `manifest.json` at its root).
3. Enable **Claude Limits**, then open the new tab from the sidebar.

**Manually** — clone or copy the folder into
`~/.claude-code-ui/plugins/cloudcli-claude-limits/`, then enable it in
**Settings → Plugins**.

Enabling spawns `dist/server.js` and adds the tab; the on/off state lives in
`~/.claude-code-ui/plugins.json`, keyed by the manifest `name`. Installing via
the URL flow leaves a git remote behind, which is what CloudCLI’s **Update**
button (`git pull`) uses — a hand-copied folder has no remote and so can’t be
updated from the UI.

## Verify the endpoint (recommended once)

The exact usage URL isn’t officially documented. Confirm it against your token:

```bash
node ~/.claude-code-ui/plugins/cloudcli-claude-limits/probe.mjs
```

It prints the HTTP status and the **raw** response. Expected: a `200` with
`five_hour` / `seven_day` buckets. If you get:

- **401 / 403** → the token is expired or lacks the `user:profile` scope. Use
  Claude Code briefly (it refreshes the token), then retry.
- **404 / different JSON** → the endpoint or field names changed. Paste the raw
  output — the normalizer in `dist/server.js` (`normalize()`) maps generically,
  but new field names may need a tweak.

You can point the plugin at a different URL without editing code:

```bash
# in the plugin server env
CLAUDE_LIMITS_ENDPOINT="https://.../usage"
CLAUDE_LIMITS_CREDS="/path/to/.credentials.json"   # optional override
```

The tab also has a collapsible **“Raw API response (debug)”** section at the
bottom, so you can inspect exactly what the API returned and how it mapped.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| “No Claude subscription token found” | Not signed in with Pro/Max in Claude Code, or creds not at `~/.claude/.credentials.json`. |
| “Not authorized” (401/403) | Token expired / missing `user:profile`. Run Claude Code, then **Refresh**. |
| “Could not load usage limits” (404/HTTP) | Endpoint changed — run `probe.mjs`, adjust `CLAUDE_LIMITS_ENDPOINT` or `normalize()`. |
| Bars show but a weekly bucket is missing/mislabeled | The API added a new `seven_day_*` key — extend `weeklyLabel()`. |
| Plan shows “Max” without “(5x)” | The multiplier wasn’t in the response/creds. Cosmetic; adjust `prettyPlan()`. |

## Files

```
manifest.json      # slot:"tab", entry+server, author, homepage
package.json       # metadata + test scripts (no deps, no build)
LICENSE            # MIT
dist/server.js     # backend: creds → usage API → normalize → RPC   (authoritative)
dist/index.js      # frontend: Panel + TUI tabs                     (authoritative)
src/types.d.ts     # PluginAPI / Limits types (for editor intellisense)
probe.mjs          # standalone endpoint checker
preview.html       # generated static preview of the Panel tab
tests/shim.mjs     # minimal DOM shim shared by the two frontend tests
tests/smoke.mjs    # backend integration test (mock upstream)
tests/preview.mjs  # regenerates preview.html + checks the Panel tab render
tests/tui.mjs      # TUI tab: default view, countdowns, bars, both themes, interval field
icon.svg
```

`dist/` is hand-written ESM and is **committed on purpose** — CloudCLI runs
`npm install --ignore-scripts` on a cloned plugin and never runs a build, so a
plugin that needs compiling would install broken.

Run the tests:

```bash
npm test                  # all three
node tests/smoke.mjs      # backend end-to-end against a mock upstream
node tests/preview.mjs    # Panel-tab render check + preview.html
node tests/tui.mjs        # TUI-tab render check (both themes, bars, interval field)
```

## Security notes

- The backend reads your local Claude OAuth token **from disk** and sends it
  only to the Anthropic usage endpoint. It is never exposed to the frontend
  (the frontend only sees normalized numbers + the raw usage JSON).
- No token is ever written back; the credentials file is read‑only from here.
- Zero third‑party dependencies.

## License

MIT © 2026 DrStannum — see [LICENSE](LICENSE).
