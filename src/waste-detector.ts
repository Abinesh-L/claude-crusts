/**
 * Waste and inefficiency detection.
 *
 * Scans classified session data for patterns that waste context window
 * space: stale file reads, duplicate reads, oversized system prompts,
 * resolved debug exchanges and unused tool results. One rule measures cost
 * rather than window space: cache overhead, the prompt-cache writes that
 * repeated content already cached (see `cache-rewrites.ts`).
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
import { isHumanUserText } from './classifier.ts';
import { findCacheRewrites, CACHE_TTL_MS } from './cache-rewrites.ts';
import type { CacheRewrite, CacheRewriteCause, CacheTtl } from './cache-rewrites.ts';

// Thresholds are bound at the top of `detectWaste` from user config (with
// defaults from `config.ts`). Kept as module-level `let`s so the internal
// helpers need no signature changes — the only public entrypoint is
// `detectWaste`, which always rebinds these before running its pipeline.

/** How many messages back before a file read is considered "stale" */
let STALE_READ_THRESHOLD = 15;

/** System prompt token threshold before we flag it as oversized */
let OVERSIZED_SYSTEM_THRESHOLD = 1_500;

/** Share of a session's cache-write tokens spent re-writing cached content before we warn */
let CACHE_REWRITE_THRESHOLD = 0.25;

/**
 * Fewest re-written tokens worth an item. Below this a session re-wrote
 * less than a fresh session writes for its fixed context and first prompt,
 * so even a large share is noise.
 */
const CACHE_REWRITE_MIN_TOKENS = 50_000;

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

/** Where a tool call's result was recorded */
interface ToolResultRef {
  /** Index of the user record that carries the tool_result block */
  index: number;
  /** The tool_result block itself */
  block: ContentBlock;
  /** The record; its `toolUseResult` is Claude Code's structured copy of the result */
  record: SessionMessage;
}

/** Info about a file read occurrence */
interface FileReadInfo {
  filePath: string;
  messageIndex: number;
  /** Position of the tool_use block inside its record (orders calls that share a record) */
  blockIndex: number;
  estimatedTokens: number;
  /** The call's input (`file_path`, `offset`, `limit`, `pages`) */
  input: Record<string, unknown>;
  /** The call's recorded result; absent when none was recorded */
  result?: ToolResultRef;
}

/**
 * Index every tool_result block by the id of the tool_use it answers.
 *
 * A call's result is not always the next record: Claude Code writes
 * parallel calls as consecutive assistant lines followed by their results
 * (13% of Read calls on the owner's transcripts), so a lookup by position
 * picks up the wrong record.
 *
 * @param messages - Session messages
 * @returns tool_use id -> where its result was recorded
 */
function indexToolResults(messages: SessionMessage[]): Map<string, ToolResultRef> {
  const results = new Map<string, ToolResultRef>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.type !== 'user' || !Array.isArray(msg.message?.content)) continue;

    for (const block of msg.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        results.set(block.tool_use_id, { index: i, block, record: msg });
      }
    }
  }

  return results;
}

/**
 * Estimated window tokens of one tool_result: its classified row's tokens,
 * or the block's size share of the row when the record carries more than
 * one block.
 *
 * @param result - Where the result was recorded
 * @param classified - Classified rows, index-aligned with the messages
 * @returns Estimated tokens, 0 when the record is outside the classified rows
 */
function resultTokens(result: ToolResultRef, classified: ClassifiedMessage[]): number {
  const row = classified[result.index];
  if (!row) return 0;

  const content = result.record.message?.content;
  if (!Array.isArray(content) || content.length <= 1) return row.tokens;

  const size = (block: ContentBlock): number => JSON.stringify(block).length;
  const total = content.reduce((sum, block) => sum + size(block), 0);
  return total > 0 ? Math.round((row.tokens * size(result.block)) / total) : 0;
}

/**
 * First string value among the given keys of a tool input.
 *
 * @param input - Tool input object
 * @param keys - Keys to try in order
 * @returns The first string found, or undefined
 */
