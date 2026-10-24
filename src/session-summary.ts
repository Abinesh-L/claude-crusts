/**
 * Per-session summaries that outlive Claude Code's transcripts.
 *
 * Claude Code deletes transcripts older than `cleanupPeriodDays` (30 days
 * by default), and every crusts view of a session (analyze, timeline,
 * lost, compare) needs the transcript. The auto-inject hook already
 * analyses the live session on each prompt, so it also keeps a small JSON
 * summary of what it saw at `~/.claude-crusts/sessions/<sessionId>.json`
 * (`crustsSessionsDir()`, moved by `CRUSTS_CONFIG_DIR_OVERRIDE` like
 * config.json): the window, the compaction model, every compaction and the
 * advisories the session received.
 *
 * A summary is rewritten only when something in it changed; otherwise its
 * `lastSeen` is refreshed at most every `SUMMARY_REFRESH_MS`. Writes are
 * atomic (`writeFileAtomic`, shared with config.json), and nothing here
 * throws into the hook.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, dirname, join } from 'path';
import { crustsSessionsDir, stripBom, writeFileAtomic } from './config.ts';
import { autocompactTrigger, AUTOCOMPACT_BUFFER_TOKENS } from './model-context.ts';
import type { CrustsBreakdown, SessionMessage } from './types.ts';

/** Schema version this build reads and writes. */
export const SESSION_SUMMARY_VERSION = 1;

/** How often an unchanged summary's `lastSeen` is refreshed (10 minutes). */
export const SUMMARY_REFRESH_MS = 10 * 60_000;

/** One compaction as a session summary records it. */
export interface SummaryCompaction {
  /** Time of Claude Code's compact_boundary record (ISO), null when the record has none */
  at: string | null;
  /** What fired it as Claude Code recorded it, null when not recorded */
  trigger: 'auto' | 'manual' | null;
  /** Claude Code compacted the session while it sat idle */
  idle: boolean;
  /** Window size Claude Code measured just before compacting (compactMetadata.preTokens) */
  preTokens: number;
  /** Claude Code's own count of what it wrote after compacting (compactMetadata.postTokens, without the fixed context), null when not recorded */
  postTokens: number | null;
  /** Window right after the compaction: the first live turn's effective input, or crusts' estimate until that turn exists */
  tokensAfter: number;
}

/**
 * One session's summary, schema v1, stored as
 * `~/.claude-crusts/sessions/<sessionId>.json`:
 *
 *   {
 *     "v": 1,
 *     "sessionId": string,
 *     "project": string,                // the transcript's folder under ~/.claude/projects (its slug)
 *     "transcriptPath": string,
 *     "firstSeen": string,              // ISO, the hook's first write
 *     "lastSeen": string,               // ISO, the latest write (refreshed at most every 10 minutes while nothing changes)
 *     "claudeCodeVersion": string | null, // the version that wrote the transcript's first versioned record, as first recorded
 *     "model": string,                  // the session's current model
 *     "contextLimit": number,           // context window in tokens
 *     "autoCompactWindow": number,      // auto-compact window in effect, capped at the context window
 *     "trigger": number | null,         // auto-compaction trigger in tokens, null when auto-compaction is off
 *     "peakTokens": number,             // largest window seen: the live windows measured and every compaction's preTokens
 *     "lastTokens": number,             // live window at the latest observation
 *     "compactions": [                  // oldest first
 *       { "at": string | null, "trigger": "auto" | "manual" | null, "idle": boolean,
 *         "preTokens": number, "postTokens": number | null, "tokensAfter": number }
 *     ],
 *     "advisories": { "count": number, "lastAt": string | null }  // advisories the hook gave this session
 *   }
 *
 * Token counts are whole tokens. Readers ignore keys they do not know; a
 * change to what an existing key means bumps `v`, and a build leaves files
 * with a newer `v` untouched.
 */
