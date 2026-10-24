/**
 * CRUSTS category classifier.
 *
 * Classifies each session message into one of the 6 CRUSTS categories
 * based on message role, content type, tool usage, and context.
 *
 * Classification precedence:
 *   1. S (System) — system messages, first message, CLAUDE.md markers,
 *      local-command wrappers (`<command-name>`, `<local-command-stdout>`)
 *   2. U (User Input) — the last human text message only (see
 *      `isHumanUserText`: machine-written user records never qualify)
 *   3. T (Tools) — tool_use and tool_result blocks (non-retrieval),
 *      background task notifications
 *   4. R (Retrieved) — tool results from read/search tools
 *   5. S (State/Memory) — memdir content, plans, skill bodies (Skill
 *      follow-ups via `sourceToolUseID`), subagent / workflow results
 *   6. C (Conversation) — all remaining human/assistant text messages
 *
 * `attachment` records bypass this precedence entirely: `attachment.type`
 * maps straight to a category (task reminders / plan references to State;
 * hook output, listings, reminders to System; auto-loaded files and IDE
 * context to Retrieved; queued commands to Conversation).
 */

import type {
  SessionMessage,
  ContentBlock,
  CrustsCategory,
  CrustsBreakdown,
  CrustsBucket,
  BucketReconciliation,
  ClassifiedMessage,
  ConfigData,
  ToolBreakdown,
  MCPBreakdown,
  MCPServerInfo,
  CompactionEvent,
  DerivedOverhead,
  ModelHistory,
  ModelSegment,
} from './types.ts';
import { resolveContextLimitWithSignal, resolveCompactionModel, latestCacheTtl, effectiveInput, cacheCreationTokens, modelFamily, tokenizerFactor } from './model-context.ts';
import { describeThresholdOverrides } from './config.ts';
import { detectClaudeCodeVersion } from './scanner.ts';
import { resolveCoreSchemaTokens, deferredLoadCost, isMcpToolName, mcpServerName, compareVersions } from './built-in-tools.ts';

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

/**
 * Tools whose RESULTS are classified as State/Memory (S).
 *
 * These return another agent's summary of work rather than a file or a
 * shell output: `Agent` (subagent run), `TaskOutput` (a background task's
 * collected output), `Workflow` (a multi-step workflow's result). The header
 * comment lists "subagent summaries" under State, and this is where they
 * enter the JSONL. The calls themselves stay in Tools; only the results
 * move. `Task` is the pre-rename subagent tool (legacy sessions).
 */
const STATE_TOOLS = new Set([
  'Agent',
  'TaskOutput',
  'Workflow',
  // Legacy name of the subagent tool before it became `Agent`
  'Task',
]);

/**
 * Leading markers that identify a user-role record Claude Code wrote
 * itself. None of these were typed by the person at the keyboard:
 *
 * - `<task-notification>`: a background task / Workflow / ScheduleWakeup
 *   completion that starts a new turn (classified as Tools)
 * - `<local-command-stdout>`, `<local-command-caveat>`, `<command-name>`,
 *   `<command-message>`: slash-command wrappers and their local output
 *   (classified as System)
 * - `[Request interrupted`: the stub written when the user hits Escape
 *   (stays Conversation, but is never the U bucket and never a
 *   "resolved exchange" confirmation)
 *
 * Matched against the start of the record's text after leading whitespace.
 */
const NON_HUMAN_USER_PREFIXES: ReadonlyArray<{ prefix: string; kind: NonHumanUserKind }> = [
  { prefix: '<task-notification>', kind: 'task-notification' },
  { prefix: '<local-command-stdout>', kind: 'local-command' },
  { prefix: '<local-command-caveat>', kind: 'local-command' },
  { prefix: '<command-name>', kind: 'local-command' },
  { prefix: '<command-message>', kind: 'local-command' },
  { prefix: '[Request interrupted', kind: 'interrupt' },
];

/** Kinds of machine-written user records recognised by their leading marker */
export type NonHumanUserKind = 'task-notification' | 'local-command' | 'interrupt';

/** Keywords that indicate state/memory content */
const STATE_MARKERS = [
  'memdir/',
  'memdir\\',
  '/memory/',
  '\\memory\\',
  'This memory is',
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
 * Flat token cost charged for one image block.
 *
 * The API prices an image at roughly (width * height) / 750 tokens; the
 * JSONL keeps only base64 data, not dimensions, so a fixed estimate near
 * the cost of a typical screenshot is used (a 1568 px long-edge image
 * tops out around 1,600 tokens).
 */
export const IMAGE_BLOCK_TOKENS = 1_500;

/**
 * Estimate the token count of a content block.
 *
 * Counts characters from the content-bearing fields: text, thinking,
 * tool input, tool_result content, and tool block metadata (ids, names).
 * Uses a content-aware divisor: ~3.3 for code, ~4.0 for English text.
 *
 * Deliberately NOT counted: `signature` on thinking blocks. Claude Code
 * never persists thinking text (every observed block has `thinking: ''`)
 * and the signature is an opaque verification token, not content the model
 * re-reads; counting its 800-14,000 chars gave 200-3,500 phantom tokens
 * to every assistant line without `output_tokens`.
 *
 * Media blocks have no text but do occupy context: image blocks cost a
 * flat `IMAGE_BLOCK_TOKENS`, document blocks (PDFs) cost their base64
 * length / 4.
 *
 * Nested sub-blocks (tool_result content arrays) are estimated with their
 * own divisor and added as tokens, so media and code nested inside a
 * result keep their own cost instead of being re-divided by the parent's
 * divisor.
 *
 * @param block - The content block to estimate
 * @returns Estimated token count
 */
function estimateBlockTokens(block: ContentBlock): number {
  if (block.type === 'image') return IMAGE_BLOCK_TOKENS;
  if (block.type === 'document') {
    const data = block.source?.data;
    return typeof data === 'string' && data.length > 0
      ? Math.ceil(data.length / CHARS_PER_TOKEN_TEXT)
      : 0;
  }

  let chars = 0;
  let sampleText = '';

  if (block.text) {
    chars += block.text.length;
    sampleText = block.text;
  }
  if (block.thinking) chars += block.thinking.length;
  if (block.input) {
    const inputStr = JSON.stringify(block.input);
    chars += inputStr.length;
    if (!sampleText) sampleText = inputStr;
  }

  // Tool block metadata: IDs and names are real content the API processes
  if (block.id) chars += block.id.length;
  if (block.tool_use_id) chars += block.tool_use_id.length;
  if (block.name) chars += block.name.length;

  let nestedTokens = 0;
  if (typeof block.content === 'string') {
    chars += block.content.length;
    if (!sampleText) sampleText = block.content;
  } else if (Array.isArray(block.content)) {
    for (const sub of block.content) {
      nestedTokens += estimateBlockTokens(sub);
    }
  }

  const divisor = sampleText ? charsPerToken(sampleText) : CHARS_PER_TOKEN_TEXT;
  return Math.ceil(chars / divisor) + nestedTokens;
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

  // Attachment records carry their injected text in the attachment
  // payload, not under message.content.
  if (msg.type === 'attachment') {
    return { tokens: estimateAttachmentTokens(msg), accuracy: 'estimated' };
  }

  // For everything else: estimate from content
  return { tokens: estimateContentTokens(msg), accuracy: 'estimated' };
}

/**
 * Estimate a message's token count from its content alone, ignoring any
 * API usage data.
 *
 * This is the "visible" size of the record: text, tool_use input JSON,
 * block ids/names, nested result blocks — everything `estimateBlockTokens`
 * counts. Thinking blocks contribute ~0 because Claude Code never persists
 * thinking text (only the uncounted signature).
 *
 * Used directly for non-assistant records, and as the per-line share when
 * apportioning one API response's `output_tokens` across its split lines.
 *
 * @param msg - The session message
 * @returns Estimated token count from content size
 */
function estimateContentTokens(msg: SessionMessage): number {
  const content = msg.message?.content;
  if (!content) return 0;

  if (typeof content === 'string') {
    return Math.ceil(content.length / charsPerToken(content));
  }

  let tokens = 0;
  for (const block of content) {
    tokens += estimateBlockTokens(block);
  }
  return tokens;
}

/**
 * Estimate the window cost of an `attachment` record at the plain-text
 * divisor (chars / 4).
 *
 * From Claude Code 2.1.268 every attachment that reaches the model carries
 * `rendered: [{content}]`, the exact text sent, and that is what is sized.
 * A 2.1.268+ attachment without it was never sent (prompt_snapshot,
 * deferred_tools_record, credential_org, batching_reminder_sent, ...) and
 * costs 0. On five real transcripts the payload fields under-read the sent
 * text by 38% (instructions, mcp_instructions_delta, environment and
 * task_reminder payloads carry it in shapes the field list misses) and
 * counted 48K tokens of never-sent batching reminders.
 *
 * The `instructions` attachment (CLAUDE.md files and auto-memory) costs 0
 * here: it is the session's CLAUDE.md + memory component, counted once per
 * view through the config overhead (see `instructionsOverhead`).
 *
 * Older records fall back to the payload fields: `content` (a string, an
 * array of strings or item objects such as task_reminder's `{subject,
 * description}` entries, or a nested object exposing `content` /
 * `file.content`), `text`, `snippet`, `banner`, `prompt`, `addedLines`
 * (string[]), and `skills[].content`. Every string found is summed.
 *
 * Returns 0 for non-attachment records, so callers can apply it
 * unconditionally.
 *
 * @param msg - The session message (any record type)
 * @returns Estimated token count of the attachment's injected text
 */
export function estimateAttachmentTokens(msg: SessionMessage): number {
  if (msg.type !== 'attachment' || !msg.attachment) return 0;
  if (msg.attachment.type === 'instructions') return 0;
  if (Array.isArray(msg.rendered)) {
    let chars = 0;
    for (const part of msg.rendered) {
      if (part && typeof part.content === 'string') chars += part.content.length;
    }
    return Math.round(chars / CHARS_PER_TOKEN_TEXT);
  }
  if (msg.version && compareVersions(msg.version, RENDERED_ATTACHMENTS_SINCE) >= 0) return 0;
  return Math.round(attachmentText(msg).length / CHARS_PER_TOKEN_TEXT);
}

/**
 * First Claude Code version that records `rendered` on every sent
 * attachment. On 2.1.268 transcripts the only attachments without it are
 * bookkeeping (prompt_snapshot, batching_reminder_sent, structured_output,
 * deferred_tools_record, hook_system_message); 2.1.265 has a single
 * rendered record, so earlier versions keep the payload estimate.
 */
const RENDERED_ATTACHMENTS_SINCE = '2.1.268';

/**
 * CLAUDE.md and memory cost from the session's own `instructions` attachment.
 *
 * Claude Code 2.1.268+ records the instruction files it loaded (`files[]`,
 * each typed User, Project, Local or AutoMem) and their exact sent text in
 * `rendered`. That beats re-reading the files from disk today: the disk copy
 * of MEMORY.md has moved on since the session ran, and ancestor CLAUDE.md
 * files (a parent folder's) were missed. Each attachment's sent text is
 * split between CLAUDE.md (System) and auto-memory (State) by its files'
 * share of characters.
 *
 * Two kinds exist. A full attachment carries every loaded file. A delta
 * (`changed: true`, written when files changed, e.g. on resume) carries only
 * the changed files, and sits in the window next to the full one rather
 * than replacing it. So the latest full attachment sets the baseline and
 * every later delta adds to it; taking the latest delta alone dropped
 * CLAUDE.md to 0 after every resume.
 *
 * @param messages - Session messages (the classifier's `effectiveMessages`)
 * @param factor - Tokenizer factor of the session's model (see `tokenizerFactor`)
 * @returns System and memory token costs, or null when no instructions
 *   attachment with sent text exists
 */
function instructionsOverhead(
  messages: SessionMessage[],
  factor = 1,
): { systemTokens: number; memoryTokens: number } | null {
  /** System and memory tokens of one attachment's sent text. */
  const split = (msg: SessionMessage): { systemTokens: number; memoryTokens: number } => {
    let sentChars = 0;
    for (const part of msg.rendered ?? []) {
      if (part && typeof part.content === 'string') sentChars += part.content.length;
    }
    let memoryChars = 0;
    let otherChars = 0;
    const files = msg.attachment?.files;
    if (Array.isArray(files)) {
      for (const file of files) {
        if (!file || typeof file !== 'object') continue;
        const content = (file as { content?: unknown }).content;
        const length = typeof content === 'string' ? content.length : 0;
        if ((file as { type?: unknown }).type === 'AutoMem') memoryChars += length;
        else otherChars += length;
      }
    }
    const memoryShare = memoryChars + otherChars > 0 ? memoryChars / (memoryChars + otherChars) : 0;
    const total = (sentChars / CHARS_PER_TOKEN_TEXT) * factor;
    const memoryTokens = Math.round(total * memoryShare);
    return { systemTokens: Math.round(total) - memoryTokens, memoryTokens };
  };

  const sent: SessionMessage[] = [];
  for (const msg of messages) {
    if (msg.type === 'attachment' && msg.attachment?.type === 'instructions' && Array.isArray(msg.rendered)) {
      sent.push(msg);
    }
  }
  if (sent.length === 0) return null;
  let start = -1;
  for (let k = sent.length - 1; k >= 0; k--) {
    if (sent[k]!.attachment?.changed !== true) { start = k; break; }
  }
  // No full attachment recorded (only deltas): the latest delta is all there is.
  if (start === -1) return split(sent[sent.length - 1]!);
  const total = { systemTokens: 0, memoryTokens: 0 };
  for (let k = start; k < sent.length; k++) {
    const part = split(sent[k]!);
    total.systemTokens += part.systemTokens;
    total.memoryTokens += part.memoryTokens;
  }
  return total;
}

/**
 * Claude Code's own system prompt as the session recorded it.
 *
 * From 2.1.269 Claude Code writes a `prompt_snapshot` attachment holding the
 * system prompt it sends (`systemPrompt`, an array of text blocks, after the
 * `cliPrefix` line) and its tool schemas. The snapshot is never sent itself
 * (it has no `rendered`, so it costs 0 as an attachment), but it is the one
 * copy of the system prompt in the transcript. The latest snapshot is the
 * prompt the live window carries, and it is sized like any other text.
 *
 * Without a snapshot the system prompt can only be derived as a residual
 * (see `deriveInternalSystemPrompt`), and that residual also holds every
 * under-estimate of the content around its anchor turn: on a 2.1.300 session
 * it read 24.0K where `/context` showed 3K for the system prompt.
 *
 * @param messages - Session messages (the classifier's `effectiveMessages`)
 * @param factor - Tokenizer factor of the session's model (see `tokenizerFactor`)
 * @returns Token estimate, character count and record index, or null when no
 *   snapshot with system prompt text was recorded
 */
function recordedSystemPrompt(
  messages: SessionMessage[],
  factor = 1,
): { tokens: number; chars: number; index: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.type !== 'attachment' || msg.attachment?.type !== 'prompt_snapshot') continue;
    const snapshot = msg.attachment as { systemPrompt?: unknown; cliPrefix?: unknown };
    const blocks = Array.isArray(snapshot.systemPrompt) ? snapshot.systemPrompt : [snapshot.systemPrompt];
    let chars = typeof snapshot.cliPrefix === 'string' ? snapshot.cliPrefix.length : 0;
    let found = false;
    for (const block of blocks) {
      const text = typeof block === 'string'
        ? block
        : block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : null;
      if (text === null) continue;
      chars += text.length;
      found = true;
    }
    if (found) return { tokens: Math.round((chars / CHARS_PER_TOKEN_TEXT) * factor), chars, index: i };
  }
  return null;
}

