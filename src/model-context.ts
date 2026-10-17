/**
 * Model-to-context-window resolution.
 *
 * Claude Code sessions can run on windows of different sizes: 1M for the
 * models that ship it natively (Fable, Sonnet 5 and later, Haiku 5.5,
 * Opus 4.7 and later, per Claude Code's model-config docs), 1M for `[1m]`
 * variants of the others, 200K for the rest (Opus 4.6, Sonnet 4.6 and
 * older), and other sizes (a 500K window has been observed) that only the
 * live payload or a recorded /context output can reveal.
 *
 * `resolveContextLimitWithSignal` combines every available signal in a
 * fixed priority order and reports which one was decisive:
 *
 *   1. `payload`         - an explicit window size handed in by the caller
 *                          (statusline stdin `context_window.context_window_size`)
 *   2. `context-command` - the latest /context output recorded in the
 *                          transcript for this model (`## Context Usage`)
 *   3. `disable-1m`      - CLAUDE_CODE_DISABLE_1M_CONTEXT is set, which holds
 *                          every model at 200K
 *   4. `model-id`        - the model ID carries a `[1m]` variant
 *   5. `settings`        - settings.json pins a `[1m]` model whose family
 *                          matches the session model
 *   6. `usage`           - observed effective input above 200K (conclusive 1M)
 *   7. `native`          - the model ships 1M natively (see
 *                          `getNativeContextLimit`)
 *   8. `default`         - 200K: Opus 4.6, Sonnet 4.6 and older models
 *                          without a `[1m]` variant
 */

import { parseContextWindowSize, parseModelHeader } from './calibrator.ts';
import type { CompactionModel, CompactionSettings } from './types.ts';

/** Fallback window size for any model that doesn't match a known variant */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

/**
 * Headroom Claude Code reserves before firing auto-compaction, in tokens.
 *
 * Auto-compaction is a fixed token buffer below the window size, not a
 * percentage: observed auto-compaction preTokens sit just under
 * `limit - 33,000` on both 200K and 1M windows (triggers at ~167,000 and
 * ~967,000 respectively, i.e. ~83.5% of 200K but ~96.7% of 1M). The old
 * flat-80% model was only coincidentally close on 200K windows and far off
 * on 1M. Users can override the buffer per-install with the
 * `autocompactBufferTokens` key in `~/.claude-crusts/config.json`
 * (see `loadAutocompactBufferTokens` in config.ts).
 */
export const AUTOCOMPACT_BUFFER_TOKENS = 33_000;

/**
 * Token level at which Claude Code's auto-compaction fires for a window.
 *
 * @param limit - Context-window size in tokens (e.g. 200,000 or 1,000,000)
 * @param bufferTokens - Reserved headroom in tokens; defaults to
 *   `AUTOCOMPACT_BUFFER_TOKENS`. Callers honouring the user's config
 *   override pass `loadAutocompactBufferTokens()` here.
 * @returns The trigger level in tokens (clamped at zero for tiny windows)
 */
export function autocompactTrigger(
  limit: number,
  bufferTokens: number = AUTOCOMPACT_BUFFER_TOKENS,
): number {
  return Math.max(0, limit - bufferTokens);
}

/** Idle compaction's default size threshold (Claude Code settings docs). */
export const IDLE_COMPACT_MIN_TOKENS = 200_000;

/** The lowest idle-compaction threshold Claude Code accepts; smaller values are raised to it. */
export const IDLE_COMPACT_FLOOR_TOKENS = 100_000;

/** Approximate idle minutes before idle compaction fires, shortly before the 1h prompt cache expires. */
export const IDLE_COMPACT_AFTER_MINUTES = 54;

