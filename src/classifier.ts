/**
 * CRUSTS category classifier.
 *
 * Classifies each session message into one of the 6 CRUSTS categories
 * based on message role, content type, tool usage, and context.
 *
 * Classification precedence:
 *   1. S (System) — system messages, first message, CLAUDE.md markers
 *   2. U (User Input) — the last human text message only
 *   3. T (Tools) — tool_use and tool_result blocks (non-retrieval)
 *   4. R (Retrieved) — tool results from read/search tools
 *   5. S (State/Memory) — memdir content, plans, skills, subagent summaries
 *   6. C (Conversation) — all remaining human/assistant text messages
 */

import type {
  SessionMessage,
  ContentBlock,
  CrustsCategory,
  CrustsBreakdown,
  CrustsBucket,
  ClassifiedMessage,
  ConfigData,
  ToolBreakdown,
  CompactionEvent,
  DerivedOverhead,
} from './types.ts';

/** Default context window limit for Claude models */
const CONTEXT_LIMIT = 200_000;

/** Whether to print derivation debug info to stderr */
let verbose = false;

/**
 * Enable or disable verbose derivation output.
 *
 * @param enabled - Whether to print derivation numbers to stderr
 */
export function setVerbose(enabled: boolean): void {
  verbose = enabled;
}

/**
 * Characters-per-token divisor for plain English text.
 *
 * Empirically measured across 90 single-message intervals in a real
 * Claude Code session: mean = 3.85, median = 3.35, P10 = 1.31, P90 = 6.05.
 * Code-heavy content tokenizes at ~3.3 chars/token; plain English at ~4.0.
 * We use 4.0 as the default (conservative) and 3.3 for code content.
 */
const CHARS_PER_TOKEN_TEXT = 4.0;
const CHARS_PER_TOKEN_CODE = 3.3;

/** Tools whose results are classified as Retrieved Knowledge (R) */
const RETRIEVAL_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  // Legacy/alternate names sometimes seen
  'FileReadTool',
  'GrepTool',
  'GlobTool',
  'WebFetchTool',
  'WebSearchTool',
  'NotebookEditTool',
]);

/** Keywords that indicate state/memory content */
const STATE_MARKERS = [
  'memdir/',
  'memdir\\',
  'extracted_memories',
  'memory_extraction',
  'plan_mode',
  'skill_metadata',
  'subagent_summary',
  'custom_agent',
];

/** Keywords that indicate system prompt content */
const SYSTEM_MARKERS = [
  'CLAUDE.md',
  'system-reminder',
  'system prompt',
  'You are Claude Code',
];

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Pattern for detecting code-heavy content (imports, brackets, arrows, etc.) */
const CODE_PATTERN = /(?:import |export |function |const |let |var |=>|[{}[\]();])/;

/**
 * Pick the appropriate chars-per-token divisor for a string.
 *
 * Code-heavy content (imports, brackets, arrow functions, etc.) tokenizes
 * at ~3.3 chars/token. Plain English text tokenizes at ~4.0 chars/token.
 * Measured empirically across 90 message intervals in a real session.
 *
 * @param text - The text to classify
 * @returns The divisor to use
 */
function charsPerToken(text: string): number {
  return CODE_PATTERN.test(text) ? CHARS_PER_TOKEN_CODE : CHARS_PER_TOKEN_TEXT;
}

/**
 * Estimate the token count of a content block.
 *
 * Counts characters from all content-bearing fields including text,
 * thinking, tool input, tool_result content, and thinking block
 * signatures (which are real data in the JSONL that occupy context).
 * Uses a content-aware divisor: ~3.3 for code, ~4.0 for English text.
 *
 * @param block - The content block to estimate
 * @returns Estimated token count
 */
function estimateBlockTokens(block: ContentBlock): number {
  let chars = 0;
  let sampleText = '';

  if (block.text) {
    chars += block.text.length;
    sampleText = block.text;
  }
  if (block.thinking) chars += block.thinking.length;
  if (block.signature) chars += block.signature.length;
  if (block.input) {
    const inputStr = JSON.stringify(block.input);
    chars += inputStr.length;
    if (!sampleText) sampleText = inputStr;
  }

  // Tool block metadata: IDs and names are real content the API processes
  if (block.id) chars += block.id.length;
  if (block.tool_use_id) chars += block.tool_use_id.length;
  if (block.name) chars += block.name.length;

  if (typeof block.content === 'string') {
    chars += block.content.length;
    if (!sampleText) sampleText = block.content;
  } else if (Array.isArray(block.content)) {
    for (const sub of block.content) {
      // Recursion: sub-blocks get their own divisor, so convert back to chars
      // using a neutral divisor for accumulation, then apply final divisor below
      chars += estimateBlockTokens(sub) * CHARS_PER_TOKEN_TEXT;
    }
  }

  const divisor = sampleText ? charsPerToken(sampleText) : CHARS_PER_TOKEN_TEXT;
  return Math.ceil(chars / divisor);
}

/**
 * Estimate the token count of a single message's content.
 *
 * The usage field on each JSONL message represents cumulative context state,
 * NOT the incremental cost of that message. So we always estimate per-message
 * tokens from content size using content-aware char divisors. For assistant
 * messages we use output_tokens from usage as the incremental token count.
 *
 * @param msg - The session message
 * @returns Object with token count and accuracy indicator
 */
