/**
 * Smart recommendations engine.
 *
 * Generates specific, actionable, rule-based recommendations from
 * CRUSTS analysis data. NO LLM calls — everything derived from data
 * we already have: waste items, breakdown, configData, messages.
 */

import type {
  CrustsBreakdown,
  WasteItem,
  Recommendation,
  RecommendationReport,
  ContextHealth,
  ConfigData,
  SessionMessage,
  FixPrompts,
} from './types.ts';
import { buildCompactFocus } from './optimizer.ts';

/**
 * Auto-compaction triggers at ~80% of context window.
 * Approximate — actual trigger is at turn boundaries, so heavy turns
 * (e.g. multiple file reads) can overshoot to ~85-90% before compaction fires.
 */
const COMPACTION_THRESHOLD = 0.80;

/** Context health thresholds */
const HEALTH_THRESHOLDS = {
  healthy: 50,
  warming: 70,
  hot: 85,
};

/**
 * Determine context health based on usage percentage.
 *
 * @param usagePercent - Current context usage as a percentage
 * @returns Context health classification
 */
function getContextHealth(usagePercent: number): ContextHealth {
  if (usagePercent < HEALTH_THRESHOLDS.healthy) return 'healthy';
  if (usagePercent < HEALTH_THRESHOLDS.warming) return 'warming';
  if (usagePercent < HEALTH_THRESHOLDS.hot) return 'hot';
  return 'critical';
}

/**
 * Estimate how many more messages can be sent before auto-compaction.
 *
 * Uses the average tokens per message from the current context window
 * (post-compaction if applicable) for more accurate projection.
 *
 * @param breakdown - The CRUSTS breakdown
 * @returns Estimated messages remaining, or null if can't calculate
 */
function estimateMessagesUntilCompaction(breakdown: CrustsBreakdown): number | null {
  const ctx = breakdown.currentContext ?? breakdown;
  const msgCount = breakdown.currentContext
    ? breakdown.messages.length - breakdown.currentContext.startIndex
    : breakdown.messages.length;
  if (msgCount === 0) return null;

  const compactionLimit = breakdown.context_limit * COMPACTION_THRESHOLD;
  if (ctx.total_tokens >= compactionLimit) return 0;

  const avgTokensPerMessage = ctx.total_tokens / msgCount;
  if (avgTokensPerMessage <= 0) return null;

  return Math.floor((compactionLimit - ctx.total_tokens) / avgTokensPerMessage);
}

// ---------------------------------------------------------------------------
// 1. DUPLICATE FILES
// ---------------------------------------------------------------------------

/**
 * Generate specific recommendations for each duplicated file read.
 *
 * @param waste - Detected waste items
 * @returns Recommendations with per-file detail and user tips
 */
function recommendDuplicateFiles(waste: WasteItem[]): Recommendation[] {
  const dupes = waste.filter((w) => w.type === 'duplicate_read');
  if (dupes.length === 0) return [];

  return dupes
    .sort((a, b) => b.estimated_tokens - a.estimated_tokens)
    .slice(0, 5)
    .map((d) => {
      const nameMatch = d.description.match(/"([^"]+)" read (\d+) times/);
      const locsMatch = d.description.match(/reads at ([^)]+?) are/);
      const filename = nameMatch?.[1] ?? 'file';
      const count = nameMatch?.[2] ?? '?';
      const locations = locsMatch?.[1] ?? '';

      return {
        priority: 2 as const,
        action: `${filename} read ${count}x — earlier reads at ${locations} are waste`,
        impact: d.estimated_tokens,
        reason: `Already in context. Say "In ${filename} that you already read, fix X" instead of re-reading.`,
      };
    });
}

// ---------------------------------------------------------------------------
// 2. COMPACT COMMAND — specific, copyable
// ---------------------------------------------------------------------------

/**
 * Generate a specific /compact command targeting the oldest waste block.
 *
 * @param waste - Detected waste items
 * @param breakdown - CRUSTS breakdown
 * @returns A copyable /compact recommendation with estimated savings
 */
