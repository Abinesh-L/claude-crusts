/**
 * Hook-triggered auto-injection — "your context self-heals when it gets hot."
 *
 * When installed, crusts runs on every Claude Code `UserPromptSubmit`
 * event. It classifies the live session; if the window is close enough to
 * Claude Code's auto-compaction trigger (within `max(20K, 10% of limit)`
 * tokens of `autocompactTrigger(limit)`; or, when the user explicitly set
 * `autoInject.threshold` in config.json, past that usage percentage) and
 * the last injection was more than `minGapMs` ago (default 5 min), it
 * emits a `UserPromptSubmit` hook response with an `additionalContext`
 * field. Claude Code prepends that text to the prompt Claude sees — so
 * the model receives a specific `/compact focus` recommendation tuned to
 * THIS session's actual waste, without the user having to paste anything.
 *
 * The hook is fire-and-forget: on any error, it exits silently with
 * code 0 so a bug in crusts never blocks the user's prompt.
 */

import { existsSync, appendFileSync, readFileSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import { parseSession } from './scanner.ts';
import { gatherConfigData } from './analyzer.ts';
import { classifySession } from './classifier.ts';
import { detectWaste } from './waste-detector.ts';
import { loadAutoInjectConfig, loadAutocompactBufferTokens, recordInjection } from './config.ts';
import { autocompactTrigger, AUTOCOMPACT_BUFFER_TOKENS } from './model-context.ts';
import { CRUSTS_DIR } from './calibrator.ts';
import type { CrustsBreakdown, WasteItem } from './types.ts';

/**
 * A single recorded injection, written as one JSON line to the log.
 *
 * Lines are append-only and newest-appended-last on disk; `readInjectionLog`
 * reverses to newest-first for display. The `advisoryText` field stores the
 * complete text that was handed to Claude Code, so the log doubles as an
 * audit trail of exactly what each injection asked the model to do.
 */
export interface InjectionLogEntry {
  ts: string;
  sessionId: string;
  usagePercent: number;
  reclaimableTokens: number;
  advisoryText: string;
}

/**
 * Resolve the log file path, honouring a test-only override via env var so
 * unit tests can sandbox writes away from the developer's real install.
 */
function injectionLogPath(): string {
  const override = process.env.CRUSTS_INJECT_LOG_DIR;
  const dir = override && override.length > 0 ? override : CRUSTS_DIR;
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  }
  return join(dir, 'auto-inject.log');
}

/**
 * Append one injection record to the JSONL log at
 * `~/.claude-crusts/auto-inject.log`.
 *
 * Silent-fail on any filesystem error — logging must never block the hook
 * from completing, since the hook's failure would show up in the user's
 * Claude Code session.
 */
export function writeInjectionLog(entry: InjectionLogEntry): void {
  try {
    appendFileSync(injectionLogPath(), JSON.stringify(entry) + '\n', 'utf-8');
  } catch { /* silent: logging is best-effort */ }
}

/**
 * Read the injection log, parse JSONL lines, and return entries newest-first.
 *
 * Corrupt lines (bad JSON or missing required fields) are silently skipped
 * so a single bad write never poisons the whole history. Returns an empty
 * array when the log doesn't exist yet.
 *
 * @param limit - If provided, returns only the newest N entries.
 */
export function readInjectionLog(limit?: number): InjectionLogEntry[] {
  const path = injectionLogPath();
  if (!existsSync(path)) return [];
  let content: string;
  try { content = readFileSync(path, 'utf-8'); } catch { return []; }
  const entries: InjectionLogEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    if (isValidInjectionLogEntry(parsed)) entries.push(parsed);
  }
  entries.reverse();
  return limit !== undefined ? entries.slice(0, limit) : entries;
}

function isValidInjectionLogEntry(x: unknown): x is InjectionLogEntry {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.ts === 'string'
    && typeof o.sessionId === 'string'
    && typeof o.usagePercent === 'number'
    && typeof o.reclaimableTokens === 'number'
    && typeof o.advisoryText === 'string';
}