function estimateMessageTokens(msg: SessionMessage): { tokens: number; accuracy: 'exact' | 'estimated' } {
  const usage = msg.message?.usage;

  // For assistant messages: output_tokens IS the incremental cost of the response
  if (msg.type === 'assistant' && usage && usage.output_tokens > 0) {
    return { tokens: usage.output_tokens, accuracy: 'exact' };
  }

  // For everything else: estimate from content
  const content = msg.message?.content;
  if (!content) return { tokens: 0, accuracy: 'estimated' };

  if (typeof content === 'string') {
    const divisor = charsPerToken(content);
    return { tokens: Math.ceil(content.length / divisor), accuracy: 'estimated' };
  }

  let tokens = 0;
  for (const block of content) {
    tokens += estimateBlockTokens(block);
  }
  return { tokens, accuracy: 'estimated' };
}

/**
 * Get a short preview of a message's content for display purposes.
 *
 * @param msg - The session message
 * @param maxLen - Maximum preview length (default 60)
 * @returns Truncated content preview string
 */
function getContentPreview(msg: SessionMessage, maxLen = 60): string {
  const content = msg.message?.content;
  if (!content) {
    if (msg.subtype) return `[system: ${msg.subtype}]`;
    return `[${msg.type}]`;
  }

  if (typeof content === 'string') {
    return content.slice(0, maxLen).replace(/\n/g, ' ');
  }

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      return block.text.slice(0, maxLen).replace(/\n/g, ' ');
    }
    if (block.type === 'tool_use' && block.name) {
      const inputPreview = block.input
        ? JSON.stringify(block.input).slice(0, 30)
        : '';
      return `${block.name}(${inputPreview}...)`;
    }
    if (block.type === 'tool_result') {
      const resultContent = typeof block.content === 'string'
        ? block.content.slice(0, maxLen).replace(/\n/g, ' ')
        : '[structured result]';
      return `result: ${resultContent}`;
    }
    if (block.type === 'thinking') {
      return '[thinking]';
    }
  }

  return `[${content.length} blocks]`;
}

// ---------------------------------------------------------------------------
// Single-message classification
// ---------------------------------------------------------------------------

/**
 * Determine if a message's content contains state/memory markers.
 *
 * @param msg - The session message to check
 * @returns True if the message references memdir, plans, skills, or agent state
 */
function hasStateMarkers(msg: SessionMessage): boolean {
  const content = msg.message?.content;
  if (!content) return false;

  const text = typeof content === 'string'
    ? content
    : content.map((b) => (b.text ?? '') + (b.thinking ?? '') + (typeof b.content === 'string' ? b.content : '')).join(' ');

  return STATE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Determine if a message's content contains system prompt markers.
 *
 * @param msg - The session message to check
 * @returns True if the message references CLAUDE.md or system prompt indicators
 */
function hasSystemMarkers(msg: SessionMessage): boolean {
  const content = msg.message?.content;
  if (!content) return false;

  const text = typeof content === 'string'
    ? content
    : content.map((b) => (b.text ?? '') + (typeof b.content === 'string' ? b.content : '')).join(' ');

  return SYSTEM_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Get the tool name associated with a tool_result block.
 *
 * Looks up the tool_use_id in the provided mapping to find which tool
 * produced this result.
 *
 * @param block - The tool_result content block
 * @param toolUseIdMap - Map of tool_use IDs to tool names
 * @returns The tool name, or undefined if not found
 */
function getToolNameForResult(
  block: ContentBlock,
  toolUseIdMap: Map<string, string>,
): string | undefined {
  if (block.tool_use_id) {
    return toolUseIdMap.get(block.tool_use_id);
  }
  return undefined;
}

/**
 * Classify a single message into a CRUSTS category.
 *
 * Applies the classification rules in order of precedence:
 * System > User > Tools/Retrieved > State > Conversation.
 *
 * @param msg - The session message to classify
 * @param isLastHuman - Whether this is the last human text message in the session
 * @param isFirstMessage - Whether this is the first message in the session
 * @param toolUseIdMap - Map of tool_use IDs to tool names (for result classification)
 * @returns Object with category and optional tool name
 */
export function classifyMessage(
  msg: SessionMessage,
  isLastHuman: boolean,
  isFirstMessage: boolean,
  toolUseIdMap: Map<string, string>,
): { category: CrustsCategory; toolName?: string } {
  // 0. Compaction summaries — the system's compressed representation of prior context
  if (msg.isCompactSummary) {
    return { category: 'system' };
  }

  // 1. System Instructions
  if (msg.type === 'system') {
    return { category: 'system' };
  }
  if (isFirstMessage && msg.message?.role === 'user' && hasSystemMarkers(msg)) {
    return { category: 'system' };
  }

  const content = msg.message?.content;

  // Check if this is a real human text message or a tool_result carrier
  const isHumanText = msg.type === 'user'
    && msg.message?.role === 'user'
    && !hasToolResultBlocks(content);

  // 2. User Input — only the last human TEXT message
  if (isHumanText && isLastHuman) {
    return { category: 'user' };
  }

  // 3 & 4. Tool / Retrieved classification
  // tool_use blocks in assistant messages
  if (msg.type === 'assistant' && Array.isArray(content)) {
    const toolUseBlocks = content.filter((b) => b.type === 'tool_use');
    if (toolUseBlocks.length > 0 && !content.some((b) => b.type === 'text')) {
      // Pure tool call message (no text) — classify as tools
      const toolName = toolUseBlocks[0]?.name;
      if (toolName && RETRIEVAL_TOOLS.has(toolName)) {
        return { category: 'retrieved', toolName };
      }
      return { category: 'tools', toolName };
    }
  }

  // tool_result blocks in user messages
  if (msg.type === 'user' && Array.isArray(content)) {
    const toolResultBlocks = content.filter((b) => b.type === 'tool_result');
    if (toolResultBlocks.length > 0) {
      // Look up the originating tool name
      const firstResult = toolResultBlocks[0];
      const toolName = firstResult ? getToolNameForResult(firstResult, toolUseIdMap) : undefined;
      if (toolName && RETRIEVAL_TOOLS.has(toolName)) {
        return { category: 'retrieved', toolName };
      }
      return { category: 'tools', toolName };
    }
  }

  // 5. State & Memory
  if (hasStateMarkers(msg)) {
    return { category: 'state' };
  }

  // 6. Conversation History (fallback)
  // Remaining human text messages (not the last) and assistant text responses
  return { category: 'conversation' };
}

/**
 * Check if content contains any tool_result blocks.
 *
 * @param content - Message content (string or content block array)
 * @returns True if tool_result blocks are present
 */
function hasToolResultBlocks(
  content: string | ContentBlock[] | undefined,
): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((b) => b.type === 'tool_result');
}

// ---------------------------------------------------------------------------
// Full session classification
// ---------------------------------------------------------------------------

/**
 * Build a map of tool_use IDs to their tool names.
 *
 * Scans all messages for tool_use content blocks and records the
 * ID -> name mapping so tool_result blocks can be attributed.
 *
 * @param messages - All session messages
 * @returns Map from tool_use ID to tool name
 */
function buildToolUseIdMap(messages: SessionMessage[]): Map<string, string> {
  const map = new Map<string, string>();

  for (const msg of messages) {
    if (!Array.isArray(msg.message?.content)) continue;
    for (const block of msg.message.content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        map.set(block.id, block.name);
      }
    }
  }

  return map;
}