function stringField(input: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/**
 * Normalise a file path for grouping: forward slashes, lower case.
 *
 * @param filePath - Path as written in a tool input
 * @returns Comparison key
 */
function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

/**
 * Extract file read operations from session messages.
 *
 * Scans for Read/FileReadTool tool_use blocks and extracts the file path,
 * message index, input and recorded result for each. The token cost is the
 * call's own tool_result record, found by tool_use id.
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
  const results = indexToolResults(messages);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (!Array.isArray(msg.message?.content)) continue;

    msg.message.content.forEach((block, blockIndex) => {
      if (block.type !== 'tool_use') return;
      if (block.name !== 'Read' && block.name !== 'FileReadTool') return;

      const filePath = stringField(block.input, 'file_path', 'path');
      if (!filePath) return;

      const result = block.id ? results.get(block.id) : undefined;
      reads.push({
        filePath,
        messageIndex: i,
        blockIndex,
        estimatedTokens: result ? resultTokens(result, classified) : 0,
        input: block.input ?? {},
        ...(result ? { result } : {}),
      });
    });
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
  /** Normalised path (see `normalizeFilePath`) */
  filePath: string;
  messageIndex: number;
  /** Position of the tool_use block inside its record */
  blockIndex: number;
}

/** Tools that change a file on disk (current and legacy names) */
const EDIT_TOOL_NAMES = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'FileEditTool', 'FileWriteTool',
]);

/**
 * Extract file write/edit operations from session messages.
 *
 * Scans for Edit, Write, MultiEdit and NotebookEdit tool_use blocks (and
 * the legacy FileEditTool / FileWriteTool names) and extracts the target
 * file path (`file_path`, NotebookEdit's `notebook_path`, or a legacy
 * `path`) and message index. Used to determine whether a file was modified
 * between reads (which makes a re-read valid, not waste).
 *
 * A call that failed counts too: Claude Code refuses to edit a file that
 * changed since it was last read until the model reads it again, and after
 * a rejected or failed edit the model has to check the file's state.
 *
 * @param messages - All session messages
 * @returns Array of file edit info objects
 */
function extractFileEdits(messages: SessionMessage[]): FileEditInfo[] {
  const edits: FileEditInfo[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (!Array.isArray(msg.message?.content)) continue;

    msg.message.content.forEach((block, blockIndex) => {
      if (block.type !== 'tool_use' || !block.name || !EDIT_TOOL_NAMES.has(block.name)) return;

      const filePath = stringField(block.input, 'file_path', 'notebook_path', 'path');
      if (!filePath) return;

      edits.push({ filePath: normalizeFilePath(filePath), messageIndex: i, blockIndex });
    });
  }

  return edits;
}

// ---------------------------------------------------------------------------
// Helper: what each Read delivered to the model
// ---------------------------------------------------------------------------

/**
 * Starts of the results Claude Code returns instead of file content: a Read
 * that repeats the previous read of an unchanged file with the same offset
 * and limit (2.1.86+; the wording changed in later versions), and a Read of
 * a CLAUDE.md or memory file already loaded at startup. Claude Code
 * recognises its own stubs by these prefixes.
 */
const UNCHANGED_READ_STUBS = [
  'File unchanged since last read',
  'Wasted call',
  '<system-reminder>This file is already in your context',
];

/**
 * A Read result with no numbered lines and no media at or under this many
 * characters is a notice (an empty file, an offset past the end, a stub
 * this list does not know), not file content.
 */
const TINY_READ_RESULT_CHARS = 400;

/**
 * Start of one line of Read output: the line number, then a tab, a colon
 * (2.1.3xx, for files with tab-indented lines) or an arrow (the padded
 * cat -n format before 2.1.86).
 */
const NUMBERED_LINE = /^\s*(\d+)(?:\t|:|\u2192)/;

/** At most this many redundant reads are listed in a duplicate description */
const MAX_LISTED_READS = 8;

/**
 * Smallest repeated share of a file worth reporting, in tokens (the floor
 * the unused-result rule and `optimize --min-savings` use). Below it sit
 * the few lines of context a model re-reads where one page of a file meets
 * the next: 39 of 44 duplicate files on the owner's transcripts, at most
 * 78 tokens each.
 */
const MIN_DUPLICATE_TOKENS = 100;

/** A half-open run of lines `[start, end)` (1-based) */
type LineSpan = [number, number];

