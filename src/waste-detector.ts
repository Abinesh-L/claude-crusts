/**
 * Waste and inefficiency detection.
 *
 * Scans classified session data for patterns that waste context window
 * space: stale file reads, duplicate reads, oversized system prompts,
 * resolved debug exchanges, cache overhead, and unused tool results.
 */

import type {
  SessionMessage,
  ContentBlock,
  CrustsBreakdown,
  ClassifiedMessage,
  WasteItem,
  ConfigData,
} from './types.ts';
import { loadWasteThresholds, describeThresholdOverrides } from './config.ts';

// Thresholds are bound at the top of `detectWaste` from user config (with
// defaults from `config.ts`). Kept as module-level `let`s so the internal
// helpers need no signature changes — the only public entrypoint is
// `detectWaste`, which always rebinds these before running its pipeline.

/** How many messages back before a file read is considered "stale" */
let STALE_READ_THRESHOLD = 15;

/** System prompt token threshold before we flag it as oversized */
let OVERSIZED_SYSTEM_THRESHOLD = 1_500;

/** Cache read ratio threshold before we warn */
let CACHE_OVERHEAD_THRESHOLD = 0.6;

/** Phrases that indicate a debug exchange was resolved */
const RESOLUTION_PHRASES = [
  'thanks',
  'thank you',
  'that works',
  'perfect',
  'great',
  'fixed',
  'solved',
  'got it',
  'looks good',
  'nice',
  'awesome',
  'exactly',
  'that did it',
  'working now',
];

/** Max messages to look back from a resolution marker */
let RESOLUTION_LOOKBACK = 10;

/** Characters per token estimation heuristic */
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Helper: extract file paths from tool_use Read calls
// ---------------------------------------------------------------------------

/** Info about a file read occurrence */
interface FileReadInfo {
  filePath: string;
  messageIndex: number;
  estimatedTokens: number;
}

/**
 * Extract file read operations from session messages.
 *
 * Scans for Read/FileReadTool tool_use blocks and extracts the file path
 * and message index for each.
 *
 * @param messages - All session messages
 * @param classified - Classified message data (for token estimates)
 * @returns Array of file read info objects
 */
function extractFileReads(
  messages: SessionMessage[],
  classified: ClassifiedMessage[],
): FileReadInfo[] {
  const reads: FileReadInfo[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (!Array.isArray(msg.message?.content)) continue;

    for (const block of msg.message.content) {
      if (block.type !== 'tool_use') continue;
      if (block.name !== 'Read' && block.name !== 'FileReadTool') continue;

      const filePath = block.input?.file_path as string | undefined
        ?? block.input?.path as string | undefined;
      if (!filePath) continue;

      // The token cost is on the tool_result message (next user message)
      const resultMsg = classified[i + 1];
      const tokens = resultMsg?.toolName === 'Read' || resultMsg?.toolName === 'FileReadTool'
        ? resultMsg.tokens
        : 0;

      reads.push({ filePath, messageIndex: i, estimatedTokens: tokens });
    }
  }

  return reads;
}

/**
 * Get all text content from messages after a given index.
 *
 * Used to check if a file path was referenced again in later conversation.
 *
 * @param messages - All session messages
 * @param afterIndex - Only consider messages after this index
 * @returns Concatenated text from subsequent messages
 */
function getSubsequentText(messages: SessionMessage[], afterIndex: number): string {
  const parts: string[] = [];

  for (let i = afterIndex + 1; i < messages.length; i++) {
    const msg = messages[i]!;
    const content = msg.message?.content;
    if (!content) continue;

    if (typeof content === 'string') {
      parts.push(content);
      continue;
    }

    for (const block of content) {
      if (block.text) parts.push(block.text);
      if (block.thinking) parts.push(block.thinking);
      if (typeof block.content === 'string') parts.push(block.content);
    }
  }

  return parts.join(' ');
}