function recommendCompactCommand(
  waste: WasteItem[],
  breakdown: CrustsBreakdown,
): Recommendation[] {
  const ctx = breakdown.currentContext ?? breakdown;
  if (ctx.total_tokens < breakdown.context_limit * 0.5) return [];

  // Share the waste-driven focus-string generator with `fix` block 3 and
  // `optimize`'s compact-focus entry, so all three commands emit the same
  // text on the same session.
  const focus = buildCompactFocus(waste);
  if (focus) {
    const wasteCount = waste.filter((w) => w.message_range && w.estimated_tokens > 100).length;
    return [{
      priority: 1,
      action: focus.text,
      impact: focus.savings,
      reason: `${wasteCount} waste item(s) in older messages. Compacting frees ~${focus.savings.toLocaleString()} tokens while retaining recent work.`,
    }];
  }

  // No targetable high/medium waste — context is still high enough to warrant
  // a general compact suggestion.
  return [{
    priority: 1,
    action: '/compact',
    impact: Math.floor(ctx.total_tokens * 0.25),
    reason: `Context at ${ctx.usage_percentage.toFixed(0)}%. Compaction will summarize older messages and free ~25% of tokens.`,
  }];
}

// ---------------------------------------------------------------------------
// 3. MCP SERVERS
// ---------------------------------------------------------------------------

/**
 * Generate MCP tool usage info.
 *
 * MCP tools are loaded on-demand (deferred) — they do NOT consume upfront
 * schema tokens like built-in tools. Only invoked tools cost tokens.
 * So "disable unused MCP servers" is bad advice — there's no savings.
 *
 * Instead, report which MCP tools were invoked and their token cost.
 *
 * @param configData - Config data from scanner
 * @param breakdown - CRUSTS breakdown (for used tool names)
 * @param messages - Session messages for MCP invocation detection
 * @returns Info-level recommendation about MCP status
 */
function recommendMCPInfo(
  configData: ConfigData,
  breakdown: CrustsBreakdown,
  messages: SessionMessage[],
): Recommendation[] {
  const servers = configData.mcpServers;
  if (servers.length === 0) return [];

  // Find MCP tools that were actually invoked
  const mcpToolNames = new Set(servers.map((s) => s.name));
  const invokedMcp: string[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.message?.content)) continue;
    for (const block of msg.message.content) {
      if (block.type === 'tool_use' && block.name && mcpToolNames.has(block.name)) {
        if (!invokedMcp.includes(block.name)) invokedMcp.push(block.name);
      }
    }
  }

  if (invokedMcp.length > 0) {
    return [{
      priority: 5,
      action: `MCP tools invoked: ${invokedMcp.join(', ')}`,
      impact: 0,
      reason: `MCP tools are loaded on-demand — only invoked tools consume tokens. ${servers.length} server(s) connected, ${invokedMcp.length} tool(s) used.`,
    }];
  }

  // Connected but none invoked — info only, not a problem
  const serverNames = servers.map((s) => s.name).join(', ');
  return [{
    priority: 5,
    action: `MCP: ${servers.length} server(s) connected, none invoked`,
    impact: 0,
    reason: `MCP tools are loaded on-demand — no upfront token cost for connected but unused servers (${serverNames}).`,
  }];
}

// ---------------------------------------------------------------------------
// 4. COMPACTION PREDICTION
// ---------------------------------------------------------------------------

/**
 * Generate compaction prediction with specific math and action options.
 *
 * @param breakdown - CRUSTS breakdown
 * @returns Recommendation with remaining message estimate and options
 */