export interface SessionSummaryRecord {
  v: 1;
  sessionId: string;
  project: string;
  transcriptPath: string;
  firstSeen: string;
  lastSeen: string;
  claudeCodeVersion: string | null;
  model: string;
  contextLimit: number;
  autoCompactWindow: number;
  trigger: number | null;
  peakTokens: number;
  lastTokens: number;
  compactions: SummaryCompaction[];
  advisories: { count: number; lastAt: string | null };
}

/** What one hook run observed: the input to `recordSessionSummary`. */
export interface SessionObservation {
  /** Session id (the payload's `session_id`, else the transcript's file name) */
  sessionId: string;
  /** Transcript the hook analysed */
  transcriptPath: string;
  /** The hook's classification of the live session */
  breakdown: CrustsBreakdown;
  /** The parsed records the breakdown came from (compaction times are read from them) */
  messages: SessionMessage[];
  /** ISO time of the advisory this run gave, when it gave one */
  advisoryAt?: string;
  /** Auto-compaction buffer for a breakdown without a compaction model (as `shouldInject` takes it) */
  bufferTokens?: number;
}

/**
 * What `recordSessionSummary` did: `written` (new or changed), `refreshed`
 * (unchanged, `lastSeen` moved on), `unchanged` (nothing written),
 * `skipped` (an id that cannot be a file name, a file from a newer schema,
 * or a file that could not be read) or `failed` (an error, swallowed).
 */
export type SummaryWriteResult = 'written' | 'refreshed' | 'unchanged' | 'skipped' | 'failed';

/** Session ids usable as a file name. Claude Code's are UUIDs. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Path of a session's summary file.
 *
 * @param sessionId - Session id
 * @returns The path, or null when the id cannot be used as a file name
 *   (a path separator, a leading dot, other punctuation)
 */
export function sessionSummaryPath(sessionId: string): string | null {
  return SAFE_SESSION_ID.test(sessionId) ? join(crustsSessionsDir(), `${sessionId}.json`) : null;
}

/** Outcome of reading one summary file. */
type SummaryRead =
  | { status: 'missing' }
  | { status: 'ok'; summary: SessionSummaryRecord }
  | { status: 'corrupt' }
  | { status: 'newer' }
  | { status: 'unreadable' };

/**
 * Read and validate one summary file.
 *
 * A file that is not valid JSON or not a well-formed v1 summary (or one
 * naming another session) is `corrupt` and may be replaced; one from a
 * newer schema is `newer` and is left alone; one that exists but cannot be
 * read (locked, no permission) is `unreadable`, so a passing I/O error never
 * costs the history.
 *
 * @param path - Summary file path
 * @param sessionId - The session the file must describe, when known
 * @returns The read outcome
 */
function readSummaryFile(path: string, sessionId?: string): SummaryRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    return (err as { code?: string }).code === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch {
    return { status: 'corrupt' };
  }
  if (isRecord(parsed) && typeof parsed.v === 'number' && parsed.v > SESSION_SUMMARY_VERSION) {
    return { status: 'newer' };
  }
  const summary = parseSummary(parsed);
  if (!summary || (sessionId !== undefined && summary.sessionId !== sessionId)) return { status: 'corrupt' };
  return { status: 'ok', summary };
}

/**
 * Read one session's summary.
 *
 * @param sessionId - Session id
 * @returns The summary, or null when there is none or it does not validate
 */
export function readSessionSummary(sessionId: string): SessionSummaryRecord | null {
  const path = sessionSummaryPath(sessionId);
  if (!path) return null;
  const read = readSummaryFile(path, sessionId);
  return read.status === 'ok' ? read.summary : null;
}

/**
 * Every session summary kept in `crustsSessionsDir()`, most recently seen
 * first. Files that do not validate as a v1 summary (a newer schema, a hand
 * edit) and leftover temp files are skipped.
 *
 * @returns The summaries; empty when the folder does not exist
 */