/**
 * Find the index of the last real human text message.
 *
 * Identifies the last message with type "user" whose content is
 * actual user text (not a tool_result carrier).
 *
 * @param messages - All session messages
 * @returns Index of last human text message, or -1 if none found
 */
function findLastHumanTextIndex(messages: SessionMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (
      msg.type === 'user'
      && msg.message?.role === 'user'
      && !hasToolResultBlocks(msg.message?.content)
    ) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// CRUSTS invocation trimming
// ---------------------------------------------------------------------------

/** Patterns in Bash commands that indicate a CRUSTS invocation */
const CRUSTS_COMMAND_PATTERNS = [
  'claude-crusts analyze',
  'claude-crusts waste',
  'claude-crusts timeline',
  'claude-crusts list',
  'claude-crusts calibrate',
  'claude-crusts fix',
  'crusts analyze',
  'crusts waste',
  'crusts timeline',
  'crusts list',
  'crusts calibrate',
  'crusts fix',
  'src/index.ts analyze',
  'src/index.ts waste',
  'src/index.ts timeline',
  'src/index.ts list',
  'src/index.ts calibrate',
  'src/index.ts fix',
  'bunx claude-crusts',
  'npx claude-crusts',
  'bunx crusts',
  'npx crusts',
];

/**
 * Check if an assistant message contains a Bash tool call invoking CRUSTS.
 *
 * @param msg - The session message to check
 * @returns True if the message contains a CRUSTS Bash invocation
 */
function isCrustsBashCall(msg: SessionMessage): boolean {
  if (msg.type !== 'assistant') return false;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return false;

  for (const block of content) {
    if (block.type !== 'tool_use' || block.name !== 'Bash') continue;
    const command = (block.input?.command as string) ?? '';
    if (CRUSTS_COMMAND_PATTERNS.some((p) => command.includes(p))) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a user message contains a tool_result from a CRUSTS run.
 *
 * @param msg - The session message to check
 * @returns True if the message contains CRUSTS output in a tool_result
 */
function hasCrustsToolResult(msg: SessionMessage): boolean {
  if (msg.type !== 'user') return false;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return false;

  for (const block of content) {
    if (block.type !== 'tool_result') continue;
    const text = typeof block.content === 'string' ? block.content : '';
    if (text.includes('CRUSTS Context Window Analysis')
      || text.includes('Waste Detection Report')
      || text.includes('CRUSTS Fix')
      || text.includes('claude-crusts')) {
      return true;
    }
  }
  return false;
}

/**
 * Find the effective end index for analysis by trimming trailing messages
 * that are part of a CRUSTS invocation.
 *
 * When CRUSTS is invoked from within Claude Code, the JSONL already
 * contains the assistant message with the Bash tool_use (and possibly
 * the preceding thinking/text messages in the same turn, plus the
 * user prompt that triggered the turn). These messages are about the
 * analysis itself, not the work being analyzed — so they're trimmed.
 *
 * Three-phase trim:
 * 1. Strip trailing CRUSTS Bash calls and their tool_results
 * 2. Strip preceding assistant text/thinking messages (same turn)
 * 3. Strip the user text message that triggered the analysis turn
 *
 * @param messages - All session messages
 * @returns The effective end index (exclusive) — analyze messages[0..end)
 */
function findAnalysisCutoff(messages: SessionMessage[]): number {
  let end = messages.length;

  // Phase 1: Walk backward, trim CRUSTS Bash calls and tool_results from tail
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;

    if (msg.type === 'assistant' && isCrustsBashCall(msg)) {
      end = i;
      continue;
    }

    if (msg.type === 'user' && hasCrustsToolResult(msg)) {
      end = i;
      continue;
    }

    break;
  }

  // If nothing was trimmed, return early
  if (end === messages.length) return end;

  // Phase 2: Continue backward through assistant text/thinking messages
  // that are part of the same turn as the CRUSTS Bash call.
  // In Claude Code JSONL, a single assistant response can span multiple
  // messages: thinking, then text, then tool_use (each a separate line).
  for (let i = end - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.type !== 'assistant') break;

    const content = msg.message?.content;
    if (!Array.isArray(content)) {
      // No content array — likely a bare assistant message, trim it
      end = i;
      continue;
    }

    // Only trim if this message contains only text/thinking blocks
    // (part of the same turn). Stop if it has other tool_use blocks
    // (that would be a different tool call, not part of the CRUSTS invocation).
    const hasOnlyTextOrThinking = content.every(
      (b) => b.type === 'text' || b.type === 'thinking',
    );
    if (hasOnlyTextOrThinking) {
      end = i;
      continue;
    }

    break;
  }

  // Phase 3: Trim the preceding user text message that triggered this turn
  if (end > 0) {
    const prev = messages[end - 1]!;
    if (prev.type === 'user' && !hasToolResultBlocks(prev.message?.content)) {
      end = end - 1;
    }
  }

  return end;
}

// ---------------------------------------------------------------------------
// Compaction detection
// ---------------------------------------------------------------------------

/** Minimum input_tokens drop between consecutive assistant messages to count as compaction */
const COMPACTION_DROP_THRESHOLD = 30_000;

/**
 * Detect compaction events using compact_boundary markers (primary)
 * with a heuristic fallback for older JSONL formats.
 *
 * Primary detection: looks for system messages with subtype "compact_boundary"
 * and extracts compactMetadata.preTokens as exact ground truth.
 *
 * Fallback: detects large drops (>30K) in cumulative input_tokens between
 * consecutive assistant messages, used only if no markers are found.
 *
 * @param messages - Parsed session messages
 * @returns Array of compaction events
 */
export function detectCompactionEvents(messages: SessionMessage[]): CompactionEvent[] {
  // --- Primary: detect via compact_boundary markers ---
  const markerEvents = detectViaMarkers(messages);
  if (markerEvents.length > 0) {
    return markerEvents;
  }

  // --- Fallback: detect via token drop heuristic ---
  return detectViaHeuristic(messages);
}

/**
 * Detect compaction events via compact_boundary system messages.
 *
 * Each auto-compaction produces this sequence in the JSONL:
 *   1. system (subtype: "compact_boundary", compactMetadata.preTokens)
 *   2. user (isCompactSummary: true) — the compressed summary
 *   3. assistant — first response in the new context window
 *
 * @param messages - Parsed session messages
 * @returns Array of compaction events detected from markers
 */
function detectViaMarkers(messages: SessionMessage[]): CompactionEvent[] {
  const events: CompactionEvent[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.type !== 'system' || msg.subtype !== 'compact_boundary') continue;

    const preTokens = msg.compactMetadata?.preTokens ?? 0;

    // Find the compaction summary (next user message with isCompactSummary)
    let summaryIndex: number | undefined;
    let summaryTokens: number | undefined;
    for (let j = i + 1; j < Math.min(i + 5, messages.length); j++) {
      if (messages[j]!.isCompactSummary) {
        summaryIndex = j;
        const content = messages[j]!.message?.content;
        const chars = typeof content === 'string' ? content.length : JSON.stringify(content).length;
        // Compact summaries are mixed content (prose + code references), use 3.5 divisor
        summaryTokens = Math.ceil(chars / 3.5);
        break;
      }
    }

    // Find the first assistant message after the boundary
    let afterIndex = i + 1;
    let tokensAfter = 0;
    for (let j = i + 1; j < Math.min(i + 10, messages.length); j++) {
      const m = messages[j]!;
      if (m.type === 'assistant' && m.message?.usage) {
        afterIndex = j;
        const u = m.message.usage;
        tokensAfter = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        break;
      }
    }

    events.push({
      beforeIndex: i,
      afterIndex,
      tokensBefore: preTokens,
      tokensAfter,
      tokensDropped: preTokens - tokensAfter,
      detection: 'marker',
      summaryIndex,
      summaryTokens,
    });
  }

  return events;
}