/**
 * Extract the filename from a full path for reference checking.
 *
 * @param filePath - Full file path
 * @returns Just the filename portion
 */
function extractFilename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? filePath;
}

// ---------------------------------------------------------------------------
// Helper: extract file edit operations (Write/Edit tool_use)
// ---------------------------------------------------------------------------

/** Info about a file edit (Write or Edit tool_use) */
interface FileEditInfo {
  filePath: string;
  messageIndex: number;
}

/**
 * Extract file write/edit operations from session messages.
 *
 * Scans for Write/Edit tool_use blocks and extracts the target file path
 * and message index. Used to determine whether a file was modified between
 * consecutive reads (which makes a re-read valid, not waste).
 *
 * @param messages - All session messages
 * @returns Array of file edit info objects
 */
function extractFileEdits(messages: SessionMessage[]): FileEditInfo[] {
  const edits: FileEditInfo[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (!Array.isArray(msg.message?.content)) continue;

    for (const block of msg.message.content) {
      if (block.type !== 'tool_use') continue;
      if (block.name !== 'Write' && block.name !== 'Edit'
        && block.name !== 'FileWriteTool' && block.name !== 'FileEditTool'
        && block.name !== 'NotebookEdit') continue;

      const filePath = block.input?.file_path as string | undefined
        ?? block.input?.path as string | undefined;
      if (!filePath) continue;

      edits.push({ filePath: filePath.replace(/\\/g, '/').toLowerCase(), messageIndex: i });
    }
  }

  return edits;
}

// ---------------------------------------------------------------------------
// Individual waste detectors
// ---------------------------------------------------------------------------

/**
 * Detect stale file reads — files read more than 15 messages ago
 * that haven't been referenced since.
 *
 * @param messages - All session messages
 * @param classified - Classified message data
 * @returns Array of waste items for stale reads
 */
function detectStaleReads(
  messages: SessionMessage[],
  classified: ClassifiedMessage[],
): WasteItem[] {
  const items: WasteItem[] = [];
  const reads = extractFileReads(messages, classified);
  const totalMessages = messages.length;

  for (const read of reads) {
    const messageAge = totalMessages - read.messageIndex;
    if (messageAge <= STALE_READ_THRESHOLD) continue;
    if (read.estimatedTokens === 0) continue;

    const filename = extractFilename(read.filePath);
    const subsequentText = getSubsequentText(messages, read.messageIndex + 1);

    if (!subsequentText.includes(filename)) {
      items.push({
        type: 'stale_read',
        severity: 'high',
        description: `File "${filename}" was read at message #${read.messageIndex + 1} (${messageAge} messages ago) and not referenced since`,
        estimated_tokens: read.estimatedTokens,
        recommendation: `/compact focus: messages ${read.messageIndex + 1}-${read.messageIndex + 2}`,
        message_range: [read.messageIndex, read.messageIndex + 1],
      });
    }
  }

  return items;
}

/**
 * Detect duplicate file reads — same file path read multiple times
 * WITHOUT an intervening edit (Write/Edit) between consecutive reads.
 *
 * If a file was edited between two reads, the second read is valid
 * (reading updated content). Only reads with no intervening edit are
 * flagged as waste.
 *
 * @param messages - All session messages
 * @param classified - Classified message data
 * @returns Array of waste items for duplicate reads
 */