/** What one Read put in the window */
interface ReadDelivery {
  /** First line delivered (1-based; first page for a PDF `pages` read) */
  start: number;
  /** One past the last line delivered; Infinity when the extent is unknown (an image, a notebook) */
  end: number;
  /** Delivered text by line number, to tell an unchanged copy from new content */
  lines?: Map<number, string>;
  /** The whole delivered content, for results without numbered lines */
  fingerprint?: string;
}

/**
 * The text of a tool_result: its string content, or its text blocks joined.
 *
 * @param block - A tool_result block
 * @returns The result text ('' when there is none)
 */
function resultText(block: ContentBlock): string {
  if (typeof block.content === 'string') return block.content;
  if (!Array.isArray(block.content)) return '';
  return block.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

/**
 * Claude Code's structured copy of a Read result, when it wrote one: the
 * result `type` ('text', 'file_unchanged', 'image', 'pdf', ...) and, for
 * text, the first line and the number of lines delivered.
 *
 * @param toolUseResult - The record's `toolUseResult`
 * @returns The fields read, or null when absent (subagent transcripts mostly lack it)
 */
function structuredRead(toolUseResult: unknown): { type?: string; startLine?: number; numLines?: number } | null {
  if (!toolUseResult || typeof toolUseResult !== 'object') return null;
  const value = toolUseResult as { type?: unknown; file?: { startLine?: unknown; numLines?: unknown } };
  const file = value.file && typeof value.file === 'object' ? value.file : undefined;
  return {
    ...(typeof value.type === 'string' ? { type: value.type } : {}),
    ...(typeof file?.startLine === 'number' ? { startLine: file.startLine } : {}),
    ...(typeof file?.numLines === 'number' ? { numLines: file.numLines } : {}),
  };
}

/**
 * Map each numbered line of a Read result to its text (the number and the
 * separator removed). Lines without a number (reminders, truncation
 * notices) are skipped.
 *
 * @param text - Result text
 * @returns Line number -> line text
 */
function numberedLines(text: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of text.split('\n')) {
    const match = NUMBERED_LINE.exec(line);
    if (match) lines.set(Number(match[1]), line.slice(match[0].length));
  }
  return lines;
}

/**
 * The page span a PDF Read asked for (`pages: "3"` or `"1-5"`).
 *
 * @param pages - The `pages` input value
 * @returns `[first, last + 1)`, or null when absent or not a simple range
 */
function pagesSpan(pages: unknown): LineSpan | null {
  if (typeof pages !== 'string') return null;
  const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(pages);
  if (!match) return null;
  const first = Number(match[1]);
  const last = match[2] !== undefined ? Number(match[2]) : first;
  return last >= first ? [first, last + 1] : null;
}

/**
 * Work out which lines of a file one Read delivered to the model.
 *
 * Sources, most exact first: Claude Code's structured result
 * (`toolUseResult.file.startLine` / `numLines`, written on main-session
 * records), else the numbers that prefix every line of the result text.
 * `offset` is the 1-based first line, so `offset: 201, limit: 200`
 * delivers lines 201-400; a call without `limit` delivers the whole file
 * only when it fits Claude Code's default line limit and token cap, which
 * is why the delivered lines are used rather than the input. Results
 * without numbered lines (images, PDFs, notebooks) cover the whole file,
 * or the `pages` they asked for.
 *
 * @param read - One Read call
 * @returns The delivered lines, or null when the call put no file content
 *   in the window: no result, an error, Claude Code's unchanged-file stub,
 *   or a short notice
 */
function readDelivery(read: FileReadInfo): ReadDelivery | null {
  const result = read.result;
  if (!result || result.block.is_error === true) return null;

  const structured = structuredRead(result.record.toolUseResult);
  const text = resultText(result.block);
  if (structured?.type === 'file_unchanged') return null;
  const head = text.slice(0, 200).trimStart();
  if (UNCHANGED_READ_STUBS.some((stub) => head.startsWith(stub))) return null;

  const lines = numberedLines(text);
  if (structured?.type === 'text' && structured.startLine !== undefined && structured.numLines !== undefined) {
    const start = Math.max(1, structured.startLine);
    return structured.numLines > 0 ? { start, end: start + structured.numLines, lines } : null;
  }
  if (lines.size > 0) {
    let first = Infinity;
    let last = -Infinity;
    for (const n of lines.keys()) {
      if (n < first) first = n;
      if (n > last) last = n;
    }
    return { start: first, end: last + 1, lines };
  }

  const content = result.block.content;
  const hasMedia = Array.isArray(content)
    && content.some((b) => b.type === 'image' || b.type === 'document');
  if (!hasMedia && text.length <= TINY_READ_RESULT_CHARS) return null;

  const pages = pagesSpan(read.input.pages);
  return {
    start: pages?.[0] ?? 1,
    end: pages?.[1] ?? Infinity,
    fingerprint: typeof content === 'string' ? content : JSON.stringify(content ?? ''),
  };
}