/**
 * Collect the injected text of an `attachment` record's payload.
 *
 * Walks the known payload fields (see `estimateAttachmentTokens`) and
 * concatenates every string found, in field order, with no separators —
 * so the result's length equals the summed character count.
 *
 * @param msg - The session message (any record type)
 * @returns Concatenated payload text, empty for non-attachment records
 */
function attachmentText(msg: SessionMessage): string {
  const att = msg.attachment;
  if (!att) return '';

  const parts: string[] = [];
  /** Accumulate one candidate value when it is a string. */
  const add = (value: unknown): void => {
    if (typeof value === 'string') parts.push(value);
  };

  add(att['text']);
  add(att['snippet']);
  add(att['banner']);
  add(att['prompt']);

  const addedLines = att['addedLines'];
  if (Array.isArray(addedLines)) {
    for (const line of addedLines) add(line);
  }

  const content = att['content'];
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    // Item arrays hold either strings (hook output lines) or objects
    // (task_reminder items with `subject` / `description` fields): every
    // string value of an item object is injected text.
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
      } else if (item && typeof item === 'object') {
        for (const value of Object.values(item)) add(value);
      }
    }
  } else if (content && typeof content === 'object') {
    const nested = content as Record<string, unknown>;
    add(nested['content']);
    const file = nested['file'];
    if (file && typeof file === 'object') {
      add((file as Record<string, unknown>)['content']);
    }
  }

  const skills = att['skills'];
  if (Array.isArray(skills)) {
    for (const skill of skills) {
      if (skill && typeof skill === 'object') {
        add((skill as Record<string, unknown>)['content']);
      }
    }
  }

  return parts.join('');
}

// ---------------------------------------------------------------------------
// Attachment classification
// ---------------------------------------------------------------------------

/**
 * Exact `attachment.type` to CRUSTS category table.
 *
 * State: per-turn agent state the harness re-injects (task reminders, plan
 * references). System: harness bookkeeping and listings (hook output,
 * skill/tool/agent listings, nested CLAUDE.md, reminders). Retrieved: file
 * content pushed into the window (auto-loaded files, IDE context, edits).
 * Conversation: the user's own queued prompt text.
 */
const ATTACHMENT_CATEGORY_BY_TYPE: ReadonlyMap<string, CrustsCategory> = new Map<string, CrustsCategory>([
  // State
  ['task_reminder', 'state'],
  ['plan_file_reference', 'state'],
  // System
  ['skill_listing', 'system'],
  ['deferred_tools_delta', 'system'],
  ['agent_listing_delta', 'system'],
  ['hook_success', 'system'],
  ['hook_additional_context', 'system'],
  ['hook_system_message', 'system'],
  ['nested_memory', 'system'],
  ['invoked_skills', 'system'],
  ['total_tokens_reminder', 'system'],
  ['date_change', 'system'],
  // Retrieved
  ['file', 'retrieved'],
  ['edited_text_file', 'retrieved'],
  ['selected_lines_in_ide', 'retrieved'],
  ['opened_file_in_ide', 'retrieved'],
  ['compact_file_reference', 'retrieved'],
  ['read_truncation_notice', 'retrieved'],
  // Conversation
  ['queued_command', 'conversation'],
]);

/**
 * Map an `attachment.type` string to its CRUSTS category.
 *
 * Exact names first (see `ATTACHMENT_CATEGORY_BY_TYPE`), then the prefix
 * families `plan_mode*` (State) and `ultra_effort_*` (System). Unknown
 * types default to System: attachments are harness-injected context, so
 * an unrecognised kind is bookkeeping until proven otherwise.
 *
 * @param attachmentType - The record's `attachment.type`, if any
 * @returns CRUSTS category for the attachment
 */
function classifyAttachmentType(attachmentType: string | undefined): CrustsCategory {
  if (!attachmentType) return 'system';
  const exact = ATTACHMENT_CATEGORY_BY_TYPE.get(attachmentType);
  if (exact) return exact;
  if (attachmentType.startsWith('plan_mode')) return 'state';
  if (attachmentType.startsWith('ultra_effort_')) return 'system';
  return 'system';
}

/** Marker CRUSTS auto-inject prepends to every injected advisory */
const CRUSTS_ADVISORY_MARKER = '[claude-crusts advisory]';

/**
 * Whether a record is CRUSTS's own auto-inject advisory.
 *
 * The `UserPromptSubmit` hook injects its advisory as a
 * `hook_additional_context` attachment whose content carries the
 * `[claude-crusts advisory]` marker. Like the CRUSTS shell call itself,
 * the advisory is about the analysis, not the session being analysed, so
 * `findAnalysisCutoff` trims it from the tail.
 *
 * @param msg - The session message (any record type)
 * @returns True for a hook_additional_context attachment carrying the marker
 */
function isCrustsAdvisoryAttachment(msg: SessionMessage): boolean {
  if (msg.type !== 'attachment' || msg.attachment?.type !== 'hook_additional_context') return false;
  return attachmentText(msg).includes(CRUSTS_ADVISORY_MARKER);
}

// ---------------------------------------------------------------------------
// Assistant split-line grouping (one API message = N JSONL lines)
// ---------------------------------------------------------------------------

/** One API response's worth of assistant JSONL lines. */
interface AssistantLineGroup {
  /** Indices into the messages array, in encounter order */
  indices: number[];
  /**
   * True when every line in the group repeats identical usage (input,
   * output, cache creation, cache read) — the split-line shape Claude Code
   * writes since v2.1.114, where each line carries the response's FINAL
   * usage. Legacy groups (2.1.81-2.1.96) whose lines carry differing
   * per-line usage stay false and keep per-line accounting.
   */
  identicalUsage: boolean;
}

/**
 * Build the grouping key for an assistant line.
 *
 * `message.id` (`msg_...`) is authoritative; `requestId` (`req_...`) is the
 * fallback for records that predate `message.id`. Lines with neither, or
 * without usage, are ungrouped and keep per-line accounting. The two keys
 * are namespaced so an id-keyed group can never collide with a
 * requestId-keyed one.
 *
 * @param msg - The session message
 * @returns Namespaced group key, or null when the line cannot be grouped
 */
function assistantGroupKey(msg: SessionMessage): string | null {
  if (msg.type !== 'assistant' || !msg.message?.usage) return null;
  if (msg.message.model === '<synthetic>') return null;
  if (msg.message.id) return `id:${msg.message.id}`;
  if (msg.requestId) return `req:${msg.requestId}`;
  return null;
}

/**
 * Group assistant lines by API message (`message.id`, fallback `requestId`).
 *
 * Since Claude Code v2.1.114 one API response is written as several
 * assistant lines (thinking / text / tool_use each on its own line) that
 * share `message.id` and repeat the same final `usage`. Counting
 * `output_tokens` once per LINE inflated buckets ~2.9x on real sessions.
 * `classifySession` and `computeModelHistory` use these groups to count
 * each response's usage exactly once.
 *
 * @param messages - Parsed session messages (the classifier's array)
 * @returns Map from message index to its group; ungroupable lines have no entry
 */
function groupAssistantLines(messages: SessionMessage[]): Map<number, AssistantLineGroup> {
  const byKey = new Map<string, AssistantLineGroup>();
  const byIndex = new Map<number, AssistantLineGroup>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const key = assistantGroupKey(msg);
    if (!key) continue;
    let group = byKey.get(key);
    if (!group) {
      group = { indices: [], identicalUsage: true };
      byKey.set(key, group);
    }
    group.indices.push(i);
    byIndex.set(i, group);
  }

  for (const group of byKey.values()) {
    const first = messages[group.indices[0]!]!.message!.usage!;
    group.identicalUsage = group.indices.every((i) => {
      const u = messages[i]!.message!.usage!;
      return u.input_tokens === first.input_tokens
        && u.output_tokens === first.output_tokens
        && (u.cache_read_input_tokens ?? 0) === (first.cache_read_input_tokens ?? 0)
        && cacheCreationTokens(u) === cacheCreationTokens(first);
    });
  }

  return byIndex;
}

/**
 * Check whether an assistant line contains a thinking block.
 *
 * @param msg - The session message
 * @returns True when any content block has `type === 'thinking'`
 */
function hasThinkingBlock(msg: SessionMessage): boolean {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b.type === 'thinking');
}

/**
 * Apportion one API response's `output_tokens` across its split lines.
 *
 * Each line's share starts from its visible content estimate (text chars,
 * tool_use input JSON, block ids/names — see `estimateContentTokens`).
 * Thinking cost is invisible in the JSONL (thinking text is never
 * persisted), so the thinking line receives the API's exact
 * `output_tokens_details.thinking_tokens` when recorded, else the
 * remainder the visible content cannot account for. Visible shares are
 * then floor-scaled to fill exactly what is left of `output_tokens`
 * (rounding remainder to the largest line), so the group's tokens sum to
 * `output_tokens` — the invariant callers rely on.
 *
 * Only called for identical-usage groups (`output_tokens` > 0); legacy
 * differing-usage groups keep per-line accounting and never reach here.
 *
 * @param messages - Parsed session messages
 * @param group - An identical-usage group from `groupAssistantLines`
 * @returns Map from message index to that line's apportioned token count
 */
function apportionGroupOutput(
  messages: SessionMessage[],
  group: AssistantLineGroup,
): Map<number, number> {
  const indices = group.indices;
  const usage = messages[indices[0]!]!.message!.usage!;
  const output = usage.output_tokens;

  const visible = indices.map((i) => estimateContentTokens(messages[i]!));
  const visibleTotal = visible.reduce((a, b) => a + b, 0);
  const thinkingPos = indices.findIndex((i) => hasThinkingBlock(messages[i]!));
  const thinkingDetail = usage.output_tokens_details?.thinking_tokens;

  let thinkingAlloc = 0;
  if (thinkingPos >= 0) {
    thinkingAlloc = thinkingDetail !== undefined
      ? Math.min(Math.max(0, thinkingDetail), output)
      : Math.max(0, output - visibleTotal);
  }
  const visibleBudget = output - thinkingAlloc;

  const tokens: number[] = indices.map(() => 0);
  if (visibleTotal > 0) {
    const scale = visibleBudget / visibleTotal;
    let assigned = 0;
    let largest = 0;
    for (let p = 0; p < indices.length; p++) {
      const share = Math.floor(visible[p]! * scale);
      tokens[p] = share;
      assigned += share;
      if (visible[p]! > visible[largest]!) largest = p;
    }
    tokens[largest] = (tokens[largest] ?? 0) + (visibleBudget - assigned);
  } else if (indices.length > 0) {
    // No visible content at all: everything rides on the thinking line
    // (or the first line when no thinking block exists).
    const sink = thinkingPos >= 0 ? thinkingPos : 0;
    tokens[sink] = visibleBudget;
  }
  if (thinkingPos >= 0) {
    tokens[thinkingPos] = (tokens[thinkingPos] ?? 0) + thinkingAlloc;
  }

  const result = new Map<number, number>();
  for (let p = 0; p < indices.length; p++) {
    result.set(indices[p]!, tokens[p]!);
  }
  return result;
}

