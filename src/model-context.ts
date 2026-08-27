/**
 * Model-to-context-window resolution.
 *
 * Claude Code sessions can run on windows of different sizes: 200K for
 * the 4.x generations, 1M for `[1m]` variants and for the 5-generation
 * families that ship 1M natively, and other sizes (a 500K window has
 * been observed) that only the live payload or a recorded /context
 * output can reveal.
 *
 * `resolveContextLimitWithSignal` combines every available signal in a
 * fixed priority order and reports which one was decisive:
 *
 *   1. `payload`         - an explicit window size handed in by the caller
 *                          (statusline stdin `context_window.context_window_size`)
 *   2. `context-command` - the latest /context output recorded in the
 *                          transcript (`## Context Usage` user record)
 *   3. `model-id`        - the model ID carries a `[1m]` variant
 *   4. `settings`        - settings.json pins a `[1m]` model whose family
 *                          matches the session model
 *   5. `usage`           - observed effective input above 200K (conclusive 1M)
 *   6. `native`          - the model family ships 1M natively (fable-5 /
 *                          mythos-5 / opus-5 / sonnet-5)
 *   7. `default`         - 200K. The 4.x models (opus-4-6/4-7/4-8,
 *                          sonnet-4-6) land here without a signal: Claude
 *                          Code runs them at 200K even where the API's own
 *                          maximum is larger.
 */

import { parseContextWindowSize } from './calibrator.ts';

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
 * Model families whose Claude Code window is natively 1M tokens with no
 * `[1m]` variant suffix: the 5-generation fable/mythos/opus/sonnet IDs.
 * The 4.x generations are deliberately NOT listed; Claude Code runs them
 * at 200K unless an explicit signal (variant, settings, payload, /context
 * output, observed usage) says otherwise.
 */
export const NATIVE_1M_MODEL_PATTERN = /^claude-(fable|mythos|opus|sonnet)-5(?![\w-])/i;

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
 * Native window size for a bare model ID (no variant suffix required).
 *
 * @param modelId - Model identifier extracted from a session message
 * @returns 1,000,000 for native-1M families, or null when the table has no entry
 */
export function getNativeContextLimit(modelId: string | undefined): number | null {
  if (!modelId) return null;
  return NATIVE_1M_MODEL_PATTERN.test(modelId) ? 1_000_000 : null;
}

/**
 * Model family: the ID with any bracketed variant (`[1m]`) or trailing
 * `-1m` suffix stripped, lowercased. `claude-opus-4-8[1m]` and
 * `claude-opus-4-8` share a family; `claude-fable-5` and
 * `claude-opus-4-8` do not.
 *
 * @param modelId - Model identifier from JSONL or settings.json
 * @returns Normalised family string for equality comparison
 */
export function modelFamily(modelId: string): string {
  return modelId.trim().replace(/\[[^\]]*\]\s*$/, '').replace(/-1m$/i, '').toLowerCase();
}

/**
 * Minimal usage shape accepted by the effective-input helpers.
 *
 * Structurally compatible with `TokenUsage` from types.ts, but every
 * field is optional so fixtures, `iterations[]` entries, and statusline
 * payload fragments all qualify.
 */
export interface UsageLike {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

/**
 * Message shape accepted by the context-limit helpers.
 *
 * Structurally compatible with `SessionMessage` from types.ts; every
 * field is optional so fixtures and payload fragments qualify. `type`,
 * `role`, and `content` feed the recorded-/context signal; `usage`
 * feeds the usage heuristic.
 */
export interface UsageMessage {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: UsageLike;
  };
}

/**
 * Coerce a usage field to a finite non-negative number.
 *
 * @param value - Raw field value from the JSONL
 * @returns The value, or 0 when it is missing, NaN, infinite, or negative
 */
