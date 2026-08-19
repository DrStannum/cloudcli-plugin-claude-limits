// @ts-check
/**
 * Claude Code sessions running on this host.
 *
 * Same source of truth the CLI itself uses, read straight from disk:
 *   /proc/<pid>            — which claude processes are alive, since when, as whom
 *   ~/.claude/sessions/*   — the CLI's own record: session id, cwd, version, name
 *   ~/.claude/projects/…   — the transcript; its mtime is the only honest
 *                            "is this session doing anything" signal we have
 *
 * Deliberately read-only: this module itself never signals, resumes or writes
 * anything — it only reports what is running. `dist/sessionActions.js` is what
 * kill/resume/cleanup use, and it re-validates any pid it acts on against the
 * list this module returns (`readClaudeSessions()`), so an action can only
 * ever touch a process this module actually recognizes as a Claude session.
 *
 * Privacy: a claude command line routinely carries live tokens (an inline
 * `--mcp-config` JSON with an API key is the normal shape). Cmdlines are parsed
 * here but never returned — only two whitelisted values leave this module,
 * `--model` and `--resume`, and both are re-validated against a strict pattern
 * first, so anything that doesn't look like an identifier is dropped instead of
 * forwarded.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** USER_HZ, as in server.js. */
const CLK_TCK = 100;

/**
 * Only these `comm` values are worth opening a cmdline for. The CLI ships as a
 * native binary (comm `claude`); node-based installs show up as `node`.
 */
const CANDIDATE_COMM = /^(claude|node|bun|deno)$/;

/** Transcript untouched for less than this — the session is working. */
const ACTIVE_SEC = 120;

/** …less than this — it is waiting for its human. Beyond it, it went quiet. */
const IDLE_SEC = 1800;

/**
 * How far back a transcript still counts as an open session with no process
 * behind it right now. CloudCLI runs a session's `claude` process only for the
 * duration of a turn: between turns the chat is very much alive but nothing is
 * running, and a process-only list would show the session blinking in and out.
 */
const DETACHED_SEC = 900;

/** Cap on process-less sessions, so an old projects tree can't flood the card. */
const MAX_DETACHED = 8;

/** How long a transcript sweep is reused before the tree is walked again. */
const SWEEP_TTL_MS = 15_000;

/** A transcript file: `<session-uuid>.jsonl`, not a subagent log. */
const TRANSCRIPT_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Bytes read from the head of a transcript to recover its working directory. */
const HEAD_BYTES = 16384;

/** A model id: letters, digits and the punctuation Anthropic ids actually use. */
const MODEL_RE = /^[\w.:@\-[\]]{1,60}$/;

/** A session id as the CLI writes it. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guardrail for a sessions directory that grew unbounded. */
const MAX_SESSION_FILES = 500;

/** @param {string} p @returns {string|null} */
function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** @param {string} p @returns {string|null} */
function readLinkSafe(p) {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

// ── users ──────────────────────────────────────────────────────────────

/** @type {{at: number, map: Map<number, {name: string, home: string}>}} */
let passwdCache = { at: 0, map: new Map() };

/**
 * uid -> name + home, from /etc/passwd. The plugin runs with a restricted env
 * and no shelling out, so `id -un` isn't an option — and passwd is where the
 * home directory (which is where the session records live) comes from anyway.
 */
function users() {
  const now = Date.now();
  if (now - passwdCache.at < 60_000) return passwdCache.map;
  const map = new Map();
  const txt = readFileSafe('/etc/passwd');
  if (txt) {
    for (const line of txt.split('\n')) {
      const f = line.split(':');
      if (f.length < 6) continue;
      const uid = Number(f[2]);
      if (!Number.isFinite(uid)) continue;
      map.set(uid, { name: f[0], home: f[5] });
    }
  }
  passwdCache = { at: now, map };
  return map;
}

/**
 * Who owns a home directory — the account name a session without a process can
 * still be attributed to.
 * @param {Map<number, {name: string, home: string}>} passwd @param {string} home
 */
function userForHome(passwd, home) {
  for (const account of passwd.values()) if (account.home === home) return account.name;
  return path.basename(home) || home;
}

// ── /proc ──────────────────────────────────────────────────────────────

/**
 * Is this argv a claude CLI process rather than something that merely mentions
 * it? Only the launcher path is inspected: the plugin backends themselves live
 * under `.claude-code-ui/plugins/…/server.js` and must not be mistaken for a
 * session, and neither must a `grep claude`.
 * @param {string[]} parts
 */
function isClaudeCli(parts) {
  if (!parts.length) return false;
  if (/(^|\/)claude$/.test(parts[0])) return true;
  // node-based install: `node …/@anthropic-ai/claude-code/cli.js`
  if (parts[1] && /(claude-code\/cli\.js|(^|\/)claude)$/.test(parts[1])) return true;
  return false;
}

/**
 * The value of one whitelisted flag, in either `--flag value` or `--flag=value`
 * form. Everything else in argv is left where it is.
 * @param {string[]} parts @param {string} name @returns {string|null}
 */
function flagValue(parts, name) {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === name) {
      const next = parts[i + 1];
      return next && !next.startsWith('-') ? next : null;
    }
    if (p.startsWith(`${name}=`)) return p.slice(name.length + 1);
  }
  return null;
}