/**
 * Fallback compaction detection via large drops in cumulative input_tokens.
 * Used for older JSONL formats that don't have compact_boundary markers.
 *
 * @param messages - Parsed session messages
 * @returns Array of compaction events detected heuristically
 */
function detectViaHeuristic(messages: SessionMessage[]): CompactionEvent[] {
  const events: CompactionEvent[] = [];
  let prevAssistantIdx = -1;
  let prevInputTokens = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.type !== 'assistant' || !msg.message?.usage) continue;

    const usage = msg.message.usage;
    const inputTokens = usage.input_tokens
      + (usage.cache_creation_input_tokens ?? 0)
      + (usage.cache_read_input_tokens ?? 0);

    if (prevAssistantIdx >= 0 && prevInputTokens - inputTokens > COMPACTION_DROP_THRESHOLD) {
      events.push({
        beforeIndex: prevAssistantIdx,
        afterIndex: i,
        tokensBefore: prevInputTokens,
        tokensAfter: inputTokens,
        tokensDropped: prevInputTokens - inputTokens,
        detection: 'heuristic',
      });
    }

    prevAssistantIdx = i;
    prevInputTokens = inputTokens;
  }

  return events;
}

/**
 * Build a CRUSTS bucket array from category token and accuracy maps.
 *
 * @param categoryTokens - Token counts per category
 * @param categoryAccuracy - Accuracy per category
 * @returns Array of CrustsBucket objects with percentages
 */