function usageField(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Cache-creation tokens for one turn, reconciling the flat and nested fields.
 *
 * Claude Code >= 2.1.1xx writes both `cache_creation_input_tokens` and a
 * nested `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`
 * breakdown. They usually agree, but 18 real records disagree (one turn:
 * flat 0 vs nested 815,917). The larger of the two is the one the API
 * actually billed and the one that bounds the window, so that is returned.
 *
 * @param usage - Usage object from an assistant record (or undefined)
 * @returns Cache-creation tokens, 0 when no usage is present
 */
export function cacheCreationTokens(usage: UsageLike | undefined): number {
  if (!usage) return 0;
  const flat = usageField(usage.cache_creation_input_tokens);
  const nested = usageField(usage.cache_creation?.ephemeral_5m_input_tokens)
    + usageField(usage.cache_creation?.ephemeral_1h_input_tokens);
  return Math.max(flat, nested);
}

/**
 * Effective input of one API turn: everything the request carried.
 *
 * `input_tokens + cache_creation + cache_read`, where cache_creation is
 * reconciled by `cacheCreationTokens`. This is the single definition of
 * "how big was the window on this turn" used by the classifier (window
 * total, compaction detection, framing derivation, model history) and by
 * the usage-based context-limit heuristic below.
 *
 * @param usage - Usage object from an assistant record (or undefined)
 * @returns Effective input tokens, 0 when no usage is present
 */
export function effectiveInput(usage: UsageLike | undefined): number {
  if (!usage) return 0;
  return usageField(usage.input_tokens)
    + cacheCreationTokens(usage)
    + usageField(usage.cache_read_input_tokens);
}

/**
 * Detect the session's context window from observed API usage.
 *
 * Claude Code strips the `[1m]` variant from the `model` field it writes
 * to JSONL, so the model ID alone cannot tell us whether a recorded
 * session used the 1M-token window. However, a single message whose
 * effective input (see `effectiveInput`) exceeds 200K is conclusive
 * proof: a standard 200K model would have errored before accepting it.
 *
 * Returns 1,000,000 if any message exceeds the 200K ceiling, otherwise
 * DEFAULT_CONTEXT_LIMIT. Conservative by design: sessions that never
 * exceeded 200K are reported against the standard window (no harm done,
 * users below 200K see identical output regardless).
 *
 * @param messages - Session messages with API usage metadata
 * @returns Detected window size in tokens
 */
export function detectContextLimitFromUsage(messages: UsageMessage[]): number {
  for (const m of messages) {
    const u = m.message?.usage;
    if (!u) continue;
    if (effectiveInput(u) > DEFAULT_CONTEXT_LIMIT) return 1_000_000;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

/** Marker that opens Claude Code's recorded /context output. */
const CONTEXT_COMMAND_MARKER = '## Context Usage';

/**
 * Flatten a user record's content to plain text.
 *
 * @param content - `message.content`: a string or an array of blocks
 * @returns Concatenated text of the string / all text-bearing blocks
 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
      text += (text ? '\n' : '') + (block as { text: string }).text;
    }
  }
  return text;
}

/**
 * Window size reported by the latest /context output recorded in the transcript.
 *
 * Running /context inside Claude Code writes a user record (isMeta) whose
 * text starts with `## Context Usage`; its `**Tokens:** used / window`
 * header names the authoritative window at that moment (200k, 500k, and
 * 1m have all been observed). Scans backwards and returns the most recent
 * record that parses, so a mid-session window change is reported from the
 * newest evidence.
 *
 * @param messages - Session messages (only user records are considered)
 * @returns Window size in tokens, or null when no /context output is recorded
 */
export function detectContextCommandWindow(messages: UsageMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.type !== 'user' && m.message?.role !== 'user') continue;
    const text = contentText(m.message?.content);
    if (!text.trimStart().startsWith(CONTEXT_COMMAND_MARKER)) continue;
    const window = parseContextWindowSize(text);
    if (window !== null && window > 0) return window;
  }
  return null;
}

/**
 * Whether a configured settings family names the session model's family.
 *
 * Exact equality matches full-ID settings (`claude-opus-4-8` vs a
 * recorded `claude-opus-4-8`). Settings also accept bare aliases
 * (`opus`, `sonnet`, `fable`); an alias matches when it equals the
 * session ID's family segment or is a dash-terminated prefix of it, so
 * `opus` covers `claude-opus-4-8` and `claude-opus-5` but never
 * `claude-fable-5`, and `opusplan` never matches `claude-opus-*`.
 *
 * @param sessionFamily - `modelFamily` of the recorded session model
 * @param configuredFamily - `modelFamily` of the settings.json model
 * @returns True when the configured entry names the session's family
 */
function familiesMatch(sessionFamily: string, configuredFamily: string): boolean {
  if (sessionFamily === configuredFamily) return true;
  if (!configuredFamily.startsWith('claude-') && sessionFamily.startsWith('claude-')) {
    const segment = sessionFamily.slice('claude-'.length);
    return segment === configuredFamily || segment.startsWith(configuredFamily + '-');
  }
  return false;
}

/**
 * Window size implied by Claude Code settings for this session's model.
 *
 * The JSONL strips the `[1m]` variant from recorded model IDs, but
 * settings.json keeps it. When the highest-precedence settings model whose
 * family matches the session model (full ID or bare alias, see
 * `familiesMatch`) carries a variant with a known window, that window is
 * the session's. A family-matching settings model WITHOUT a variant is
 * not a signal (resolution falls through to usage / native), and a
 * settings model of a different family is ignored entirely (the session
 * did not run on it).
 *
 * @param sessionModel - Model ID recorded in the session (variant stripped)
 * @param settingsModels - Configured models, highest precedence first (see
 *   `readSettingsModels` in scanner.ts)
 * @returns Window size above the default, or null when settings say nothing
 */
export function detectSettingsContextLimit(
  sessionModel: string | undefined,
  settingsModels: string[] | undefined,
): number | null {
  if (!sessionModel || !settingsModels || settingsModels.length === 0) return null;
  const family = modelFamily(sessionModel);
  if (!family) return null;
  for (const configured of settingsModels) {
    if (!familiesMatch(family, modelFamily(configured))) continue;
    const limit = getContextLimit(configured);
    return limit > DEFAULT_CONTEXT_LIMIT ? limit : null;
  }
  return null;
}

/**
 * Which signal decided the resolved context limit (in priority order).
 *
 * `payload`         - an explicit window size handed in by the caller
 *                     (Claude Code's statusline stdin payload carries
 *                     `context_window.context_window_size`)
 * `context-command` - the latest /context output recorded in the transcript
 *                     reported the window in its `**Tokens:**` header
 * `model-id`        - the model-ID regex matched a `[1m]` (or similar) variant
 * `settings`        - settings.json pins a `[1m]`-variant model whose family
 *                     matches the session model
 * `usage`           - at least one message's effective input exceeded 200K,
 *                     proving the window must be 1M
 * `native`          - the model family ships a 1M window natively (fable-5 /
 *                     mythos-5 / opus-5 / sonnet-5)
 * `default`         - no signal fired; fell back to 200K. A fresh 1M session
 *                     that no other signal covers will show this.
 */
export type ContextLimitSignal =
  | 'payload'
  | 'context-command'
  | 'model-id'
  | 'settings'
  | 'usage'
  | 'native'
  | 'default';

/** Full provenance output for a context-limit resolution. */
export interface ResolvedContextLimit {
  limit: number;
  signal: ContextLimitSignal;
}

/** Optional inputs for `resolveContextLimitWithSignal`. */
export interface ContextLimitOptions {
  /**
   * Explicit window size in tokens from a live payload (the statusline
   * stdin's `context_window.context_window_size`). Any positive number
   * wins outright; zero, negative, and non-finite values are ignored.
   */
  limitOverride?: number | null;
  /**
   * Configured `model` values from Claude Code settings files, highest
   * precedence first (project .claude/settings.local.json, project
   * .claude/settings.json, ~/.claude/settings.json). See
   * `readSettingsModels` in scanner.ts.
   */
  settingsModels?: string[];
}

/**
 * Resolve the effective context limit from every available signal, and
 * return which signal was decisive. Priority order (first hit wins):
 *
 *   1. `options.limitOverride`: live payload window size (a free integer,
 *      not restricted to 200K / 1M)
 *   2. the latest `## Context Usage` (/context output) user record's window
 *   3. model-ID `[1m]` variant
 *   4. settings.json `[1m]` model whose family matches the session model
 *   5. observed usage above 200K (conclusive 1M)
 *   6. native-1M model families (fable-5 / mythos-5 / opus-5 / sonnet-5)
 *   7. the 200K default; 4.x models (opus-4-x, sonnet-4-6) land here
 *      without a signal
 *
 * @param modelId - Model ID for the session (live override preferred when available)
 * @param messages - Session messages (usage + recorded /context output)
 * @param options - Optional payload override and settings models
 * @returns Resolved limit plus the decisive signal
 */
export function resolveContextLimitWithSignal(
  modelId: string | undefined,
  messages: UsageMessage[],
  options?: ContextLimitOptions,
): ResolvedContextLimit {
  const override = options?.limitOverride;
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return { limit: Math.floor(override), signal: 'payload' };
  }
  const commandWindow = detectContextCommandWindow(messages);
  if (commandWindow !== null) {
    return { limit: commandWindow, signal: 'context-command' };
  }
  const modelLimit = getContextLimit(modelId);
  if (modelLimit > DEFAULT_CONTEXT_LIMIT) {
    return { limit: modelLimit, signal: 'model-id' };
  }
  const settingsLimit = detectSettingsContextLimit(modelId, options?.settingsModels);
  if (settingsLimit !== null && settingsLimit > DEFAULT_CONTEXT_LIMIT) {
    return { limit: settingsLimit, signal: 'settings' };
  }
  if (detectContextLimitFromUsage(messages) > DEFAULT_CONTEXT_LIMIT) {
    return { limit: 1_000_000, signal: 'usage' };
  }
  const nativeLimit = getNativeContextLimit(modelId);
  if (nativeLimit !== null && nativeLimit > DEFAULT_CONTEXT_LIMIT) {
    return { limit: nativeLimit, signal: 'native' };
  }
  return { limit: DEFAULT_CONTEXT_LIMIT, signal: 'default' };
}

/**
 * Back-compat: resolve just the numeric limit. Calls through to the
 * signal-returning variant and drops the provenance.
 *
 * @param modelId - Model ID for the session
 * @param messages - Session messages
 * @param options - Optional payload override and settings models
 * @returns Resolved window size in tokens
 */
export function resolveContextLimit(
  modelId: string | undefined,
  messages: UsageMessage[],
  options?: ContextLimitOptions,
): number {
  return resolveContextLimitWithSignal(modelId, messages, options).limit;
}