function detectDuplicateReads(
  messages: SessionMessage[],
  classified: ClassifiedMessage[],
): WasteItem[] {
  const items: WasteItem[] = [];
  const reads = extractFileReads(messages, classified);
  const edits = extractFileEdits(messages);

  // Group reads by normalized file path
  const byPath = new Map<string, FileReadInfo[]>();
  for (const read of reads) {
    const normalized = read.filePath.replace(/\\/g, '/').toLowerCase();
    const existing = byPath.get(normalized);
    if (existing) {
      existing.push(read);
    } else {
      byPath.set(normalized, [read]);
    }
  }

  for (const [normalizedPath, pathReads] of byPath) {
    if (pathReads.length < 2) continue;

    // Sort by message index
    pathReads.sort((a, b) => a.messageIndex - b.messageIndex);

    // Get all edits to this file, sorted by message index
    const fileEdits = edits
      .filter((e) => e.filePath === normalizedPath)
      .sort((a, b) => a.messageIndex - b.messageIndex);

    // Check each consecutive pair of reads for intervening edits
    const redundantReads: FileReadInfo[] = [];
    for (let i = 0; i < pathReads.length - 1; i++) {
      const thisRead = pathReads[i]!;
      const nextRead = pathReads[i + 1]!;

      // Was there a Write/Edit between this read and the next?
      const hasInterveningEdit = fileEdits.some(
        (e) => e.messageIndex > thisRead.messageIndex && e.messageIndex < nextRead.messageIndex,
      );

      if (!hasInterveningEdit) {
        // No edit between reads — the earlier read is waste
        redundantReads.push(thisRead);
      }
    }

    if (redundantReads.length === 0) continue;

    const wasteTokens = redundantReads.reduce((sum, r) => sum + r.estimatedTokens, 0);
    const filename = extractFilename(pathReads[0]!.filePath);

    if (wasteTokens > 0) {
      const totalReads = pathReads.length;
      const validReReads = totalReads - 1 - redundantReads.length;
      const ranges = redundantReads.map((d) => `#${d.messageIndex + 1}`).join(', ');

      let desc = `"${filename}" read ${totalReads} times`;
      if (validReReads > 0) {
        desc += ` (${validReReads} re-read${validReReads > 1 ? 's' : ''} after edits OK; reads at ${ranges} are redundant)`;
      } else {
        desc += ` (earlier reads at ${ranges} are redundant)`;
      }

      items.push({
        type: 'duplicate_read',
        severity: 'medium',
        description: desc,
        estimated_tokens: wasteTokens,
        recommendation: `Avoid re-reading files that haven't changed. Consider using /compact to remove stale reads.`,
        message_range: [redundantReads[0]!.messageIndex, redundantReads[redundantReads.length - 1]!.messageIndex + 1],
      });
    }
  }

  return items;
}

/**
 * Detect oversized system prompt — system instructions exceeding
 * the threshold token count.
 *
 * @param configData - Config data with system prompt file info
 * @returns Array of waste items (0 or 1) for oversized system prompt
 */
function detectOversizedSystem(configData: ConfigData): WasteItem[] {
  const total = configData.systemPrompt.totalEstimatedTokens;
  if (total <= OVERSIZED_SYSTEM_THRESHOLD) return [];

  const fileList = configData.systemPrompt.files
    .map((f) => {
      const name = f.path.replace(/\\/g, '/').split('/').pop() ?? f.path;
      return `${name} (~${f.estimatedTokens} tokens)`;
    })
    .join(', ');

  return [{
    type: 'oversized_system',
    severity: 'medium',
    description: `System prompt is ~${total.toLocaleString()} tokens (${fileList})`,
    estimated_tokens: total - OVERSIZED_SYSTEM_THRESHOLD,
    recommendation: 'Split CLAUDE.md into CLAUDE.md (essentials) + CLAUDE.local.md (project-specific details) to reduce base context cost.',
  }];
}

/**
 * Detect resolved debug exchanges — conversation patterns where the
 * user confirmed resolution, making the preceding exchange compactable.
 *
 * @param messages - All session messages
 * @param classified - Classified message data
 * @returns Array of waste items for resolved exchanges
 */