/**
 * True when two reads delivered different text for lines both of them
 * cover: the file changed between them without an edit call (a shell
 * command, a formatter, the user's editor), so the later read is current
 * content, not a copy.
 *
 * @param earlier - What the earlier read delivered
 * @param later - What the later read delivered
 * @param span - The lines both reads cover
 * @returns True when the shared lines differ
 */
function deliveredDifferently(earlier: ReadDelivery, later: ReadDelivery, span: LineSpan): boolean {
  // Reads with text always have a finite extent, so the span is finite here
  if (earlier.lines && later.lines && earlier.lines.size > 0 && later.lines.size > 0) {
    for (let n = span[0]; n < span[1]; n++) {
      const text = earlier.lines.get(n);
      const again = later.lines.get(n);
      if (text !== undefined && again !== undefined && text !== again) return true;
    }
    return false;
  }
  if (earlier.fingerprint !== undefined && later.fingerprint !== undefined) {
    return earlier.fingerprint !== later.fingerprint;
  }
  return false;
}

/**
 * Add a span to a sorted list of disjoint spans, merging any it overlaps
 * or touches.
 *
 * @param spans - Sorted, disjoint spans
 * @param span - Span to add
 * @returns The merged, sorted list
 */
function addSpan(spans: LineSpan[], span: LineSpan): LineSpan[] {
  const merged: LineSpan[] = [];
  let [start, end] = span;
  for (const [s, e] of spans) {
    if (e < start || s > end) {
      merged.push([s, e]);
    } else {
      start = Math.min(start, s);
      end = Math.max(end, e);
    }
  }
  merged.push([start, end]);
  return merged.sort((a, b) => a[0] - b[0]);
}

/**
 * Share of what a read delivered that later reads delivered again.
 *
 * Lines are weighed by their text (plus one for the line break) when the
 * read's text is known, since a long line costs more tokens than a blank
 * one; otherwise each line counts the same.
 *
 * @param delivered - What the read delivered
 * @param covered - Disjoint spans inside it that later reads repeated
 * @returns 0..1; for a read of unknown extent, 1 only when a later read
 *   repeated all of it
 */
function coveredShare(delivered: ReadDelivery, covered: LineSpan[]): number {
  const length = delivered.end - delivered.start;
  if (!Number.isFinite(length)) {
    return covered.some(([s, e]) => s <= delivered.start && e === Infinity) ? 1 : 0;
  }
  if (delivered.lines && delivered.lines.size > 0) {
    let all = 0;
    let repeated = 0;
    for (const [n, text] of delivered.lines) {
      const weight = text.length + 1;
      all += weight;
      if (covered.some(([s, e]) => n >= s && n < e)) repeated += weight;
    }
    return all > 0 ? repeated / all : 0;
  }
  const repeated = covered.reduce((sum, [s, e]) => sum + (e - s), 0);
  return length > 0 ? Math.min(1, repeated / length) : 0;
}

/**
 * Inclusive line ranges for a description: "line 5", "lines 120-180",
 * "lines 1-40 and 90-120"; beyond two ranges, the rest are counted.
 *
 * @param spans - Half-open spans (at least one)
 * @returns Plain text
 */
function describeSpans(spans: LineSpan[]): string {
  const label = ([s, e]: LineSpan): string => (e - s === 1 ? `${s}` : `${s}-${e - 1}`);
  if (spans.length === 1) {
    const [s, e] = spans[0]!;
    return `${e - s === 1 ? 'line' : 'lines'} ${label(spans[0]!)}`;
  }
  if (spans.length === 2) return `lines ${spans.map(label).join(' and ')}`;
  const others = spans.length - 1;
  return `lines ${label(spans[0]!)} and ${others} other ranges`;
}

