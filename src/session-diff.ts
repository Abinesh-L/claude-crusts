/**
 * Intra-session diff — what changed in context between two points in the
 * *same* session.
 *
 * Complements `compare` (two different sessions) by slicing one session at
 * two cutpoints and reporting per-category deltas. Useful for "which message
 * blew up my context?" analysis and for pinpointing individual compaction
 * effects.
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import { classifySession } from './classifier.ts';
import type { CrustsCategory, SessionMessage, ConfigData, CrustsBreakdown } from './types.ts';

/** Per-category delta between two slices of the same session. */
export interface SessionDiffCategoryDelta {
  category: CrustsCategory;
  tokensFrom: number;
  tokensTo: number;
  delta: number;
  deltaPercent: number;
}

/** Diff result between two message cutpoints of a single session. */
export interface SessionDiffResult {
  sessionId: string;
  fromIndex: number;
  toIndex: number;
  totalFrom: number;
  totalTo: number;
  totalDelta: number;
  categoryDeltas: SessionDiffCategoryDelta[];
  messageCountFrom: number;
  messageCountTo: number;
}

/** All six CRUSTS categories in a stable display order. */
const CATEGORIES: CrustsCategory[] = ['conversation', 'retrieved', 'user', 'system', 'tools', 'state'];

/**
 * Compute the diff between two message cutpoints of a session.
 *
 * Both cutpoints use `classifySession`'s `untilIndex` semantics (exclusive).
 * `fromIndex` must be less than `toIndex`; both are clamped to the valid
 * range [1, messages.length].
 *
 * @param messages - Parsed session messages
 * @param configData - Config data from scanner
 * @param sessionId - Session identifier for the result
 * @param fromIndex - Earlier cutpoint (exclusive; 1-based-like)
 * @param toIndex - Later cutpoint (exclusive)
 * @returns Diff result
 * @throws when fromIndex >= toIndex or either is out of range
 */
export function computeSessionDiff(
  messages: SessionMessage[],
  configData: ConfigData,
  sessionId: string,
  fromIndex: number,
  toIndex: number,
): SessionDiffResult {
  if (messages.length === 0) {
    throw new Error('Session is empty — nothing to diff.');
  }
  const maxIndex = messages.length;
  const from = Math.max(1, Math.min(fromIndex, maxIndex));
  const to = Math.max(1, Math.min(toIndex, maxIndex));
  if (from >= to) {
    throw new Error(`--from (${from}) must be less than --to (${to}).`);
  }

  const breakdownFrom = classifySession(messages, configData, from);
  const breakdownTo = classifySession(messages, configData, to);

  return {
    sessionId,
    fromIndex: from,
    toIndex: to,
    totalFrom: breakdownFrom.total_tokens,
    totalTo: breakdownTo.total_tokens,
    totalDelta: breakdownTo.total_tokens - breakdownFrom.total_tokens,
    categoryDeltas: buildCategoryDeltas(breakdownFrom, breakdownTo),
    messageCountFrom: breakdownFrom.messages.length,
    messageCountTo: breakdownTo.messages.length,
  };
}

/** Pair up buckets from two breakdowns and emit a delta row for each category. */
function buildCategoryDeltas(
  from: CrustsBreakdown,
  to: CrustsBreakdown,
): SessionDiffCategoryDelta[] {
  const fromMap = new Map(from.buckets.map((b) => [b.category, b.tokens]));
  const toMap = new Map(to.buckets.map((b) => [b.category, b.tokens]));
  return CATEGORIES.map((cat) => {
    const tokensFrom = fromMap.get(cat) ?? 0;
    const tokensTo = toMap.get(cat) ?? 0;
    const delta = tokensTo - tokensFrom;
    const deltaPercent = tokensFrom > 0 ? (delta / tokensFrom) * 100 : (tokensTo > 0 ? 100 : 0);
    return { category: cat, tokensFrom, tokensTo, delta, deltaPercent };
  });
}

/** Render a session diff to stdout as a coloured cli-table. */
export function renderSessionDiff(diff: SessionDiffResult): void {
  console.log();
  console.log(chalk.bold(`  CRUSTS Session Diff \u2014 ${diff.sessionId.slice(0, 8)}`));
  console.log(chalk.dim(`  Messages #${diff.fromIndex} (${diff.totalFrom.toLocaleString()} tkns) \u2192 #${diff.toIndex} (${diff.totalTo.toLocaleString()} tkns)`));

  const totalSign = diff.totalDelta > 0 ? '+' : '';
  const totalColor = diff.totalDelta > 0 ? chalk.yellow : diff.totalDelta < 0 ? chalk.green : chalk.dim;
  console.log(`  Total delta: ${totalColor(`${totalSign}${diff.totalDelta.toLocaleString()} tokens`)}`);
  console.log();

  const table = new Table({
    head: [
      chalk.dim('Category'),
      chalk.dim('From'),
      chalk.dim('To'),
      chalk.dim('Delta'),
      chalk.dim('%'),
    ],
    style: { head: [], border: [] },
    colWidths: [16, 12, 12, 12, 10],
  });

  for (const row of diff.categoryDeltas) {
    const sign = row.delta > 0 ? '+' : '';
    const color = row.delta > 0 ? chalk.yellow : row.delta < 0 ? chalk.green : chalk.dim;
    const pctSign = row.deltaPercent > 0 ? '+' : '';
    table.push([
      row.category,
      row.tokensFrom.toLocaleString(),
      row.tokensTo.toLocaleString(),
      color(`${sign}${row.delta.toLocaleString()}`),
      color(`${pctSign}${row.deltaPercent.toFixed(1)}%`),
    ]);
  }
  console.log(table.toString());
  console.log();
}