export function loadSessionSummaries(): SessionSummaryRecord[] {
  const dir = crustsSessionsDir();
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const summaries: SessionSummaryRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const read = readSummaryFile(join(dir, name), name.slice(0, -'.json'.length));
    if (read.status === 'ok') summaries.push(read.summary);
  }
  return summaries.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
}

/**
 * Build the summary one observation leads to, given the stored one.
 *
 * The session's state (model, window, trigger, last window) is taken from
 * this observation; `firstSeen`, the starting Claude Code version, the peak,
 * the compaction history and the advisory count carry over from `previous`.
 * `lastSeen` is `now`.
 *
 * @param observation - What this hook run saw
 * @param previous - The stored summary, or null for a first write
 * @param now - Clock in ms since epoch
 * @returns The next summary
 */
export function buildSessionSummary(
  observation: SessionObservation,
  previous: SessionSummaryRecord | null,
  now: number,
): SessionSummaryRecord {
  const { breakdown, advisoryAt } = observation;
  const nowIso = new Date(now).toISOString();
  const lastTokens = wholeTokens((breakdown.currentContext ?? breakdown).total_tokens);
  const compactions = mergeCompactions(previous?.compactions ?? [], markedCompactions(breakdown, observation.messages));
  const peakTokens = Math.max(previous?.peakTokens ?? 0, lastTokens, ...compactions.map((c) => c.preTokens));
  const limit = wholeTokens(breakdown.context_limit);
  // The same trigger the inject gate reads: the classifier's compaction
  // model, else the window less the buffer.
  const trigger = breakdown.compaction
    ? breakdown.compaction.trigger
    : autocompactTrigger(limit, observation.bufferTokens ?? AUTOCOMPACT_BUFFER_TOKENS);
  return {
    v: SESSION_SUMMARY_VERSION,
    sessionId: observation.sessionId,
    project: basename(dirname(observation.transcriptPath)),
    transcriptPath: observation.transcriptPath,
    firstSeen: previous?.firstSeen ?? nowIso,
    lastSeen: nowIso,
    // The version the session started on stays put once known: a transcript
    // trimmed before a compaction opens with later records.
    claudeCodeVersion: previous?.claudeCodeVersion ?? breakdown.claudeCodeVersion ?? null,
    model: breakdown.model,
    contextLimit: limit,
    autoCompactWindow: wholeTokens(breakdown.compaction?.autoCompactWindow ?? limit),
    trigger: trigger === null ? null : wholeTokens(trigger),
    peakTokens,
    lastTokens,
    compactions,
    advisories: {
      count: (previous?.advisories.count ?? 0) + (advisoryAt ? 1 : 0),
      lastAt: advisoryAt ?? previous?.advisories.lastAt ?? null,
    },
  };
}

/**
 * Update a session's summary file from one hook run.
 *
 * Writes when the file is new or anything but `lastSeen` changed; an
 * unchanged summary is rewritten only to move `lastSeen` on, at most every
 * `SUMMARY_REFRESH_MS`. A corrupt file is replaced; a file from a newer
 * schema, or one that cannot be read right now, is left as it is. Never
 * throws: the hook must not fail on its bookkeeping.
 *
 * @param observation - What this hook run saw
 * @param now - Clock override for tests (ms since epoch)
 * @returns What was done
 */
export function recordSessionSummary(observation: SessionObservation, now: number = Date.now()): SummaryWriteResult {
  try {
    const path = sessionSummaryPath(observation.sessionId);
    if (!path) return 'skipped';
    const stored = readSummaryFile(path, observation.sessionId);
    if (stored.status === 'newer' || stored.status === 'unreadable') return 'skipped';
    const previous = stored.status === 'ok' ? stored.summary : null;
    const next = buildSessionSummary(observation, previous, now);
    if (previous && !summaryChanged(previous, next)) {
      if (now - Date.parse(previous.lastSeen) < SUMMARY_REFRESH_MS) return 'unchanged';
      writeFileAtomic(path, serializeSummary(next));
      return 'refreshed';
    }
    writeFileAtomic(path, serializeSummary(next));
    return 'written';
  } catch {
    return 'failed';
  }
}