/** Subset of Claude Code's UserPromptSubmit hook stdin payload that we use. */
export interface AutoInjectPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: { id?: string };
  prompt?: string;
}

/** Read the JSON hook payload from stdin. Returns null on empty/malformed. */
export async function readAutoInjectPayload(): Promise<AutoInjectPayload | null> {
  if (process.stdin.isTTY) return null;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) return null;
    return JSON.parse(raw) as AutoInjectPayload;
  } catch {
    return null;
  }
}

/** Decision outcome for whether this invocation should emit an injection. */
export type InjectDecision =
  | { inject: false; reason: string }
  | { inject: true; usagePercent: number };

/**
 * Decide whether to inject, given a breakdown and the current config.
 *
 * Checks (in order):
 *   1. config.enabled — opted in
 *   2. the hotness gate:
 *      - explicit `autoInject.threshold` in config.json → usage percent
 *        ≥ threshold (the user's choice is honoured verbatim);
 *      - otherwise (default) → headroom-based: the live window is within
 *        `max(20K, 10% of limit)` tokens of the auto-compaction trigger
 *        (`limit - buffer`). A percentage default cannot serve both window
 *        sizes: 70% of 1M is still 267K clear of the trigger, while 70% of
 *        200K is genuinely close to it.
 *   3. min-gap elapsed since last injection (or last was a different session)
 *
 * @param breakdown - Live session breakdown (currentContext preferred)
 * @param config - Auto-inject config from `loadAutoInjectConfig`
 * @param sessionId - Session receiving the prompt
 * @param now - Clock override for tests (ms since epoch)
 * @param bufferTokens - Auto-compaction buffer; callers honouring the
 *   user's config override pass `loadAutocompactBufferTokens()`
 */
export function shouldInject(
  breakdown: CrustsBreakdown,
  config: ReturnType<typeof loadAutoInjectConfig>,
  sessionId: string,
  now: number = Date.now(),
  bufferTokens: number = AUTOCOMPACT_BUFFER_TOKENS,
): InjectDecision {
  if (!config.enabled) return { inject: false, reason: 'disabled' };

  const ctx = breakdown.currentContext ?? breakdown;
  const usage = ctx.usage_percentage;
  if (config.thresholdExplicit) {
    if (usage < config.threshold) {
      return { inject: false, reason: `usage ${usage.toFixed(1)}% < threshold ${config.threshold}%` };
    }
  } else {
    const limit = breakdown.context_limit;
    const gate = autocompactTrigger(limit, bufferTokens) - Math.max(20_000, 0.10 * limit);
    if (ctx.total_tokens < gate) {
      return {
        inject: false,
        reason: `window ${ctx.total_tokens.toLocaleString()} tokens < headroom gate ${Math.round(gate).toLocaleString()} (auto-compact trigger minus margin)`,
      };
    }
  }

  if (config.lastInjectionAt && config.lastInjectionSessionId === sessionId) {
    const lastMs = Date.parse(config.lastInjectionAt);
    if (Number.isFinite(lastMs) && now - lastMs < config.minGapMs) {
      const remainingS = Math.round((config.minGapMs - (now - lastMs)) / 1000);
      return { inject: false, reason: `last injection ${remainingS}s ago (min-gap ${Math.round(config.minGapMs / 1000)}s)` };
    }
  }

  return { inject: true, usagePercent: usage };
}

/**
 * Compose the advisory text to inject as additionalContext.
 *
 * The injection includes:
 *   - A one-line "crusts advisory" header with current usage
 *   - The top 3 actionable waste items as targets for /compact focus
 *   - A ready-to-run `/compact focus "..."` string tuned to the session
 */
