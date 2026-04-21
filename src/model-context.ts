/**
 * Model-to-context-window resolution.
 *
 * Claude Code sessions can run on models with different context-window
 * sizes. Standard Claude models (Opus/Sonnet/Haiku 4.x without a variant
 * suffix) expose a 200K-token window. The `[1m]` variant available on
 * recent Opus and Sonnet generations exposes 1,000,000 tokens.
 *
 * This module resolves a model ID (as recorded in the session JSONL)
 * into the corresponding window size. A regex-pattern table keeps the
 * mapping extensible — adding a new variant is a one-line change.
 */

/** Fallback window size for any model that doesn't match a known variant */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

/**
 * Pattern table mapping model-ID substrings to their context-window size.
 *
 * Evaluated in order; the first match wins. The `[1m]` pattern covers
 * the current bracketed form (e.g. `claude-opus-4-7[1m]`). The trailing
 * `-1m$` branch is a defensive match for hypothetical hyphenated IDs.
 */
export const MODEL_CONTEXT_LIMITS: Array<{ pattern: RegExp; limit: number }> = [
  { pattern: /\[1m\]|-1m$/i, limit: 1_000_000 },
];

/**
 * Resolve the context-window size for a given model ID.
 *
 * Unknown IDs, `undefined`, empty strings, and synthetic markers
 * (`<synthetic>`) all fall through to DEFAULT_CONTEXT_LIMIT.
 *
 * @param modelId - Model identifier extracted from a session message
 * @returns Window size in tokens
 */
export function getContextLimit(modelId: string | undefined): number {
  if (!modelId) return DEFAULT_CONTEXT_LIMIT;
  for (const { pattern, limit } of MODEL_CONTEXT_LIMITS) {
    if (pattern.test(modelId)) return limit;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * Detect the session's context window from observed API usage.
 *
 * Claude Code strips the `[1m]` variant from the `model` field it writes
 * to JSONL, so the model ID alone cannot tell us whether a recorded
 * session used the 1M-token window. However, a single message whose
 * effective input (`input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens`) exceeds 200K is conclusive proof — a
 * standard 200K model would have errored before accepting it.
 *
 * Returns 1,000,000 if any message exceeds the 200K ceiling, otherwise
 * DEFAULT_CONTEXT_LIMIT. Conservative by design: sessions that never
 * exceeded 200K are reported against the standard window (no harm done
 * — users below 200K see identical output regardless).
 *
 * @param messages - Session messages with API usage metadata
 * @returns Detected window size in tokens
 */
export function detectContextLimitFromUsage(
  messages: Array<{ message?: { usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } } }>,
): number {
  for (const m of messages) {
    const u = m.message?.usage;
    if (!u) continue;
    const effective = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    if (effective > DEFAULT_CONTEXT_LIMIT) return 1_000_000;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * Which signal decided the resolved context limit.
 *
 * `model-id`   — the model-ID regex matched a `[1m]` (or similar) variant
 * `usage`      — at least one message's effective input exceeded 200K,
 *                proving the window must be 1M
 * `default`    — neither signal fired; fell back to 200K. A 1M session
 *                that hasn't crossed the threshold yet will show this.
 */
export type ContextLimitSignal = 'model-id' | 'usage' | 'default';

/** Full provenance output for a context-limit resolution. */
export interface ResolvedContextLimit {
  limit: number;
  signal: ContextLimitSignal;
}

/**
 * Resolve the effective context limit from both the model ID and observed usage,
 * and return which signal was decisive.
 *
 * Takes the larger of `getContextLimit(modelId)` and
 * `detectContextLimitFromUsage(messages)`. This way either signal alone
 * is sufficient: a live payload that preserves `[1m]` is honoured even
 * on a small session, and a recorded session that stripped the variant
 * still gets upgraded to 1M when its usage proves it.
 */
export function resolveContextLimitWithSignal(
  modelId: string | undefined,
  messages: Array<{ message?: { usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } } }>,
): ResolvedContextLimit {
  const modelLimit = getContextLimit(modelId);
  const usageLimit = detectContextLimitFromUsage(messages);
  if (modelLimit > DEFAULT_CONTEXT_LIMIT && modelLimit >= usageLimit) {
    return { limit: modelLimit, signal: 'model-id' };
  }
  if (usageLimit > DEFAULT_CONTEXT_LIMIT) {
    return { limit: usageLimit, signal: 'usage' };
  }
  return { limit: DEFAULT_CONTEXT_LIMIT, signal: 'default' };
}

/**
 * Back-compat: resolve just the numeric limit. Calls through to the
 * signal-returning variant and drops the provenance.
 */
export function resolveContextLimit(
  modelId: string | undefined,
  messages: Array<{ message?: { usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } } }>,
): number {
  return resolveContextLimitWithSignal(modelId, messages).limit;
}