/**
 * The compactions Claude Code marked in the transcript (compact_boundary
 * records), in the summary's shape.
 *
 * Token-drop detections (`detection: 'heuristic'`, the fallback for
 * transcripts without markers) are left out: the same drop also appears
 * when several prompt chains interleave in one file, and a durable record
 * should hold only compactions Claude Code wrote down.
 *
 * @param breakdown - The hook's breakdown
 * @param messages - The records it was built from (event indices point into them)
 * @returns One entry per marked compaction, in transcript order
 */
function markedCompactions(breakdown: CrustsBreakdown, messages: SessionMessage[]): SummaryCompaction[] {
  return breakdown.compactionEvents
    .filter((event) => event.detection === 'marker')
    .map((event) => ({
      at: isoTime(messages[event.beforeIndex]?.timestamp),
      trigger: event.trigger ?? null,
      idle: event.idle === true,
      preTokens: wholeTokens(event.tokensBefore),
      postTokens: event.postTokens === undefined ? null : wholeTokens(event.postTokens),
      tokensAfter: wholeTokens(event.tokensAfter),
    }));
}

/**
 * Merge the stored compactions with the ones the transcript holds now.
 *
 * The transcript's version wins for a compaction it still holds: its
 * `tokensAfter` becomes exact once the first turn after it lands, and the
 * idle notice is written after the boundary. Stored compactions the
 * transcript no longer holds are kept, since Claude Code can trim the
 * history before a compaction out of a long session's file
 * (CLAUDE_CODE_TRANSCRIPT_LOCAL_GC). A compaction is identified by its
 * boundary time and preTokens.
 *
 * @param stored - Compactions from the stored summary
 * @param current - Compactions in the transcript now
 * @returns The merged list, oldest first (untimed entries keep their order)
 */
function mergeCompactions(stored: SummaryCompaction[], current: SummaryCompaction[]): SummaryCompaction[] {
  const byKey = new Map<string, SummaryCompaction>();
  for (const c of stored) byKey.set(compactionKey(c), c);
  for (const c of current) byKey.set(compactionKey(c), c);
  const timeOf = (c: SummaryCompaction): number => (c.at === null ? Number.POSITIVE_INFINITY : Date.parse(c.at));
  return [...byKey.values()].sort((a, b) => {
    const ta = timeOf(a);
    const tb = timeOf(b);
    return ta === tb ? 0 : ta < tb ? -1 : 1;
  });
}

/**
 * Identity of a compaction across hook runs.
 *
 * @param c - A compaction entry
 * @returns Its boundary time and preTokens
 */
function compactionKey(c: SummaryCompaction): string {
  return `${c.at ?? '-'}|${c.preTokens}`;
}

/**
 * Whether two summaries differ in anything but `lastSeen`. Both are in the
 * canonical key order (`buildSessionSummary`, `parseSummary`), so their JSON
 * is comparable.
 *
 * @param previous - Stored summary
 * @param next - Summary built from this run
 * @returns True when a write is due
 */
function summaryChanged(previous: SessionSummaryRecord, next: SessionSummaryRecord): boolean {
  return JSON.stringify({ ...previous, lastSeen: '' }) !== JSON.stringify({ ...next, lastSeen: '' });
}

/**
 * File content for a summary: indented JSON with a trailing newline, like
 * config.json.
 *
 * @param summary - Summary to store
 * @returns The text to write
 */
function serializeSummary(summary: SessionSummaryRecord): string {
  return JSON.stringify(summary, null, 2) + '\n';
}

/**
 * Validate a parsed summary and rebuild it in canonical key order.
 *
 * @param raw - Parsed JSON
 * @returns The summary, or null when any field is missing or malformed
 */