function buildBuckets(
  categoryTokens: Record<CrustsCategory, number>,
  categoryAccuracy: Record<CrustsCategory, 'exact' | 'estimated'>,
): CrustsBucket[] {
  const totalTokens = Object.values(categoryTokens).reduce((a, b) => a + b, 0);
  const categories: CrustsCategory[] = [
    'conversation', 'retrieved', 'user', 'system', 'tools', 'state',
  ];
  return categories.map((cat) => ({
    category: cat,
    tokens: categoryTokens[cat],
    percentage: totalTokens > 0 ? (categoryTokens[cat] / totalTokens) * 100 : 0,
    accuracy: categoryAccuracy[cat],
  }));
}

/**
 * Classify an entire session and produce a full CRUSTS breakdown.
 *
 * Walks through all messages, classifies each one, tracks per-tool usage,
 * and combines JSONL data with config data (system prompt sizes, MCP tool
 * counts, memory files) for the most accurate breakdown possible.
 *
 * Produces dual views:
 * - Session lifetime: all messages summed (the main breakdown)
 * - Current context: only post-last-compaction messages (if compaction occurred)
 *
 * By default, trims trailing messages that are part of a CRUSTS invocation
 * (the analysis command itself) so the breakdown reflects the context state
 * BEFORE the analysis was triggered. Pass `untilIndex` to override this
 * with a specific cutoff point.
 *
 * @param messages - Parsed session messages from scanner.parseSession()
 * @param configData - Config data from scanner (system prompt, MCP, memory, tools)
 * @param untilIndex - Optional message cutoff (exclusive). If set, disables auto-trim.
 * @returns Complete CRUSTS breakdown with per-message detail
 */