/**
 * Build the per-line apportioned token map for a message array.
 *
 * Covers every identical-usage multi-line group with a positive
 * `output_tokens`. Single-line groups are omitted (the per-line path
 * already returns `output_tokens` for them), as are legacy
 * differing-usage groups and ungroupable lines.
 *
 * @param messages - Parsed session messages
 * @param lineGroups - Index-to-group map from `groupAssistantLines`
 * @returns Map from message index to apportioned token count
 */
function buildApportionedTokens(
  messages: SessionMessage[],
  lineGroups: Map<number, AssistantLineGroup>,
): Map<number, number> {
  const apportioned = new Map<number, number>();
  const seen = new Set<AssistantLineGroup>();
  for (const group of lineGroups.values()) {
    if (seen.has(group)) continue;
    seen.add(group);
    if (!group.identicalUsage || group.indices.length < 2) continue;
    const usage = messages[group.indices[0]!]!.message!.usage!;
    if (usage.output_tokens <= 0) continue;
    for (const [idx, tok] of apportionGroupOutput(messages, group)) {
      apportioned.set(idx, tok);
    }
  }
  return apportioned;
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
    if (msg.type === 'attachment' && msg.attachment) {
      return `[attachment: ${msg.attachment.type}]`;
    }
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
 * Concatenated text of a user-role record (string content, or the text
 * blocks of an array). Tool results and media contribute nothing.
 *
 * @param msg - The session message
 * @returns The record's text, empty when it carries none
 */
function userRecordText(msg: SessionMessage): string {
  const content = msg.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block.type === 'text' && block.text) text += block.text;
  }
  return text;
}

/**
 * Identify a machine-written user record by its leading marker.
 *
 * @param msg - The session message
 * @returns The record kind, or null when no marker matches
 */
function nonHumanUserKind(msg: SessionMessage): NonHumanUserKind | null {
  return nonHumanPromptKind(userRecordText(msg));
}

/**
 * Identify machine-written prompt text by its leading marker.
 *
 * The raw-text form of `nonHumanUserKind`, for callers that hold the prompt
 * string itself (the UserPromptSubmit hook payload's `prompt`) rather than a
 * transcript record, so both agree on what a typed prompt is.
 *
 * @param text - Prompt text as submitted
 * @returns The machine-written kind, or null when no marker matches
 */
export function nonHumanPromptKind(text: string): NonHumanUserKind | null {
  const trimmed = text.trimStart();
  if (!trimmed) return null;
  for (const entry of NON_HUMAN_USER_PREFIXES) {
    if (trimmed.startsWith(entry.prefix)) return entry.kind;
  }
  return null;
}

/**
 * Whether a record is a prompt the person actually typed.
 *
 * Claude Code writes many `type: 'user'` records that are not human input:
 * tool_result carriers, `isMeta` injections (skill bodies, scheduled
 * re-prompts, `/context` dumps, image notes), Skill follow-up content
 * (`sourceToolUseID`), compaction summaries, background task notifications,
 * slash-command wrappers with their local stdout, and interrupt stubs. In
 * the real corpus only ~70% of non-tool_result user records are typed
 * prompts. Everything that picks "the user's message" (the U bucket, the
 * analysis-cutoff trim, the resolved-exchange waste rule) goes through
 * this one predicate so they agree.
 *
 * @param msg - The session message
 * @returns True only for human-typed user text
 */
export function isHumanUserText(msg: SessionMessage): boolean {
  if (msg.type !== 'user' || msg.message?.role !== 'user') return false;
  if (hasToolResultBlocks(msg.message.content)) return false;
  if (msg.isMeta === true) return false;
  if (msg.isCompactSummary === true) return false;
  if (typeof msg.sourceToolUseID === 'string' && msg.sourceToolUseID.length > 0) return false;
  return nonHumanUserKind(msg) === null;
}

/**
 * Classify a record that carries a tool's output by the tool's name.
 *
 * Shared by tool_result blocks and `sourceToolUseID` follow-ups so both
 * paths apply the same RETRIEVAL_TOOLS / STATE_TOOLS rules.
 *
 * @param toolName - Originating tool name, undefined when unresolved
 * @returns Category for the result plus the resolved tool name
 */
function classifyToolOutput(toolName: string | undefined): { category: CrustsCategory; toolName?: string } {
  if (toolName && RETRIEVAL_TOOLS.has(toolName)) {
    return { category: 'retrieved', toolName };
  }
  if (toolName && STATE_TOOLS.has(toolName)) {
    return { category: 'state', toolName };
  }
  return { category: 'tools', toolName };
}

/**
 * Classify a single message into a CRUSTS category.
 *
 * Applies the classification rules in order of precedence:
 * System > User > Tools/Retrieved > State > Conversation.
 *
 * Machine-written user records are routed before the human-text rules:
 * `sourceToolUseID` follow-ups go where their originating tool's output
 * goes (Skill bodies to State), `<task-notification>` to Tools, and
 * local-command wrappers to System. They can never become the U bucket
 * because `isHumanUserText` rejects them.
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
  // 0a. Attachment records — per-turn context Claude Code injects into the
  // request. `attachment.type` names the kind and fully determines the
  // category; none of the message-shaped rules below apply.
  if (msg.type === 'attachment') {
    return { category: classifyAttachmentType(msg.attachment?.type) };
  }

  // 0b. Compaction summaries — the system's compressed representation of prior context
  if (msg.isCompactSummary) {
    return { category: 'system' };
  }

  // 1. System Instructions
  if (msg.type === 'system') {
    return { category: 'system' };
  }
  if (isFirstMessage && msg.type === 'user' && msg.message?.role === 'user' && hasSystemMarkers(msg)) {
    return { category: 'system' };
  }

  const content = msg.message?.content;

  // 2. User Input — only the last human TEXT message
  if (isLastHuman && isHumanUserText(msg)) {
    return { category: 'user' };
  }

  // 2b. Machine-written user records (no tool_result blocks)
  if (msg.type === 'user' && msg.message?.role === 'user' && !hasToolResultBlocks(content)) {
    // Follow-up content a tool injected as a user record. For `Skill` this
    // is the skill body itself (hundreds of KB per record in real sessions)
    // and belongs to State; any other tool follows the result rules.
    if (typeof msg.sourceToolUseID === 'string' && msg.sourceToolUseID.length > 0) {
      const toolName = toolUseIdMap.get(msg.sourceToolUseID);
      if (toolName === 'Skill') {
        return { category: 'state', toolName };
      }
      return classifyToolOutput(toolName);
    }
    const kind = nonHumanUserKind(msg);
    if (kind === 'task-notification') {
      return { category: 'tools' };
    }
    if (kind === 'local-command') {
      return { category: 'system' };
    }
    // Interrupt stubs and unprefixed isMeta records fall through to the
    // State / Conversation rules below.
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
      // Look up the originating tool name; retrieval results are Retrieved,
      // subagent / workflow results are State, the rest are Tools.
      const firstResult = toolResultBlocks[0];
      const toolName = firstResult ? getToolNameForResult(firstResult, toolUseIdMap) : undefined;
      return classifyToolOutput(toolName);
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

/** Names a ToolSearch result loaded plus Claude Code's deferred-pool size */
interface ToolSearchLoad {
  /** Deferred tool names the call materialised, in result order (deduped) */
  names: string[];
  /** `toolUseResult.total_deferred_tools` when Claude Code reported it */
  totalDeferred?: number;
}

/**
 * Extract the deferred tools a ToolSearch result loaded into the window.
 *
 * Claude Code records a load two ways on the same user record: a top-level
 * `toolUseResult: { matches: string[], query, total_deferred_tools }` and
 * `tool_reference` blocks (`{ type: 'tool_reference', tool_name }`) inside
 * the tool_result's content array. `matches` is preferred; the
 * tool_reference blocks are the fallback for records without the
 * structured copy. A tool_result is treated as a ToolSearch result when its
 * tool_use_id maps to `ToolSearch` or when it carries tool_reference
 * blocks (no other tool emits them).
 *
 * @param msg - A session message (only user tool_result carriers qualify)
 * @param toolUseIdMap - Map of tool_use IDs to tool names
 * @returns The loaded names, or null when the message is not a ToolSearch result
 */
function extractToolSearchLoad(
  msg: SessionMessage,
  toolUseIdMap: Map<string, string>,
): ToolSearchLoad | null {
  if (msg.type !== 'user') return null;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return null;

  let isToolSearchResult = false;
  const referenced: string[] = [];
  for (const block of content) {
    if (block.type !== 'tool_result') continue;
    if (block.tool_use_id && toolUseIdMap.get(block.tool_use_id) === 'ToolSearch') {
      isToolSearchResult = true;
    }
    if (!Array.isArray(block.content)) continue;
    for (const sub of block.content) {
      if (sub.type === 'tool_reference' && typeof sub.tool_name === 'string' && sub.tool_name) {
        isToolSearchResult = true;
        referenced.push(sub.tool_name);
      }
    }
  }
  if (!isToolSearchResult) return null;

  const structured = msg.toolUseResult;
  let matches: string[] | null = null;
  let totalDeferred: number | undefined;
  if (structured && typeof structured === 'object') {
    const record = structured as { matches?: unknown; total_deferred_tools?: unknown };
    if (Array.isArray(record.matches)) {
      matches = record.matches.filter((m): m is string => typeof m === 'string' && m.length > 0);
    }
    if (typeof record.total_deferred_tools === 'number' && Number.isFinite(record.total_deferred_tools)) {
      totalDeferred = record.total_deferred_tools;
    }
  }

  const names = [...new Set(matches ?? referenced)];
  return totalDeferred !== undefined ? { names, totalDeferred } : { names };
}

/**
 * Collect the deferred tool names Claude Code reported for a session.
 *
 * Reads `deferred_tools_delta` attachment records in order, applying
 * `addedNames` and `readdedNames` as additions and `removedNames` as
 * removals, so the result is the deferred pool as of the last delta.
 * Returns an empty list when the parsed messages carry no attachment
 * records.
 *
 * @param messages - All session messages
 * @returns Deferred tool names in first-seen order
 */
function collectDeferredToolNames(messages: SessionMessage[]): string[] {
  const deferred = new Set<string>();
  const names = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];

  for (const msg of messages) {
    if (msg.type !== 'attachment' || msg.attachment?.type !== 'deferred_tools_delta') continue;
    const delta = msg.attachment;
    for (const name of names(delta.addedNames)) deferred.add(name);
    for (const name of names(delta.readdedNames)) deferred.add(name);
    for (const name of names(delta.removedNames)) deferred.delete(name);
  }
  return [...deferred];
}

/**
 * Find the index of the last real human text message.
 *
 * Identifies the last record that `isHumanUserText` accepts, so a trailing
 * task notification, slash-command wrapper, skill body or interrupt stub
 * never displaces the prompt the person actually typed.
 *
 * @param messages - All session messages
 * @returns Index of last human text message, or -1 if none found
 */
function findLastHumanTextIndex(messages: SessionMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isHumanUserText(messages[i]!)) {
      return i;
    }
  }
  return -1;
}

/**
 * Count the classified rows that are actual messages.
 *
 * Attachment rows carry real window tokens but are injected content, not
 * messages — every messageCount-style statistic (analyze/report message
 * counts, tokens-per-message averages, framing distribution) counts
 * through this helper so they all agree.
 *
 * @param rows - Classified message rows (a full breakdown or a slice)
 * @returns Number of non-attachment rows
 */
export function countAnalyzedMessages(rows: ClassifiedMessage[]): number {
  let count = 0;
  for (const row of rows) {
    if (!row.isAttachment) count++;
  }
  return count;
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
 * Shell tools whose `command` input can carry a CRUSTS invocation.
 *
 * Claude Code on Windows exposes `PowerShell` next to `Bash`; both run
 * `claude-crusts ...` and both write its report back as a tool_result, so
 * both must be recognised or the self-call output gets analysed as session
 * content.
 */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);

/**
 * Check if an assistant message contains a shell tool call (Bash or
 * PowerShell) invoking CRUSTS.
 *
 * @param msg - The session message to check
 * @returns True if the message contains a CRUSTS shell invocation
 */