function recommendCompactionPrediction(breakdown: CrustsBreakdown): Recommendation[] {
  const ctx = breakdown.currentContext ?? breakdown;
  const msgCount = breakdown.currentContext
    ? breakdown.messages.length - breakdown.currentContext.startIndex
    : breakdown.messages.length;
  if (msgCount === 0) return [];

  const threshold = breakdown.context_limit * COMPACTION_THRESHOLD;
  const avgPerMsg = ctx.total_tokens / msgCount;
  const remaining = avgPerMsg > 0
    ? Math.floor((threshold - ctx.total_tokens) / avgPerMsg)
    : null;

  if (remaining === null) return [];
  if (remaining <= 0) {
    return [{
      priority: 1,
      action: 'Context PAST compaction threshold — act now',
      impact: 0,
      reason: `At ${ctx.total_tokens.toLocaleString()}/${threshold.toLocaleString()} (${(ctx.total_tokens / threshold * 100).toFixed(0)}% of 80% limit). Options: (A) /compact now, (B) /clear to start fresh, (C) let auto-compact handle it (loses context quality).`,
    }];
  }

  if (remaining < 20) {
    return [{
      priority: 2,
      action: `~${remaining} messages until auto-compaction — act soon`,
      impact: 0,
      reason: `${ctx.total_tokens.toLocaleString()} tokens, ~${Math.round(avgPerMsg)} per message, threshold at ${threshold.toLocaleString()}. Options: (A) /compact to stay ahead, (B) /clear between tasks, (C) continue — auto-compact will trigger at ~80%.`,
    }];
  }

  if (remaining > 100) return []; // No action needed, don't clutter

  return [{
    priority: 5,
    action: `~${remaining} messages until auto-compaction`,
    impact: 0,
    reason: `${ctx.total_tokens.toLocaleString()} tokens, ~${Math.round(avgPerMsg)} per message. You have room. No action needed.`,
  }];
}

// ---------------------------------------------------------------------------
// 5. CLAUDE.MD SIZE
// ---------------------------------------------------------------------------

/**
 * Generate specific CLAUDE.md size reduction recommendation.
 *
 * @param configData - Config data from scanner
 * @returns Recommendation with current size and split suggestion
 */
function recommendClaudeMdSplit(configData: ConfigData): Recommendation[] {
  const total = configData.systemPrompt.totalEstimatedTokens;
  if (total <= 1500) return [];

  const files = configData.systemPrompt.files.filter((f) => f.exists);
  const fileDetails = files
    .map((f) => {
      const name = f.path.replace(/\\/g, '/').split('/').pop() ?? f.path;
      const lines = f.content.split('\n').length;
      return `${name}: ${lines} lines, ~${f.estimatedTokens.toLocaleString()} tokens`;
    })
    .join('; ');

  const excess = total - 1500;

  return [{
    priority: 4,
    action: `CLAUDE.md is ~${total.toLocaleString()} tokens — consider splitting`,
    impact: excess,
    reason: `${fileDetails}. Move project-specific sections to CLAUDE.local.md (gitignored, not loaded by default). Saves ~${excess.toLocaleString()} tokens per message.`,
  }];
}

// ---------------------------------------------------------------------------
// 6. SESSION HABITS — pick ONE most relevant tip
// ---------------------------------------------------------------------------

/**
 * Generate a single session habit recommendation based on the dominant pattern.
 *
 * @param breakdown - CRUSTS breakdown
 * @param waste - Detected waste items
 * @returns At most one recommendation for the most impactful habit change
 */
function recommendSessionHabit(
  breakdown: CrustsBreakdown,
  waste: WasteItem[],
): Recommendation[] {
  const compactionCount = breakdown.compactionEvents.length;
  const dupeCount = waste.filter((w) => w.type === 'duplicate_read').length;
  const toolBucket = breakdown.buckets.find((b) => b.category === 'tools');
  const toolPct = toolBucket?.percentage ?? 0;

  // Pick the most relevant habit — only ONE
  if (compactionCount >= 3) {
    return [{
      priority: 5,
      action: 'Habit: use /clear between distinct tasks',
      impact: 0,
      reason: `${compactionCount} compactions this session. Each compaction loses context quality. Starting fresh sessions per task avoids degradation.`,
    }];
  }

  if (dupeCount >= 5) {
    return [{
      priority: 5,
      action: 'Habit: reference earlier reads instead of re-reading',
      impact: 0,
      reason: `${dupeCount} files read multiple times. Say "In X that you already read" instead of asking Claude to re-read files already in context.`,
    }];
  }

  if (toolPct > 50) {
    return [{
      priority: 5,
      action: 'Habit: start fresh sessions for new tasks',
      impact: 0,
      reason: `Tools are ${toolPct.toFixed(0)}% of context. Long sessions accumulate tool results. A fresh session starts clean.`,
    }];
  }

  return [];
}

// ---------------------------------------------------------------------------
// 7. TOP 5 CONSUMERS
// ---------------------------------------------------------------------------