/**
 * How and when Claude Code will compact a session.
 *
 * Token trigger: the auto-compact window (CLAUDE_CODE_AUTO_COMPACT_WINDOW,
 * then the model's `/autocompact` window under `modelSettings`, then the
 * top-level `autoCompactWindow`, else the context window itself), capped at
 * the context window, less the headroom buffer. With no setting that is
 * about 967K on a 1M window and 167K on 200K; a configured window is
 * assumed to keep the same buffer. Null when auto-compaction is off.
 *
 * Idle compaction (Claude Code 2.1.299+): a conversation at or above the
 * idle threshold (200K by default) left idle about 54 minutes is compacted
 * before its one-hour prompt cache expires. It is off when `idleCompaction`
 * is false or auto-compaction is off. Hand-built breakdowns and fixtures
 * pass no settings and get Claude Code's defaults.
 *
 * Idle compaction also needs the one-hour prompt cache: a session whose
 * latest cache write used the 5-minute TTL (a usage-credits plan, or a TTL
 * override) does not qualify. Claude Code rolls the feature out in stages,
 * so "applies" means "may happen", never "will".
 *
 * @param limit - Resolved context window in tokens
 * @param modelId - Session model, for a per-model `/autocompact` window
 * @param liveTokens - Live window size, for whether idle compaction applies
 * @param settings - Claude Code compaction settings (see `readCompactionSettings`)
 * @param cacheTtl - TTL of the session's latest cache write ('unknown' when
 *   the usage records do not say)
 * @returns The compaction model
 */
export function resolveCompactionModel(
  limit: number,
  modelId: string | undefined,
  liveTokens: number,
  settings?: CompactionSettings,
  cacheTtl: '1h' | '5m' | 'unknown' = 'unknown',
): CompactionModel {
  const bufferTokens = settings?.bufferTokens && settings.bufferTokens > 0
    ? settings.bufferTokens
    : AUTOCOMPACT_BUFFER_TOKENS;
  const autoEnabled = settings?.autoCompactEnabled ?? true;

  let window = limit;
  let windowSource: CompactionModel['windowSource'] = 'default';
  if (settings?.envAutoCompactWindow) {
    window = settings.envAutoCompactWindow;
    windowSource = 'env';
  } else {
    const perModel = modelId && settings?.modelAutoCompactWindows
      ? Object.entries(settings.modelAutoCompactWindows)
        .find(([key]) => modelFamily(key) === modelFamily(modelId))?.[1]
      : undefined;
    if (perModel) {
      window = perModel;
      windowSource = 'model-setting';
    } else if (settings?.autoCompactWindow) {
      window = settings.autoCompactWindow;
      windowSource = 'setting';
    }
  }
  window = Math.min(window, limit);

  const idleEnabled = autoEnabled && (settings?.idleCompaction ?? true);
  const idleMin = settings?.idleCompactMinTokens ?? IDLE_COMPACT_MIN_TOKENS;
  return {
    trigger: autoEnabled ? autocompactTrigger(window, bufferTokens) : null,
    autoCompactWindow: window,
    windowSource: autoEnabled ? windowSource : 'disabled',
    bufferTokens,
    idle: {
      enabled: idleEnabled,
      minTokens: idleMin,
      afterMinutes: IDLE_COMPACT_AFTER_MINUTES,
      cacheTtl,
      applies: idleEnabled && cacheTtl !== '5m' && liveTokens >= idleMin,
    },
  };
}

/**
 * TTL of the session's latest prompt-cache write.
 *
 * Reads the nested `cache_creation` breakdown of the newest real turn that
 * wrote cache: ephemeral_1h tokens mean the one-hour TTL (what idle
 * compaction needs), ephemeral_5m only means five minutes. Zeroed copies
 * and turns that only read cache are skipped.
 *
 * @param messages - Session messages
 * @returns '1h', '5m', or 'unknown' when no turn records the breakdown
 */
