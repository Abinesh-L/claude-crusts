/**
 * Markdown report generator.
 *
 * Produces a standalone .md file with the full CRUSTS analysis —
 * standard markdown, no HTML tags, renders well in VS Code preview
 * and on GitHub. Supports both single-session and comparison reports.
 */

import type {
  AnalysisResult,
  ComparisonResult,
  CrustsCategory,
  WasteItem,
  FixPrompts,
} from './types.ts';

/** Human-readable labels for each CRUSTS category */
const CATEGORY_LABELS: Record<CrustsCategory, string> = {
  conversation: 'C Conversation',
  retrieved: 'R Retrieved',
  user: 'U User Input',
  system: 'S System',
  tools: 'T Tools',
  state: 'S State/Memory',
};

/**
 * Format a number with locale separators.
 *
 * @param n - Number to format
 * @returns Formatted string
 */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Format duration in seconds as human-readable.
 *
 * @param seconds - Duration in seconds, or null
 * @returns Formatted string or empty string
 */
function fmtDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

// ---------------------------------------------------------------------------
// Single-session report
// ---------------------------------------------------------------------------

/**
 * Generate a markdown report for a single session analysis.
 *
 * @param result - Complete analysis result
 * @param fix - Generated fix prompts
 * @returns Complete markdown string
 */