export function classifySession(
  messages: SessionMessage[],
  configData: ConfigData,
  untilIndex?: number,
): CrustsBreakdown {
  // Determine effective endpoint: explicit --until, or auto-trim CRUSTS invocation
  const effectiveEnd = untilIndex ?? findAnalysisCutoff(messages);
  const effectiveMessages = effectiveEnd < messages.length
    ? messages.slice(0, effectiveEnd)
    : messages;

  const toolUseIdMap = buildToolUseIdMap(effectiveMessages);
  const lastHumanIdx = findLastHumanTextIndex(effectiveMessages);

  // Detect compaction events
  const compactionEvents = detectCompactionEvents(effectiveMessages);

  // Track per-category totals (session lifetime)
  const categoryTokens: Record<CrustsCategory, number> = {
    conversation: 0,
    retrieved: 0,
    user: 0,
    system: 0,
    tools: 0,
    state: 0,
  };

  // Track accuracy per category — starts as 'exact', degrades to 'estimated'
  const categoryAccuracy: Record<CrustsCategory, 'exact' | 'estimated'> = {
    conversation: 'exact',
    retrieved: 'exact',
    user: 'exact',
    system: 'exact',
    tools: 'exact',
    state: 'exact',
  };

  // Track tools used in the session
  const usedToolNames = new Set<string>();
  let toolCallTokens = 0;
  let toolResultTokens = 0;

  // Classify each message
  const classifiedMessages: ClassifiedMessage[] = [];
  let cumulative = 0;

  for (let i = 0; i < effectiveMessages.length; i++) {
    const msg = effectiveMessages[i]!;
    const isLastHuman = i === lastHumanIdx;
    const isFirst = i === 0;

    const { category, toolName } = classifyMessage(msg, isLastHuman, isFirst, toolUseIdMap);
    const { tokens, accuracy } = estimateMessageTokens(msg);

    // Track tool usage
    if (toolName) usedToolNames.add(toolName);
    if (Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use' && block.name) {
          usedToolNames.add(block.name);
        }
      }
    }

    // Track tool call vs result tokens separately
    if (category === 'tools' || category === 'retrieved') {
      if (msg.type === 'assistant') {
        toolCallTokens += tokens;
      } else {
        toolResultTokens += tokens;
      }
    }

    cumulative += tokens;
    categoryTokens[category] += tokens;
    if (accuracy === 'estimated') {
      categoryAccuracy[category] = 'estimated';
    }

    classifiedMessages.push({
      index: i,
      category,
      tokens,
      cumulativeTokens: cumulative,
      accuracy,
      contentPreview: getContentPreview(msg),
      toolName,
    });
  }

  // Config overhead tokens (added to both lifetime and current context)
  const configOverhead = computeConfigOverhead(configData);

  // Derive overhead values from THIS SESSION's API usage data
  const derivedSystemPrompt = deriveInternalSystemPrompt(effectiveMessages, configData);
  // Framing derivation is deferred until after compaction detection (below)
  // so it can sample from the post-compaction window for cleaner data
  let derivedFraming: DerivedOverhead['messageFraming'] = null;

  // Add config overhead to session lifetime totals
  addConfigOverhead(categoryTokens, categoryAccuracy, configOverhead);

  // Add derived internal system prompt to System bucket
  if (derivedSystemPrompt) {
    categoryTokens.system += derivedSystemPrompt.tokens;
    categoryAccuracy.system = 'estimated';
  }

  // Calculate session lifetime totals
  const totalTokens = Object.values(categoryTokens).reduce((a, b) => a + b, 0);
  const buckets = buildBuckets(categoryTokens, categoryAccuracy);

  // Build loaded vs used tool lists
  const loadedTools = [
    ...configData.builtInTools.tools.map((t) => t.name),
    ...configData.mcpServers.map((s) => s.name),
  ];
  const usedToolsArray = [...usedToolNames];
  const unusedTools = loadedTools.filter((t) => !usedToolNames.has(t));

  const mcpSchemaTokens = configData.mcpServers.reduce(
    (sum, s) => sum + s.estimatedSchemaTokens, 0,
  );

  const toolBreakdown: ToolBreakdown = {
    loadedTools,
    usedTools: usedToolsArray,
    unusedTools,
    schemaTokens: configData.builtInTools.totalEstimatedTokens + mcpSchemaTokens,
    callTokens: toolCallTokens,
    resultTokens: toolResultTokens,
  };

  // Derive framing overhead from post-compaction window for cleaner data
  // (pre-compaction pairs span compaction boundaries and produce negative deltas)
  const framingStartIndex = compactionEvents.length > 0
    ? compactionEvents[compactionEvents.length - 1]!.afterIndex
    : 0;
  derivedFraming = deriveMessageFraming(effectiveMessages, classifiedMessages, framingStartIndex);

  // Add derived framing overhead — distribute proportionally across categories
  if (derivedFraming && derivedFraming.totalTokens > 0) {
    const msgCountByCategory: Record<CrustsCategory, number> = {
      conversation: 0, retrieved: 0, user: 0, system: 0, tools: 0, state: 0,
    };
    for (const cm of classifiedMessages) {
      msgCountByCategory[cm.category]++;
    }
    for (const cat of Object.keys(msgCountByCategory) as CrustsCategory[]) {
      const framingForCat = msgCountByCategory[cat] * derivedFraming.tokensPerMessage;
      if (framingForCat > 0) {
        categoryTokens[cat] += framingForCat;
        categoryAccuracy[cat] = 'estimated';
      }
    }
  }

  // Build current context view (post-last-compaction) if compaction occurred
  let currentContext: CrustsBreakdown['currentContext'] = undefined;
  if (compactionEvents.length > 0) {
    const lastCompaction = compactionEvents[compactionEvents.length - 1]!;
    const startIndex = lastCompaction.afterIndex;

    const currentCategoryTokens: Record<CrustsCategory, number> = {
      conversation: 0, retrieved: 0, user: 0, system: 0, tools: 0, state: 0,
    };
    const currentCategoryAccuracy: Record<CrustsCategory, 'exact' | 'estimated'> = {
      conversation: 'exact', retrieved: 'exact', user: 'exact',
      system: 'exact', tools: 'exact', state: 'exact',
    };

    for (let i = startIndex; i < classifiedMessages.length; i++) {
      const cm = classifiedMessages[i]!;
      currentCategoryTokens[cm.category] += cm.tokens;
      if (cm.accuracy === 'estimated') {
        currentCategoryAccuracy[cm.category] = 'estimated';
      }
    }

    // Add same config overhead to current context
    addConfigOverhead(currentCategoryTokens, currentCategoryAccuracy, configOverhead);

    // Add derived overhead to current context too
    if (derivedSystemPrompt) {
      currentCategoryTokens.system += derivedSystemPrompt.tokens;
      currentCategoryAccuracy.system = 'estimated';
    }
    if (derivedFraming && derivedFraming.tokensPerMessage > 0) {
      const currentMessages = classifiedMessages.slice(startIndex);
      const currentMsgCount: Record<CrustsCategory, number> = {
        conversation: 0, retrieved: 0, user: 0, system: 0, tools: 0, state: 0,
      };
      for (const cm of currentMessages) {
        currentMsgCount[cm.category]++;
      }
      for (const cat of Object.keys(currentMsgCount) as CrustsCategory[]) {
        const framingForCat = currentMsgCount[cat] * derivedFraming.tokensPerMessage;
        if (framingForCat > 0) {
          currentCategoryTokens[cat] += framingForCat;
          currentCategoryAccuracy[cat] = 'estimated';
        }
      }
    }

    const currentTotal = Object.values(currentCategoryTokens).reduce((a, b) => a + b, 0);
    currentContext = {
      buckets: buildBuckets(currentCategoryTokens, currentCategoryAccuracy),
      total_tokens: currentTotal,
      free_tokens: CONTEXT_LIMIT - currentTotal,
      usage_percentage: (currentTotal / CONTEXT_LIMIT) * 100,
      startIndex,
    };
  }

  // Extract model name from first non-synthetic assistant message
  const modelMsg = effectiveMessages.find(
    (m) => m.type === 'assistant' && m.message?.model && m.message.model !== '<synthetic>',
  );
  const model = modelMsg?.message?.model ?? 'unknown';

  // Compute session duration from first and last message timestamps
  let durationSeconds: number | null = null;
  const firstTs = effectiveMessages[0]?.timestamp;
  const lastTs = effectiveMessages[effectiveMessages.length - 1]?.timestamp;
  if (firstTs && lastTs) {
    const diffMs = new Date(lastTs).getTime() - new Date(firstTs).getTime();
    if (diffMs > 0) durationSeconds = Math.round(diffMs / 1000);
  }

  return {
    buckets,
    total_tokens: totalTokens,
    context_limit: CONTEXT_LIMIT,
    free_tokens: CONTEXT_LIMIT - totalTokens,
    usage_percentage: (totalTokens / CONTEXT_LIMIT) * 100,
    messages: classifiedMessages,
    toolBreakdown,
    model,
    durationSeconds,
    compactionEvents,
    currentContext,
    derivedOverhead: {
      internalSystemPrompt: derivedSystemPrompt,
      messageFraming: derivedFraming,
    },
  };
}

