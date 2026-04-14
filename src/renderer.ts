/**
 * Terminal output formatting.
 *
 * Renders CRUSTS analysis results using chalk for colors and
 * cli-table3 for structured tables. Handles the full dashboard,
 * timeline, session list, and waste report views.
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import type {
  CrustsBreakdown,
  CrustsBucket,
  ClassifiedMessage,
  CompactionEvent,
  ComparisonResult,
  CrustsCategory,
  DerivedOverhead,
  FixPrompts,
  WasteItem,
  SessionInfo,
  Recommendation,
  RecommendationReport,
  ContextHealth,
  TrendRecord,
  TrendSummary,
} from './types.ts';
import type { LostAnalysis, CompactionLoss, LostItem } from './lost-detector.ts';

// ---------------------------------------------------------------------------
// Color scheme
// ---------------------------------------------------------------------------

/** Color function for each CRUSTS category */
const CATEGORY_COLOR: Record<CrustsCategory, (s: string) => string> = {
  conversation: chalk.cyan,
  retrieved: chalk.blue,
  user: chalk.green,
  system: chalk.yellow,
  tools: chalk.magenta,
  state: chalk.white,
};

/** Short label for each category */
const CATEGORY_LABEL: Record<CrustsCategory, string> = {
  conversation: 'C  Conversation',
  retrieved: 'R  Retrieved',
  user: 'U  User Input',
  system: 'S  System',
  tools: 'T  Tools',
  state: 'S  State/Memory',
};

/** Single-letter tag for timeline */
const CATEGORY_TAG: Record<CrustsCategory, string> = {
  conversation: '[C]',
  retrieved: '[R]',
  user: '[U]',
  system: '[S]',
  tools: '[T]',
  state: '[M]',
};

/** Color for health status */
function healthColor(health: ContextHealth): (s: string) => string {
  switch (health) {
    case 'healthy': return chalk.green;
    case 'warming': return chalk.yellow;
    case 'hot': return chalk.red;
    case 'critical': return chalk.bgRed.white;
  }
}