export function buildInjectionText(
  breakdown: CrustsBreakdown,
  waste: WasteItem[],
  usagePercent: number,
): string {
  const targets: string[] = [];
  const top = waste.filter((w) => w.severity === 'high' || w.severity === 'medium').slice(0, 3);
  for (const item of top) {
    if (item.type === 'duplicate_read') {
      const m = /"([^"]+)"/.exec(item.description);
      if (m) targets.push(`keep only latest read of ${m[1]}`);
    } else if (item.type === 'stale_read') {
      const m = /"([^"]+)"/.exec(item.description);
      if (m) targets.push(`drop stale read of ${m[1]}`);
    } else if (item.type === 'resolved_exchange' && item.message_range) {
      targets.push(`drop resolved exchange at messages #${item.message_range[0]}-${item.message_range[1]}`);
    }
  }

  const compactLine = targets.length > 0
    ? `/compact focus "${targets.join('; ')}"`
    : '/compact';

  const saveable = top.reduce((sum, w) => sum + w.estimated_tokens, 0);

  // Read the live window's buckets: post-compaction sessions keep lifetime
  // buckets on the top-level breakdown, but the advisory describes the
  // CURRENT context, so prefer currentContext when it exists.
  const bucketSource = (breakdown.currentContext ?? breakdown).buckets;
  const headerTail = saveable > 0
    ? ` ~${saveable.toLocaleString()} tokens of reclaimable waste identified.`
    : ` Dominant categories: ${bucketSource.slice(0, 3).map((b) => `${b.category} ${b.percentage.toFixed(0)}%`).join(', ')}.`;

  const lines = [
    `[claude-crusts advisory] Context is at ${usagePercent.toFixed(1)}%.${headerTail}`,
    ``,
    `Before responding to the user's next message, surface this compact command and ask them to run it:`,
    ``,
    `    ${compactLine}`,
    ``,
    `Why now: Claude Code auto-compacts when about 33K tokens of headroom remain (about 83.5% of a 200K window, 96.7% of 1M); it summarises aggressively and drops more than this targeted command would. Running this compact first lets the user keep control of what stays and what gets cleared.`,
    ``,
    `Files dropped by /compact remain on disk. Re-read any that become relevant later. \`claude-crusts lost\` inspects what the compaction dropped.`,
  ];
  return lines.join('\n');
}

/**
 * Emit a UserPromptSubmit hook response that prepends text to Claude's context.
 *
 * Claude Code's hook protocol reads JSON on stdout. When the event is
 * UserPromptSubmit and the payload includes
 * `hookSpecificOutput.additionalContext`, the text is added to what the
 * model sees for this turn.
 */
function emitHookResponse(additionalContext: string): void {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(payload));
}

/**
 * Main entry point for the `claude-crusts auto-inject` command.
 *
 * Reads the hook payload, analyses the live session, decides whether to
 * inject, and emits either a hook response with additionalContext or an
 * empty response (allowing the user's prompt to proceed unchanged). All
 * errors are swallowed so the hook can never block the user.
 */
export async function runAutoInject(): Promise<void> {
  try {
    const payload = await readAutoInjectPayload();
    if (!payload) return;

    const transcriptPath = payload.transcript_path;
    if (!transcriptPath || !existsSync(transcriptPath)) return;

    const config = loadAutoInjectConfig();
    if (!config.enabled) return;

    const messages = await parseSession(transcriptPath);
    if (messages.length === 0) return;

    const configData = gatherConfigData();
    const breakdown = classifySession(messages, configData, undefined, payload.model?.id);

    const sessionId = payload.session_id ?? basename(transcriptPath).replace(/\.jsonl$/, '');
    const decision = shouldInject(breakdown, config, sessionId, Date.now(), loadAutocompactBufferTokens());
    if (!decision.inject) return;

    const waste = detectWaste(messages, breakdown, configData);
    const text = buildInjectionText(breakdown, waste, decision.usagePercent);
    const top = waste.filter((w) => w.severity === 'high' || w.severity === 'medium').slice(0, 3);
    const reclaimableTokens = top.reduce((sum, w) => sum + w.estimated_tokens, 0);

    emitHookResponse(text);
    recordInjection(sessionId);
    writeInjectionLog({
      ts: new Date().toISOString(),
      sessionId,
      usagePercent: decision.usagePercent,
      reclaimableTokens,
      advisoryText: text,
    });
  } catch {
    // Auto-inject must never break Claude Code — swallow all errors.
  }
}