function parseSummary(raw: unknown): SessionSummaryRecord | null {
  if (!isRecord(raw) || raw.v !== SESSION_SUMMARY_VERSION) return null;
  const { advisories } = raw;
  if (!isRecord(advisories) || !Array.isArray(raw.compactions)) return null;
  const compactions: SummaryCompaction[] = [];
  for (const entry of raw.compactions) {
    const compaction = parseCompaction(entry);
    if (!compaction) return null;
    compactions.push(compaction);
  }
  if (typeof raw.sessionId !== 'string' || typeof raw.project !== 'string'
    || typeof raw.transcriptPath !== 'string' || typeof raw.model !== 'string') return null;
  if (!isTime(raw.firstSeen) || !isTime(raw.lastSeen)) return null;
  if (raw.claudeCodeVersion !== null && typeof raw.claudeCodeVersion !== 'string') return null;
  if (!isCount(raw.contextLimit) || !isCount(raw.autoCompactWindow)
    || !isCount(raw.peakTokens) || !isCount(raw.lastTokens)) return null;
  if (raw.trigger !== null && !isCount(raw.trigger)) return null;
  if (!isCount(advisories.count) || (advisories.lastAt !== null && !isTime(advisories.lastAt))) return null;
  return {
    v: SESSION_SUMMARY_VERSION,
    sessionId: raw.sessionId,
    project: raw.project,
    transcriptPath: raw.transcriptPath,
    firstSeen: raw.firstSeen,
    lastSeen: raw.lastSeen,
    claudeCodeVersion: raw.claudeCodeVersion,
    model: raw.model,
    contextLimit: raw.contextLimit,
    autoCompactWindow: raw.autoCompactWindow,
    trigger: raw.trigger,
    peakTokens: raw.peakTokens,
    lastTokens: raw.lastTokens,
    compactions,
    advisories: { count: advisories.count, lastAt: advisories.lastAt },
  };
}

/**
 * Validate one stored compaction entry and rebuild it in canonical key order.
 *
 * @param raw - Parsed JSON
 * @returns The entry, or null when malformed
 */
function parseCompaction(raw: unknown): SummaryCompaction | null {
  if (!isRecord(raw)) return null;
  if (raw.at !== null && !isTime(raw.at)) return null;
  if (raw.trigger !== null && raw.trigger !== 'auto' && raw.trigger !== 'manual') return null;
  if (typeof raw.idle !== 'boolean' || !isCount(raw.preTokens) || !isCount(raw.tokensAfter)) return null;
  if (raw.postTokens !== null && !isCount(raw.postTokens)) return null;
  return {
    at: raw.at,
    trigger: raw.trigger,
    idle: raw.idle,
    preTokens: raw.preTokens,
    postTokens: raw.postTokens,
    tokensAfter: raw.tokensAfter,
  };
}

/**
 * Narrow to a plain JSON object.
 *
 * @param x - Any value
 * @returns True for a non-null, non-array object
 */
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * A finite, non-negative number (token counts, the advisory count).
 *
 * @param x - Any value
 * @returns True when usable as a count
 */
function isCount(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

/**
 * A string `Date.parse` accepts.
 *
 * @param x - Any value
 * @returns True for a parseable time string
 */
function isTime(x: unknown): x is string {
  return typeof x === 'string' && Number.isFinite(Date.parse(x));
}

/**
 * A record's timestamp as stored, when it parses as a time.
 *
 * @param timestamp - The record's `timestamp` field
 * @returns The timestamp, or null when absent or unparseable
 */
function isoTime(timestamp: string | undefined): string | null {
  return isTime(timestamp) ? timestamp : null;
}

/**
 * Round a token figure to whole tokens, never below zero (estimates can
 * carry fractions; a failed estimate must not store NaN).
 *
 * @param tokens - Token figure
 * @returns Whole, non-negative tokens
 */
function wholeTokens(tokens: number): number {
  return Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0;
}
