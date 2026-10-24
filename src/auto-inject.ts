/**
 * Hook-triggered auto-injection — "your context self-heals when it gets hot."
 *
 * When installed, crusts runs on every Claude Code `UserPromptSubmit`
 * event (typed prompts, background-task reports, `/loop` iterations). It
 * classifies the live session; if the window is close enough to Claude
 * Code's auto-compaction trigger (within `max(20K, 10% of the auto-compact
 * window)` tokens of `breakdown.compaction.trigger`; or, when the user
 * explicitly set `autoInject.threshold` in config.json, past that usage
 * percentage while it comes before the trigger) and this session's last
 * injection was more than `minGapMs` ago (default 5 min), it emits a
 * `UserPromptSubmit` hook response: `additionalContext` that Claude Code
 * adds to what Claude sees (a specific `/compact focus` recommendation
 * tuned to THIS session's actual waste), and a `systemMessage` notice shown
 * to the person.
 *
 * The hook is fire-and-forget: on any error, it exits silently with
 * code 0 so a bug in crusts never blocks the user's prompt.
 */

import { existsSync, appendFileSync, readFileSync, mkdirSync } from 'fs';
import { basename, dirname, join } from 'path';
import { parseSession, collectObservedMcpServers } from './scanner.ts';
import { gatherConfigData, sessionProjectPath } from './analyzer.ts';
import { classifySession, nonHumanPromptKind } from './classifier.ts';
import { detectWaste, compactTargets } from './waste-detector.ts';
import { loadAutoInjectConfig, loadAutocompactBufferTokens, recordInjection } from './config.ts';
import { autocompactTrigger, AUTOCOMPACT_BUFFER_TOKENS } from './model-context.ts';
import { CRUSTS_DIR } from './calibrator.ts';
import { recordSessionSummary } from './session-summary.ts';
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

/**
 * Why a submitted prompt must not carry an advisory, or null when it may.
 *
 * `/compact` and `/clear` are skipped: advising a compaction on the command
 * that compacts or clears the window is noise. Slash-command wrappers
 * (`<command-name>`, local command output) and interrupt stubs are not
 * prompts to advise on either.
 *
 * Background-task reports (`<task-notification>`), `/loop` iterations and
 * cross-session messages also fire UserPromptSubmit, and they DO carry the
 * advisory: in long autonomous runs they are most of the turns, Claude
 * relayed every advisory it received on one (7 of 7 on a real transcript),
 * and the advisory's `systemMessage` line reaches the person directly
 * whichever turn it rides on.
 *
 * Payloads without a `prompt` field are not skipped (older Claude Code).
 *
 * @param prompt - The payload's `prompt` field
 * @returns A short reason to skip, or null when the prompt may carry one
 */
export function promptSkipReason(prompt: string | undefined): string | null {
  if (typeof prompt !== 'string') return null;
  const kind = nonHumanPromptKind(prompt);
  if (kind === 'local-command' || kind === 'interrupt') return `not a prompt (${kind})`;
  // /reset and /new are documented aliases of /clear.
  if (/^\/(compact|clear|reset|new)(\s|$)/i.test(prompt.trimStart())) return 'compaction command';
  return null;
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
 *        ≥ threshold, honoured while that point comes before Claude Code's
 *        trigger; when the trigger sits below it, the headroom gate below;
 *      - otherwise (default) → headroom-based: the live window is within
 *        `max(20K, 10% of the auto-compact window)` tokens of the
 *        auto-compaction trigger (the classifier's compaction model, which
 *        honours Claude Code's auto-compact window settings; `limit -
 *        buffer` without one, and the window itself when auto-compaction is
 *        off). A percentage default cannot serve both window sizes: 70% of
 *        1M is still 267K clear of the trigger, while 70% of 200K is
 *        genuinely close to it.
 *   3. min-gap elapsed since this session's last injection
 *
 * @param breakdown - Live session breakdown (currentContext preferred)
 * @param config - Auto-inject config from `loadAutoInjectConfig`
 * @param sessionId - Session receiving the prompt
 * @param now - Clock override for tests (ms since epoch)
 * @param bufferTokens - Auto-compaction buffer for breakdowns without a
 *   compaction model; callers honouring the user's config override pass
 *   `loadAutocompactBufferTokens()`
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
  const limit = breakdown.context_limit;
  // The headroom gate: within max(20K, 10% of the auto-compact window) of
  // the trigger. The margin follows the auto-compact window, not the
  // context window: with a 200K window on a 1M model, 10% of 1M put the gate
  // at 67K and every prompt from there on got an advisory.
  const trigger = breakdown.compaction
    ? breakdown.compaction.trigger ?? limit
    : autocompactTrigger(limit, bufferTokens);
  const compactWindow = breakdown.compaction?.autoCompactWindow ?? limit;
  const gate = trigger - Math.max(20_000, 0.10 * compactWindow);

  // An explicit threshold is honoured while it can still fire before the
  // trigger. When the trigger sits below it (a smaller auto-compact window,
  // a percent override), the headroom gate takes over, so a threshold of 80
  // cannot go silent on a session Claude Code compacts at 27%.
  const thresholdTokens = (config.threshold / 100) * limit;
  if (config.thresholdExplicit && thresholdTokens < trigger) {
    if (usage < config.threshold) {
      return { inject: false, reason: `usage ${usage.toFixed(1)}% < threshold ${config.threshold}%` };
    }
  } else if (ctx.total_tokens < gate) {
    return {
      inject: false,
      reason: `window ${ctx.total_tokens.toLocaleString()} tokens < headroom gate ${Math.round(gate).toLocaleString()} (auto-compact trigger minus margin)`,
    };
  }

  // The min-gap is per session: each session's own last injection.
  const last = config.lastInjections?.[sessionId]
    ?? (config.lastInjectionSessionId === sessionId ? config.lastInjectionAt : undefined);
  if (last) {
    const lastMs = Date.parse(last);
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
  const top = compactTargets(waste);
  const compactLine = compactCommandFor(waste);
  const saveable = top.reduce((sum, w) => sum + w.estimated_tokens, 0);

  // Read the live window's buckets: post-compaction sessions keep lifetime
  // buckets on the top-level breakdown, but the advisory describes the
  // CURRENT context, so prefer currentContext when it exists. Buckets come
  // in fixed CRUSTS order, so rank them by size before naming the dominant
  // ones (the head of the fixed order read "conversation 0%, retrieved 1%,
  // user 0%" on windows that System or Tools filled).
  const bucketSource = [...(breakdown.currentContext ?? breakdown).buckets]
    .sort((a, b) => b.tokens - a.tokens);
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
    `Why now: ${describeCompactionTiming(breakdown)} An automatic compaction summarises generically and drops more than this targeted command would. Running this compact first lets the user keep control of what stays and what gets cleared.`,
    ``,
    `Files dropped by /compact remain on disk. Re-read any that become relevant later. \`claude-crusts lost\` inspects what the compaction dropped.`,
  ];
  return lines.join('\n');
}