export function generateSessionReportMd(result: AnalysisResult, fix: FixPrompts): string {
  const bd = result.breakdown;
  const hasCompaction = bd.compactionEvents.length > 0 && bd.currentContext;
  const primaryBuckets = hasCompaction ? bd.currentContext!.buckets : bd.buckets;
  const primaryTotal = hasCompaction ? bd.currentContext!.total_tokens : bd.total_tokens;
  const primaryFree = hasCompaction ? bd.currentContext!.free_tokens : bd.free_tokens;
  const primaryPct = hasCompaction ? bd.currentContext!.usage_percentage : bd.usage_percentage;
  const health = result.recommendations.context_health;
  const duration = fmtDuration(bd.durationSeconds);

  const lines: string[] = [];

  // Header
  lines.push(`# CRUSTS Context Window Analysis`);
  lines.push('');
  lines.push(`**Session:** \`${result.sessionId.slice(0, 8)}\` | **Model:** ${bd.model} | **Project:** ${result.project}`);
  lines.push(`**Messages:** ${result.messageCount}${duration ? ` | **Duration:** ${duration}` : ''} | **Health:** ${health.toUpperCase()}`);
  if (hasCompaction) {
    lines.push(`**${bd.compactionEvents.length} compaction(s) detected** — showing current context`);
  }
  lines.push('');

  // Category Breakdown
  lines.push(`## Category Breakdown`);
  lines.push('');
  lines.push(`| Category | Tokens | % | Accuracy |`);
  lines.push(`|----------|-------:|--:|----------|`);
  for (const bucket of primaryBuckets) {
    const label = CATEGORY_LABELS[bucket.category];
    const acc = bucket.accuracy === 'estimated' ? '~est' : 'exact';
    lines.push(`| ${label} | ${fmt(bucket.tokens)} | ${bucket.percentage.toFixed(1)}% | ${acc} |`);
  }
  lines.push(`| **Total** | **${fmt(primaryTotal)}** | **${primaryPct.toFixed(1)}%** | |`);
  lines.push('');
  lines.push(`**Context:** ${fmt(primaryTotal)} / ${fmt(bd.context_limit)} tokens (${primaryPct.toFixed(1)}% used)`);
  lines.push(`**Free space:** ${fmt(primaryFree)} tokens`);
  if (hasCompaction) {
    lines.push(`**Session lifetime:** ${fmt(bd.total_tokens)} tokens across ${result.messageCount} messages`);
  }
  lines.push('');

  // Waste
  if (result.waste.length > 0) {
    const totalWaste = result.waste.reduce((sum, w) => sum + w.estimated_tokens, 0);
    lines.push(`## Waste Detection`);
    lines.push('');
    lines.push(`**${result.waste.length} issue(s)** — ~${fmt(totalWaste)} tokens reclaimable`);
    lines.push('');

    const grouped = groupBySeverity(result.waste);
    for (const severity of ['high', 'medium', 'low', 'info'] as const) {
      const items = grouped[severity];
      if (!items || items.length === 0) continue;
      lines.push(`### ${severity.toUpperCase()} (${items.length})`);
      lines.push('');
      for (const item of items) {
        lines.push(`- **${item.description}** (~${fmt(item.estimated_tokens)} tokens)`);
        lines.push(`  - ${item.recommendation}`);
      }
      lines.push('');
    }
  }

  // Recommendations
  if (result.recommendations.recommendations.length > 0) {
    lines.push(`## Recommendations`);
    lines.push('');
    for (const rec of result.recommendations.recommendations) {
      const actionLines = rec.action.split('\n');
      lines.push(`- **P${rec.priority}** ${actionLines[0]}`);
      for (const line of actionLines.slice(1)) {
        lines.push(`  ${line}`);
      }
      if (rec.impact > 0) {
        lines.push(`  - ~${fmt(rec.impact)} tokens saveable`);
      }
      lines.push(`  - *${rec.reason}*`);
    }
    if (result.recommendations.estimated_messages_until_compaction !== null) {
      lines.push('');
      lines.push(`Messages until auto-compaction: ~${result.recommendations.estimated_messages_until_compaction}`);
    }
    lines.push('');
  }

  // Fix Prompts
  if (fix.sessionPrompt || fix.claudeMdSnippet || fix.compactCommand) {
    lines.push(`## Fix Prompts`);
    lines.push('');
    let blockNum = 1;
    if (fix.sessionPrompt) {
      lines.push(`### ${blockNum}. Paste into your current Claude Code session`);
      lines.push('');
      lines.push('```');
      lines.push(fix.sessionPrompt);
      lines.push('```');
      lines.push('');
      blockNum++;
    }
    if (fix.claudeMdSnippet) {
      lines.push(`### ${blockNum}. Add to your CLAUDE.md`);
      lines.push('');
      lines.push('```');
      lines.push(fix.claudeMdSnippet);
      lines.push('```');
      lines.push('');
      blockNum++;
    }
    if (fix.compactCommand) {
      lines.push(`### ${blockNum}. Run this command now`);
      lines.push('');
      lines.push('```');
      lines.push(fix.compactCommand);
      lines.push('```');
      lines.push('');
    }
  }

  // Derived overhead
  const derived = bd.derivedOverhead;
  if (derived?.internalSystemPrompt || derived?.messageFraming) {
    lines.push(`## Derived Overhead`);
    lines.push('');
    if (derived.internalSystemPrompt) {
      lines.push(`- Internal system prompt: ~${fmt(derived.internalSystemPrompt.tokens)} tokens`);
    }
    if (derived.messageFraming) {
      lines.push(`- Message framing: ~${derived.messageFraming.tokensPerMessage} tokens/msg (${derived.messageFraming.sampleCount} samples)`);
    }
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('');
  lines.push(`Generated by [claude-crusts](https://github.com/Abinesh-L/claude-crusts) v0.5.0 | ${new Date().toISOString()}`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Comparison report
// ---------------------------------------------------------------------------

/**
 * Generate a markdown report comparing two sessions.
 *
 * @param comparison - Comparison result
 * @returns Complete markdown string
 */
export function generateComparisonReportMd(comparison: ComparisonResult): string {
  const lines: string[] = [];

  // Header
  lines.push(`# CRUSTS Session Comparison`);
  lines.push('');
  lines.push(`**A:** \`${comparison.sessionA.id.slice(0, 8)}\` (${comparison.sessionA.project}) — ${comparison.sessionA.messageCount} messages`);
  lines.push(`**B:** \`${comparison.sessionB.id.slice(0, 8)}\` (${comparison.sessionB.project}) — ${comparison.sessionB.messageCount} messages`);
  lines.push('');

  // Category deltas
  lines.push(`## Category Breakdown`);
  lines.push('');
  lines.push(`| Category | Session A | Session B | Delta |`);
  lines.push(`|----------|----------:|----------:|------:|`);
  for (const d of comparison.categoryDeltas) {
    const label = CATEGORY_LABELS[d.category];
    const sign = d.delta >= 0 ? '+' : '';
    lines.push(`| ${label} | ${fmt(d.tokensA)} | ${fmt(d.tokensB)} | ${sign}${fmt(d.delta)} (${sign}${d.deltaPercent.toFixed(0)}%) |`);
  }
  const totalSign = comparison.totalDelta >= 0 ? '+' : '';
  lines.push(`| **Total** | **${fmt(comparison.totalA)}** | **${fmt(comparison.totalB)}** | **${totalSign}${fmt(comparison.totalDelta)} (${totalSign}${comparison.totalDeltaPercent.toFixed(0)}%)** |`);
  lines.push('');

  // Waste comparison
  lines.push(`## Waste Comparison`);
  lines.push('');
  lines.push(`| | Session A | Session B |`);
  lines.push(`|--|----------:|----------:|`);
  lines.push(`| Issues | ${comparison.waste.countA} | ${comparison.waste.countB} |`);
  lines.push(`| Reclaimable tokens | ~${fmt(comparison.waste.totalTokensA)} | ~${fmt(comparison.waste.totalTokensB)} |`);
  lines.push(`| Compactions | ${comparison.compaction.countA} | ${comparison.compaction.countB} |`);
  lines.push('');

  // Insights
  if (comparison.insights.length > 0) {
    lines.push(`## Insights`);
    lines.push('');
    for (const insight of comparison.insights) {
      lines.push(`- ${insight}`);
    }
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('');
  lines.push(`Generated by [claude-crusts](https://github.com/Abinesh-L/claude-crusts) v0.5.0 | ${new Date().toISOString()}`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Group waste items by severity.
 *
 * @param waste - Array of waste items
 * @returns Grouped object
 */
function groupBySeverity(waste: WasteItem[]): Record<string, WasteItem[]> {
  const grouped: Record<string, WasteItem[]> = {};
  for (const item of waste) {
    const arr = grouped[item.severity];
    if (arr) {
      arr.push(item);
    } else {
      grouped[item.severity] = [item];
    }
  }
  return grouped;
}
