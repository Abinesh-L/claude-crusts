/**
 * Hook-triggered auto-injection — "your context self-heals when it gets hot."
 *
 * When installed, crusts runs on every Claude Code `UserPromptSubmit`
 * event. It classifies the live session; if usage has crossed the
 * configured threshold (default 70%) and the last injection was more
 * than `minGapMs` ago (default 5 min), it emits a `UserPromptSubmit`
 * hook response with an `additionalContext` field. Claude Code prepends
 * that text to the prompt Claude sees — so the model receives a
 * specific `/compact focus` recommendation tuned to THIS session's
 * actual waste, without the user having to paste anything.
 *
 * The hook is fire-and-forget: on any error, it exits silently with
 * code 0 so a bug in crusts never blocks the user's prompt.
 */

import { existsSync } from 'fs';
import { basename } from 'path';
import { parseSession } from './scanner.ts';
import { gatherConfigData } from './analyzer.ts';
import { classifySession } from './classifier.ts';
import { detectWaste } from './waste-detector.ts';
import { loadAutoInjectConfig, recordInjection } from './config.ts';
import type { CrustsBreakdown, WasteItem } from './types.ts';

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
 *   2. usage percent ≥ threshold
 *   3. min-gap elapsed since last injection (or last was a different session)
 */
export function shouldInject(
  breakdown: CrustsBreakdown,
  config: ReturnType<typeof loadAutoInjectConfig>,
  sessionId: string,
  now: number = Date.now(),
): InjectDecision {
  if (!config.enabled) return { inject: false, reason: 'disabled' };

  const usage = breakdown.currentContext?.usage_percentage ?? breakdown.usage_percentage;
  if (usage < config.threshold) {
    return { inject: false, reason: `usage ${usage.toFixed(1)}% < threshold ${config.threshold}%` };
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

  const lines = [
    `[claude-crusts advisory] This session is at ${usagePercent.toFixed(1)}% of its context window.`,
    saveable > 0
      ? `~${saveable.toLocaleString()} tokens are reclaimable from the top waste items.`
      : `The dominant categories are: ${breakdown.buckets.slice(0, 3).map((b) => `${b.category} ${b.percentage.toFixed(0)}%`).join(', ')}.`,
    `Suggested compact command:`,
    `    ${compactLine}`,
    ``,
    `Recovery note: files remain on disk. If anything dropped by /compact becomes relevant again, re-read the file from its original path. Run \`claude-crusts lost\` to inspect the compaction summary after the fact.`,
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
    const decision = shouldInject(breakdown, config, sessionId);
    if (!decision.inject) return;

    const waste = detectWaste(messages, breakdown, configData);
    const text = buildInjectionText(breakdown, waste, decision.usagePercent);

    emitHookResponse(text);
    recordInjection(sessionId);
  } catch {
    // Auto-inject must never break Claude Code — swallow all errors.
  }
}
