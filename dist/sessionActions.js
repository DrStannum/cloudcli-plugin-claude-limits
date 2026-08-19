// @ts-check
/**
 * Claude sessions — actions: context, kill, resume, cleanup.
 *
 * Ported from cloudcli-plugin-session-manager/src/server.js (`handleContext`,
 * `extractContext`, `handleKill`, `handleResume`, `handleCleanup`), with one
 * addition the donor didn't have: kill and resume are re-validated against
 * `readClaudeSessions()` from dist/sessions.js (the same read-only inventory
 * `GET /sessions` serves) before they touch anything, instead of trusting a
 * lighter-weight pid/argv check built just for the action route.
 *
 * Each handler here is transport-agnostic: it returns `{status, body}` and
 * dist/server.js is the only place that writes to an HTTP response.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { pipeline as pipelineAsync } from 'node:stream/promises';
import { readClaudeSessions } from './sessions.js';

// ── Config ─────────────────────────────────────────────────────────────

/** Home directories to scan for `~/.claude/sessions/*.json` records. */
const SCAN_HOMES = process.env.CLAUDE_LIMITS_SESSION_HOMES
  ? process.env.CLAUDE_LIMITS_SESSION_HOMES.split(',').map((h) => h.trim()).filter(Boolean)
  : [os.homedir()];

/** Which OS user resumed sessions run as. Never taken from the client request. */
const DEFAULT_USER = process.env.CLAUDE_LIMITS_RESUME_USER || os.userInfo().username;

/** Compressed transcripts older than this are left alone by cleanup. */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// ── Helpers ────────────────────────────────────────────────────────────

/** @param {string} p @returns {string|null} */
function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** @param {string} p @returns {any|null} */
function readJsonFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * `~/.claude/sessions/<pid>.json`, indexed by pid, across every configured
 * home. Only used for the context lookup (session id + cwd for a given pid);
 * `dist/sessions.js` is the source of truth for "is this pid a live session".
 * @returns {Record<string, {sessionId: string|null, cwd: string|null, homeDir: string}>}
 */
function loadSessionRecordsByPid() {
  /** @type {Record<string, {sessionId: string|null, cwd: string|null, homeDir: string}>} */
  const byPid = {};
  for (const home of SCAN_HOMES) {
    const sessionsDir = path.join(home, '.claude', 'sessions');
    let files;
    try {
      files = fs.readdirSync(sessionsDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const d = readJsonFile(path.join(sessionsDir, f));
      if (!d) continue;
      const pid = d.pid || parseInt(f, 10);
      if (!Number.isNaN(pid)) {
        byPid[String(pid)] = { sessionId: d.sessionId || null, cwd: d.cwd || null, homeDir: home };
      }
    }
  }
  return byPid;
}

/** Convert a cwd path to the Claude project directory name convention. */
function cwdToProjectDir(cwd) {
  return (cwd || '').replace(/\//g, '-');
}

/** Find the .jsonl transcript for a given sessionId + cwd. */
function findJsonlPath(sessionId, cwd, preferredHome) {
  if (!sessionId || !cwd) return null;
  const projectDir = cwdToProjectDir(cwd);
  const homes = [preferredHome, ...SCAN_HOMES].filter(Boolean);
  const seen = new Set();
  for (const home of homes) {
    if (seen.has(home)) continue;
    seen.add(home);
    const candidate = path.join(home, '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Parse a .jsonl transcript and extract context (last prompt, away summary, last assistant text). */
export function extractContext(jsonlPath) {
  let lastPrompt = null;
  let awaySummary = null;
  let lastAssistant = null;

  const txt = readFileSafe(jsonlPath);
  if (txt) {
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'last-prompt' && entry.lastPrompt) {
          lastPrompt = entry.lastPrompt;
        } else if (entry.type === 'system' && entry.subtype === 'away_summary' && entry.content) {
          awaySummary = entry.content;
        } else if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
          const textBlock = entry.message.content.find((b) => b.type === 'text' && b.text);
          if (textBlock) lastAssistant = textBlock.text.slice(0, 800);
        }
      } catch {
        /* partial line mid-write; skip */
      }
    }
  }

  return { lastPrompt, awaySummary, lastAssistant };
}

// ── Route handlers ─────────────────────────────────────────────────────

/**
 * GET /sessions/:pid/context
 * @param {number} pid
 */
export async function getContext(pid) {
  const byPid = loadSessionRecordsByPid();
  const rec = byPid[String(pid)];
  if (!rec || !rec.sessionId) {
    return { status: 404, body: { ok: false, error: 'No session record found for this PID' } };
  }
  const jsonlPath = findJsonlPath(rec.sessionId, rec.cwd, rec.homeDir);
  if (!jsonlPath) {
    return {
      status: 200,
      body: { ok: true, sessionId: rec.sessionId, lastPrompt: null, awaySummary: null, lastAssistant: null },
    };
  }
  const context = extractContext(jsonlPath);
  return { status: 200, body: { ok: true, sessionId: rec.sessionId, ...context } };
}

/**
 * POST /sessions/:pid/kill
 *
 * Extra defense the session-manager donor didn't have: rather than a
 * purpose-built /proc/<pid>/cmdline check, this re-validates the pid against
 * `readClaudeSessions()` — the exact same inventory `GET /sessions` shows in
 * the UI — so kill can never touch anything the table itself doesn't list.
 * @param {number} pid
 */
export function killSession(pid) {
  const known = readClaudeSessions(null).some((s) => s.pid === pid);
  if (!known) {
    return { status: 403, body: { ok: false, error: 'PID is not a known Claude session' } };
  }
  try {
    process.kill(pid, 'SIGTERM');
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, 2000);
    return { status: 200, body: { ok: true, pid } };
  } catch (err) {
    return { status: 400, body: { ok: false, error: err && err.message ? err.message : String(err) } };
  }
}