function isCrustsShellCall(msg: SessionMessage): boolean {
  if (msg.type !== 'assistant') return false;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return false;

  for (const block of content) {
    if (block.type !== 'tool_use' || !block.name || !SHELL_TOOL_NAMES.has(block.name)) continue;
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
 * 1. Strip trailing CRUSTS shell calls (Bash or PowerShell), their
 *    tool_results, and CRUSTS's own auto-inject advisory attachments
 * 2. Strip preceding assistant text/thinking messages (same turn),
 *    stepping over an interleaved advisory attachment
 * 3. Strip the user text message that triggered the analysis turn
 *
 * A trailing advisory alone (the hook fired on a prompt submit but no
 * CRUSTS invocation followed yet) is trimmed by phase 1, but phases 2-3
 * only run when an actual invocation was trimmed — otherwise the person's
 * real latest prompt would be misattributed to the analysis turn.
 *
 * @param messages - All session messages
 * @returns The effective end index (exclusive) — analyze messages[0..end)
 */
function findAnalysisCutoff(messages: SessionMessage[]): number {
  let end = messages.length;
  let sawInvocation = false;

  // Phase 1: Walk backward, trim CRUSTS shell calls, tool_results, and
  // auto-inject advisories from the tail
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;

    if (msg.type === 'assistant' && isCrustsShellCall(msg)) {
      end = i;
      sawInvocation = true;
      continue;
    }

    if (msg.type === 'user' && hasCrustsToolResult(msg)) {
      end = i;
      sawInvocation = true;
      continue;
    }

    if (isCrustsAdvisoryAttachment(msg)) {
      end = i;
      continue;
    }

    break;
  }

  // If nothing was trimmed — or only advisories were (no invocation to
  // attribute a triggering turn to) — stop here.
  if (end === messages.length || !sawInvocation) return end;

  // Phase 2: Continue backward through assistant text/thinking messages
  // that are part of the same turn as the CRUSTS shell call.
  // In Claude Code JSONL, a single assistant response can span multiple
  // messages: thinking, then text, then tool_use (each a separate line).
  // The auto-inject advisory lands between the triggering prompt and the
  // assistant turn it triggered, so step over it here too.
  for (let i = end - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (isCrustsAdvisoryAttachment(msg)) {
      end = i;
      continue;
    }
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

  // Phase 3: Trim the preceding user text message that triggered this turn.
  // Only a human-typed prompt is "about the analysis"; a task notification
  // or command wrapper that happened to precede the call is session content.
  if (end > 0 && isHumanUserText(messages[end - 1]!)) {
    end = end - 1;
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
 * Walk every non-synthetic assistant turn and build the per-session model
 * history.
 *
 * Contiguous turns on the same model collapse into a single `ModelSegment`.
 * A model change opens a new segment; switching back later creates a third
 * segment rather than merging with the first — the chronological flow is
 * preserved. Synthetic model markers (`<synthetic>`) — which Claude Code
 * writes around session exit/resume — are ignored entirely; they never
 * start, extend, or close a segment.
 *
 * Per-segment token counts are summed from `usage.*` fields rather than
 * estimated, so they're exact when Claude Code recorded usage. Split
 * assistant lines that repeat one API response's usage (same `message.id`
 * or `requestId`, identical usage on every line — the 2.1.114+ shape) are
 * counted ONCE per group, on the group's last line; legacy groups whose
 * lines carry differing per-line usage keep per-line sums.
 * `assistantMessageCount` still counts JSONL lines, not API messages.
 *
 * @param messages - All session messages (classifier's `effectiveMessages`)
 * @param lineGroups - Optional precomputed split-line groups for `messages`
 *   (from `groupAssistantLines`); computed on demand when omitted
 * @returns History snapshot with at least one segment for any session that
 *   has at least one non-synthetic assistant turn
 */
function computeModelHistory(
  messages: SessionMessage[],
  lineGroups?: Map<number, AssistantLineGroup>,
): ModelHistory {
  const segments: ModelSegment[] = [];
  let current: ModelSegment | null = null;
  const groups = lineGroups ?? groupAssistantLines(messages);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.type !== 'assistant') continue;
    const model = msg.message?.model;
    if (!model || model === '<synthetic>') continue;

    const usage = msg.message?.usage;
    const timestamp = msg.timestamp ?? null;

    // Identical-usage split groups: count the shared usage once, on the
    // group's last line. Differing-usage (legacy) groups count every line.
    const group = groups.get(i);
    const countUsage = !group
      || !group.identicalUsage
      || group.indices[group.indices.length - 1] === i;

    if (current && current.model === model) {
      // Extend the open segment.
      current.lastMessageIndex = i;
      current.assistantMessageCount++;
      if (countUsage) {
        current.totalInputTokens += usage?.input_tokens ?? 0;
        current.totalOutputTokens += usage?.output_tokens ?? 0;
        // Flat vs nested cache_creation reconciled the same way effectiveInput does
        current.cacheCreationTokens += cacheCreationTokens(usage);
        current.cacheReadTokens += usage?.cache_read_input_tokens ?? 0;
      }
      current.lastSeenAt = timestamp;
      continue;
    }

    // New segment — either the first ever, or a model switch.
    current = {
      model,
      firstMessageIndex: i,
      lastMessageIndex: i,
      assistantMessageCount: 1,
      totalInputTokens: countUsage ? usage?.input_tokens ?? 0 : 0,
      totalOutputTokens: countUsage ? usage?.output_tokens ?? 0 : 0,
      cacheCreationTokens: countUsage ? cacheCreationTokens(usage) : 0,
      cacheReadTokens: countUsage ? usage?.cache_read_input_tokens ?? 0 : 0,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
    };
    segments.push(current);
  }

  const uniqueModels: string[] = [];
  for (const seg of segments) {
    if (!uniqueModels.includes(seg.model)) uniqueModels.push(seg.model);
  }

  return {
    segments,
    uniqueModels,
    current: segments.length > 0 ? segments[segments.length - 1]!.model : 'unknown',
    switchCount: Math.max(0, segments.length - 1),
  };
}

/** A contiguous same-model run of message indices (inclusive bounds). */
interface ModelSpan {
  model: string;
  start: number;
  end: number;
}

/**
 * Partition the full message range into contiguous same-model spans.
 *
 * Span k runs from just after the previous model segment's last assistant
 * to segment k's last assistant; the first span starts at index 0 and the
 * last span extends to the end of the session, so every message index
 * (user records, boundaries, attachments included) belongs to exactly one
 * span. Sessions without any model-carrying assistant collapse to a single
 * span on the history's `current` model.
 *
 * Used for per-window context-limit resolution: the window size can only
 * change at a model switch, so signals (usage, /context output) are scoped
 * to the span they were observed in.
 *
 * @param messages - Session messages the history was computed from
 * @param history - Model history for the same message array
 * @returns Ordered spans covering [0, messages.length - 1]
 */
function computeModelSpans(messages: SessionMessage[], history: ModelHistory): ModelSpan[] {
  const segments = history.segments;
  const lastIndex = Math.max(0, messages.length - 1);
  if (segments.length === 0) {
    return [{ model: history.current, start: 0, end: lastIndex }];
  }
  const spans: ModelSpan[] = [];
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k]!;
    spans.push({
      model: seg.model,
      start: k === 0 ? 0 : segments[k - 1]!.lastMessageIndex + 1,
      end: k === segments.length - 1 ? lastIndex : seg.lastMessageIndex,
    });
  }
  return spans;
}

/**
 * Detect compaction events via compact_boundary system messages.
 *
 * Each auto-compaction produces this sequence in the JSONL:
 *   1. system (subtype: "compact_boundary", compactMetadata.preTokens)
 *   2. user (isCompactSummary: true) — the compressed summary
 *   3. assistant — first response in the new context window
 *
 * Guards that keep the event list faithful to the real window:
 *   - Boundaries are deduplicated by `uuid`. The scanner already drops
 *     resume replays at parse time; this is the belt for callers that build
 *     message arrays themselves. Boundaries without a uuid are never merged.
 *   - `tokensAfter` is the first LIVE assistant after the boundary
 *     (`firstLiveIndex`): `<synthetic>` placeholders, zero-usage records and
 *     records carried over from the old window (a continuation file's
 *     copied turns, an in-flight turn: see `isPreCompactionCarryover`) are
 *     skipped, and the scan stops at the next boundary rather than a
 *     10-record window ("user > user > user > ..." tails after a boundary
 *     previously fell off the window and reported tokensAfter = 0). Until a
 *     live turn exists it is Claude Code's `postTokens` (its chars/4 count of
 *     what it wrote after compacting; classifySession adds the fixed
 *     context on the last event).
 *   - `trigger` and `cumulativeDroppedTokens` are copied from
 *     `compactMetadata` so downstream rules can tell deliberate /compact
 *     runs from auto-compactions.
 *   - `preservedMessages.uuids` are resolved to pre-boundary message
 *     indices; Claude Code re-sends those messages in the new window, so
 *     the post-compaction slice must include them.
 *
 * @param messages - Parsed session messages
 * @returns Array of compaction events detected from markers
 */
function detectViaMarkers(messages: SessionMessage[]): CompactionEvent[] {
  const events: CompactionEvent[] = [];
  const seenBoundaryUuids = new Set<string>();
  // Lazily built uuid -> first index map for preservedMessages resolution.
  let uuidToIndex: Map<string, number> | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.type !== 'system' || msg.subtype !== 'compact_boundary') continue;
    if (msg.uuid) {
      if (seenBoundaryUuids.has(msg.uuid)) continue;
      seenBoundaryUuids.add(msg.uuid);
    }

    const meta = msg.compactMetadata;
    const preTokens = meta?.preTokens ?? 0;

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

    // Find the first REAL assistant message after the boundary: the first
    // turn whose request was built from the compacted window. The scan
    // steps over long runs of user records or attachments, skips records
    // carried over from before the compaction (their usage still describes
    // the old window), and stops at the next boundary.
    let afterIndex = i + 1;
    let firstLiveIndex: number | undefined;
    let scannedTokensAfter = 0;
    // Only the first response after the boundary can be one that was in
    // flight when compaction fired, and not if a prompt written after the
    // boundary came first: that prompt's answer was built from the
    // compacted window, however big a paste made it.
    let firstGroup: string | null | undefined;
    let newerPromptSeen = false;
    for (let j = i + 1; j < messages.length; j++) {
      const m = messages[j]!;
      if (m.type === 'system' && m.subtype === 'compact_boundary') break;
      if (isPromptAfterBoundary(m, msg)) newerPromptSeen = true;
      if (m.type !== 'assistant' || !m.message?.usage) continue;
      if (m.message.model === '<synthetic>') continue;
      const effective = effectiveInput(m.message.usage);
      if (effective <= 0) continue;
      const group = assistantGroupKey(m) ?? `#${j}`;
      if (firstGroup === undefined) firstGroup = group;
      const mayBeInFlight = group === firstGroup && !newerPromptSeen;
      if (isPreCompactionCarryover(m, msg, mayBeInFlight)) continue;
      afterIndex = j;
      firstLiveIndex = j;
      scannedTokensAfter = effective;
      break;
    }

    // The window right after compaction is the first live turn's effective
    // input. Claude Code's postTokens is its own chars/4 estimate of what it
    // wrote after compacting (the summary, re-attached files, command
    // records); the fixed context rides on top, so it understates the window
    // and overstates the drop. It stands in only until a live turn exists;
    // classifySession then adds its fixed-context estimate on the last event.
    const tokensAfter = firstLiveIndex !== undefined ? scannedTokensAfter : meta?.postTokens ?? 0;

    // Resolve preserved-message uuids to pre-boundary indices (first
    // occurrence wins, matching the scanner's resume-replay dedupe).
    let preservedMessageIndices: number[] | undefined;
    const preservedUuids = meta?.preservedMessages?.uuids;
    if (preservedUuids && preservedUuids.length > 0) {
      if (!uuidToIndex) {
        uuidToIndex = new Map();
        for (let k = 0; k < messages.length; k++) {
          const u = messages[k]!.uuid;
          if (u !== undefined && !uuidToIndex.has(u)) uuidToIndex.set(u, k);
        }
      }
      const indices: number[] = [];
      for (const u of preservedUuids) {
        const k = uuidToIndex.get(u);
        if (k !== undefined && k < i && !indices.includes(k)) indices.push(k);
      }
      if (indices.length > 0) {
        preservedMessageIndices = indices.sort((a, b) => a - b);
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
      trigger: meta?.trigger,
      cumulativeDroppedTokens: meta?.cumulativeDroppedTokens,
      preservedMessageIndices,
      ...(firstLiveIndex !== undefined ? { firstLiveIndex } : {}),
      ...(meta?.postTokens !== undefined ? { postTokens: meta.postTokens } : {}),
      ...(msg.idleCompaction === true ? { idle: true } : {}),
    });
  }

  return events;
}

/**
 * Whether an assistant record written after a compaction boundary still
 * describes the PRE-compaction window.
 *
 * Two kinds land past the boundary in the JSONL. A continued session's file
 * opens with the previous conversation's boundary followed by its last
 * turns, timestamped before the boundary (observed: two records at 821,214
 * effective input right after a boundary whose postTokens was 12,536). And a
 * turn already in flight when compaction fired finishes after it (observed:
 * 676,916 against postTokens 12,867). Either one's usage is the old window,
 * so it must not stand in for the live window, anchor the fixed-context
 * derivation, or mark the post-compaction size.
 *
 * @param msg - An assistant record after the boundary
 * @param boundary - The compact_boundary record
 * @param mayBeInFlight - The record is the first response after the
 *   boundary and no prompt written after the boundary came before it; only
 *   then can its size mark it as an in-flight turn
 * @returns True when the record's usage belongs to the pre-compaction window
 */