/** A named token consumer for the top-5 list */
interface Consumer {
  name: string;
  tokens: number;
  detail: string;
}

/**
 * Build the top 5 context consumers by name with specific detail.
 *
 * Aggregates tokens from classified messages (grouped by filename for reads),
 * tool schemas, system prompt, and compaction summaries.
 *
 * @param breakdown - CRUSTS breakdown
 * @param waste - Detected waste items
 * @param configData - Config data from scanner
 * @param messages - Session messages (for file name extraction)
 * @returns Top 5 consumers as a single recommendation
 */
function recommendTopConsumers(
  breakdown: CrustsBreakdown,
  waste: WasteItem[],
  configData: ConfigData,
  messages: SessionMessage[],
): Recommendation[] {
  const consumers: Consumer[] = [];
  const ctx = breakdown.currentContext ?? breakdown;
  const startIdx = breakdown.currentContext?.startIndex ?? 0;
  const effectiveMessages = messages.slice(startIdx);

  // 1. File reads — group by filename
  const fileTokens = new Map<string, { tokens: number; readCount: number; dupeTokens: number }>();
  for (let i = 0; i < effectiveMessages.length; i++) {
    const msg = effectiveMessages[i]!;
    if (!Array.isArray(msg.message?.content)) continue;
    for (const block of msg.message.content) {
      if (block.type !== 'tool_use' || (block.name !== 'Read' && block.name !== 'FileReadTool')) continue;
      const filePath = (block.input?.file_path as string) ?? (block.input?.path as string) ?? '';
      const filename = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
      if (!filename) continue;

      // Token cost is on the next message (tool_result)
      const cm = breakdown.messages[startIdx + i + 1];
      const tokens = cm?.tokens ?? 0;
      const existing = fileTokens.get(filename);
      if (existing) {
        existing.tokens += tokens;
        existing.readCount++;
      } else {
        fileTokens.set(filename, { tokens, readCount: 1, dupeTokens: 0 });
      }
    }
  }

  // Add duplicate waste info
  for (const w of waste.filter((w) => w.type === 'duplicate_read')) {
    const match = w.description.match(/"([^"]+)"/);
    if (match?.[1]) {
      const entry = fileTokens.get(match[1]);
      if (entry) entry.dupeTokens = w.estimated_tokens;
    }
  }

  for (const [filename, info] of fileTokens) {
    const dupeNote = info.dupeTokens > 0
      ? ` — ${info.dupeTokens.toLocaleString()} in duplicates`
      : '';
    consumers.push({
      name: filename,
      tokens: info.tokens,
      detail: `read ${info.readCount}x${dupeNote}`,
    });
  }

  // 2. Tool schemas
  const tb = breakdown.toolBreakdown;
  consumers.push({
    name: 'Tool schemas',
    tokens: tb.schemaTokens,
    detail: `${tb.loadedTools.length} loaded, ${tb.usedTools.length} used`,
  });

  // 3. System prompt (CLAUDE.md + derived internal)
  const claudeMdTokens = configData.systemPrompt.totalEstimatedTokens;
  const derivedPrompt = breakdown.derivedOverhead?.internalSystemPrompt?.tokens ?? 0;
  consumers.push({
    name: 'System prompt',
    tokens: claudeMdTokens + derivedPrompt,
    detail: `CLAUDE.md ${claudeMdTokens.toLocaleString()} + internal ${derivedPrompt.toLocaleString()}`,
  });

  // 4. Compaction summary (if present)
  for (const event of breakdown.compactionEvents) {
    if (event.summaryTokens && event.summaryTokens > 0) {
      consumers.push({
        name: 'Compaction summary',
        tokens: event.summaryTokens,
        detail: `compressed context from ${event.tokensBefore.toLocaleString()} tokens`,
      });
      break; // Only show the most recent one
    }
  }

  // 5. Memory files
  const memTokens = configData.memoryFiles.totalEstimatedTokens;
  if (memTokens > 0) {
    consumers.push({
      name: 'Memory files',
      tokens: memTokens,
      detail: `${configData.memoryFiles.files.length} file(s)`,
    });
  }

  // Sort by tokens descending, take top 5
  consumers.sort((a, b) => b.tokens - a.tokens);
  const top5 = consumers.slice(0, 5);

  if (top5.length === 0) return [];

  const lines = top5.map((c, i) =>
    `${i + 1}. ${c.name} (${c.detail}) — ${c.tokens.toLocaleString()} tokens`
  );

  return [{
    priority: 3,
    action: 'Top 5 context consumers:\n     ' + lines.join('\n     '),
    impact: 0,
    reason: `These items consume the most context window space in your current session.`,
  }];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate a prioritized list of specific, actionable recommendations.
 *
 * Combines all recommendation sources, deduplicates, and returns
 * them sorted by priority (1 = most urgent). All rules are data-driven:
 * NO LLM calls, NO API tokens, ZERO cost.
 *
 * @param breakdown - The CRUSTS breakdown
 * @param waste - Detected waste items
 * @param configData - Config data from scanner
 * @param messages - Session messages for file name extraction
 * @returns Full recommendation report with health status
 */