// ---------------------------------------------------------------------------
// Derived overhead — values computed from THIS SESSION's API usage data
// ---------------------------------------------------------------------------

/**
 * Derive the internal system prompt size from the first assistant message.
 *
 * The first assistant message's input_tokens represents the TOTAL context
 * sent to the API before any conversation happened. By subtracting all
 * known components (CLAUDE.md, tool schemas, memory, skills, first user
 * message), the residual is Claude Code's built-in system prompt.
 *
 * Different sessions will produce different values depending on model,
 * system prompt version, and tool configuration at the time.
 *
 * @param messages - Parsed session messages
 * @param configData - Config data from scanner
 * @returns Derivation result or null if insufficient data
 */
function deriveInternalSystemPrompt(
  messages: SessionMessage[],
  configData: ConfigData,
): DerivedOverhead['internalSystemPrompt'] {
  // Find first assistant message with usage data
  const firstAssistant = messages.find(
    (m) => m.type === 'assistant' && m.message?.usage && m.message.usage.input_tokens > 0,
  );
  if (!firstAssistant?.message?.usage) return null;

  const usage = firstAssistant.message.usage;
  const totalInput = usage.input_tokens
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0);

  // Known components
  const knownClaudeMd = configData.systemPrompt.totalEstimatedTokens;
  const knownToolSchemas = configData.builtInTools.totalEstimatedTokens;
  const knownMemory = configData.memoryFiles.totalEstimatedTokens;
  // Sum discovered skills' estimated cost. Falls back to 476 (the historical
  // /context ground-truth observation) when no skills are discovered, so
  // sessions on machines without skills configured keep their prior derivation.
  const discoveredSkillTokens = configData.skills.totalEstimatedTokens;
  const knownSkills = discoveredSkillTokens > 0 ? discoveredSkillTokens : 476;

  // Estimate first user message tokens
  let knownFirstUserMessage = 0;
  const firstUser = messages.find(
    (m) => m.type === 'user' && m.message?.role === 'user',
  );
  if (firstUser) {
    const { tokens } = estimateMessageTokens(firstUser);
    knownFirstUserMessage = tokens;
  }

  const totalKnown = knownClaudeMd + knownToolSchemas + knownMemory + knownSkills + knownFirstUserMessage;
  const derived = totalInput - totalKnown;

  // Sanity check: should be in plausible range for a system prompt (1K-15K)
  if (derived < 1000 || derived > 15000) {
    if (verbose) {
      console.error(
        `[CRUSTS debug] Internal system prompt derivation out of range: ${derived}`
        + ` (total_input=${totalInput}, known=${totalKnown}). Skipping.`,
      );
    }
    return null;
  }

  if (verbose) {
    console.error(
      `[CRUSTS derived] Internal system prompt: ${derived} tokens`
      + ` (first_assistant_input=${totalInput}`
      + `, claude_md=${knownClaudeMd}`
      + `, tool_schemas=${knownToolSchemas}`
      + `, memory=${knownMemory}`
      + `, skills=${knownSkills}`
      + `, first_user_msg=${knownFirstUserMessage}`
      + `, total_known=${totalKnown})`,
    );
  }

  return {
    tokens: derived,
    derivation: {
      firstAssistantInputTokens: totalInput,
      knownClaudeMd,
      knownToolSchemas,
      knownMemory,
      knownSkills,
      knownFirstUserMessage,
      totalKnown,
    },
  };
}