/**
 * Fields after the `(comm)` block shift by 3: state=3, starttime=22.
 * @param {number} pid @returns {{state: string, startTicks: number}|null}
 */
function readStat(pid) {
  const txt = readFileSafe(`/proc/${pid}/stat`);
  if (!txt) return null;
  const close = txt.lastIndexOf(')');
  if (close < 0) return null;
  const f = txt.slice(close + 2).trim().split(/\s+/);
  if (f.length < 20) return null;
  return { state: f[0], startTicks: Number(f[19]) };
}

/**
 * Live claude processes with the bits /proc alone can tell us.
 * @param {{pid: number, name: string}[]|null} candidates process rows already
 *   scanned by the sampler; when absent, /proc is walked here.
 */
function findClaudeProcesses(candidates) {
  /** @type {{pid: number, uid: number, cwd: string|null, startTicks: number, state: string, model: string|null, resumeId: string|null}[]} */
  const out = [];
  let list = candidates;
  if (!list) {
    list = [];
    let entries;
    try {
      entries = fs.readdirSync('/proc');
    } catch {
      return out;
    }
    for (const e of entries) {
      if (e.charCodeAt(0) < 48 || e.charCodeAt(0) > 57) continue;
      const comm = readFileSafe(`/proc/${e}/comm`);
      if (comm) list.push({ pid: Number(e), name: comm.trim() });
    }
  }

  for (const row of list) {
    if (!CANDIDATE_COMM.test(row.name) && !row.name.includes('claude')) continue;
    const raw = readFileSafe(`/proc/${row.pid}/cmdline`);
    if (!raw) continue; // exited between the scan and the read
    const parts = raw.split('\0').filter(Boolean);
    if (!isClaudeCli(parts)) continue;

    const stat = readStat(row.pid);
    if (!stat) continue;

    const model = flagValue(parts, '--model');
    const resumeId = flagValue(parts, '--resume');
    let uid = -1;
    const status = readFileSafe(`/proc/${row.pid}/status`) || '';
    const uidLine = status.split('\n').find((l) => l.startsWith('Uid:'));
    if (uidLine) uid = Number(uidLine.split(/\s+/)[1]);

    out.push({
      pid: row.pid,
      uid,
      cwd: readLinkSafe(`/proc/${row.pid}/cwd`),
      startTicks: stat.startTicks,
      state: stat.state,
      // Whitelisted, then pattern-checked: a value that doesn't look like an id
      // is dropped rather than passed through.
      model: model && MODEL_RE.test(model) ? model : null,
      resumeId: resumeId && UUID_RE.test(resumeId) ? resumeId : null,
    });
  }
  return out;
}

// ── the CLI's own session records ──────────────────────────────────────

/** @type {Map<string, {at: number, byPid: Map<number, any>}>} */
const recordCache = new Map();

/**
 * `~/.claude/sessions/<pid>.json`, indexed by pid. Cached for a second because
 * several sessions usually share one home and the tab polls repeatedly.
 * @param {string} home
 */
function sessionRecords(home) {
  const hit = recordCache.get(home);
  const now = Date.now();
  if (hit && now - hit.at < 1000) return hit.byPid;

  /** @type {Map<number, any>} */
  const byPid = new Map();
  const dir = path.join(home, '.claude', 'sessions');
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    recordCache.set(home, { at: now, byPid });
    return byPid;
  }
  let read = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    if (++read > MAX_SESSION_FILES) break;
    const txt = readFileSafe(path.join(dir, f));
    if (!txt) continue;
    try {
      const d = JSON.parse(txt);
      const pid = Number(d.pid || parseInt(f, 10));
      if (Number.isFinite(pid)) byPid.set(pid, d);
    } catch {
      // a record being written right now; it'll parse on the next poll
    }
  }
  recordCache.set(home, { at: now, byPid });
  return byPid;
}

// ── transcripts ────────────────────────────────────────────────────────

/** sessionId -> resolved transcript path. Only successes are remembered. */
const jsonlCache = new Map();