export function latestCacheTtl(messages: UsageMessage[]): '1h' | '5m' | 'unknown' {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i]!.message?.usage;
    if (!usage || isZeroedUsageCopy(usage)) continue;
    const oneHour = usageField(usage.cache_creation?.ephemeral_1h_input_tokens);
    const fiveMinutes = usageField(usage.cache_creation?.ephemeral_5m_input_tokens);
    if (oneHour > 0) return '1h';
    if (fiveMinutes > 0) return '5m';
  }
  return 'unknown';
}

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
 * Shape of a Claude model ID: `claude-<family>-<major>[-<minor>][-<date>]`
 * with an optional bracketed variant (`[1m]`). The version must end the ID
 * (or meet the variant), so `claude-opus-50` reads as major 50 and
 * `claude-opus-5-mini` does not parse at all.
 */
const CLAUDE_MODEL_ID = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/i;

/** A parsed Claude model ID. */
export interface ClaudeModelVersion {
  family: string;
  major: number;
  minor: number;
}

/**
 * Parse a Claude model ID into family and version.
 *
 * @param modelId - Model identifier (`claude-opus-5-5`, `claude-haiku-4-5-20251001`)
 * @returns Lowercased family plus major/minor (minor 0 when absent), or null
 */
export function parseClaudeModelId(modelId: string | undefined): ClaudeModelVersion | null {
  if (!modelId) return null;
  const match = CLAUDE_MODEL_ID.exec(modelId.trim());
  if (!match) return null;
  return {
    family: match[1]!.toLowerCase(),
    major: Number(match[2]),
    minor: match[3] !== undefined ? Number(match[3]) : 0,
  };
}

/**
 * Models whose Claude Code window is natively 1M with no `[1m]` variant,
 * as `[family, first native major, first native minor]`. From Claude
 * Code's model-config docs: "Fable 5.1, Fable 5, Sonnet 5 and later,
 * Haiku 5.5, and Opus 4.7 and later get the 1M window with no [1m] variant
 * to select", while Opus 4.6 and Sonnet 4.6 run at 200K without it. Mythos
 * keeps its earlier 5-generation entry.
 */