function isPreCompactionCarryover(
  msg: SessionMessage,
  boundary: SessionMessage,
  mayBeInFlight: boolean,
): boolean {
  const msgTs = msg.timestamp ? Date.parse(msg.timestamp) : Number.NaN;
  const boundaryTs = boundary.timestamp ? Date.parse(boundary.timestamp) : Number.NaN;
  const timed = Number.isFinite(msgTs) && Number.isFinite(boundaryTs);
  if (timed && msgTs < boundaryTs) return true;
  if (!mayBeInFlight) return false;
  // An in-flight turn finishes within minutes of the boundary; later turns
  // are live whatever their size.
  if (timed && msgTs - boundaryTs > IN_FLIGHT_WINDOW_MS) return false;
  // The size test needs both ends of the compaction (postTokens is recorded
  // since 2.1.119). postTokens leaves out the fixed context, so a live first
  // turn sits well above it (about 60K typically, 142K seen with a large
  // preserved segment); a turn above POST_COMPACTION_ALLOWANCE over it and
  // closer to the old window than to the compacted one was built before the
  // compaction.
  const pre = boundary.compactMetadata?.preTokens ?? 0;
  const post = boundary.compactMetadata?.postTokens;
  if (pre <= 0 || post === undefined || post >= pre) return false;
  const effective = effectiveInput(msg.message?.usage);
  return effective > post + POST_COMPACTION_ALLOWANCE && effective > (pre + post) / 2;
}

/** How long after a boundary an in-flight pre-compaction turn can still finish. */
const IN_FLIGHT_WINDOW_MS = 10 * 60_000;

/**
 * Headroom above `postTokens` that a live first post-compaction turn can
 * occupy: the fixed context and the next prompt. Over 38 real boundaries
 * the first live turn sat 45K-77K above postTokens (median about 59K), and
 * 142K once when Claude Code preserved a large recent segment; that turn
 * still read as live because it stayed far below the old window.
 */
const POST_COMPACTION_ALLOWANCE = 100_000;

/**
 * The Claude Code version running the session now: the `version` of the
 * newest record that carries one (a session can outlive several updates;
 * `detectClaudeCodeVersion` reports the first).
 *
 * @param messages - Session messages
 * @returns The version string, or undefined when no record carries one
 */
function latestClaudeCodeVersion(messages: SessionMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const version = messages[i]!.version;
    if (typeof version === 'string' && version.trim() !== '') return version.trim();
  }
  return undefined;
}

/**
 * The model named by the latest `model` attachment (`identity.modelId`),
 * which Claude Code writes at session start and after a model switch.
 *
 * @param messages - Session messages
 * @returns The model ID, or null when no such attachment exists
 */
function announcedModel(messages: SessionMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const att = messages[i]!.attachment;
    if (!att || att.type !== 'model') continue;
    const identity = att.identity as { modelId?: unknown } | undefined;
    if (identity && typeof identity.modelId === 'string' && identity.modelId.trim() !== '') {
      return identity.modelId.trim();
    }
  }
  return null;
}

/**
 * Whether a record is a prompt written after a compaction boundary: a user
 * record (not the compact summary, not a tool result) timestamped after the
 * boundary. Its answer was built from the compacted window. Untimed records
 * never count, so fixtures without timestamps keep the size test.
 *
 * @param msg - A record after the boundary
 * @param boundary - The compact_boundary record
 * @returns True for a prompt newer than the boundary
 */
function isPromptAfterBoundary(msg: SessionMessage, boundary: SessionMessage): boolean {
  if (msg.type !== 'user' || msg.isCompactSummary === true) return false;
  if (hasToolResultBlocks(msg.message?.content)) return false;
  const msgTs = msg.timestamp ? Date.parse(msg.timestamp) : Number.NaN;
  const boundaryTs = boundary.timestamp ? Date.parse(boundary.timestamp) : Number.NaN;
  return Number.isFinite(msgTs) && Number.isFinite(boundaryTs) && msgTs > boundaryTs;
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

    const inputTokens = effectiveInput(msg.message.usage);

    if (prevAssistantIdx >= 0 && prevInputTokens - inputTokens > COMPACTION_DROP_THRESHOLD) {
      events.push({
        beforeIndex: prevAssistantIdx,
        afterIndex: i,
        tokensBefore: prevInputTokens,
        tokensAfter: inputTokens,
        tokensDropped: prevInputTokens - inputTokens,
        detection: 'heuristic',
        firstLiveIndex: i,
      });
    }

    prevAssistantIdx = i;
    prevInputTokens = inputTokens;
  }

  return events;
}

/**
 * Pull the authoritative "current window size" from the last non-synthetic
 * assistant turn's API-reported usage.
 *
 * `effectiveInput(usage)` (input + reconciled cache_creation + cache_read)
 * is what Claude Code sent to the API on that turn. The turn's own
 * `output_tokens` is added on top: that response is already part of the
 * window and is re-sent on the next request. Observed auto-compaction
 * `preTokens` decompose exactly as input + cache_creation + cache_read +
 * output (+ the pending turn), so leaving the last output out consistently
 * under-reports the live window by one response.
 *
 * The classifier's per-message content-sum diverges from this: it
 * under-reports short sessions (cached prior conversation re-sent each turn
 * is a single API hit but isn't classified per message) and over-reports
 * long multi-compact sessions (every per-turn output accumulates even though
 * subsequent turns see it only via cache).
 *
 * Walks backward from the end of the slice so we always pick the latest
 * state. Skips synthetic assistants (which are compaction-summary markers,
 * not real API turns with usage). Split lines of one API response share
 * identical usage, so whichever line of the last group is hit first yields
 * the same total.
 *
 * @param messages - Session messages to scan (typically `effectiveMessages`)
 * @param fromIndex - Don't look earlier than this index. 0 for whole-session,
 *   `currentContext.startIndex` for the post-last-compaction slice.
 * @returns Window total in tokens (effective input plus the turn's output),
 *   or null if no usable assistant turn exists in the range.
 */
function computeEffectiveInputTokens(
  messages: SessionMessage[],
  fromIndex: number = 0,
): number | null {
  for (let i = messages.length - 1; i >= fromIndex; i--) {
    const msg = messages[i];
    if (!msg || msg.type !== 'assistant') continue;
    if (msg.message?.model === '<synthetic>') continue;
    const usage = msg.message?.usage;
    if (!usage) continue;
    const effective = effectiveInput(usage);
    if (effective > 0) return effective + (usage.output_tokens ?? 0);
  }
  return null;
}

/**
 * Size of the live window: the latest real turn's effective input plus its
 * output, read only from turns built on the CURRENT window.
 *
 * Without a compaction that is simply the session's last real turn. After
 * one, the scan starts at the first live post-compaction turn
 * (`CompactionEvent.firstLiveIndex`): records carried over past the boundary
 * still report the old window, and reading one right after a compaction put
 * a 13K window at 82%. Before the first live turn exists, the window is
 * estimated as Claude Code's `postTokens` plus the fixed context (derived
 * system prompt, CLAUDE.md, core tool and MCP schemas, memory) and the
 * attachments re-sent after the boundary. postTokens is Claude Code's
 * chars/4 count of the summary and those attachments, which runs well below
 * their real token count, so adding the attachments again lands closer: on real
 * boundaries the estimate came within about -17% to +19% of the next
 * request (about a third low at the first prompt of a continuation file,
 * where no fixed-context anchor exists yet).
 *
 * @param messages - Session messages (the classifier's `effectiveMessages`)
 * @param events - Compaction events detected on the same messages
 * @param classified - Per-record classification of `messages`
 * @param fixedContextTokens - The session's fixed-context estimate
 * @returns Live window total in tokens, or null when no usable signal exists
 */
function liveWindowTokens(
  messages: SessionMessage[],
  events: CompactionEvent[],
  classified: ClassifiedMessage[],
  fixedContextTokens: number,
): number | null {
  const last = events[events.length - 1];
  if (!last) return computeEffectiveInputTokens(messages);
  if (last.firstLiveIndex !== undefined) {
    return computeEffectiveInputTokens(messages, last.firstLiveIndex);
  }
  if (last.postTokens === undefined) return null;
  let reattached = 0;
  for (let i = last.beforeIndex + 1; i < classified.length; i++) {
    if (classified[i]!.isAttachment) reattached += classified[i]!.tokens;
  }
  return last.postTokens + fixedContextTokens + reattached;
}

/**
 * Build a CRUSTS bucket array from category token and accuracy maps.
 *
 * The buckets come back on the raw content basis (`tokens ===
 * contentTokens`); `reconcileBuckets` scales them to the API window total
 * where that is sound.
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
    contentTokens: categoryTokens[cat],
  }));
}

/**
 * Guard band for bucket reconciliation. Content-sum estimation noise
 * (tokenizer divisors, framing medians, attachment estimates) lands the
 * scale near 1 on healthy classifications — measured 1.03-1.20 on real
 * sessions after the v0.8.0 root fixes. A scale outside this band means the
 * classifier is missing (or double-counting) whole components, and scaling
 * would mask that defect instead of absorbing noise.
 */
export const RECONCILE_SCALE_MIN = 0.7;
/** Upper bound of the reconciliation guard band — see RECONCILE_SCALE_MIN. */
export const RECONCILE_SCALE_MAX = 1.4;

/**
 * Reconcile content-estimated buckets to the API-reported window total.
 *
 * The API's effective-input number is the truth about window size, but only
 * the classifier knows the composition. This projects the composition onto
 * the API total: each bucket becomes `floor(contentTokens * scale)` with
 * `scale = apiTotal / contentSum`, and the sub-token remainder (0..5) is
 * added to the largest bucket so the invariant `sum(tokens) === apiTotal`
 * holds EXACTLY. Percentages are recomputed from the reconciled values.
 *
 * Guarded so it cannot hide defects: when the scale falls outside
 * [`RECONCILE_SCALE_MIN`, `RECONCILE_SCALE_MAX`] the buckets are returned
 * unscaled (basis 'content') with the offending scale recorded, keeping the
 * audit tripwire visible. No API total (or an empty content sum) also
 * returns the raw buckets with scale 1.
 *
 * @param buckets - Raw buckets from `buildBuckets` (tokens === contentTokens)
 * @param apiTotal - API-derived window total for the view, or null when no
 *   assistant turn with usage data exists
 * @returns The (possibly scaled) buckets plus the reconciliation descriptor
 */
export function reconcileBuckets(
  buckets: CrustsBucket[],
  apiTotal: number | null,
): { buckets: CrustsBucket[]; reconciliation: BucketReconciliation } {
  const contentSum = buckets.reduce((sum, b) => sum + b.contentTokens, 0);
  if (apiTotal === null || apiTotal <= 0 || contentSum <= 0) {
    return { buckets, reconciliation: { scale: 1, basis: 'content' } };
  }
  const scale = apiTotal / contentSum;
  if (scale < RECONCILE_SCALE_MIN || scale > RECONCILE_SCALE_MAX) {
    return { buckets, reconciliation: { scale, basis: 'content' } };
  }
  const scaled = buckets.map((b) => ({ ...b, tokens: Math.floor(b.contentTokens * scale) }));
  const remainder = apiTotal - scaled.reduce((sum, b) => sum + b.tokens, 0);
  let largest = scaled[0]!;
  for (const b of scaled) {
    if (b.contentTokens > largest.contentTokens) largest = b;
  }
  largest.tokens += remainder;
  for (const b of scaled) {
    b.percentage = (b.tokens / apiTotal) * 100;
  }
  return { buckets: scaled, reconciliation: { scale, basis: 'api' } };
}

/**
 * Print the outcome of a bucket reconciliation under --verbose.
 *
 * An out-of-band scale is the accuracy tripwire the guard exists for, so it
 * is called out explicitly rather than silently leaving the buckets raw.
 *
 * @param label - Which view was reconciled ('lifetime' or 'current context')
 * @param reconciliation - Result descriptor from `reconcileBuckets`
 * @param apiTotal - API total the reconciliation targeted (null when absent)
 */