/** The CLI's project-directory convention: every non-alphanumeric char -> '-'. */
function projectDirName(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * `<home>/.claude/projects/<encoded cwd>/<sessionId>.jsonl`, with a fallback
 * sweep across the project directories: the encoding has changed shape across
 * versions, and a session started elsewhere and resumed here still logs to its
 * original project directory.
 * @param {string} home @param {string} sessionId @param {string|null} cwd
 */
function findTranscript(home, sessionId, cwd) {
  const cached = jsonlCache.get(sessionId);
  if (cached && fs.existsSync(cached)) return cached;

  const projects = path.join(home, '.claude', 'projects');
  if (cwd) {
    const direct = path.join(projects, projectDirName(cwd), `${sessionId}.jsonl`);
    if (fs.existsSync(direct)) {
      jsonlCache.set(sessionId, direct);
      return direct;
    }
  }
  let dirs;
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const candidate = path.join(projects, d, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      jsonlCache.set(sessionId, candidate);
      return candidate;
    }
  }
  return null;
}

/** @type {Map<string, {at: number, list: {sessionId: string, path: string, mtimeMs: number}[]}>} */
const sweepCache = new Map();

/**
 * Transcripts touched within the detached window, newest first. Walked at most
 * once per {@link SWEEP_TTL_MS} — a projects tree holds hundreds of files and
 * the tab polls every few seconds.
 * @param {string} home @param {number} nowMs
 */
function recentTranscripts(home, nowMs) {
  const hit = sweepCache.get(home);
  if (hit && nowMs - hit.at < SWEEP_TTL_MS) return hit.list;

  /** @type {{sessionId: string, path: string, mtimeMs: number}[]} */
  const list = [];
  const projects = path.join(home, '.claude', 'projects');
  const cutoff = nowMs - DETACHED_SEC * 1000;
  let dirs;
  try {
    dirs = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    sweepCache.set(home, { at: nowMs, list });
    return list;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projects, d.name);
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      // Subagent logs live in a `<session>/subagents/` subdirectory; only the
      // top-level `<uuid>.jsonl` is a session.
      if (!f.isFile()) continue;
      const m = TRANSCRIPT_RE.exec(f.name);
      if (!m) continue;
      const full = path.join(dir, f.name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs >= cutoff) list.push({ sessionId: m[1], path: full, mtimeMs: st.mtimeMs });
      } catch {
        // rotated away mid-sweep
      }
    }
  }
  list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  sweepCache.set(home, { at: nowMs, list });
  return list;
}

/** sessionId -> what the head of its transcript says. Immutable once read. */
const headCache = new Map();

/**
 * The working directory (and CLI version) a session started in, from the first
 * transcript entry that carries them. The *head*, not the tail: later entries
 * record wherever the agent has `cd`-ed to since.
 * @param {string} sessionId @param {string} file
 */
function transcriptHead(sessionId, file) {
  const cached = headCache.get(sessionId);
  if (cached) return cached;
  /** @type {{cwd: string|null, version: string|null}} */
  const out = { cwd: null, version: null };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    for (const line of buf.slice(0, read).toString('utf8').split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const d = JSON.parse(line);
        if (d && d.cwd) {
          out.cwd = String(d.cwd);
          out.version = d.version ? String(d.version) : null;
          break;
        }
      } catch {
        // truncated last line of the chunk
      }
    }
  } catch {
    return out;
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
  if (out.cwd) headCache.set(sessionId, out);
  return out;
}

// ── assembly ───────────────────────────────────────────────────────────

/**
 * @param {number|null} idleSec seconds since the transcript last grew
 * @returns {'working'|'waiting'|'quiet'|'unknown'}
 */
function activityStatus(idleSec) {
  if (idleSec == null) return 'unknown';
  if (idleSec < ACTIVE_SEC) return 'working';
  if (idleSec < IDLE_SEC) return 'waiting';
  return 'quiet';
}

/**
 * Every claude session alive on this host.
 *
 * @param {{pid: number, name: string, cpuPct: number|null, rss: number, rssPct: number, threads: number}[]|null} procRows
 *   the sampler's process rows, reused so a session's CPU share is measured
 *   over the same window as the process table instead of being sampled twice.
 * @param {number} [nowMs]
 */
