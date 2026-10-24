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
  ClassifiedMessage,
} from './types.ts';
import { buildCompactFocus } from './optimizer.ts';
import { countAnalyzedMessages } from './classifier.ts';
import { autocompactTrigger } from './model-context.ts';
import { loadAutocompactBufferTokens } from './config.ts';

/**
 * Resolve the auto-compaction trigger level for this breakdown's window.
 *
 * Auto-compaction fires when the reserved headroom buffer is exhausted:
 * the auto-compact window minus the buffer (167,000 on a 200K window,
 * 967,000 on 1M with no setting), not at a flat 80%. The classifier's
 * compaction model already honours Claude Code's auto-compact window
 * settings and crusts' `autocompactBufferTokens` override; hand-built
 * breakdowns without one fall back to the window minus the buffer.
 * Approximate at the edges: the actual trigger lands on turn boundaries,
 * so a heavy turn can overshoot before compaction fires.
 *
 * @param breakdown - The CRUSTS breakdown (supplies `compaction` or `context_limit`)
 * @returns The trigger level in tokens (null when auto-compaction is off)
 *   plus the buffer used to compute it
 */
function resolveAutocompactTrigger(breakdown: CrustsBreakdown): { trigger: number | null; bufferTokens: number } {
  if (breakdown.compaction) {
    return { trigger: breakdown.compaction.trigger, bufferTokens: breakdown.compaction.bufferTokens };
  }
  const bufferTokens = loadAutocompactBufferTokens();
  return { trigger: autocompactTrigger(breakdown.context_limit, bufferTokens), bufferTokens };
}

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
export function getContextHealth(usagePercent: number): ContextHealth {
  if (usagePercent < HEALTH_THRESHOLDS.healthy) return 'healthy';
  if (usagePercent < HEALTH_THRESHOLDS.warming) return 'warming';
  if (usagePercent < HEALTH_THRESHOLDS.hot) return 'hot';
  return 'critical';
}

/**
 * Classified rows belonging to the live context window: the post-compaction
 * slice when the session compacted, all rows otherwise. Every per-message
 * average in this module counts through `countAnalyzedMessages` over these
 * rows so the prediction recommendation and
 * `estimated_messages_until_compaction` can never disagree.
 *
 * @param breakdown - The CRUSTS breakdown
 * @returns Rows of the live window
 */
function currentWindowRows(breakdown: CrustsBreakdown): ClassifiedMessage[] {
  return breakdown.currentContext
    ? breakdown.messages.slice(breakdown.currentContext.startIndex)
    : breakdown.messages;
}

/** Messages a live window needs before its growth rate is worth projecting. */
const MIN_MESSAGES_FOR_RUNWAY = 4;

/**
 * How fast the live window grows per message.
 *
 * Growth is measured from the window's starting size, not from zero: the
 * size right after the last compaction (its `tokensAfter`), or for a fresh
 * session the first turn's input (fixed context and first prompt). Dividing
 * the whole window by a handful of messages counted the fixed context and
 * the compact summary as per-message growth, and every compaction was
 * followed by a false "~19 messages until auto-compaction, act soon" at 9%.
 * Attachment rows are excluded from the message count, and fewer than
 * `MIN_MESSAGES_FOR_RUNWAY` messages give no projection.
 *
 * @param breakdown - The CRUSTS breakdown
 * @returns Tokens per message and the message count, or null when the
 *   window is too young or has not grown
 */
function windowGrowth(breakdown: CrustsBreakdown): { perMessage: number; messages: number } | null {
  const ctx = breakdown.currentContext ?? breakdown;
  const messages = countAnalyzedMessages(currentWindowRows(breakdown));
  if (messages < MIN_MESSAGES_FOR_RUNWAY) return null;
  const lastEvent = breakdown.compactionEvents[breakdown.compactionEvents.length - 1];
  const baseline = breakdown.currentContext && lastEvent
    ? lastEvent.tokensAfter
    : breakdown.derivedOverhead?.internalSystemPrompt?.derivation.firstAssistantInputTokens ?? 0;
  const growth = ctx.total_tokens - baseline;
  if (growth <= 0) return null;
  return { perMessage: growth / messages, messages };
}