function detectResolvedExchanges(
  messages: SessionMessage[],
  classified: ClassifiedMessage[],
): WasteItem[] {
  const items: WasteItem[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    // Only check real user text messages
    if (msg.type !== 'user') continue;
    const content = msg.message?.content;
    if (!content || typeof content !== 'string') {
      if (!Array.isArray(content)) continue;
      // Check text blocks in array content
      const hasToolResult = content.some((b) => b.type === 'tool_result');
      if (hasToolResult) continue;
    }

    // Extract text from this message
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join(' ');
    }

    const textLower = text.toLowerCase().trim();
    if (!textLower) continue;

    // Check if this message contains a resolution phrase
    // Only match short messages (likely confirmations, not new requests)
    if (textLower.length > 100) continue;
    const isResolution = RESOLUTION_PHRASES.some((phrase) => textLower.includes(phrase));
    if (!isResolution) continue;

    // Look back up to RESOLUTION_LOOKBACK messages for the exchange
    const lookbackStart = Math.max(0, i - RESOLUTION_LOOKBACK);
    let exchangeTokens = 0;
    for (let j = lookbackStart; j < i; j++) {
      const cm = classified[j];
      if (cm && (cm.category === 'conversation' || cm.category === 'tools' || cm.category === 'retrieved')) {
        exchangeTokens += cm.tokens;
      }
    }

    if (exchangeTokens > 500) {
      items.push({
        type: 'resolved_exchange',
        severity: 'high',
        description: `Resolved exchange before message #${i + 1} ("${textLower.slice(0, 40)}") — preceding discussion is compactable`,
        estimated_tokens: exchangeTokens,
        recommendation: `/compact focus: messages ${lookbackStart + 1}-${i + 1}`,
        message_range: [lookbackStart, i],
      });
    }
  }

  return items;
}

/**
 * Detect excessive cache overhead — when cache_read_input_tokens
 * dominate the token usage, indicating system prompt and tool schemas
 * are consuming a large portion of effective context.
 *
 * @param messages - All session messages
 * @returns Array of waste items (0 or 1) for cache overhead
 */
function detectCacheOverhead(messages: SessionMessage[]): WasteItem[] {
  let totalInput = 0;
  let totalCacheRead = 0;

  for (const msg of messages) {
    const usage = msg.message?.usage;
    if (!usage) continue;

    totalInput += usage.input_tokens
      + (usage.cache_creation_input_tokens ?? 0)
      + (usage.cache_read_input_tokens ?? 0);
    totalCacheRead += usage.cache_read_input_tokens ?? 0;
  }

  if (totalInput === 0) return [];

  const ratio = totalCacheRead / totalInput;
  if (ratio <= CACHE_OVERHEAD_THRESHOLD) return [];

  const pct = (ratio * 100).toFixed(1);
  return [{
    type: 'cache_overhead',
    severity: 'info',
    description: `Cache reads are ${pct}% of total input — system prompt + tool schemas are re-sent every turn`,
    estimated_tokens: 0,
    recommendation: 'Reduce CLAUDE.md size and disable unused MCP servers to lower per-turn cache cost. High cache overhead increases per-turn cost.',
  }];
}

/**
 * Detect unused tool results — tool results that were returned but
 * the assistant never referenced the content in subsequent text responses.
 *
 * @param messages - All session messages
 * @param classified - Classified message data
 * @returns Array of waste items for unused results
 */