/**
 * The `/compact` command an advisory recommends: a `focus` line built from
 * the top three high- or medium-severity waste items, or a bare `/compact`
 * when none of them names a target.
 *
 * @param waste - Detected waste items
 * @returns The command to run
 */
export function compactCommandFor(waste: WasteItem[]): string {
  const targets: string[] = [];
  const top = compactTargets(waste);
  for (const item of top) {
    if (item.type === 'duplicate_read') {
      const m = /"([^"]+)"/.exec(item.description);
      if (m) targets.push(`keep only latest read of ${m[1]}`);
    } else if (item.type === 'stale_read') {
      const m = /"([^"]+)"/.exec(item.description);
      if (m) targets.push(`drop stale read of ${m[1]}`);
    } else if (item.type === 'resolved_exchange' && item.message_range) {
      targets.push(`drop resolved exchange at messages #${item.message_range[0] + 1}-${item.message_range[1]}`);
    }
  }
  return targets.length > 0 ? `/compact focus "${targets.join('; ')}"` : '/compact';
}

/**
 * One or two sentences on when Claude Code will compact this session.
 *
 * Uses the classifier's compaction model: the token trigger (from the
 * auto-compact window settings) and, when it applies, idle compaction.
 * Breakdowns without a model get the general headroom explanation.
 *
 * @param breakdown - Live session breakdown
 * @returns Plain-language timing for the advisory's "Why now" line
 */
function describeCompactionTiming(breakdown: CrustsBreakdown): string {
  const compaction = breakdown.compaction;
  if (!compaction) {
    return 'Claude Code auto-compacts when about 33K tokens of headroom remain (about 83.5% of a 200K window, 96.7% of 1M).';
  }
  const limit = breakdown.context_limit;
  const sentences: string[] = [];
  if (compaction.trigger === null) {
    sentences.push(`Auto-compaction is off here, so the session stops with a context-limit error at ${formatTokens(limit)} tokens.`);
  } else {
    const pct = ((compaction.trigger / limit) * 100).toFixed(1);
    const windowNote = compaction.autoCompactWindow < limit
      ? `its auto-compact window is set to ${formatTokens(compaction.autoCompactWindow)}`
      : `${formatTokens(limit - compaction.trigger)} short of the full window`;
    sentences.push(`Claude Code auto-compacts this session at about ${formatTokens(compaction.trigger)} tokens (${pct}% of the ${formatTokens(limit)} window; ${windowNote}).`);
  }
  if (compaction.idle.applies) {
    sentences.push(`It may also compact it if the session sits idle about ${compaction.idle.afterMinutes} minutes, since the window is over ${formatTokens(compaction.idle.minTokens)} tokens.`);
  }
  return sentences.join(' ');
}