export function generateRecommendations(
  breakdown: CrustsBreakdown,
  waste: WasteItem[],
  configData: ConfigData,
  messages: SessionMessage[],
): RecommendationReport {
  const recommendations: Recommendation[] = [
    ...recommendCompactCommand(waste, breakdown),
    ...recommendCompactionPrediction(breakdown),
    ...recommendDuplicateFiles(waste),
    ...recommendTopConsumers(breakdown, waste, configData, messages),
    ...recommendMCPInfo(configData, breakdown, messages),
    ...recommendClaudeMdSplit(configData),
    ...recommendSessionHabit(breakdown, waste),
  ];

  recommendations.sort((a, b) => a.priority - b.priority);

  return {
    recommendations,
    estimated_messages_until_compaction: estimateMessagesUntilCompaction(breakdown),
    // Post-compaction sessions have `currentContext.usage_percentage` reflecting
    // the live window. `breakdown.usage_percentage` is the LIFETIME ratio
    // (cumulative tokens across all compactions) which routinely exceeds 100%
    // and would misread as "critical" even when the live window is cold.
    context_health: getContextHealth(breakdown.currentContext?.usage_percentage ?? breakdown.usage_percentage),
  };
}

// ---------------------------------------------------------------------------
// Fix prompts — pasteable text for Claude Code sessions and CLAUDE.md
// ---------------------------------------------------------------------------

/** Info about a duplicate file for fix prompt generation */
interface DupeFileInfo {
  filename: string;
  readCount: number;
  earlierReads: string;
  wastedTokens: number;
}

/**
 * Extract structured duplicate file info from waste items.
 *
 * @param waste - Detected waste items
 * @returns Array of duplicate file details
 */
function extractDuplicateFiles(waste: WasteItem[]): DupeFileInfo[] {
  return waste
    .filter((w) => w.type === 'duplicate_read')
    .sort((a, b) => b.estimated_tokens - a.estimated_tokens)
    .map((w) => {
      const nameMatch = w.description.match(/"([^"]+)" read (\d+) times/);
      const locsMatch = w.description.match(/reads at ([^)]+?) are/);
      return {
        filename: nameMatch?.[1] ?? 'unknown',
        readCount: parseInt(nameMatch?.[2] ?? '0', 10),
        earlierReads: locsMatch?.[1] ?? '',
        wastedTokens: w.estimated_tokens,
      };
    });
}

/**
 * Generate pasteable fix prompts from analysis data.
 *
 * Produces three text blocks:
 * 1. A prompt to paste into the current Claude Code session
 * 2. A CLAUDE.md snippet for future sessions
 * 3. A specific /compact command ready to paste
 *
 * All rule-based — NO LLM calls, NO API tokens.
 *
 * @param breakdown - CRUSTS breakdown
 * @param waste - Detected waste items
 * @param configData - Config data from scanner
 * @returns Fix prompts ready for pasting
 */
export function generateFixPrompts(
  breakdown: CrustsBreakdown,
  waste: WasteItem[],
  configData: ConfigData,
): FixPrompts {
  return {
    sessionPrompt: buildSessionPrompt(breakdown, waste),
    claudeMdSnippet: buildClaudeMdSnippet(breakdown, waste, configData),
    compactCommand: buildCompactCommand(breakdown, waste),
  };
}