/**
 * True when tool call `a` comes after tool call `b` in the transcript.
 *
 * @param a - Position of the first call
 * @param b - Position of the second call
 * @returns Whether `a` is later
 */
function isAfter(
  a: { messageIndex: number; blockIndex: number },
  b: { messageIndex: number; blockIndex: number },
): boolean {
  return a.messageIndex > b.messageIndex
    || (a.messageIndex === b.messageIndex && a.blockIndex > b.blockIndex);
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

/** One earlier read whose content a later read delivered again */
interface RedundantRead {
  read: FileReadInfo;
  /** The lines of it that were delivered again */
  spans: LineSpan[];
  /** Every delivered line was delivered again */
  full: boolean;
  /** The repeated share of its tokens */
  tokens: number;
}

/**
 * Detect duplicate file reads: content of a file that a later Read put in
 * the window again while the earlier copy was still current.
 *
 * Range-aware: each Read covers the lines it delivered (see
 * `readDelivery`), so paging through a file (lines 1-200, then 201-400) is
 * not a duplicate. An earlier read is waste only for the part a later read
 * of the same file delivered again, and is sized as that share of its
 * tokens. A file is reported once its repeated share reaches
 * `MIN_DUPLICATE_TOKENS`.
 *
 * Edit-aware: an Edit, Write, MultiEdit or NotebookEdit of the file between
 * the two reads makes the earlier copy stale rather than duplicated, so it
 * is not flagged. The same holds when the two reads delivered different
 * text for the same lines: the file changed some other way (a shell
 * command, a formatter, the user's editor).
 *
 * A later read that delivered no content does not count: Claude Code's
 * unchanged-file stub (same offset and limit as the previous read of an
 * unchanged file) gives the model no second copy, nor does an error or a
 * notice.
 *
 * Only the analysed rows are scanned (`classified`), so records after an
 * analysis cutoff or `--until` cannot make an earlier read redundant.
 *
 * @param messages - All session messages
 * @param classified - Classified message data
 * @returns Array of waste items for duplicate reads (one per file)
 */
function detectDuplicateReads(
  messages: SessionMessage[],
  classified: ClassifiedMessage[],
): WasteItem[] {
  const items: WasteItem[] = [];
  const analysed = messages.length > classified.length ? messages.slice(0, classified.length) : messages;
  const reads = extractFileReads(analysed, classified);
  const edits = extractFileEdits(analysed);

  // Group reads by normalized file path (extraction keeps transcript order)
  const byPath = new Map<string, FileReadInfo[]>();
  for (const read of reads) {
    const normalized = normalizeFilePath(read.filePath);
    const existing = byPath.get(normalized);
    if (existing) {
      existing.push(read);
    } else {
      byPath.set(normalized, [read]);
    }
  }

  for (const [normalizedPath, pathReads] of byPath) {
    if (pathReads.length < 2) continue;

    const fileEdits = edits.filter((e) => e.filePath === normalizedPath);
    const deliveries = pathReads.map(readDelivery);

    const redundant: RedundantRead[] = [];
    for (let i = 0; i < pathReads.length - 1; i++) {
      const earlier = pathReads[i]!;
      const delivered = deliveries[i];
      if (!delivered || earlier.estimatedTokens <= 0) continue;

      // Lines of the earlier read that later reads delivered again, up to
      // the first edit or content change (after which it is stale for good)
      const firstEdit = fileEdits.find((e) => isAfter(e, earlier));
      let covered: LineSpan[] = [];
      for (let j = i + 1; j < pathReads.length; j++) {
        const later = pathReads[j]!;
        if (firstEdit && isAfter(later, firstEdit)) break;

        const again = deliveries[j];
        if (!again) continue;
        const span: LineSpan = [Math.max(delivered.start, again.start), Math.min(delivered.end, again.end)];
        if (span[0] >= span[1]) continue;
        if (deliveredDifferently(delivered, again, span)) break;
        covered = addSpan(covered, span);
        const whole = covered[0]!;
        if (covered.length === 1 && whole[0] <= delivered.start && whole[1] >= delivered.end) break;
      }
      if (covered.length === 0) continue;

      const share = coveredShare(delivered, covered);
      const tokens = Math.round(earlier.estimatedTokens * share);
      if (tokens <= 0) continue;
      redundant.push({ read: earlier, spans: covered, full: share >= 1, tokens });
    }

    const wasteTokens = redundant.reduce((sum, r) => sum + r.tokens, 0);
    if (wasteTokens < MIN_DUPLICATE_TOKENS) continue;

    // Consumers parse this text: `"<file>" read <n> times` and
    // `reads at <locations> are` (locations must not contain ')').
    const filename = extractFilename(pathReads[0]!.filePath);
    const listed = redundant.slice(0, MAX_LISTED_READS).map((r) => {
      const at = `#${r.read.messageIndex + 1}`;
      return r.full ? at : `${at} ${describeSpans(r.spans)}`;
    });
    const unlisted = redundant.length - listed.length;
    const locations = listed.join(', ') + (unlisted > 0 ? ` and ${unlisted} more` : '');

    items.push({
      type: 'duplicate_read',
      severity: 'medium',
      description: `"${filename}" read ${pathReads.length} times (earlier reads at ${locations} are redundant)`,
      estimated_tokens: wasteTokens,
      recommendation: 'Unchanged lines already read are still in context: refer to the earlier read, and use offset and limit to read only new lines. /compact can drop the older copy.',
      message_range: [redundant[0]!.read.messageIndex, redundant[redundant.length - 1]!.read.messageIndex + 1],
    });
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
 * Only human-typed prompts (`isHumanUserText`) count as confirmations:
 * interrupt stubs, slash-command stdout, task notifications and other
 * records Claude Code writes under the user role are skipped, so machine
 * text that happens to contain "looks good" or "nice" cannot flag the
 * preceding exchange.
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

    // Only check prompts the person actually typed
    if (!isHumanUserText(msg)) continue;
    const content = msg.message?.content;

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
 * Groups for describing cache re-writes: one per cause, with expiries split
 * by whether a one-hour cache would have outlived the gap (only those are
 * helped by the `promptCacheTtl` setting).
 */
type RewriteGroup = 'expired_short' | 'expired_long' | Exclude<CacheRewriteCause, 'expired'>;

/** Lead phrase for each group: [one re-write, several]. */
const REWRITE_PHRASES: Record<RewriteGroup, [string, string]> = {
  expired_long: ['after the cache expired (gap over 1 h)', 'after the cache expired (gaps over 1 h)'],
  expired_short: ['after the 5-minute cache expired (gap under 1 h)', 'after the 5-minute cache expired (gaps under 1 h)'],
  model_changed: ['after a model switch', 'after model switches'],
  system_changed: ['after the system prompt changed', 'after the system prompt changed'],
  tools_changed: ['after the tool list changed', 'after the tool list changed'],
  messages_changed: ['after earlier messages changed', 'after earlier messages changed'],
  ttl_changed: ['after the cache TTL switched', 'after the cache TTL switched'],
  unexplained: ['with no recorded cause', 'with no recorded cause'],
};

/** Noun for each group in the "Also" list: [one re-write, several]. */
const REWRITE_NOUNS: Record<RewriteGroup, [string, string]> = {
  expired_long: ['expiry after a gap over 1 h', 'expiries after gaps over 1 h'],
  expired_short: ['5-minute cache expiry', '5-minute cache expiries'],
  model_changed: ['model switch', 'model switches'],
  system_changed: ['system prompt change', 'system prompt changes'],
  tools_changed: ['tool list change', 'tool list changes'],
  messages_changed: ['change to earlier messages', 'changes to earlier messages'],
  ttl_changed: ['cache TTL switch', 'cache TTL switches'],
  unexplained: ['unexplained re-write', 'unexplained re-writes'],
};

/** Short name of each cache TTL tier. */
const TTL_NAMES: Record<CacheTtl, string> = { '5m': '5 min', '1h': '1 h' };

/** Re-writes of one group with their token total. */
interface RewriteGroupTotal {
  group: RewriteGroup;
  rewrites: CacheRewrite[];
  tokens: number;
}

/**
 * The description group of one re-write.
 *
 * @param rewrite - A detected re-write
 * @returns Its cause, with expiries split at the one-hour mark
 */
function rewriteGroup(rewrite: CacheRewrite): RewriteGroup {
  if (rewrite.cause !== 'expired') return rewrite.cause;
  return rewrite.ttl === '5m' && rewrite.gapMs !== undefined && rewrite.gapMs <= CACHE_TTL_MS['1h']
    ? 'expired_short'
    : 'expired_long';
}

/**
 * Group re-writes by cause and rank the groups by tokens re-written.
 *
 * @param rewrites - Detected re-writes
 * @returns Groups, largest token total first
 */
function rankRewriteGroups(rewrites: CacheRewrite[]): RewriteGroupTotal[] {
  const byGroup = new Map<RewriteGroup, CacheRewrite[]>();
  for (const rewrite of rewrites) {
    const group = rewriteGroup(rewrite);
    const list = byGroup.get(group);
    if (list) list.push(rewrite);
    else byGroup.set(group, [rewrite]);
  }
  return [...byGroup]
    .map(([group, list]) => ({ group, rewrites: list, tokens: list.reduce((sum, r) => sum + r.tokens, 0) }))
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * Compact token count for descriptions: 1.4M, 540K, 900.
 *
 * @param tokens - Token count
 * @returns Formatted count
 */
function formatTokenCount(tokens: number): string {
  const thousands = Math.round(tokens / 1000);
  if (thousands >= 1000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${thousands}K`;
  return Math.round(tokens).toLocaleString();
}

/**
 * Length of a gap as an adjective: "22 min", "3 h", "1.5 h", "7-day".
 *
 * @param ms - Gap in milliseconds
 * @returns Formatted length
 */
function formatGap(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 59.5) return `${Math.max(1, Math.round(minutes))} min`;
  const hours = minutes / 60;
  if (hours < 47.5) return `${hours < 9.95 ? Number(hours.toFixed(1)) : Math.round(hours)} h`;
  return `${Math.round(hours / 24)}-day`;
}

/**
 * Join phrases as "a", "a and b", "a, b and c".
 *
 * @param parts - Phrases
 * @returns One phrase
 */
function joinPhrases(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Where and how one re-write happened, for the description.
 *
 * @param group - The re-write's group
 * @param rewrite - The re-write
 * @returns e.g. "after a 3 h break at message #812"
 */
function rewriteLocation(group: RewriteGroup, rewrite: CacheRewrite): string {
  const at = `message #${rewrite.messageIndex + 1}`;
  if ((group === 'expired_long' || group === 'expired_short') && rewrite.gapMs !== undefined) {
    return `after a ${formatGap(rewrite.gapMs)} break at ${at}`;
  }
  if (group === 'model_changed' && rewrite.fromModel && rewrite.toModel) {
    return `at ${at} (${rewrite.fromModel} to ${rewrite.toModel})`;
  }
  if (group === 'ttl_changed' && rewrite.writeTtl) {
    return `at ${at} (${TTL_NAMES[rewrite.ttl]} to ${TTL_NAMES[rewrite.writeTtl]})`;
  }
  return `at ${at}`;
}

/**
 * Describe a session's cache re-writes: the largest group with its biggest
 * re-write, the other groups in one line, and the share of the session's
 * cache writes they took.
 *
 * @param groups - Ranked re-write groups (at least one)
 * @param share - Re-written tokens over all cache-write tokens
 * @returns Description text
 */
function describeCacheRewrites(groups: RewriteGroupTotal[], share: number): string {
  const lead = groups[0]!;
  const count = lead.rewrites.length;
  const largest = lead.rewrites.reduce((a, b) => (b.tokens > a.tokens ? b : a));
  const where = rewriteLocation(lead.group, largest);
  let text = `${count} cache re-write${count === 1 ? '' : 's'} ${REWRITE_PHRASES[lead.group][count === 1 ? 0 : 1]}`
    + ` re-wrote ${formatTokenCount(lead.tokens)} tokens${count === 1 ? ` ${where}` : `; the largest ${where}`}.`;
  const others = groups.slice(1).map((g) =>
    `${g.rewrites.length} ${REWRITE_NOUNS[g.group][g.rewrites.length === 1 ? 0 : 1]} (${formatTokenCount(g.tokens)})`);
  if (others.length > 0) text += ` Also ${joinPhrases(others)}.`;
  return `${text} Re-writes were ${Math.round(share * 100)}% of this session's cache writes.`;
}

/**
 * What would have prevented or shrunk the re-writes, largest group first.
 * Names `promptCacheTtl` where a setting applies; never keep-alive pings.
 *
 * @param groups - Ranked re-write groups
 * @returns Recommendation text
 */
function cacheRewriteAdvice(groups: RewriteGroupTotal[]): string {
  const present = new Set(groups.map((g) => g.group));
  const hints: string[] = [];
  let ttlHint = false;
  let prefixHint = false;
  for (const { group } of groups) {
    if ((group === 'expired_short' || group === 'ttl_changed') && !ttlHint) {
      ttlHint = true;
      if (!present.has('expired_short')) {
        hints.push('Set "promptCacheTtl" ("5m" or "1h") in settings.json (Claude Code 2.1.242+) to pin the cache TTL so it cannot switch mid-session.');
      } else {
        const alsoPins = present.has('ttl_changed') ? ' and stop the TTL switching mid-session' : '';
        hints.push(`Set "promptCacheTtl": "1h" in settings.json (Claude Code 2.1.242+) to keep the cache through breaks under an hour${alsoPins}; 1-hour cache writes cost more per token, so it pays off when such breaks are common.`);
      }
    } else if (group === 'expired_long') {
      hints.push('Re-writes after long breaks are expected; /compact before a long break (or /clear once a task is done) makes them smaller.');
    } else if (group === 'model_changed') {
      hints.push('Each model has its own cache, so choose the model when a task starts rather than switching mid-task.');
    } else if ((group === 'system_changed' || group === 'tools_changed') && !prefixHint) {
      prefixHint = true;
      hints.push('The system prompt or tool list changed mid-session (a plugin or MCP server change, for example); make such changes between tasks.');
    }
  }
  return hints.length > 0
    ? hints.join(' ')
    : 'No setting prevents these re-writes; they are listed so their cost is visible.';
}

/**
 * Detect cache overhead: prompt-cache writes that repeated content the
 * cache already held.
 *
 * Cache reads are the healthy case (about a tenth of the input price, and
 * 95-97% of input on a normal session), so they are not counted.
 * `findCacheRewrites` finds the requests that wrote most of their agent's
 * previous cached prefix again, skipping each agent's first request and the
 * first request after each compaction, and names why: the cache expired, the
 * model, system prompt, tools or earlier messages changed, or the cache TTL
 * switched. The item appears when the re-writes come to at least
 * `CACHE_REWRITE_MIN_TOKENS` and to at least `CACHE_REWRITE_THRESHOLD` of
 * the session's cache-write tokens (a quarter by default; with 97% of input
 * read from a one-hour cache, that is about a tenth of the session's input
 * cost). The whole session is measured, compactions included, up to the
 * analysed end. `estimated_tokens` stays 0: re-writes cost money, not
 * window space, so they free nothing in the window.
 *
 * @param messages - All session messages
 * @param breakdown - The session's breakdown (compactions, analysed range)
 * @returns Array of waste items (0 or 1) for cache re-writes
 */
function detectCacheOverhead(messages: SessionMessage[], breakdown: CrustsBreakdown): WasteItem[] {
  const report = findCacheRewrites(messages, breakdown.compactionEvents, breakdown.messages.length);
  const rewritten = report.rewrites.reduce((sum, r) => sum + r.tokens, 0);
  if (rewritten < CACHE_REWRITE_MIN_TOKENS || report.cacheWriteTokens <= 0) return [];
  const share = rewritten / report.cacheWriteTokens;
  if (share < CACHE_REWRITE_THRESHOLD) return [];

  const groups = rankRewriteGroups(report.rewrites);
  return [{
    type: 'cache_overhead',
    severity: 'info',
    description: describeCacheRewrites(groups, share),
    estimated_tokens: 0,
    recommendation: cacheRewriteAdvice(groups),
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
  CACHE_REWRITE_THRESHOLD = thresholds.cacheRewriteThreshold;
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
    ...detectCacheOverhead(messages, breakdown), // Whole session: cache writes are billed across compactions
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
