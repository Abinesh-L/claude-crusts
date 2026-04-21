/**
 * Live session watcher.
 *
 * Monitors a session JSONL file for changes and renders a compact
 * live dashboard that updates in real-time. Detects compaction events
 * and shows alerts. Prints a summary on exit.
 */

import { statSync, watchFile, unwatchFile } from 'fs';
import chalk from 'chalk';
import { parseSession } from './scanner.ts';
import { classifySession } from './classifier.ts';
import { detectWaste } from './waste-detector.ts';
import { generateRecommendations } from './recommender.ts';
import { gatherConfigData } from './analyzer.ts';
import type {
  AnalysisResult,
  CrustsBreakdown,
  CrustsCategory,
  CompactionEvent,
  ContextHealth,
  SessionInfo,
} from './types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CRUSTS category short labels for the compact display */
const CAT_SHORT: Record<CrustsCategory, string> = {
  conversation: 'C',
  retrieved: 'R',
  user: 'U',
  system: 'Sys',
  tools: 'T',
  state: 'St',
};

/** Category colors for the compact display */
const CAT_COLOR: Record<CrustsCategory, (s: string) => string> = {
  conversation: chalk.cyan,
  retrieved: chalk.blue,
  user: chalk.green,
  system: chalk.yellow,
  tools: chalk.magenta,
  state: chalk.white,
};

/** Compaction threshold */
const COMPACTION_THRESHOLD = 0.80;

/** Health thresholds */
const HEALTH_THRESHOLDS = { healthy: 50, warming: 70, hot: 85 };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Last compaction observed during this watch session */
let lastWatchCompaction: {
  messageIndex: number;
  tokensBefore: number;
  tokensAfter: number;
  timestamp: number;
} | null = null;

/** How many compactions occurred during this watch session */
let watchCompactionCount = 0;

/** Render count since last compaction (for flash effect) */
let rendersSinceCompaction = Infinity;

/** Previous compaction count to detect new events */
let prevCompactionCount = 0;

/** Message count at start of watch */
let startMessageCount = 0;

/** Whether this is the first render */
let firstRender = true;

/** Last known file size for change detection */
let lastFileSize = 0;

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Start watching a session file and rendering live updates.
 *
 * @param session - Session info from scanner
 * @param intervalMs - Polling interval in milliseconds
 * @param jsonMode - If true, output newline-delimited JSON instead of dashboard
 */