/**
 * Derive per-message framing overhead from consecutive assistant message pairs.
 *
 * For each pair of consecutive assistant messages (both with usage data),
 * compute: actual_delta = next_total_input - current_total_input.
 * Then compute expected_delta = sum of classified tokens for messages between.
 * The difference (actual - expected) / message_count = framing per message.
 *
 * Uses the median of up to 20 samples for robustness against outliers.
 * Different sessions will produce different values.
 *
 * @param messages - Parsed session messages (post-compaction subset if applicable)
 * @param classifiedMessages - Already-classified messages with token estimates
 * @param startIndex - Start index in messages to sample from (e.g., post-compaction)
 * @returns Derivation result or null if insufficient data
 */
function deriveMessageFraming(
  messages: SessionMessage[],
  classifiedMessages: ClassifiedMessage[],
  startIndex: number = 0,
): DerivedOverhead['messageFraming'] {
  // Find consecutive assistant message pairs with usage
  interface AssistantInfo {
    index: number;
    totalInput: number;
  }

  const assistants: AssistantInfo[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.type !== 'assistant' || !msg.message?.usage) continue;
    const u = msg.message.usage;
    const totalInput = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    if (totalInput > 0) {
      assistants.push({ index: i, totalInput });
    }
  }

  if (assistants.length < 3) return null;

  // Sample up to 20 consecutive pairs, preferring later messages (more stable)
  const maxSamples = 20;
  const startPair = Math.max(0, assistants.length - maxSamples - 1);
  const samples: number[] = [];

  for (let p = startPair; p < assistants.length - 1 && samples.length < maxSamples; p++) {
    const curr = assistants[p]!;
    const next = assistants[p + 1]!;

    const actualDelta = next.totalInput - curr.totalInput;
    // Skip pairs where input dropped (compaction or cache shift)
    if (actualDelta <= 0) continue;

    // Sum classified tokens for messages between curr and next (exclusive of both)
    let expectedDelta = 0;
    let msgCountBetween = 0;
    for (let i = curr.index; i < next.index; i++) {
      const cm = classifiedMessages[i];
      if (cm) {
        expectedDelta += cm.tokens;
        msgCountBetween++;
      }
    }

    if (msgCountBetween === 0) continue;

    const framingTotal = actualDelta - expectedDelta;
    const framingPerMsg = framingTotal / msgCountBetween;

    // Only accept plausible values (0-50 tokens/msg)
    if (framingPerMsg >= 0 && framingPerMsg <= 50) {
      samples.push(framingPerMsg);
    }
  }

  if (samples.length < 3) return null;

  // Take median
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const tokensPerMessage = Math.round(median);

  const totalTokens = tokensPerMessage * classifiedMessages.length;

  if (verbose) console.error(
    `[CRUSTS derived] Message framing: ${tokensPerMessage} tokens/msg`
    + ` (median of ${samples.length} samples, range ${sorted[0]!.toFixed(1)}-${sorted[sorted.length - 1]!.toFixed(1)})`
    + `, total overhead: ${totalTokens} tokens across ${classifiedMessages.length} messages`,
  );

  return {
    tokensPerMessage,
    totalTokens,
    sampleCount: samples.length,
    samples: sorted.map((s) => Math.round(s * 10) / 10),
  };
}

/** Config overhead values to add to category totals */
interface ConfigOverhead {
  systemTokens: number;
  toolTokens: number;
  mcpTokens: number;
  memoryTokens: number;
}

/**
 * Compute config overhead tokens from scanner data.
 *
 * @param configData - Config data from scanner
 * @returns Overhead token values per category
 */
function computeConfigOverhead(configData: ConfigData): ConfigOverhead {
  return {
    systemTokens: configData.systemPrompt.totalEstimatedTokens,
    toolTokens: configData.builtInTools.totalEstimatedTokens,
    mcpTokens: configData.mcpServers.reduce((sum, s) => sum + s.estimatedSchemaTokens, 0),
    memoryTokens: configData.memoryFiles.totalEstimatedTokens,
  };
}

/**
 * Add config overhead tokens to category totals (mutates in place).
 *
 * @param categoryTokens - Token totals per category
 * @param categoryAccuracy - Accuracy per category
 * @param overhead - Config overhead values
 */
function addConfigOverhead(
  categoryTokens: Record<CrustsCategory, number>,
  categoryAccuracy: Record<CrustsCategory, 'exact' | 'estimated'>,
  overhead: ConfigOverhead,
): void {
  if (overhead.systemTokens > 0) {
    categoryTokens.system += overhead.systemTokens;
    categoryAccuracy.system = 'estimated';
  }
  categoryTokens.tools += overhead.toolTokens;
  categoryAccuracy.tools = 'estimated';
  if (overhead.mcpTokens > 0) {
    categoryTokens.tools += overhead.mcpTokens;
  }
  if (overhead.memoryTokens > 0) {
    categoryTokens.state += overhead.memoryTokens;
    categoryAccuracy.state = 'estimated';
  }
}