export function readClaudeSessions(procRows, nowMs = Date.now()) {
  /** @type {Map<number, any>} */
  const byPid = new Map();
  if (procRows) for (const r of procRows) byPid.set(r.pid, r);

  const procs = findClaudeProcesses(procRows ? procRows.map((r) => ({ pid: r.pid, name: r.name })) : null);
  const uptimeSec = parseFloat((readFileSafe('/proc/uptime') || '0').split(' ')[0]) || 0;
  const passwd = users();
  const selfHome = os.homedir();

  const out = [];
  /** Homes worth sweeping for sessions that are between turns. */
  const homesSeen = new Set([selfHome]);
  for (const p of procs) {
    const account = passwd.get(p.uid) || null;
    const home = account && account.home ? account.home : selfHome;
    homesSeen.add(home);

    // A record is only this process's if the kernel agrees on when it started:
    // pids are recycled, and a stale <pid>.json would otherwise attach a dead
    // session's identity to a live one.
    let rec = sessionRecords(home).get(p.pid) || null;
    if (rec && rec.procStart != null && String(rec.procStart) !== String(p.startTicks)) rec = null;
    if (!rec && home !== selfHome) {
      const own = sessionRecords(selfHome).get(p.pid) || null;
      if (own && (own.procStart == null || String(own.procStart) === String(p.startTicks))) rec = own;
    }

    const sessionId = (rec && rec.sessionId) || p.resumeId || null;
    const cwd = p.cwd || (rec && rec.cwd) || null;

    /** @type {number|null} */
    let idleSec = null;
    if (sessionId) {
      const transcript = findTranscript(home, sessionId, cwd) || (home !== selfHome ? findTranscript(selfHome, sessionId, cwd) : null);
      if (transcript) {
        try {
          idleSec = Math.max(0, Math.floor((nowMs - fs.statSync(transcript).mtimeMs) / 1000));
        } catch {
          idleSec = null;
        }
      }
    }

    const proc = byPid.get(p.pid) || null;
    const startedSec = Math.max(0, Math.round(uptimeSec - p.startTicks / CLK_TCK));

    out.push({
      pid: p.pid,
      user: account ? account.name : String(p.uid),
      /** The CLI's own display name for the session; falls back to the folder. */
      name: (rec && rec.name) || (cwd ? path.basename(cwd) : `pid ${p.pid}`),
      cwd,
      project: cwd ? path.basename(cwd) : null,
      sessionId,
      version: (rec && rec.version) || null,
      /** `sdk-ts` here means the panel spawned it; `cli` is a terminal session. */
      entrypoint: (rec && rec.entrypoint) || null,
      model: p.model,
      resumed: Boolean(p.resumeId),
      /** A live process is backing this row. */
      detached: false,
      uptimeSec: startedSec,
      idleSec,
      status: activityStatus(idleSec),
      cpuPct: proc ? proc.cpuPct : null,
      rss: proc ? proc.rss : null,
      rssPct: proc ? proc.rssPct : null,
      threads: proc ? proc.threads : null,
    });
  }

  // Sessions between turns: CloudCLI keeps a chat open while running its
  // `claude` process only for the duration of a turn, so a list built purely
  // from /proc drops the session the moment it stops typing. A transcript that
  // was written to minutes ago is that session, waiting for its next prompt.
  const covered = new Set(out.filter((s) => s.sessionId).map((s) => s.sessionId));
  let detached = 0;
  for (const home of homesSeen) {
    for (const tr of recentTranscripts(home, nowMs)) {
      if (detached >= MAX_DETACHED) break;
      if (covered.has(tr.sessionId)) continue;
      covered.add(tr.sessionId);
      detached++;
      const head = transcriptHead(tr.sessionId, tr.path);
      const idleSec = Math.max(0, Math.floor((nowMs - tr.mtimeMs) / 1000));
      out.push({
        pid: null,
        user: userForHome(passwd, home),
        name: head.cwd ? path.basename(head.cwd) : tr.sessionId.slice(0, 8),
        cwd: head.cwd,
        project: head.cwd ? path.basename(head.cwd) : null,
        sessionId: tr.sessionId,
        version: head.version,
        entrypoint: null,
        model: null,
        resumed: false,
        detached: true,
        uptimeSec: null,
        idleSec,
        // Nothing is running, so nothing is "working" no matter how fresh the
        // transcript is — the session is between turns.
        status: activityStatus(idleSec) === 'working' ? 'waiting' : activityStatus(idleSec),
        cpuPct: null,
        rss: null,
        rssPct: null,
        threads: null,
      });
    }
  }

  // Busiest first, then the ones that went quiet longest ago — the two reasons
  // anyone opens this list. A session with a live process outranks one that is
  // merely between turns.
  const rank = { working: 0, waiting: 1, unknown: 2, quiet: 3 };
  out.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      Number(a.detached) - Number(b.detached) ||
      (b.cpuPct || 0) - (a.cpuPct || 0) ||
      (a.idleSec ?? 0) - (b.idleSec ?? 0),
  );
  return out;
}