export async function startWatch(
  session: SessionInfo,
  intervalMs: number,
  jsonMode: boolean,
): Promise<void> {
  const configData = gatherConfigData();

  // Initial render
  await renderUpdate(session, configData, jsonMode);

  // Set up file watching via polling (most reliable on Windows)
  watchFile(session.path, { interval: intervalMs }, async () => {
    try {
      const currentSize = statSync(session.path).size;
      if (currentSize === lastFileSize) return;
      lastFileSize = currentSize;
      await renderUpdate(session, configData, jsonMode);
    } catch {
      // File may be mid-write, skip this tick
    }
  });

  // Graceful shutdown on Ctrl+C
  const cleanup = async () => {
    unwatchFile(session.path);
    if (!jsonMode) {
      await renderExitSummary(session, configData);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => { void cleanup(); });
  process.on('SIGTERM', () => { void cleanup(); });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * Parse, analyze, and render the current session state.
 *
 * @param session - Session info
 * @param configData - Pre-loaded config data
 * @param jsonMode - Output JSON instead of dashboard
 */
async function renderUpdate(
  session: SessionInfo,
  configData: ReturnType<typeof gatherConfigData>,
  jsonMode: boolean,
): Promise<void> {
  const messages = await parseSession(session.path);
  if (messages.length === 0) return;

  lastFileSize = statSync(session.path).size;
  const breakdown = classifySession(messages, configData);
  const waste = detectWaste(messages, breakdown, configData);
  const recommendations = generateRecommendations(breakdown, waste, configData, messages);

  if (firstRender) {
    startMessageCount = breakdown.messages.length;
    prevCompactionCount = breakdown.compactionEvents.length;
    firstRender = false;
  }

  // Detect new compaction events during this watch session
  if (breakdown.compactionEvents.length > prevCompactionCount) {
    const newCount = breakdown.compactionEvents.length - prevCompactionCount;
    watchCompactionCount += newCount;
    rendersSinceCompaction = 0;
    const latest = breakdown.compactionEvents[breakdown.compactionEvents.length - 1]!;
    lastWatchCompaction = {
      messageIndex: latest.beforeIndex + 1,
      tokensBefore: latest.tokensBefore,
      tokensAfter: latest.tokensAfter,
      timestamp: Date.now(),
    };
    prevCompactionCount = breakdown.compactionEvents.length;
  } else {
    rendersSinceCompaction++;
  }

  if (jsonMode) {
    renderJsonUpdate(breakdown, waste.length, recommendations.estimated_messages_until_compaction, session);
    return;
  }

  renderDashboard(breakdown, waste.length, recommendations.context_health, recommendations.estimated_messages_until_compaction, session);
}

/**
 * Render the compact live dashboard.
 *
 * Clears the screen and draws a single-screen view with usage bar,
 * category breakdown, waste count, compaction prediction, and
 * last message preview.
 */
function renderDashboard(
  breakdown: CrustsBreakdown,
  wasteCount: number,
  health: ContextHealth,
  msgsUntilCompaction: number | null,
  session: SessionInfo,
): void {
  // Use current context if compacted, otherwise full
  const hasCompaction = breakdown.compactionEvents.length > 0 && breakdown.currentContext;
  const total = hasCompaction ? breakdown.currentContext!.total_tokens : breakdown.total_tokens;
  const pct = hasCompaction ? breakdown.currentContext!.usage_percentage : breakdown.usage_percentage;
  const buckets = hasCompaction ? breakdown.currentContext!.buckets : breakdown.buckets;

  // Clear screen
  process.stdout.write('\x1b[2J\x1b[H');

  // Header
  const hc = healthColorFn(health);
  console.log(chalk.bold('  CRUSTS Watch') + chalk.dim(` — ${session.id.slice(0, 8)} | ${breakdown.model}`));
  console.log(chalk.dim(`  Project: ${session.project}`));
  console.log();

  // Usage bar
  const barWidth = 40;
  const filled = Math.round((pct / 100) * barWidth);
  const empty = barWidth - filled;
  const barColor = pct >= 85 ? chalk.red : pct >= 70 ? chalk.yellow : chalk.green;
  const bar = barColor('\u2588'.repeat(filled)) + chalk.dim('\u2591'.repeat(empty));
  console.log(`  ${bar} ${hc(`${pct.toFixed(1)}%`)} (${total.toLocaleString()} / ${breakdown.context_limit.toLocaleString()})`);

  // Inline compaction line — only if one happened during this watch session
  if (lastWatchCompaction) {
    const ago = formatAgo(Date.now() - lastWatchCompaction.timestamp);
    const text = `  \u26A1 Last compaction: #${lastWatchCompaction.messageIndex} (${lastWatchCompaction.tokensBefore.toLocaleString()} \u2192 ${lastWatchCompaction.tokensAfter.toLocaleString()} tokens) ${ago}`;
    // Flash bright for first 3 renders after compaction, then settle to yellow
    const compColor = rendersSinceCompaction < 3 ? chalk.bgYellow.black.bold : chalk.yellow;
    console.log(compColor(text));
  }

  console.log();

  // Category percentages on one line
  const catParts: string[] = [];
  for (const bucket of buckets) {
    const label = CAT_SHORT[bucket.category];
    const color = CAT_COLOR[bucket.category];
    catParts.push(color(`${label}:${bucket.percentage.toFixed(0)}%`));
  }
  console.log(`  ${catParts.join('  ')}`);
  console.log();

  // Message count
  const msgDelta = breakdown.messages.length - startMessageCount;
  const msgSuffix = msgDelta > 0 ? chalk.dim(` (+${msgDelta} since watch started)`) : '';
  console.log(`  Messages: ${chalk.bold(String(breakdown.messages.length))}${msgSuffix}`);

  // Compaction count
  if (breakdown.compactionEvents.length > 0) {
    console.log(`  Compactions: ${chalk.yellow(String(breakdown.compactionEvents.length))}`);
  }

  // Waste count
  if (wasteCount > 0) {
    console.log(`  Waste: ${chalk.yellow(`${wasteCount} issue(s) detected`)}`);
  }

  // Compaction prediction
  if (msgsUntilCompaction !== null) {
    const urgency = msgsUntilCompaction <= 10
      ? chalk.red.bold(`~${msgsUntilCompaction} messages until auto-compaction`)
      : msgsUntilCompaction <= 30
        ? chalk.yellow(`~${msgsUntilCompaction} messages until auto-compaction`)
        : chalk.dim(`~${msgsUntilCompaction} messages until auto-compaction`);
    console.log(`  ${urgency}`);
  }

  console.log();

  // Last message preview
  const lastMsg = breakdown.messages[breakdown.messages.length - 1];
  if (lastMsg) {
    const preview = lastMsg.contentPreview.slice(0, 70);
    const catLabel = CAT_SHORT[lastMsg.category];
    const catColor = CAT_COLOR[lastMsg.category];
    console.log(chalk.dim(`  Last: `) + catColor(`[${catLabel}]`) + chalk.dim(` ${preview}`));
  }

  // Timestamp
  console.log(chalk.dim(`  Updated: ${new Date().toLocaleTimeString()}`));
  console.log();
  console.log(chalk.dim('  Press Ctrl+C to stop'));
}

/**
 * Output a JSON line for the current state (newline-delimited JSON mode).
 */
function renderJsonUpdate(
  breakdown: CrustsBreakdown,
  wasteCount: number,
  msgsUntilCompaction: number | null,
  session: SessionInfo,
): void {
  const hasCompaction = breakdown.compactionEvents.length > 0 && breakdown.currentContext;
  const total = hasCompaction ? breakdown.currentContext!.total_tokens : breakdown.total_tokens;
  const pct = hasCompaction ? breakdown.currentContext!.usage_percentage : breakdown.usage_percentage;

  const catMap: Record<string, number> = {};
  const buckets = hasCompaction ? breakdown.currentContext!.buckets : breakdown.buckets;
  for (const b of buckets) {
    catMap[b.category] = b.percentage;
  }

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    sessionId: session.id,
    messageCount: breakdown.messages.length,
    model: breakdown.model,
    totalTokens: total,
    contextLimit: breakdown.context_limit,
    usagePercent: Math.round(pct * 10) / 10,
    categories: catMap,
    wasteCount,
    compactionCount: breakdown.compactionEvents.length,
    msgsUntilCompaction,
  }));
}