/**
 * Build text to paste into the current Claude Code session.
 *
 * @param breakdown - CRUSTS breakdown
 * @param waste - Detected waste items
 * @returns Pasteable prompt text, or null if nothing to say
 */
function buildSessionPrompt(
  breakdown: CrustsBreakdown,
  waste: WasteItem[],
): string | null {
  const parts: string[] = [];
  const dupes = extractDuplicateFiles(waste);

  // Duplicate file warning
  if (dupes.length > 0) {
    parts.push('Important: these files are already in your context from earlier reads. Do NOT re-read them. Reference your earlier reads instead:');
    for (const d of dupes.slice(0, 10)) {
      parts.push(`- ${d.filename} (already read, at messages ${d.earlierReads})`);
    }
    parts.push('');
    parts.push('If you need to check something in these files, say "based on [filename] that you already read" instead of reading the file again.');
  }

  // Compaction urgency
  const msgsLeft = estimateMessagesUntilCompaction(breakdown);
  if (msgsLeft !== null && msgsLeft < 20 && msgsLeft > 0) {
    if (parts.length > 0) parts.push('');
    parts.push(`Context is filling up (~${msgsLeft} messages until auto-compaction). Be concise and avoid unnecessary tool calls.`);
  }

  if (parts.length === 0) return null;
  return parts.join('\n');
}

/**
 * Build a CLAUDE.md snippet based on session patterns.
 *
 * @param breakdown - CRUSTS breakdown
 * @param waste - Detected waste items
 * @param configData - Config data from scanner
 * @returns CLAUDE.md snippet text, or null if nothing to suggest
 */
function buildClaudeMdSnippet(
  breakdown: CrustsBreakdown,
  waste: WasteItem[],
  configData: ConfigData,
): string | null {
  const sections: string[] = [];
  const dupes = extractDuplicateFiles(waste);

  // Frequently read files
  if (dupes.length >= 2) {
    sections.push('## Key Project Files');
    sections.push('These files are frequently referenced. Read each once at the start of a session, then reference from memory:');
    for (const d of dupes.slice(0, 8)) {
      sections.push(`- ${d.filename}: [describe what this file does]`);
    }
  }

  // Session management tip (if compaction-heavy)
  if (breakdown.compactionEvents.length >= 2) {
    if (sections.length > 0) sections.push('');
    sections.push('## Session Management');
    sections.push('- Keep sessions under 200 messages when possible');
    sections.push('- Use /clear between distinct tasks');
    sections.push('- Run /compact proactively at 60% context usage');
  }

  // System prompt size warning
  const sysToks = configData.systemPrompt.totalEstimatedTokens;
  if (sysToks > 1500) {
    if (sections.length > 0) sections.push('');
    sections.push('## Note');
    sections.push(`This CLAUDE.md is ~${sysToks.toLocaleString()} tokens. Consider moving project-specific details to CLAUDE.local.md to reduce per-message cache overhead.`);
  }

  if (sections.length === 0) return null;
  return sections.join('\n');
}

/**
 * Build a specific /compact command for the `fix` command's block 3.
 *
 * Delegates the focus-string generation to `optimizer.ts:buildCompactFocus`
 * so the `fix` and `optimize` commands emit byte-identical /compact-focus
 * strings on the same session.
 *
 * Gate: below 50% usage, don't surface a compact suggestion at all. Above
 * 50% with targeted waste, emit the waste-driven focus command. Above 70%
 * with no targetable waste, fall back to a plain `/compact`.
 *
 * @param breakdown - CRUSTS breakdown
 * @param waste - Detected waste items
 * @returns A /compact command ready to paste, or null
 */
function buildCompactCommand(
  breakdown: CrustsBreakdown,
  waste: WasteItem[],
): string | null {
  const ctx = breakdown.currentContext ?? breakdown;
  if (ctx.usage_percentage < 50) return null;
  const focus = buildCompactFocus(waste);
  if (focus) return focus.text;
  if (ctx.usage_percentage >= 70) return '/compact';
  return null;
}