function reportReconciliation(
  label: string,
  reconciliation: BucketReconciliation,
  apiTotal: number | null,
): void {
  if (!verbose || apiTotal === null) return;
  if (reconciliation.basis === 'api') {
    console.error(`[verbose] ${label} buckets reconciled to the API window total (scale ${reconciliation.scale.toFixed(3)})`);
  } else if (reconciliation.scale < RECONCILE_SCALE_MIN || reconciliation.scale > RECONCILE_SCALE_MAX) {
    console.error(`[verbose] ${label} bucket scale ${reconciliation.scale.toFixed(3)} is outside [${RECONCILE_SCALE_MIN}, ${RECONCILE_SCALE_MAX}]; buckets left on the content basis. A drift this large usually means a classification defect, not estimation noise.`);
  }
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
 * @param modelOverride - Optional live model ID (e.g. `claude-opus-4-7[1m]`) that takes precedence over the stripped ID in the JSONL. Used by the statusline path where Claude Code preserves the variant in its stdin payload.
 * @param limitOverride - Optional live context-window size in tokens (the statusline payload's `context_window.context_window_size`). Wins over every recorded signal.
 * @returns Complete CRUSTS breakdown with per-message detail
 */
export function classifySession(
  messages: SessionMessage[],
  configData: ConfigData,
  untilIndex?: number,
  modelOverride?: string,
  limitOverride?: number,
): CrustsBreakdown {
  // Determine effective endpoint: explicit --until, or auto-trim CRUSTS invocation
  const effectiveEnd = untilIndex ?? findAnalysisCutoff(messages);
  const effectiveMessages = effectiveEnd < messages.length
    ? messages.slice(0, effectiveEnd)
    : messages;

  const toolUseIdMap = buildToolUseIdMap(effectiveMessages);
  const lastHumanIdx = findLastHumanTextIndex(effectiveMessages);

  // Claude Code version that wrote these records (first non-empty `version`);
  // feeds version-keyed constants such as the core tool schema cost.
  const claudeCodeVersion = detectClaudeCodeVersion(effectiveMessages);
  // Core (always-loaded) tool schema cost: calibration override > version
  // table > the scanner's legacy baseline. Fixed per session, not in JSONL.
  const coreSchema = resolveCoreSchemaTokens(
    claudeCodeVersion,
    configData.builtInTools.coreSchemaOverride,
    configData.builtInTools.totalEstimatedTokens,
  );

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

  // Deferred tools that ToolSearch results loaded (first-load order, each
  // once: a loaded schema stays in the window) and their estimated cost.
  const loadedDeferred: string[] = [];
  const loadedDeferredSet = new Set<string>();
  let loadedSchemaTokens = 0;
  let totalDeferredReported: number | undefined;

  // Per-MCP-server invocation tokens (keyed by server name parsed from `mcp__<server>__<tool>`)
  const mcpServerTokens = new Map<string, number>();
  const mcpServerInvocations = new Map<string, number>();

  // Assistant split-line groups (by message.id, fallback requestId): one
  // API response's output_tokens is counted once per group, apportioned
  // across the lines by content share. Legacy differing-usage groups keep
  // per-line accounting.
  const lineGroups = groupAssistantLines(effectiveMessages);
  const apportionedOutput = buildApportionedTokens(effectiveMessages, lineGroups);

  // Resolve the model ID and full session model history.
  //
  // `modelHistory` walks every non-synthetic assistant turn in order and
  // groups contiguous runs of the same model into segments, recording the
  // API token flows for each segment. When the user switches Claude models
  // mid-session (e.g. sonnet → opus), each switch closes one segment and
  // opens another — the chronological flow is preserved, not collapsed.
  //
  // `breakdown.model` reports the CURRENT model (the last non-synthetic
  // assistant) rather than the first, which is more useful as an "at-a-glance
  // what am I on?" label. The first model is still accessible via
  // `modelHistory.segments[0].model`.
  //
  // A live override (Claude Code's statusline payload — which preserves the
  // `[1m]` variant JSONL strips) takes precedence when supplied.
  const modelHistory = computeModelHistory(effectiveMessages, lineGroups);
  // Before the first response there is no assistant model yet, but Claude
  // Code's `model` attachment already names it (identity.modelId), so a
  // fresh native-1M session is not sized at the 200K default.
  const model = modelOverride
    ?? (modelHistory.current !== 'unknown' ? modelHistory.current : announcedModel(effectiveMessages) ?? 'unknown');
  // Contiguous same-model spans covering every message index.
  const modelSpans = computeModelSpans(effectiveMessages, modelHistory);

  // crusts' character divisors were measured on Claude's older tokenizer;
  // Claude 4.7 and later count about 30% more tokens for the same text. So
  // every content estimate is scaled by the tokenizer of the model its
  // message ran on, and the config overhead by the current model's. Exact
  // API figures (output tokens, usage) and the core tool schema table, read
  // off /context, are not scaled.
  const currentFactor = tokenizerFactor(model);
  // The classification loop asks in index order, so one cursor walks the spans.
  let spanCursor = 0;
  const factorAt = (index: number): number => {
    while (spanCursor < modelSpans.length - 1 && index > modelSpans[spanCursor]!.end) spanCursor++;
    const spanModel = modelSpans[spanCursor]?.model;
    return spanModel && spanModel !== 'unknown' ? tokenizerFactor(spanModel) : currentFactor;
  };

  // Classify each message
  const classifiedMessages: ClassifiedMessage[] = [];
  let cumulative = 0;

  // The "first message" system-marker rule targets the first API
  // conversation record; a SessionStart attachment ahead of it must not
  // steal that position.
  const firstNonAttachmentIdx = effectiveMessages.findIndex((m) => m.type !== 'attachment');

  for (let i = 0; i < effectiveMessages.length; i++) {
    const msg = effectiveMessages[i]!;
    const isLastHuman = i === lastHumanIdx;
    const isFirst = i === firstNonAttachmentIdx;

    const { category, toolName } = classifyMessage(msg, isLastHuman, isFirst, toolUseIdMap);
    const apportioned = apportionedOutput.get(i);
    // Apportioned lines: the group sum is API-exact but the per-line split
    // is content-estimated, so each line reports 'estimated'.
    const estimate = apportioned !== undefined
      ? { tokens: apportioned, accuracy: 'estimated' as const }
      : estimateMessageTokens(msg);
    // Apportioned lines split an exact API sum, so only content estimates scale.
    let tokens = apportioned === undefined && estimate.accuracy === 'estimated'
      ? Math.round(estimate.tokens * factorAt(i))
      : estimate.tokens;
    let accuracy = estimate.accuracy;

    // ToolSearch results materialise deferred schemas into the request's
    // tools array. The schema text is never written to the JSONL (the
    // result is a list of bare `tool_reference` names), so the load cost is
    // charged here, at the result index, once per distinct name.
    const toolSearchLoad = extractToolSearchLoad(msg, toolUseIdMap);
    if (toolSearchLoad) {
      if (toolSearchLoad.totalDeferred !== undefined) {
        totalDeferredReported = toolSearchLoad.totalDeferred;
      }
      let loadCost = 0;
      for (const name of toolSearchLoad.names) {
        if (loadedDeferredSet.has(name)) continue;
        loadedDeferredSet.add(name);
        loadedDeferred.push(name);
        loadCost += deferredLoadCost(name);
      }
      if (loadCost > 0) {
        tokens += loadCost;
        loadedSchemaTokens += loadCost;
        accuracy = 'estimated';
      }
    }

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
      // Per-MCP-server accounting: `mcp__<server>__<tool>` is Anthropic's naming convention
      if (toolName) {
        const server = mcpServerName(toolName);
        if (server) {
          mcpServerTokens.set(server, (mcpServerTokens.get(server) ?? 0) + tokens);
          if (msg.type === 'assistant') {
            mcpServerInvocations.set(server, (mcpServerInvocations.get(server) ?? 0) + 1);
          }
        }
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
      ...(msg.requestId ? { requestId: msg.requestId } : {}),
      ...(msg.message?.id ? { messageId: msg.message.id } : {}),
      ...(msg.type === 'attachment' ? { isAttachment: true } : {}),
    });
  }

  // Config overhead tokens (added to both lifetime and current context).
  // The session's own `instructions` attachment (2.1.268+) replaces the disk
  // copies of CLAUDE.md and memory when it was recorded.
  const configOverhead = computeConfigOverhead(configData, coreSchema.tokens, currentFactor);
  const recordedInstructions = instructionsOverhead(effectiveMessages, currentFactor);
  if (recordedInstructions) {
    configOverhead.systemTokens = recordedInstructions.systemTokens;
    configOverhead.memoryTokens = recordedInstructions.memoryTokens;
  }

  // Derive overhead values from THIS SESSION's API usage data
  const derivedSystemPrompt = deriveInternalSystemPrompt(
    effectiveMessages, classifiedMessages, compactionEvents, configData, coreSchema.tokens, configOverhead,
    currentFactor,
  );
  // The System bucket carries Claude Code's own system prompt: the recorded
  // copy when the session has one (2.1.269+), else the derived residual. The
  // residual is everything the anchor turn held beyond the estimated
  // components, so with a recorded prompt the rest of it is those estimates'
  // shortfall, which reconciliation to the API total spreads over every
  // bucket instead of piling it onto System.
  const recordedPrompt = recordedSystemPrompt(effectiveMessages, currentFactor);
  const systemPromptTokens = recordedPrompt?.tokens ?? derivedSystemPrompt?.tokens ?? 0;
  // Add config overhead to session lifetime totals
  addConfigOverhead(categoryTokens, categoryAccuracy, configOverhead);

  // Add Claude Code's system prompt to the System bucket
  if (systemPromptTokens > 0) {
    categoryTokens.system += systemPromptTokens;
    categoryAccuracy.system = 'estimated';
  }

  // Derive framing overhead from the post-compaction window for cleaner
  // data (pre-compaction pairs span compaction boundaries and produce
  // negative deltas). Distributed BEFORE the content sum and lifetime
  // buckets are computed (M9) so the lifetime view includes framing on
  // the same basis as currentContext does. The window opens right after
  // the boundary record — the same slice start the currentContext view
  // uses — so both derive from an identical post-compaction view.
  const framingStartIndex = compactionEvents.length > 0
    ? compactionEvents[compactionEvents.length - 1]!.beforeIndex + 1
    : 0;
  const derivedFraming = deriveMessageFraming(effectiveMessages, classifiedMessages, lineGroups, framingStartIndex);

  // Add derived framing overhead — distribute proportionally across
  // categories. Attachment rows are injected content, not messages, so
  // they carry no per-message framing.
  if (derivedFraming && derivedFraming.totalTokens > 0) {
    const msgCountByCategory: Record<CrustsCategory, number> = {
      conversation: 0, retrieved: 0, user: 0, system: 0, tools: 0, state: 0,
    };
    for (const cm of classifiedMessages) {
      if (cm.isAttachment) continue;
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

  // Classifier's per-category content sum — the internal accounting number,
  // kept around for --verbose diagnostics. NOT the authoritative window size;
  // see `computeEffectiveInputTokens` for the canonical per-turn total.
  const contentSumTokens = Object.values(categoryTokens).reduce((a, b) => a + b, 0);
  // Authoritative window size from the latest live assistant turn's API
  // usage (see `liveWindowTokens`). Falls back to the content sum when no
  // usable usage data exists (fresh sessions, synthetic-only sessions, or
  // fixtures without `usage` fields).
  // The pre-live estimate keeps the derived figure even when the prompt was
  // recorded: anchored on the exact first request, it also carries the
  // estimates' shortfall, which offsets the chars/4 basis of `postTokens`.
  const fixedContextTokens = (derivedSystemPrompt?.tokens ?? recordedPrompt?.tokens ?? 0) + configOverhead.systemTokens
    + configOverhead.toolTokens + configOverhead.mcpTokens + configOverhead.memoryTokens;
  const effectiveInputTokens = liveWindowTokens(
    effectiveMessages, compactionEvents, classifiedMessages, fixedContextTokens,
  );
  const totalTokens = effectiveInputTokens ?? contentSumTokens;
  // Before the first live turn, the last event's post-compaction size is the
  // same estimate (postTokens alone is messages only).
  const lastEvent = compactionEvents[compactionEvents.length - 1];
  if (lastEvent && lastEvent.detection === 'marker' && lastEvent.firstLiveIndex === undefined
    && effectiveInputTokens !== null) {
    lastEvent.tokensAfter = effectiveInputTokens;
    lastEvent.tokensDropped = lastEvent.tokensBefore - effectiveInputTokens;
  }

  // Reconcile lifetime buckets to the API window total ONLY when the session
  // never compacted (lifetime === current window). In compacted sessions the
  // API number describes just the LAST window while the lifetime buckets
  // span every window, so scaling them by it would fabricate a composition;
  // they stay on the raw content basis (currentContext carries the
  // reconciled live-window view instead).
  let buckets = buildBuckets(categoryTokens, categoryAccuracy);
  let reconciliation: BucketReconciliation = { scale: 1, basis: 'content' };
  if (compactionEvents.length === 0) {
    const reconciled = reconcileBuckets(buckets, effectiveInputTokens);
    buckets = reconciled.buckets;
    reconciliation = reconciled.reconciliation;
    reportReconciliation('Lifetime', reconciliation, effectiveInputTokens);
  }

  // Build loaded vs used tool lists.
  //
  // A schema is in the window when the tool is core, when the session
  // invoked it without a ToolSearch load (so it was core on that Claude
  // Code version), or when a ToolSearch result loaded it. Names that only
  // appear in the deferred list cost nothing and are never listed as loaded
  // or unused.
  const usedToolsArray = [...usedToolNames];
  const loadedToolSet = new Set<string>(configData.builtInTools.tools);
  for (const name of usedToolsArray) {
    if (!loadedDeferredSet.has(name)) loadedToolSet.add(name);
  }
  for (const name of loadedDeferred) loadedToolSet.add(name);
  const loadedTools = [...loadedToolSet];
  const unusedTools = loadedTools.filter((t) => !usedToolNames.has(t));

  const deferredToolNames = collectDeferredToolNames(effectiveMessages);
  const deferredBuiltIn = deferredToolNames.filter((name) => !isMcpToolName(name));
  const deferredMcp = deferredToolNames.filter((name) => isMcpToolName(name));

  const mcpSchemaTokens = configData.mcpServers.reduce(
    (sum, s) => sum + s.estimatedSchemaTokens, 0,
  );

  const toolBreakdown: ToolBreakdown = {
    loadedTools,
    usedTools: usedToolsArray,
    unusedTools,
    schemaTokens: coreSchema.tokens + mcpSchemaTokens + loadedSchemaTokens,
    callTokens: toolCallTokens,
    resultTokens: toolResultTokens,
    coreSchemaTokens: coreSchema.tokens,
    coreSchemaSource: coreSchema.source,
    deferredBuiltIn,
    deferredMcp,
    loadedDeferred,
    loadedSchemaTokens,
    ...(totalDeferredReported !== undefined ? { totalDeferredReported } : {}),
  };

  // Build per-MCP-server breakdown whenever any server is configured OR
  // observed in the session itself. Config files can be absent or stale
  // (they moved to ~/.claude.json and plugin caches), but recorded
  // `mcp__<server>__` tool names and the deferred-tools listing prove
  // which servers the session actually had connected.
  const observedServers = new Set<string>([
    ...mcpServerTokens.keys(),
    ...mcpServerInvocations.keys(),
  ]);
  for (const name of [...deferredMcp, ...loadedDeferred, ...usedToolNames]) {
    const server = mcpServerName(name);
    if (server) observedServers.add(server);
  }
  const mcpServerInfos: MCPServerInfo[] = [...configData.mcpServers];
  for (const server of observedServers) {
    if (!mcpServerInfos.some((s) => s.name === server)) {
      mcpServerInfos.push({ name: server, toolCount: null, estimatedSchemaTokens: 0, source: 'observed' });
    }
  }
  let mcpBreakdown: MCPBreakdown | undefined;
  if (mcpServerInfos.length > 0) {
    const servers = mcpServerInfos.map((s) => {
      const invocationCount = mcpServerInvocations.get(s.name) ?? 0;
      const tokensSpent = mcpServerTokens.get(s.name) ?? 0;
      return {
        name: s.name,
        source: s.source,
        invocationCount,
        tokensSpent,
        unused: invocationCount === 0,
      };
    });
    servers.sort((a, b) => b.tokensSpent - a.tokensSpent);
    mcpBreakdown = {
      servers,
      unusedServers: servers.filter((s) => s.unused).map((s) => s.name),
      totalMcpTokens: servers.reduce((sum, s) => sum + s.tokensSpent, 0),
    };
  }

  // Window size is a property of the MODEL RUN, not the compaction window:
  // compaction never resizes the window, but a mid-session model switch
  // can. Each compaction event's limit is resolved from the signals of
  // every span of the model its window ran on (`modelSpans`, computed before
  // classification), so pre-switch 200K events keep their own limit instead
  // of inheriting the current model's window.
  const lastSpan = modelSpans[modelSpans.length - 1]!;
  // Evidence for one model's window is not confined to one contiguous run:
  // after fable -> opus-4-8 -> fable -> opus-4-8, the last opus-4-8 run
  // often has no /context output and no turn above 200K of its own, while an
  // earlier opus-4-8 run proved the window ("/ 1m"). Scoping to the last run
  // alone resolved 200K there and fired advisories at a real 16% of 1M. So
  // each resolution reads every run of the same model family (other
  // families' runs stay out, and a /context output is also checked against
  // the model it names).
  const familyMessageCache = new Map<string, SessionMessage[]>();
  /** Messages of every span that ran on `target`'s model family. */
  const sameFamilyMessages = (target: string): SessionMessage[] => {
    const family = modelFamily(target);
    const cached = familyMessageCache.get(family);
    if (cached) return cached;
    const out: SessionMessage[] = [];
    for (const s of modelSpans) {
      if (modelFamily(s.model) !== family) continue;
      // An empty window still yields one span at index 0; skip the hole.
      for (let k = s.start; k <= s.end; k++) {
        const record = effectiveMessages[k];
        if (record) out.push(record);
      }
    }
    familyMessageCache.set(family, out);
    return out;
  };
  for (const event of compactionEvents) {
    // The window that ENDED at this event ran on the model of the last
    // real assistant at or before `beforeIndex` (the boundary record
    // itself sits between spans when the user switched at the compaction).
    let anchor = event.beforeIndex;
    while (anchor > 0) {
      const m = effectiveMessages[anchor];
      if (m && m.type === 'assistant' && m.message?.model && m.message.model !== '<synthetic>') break;
      anchor--;
    }
    const span = modelSpans.find((s) => anchor >= s.start && anchor <= s.end) ?? modelSpans[0]!;
    // Historical windows use the recorded signals only (usage, /context
    // output, model-id, native table) plus the settings family match; the
    // live payload override describes the CURRENT window, never a past one.
    event.contextLimit = resolveContextLimitWithSignal(
      span.model,
      sameFamilyMessages(span.model),
      { settingsModels: configData.settingsModels, disable1m: configData.compaction?.disable1m },
    ).limit;
  }

  // Claude Code strips the `[1m]` variant from the recorded model ID, so
  // every signal is combined in priority order: live payload override,
  // recorded /context output, model-ID variant, settings.json model,
  // usage above 200K (conclusive 1M), and the native-1M model table.
  // Scoped to the runs of the CURRENT model family (the whole session when
  // the model never switched) so `context_limit` reports the window the
  // session is ON, not one a different pre-switch model ran with.
  const currentFamilyMessages = sameFamilyMessages(model);
  const contextResolution = resolveContextLimitWithSignal(
    model,
    currentFamilyMessages.length > 0
      ? currentFamilyMessages
      : lastSpan.start > 0 ? effectiveMessages.slice(lastSpan.start) : effectiveMessages,
    {
      limitOverride,
      settingsModels: configData.settingsModels,
      disable1m: configData.compaction?.disable1m,
    },
  );
  const contextLimit = contextResolution.limit;
  if (verbose) {
    const signalExplanation =
      contextResolution.signal === 'payload' ? 'live payload supplied context_window.context_window_size' :
      contextResolution.signal === 'context-command' ? 'latest /context output recorded for this model reported this window' :
      contextResolution.signal === 'disable-1m' ? 'CLAUDE_CODE_DISABLE_1M_CONTEXT holds every model at 200K' :
      contextResolution.signal === 'model-id' ? `model-ID "${model}" matched a 1M-variant pattern` :
      contextResolution.signal === 'settings' ? 'settings.json pins a [1m] model matching this session model family' :
      contextResolution.signal === 'usage' ? 'an observed message exceeded 200K effective input (conclusive 1M)' :
      contextResolution.signal === 'native' ? `model "${model}" ships a native 1M window` :
      'no signal fired (payload, /context output, model-id, settings, usage, native); defaulting to 200K, the window of Opus 4.6, Sonnet 4.6 and older models without [1m].';
    console.error(`[verbose] Context limit: ${contextLimit.toLocaleString()} (signal: ${contextResolution.signal}) \u2014 ${signalExplanation}`);
    const coreExplanation =
      coreSchema.source === 'calibration' ? 'pinned by `claude-crusts calibrate` (/context "System tools" row)' :
      coreSchema.source === 'version' ? `version table for Claude Code ${claudeCodeVersion}` :
      'legacy baseline (no version signal, no calibration)';
    console.error(`[verbose] Core tool schemas: ${coreSchema.tokens.toLocaleString()} tokens (${coreExplanation})`);
    if (loadedDeferred.length > 0) {
      console.error(`[verbose] ToolSearch loaded ${loadedDeferred.length} deferred schema(s) (~${loadedSchemaTokens.toLocaleString()} tokens): ${loadedDeferred.join(', ')}`);
    }
    const thresholdOverrides = describeThresholdOverrides();
    if (thresholdOverrides.length > 0) {
      console.error(`[verbose] Waste thresholds overridden via ~/.claude-crusts/config.json:`);
      for (const note of thresholdOverrides) console.error(`[verbose]   ${note}`);
    }
  }

  // Build current context view (post-last-compaction) if compaction occurred
  let currentContext: CrustsBreakdown['currentContext'] = undefined;
  if (compactionEvents.length > 0) {
    const lastCompaction = compactionEvents[compactionEvents.length - 1]!;
    // The new window starts right AFTER the boundary record: Claude Code
    // re-sends everything written past the boundary — the compact summary
    // itself, re-sent file attachments, hook output, task notifications —
    // on the next request. `afterIndex` (the first post-boundary assistant
    // with usage, kept on CompactionEvent for tokensAfter scanning) can sit
    // many records later; slicing from it silently dropped those records
    // from the live-window buckets on every compacted session.
    const startIndex = lastCompaction.beforeIndex + 1;

    const currentCategoryTokens: Record<CrustsCategory, number> = {
      conversation: 0, retrieved: 0, user: 0, system: 0, tools: 0, state: 0,
    };
    const currentCategoryAccuracy: Record<CrustsCategory, 'exact' | 'estimated'> = {
      conversation: 'exact', retrieved: 'exact', user: 'exact',
      system: 'exact', tools: 'exact', state: 'exact',
    };

    // Pre-boundary messages Claude Code preserved verbatim across the
    // boundary (compactMetadata.preservedMessages) are re-sent in the new
    // window, so the post-compaction slice includes their indices too.
    const preservedIndices = (lastCompaction.preservedMessageIndices ?? [])
      .filter((idx) => idx >= 0 && idx < startIndex && idx < classifiedMessages.length);
    const currentIndices: number[] = [...preservedIndices];
    for (let i = startIndex; i < classifiedMessages.length; i++) currentIndices.push(i);

    for (const i of currentIndices) {
      const cm = classifiedMessages[i]!;
      currentCategoryTokens[cm.category] += cm.tokens;
      if (cm.accuracy === 'estimated') {
        currentCategoryAccuracy[cm.category] = 'estimated';
      }
    }

    // Add same config overhead to current context
    addConfigOverhead(currentCategoryTokens, currentCategoryAccuracy, configOverhead);

    // Add Claude Code's system prompt to the current context too
    if (systemPromptTokens > 0) {
      currentCategoryTokens.system += systemPromptTokens;
      currentCategoryAccuracy.system = 'estimated';
    }
    if (derivedFraming && derivedFraming.tokensPerMessage > 0) {
      const currentMessages = currentIndices.map((i) => classifiedMessages[i]!);
      const currentMsgCount: Record<CrustsCategory, number> = {
        conversation: 0, retrieved: 0, user: 0, system: 0, tools: 0, state: 0,
      };
      for (const cm of currentMessages) {
        if (cm.isAttachment) continue;
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

    const currentContentSum = Object.values(currentCategoryTokens).reduce((a, b) => a + b, 0);
    // Same API-first rule for the post-compaction slice — without this, heavy
    // multi-compact sessions display content-sum > context_limit (Bug #9).
    // The live-window total already reads only post-compaction turns (or
    // the recorded postTokens before the first one).
    const currentEffective = effectiveInputTokens;
    const currentTotal = currentEffective ?? currentContentSum;
    // The current-context slice IS the live window, so reconciliation to the
    // API total is always attempted here (the guard band still applies).
    const currentReconciled = reconcileBuckets(
      buildBuckets(currentCategoryTokens, currentCategoryAccuracy),
      currentEffective,
    );
    reportReconciliation('Current-context', currentReconciled.reconciliation, currentEffective);
    currentContext = {
      buckets: currentReconciled.buckets,
      total_tokens: currentTotal,
      contentSumTokens: currentContentSum,
      reconciliation: currentReconciled.reconciliation,
      free_tokens: Math.max(0, contextLimit - currentTotal),
      usage_percentage: (currentTotal / contextLimit) * 100,
      startIndex,
    };
  }

  // Compute session duration from first and last message timestamps
  let durationSeconds: number | null = null;
  const firstTs = effectiveMessages[0]?.timestamp;
  const lastTs = effectiveMessages[effectiveMessages.length - 1]?.timestamp;
  if (firstTs && lastTs) {
    const diffMs = new Date(lastTs).getTime() - new Date(firstTs).getTime();
    if (diffMs > 0) durationSeconds = Math.round(diffMs / 1000);
  }

  // When Claude Code will compact this window: the token trigger from the
  // auto-compact window settings, and whether idle compaction applies.
  const compaction = resolveCompactionModel(
    contextLimit,
    model,
    currentContext?.total_tokens ?? totalTokens,
    configData.compaction,
    latestCacheTtl(effectiveMessages),
    latestClaudeCodeVersion(effectiveMessages),
  );

  return {
    buckets,
    total_tokens: totalTokens,
    contentSumTokens,
    reconciliation,
    context_limit: contextLimit,
    free_tokens: Math.max(0, contextLimit - totalTokens),
    usage_percentage: (totalTokens / contextLimit) * 100,
    messages: classifiedMessages,
    toolBreakdown,
    mcpBreakdown,
    model,
    modelHistory,
    claudeCodeVersion,
    durationSeconds,
    compactionEvents,
    currentContext,
    derivedOverhead: {
      internalSystemPrompt: derivedSystemPrompt,
      recordedSystemPrompt: recordedPrompt,
      messageFraming: derivedFraming,
    },
    compaction,
  };
}

// ---------------------------------------------------------------------------
// Derived overhead — values computed from THIS SESSION's API usage data
// ---------------------------------------------------------------------------

/**
 * Derive Claude Code's fixed context (the part not present in the JSONL)
 * from an ANCHOR turn: the first API turn whose whole window this file
 * records.
 *
 * In a fresh session the anchor is the first assistant turn. Its effective
 * input is the fixed context plus everything recorded before it: user-role
 * records (the typed prompt, skill bodies, slash-command wrappers) and
 * attachment records. When a compaction boundary precedes the first turn
 * that was built from it (a continued session's file opens with the
 * previous conversation's compaction followed by carried-over turns), the
 * fresh view does not exist; the anchor is then the first live turn after a
 * boundary, and its window opens at that boundary (compact summary,
 * preserved and carried-over messages, re-injected attachments, the prompt).
 * Anchoring on a carried-over record attributed a whole previous
 * conversation to the fixed context (790,912 tokens).
 *
 *   derived = anchor input - (CLAUDE.md + core tool schemas + memory
 *             + skills + every recorded window record before the anchor)
 *
 * Accepted when `1,000 <= derived <= smallest live-turn input`: every live
 * turn carries the fixed context, so it can never exceed the smallest live
 * window (carried-over records are not live). Candidates are tried in order
 * (the fresh window, then each compaction window) and the first accepted
 * one wins. There is no absolute ceiling: the fixed context grew well past
 * the old 15K cap on current Claude Code versions (observed ~43K on
 * 2.1.239), and an absolute cap silently discarded the whole System
 * component.
 *
 * Different sessions will produce different values depending on model,
 * system prompt version, and tool configuration at the time.
 *
 * @param messages - Parsed session messages
 * @param classifiedMessages - Per-record classification of `messages`
 * @param compactionEvents - Compaction events detected on `messages`
 * @param configData - Config data from scanner
 * @param coreSchemaTokens - Resolved core tool schema cost for this session
 * @param overhead - The session's config overhead (CLAUDE.md and memory from
 *   its own instructions attachment when recorded, else from disk)
 * @param factor - Tokenizer factor for the disk skills estimate (see
 *   `tokenizerFactor`); the classified records and `overhead` are scaled already
 * @returns Derivation result or null if insufficient data
 */
function deriveInternalSystemPrompt(
  messages: SessionMessage[],
  classifiedMessages: ClassifiedMessage[],
  compactionEvents: CompactionEvent[],
  configData: ConfigData,
  coreSchemaTokens: number,
  overhead: ConfigOverhead,
  factor = 1,
): DerivedOverhead['internalSystemPrompt'] {
  /** A real API turn with usage. On current Claude Code the first turn's
   * input_tokens is typically 2 with the real context in cache_creation /
   * cache_read, so the effective sum is what matters. */
  const isUsageTurn = (m: SessionMessage): boolean =>
    m.type === 'assistant' && m.message?.model !== '<synthetic>' && effectiveInput(m.message?.usage) > 0;

  const firstUsageIndex = messages.findIndex(isUsageTurn);
  if (firstUsageIndex === -1) return null;

  // Turns past a boundary but before its first live turn are carried over
  // from the old window; they are neither anchors nor bound evidence.
  const markerEvents = compactionEvents.filter((e) => e.detection === 'marker');
  const carriedOver = new Set<number>();
  for (let n = 0; n < markerEvents.length; n++) {
    const e = markerEvents[n]!;
    const end = e.firstLiveIndex ?? markerEvents[n + 1]?.beforeIndex ?? messages.length;
    for (let j = e.beforeIndex + 1; j < end; j++) {
      if (isUsageTurn(messages[j]!)) carriedOver.add(j);
    }
  }
  let smallestLiveInput = Number.POSITIVE_INFINITY;
  for (let k = 0; k < messages.length; k++) {
    if (carriedOver.has(k) || !isUsageTurn(messages[k]!)) continue;
    smallestLiveInput = Math.min(smallestLiveInput, effectiveInput(messages[k]!.message!.usage));
  }

  const candidates: Array<{ start: number; anchor: number; preserved: number[] }> = [];
  const firstMarker = markerEvents[0];
  if (!firstMarker || firstMarker.beforeIndex > firstUsageIndex) {
    candidates.push({ start: 0, anchor: firstUsageIndex, preserved: [] });
  }
  for (const e of markerEvents) {
    if (e.firstLiveIndex === undefined) continue;
    candidates.push({
      start: e.beforeIndex + 1,
      anchor: e.firstLiveIndex,
      preserved: (e.preservedMessageIndices ?? []).filter((p) => p < e.beforeIndex),
    });
  }

  // Known components carried by every request (the same CLAUDE.md and
  // memory figures the views add as config overhead)
  const knownClaudeMd = overhead.systemTokens;
  // Core schema cost resolved per session (calibration > version > legacy)
  const knownToolSchemas = coreSchemaTokens;
  const knownMemory = overhead.memoryTokens;
  const discoveredSkillTokens = Math.round(configData.skills.totalEstimatedTokens * factor);

  for (const candidate of candidates) {
    const totalInput = effectiveInput(messages[candidate.anchor]!.message!.usage);

    // Window records before the anchor are part of its input but are
    // classified (and counted) in their own right, so they are subtracted
    // to keep them out of the residual. A `skill_listing` attachment is the
    // session's own record of the skills block and is preferred over the
    // scanner's discovery estimate; it is counted as the skills component,
    // not again as a generic attachment.
    let skillListingTokens = 0;
    let knownAttachments = 0;
    let knownFirstUserMessage = 0;
    let knownCarriedOver = 0;
    const windowIndices = [...candidate.preserved];
    for (let k = candidate.start; k < candidate.anchor; k++) windowIndices.push(k);
    for (const k of windowIndices) {
      const msg = messages[k]!;
      const tokens = classifiedMessages[k]?.tokens ?? 0;
      if (msg.type === 'attachment') {
        if (msg.attachment?.type === 'skill_listing' && skillListingTokens === 0) {
          skillListingTokens = tokens;
        } else {
          knownAttachments += tokens;
        }
      } else if (msg.type === 'user' && msg.isCompactSummary !== true) {
        knownFirstUserMessage += tokens;
      } else {
        knownCarriedOver += tokens;
      }
    }

    // Skills: the window's skill_listing attachment when present, else the
    // sum of discovered skills' estimated cost. Falls back to 476 (the
    // historical /context ground-truth observation) when no skills are
    // discovered, so sessions on machines without skills configured keep
    // their prior derivation.
    const knownSkills = skillListingTokens > 0
      ? skillListingTokens
      : discoveredSkillTokens > 0 ? discoveredSkillTokens : 476;

    const totalKnown = knownClaudeMd + knownToolSchemas + knownMemory + knownSkills
      + knownFirstUserMessage + knownAttachments + knownCarriedOver;
    const derived = totalInput - totalKnown;

    // Sanity check: at least 1K (anything smaller is estimation noise) and
    // never more than the smallest live window, which carries it too.
    const ceiling = Math.min(totalInput, smallestLiveInput);
    if (derived < 1000 || derived > ceiling) {
      if (verbose) {
        console.error(
          `[CRUSTS debug] Fixed-context derivation out of range at turn ${candidate.anchor}: ${derived}`
          + ` (anchor_input=${totalInput}, known=${totalKnown}, ceiling=${ceiling}). Skipping.`,
        );
      }
      continue;
    }

    if (verbose) {
      console.error(
        `[CRUSTS derived] Claude Code fixed context: ${derived} tokens`
        + ` (anchor_turn=${candidate.anchor}`
        + `, anchor_input=${totalInput}`
        + `, claude_md=${knownClaudeMd}`
        + `, tool_schemas=${knownToolSchemas}`
        + `, memory=${knownMemory}`
        + `, skills=${knownSkills}`
        + `, user_records=${knownFirstUserMessage}`
        + `, attachments=${knownAttachments}`
        + `, carried_over=${knownCarriedOver}`
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
        knownAttachments,
        knownCarriedOver,
        anchorIndex: candidate.anchor,
        totalKnown,
      },
    };
  }
  return null;
}

/**
 * Derive per-message framing overhead from consecutive assistant PAIRS,
 * one entry per API message.
 *
 * For each pair of consecutive API messages (both with usage data),
 * compute: actual_delta = next_total_input - current_total_input.
 * Then compute expected_delta = sum of classified tokens for the window
 * between them. The difference (actual - expected) / message_count =
 * framing per message.
 *
 * Since Claude Code v2.1.114 one API response spans several JSONL lines
 * (thinking / text / tool_use) sharing `message.id`, so the pair list is
 * built per GROUP: the entry sits on the group's LAST line (whose usage is
 * the response's final usage) while the expected-delta window opens at the
 * group's FIRST line. Opening at the last line dropped the earlier lines'
 * apportioned output shares (the thinking share is typically the bulk of
 * `output_tokens`), inflating every sample past the 0-50 acceptance band
 * and returning null on all split-line sessions.
 *
 * Uses the median of up to 20 samples for robustness against outliers.
 * Different sessions will produce different values.
 *
 * @param messages - Parsed session messages (post-compaction subset if applicable)
 * @param classifiedMessages - Already-classified messages with token estimates
 * @param lineGroups - Split-line groups from `groupAssistantLines`
 * @param startIndex - Start index in messages to sample from (e.g., post-compaction)
 * @returns Derivation result or null if insufficient data
 */
function deriveMessageFraming(
  messages: SessionMessage[],
  classifiedMessages: ClassifiedMessage[],
  lineGroups: Map<number, AssistantLineGroup>,
  startIndex: number = 0,
): DerivedOverhead['messageFraming'] {
  // One entry per API message, with the window boundary of its first line
  interface AssistantInfo {
    /** Index of the API message's LAST line (carries the final usage) */
    index: number;
    /** Index of its FIRST line — the expected-delta window opens here */
    firstIndex: number;
    totalInput: number;
  }

  const assistants: AssistantInfo[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.type !== 'assistant' || !msg.message?.usage) continue;
    const totalInput = effectiveInput(msg.message.usage);
    if (totalInput <= 0) continue;
    const group = lineGroups.get(i);
    if (group && group.identicalUsage && group.indices.length > 1) {
      // Split-line response: one entry, emitted at the group's last line.
      if (i !== group.indices[group.indices.length - 1]) continue;
      assistants.push({ index: i, firstIndex: group.indices[0]!, totalInput });
    } else {
      // Single-line responses, legacy differing-usage groups, and
      // ungroupable lines keep per-line pairing (their per-line tokens are
      // their own output, so the old window arithmetic is already right).
      assistants.push({ index: i, firstIndex: i, totalInput });
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

    // Sum classified tokens for the window [curr's first line, next's first
    // line): the whole curr group's apportioned output plus every record
    // between the responses, and nothing of next's own output. Attachment
    // rows contribute their tokens to the expected delta (their text IS
    // part of the input growth) but not to the per-message divisor — they
    // are injected into a turn, not framed as messages.
    let expectedDelta = 0;
    let msgCountBetween = 0;
    for (let i = curr.firstIndex; i < next.firstIndex; i++) {
      const cm = classifiedMessages[i];
      if (cm) {
        expectedDelta += cm.tokens;
        if (!cm.isAttachment) msgCountBetween++;
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

  // Only real messages carry framing; attachment rows are injected content.
  const framedMessageCount = countAnalyzedMessages(classifiedMessages);
  const totalTokens = tokensPerMessage * framedMessageCount;

  if (verbose) console.error(
    `[CRUSTS derived] Message framing: ${tokensPerMessage} tokens/msg`
    + ` (median of ${samples.length} samples, range ${sorted[0]!.toFixed(1)}-${sorted[sorted.length - 1]!.toFixed(1)})`
    + `, total overhead: ${totalTokens} tokens across ${framedMessageCount} messages`,
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
 * @param coreSchemaTokens - Core tool schema cost resolved for this session
 * @param factor - Tokenizer factor for the disk estimates of CLAUDE.md and
 *   memory (see `tokenizerFactor`); the schema figures are not estimates of
 *   text and are not scaled
 * @returns Overhead token values per category
 */
function computeConfigOverhead(configData: ConfigData, coreSchemaTokens: number, factor = 1): ConfigOverhead {
  return {
    systemTokens: Math.round(configData.systemPrompt.totalEstimatedTokens * factor),
    toolTokens: coreSchemaTokens,
    mcpTokens: configData.mcpServers.reduce((sum, s) => sum + s.estimatedSchemaTokens, 0),
    memoryTokens: Math.round(configData.memoryFiles.totalEstimatedTokens * factor),
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