function detectUnusedResults(
  messages: SessionMessage[],
  classified: ClassifiedMessage[],
): WasteItem[] {
  const items: WasteItem[] = [];

  // Build tool_use ID -> name map
  const toolUseNames = new Map<string, string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.message?.content)) continue;
    for (const block of msg.message.content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        toolUseNames.set(block.id, block.name);
      }
    }
  }

  // Find tool_result messages and check if assistant referenced them
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (!Array.isArray(msg.message?.content)) continue;

    for (const block of msg.message.content) {
      if (block.type !== 'tool_result') continue;
      if (block.is_error) continue; // Errors are always referenced

      const toolName = block.tool_use_id
        ? toolUseNames.get(block.tool_use_id)
        : undefined;

      // Skip retrieval tools — they're often consumed implicitly
      if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') continue;

      // Get the result content for fingerprinting
      const resultContent = typeof block.content === 'string' ? block.content : '';
      if (resultContent.length < 200) continue; // Only flag large results

      // Check if the next assistant text message references this result
      let referenced = false;
      for (let j = i + 1; j < Math.min(i + 5, messages.length); j++) {
        const nextMsg = messages[j]!;
        if (nextMsg.type !== 'assistant') continue;
        if (!Array.isArray(nextMsg.message?.content)) continue;

        for (const nextBlock of nextMsg.message.content) {
          if (nextBlock.type === 'text' && nextBlock.text) {
            // Simple heuristic: check if assistant mentions key parts of the result
            // Use first 50 chars as a fingerprint
            const fingerprint = resultContent.slice(0, 50).trim();
            if (fingerprint && nextBlock.text.includes(fingerprint)) {
              referenced = true;
            }
            // Also count as referenced if assistant produces any text after it
            // (it likely used the result internally)
            if (nextBlock.text.length > 50) {
              referenced = true;
            }
          }
        }
        if (referenced) break;
      }

      if (!referenced) {
        const cm = classified[i];
        const tokens = cm?.tokens ?? Math.ceil(resultContent.length / CHARS_PER_TOKEN);
        if (tokens > 100) {
          items.push({
            type: 'unused_result',
            severity: 'low',
            description: `${toolName ?? 'Tool'} result at message #${i + 1} (~${tokens} tokens) appears unused by assistant`,
            estimated_tokens: tokens,
            recommendation: 'Consider whether this tool call was necessary. Unused results waste context space.',
            message_range: [i, i],
          });
        }
      }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Detect all waste and inefficiencies in a classified session.
 *
 * When compaction has occurred, only detects waste in the current context
 * (post-last-compaction messages). This avoids flagging waste that was
 * already compacted away and no longer occupies context space.
 *
 * Runs all waste detection rules and returns a combined list of waste items,
 * sorted by severity (high first) then by estimated token savings (largest first).
 *
 * @param messages - Parsed session messages
 * @param breakdown - CRUSTS classification breakdown
 * @param configData - Config data from scanner
 * @returns Array of WasteItem objects sorted by impact
 */
export function detectWaste(
  messages: SessionMessage[],
  breakdown: CrustsBreakdown,
  configData: ConfigData,
): WasteItem[] {
  // Apply user-configured thresholds from ~/.claude-crusts/config.json
  // (falls through to defaults for unset keys).
  const thresholds = loadWasteThresholds();
  STALE_READ_THRESHOLD = thresholds.staleReadThreshold;
  OVERSIZED_SYSTEM_THRESHOLD = thresholds.oversizedSystemThreshold;
  CACHE_OVERHEAD_THRESHOLD = thresholds.cacheOverheadThreshold;
  RESOLUTION_LOOKBACK = thresholds.resolutionLookback;

  // If compaction occurred, only analyze post-compaction messages
  const startIndex = breakdown.currentContext?.startIndex ?? 0;
  const effectiveMessages = startIndex > 0 ? messages.slice(startIndex) : messages;
  const effectiveClassified = startIndex > 0 ? breakdown.messages.slice(startIndex) : breakdown.messages;

  const items: WasteItem[] = [
    ...detectStaleReads(effectiveMessages, effectiveClassified),
    ...detectDuplicateReads(effectiveMessages, effectiveClassified),
    ...detectOversizedSystem(configData),
    ...detectResolvedExchanges(effectiveMessages, effectiveClassified),
    ...detectCacheOverhead(messages), // Cache overhead uses full session (cumulative API data)
    ...detectUnusedResults(effectiveMessages, effectiveClassified),
  ];

  // Sort: high severity first, then by token savings descending
  const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
  items.sort((a, b) => {
    const sevDiff = (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4);
    if (sevDiff !== 0) return sevDiff;
    return b.estimated_tokens - a.estimated_tokens;
  });

  return items;
}