const NATIVE_1M_FROM: ReadonlyArray<readonly [string, number, number]> = [
  ['fable', 0, 0],
  ['mythos', 5, 0],
  ['sonnet', 5, 0],
  ['haiku', 5, 5],
  ['opus', 4, 7],
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
 * Native window size for a bare model ID (no variant suffix required).
 *
 * Point releases and dated IDs count (`claude-opus-5-5`,
 * `claude-fable-5-1`, `claude-haiku-5-5`); an ID that does not parse as a
 * Claude model has no entry.
 *
 * @param modelId - Model identifier extracted from a session message
 * @returns 1,000,000 for natively-1M models, or null when the table has no entry
 */
export function getNativeContextLimit(modelId: string | undefined): number | null {
  const parsed = parseClaudeModelId(modelId);
  if (!parsed) return null;
  for (const [family, major, minor] of NATIVE_1M_FROM) {
    if (parsed.family !== family) continue;
    const atLeast = parsed.major > major || (parsed.major === major && parsed.minor >= minor);
    return atLeast ? 1_000_000 : null;
  }
  return null;
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
  output_tokens?: number;
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
 * breakdown, and they agree on real turns; the larger of the two is
 * returned for the shapes that carry only one of them.
 *
 * The disagreements seen on real transcripts (flat 0 vs nested 821,214) are
 * all zeroed copies: a continuation file repeats the previous conversation's
 * last turns with input, cache_creation_input, cache_read and output all set
 * to 0 while the nested breakdown keeps the old window. Such a record
 * describes no request (no real turn has zero input and zero output), so it
 * contributes nothing; reading its nested figure as a live window was the
 * root of the 790K "fixed context".
 *
 * @param usage - Usage object from an assistant record (or undefined)
 * @returns Cache-creation tokens, 0 when no usage is present
 */
export function cacheCreationTokens(usage: UsageLike | undefined): number {
  if (!usage || isZeroedUsageCopy(usage)) return 0;
  const flat = usageField(usage.cache_creation_input_tokens);
  const nested = usageField(usage.cache_creation?.ephemeral_5m_input_tokens)
    + usageField(usage.cache_creation?.ephemeral_1h_input_tokens);
  return Math.max(flat, nested);
}

/**
 * Whether a usage object is a zeroed copy: input, cache_creation_input,
 * cache_read and output all present and exactly 0.
 *
 * @param usage - Usage object from an assistant record
 * @returns True for the zeroed copies Claude Code writes into continuation files
 */
export function isZeroedUsageCopy(usage: UsageLike): boolean {
  return usage.input_tokens === 0 && usage.cache_creation_input_tokens === 0
    && usage.cache_read_input_tokens === 0 && usage.output_tokens === 0;
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
 * The output names the model it measured (`**Model:** claude-opus-5[1m]`);
 * when `modelId` is given, a record taken on a different model family is
 * skipped, since it says nothing about this model's window.
 *
 * @param messages - Session messages (only user records are considered)
 * @param modelId - Optional model whose window is wanted
 * @returns Window size in tokens, or null when no matching /context output is recorded
 */
export function detectContextCommandWindow(messages: UsageMessage[], modelId?: string): number | null {
  const family = modelId ? modelFamily(modelId) : '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    // A typed record must be a user record: 2.1.300's api-request-blob copies
    // carry message.role 'user' too, and library callers may pass raw
    // records. Untyped fragments fall back to the role.
    if (m.type !== undefined ? m.type !== 'user' : m.message?.role !== 'user') continue;
    const text = contentText(m.message?.content);
    if (!text.trimStart().startsWith(CONTEXT_COMMAND_MARKER)) continue;
    if (family) {
      const recorded = parseModelHeader(text);
      if (recorded && !familiesMatch(family, modelFamily(recorded))) continue;
    }
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
 * `disable-1m`      - CLAUDE_CODE_DISABLE_1M_CONTEXT holds every model at 200K
 * `model-id`        - the model-ID regex matched a `[1m]` (or similar) variant
 * `settings`        - settings.json pins a `[1m]`-variant model whose family
 *                     matches the session model
 * `usage`           - at least one message's effective input exceeded 200K,
 *                     proving the window must be 1M
 * `native`          - the model ships a 1M window natively (see
 *                     `getNativeContextLimit`)
 * `default`         - no signal fired; fell back to 200K (Opus 4.6, Sonnet
 *                     4.6, older and unrecognised models)
 */
export type ContextLimitSignal =
  | 'payload'
  | 'context-command'
  | 'disable-1m'
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
  /**
   * CLAUDE_CODE_DISABLE_1M_CONTEXT is set (process environment or a
   * settings `env` block): Claude Code treats every model as a 200K window.
   */
  disable1m?: boolean;
}

/**
 * Resolve the effective context limit from every available signal, and
 * return which signal was decisive. Priority order (first hit wins):
 *
 *   1. `options.limitOverride`: live payload window size (a free integer,
 *      not restricted to 200K / 1M)
 *   2. the latest `## Context Usage` (/context output) user record's window
 *      for this model
 *   3. CLAUDE_CODE_DISABLE_1M_CONTEXT: 200K for every model
 *   4. model-ID `[1m]` variant
 *   5. settings.json `[1m]` model whose family matches the session model
 *   6. observed usage above 200K (conclusive 1M)
 *   7. natively-1M models (Fable, Sonnet 5+, Haiku 5.5, Opus 4.7+, Mythos 5)
 *   8. the 200K default (Opus 4.6, Sonnet 4.6, older and unrecognised IDs)
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
  const commandWindow = detectContextCommandWindow(messages, modelId);
  if (commandWindow !== null) {
    return { limit: commandWindow, signal: 'context-command' };
  }
  if (options?.disable1m) {
    return { limit: DEFAULT_CONTEXT_LIMIT, signal: 'disable-1m' };
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