/**
 * Short token count for messages: "1M" for a whole million, else thousands
 * ("967K", "1,200K" never; "1.2M" above a million).
 *
 * @param tokens - Token count
 * @returns Compact label
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000).toLocaleString()}K`;
}

/**
 * Emit a UserPromptSubmit hook response: the advisory for Claude, and a
 * one-line notice for the person.
 *
 * Claude Code's hook protocol reads JSON on stdout. `hookSpecificOutput.
 * additionalContext` is added to what the model sees for this turn, but it
 * never shows in the transcript, so the person only learns of it if Claude
 * relays it (on a real transcript 3 advisories never were). `systemMessage`
 * is shown to the person directly, whichever turn the advisory rides on.
 *
 * @param additionalContext - The full advisory for Claude
 * @param systemMessage - The one-line notice for the person
 */
function emitHookResponse(additionalContext: string, systemMessage: string): void {
  const payload = {
    systemMessage,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(payload));
}

/**
 * The person-facing line shown with an advisory.
 *
 * @param breakdown - Live session breakdown
 * @param usagePercent - The usage the gate measured
 * @param compactLine - The `/compact` command the advisory recommends
 * @returns One line: usage, window and the command to run
 */
export function buildUserNotice(breakdown: CrustsBreakdown, usagePercent: number, compactLine: string): string {
  const live = (breakdown.currentContext ?? breakdown).total_tokens;
  const ending = breakdown.compaction?.trigger === null
    ? 'to choose what stays before the window fills.'
    : 'to choose what stays before Claude Code compacts it.';
  return `claude-crusts: context at ${usagePercent.toFixed(1)}% (${formatTokens(live)} of ${formatTokens(breakdown.context_limit)}). Run ${compactLine} ${ending}`;
}

/**
 * Main entry point for the `claude-crusts auto-inject` command.
 *
 * Reads the hook payload, analyses the live session, decides whether to
 * inject, and emits either a hook response with additionalContext or an
 * empty response (allowing the user's prompt to proceed unchanged). Every
 * analysed prompt also updates the session's summary in
 * `~/.claude-crusts/sessions` (see session-summary.ts), which outlives the
 * transcript. All errors are swallowed so the hook can never block the user.
 */
export async function runAutoInject(): Promise<void> {
  try {
    const payload = await readAutoInjectPayload();
    if (!payload) return;
    // Only a prompt the person typed may carry (and spend the min-gap on)
    // an advisory; checked before the transcript parse, which is the
    // expensive part.
    if (promptSkipReason(payload.prompt) !== null) return;

    const transcriptPath = payload.transcript_path;
    if (!transcriptPath || !existsSync(transcriptPath)) return;

    const config = loadAutoInjectConfig();
    if (!config.enabled) return;

    const messages = await parseSession(transcriptPath);
    if (messages.length === 0) return;

    // The session's own project: its CLAUDE.md, memory folder, project
    // settings (model, auto-compact window, idle compaction) and the MCP
    // servers the transcript used. The project root is the folder the
    // session started in (`sessionProjectPath`), as in `analyze`;
    // payload.cwd follows a `cd` mid-session and would drop the project's
    // settings, so it is only the fallback. A bare gatherConfigData() read
    // only the user-level files.
    const slug = basename(dirname(transcriptPath));
    const projectRoot = sessionProjectPath(messages, transcriptPath)
      ?? (payload.cwd && existsSync(payload.cwd) ? payload.cwd : undefined);
    const configData = gatherConfigData(projectRoot, slug, collectObservedMcpServers(messages));
    const breakdown = classifySession(messages, configData, undefined, payload.model?.id);

    const sessionId = payload.session_id ?? basename(transcriptPath).replace(/\.jsonl$/, '');
    const bufferTokens = loadAutocompactBufferTokens();
    const decision = shouldInject(breakdown, config, sessionId, Date.now(), bufferTokens);
    let advisoryAt: string | undefined;
    if (decision.inject) {
      const waste = detectWaste(messages, breakdown, configData);
      const text = buildInjectionText(breakdown, waste, decision.usagePercent);
      const top = compactTargets(waste);
      const reclaimableTokens = top.reduce((sum, w) => sum + w.estimated_tokens, 0);

      emitHookResponse(text, buildUserNotice(breakdown, decision.usagePercent, compactCommandFor(waste)));
      // The advisory is out: log it first, then arm this session's min-gap.
      // Each step fails on its own, so a busy config.json cannot cost the log.
      advisoryAt = new Date().toISOString();
      writeInjectionLog({
        ts: advisoryAt,
        sessionId,
        usagePercent: decision.usagePercent,
        reclaimableTokens,
        advisoryText: text,
      });
      try { recordInjection(sessionId); } catch { /* the next prompt may advise again */ }
    }

    // Keep what this run saw where Claude Code's transcript cleanup cannot
    // reach it (cleanupPeriodDays). Built from this run's analysis; never throws.
    recordSessionSummary({ sessionId, transcriptPath, breakdown, messages, advisoryAt, bufferTokens });
  } catch {
    // Auto-inject must never break Claude Code — swallow all errors.
  }
}