/**
 * POST /sessions/resume  { sessionId, cwd }
 *
 * Extra defense beyond the donor's regex-only validation: the (sessionId, cwd)
 * pair must match a session `readClaudeSessions()` actually knows about
 * (typically a detached one, resumable because it has no live process) —
 * an arbitrary id/path a client makes up is rejected before `su`/`claude` ever run.
 * @param {any} body
 */
export function resumeSession(body) {
  const { sessionId, cwd } = body || {};
  if (!sessionId || !cwd) {
    return { status: 400, body: { ok: false, error: 'sessionId and cwd required' } };
  }
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) {
    return { status: 400, body: { ok: false, error: 'Invalid sessionId format' } };
  }
  if (!/^\/[^\0;&|`$<>'"\\!]+$/.test(cwd)) {
    return { status: 400, body: { ok: false, error: 'Invalid cwd path' } };
  }

  const known = readClaudeSessions(null).some((s) => s.sessionId === sessionId && s.cwd === cwd);
  if (!known) {
    return { status: 403, body: { ok: false, error: 'No known session matches that sessionId/cwd' } };
  }

  // Always use the configured default user — never trust client-supplied user.
  const runAs = DEFAULT_USER;

  try {
    const child = spawn(
      'su',
      ['-', runAs, '-c', `cd '${cwd.replace(/'/g, "'\\''")}' && claude --resume '${sessionId}'`],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    return { status: 200, body: { ok: true, sessionId, pid: child.pid } };
  } catch (err) {
    return { status: 500, body: { ok: false, error: err && err.message ? err.message : String(err) } };
  }
}

/**
 * POST /sessions/cleanup — delete orphaned session records for dead pids,
 * gzip transcripts untouched for 30+ days.
 */
export async function cleanup() {
  const results = { deletedSessions: 0, compressedLogs: 0, errors: [] };
  const cutoff = Date.now() - THIRTY_DAYS_MS;

  for (const home of SCAN_HOMES) {
    // 1. Delete session JSON files for dead PIDs.
    const sessionsDir = path.join(home, '.claude', 'sessions');
    try {
      for (const f of fs.readdirSync(sessionsDir)) {
        if (!f.endsWith('.json')) continue;
        const pid = parseInt(f, 10);
        if (!Number.isNaN(pid) && !fs.existsSync(`/proc/${pid}`)) {
          try {
            fs.unlinkSync(path.join(sessionsDir, f));
            results.deletedSessions++;
          } catch (e) {
            results.errors.push(`Delete session ${f}: ${e.message}`);
          }
        }
      }
    } catch {
      /* no sessions dir for this home */
    }

    // 2. Compress .jsonl transcripts older than 30 days.
    const projectsDir = path.join(home, '.claude', 'projects');
    let projects = [];
    try {
      projects = fs.readdirSync(projectsDir);
    } catch {
      continue;
    }
    for (const proj of projects) {
      const projPath = path.join(projectsDir, proj);
      let isDir = false;
      try {
        isDir = fs.statSync(projPath).isDirectory();
      } catch {
        /* race with a rotating dir */
      }
      if (!isDir) continue;

      let files = [];
      try {
        files = fs.readdirSync(projPath);
      } catch {
        continue;
      }

      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const filePath = path.join(projPath, f);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            const gzPath = `${filePath}.gz`;
            await pipelineAsync(fs.createReadStream(filePath), createGzip(), fs.createWriteStream(gzPath));
            fs.unlinkSync(filePath);
            results.compressedLogs++;
          }
        } catch (e) {
          results.errors.push(`Compress ${f}: ${e.message}`);
        }
      }
    }
  }

  return { status: 200, body: { ok: true, ...results } };
}