/**
 * Render the exit summary when the user presses Ctrl+C.
 */
async function renderExitSummary(
  session: SessionInfo,
  configData: ReturnType<typeof gatherConfigData>,
): Promise<void> {
  // Clear the watch display
  process.stdout.write('\x1b[2J\x1b[H');

  const messages = await parseSession(session.path);
  if (messages.length === 0) {
    console.log(chalk.dim('\n  No messages in session.\n'));
    return;
  }

  const breakdown = classifySession(messages, configData);
  const hasCompaction = breakdown.compactionEvents.length > 0 && breakdown.currentContext;
  const total = hasCompaction ? breakdown.currentContext!.total_tokens : breakdown.total_tokens;
  const pct = hasCompaction ? breakdown.currentContext!.usage_percentage : breakdown.usage_percentage;

  const endMessageCount = breakdown.messages.length;
  const observed = endMessageCount - startMessageCount;

  console.log();
  console.log(chalk.bold('  CRUSTS Watch — Summary'));
  console.log(chalk.dim('  ' + '\u2500'.repeat(40)));
  console.log(`  Session: ${session.id.slice(0, 8)}`);
  console.log(`  Messages observed: ${observed >= 0 ? `+${observed}` : observed} (${startMessageCount} → ${endMessageCount})`);
  console.log(`  Compaction events during watch: ${watchCompactionCount}`);
  console.log(`  Final context usage: ${total.toLocaleString()} / ${breakdown.context_limit.toLocaleString()} (${pct.toFixed(1)}%)`);
  console.log();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get a chalk color function for a health status.
 *
 * @param health - Context health level
 * @returns Chalk color function
 */
function healthColorFn(health: ContextHealth): (s: string) => string {
  switch (health) {
    case 'healthy': return chalk.green;
    case 'warming': return chalk.yellow;
    case 'hot': return chalk.red;
    case 'critical': return chalk.bgRed.white;
  }
}

/**
 * Format a millisecond duration as a short human-readable "ago" string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string like "2m ago" or "just now"
 */
function formatAgo(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}