/** Color for severity */
function severityColor(severity: string): (s: string) => string {
  switch (severity) {
    case 'high': return chalk.red;
    case 'medium': return chalk.yellow;
    case 'low': return chalk.blue;
    default: return chalk.dim;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a token count for display.
 *
 * @param tokens - Token count
 * @returns Formatted string like "42,800 tkns"
 */
function fmtTokens(tokens: number): string {
  return `${tokens.toLocaleString()} tkns`;
}

/**
 * Render a percentage bar using block characters.
 *
 * @param pct - Percentage value (0-100)
 * @param width - Total bar width in characters
 * @param color - Chalk color function for filled portion
 * @returns Colored bar string
 */
function renderBar(pct: number, width: number, color: (s: string) => string): string {
  const raw = Math.round((pct / 100) * width);
  const filled = pct >= 1 ? Math.max(1, raw) : 0;
  const empty = width - filled;
  return color('\u2588'.repeat(filled)) + chalk.dim('\u2591'.repeat(empty));
}

/**
 * Format a Date as a relative age string.
 *
 * @param date - The date to format
 * @returns Human-readable age like "3h ago"
 */
function formatAge(date: Date): string {
  const ms = Date.now() - date.getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/**
 * Format bytes as a human-readable size string.
 *
 * @param bytes - Size in bytes
 * @returns Formatted string like "2.4 MB"
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// renderAnalysis — full dashboard view
// ---------------------------------------------------------------------------

/**
 * Render the full CRUSTS analysis dashboard.
 *
 * Shows the category breakdown with bar chart, totals, waste summary,
 * and prioritized recommendations in a box-drawn display.
 *
 * @param breakdown - CRUSTS classification breakdown
 * @param waste - Detected waste items
 * @param report - Recommendation report with health status
 * @param sessionId - Session ID for the header
 * @param project - Project name for the header
 * @param messageCount - Total message count
 */
export function renderAnalysis(
  breakdown: CrustsBreakdown,
  waste: WasteItem[],
  report: RecommendationReport,
  sessionId: string,
  project: string,
  messageCount: number,
): void {
  const hc = healthColor(report.context_health);
  const model = breakdown.model;
  const duration = formatDuration(breakdown.durationSeconds);

  // Determine which view to show primarily
  const hasCompaction = breakdown.compactionEvents.length > 0 && breakdown.currentContext;
  const primaryBuckets = hasCompaction ? breakdown.currentContext!.buckets : breakdown.buckets;
  const primaryTotal = hasCompaction ? breakdown.currentContext!.total_tokens : breakdown.total_tokens;
  const primaryFree = hasCompaction ? breakdown.currentContext!.free_tokens : breakdown.free_tokens;
  const primaryPct = hasCompaction ? breakdown.currentContext!.usage_percentage : breakdown.usage_percentage;

  // Header
  console.log();
  console.log(chalk.bold('\u2554' + '\u2550'.repeat(62) + '\u2557'));
  console.log(chalk.bold('\u2551') + '  CRUSTS Context Window Analysis' + ' '.repeat(30) + chalk.bold('\u2551'));
  console.log(chalk.bold('\u2551') + chalk.dim(`  Session: ${sessionId.slice(0, 8)} | Model: ${model}`.padEnd(62)) + chalk.bold('\u2551'));
  console.log(chalk.bold('\u2551') + chalk.dim(`  Messages: ${messageCount}${duration ? ` | Duration: ${duration}` : ''}`.padEnd(62)) + chalk.bold('\u2551'));
  if (hasCompaction) {
    const compCount = breakdown.compactionEvents.length;
    const compLabel = `  ${compCount} compaction(s) detected — showing current context`;
    console.log(chalk.bold('\u2551') + chalk.yellow(compLabel.padEnd(62)) + chalk.bold('\u2551'));
  }
  console.log(chalk.bold('\u2560' + '\u2550'.repeat(62) + '\u2563'));

  // Category breakdown (primary view: current context if compacted)
  // Layout: 2 pad + 18 label + 1 sp + 14 tokens + 1 sp + 8 pct + 2 sp + bar = 62
  const barWidth = 62 - 2 - 18 - 1 - 14 - 1 - 8 - 2; // = 16
  console.log(chalk.bold('\u2551') + ' '.repeat(62) + chalk.bold('\u2551'));
  for (const bucket of primaryBuckets) {
    const color = CATEGORY_COLOR[bucket.category];
    const labelText = CATEGORY_LABEL[bucket.category].padEnd(18);
    const tokens = fmtTokens(bucket.tokens).padStart(14);
    const pct = `(${bucket.percentage.toFixed(1)}%)`.padStart(8);
    const bar = renderBar(bucket.percentage, barWidth, color);
    console.log(chalk.bold('\u2551') + `  ${color(labelText)} ${tokens} ${pct}  ${bar}` + chalk.bold('\u2551'));
  }

  // Totals
  console.log(chalk.bold('\u2551') + '  ' + chalk.dim('\u2500'.repeat(58)) + '  ' + chalk.bold('\u2551'));
  const usagePct = primaryPct.toFixed(1);
  const usageStr = hc(`${usagePct}%`);
  console.log(chalk.bold('\u2551') + `  TOTAL: ${primaryTotal.toLocaleString()} / ${breakdown.context_limit.toLocaleString()} tokens (${usageStr})`.padEnd(62 + (usageStr.length - usagePct.length - 1)) + chalk.bold('\u2551'));
  console.log(chalk.bold('\u2551') + `  FREE:  ${primaryFree.toLocaleString()} tokens`.padEnd(62) + chalk.bold('\u2551'));
  console.log(chalk.bold('\u2551') + ' '.repeat(62) + chalk.bold('\u2551'));

  // Session lifetime summary (if compacted, show as secondary info)
  if (hasCompaction) {
    const lifetimeLine = `  Session lifetime: ${breakdown.total_tokens.toLocaleString()} tokens across ${messageCount} messages`;
    console.log(chalk.bold('\u2551') + chalk.dim(lifetimeLine.padEnd(62)) + chalk.bold('\u2551'));
    console.log(chalk.bold('\u2551') + ' '.repeat(62) + chalk.bold('\u2551'));
  }

  // Waste summary (top items only)
  const highWaste = waste.filter((w) => w.severity === 'high' || w.severity === 'medium');
  if (highWaste.length > 0) {
    console.log(chalk.bold('\u2551') + chalk.red('  \u26a0  WASTE DETECTED:') + ' '.repeat(62 - 20) + chalk.bold('\u2551'));
    for (const item of highWaste.slice(0, 4)) {
      const line = `     \u2022 ${item.description.slice(0, 54)}`;
      console.log(chalk.bold('\u2551') + line.padEnd(62) + chalk.bold('\u2551'));
      const tokLine = `       est. ~${item.estimated_tokens.toLocaleString()} tokens`;
      console.log(chalk.bold('\u2551') + chalk.dim(tokLine.padEnd(62)) + chalk.bold('\u2551'));
    }
    if (highWaste.length > 4) {
      console.log(chalk.bold('\u2551') + chalk.dim(`     ... and ${highWaste.length - 4} more`.padEnd(62)) + chalk.bold('\u2551'));
    }
    console.log(chalk.bold('\u2551') + ' '.repeat(62) + chalk.bold('\u2551'));
  }

  // Recommendations (dashboard shows top 3 single-line actions)
  if (report.recommendations.length > 0) {
    console.log(chalk.bold('\u2551') + chalk.green('  \ud83d\udca1 RECOMMENDATIONS:') + ' '.repeat(62 - 22) + chalk.bold('\u2551'));
    const dashboardRecs = report.recommendations
      .filter((r) => !r.action.includes('\n'))
      .slice(0, 3);
    for (const rec of dashboardRecs) {
      const actionLine = `     ${rec.action.slice(0, 55)}`;
      console.log(chalk.bold('\u2551') + chalk.green(actionLine.padEnd(62)) + chalk.bold('\u2551'));
      if (rec.impact > 0) {
        const impactLine = `       ~${rec.impact.toLocaleString()} tokens saveable`;
        console.log(chalk.bold('\u2551') + chalk.dim(impactLine.padEnd(62)) + chalk.bold('\u2551'));
      }
    }

    if (report.estimated_messages_until_compaction !== null) {
      const msgLine = `     Messages until auto-compaction: ~${report.estimated_messages_until_compaction}`;
      console.log(chalk.bold('\u2551') + chalk.dim(msgLine.padEnd(62)) + chalk.bold('\u2551'));
    }
    console.log(chalk.bold('\u2551') + chalk.dim('     Run `claude-crusts waste` for full details'.padEnd(62)) + chalk.bold('\u2551'));
    console.log(chalk.bold('\u2551') + ' '.repeat(62) + chalk.bold('\u2551'));
  }

  // Health footer
  const healthLabel = report.context_health.toUpperCase();
  const healthLine = `  Context health: ${hc(healthLabel)}`;
  console.log(chalk.bold('\u2551') + healthLine + ' '.repeat(62 - healthLine.length + (hc(healthLabel).length - healthLabel.length)) + chalk.bold('\u2551'));

  // Derivation details and transparency note
  console.log(chalk.bold('\u2551') + ' '.repeat(62) + chalk.bold('\u2551'));
  const derived = breakdown.derivedOverhead;
  if (derived?.internalSystemPrompt || derived?.messageFraming) {
    console.log(chalk.bold('\u2551') + chalk.dim('  Derived from this session\'s API data:'.padEnd(62)) + chalk.bold('\u2551'));
    if (derived.internalSystemPrompt) {
      const sp = derived.internalSystemPrompt;
      const spLine = `    Internal system prompt: ~${sp.tokens.toLocaleString()} tokens`;
      console.log(chalk.bold('\u2551') + chalk.dim(spLine.padEnd(62)) + chalk.bold('\u2551'));
    }
    if (derived.messageFraming) {
      const mf = derived.messageFraming;
      const mfLine = `    Message framing: ~${mf.tokensPerMessage} tokens/msg (${mf.sampleCount} samples)`;
      console.log(chalk.bold('\u2551') + chalk.dim(mfLine.padEnd(62)) + chalk.bold('\u2551'));
    }
    const calNote = '  Run `claude-crusts calibrate` for ground truth comparison.';
    console.log(chalk.bold('\u2551') + chalk.dim(calNote.padEnd(62)) + chalk.bold('\u2551'));
  } else {
    const note1 = '  Note: Could not derive overhead from session data.';
    const note2 = '  Run `claude-crusts calibrate` for ground truth comparison.';
    console.log(chalk.bold('\u2551') + chalk.dim(note1.padEnd(62)) + chalk.bold('\u2551'));
    console.log(chalk.bold('\u2551') + chalk.dim(note2.padEnd(62)) + chalk.bold('\u2551'));
  }

  console.log(chalk.bold('\u255a' + '\u2550'.repeat(62) + '\u255d'));
  console.log();
}

/**
 * Format a duration in seconds as a human-readable string.
 *
 * @param seconds - Duration in seconds, or null
 * @returns Formatted string like "2h 15m" or "4m 30s", or null
 */
function formatDuration(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

// ---------------------------------------------------------------------------
// renderTimeline — message-by-message growth
// ---------------------------------------------------------------------------

/**
 * Render the timeline view showing context growth per message.
 *
 * Displays each message with its token count, cumulative total,
 * CRUSTS category, and content preview. Marks compaction events.
 *
 * @param classified - Array of classified messages
 * @param contextLimit - Context window limit
 * @param compactionEvents - Detected compaction events to mark in timeline
 */
export function renderTimeline(
  classified: ClassifiedMessage[],
  contextLimit: number,
  compactionEvents: CompactionEvent[] = [],
): void {
  console.log();

  const table = new Table({
    head: [
      chalk.dim('Msg'),
      chalk.dim('Tokens'),
      chalk.dim('Cumulative'),
      chalk.dim('Category'),
      chalk.dim('Content'),
    ],
    colWidths: [6, 10, 13, 16, 42],
    style: { head: [], border: [] },
    chars: {
      'top': '\u2500', 'top-mid': '\u252c', 'top-left': '\u250c', 'top-right': '\u2510',
      'bottom': '\u2500', 'bottom-mid': '\u2534', 'bottom-left': '\u2514', 'bottom-right': '\u2518',
      'left': '\u2502', 'left-mid': '\u251c', 'mid': '\u2500', 'mid-mid': '\u253c',
      'right': '\u2502', 'right-mid': '\u2524', 'middle': '\u2502',
    },
  });

  // Show every message for small sessions, sample for large ones
  const maxRows = 60;
  let entries: ClassifiedMessage[];
  if (classified.length <= maxRows) {
    entries = classified;
  } else {
    // Show first 10, sample middle, show last 10
    // Always include compaction event messages
    const compactionIndices = new Set(compactionEvents.map((e) => e.afterIndex));
    const first = classified.slice(0, 10);
    const last = classified.slice(-10);
    const middleCount = maxRows - 20;
    const step = Math.floor((classified.length - 20) / middleCount);
    const middle: ClassifiedMessage[] = [];
    const middleIndices = new Set<number>();
    for (let i = 10; i < classified.length - 10; i += step) {
      middleIndices.add(i);
      if (middleIndices.size >= middleCount) break;
    }
    // Ensure compaction indices are included
    for (const idx of compactionIndices) {
      if (idx >= 10 && idx < classified.length - 10) {
        middleIndices.add(idx);
      }
    }
    const sortedMiddle = [...middleIndices].sort((a, b) => a - b);
    for (const idx of sortedMiddle) {
      middle.push(classified[idx]!);
    }
    entries = [...first, ...middle, ...last];
  }

  // Build a set of compaction after-indices for marking
  const compactionAfterIndices = new Set(compactionEvents.map((e) => e.afterIndex));
  const compactionMap = new Map(compactionEvents.map((e) => [e.afterIndex, e]));

  for (const msg of entries) {
    // Insert compaction marker row before the post-compaction message
    if (compactionAfterIndices.has(msg.index)) {
      const event = compactionMap.get(msg.index)!;
      table.push([
        { colSpan: 5, content: chalk.yellow(`  ── COMPACTION: ${event.tokensBefore.toLocaleString()} → ${event.tokensAfter.toLocaleString()} (−${event.tokensDropped.toLocaleString()} tokens) ──`) },
      ]);
    }

    const color = CATEGORY_COLOR[msg.category];
    const tag = CATEGORY_TAG[msg.category];
    const preview = msg.contentPreview.slice(0, 38);
    const toolSuffix = msg.toolName ? chalk.dim(` (${msg.toolName})`) : '';

    table.push([
      chalk.dim(`#${msg.index + 1}`),
      msg.tokens.toLocaleString(),
      msg.cumulativeTokens.toLocaleString(),
      color(`${tag} ${msg.category.slice(0, 10)}`),
      preview + toolSuffix,
    ]);
  }

  console.log(table.toString());

  // Compaction prediction
  const compactionTokens = contextLimit * 0.80;
  if (classified.length > 0) {
    const last = classified[classified.length - 1]!;
    if (last.cumulativeTokens < compactionTokens) {
      const avgPerMsg = last.cumulativeTokens / classified.length;
      if (avgPerMsg > 0) {
        const remaining = Math.floor((compactionTokens - last.cumulativeTokens) / avgPerMsg);
        console.log(chalk.dim(`\n  Compaction predicted at message ~${classified.length + remaining} (80% = ${compactionTokens.toLocaleString()} tokens)`));
      }
    } else {
      console.log(chalk.red(`\n  Context already past compaction threshold (80% = ${compactionTokens.toLocaleString()} tokens)`));
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// renderList — session table
// ---------------------------------------------------------------------------

/**
 * Render a table of discovered sessions.
 *
 * @param sessions - Array of session info objects
 */
export function renderList(sessions: SessionInfo[]): void {
  console.log(chalk.bold(`\n  Found ${sessions.length} session(s)\n`));

  const table = new Table({
    head: [
      chalk.dim('ID'),
      chalk.dim('Age'),
      chalk.dim('Size'),
      chalk.dim('Project'),
    ],
    colWidths: [12, 14, 12, 48],
    style: { head: [], border: [] },
    chars: {
      'top': '\u2500', 'top-mid': '\u252c', 'top-left': '\u250c', 'top-right': '\u2510',
      'bottom': '\u2500', 'bottom-mid': '\u2534', 'bottom-left': '\u2514', 'bottom-right': '\u2518',
      'left': '\u2502', 'left-mid': '\u251c', 'mid': '\u2500', 'mid-mid': '\u253c',
      'right': '\u2502', 'right-mid': '\u2524', 'middle': '\u2502',
    },
  });

  for (const s of sessions.slice(0, 25)) {
    table.push([
      chalk.cyan(s.id.slice(0, 8)),
      chalk.dim(formatAge(s.modifiedAt)),
      formatBytes(s.sizeBytes),
      chalk.dim(s.project),
    ]);
  }

  console.log(table.toString());

  if (sessions.length > 25) {
    console.log(chalk.dim(`\n  ... and ${sessions.length - 25} more`));
  }
  console.log();
}

// ---------------------------------------------------------------------------
// renderWaste — waste report with recommendations
// ---------------------------------------------------------------------------

/**
 * Render the waste detection report.
 *
 * Shows detected waste items sorted by severity, followed by
 * prioritized recommendations.
 *
 * @param waste - Detected waste items
 * @param report - Recommendation report
 * @param totalTokens - Total session tokens (for percentage calculation)
 */
export function renderWaste(
  waste: WasteItem[],
  report: RecommendationReport,
  totalTokens: number,
): void {
  console.log();

  if (waste.length === 0) {
    console.log(chalk.green('  No waste detected. Context usage looks clean.\n'));
    return;
  }

  const totalWaste = waste.reduce((sum, w) => sum + w.estimated_tokens, 0);
  const wastePct = totalTokens > 0 ? ((totalWaste / totalTokens) * 100).toFixed(1) : '0';
  console.log(chalk.yellow(`  ${waste.length} issue(s) found \u2014 ~${totalWaste.toLocaleString()} tokens reclaimable (${wastePct}%)\n`));

  // Group by severity
  const bySeverity: Record<string, WasteItem[]> = {};
  for (const item of waste) {
    const arr = bySeverity[item.severity];
    if (arr) {
      arr.push(item);
    } else {
      bySeverity[item.severity] = [item];
    }
  }

  for (const severity of ['high', 'medium', 'low', 'info'] as const) {
    const items = bySeverity[severity];
    if (!items || items.length === 0) continue;

    const color = severityColor(severity);
    console.log(color(`  \u2500\u2500 ${severity.toUpperCase()} (${items.length}) \u2500\u2500`));
    console.log();

    for (const item of items) {
      const badge = color(`[${severity.toUpperCase()}]`);
      const tokens = chalk.dim(`~${item.estimated_tokens.toLocaleString()} tkns`);
      console.log(`  ${badge} ${item.description} ${tokens}`);
      console.log(chalk.cyan(`    \u2192 ${item.recommendation}`));
      console.log();
    }
  }

  // Recommendations section
  if (report.recommendations.length > 0) {
    console.log(chalk.bold('  \u2500\u2500 RECOMMENDATIONS \u2500\u2500\n'));

    for (const rec of report.recommendations) {
      const prioColor = rec.priority <= 2 ? chalk.red
        : rec.priority <= 3 ? chalk.yellow
        : chalk.dim;
      const prio = prioColor(`P${rec.priority}`);
      // Multi-line actions (like Top 5) get each line printed
      const actionLines = rec.action.split('\n');
      console.log(`  ${prio} ${chalk.green(actionLines[0])}`);
      for (const line of actionLines.slice(1)) {
        console.log(`     ${chalk.green(line)}`);
      }
      if (rec.impact > 0) {
        console.log(chalk.dim(`     Savings: ~${rec.impact.toLocaleString()} tokens`));
      }
      console.log(chalk.dim(`     ${rec.reason}`));
      console.log();
    }
  }

  // Health and compaction estimate
  const hc = healthColor(report.context_health);
  console.log(`  Context health: ${hc(report.context_health.toUpperCase())}`);
  if (report.estimated_messages_until_compaction !== null) {
    console.log(chalk.dim(`  Messages until auto-compaction: ~${report.estimated_messages_until_compaction}`));
  }
  console.log();
}

// ---------------------------------------------------------------------------
// renderFix — pasteable fix prompts
// ---------------------------------------------------------------------------

/**
 * Render a box-bordered block of pasteable text.
 *
 * @param text - The text to display in the box
 * @param width - Box inner width
 */
function renderPasteBox(text: string, width: number): void {
  console.log(chalk.cyan('  \u250c' + '\u2500'.repeat(width) + '\u2510'));
  for (const line of text.split('\n')) {
    // Wrap long lines
    const chunks = wrapText(line, width - 2);
    for (const chunk of chunks) {
      console.log(chalk.cyan('  \u2502') + ' ' + chunk.padEnd(width - 1) + chalk.cyan('\u2502'));
    }
  }
  console.log(chalk.cyan('  \u2514' + '\u2500'.repeat(width) + '\u2518'));
}

/**
 * Wrap text to a given width, preserving words.
 *
 * @param text - Text to wrap
 * @param width - Maximum line width
 * @returns Array of wrapped lines
 */
function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/**
 * Render the fix command output with pasteable text blocks.
 *
 * Shows three sections:
 * 1. Prompt to paste into Claude Code session
 * 2. CLAUDE.md snippet for future sessions
 * 3. /compact command ready to paste
 *
 * @param fix - Generated fix prompts
 * @param sessionId - Session ID for the header
 */
export function renderFix(fix: FixPrompts, sessionId: string): void {
  const boxWidth = 64;
  console.log();
  console.log(chalk.bold(`  CRUSTS Fix — Session ${sessionId.slice(0, 8)}`));
  console.log();

  let hasOutput = false;

  // Output 1: Session prompt
  if (fix.sessionPrompt) {
    hasOutput = true;
    console.log(chalk.bold.green('  1. Paste this into your current Claude Code session:'));
    console.log();
    renderPasteBox(fix.sessionPrompt, boxWidth);
    console.log();
  }

  // Output 2: CLAUDE.md snippet
  if (fix.claudeMdSnippet) {
    hasOutput = true;
    console.log(chalk.bold.yellow('  2. Add this to your CLAUDE.md for future sessions:'));
    console.log();
    renderPasteBox(fix.claudeMdSnippet, boxWidth);
    console.log();
  }

  // Output 3: Compact command
  if (fix.compactCommand) {
    hasOutput = true;
    console.log(chalk.bold.cyan('  3. Run this command now:'));
    console.log();
    renderPasteBox(fix.compactCommand, boxWidth);
    console.log();
  }

  if (!hasOutput) {
    console.log(chalk.green('  No fixes needed — session looks clean.'));
    console.log();
  }
}

// ---------------------------------------------------------------------------
// renderComparison — side-by-side session comparison
// ---------------------------------------------------------------------------

/**
 * Render a comparison between two sessions.
 *
 * Shows per-category deltas with bar indicators, waste/compaction
 * comparison, and auto-generated insights in a box-drawn display.
 *
 * @param result - Comparison result from comparator
 */
export function renderComparison(result: ComparisonResult): void {
  const w = 68;

  // Header
  console.log();
  console.log(chalk.bold('\u2554' + '\u2550'.repeat(w) + '\u2557'));
  console.log(chalk.bold('\u2551') + '  CRUSTS Session Comparison' + ' '.repeat(w - 27) + chalk.bold('\u2551'));
  console.log(chalk.bold('\u2551') + chalk.dim(`  A: ${result.sessionA.id.slice(0, 8)} (${result.sessionA.project})`.padEnd(w)) + chalk.bold('\u2551'));
  console.log(chalk.bold('\u2551') + chalk.dim(`  B: ${result.sessionB.id.slice(0, 8)} (${result.sessionB.project})`.padEnd(w)) + chalk.bold('\u2551'));
  console.log(chalk.bold('\u2560' + '\u2550'.repeat(w) + '\u2563'));

  // Category breakdown table header
  console.log(chalk.bold('\u2551') + ' '.repeat(w) + chalk.bold('\u2551'));
  const hdr = '  ' + 'Category'.padEnd(16) + 'Session A'.padStart(12) + 'Session B'.padStart(12) + '   Delta'.padEnd(16) + '     ';
  console.log(chalk.bold('\u2551') + chalk.dim(hdr.padEnd(w)) + chalk.bold('\u2551'));
  console.log(chalk.bold('\u2551') + '  ' + chalk.dim('\u2500'.repeat(w - 4)) + '  ' + chalk.bold('\u2551'));

  // Category rows
  for (const d of result.categoryDeltas) {
    const color = CATEGORY_COLOR[d.category];
    const label = CATEGORY_LABEL[d.category].padEnd(16);
    const colA = d.tokensA.toLocaleString().padStart(12);
    const colB = d.tokensB.toLocaleString().padStart(12);
    const sign = d.delta >= 0 ? '+' : '';
    const deltaRaw = `${sign}${d.delta.toLocaleString()} (${sign}${d.deltaPercent.toFixed(0)}%)`;
    const deltaColor = d.delta > 0 ? chalk.red : d.delta < 0 ? chalk.green : chalk.dim;
    const padding = ' '.repeat(Math.max(0, w - 2 - label.length - colA.length - colB.length - 3 - deltaRaw.length));
    const row = `  ${color(label)}${colA}${colB}   ${deltaColor(deltaRaw)}${padding}`;
    console.log(chalk.bold('\u2551') + row + chalk.bold('\u2551'));
  }

  // Totals
  console.log(chalk.bold('\u2551') + '  ' + chalk.dim('\u2500'.repeat(w - 4)) + '  ' + chalk.bold('\u2551'));
  const totalSign = result.totalDelta >= 0 ? '+' : '';
  const totalDeltaRaw = `${totalSign}${result.totalDelta.toLocaleString()} (${totalSign}${result.totalDeltaPercent.toFixed(0)}%)`;
  const totalDeltaColor = result.totalDelta > 0 ? chalk.red : result.totalDelta < 0 ? chalk.green : chalk.dim;
  const totalLabel = 'TOTAL'.padEnd(16);
  const totalA = result.totalA.toLocaleString().padStart(12);
  const totalBStr = result.totalB.toLocaleString().padStart(12);
  const totalPadding = ' '.repeat(Math.max(0, w - 2 - totalLabel.length - totalA.length - totalBStr.length - 3 - totalDeltaRaw.length));
  const totalLine = `  ${totalLabel}${totalA}${totalBStr}   ${totalDeltaColor(totalDeltaRaw)}${totalPadding}`;
  console.log(chalk.bold('\u2551') + totalLine + chalk.bold('\u2551'));
  console.log(chalk.bold('\u2551') + ' '.repeat(w) + chalk.bold('\u2551'));

  // Messages
  const msgLine = `  Messages: A=${result.sessionA.messageCount}  B=${result.sessionB.messageCount}`;
  console.log(chalk.bold('\u2551') + chalk.dim(msgLine.padEnd(w)) + chalk.bold('\u2551'));

  // Waste comparison
  console.log(chalk.bold('\u2560' + '\u2550'.repeat(w) + '\u2563'));
  console.log(chalk.bold('\u2551') + chalk.yellow('  Waste:') + ' '.repeat(w - 8) + chalk.bold('\u2551'));
  const wasteLineA = `    A: ${result.waste.countA} issue(s), ~${result.waste.totalTokensA.toLocaleString()} tokens`;
  const wasteLineB = `    B: ${result.waste.countB} issue(s), ~${result.waste.totalTokensB.toLocaleString()} tokens`;
  console.log(chalk.bold('\u2551') + wasteLineA.padEnd(w) + chalk.bold('\u2551'));
  console.log(chalk.bold('\u2551') + wasteLineB.padEnd(w) + chalk.bold('\u2551'));

  // Compaction comparison
  const compLine = `  Compactions: A=${result.compaction.countA}  B=${result.compaction.countB}`;
  console.log(chalk.bold('\u2551') + chalk.dim(compLine.padEnd(w)) + chalk.bold('\u2551'));
  console.log(chalk.bold('\u2551') + ' '.repeat(w) + chalk.bold('\u2551'));

  // Insights
  if (result.insights.length > 0) {
    console.log(chalk.bold('\u2560' + '\u2550'.repeat(w) + '\u2563'));
    console.log(chalk.bold('\u2551') + chalk.green('  Insights:') + ' '.repeat(w - 11) + chalk.bold('\u2551'));
    for (const insight of result.insights) {
      const lines = wrapText(insight, w - 6);
      for (let i = 0; i < lines.length; i++) {
        const prefix = i === 0 ? '  \u2022 ' : '    ';
        console.log(chalk.bold('\u2551') + `${prefix}${lines[i]}`.padEnd(w) + chalk.bold('\u2551'));
      }
    }
    console.log(chalk.bold('\u2551') + ' '.repeat(w) + chalk.bold('\u2551'));
  }

  console.log(chalk.bold('\u255a' + '\u2550'.repeat(w) + '\u255d'));
  console.log();
}

// ---------------------------------------------------------------------------
// renderLost — what was lost in compaction
// ---------------------------------------------------------------------------

/** Type label for lost items */
const LOST_TYPE_LABEL: Record<string, string> = {
  file_read: 'File Read',
  conversation: 'Conversation',
  tool_result: 'Tool Result',
  instruction: 'Instruction',
};

/** Color for lost item type */
const LOST_TYPE_COLOR: Record<string, (s: string) => string> = {
  file_read: chalk.blue,
  conversation: chalk.cyan,
  tool_result: chalk.magenta,
  instruction: chalk.yellow,
};

/**
 * Render the lost content analysis for a session.
 *
 * Shows each compaction event with its lost items grouped by type,
 * followed by a grand total summary.
 *
 * @param analysis - Lost analysis result
 */
export function renderLost(analysis: LostAnalysis): void {
  const w = 66;

  // Header
  console.log();
  console.log(chalk.bold('\u2554' + '\u2550'.repeat(w) + '\u2557'));
  lostLine('  What Was Lost in Compaction', w, chalk.bold);
  lostLine(`  Session: ${analysis.sessionId.slice(0, 8)} | ${analysis.compactionCount} compaction event(s)`, w, chalk.dim);
  console.log(chalk.bold('\u2560' + '\u2550'.repeat(w) + '\u2563'));

  // Each compaction event
  for (const event of analysis.events) {
    renderCompactionEvent(event, w);
  }

  // Grand total
  const pct = analysis.grandTotalBefore > 0
    ? ((analysis.grandTotalLost / analysis.grandTotalBefore) * 100).toFixed(1)
    : '0';
  console.log(chalk.bold('\u2560' + '\u2550'.repeat(w) + '\u2563'));
  lostLine('', w);
  lostLine(`  Total: ${analysis.grandTotalLost.toLocaleString()} tokens lost out of ${analysis.grandTotalBefore.toLocaleString()} pre-compaction (${pct}%)`, w, chalk.yellow);
  lostLine('', w);
  console.log(chalk.bold('\u255a' + '\u2550'.repeat(w) + '\u255d'));
  console.log();
}

/**
 * Render a single line inside the lost report box.
 *
 * Pads the plaintext to exactly `w` visible characters, then applies
 * the optional color function so ANSI codes don't affect alignment.
 *
 * @param text - Plaintext content (will be padded/truncated to w)
 * @param w - Box inner width
 * @param color - Optional chalk color function
 */
function lostLine(text: string, w: number, color?: (s: string) => string): void {
  const padded = text.length > w ? text.slice(0, w) : text.padEnd(w);
  const content = color ? color(padded) : padded;
  console.log(chalk.bold('\u2551') + content + chalk.bold('\u2551'));
}

/**
 * Render a single compaction event within the lost report.
 *
 * @param event - Single compaction loss event
 * @param w - Box inner width
 */
function renderCompactionEvent(event: CompactionLoss, w: number): void {
  lostLine('', w);

  // Event header
  lostLine(`  Compaction #${event.eventNumber} (at message #${event.boundaryIndex + 1})`, w, chalk.bold);
  lostLine(`  ${event.tokensBefore.toLocaleString()} \u2192 ${event.tokensAfter.toLocaleString()} tokens (\u2212${event.tokensDropped.toLocaleString()} dropped)`, w, chalk.dim);

  if (event.summaryExcerpt) {
    const maxExcerpt = w - 16; // room for '  Summary: "' + '..."'
    lostLine(`  Summary: "${event.summaryExcerpt.slice(0, maxExcerpt)}..."`, w, chalk.dim);
  }

  console.log(chalk.bold('\u2551') + '  ' + chalk.dim('\u2500'.repeat(w - 4)) + '  ' + chalk.bold('\u2551'));

  if (event.lostItems.length === 0) {
    lostLine('  All content appears preserved in the summary.', w, chalk.green);
    return;
  }

  // Group by type
  const grouped: Record<string, LostItem[]> = {};
  for (const item of event.lostItems) {
    const arr = grouped[item.type];
    if (arr) {
      arr.push(item);
    } else {
      grouped[item.type] = [item];
    }
  }

  for (const type of ['file_read', 'conversation', 'tool_result', 'instruction'] as const) {
    const items = grouped[type];
    if (!items || items.length === 0) continue;

    const label = LOST_TYPE_LABEL[type] ?? type;
    const color = LOST_TYPE_COLOR[type] ?? chalk.white;
    const groupTokens = items.reduce((sum, item) => sum + item.tokens, 0);
    lostLine(`  ${label}s (${items.length}) \u2014 ~${groupTokens.toLocaleString()} tokens`, w, color);

    // Show up to 8 items per type
    const shown = items.slice(0, 8);
    for (const item of shown) {
      const suffix = ` ~${item.tokens.toLocaleString()} #${item.messageRange[0] + 1}`;
      const maxDesc = w - 4 - suffix.length; // 4 for leading spaces
      const desc = item.description.length > maxDesc
        ? item.description.slice(0, maxDesc - 1) + '\u2026'
        : item.description;
      const line = `    ${desc}${' '.repeat(Math.max(0, maxDesc - desc.length))}${suffix}`;
      lostLine(line, w);
    }
    if (items.length > 8) {
      lostLine(`    ... and ${items.length - 8} more`, w, chalk.dim);
    }
  }

  // Per-event total
  lostLine(`  Lost: ~${event.totalLostTokens.toLocaleString()} tokens identified`, w, chalk.dim);
}

// ---------------------------------------------------------------------------
// Trend view
// ---------------------------------------------------------------------------

/** Sparkline characters ordered by magnitude (low → high) */
const SPARK_CHARS = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

/**
 * Build a sparkline string from a numeric series.
 *
 * @param values - Array of numbers
 * @returns A compact one-line sparkline using Unicode block elements
 */
function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map((v) => {
      const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1));
      return SPARK_CHARS[idx]!;
    })
    .join('');
}

/**
 * Render the trend dashboard showing historical session statistics.
 *
 * @param records - Chronologically-sorted trend records
 * @param summary - Pre-computed aggregate summary
 */
export function renderTrend(records: TrendRecord[], summary: TrendSummary): void {
  if (records.length === 0) {
    console.log(chalk.dim('  No trend history yet. Run `claude-crusts analyze` on a few sessions first.'));
    console.log();
    return;
  }

  const w = 62;
  const border = chalk.bold;

  console.log();
  console.log(border('\u2554' + '\u2550'.repeat(w) + '\u2557'));
  console.log(border('\u2551') + chalk.bold.white(`  CRUSTS Trend  (${summary.count} session${summary.count === 1 ? '' : 's'})`.padEnd(w)) + border('\u2551'));
  console.log(border('\u2560' + '\u2550'.repeat(w) + '\u2563'));

  // Sparkline
  const spark = sparkline(summary.series);
  const dirColor = summary.direction === 'improving'
    ? chalk.green
    : summary.direction === 'worsening'
      ? chalk.red
      : chalk.dim;
  const dirLabel = summary.direction === 'improving'
    ? 'improving'
    : summary.direction === 'worsening'
      ? 'worsening'
      : 'flat';
  const deltaStr = summary.percentUsedDelta >= 0
    ? `+${summary.percentUsedDelta.toFixed(1)}pp`
    : `${summary.percentUsedDelta.toFixed(1)}pp`;

  console.log(border('\u2551') + `  Context usage: ${spark}  ${dirColor(dirLabel)} (${deltaStr})`.padEnd(w) + border('\u2551'));
  console.log(border('\u2560' + '\u2550'.repeat(w) + '\u2563'));

  // Averages
  const lines: [string, string][] = [
    ['Avg context used', `${summary.avgPercentUsed.toFixed(1)}%`],
    ['Avg tokens', summary.avgTotalTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })],
    ['Avg messages', summary.avgMessageCount.toFixed(0)],
    ['Avg compactions', summary.avgCompactionCount.toFixed(1)],
    ['Dominant category', CATEGORY_LABEL[summary.dominantCategory]],
  ];
  for (const [label, value] of lines) {
    const text = `  ${label.padEnd(22)} ${value}`;
    console.log(border('\u2551') + text.padEnd(w) + border('\u2551'));
  }

  console.log(border('\u2560' + '\u2550'.repeat(w) + '\u2563'));

  // Recent sessions table (last 10)
  console.log(border('\u2551') + chalk.bold('  Recent sessions').padEnd(w) + border('\u2551'));
  console.log(border('\u2551') + chalk.dim('  Session          Used   Msgs  Compact  Health').padEnd(w) + border('\u2551'));

  const recent = records.slice(-10);
  for (const r of recent) {
    const sid = r.sessionId.slice(0, 8);
    const pct = `${r.percentUsed.toFixed(1)}%`.padStart(6);
    const msgs = String(r.messageCount).padStart(5);
    const comp = String(r.compactionCount).padStart(5);
    const hColor = healthColor(r.health);
    const hLabel = r.health.padEnd(8);
    const line = `  ${sid.padEnd(17)} ${pct} ${msgs}  ${comp}  `;
    console.log(border('\u2551') + line + hColor(hLabel) + ' '.repeat(Math.max(0, w - line.length - hLabel.length)) + border('\u2551'));
  }

  console.log(border('\u255A' + '\u2550'.repeat(w) + '\u255D'));
  console.log();
}