/**
 * Estimate how many more messages can be sent before auto-compaction.
 *
 * Projects the live window's growth per message (see `windowGrowth`) to the
 * auto-compaction trigger. Null when auto-compaction is off or the window is
 * too young to project; 0 once the trigger is reached.
 *
 * @param breakdown - The CRUSTS breakdown
 * @returns Estimated messages remaining, or null if can't calculate
 */
function estimateMessagesUntilCompaction(breakdown: CrustsBreakdown): number | null {
  const ctx = breakdown.currentContext ?? breakdown;
  const { trigger } = resolveAutocompactTrigger(breakdown);
  if (trigger === null) return null;
  if (ctx.total_tokens >= trigger) return 0;
  const growth = windowGrowth(breakdown);
  if (!growth) return null;
  return Math.floor((trigger - ctx.total_tokens) / growth.perMessage);
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

  // Find MCP tools that were actually invoked. Tool names follow
  // Anthropic's `mcp__<server>__<tool>` convention, so a server matches
  // when a tool_use name starts with its prefix (the old exact-name
  // comparison against server names could never match).
  const invokedMcp: string[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.message?.content)) continue;
    for (const block of msg.message.content) {
      if (block.type !== 'tool_use' || !block.name) continue;
      const name = block.name;
      if (!servers.some((s) => name.startsWith('mcp__' + s.name + '__'))) continue;
      if (!invokedMcp.includes(name)) invokedMcp.push(name);
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
  // Same projection as estimateMessagesUntilCompaction (growth per analyzed
  // message since the window started), so the two can never disagree.
  const { trigger, bufferTokens } = resolveAutocompactTrigger(breakdown);
  if (trigger === null) return [];
  const bufferK = `${Math.round(bufferTokens / 1000)}K`;
  const remaining = estimateMessagesUntilCompaction(breakdown);
  const avgPerMsg = windowGrowth(breakdown)?.perMessage ?? 0;

  if (remaining === null) return [];
  if (remaining <= 0) {
    return [{
      priority: 1,
      action: 'Context PAST the auto-compaction trigger, act now',
      impact: 0,
      reason: `At ${ctx.total_tokens.toLocaleString()}/${trigger.toLocaleString()} tokens; auto-compact fires when about ${bufferK} tokens of headroom remain. Options: (A) /compact now, (B) /clear to start fresh, (C) let auto-compact handle it (loses context quality).`,
    }];
  }

  if (remaining < 20) {
    return [{
      priority: 2,
      action: `~${remaining} messages until auto-compaction, act soon`,
      impact: 0,
      reason: `${ctx.total_tokens.toLocaleString()} tokens, ~${Math.round(avgPerMsg)} per message, auto-compact trigger at ${trigger.toLocaleString()} (window minus the ${bufferK}-token headroom buffer). Options: (A) /compact to stay ahead, (B) /clear between tasks, (C) continue and let auto-compact fire.`,
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

/**
 * Warn that Claude Code will compact this session if it is left idle.
 *
 * From Claude Code 2.1.286, a conversation at or above the idle threshold
 * (200K by default) that sits idle about 54 minutes is compacted before its
 * one-hour prompt cache expires. A 1M window rarely reaches a percentage
 * advisory before a break, so this is usually the compaction that comes
 * first. Silent when idle compaction is off or the window is under the
 * threshold.
 *
 * @param breakdown - CRUSTS breakdown (needs the classifier's compaction model)
 * @returns At most one recommendation
 */
function recommendIdleCompaction(breakdown: CrustsBreakdown, waste: WasteItem[]): Recommendation[] {
  const idle = breakdown.compaction?.idle;
  if (!idle?.applies) return [];
  const total = (breakdown.currentContext ?? breakdown).total_tokens;
  // The command is named here: below half the window there is no /compact
  // recommendation above to point at, and most of a 1M window's idle band
  // (200K-500K) is there.
  const command = buildCompactFocus(waste)?.text ?? '/compact';
  // Priority 2, listed ahead of the duplicate-read tips: on a 1M window this
  // is usually the compaction that comes first, and the dashboard shows only
  // the top three actions.
  return [{
    priority: 2,
    action: `Idle ~${idle.afterMinutes} min and Claude Code may compact this session`,
    impact: 0,
    reason: `${total.toLocaleString()} tokens is over the ${idle.minTokens.toLocaleString()}-token idle-compaction threshold, so a break of about ${idle.afterMinutes} minutes can end in a generic summary. Before a break, run ${command} to choose what stays, or turn idle compaction off ("idleCompaction": false in settings.json, or the Idle compaction row in /config on Claude Code 2.1.302+).`,
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
 * The "start fresh sessions" habit counts only AUTO compactions
 * (`trigger === 'auto'`): a manual /compact is a deliberate, targeted
 * choice, not a habit problem (observed sessions run to ~79% manual).
 * Heuristic-detected events carry no trigger and are not counted either.
 *
 * @param breakdown - CRUSTS breakdown
 * @param waste - Detected waste items
 * @returns At most one recommendation for the most impactful habit change
 */
function recommendSessionHabit(
  breakdown: CrustsBreakdown,
  waste: WasteItem[],
): Recommendation[] {
  // Idle compactions (Claude Code's own, while the session sat unused) are
  // not a habit problem; the idle-compaction recommendation covers them.
  const autoCompactionCount = breakdown.compactionEvents
    .filter((e) => e.trigger === 'auto' && e.idle !== true).length;
  const dupeCount = waste.filter((w) => w.type === 'duplicate_read').length;
  const toolBucket = breakdown.buckets.find((b) => b.category === 'tools');
  const toolPct = toolBucket?.percentage ?? 0;

  // Pick the most relevant habit — only ONE
  if (autoCompactionCount >= 3) {
    return [{
      priority: 5,
      action: 'Habit: use /clear between distinct tasks',
      impact: 0,
      reason: `${autoCompactionCount} auto-compactions this session. Each auto-compaction summarises aggressively and loses context quality. Starting fresh sessions per task avoids degradation (deliberate /compact runs are not counted here).`,
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

  // 3. System prompt (CLAUDE.md + Claude Code's own prompt). Every figure is
  // the one the classifier used: CLAUDE.md and memory from the session's own
  // instructions record when Claude Code wrote one, and the recorded system
  // prompt when there is one (else the derived figure), so this list and the
  // buckets agree.
  const derivation = breakdown.derivedOverhead?.internalSystemPrompt?.derivation;
  const claudeMdTokens = derivation?.knownClaudeMd ?? configData.systemPrompt.totalEstimatedTokens;
  const promptTokens = breakdown.derivedOverhead?.recordedSystemPrompt?.tokens
    ?? breakdown.derivedOverhead?.internalSystemPrompt?.tokens ?? 0;
  consumers.push({
    name: 'System prompt',
    tokens: claudeMdTokens + promptTokens,
    detail: `CLAUDE.md ${claudeMdTokens.toLocaleString()} + Claude Code ${promptTokens.toLocaleString()}`,
  });

  // 4. Compaction summary (if present): the most recent one is the summary
  // in the live window, so walk newest first.
  for (let e = breakdown.compactionEvents.length - 1; e >= 0; e--) {
    const event = breakdown.compactionEvents[e]!;
    if (event.summaryTokens && event.summaryTokens > 0) {
      consumers.push({
        name: 'Compaction summary',
        tokens: event.summaryTokens,
        detail: `compressed context from ${event.tokensBefore.toLocaleString()} tokens`,
      });
      break;
    }
  }

  // 5. Memory files
  const memTokens = derivation?.knownMemory ?? configData.memoryFiles.totalEstimatedTokens;
  if (memTokens > 0) {
    consumers.push({
      name: 'Memory files',
      tokens: memTokens,
      detail: derivation ? 'as loaded in this session' : `${configData.memoryFiles.files.length} file(s)`,
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
    ...recommendIdleCompaction(breakdown, waste),
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
