/**
 * Cross-session trend tracking.
 *
 * Persists a one-line summary of every analyze run to
 * `~/.claude-crusts/history.jsonl`, then provides loaders and a
 * summarizer that powers the `claude-crusts trend` command. Storage is
 * append-only JSONL so concurrent runs never trample each other; reads
 * dedupe by session id (latest timestamp wins) so re-analyzing the same
 * session updates rather than double-counting it.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { CRUSTS_DIR } from './calibrator.ts';
import type {
  AnalysisResult,
  TrendRecord,
  TrendSummary,
  CrustsCategory,
  ContextHealth,
} from './types.ts';

/** Path to the append-only history file */
const HISTORY_PATH = join(CRUSTS_DIR, 'history.jsonl');

/** Health classification thresholds — kept in sync with recommender.ts */
const HEALTH_THRESHOLDS = { healthy: 50, warming: 70, hot: 85 };

/**
 * Map a percent-used value to a context health bucket.
 *
 * Duplicated from recommender.ts (kept private there) to avoid an import
 * cycle: recommender already depends on types, and this module is loaded
 * by analyzer.ts after recommender has run.
 *
 * @param percent - Context usage percentage (0-100)
 * @returns Health classification
 */
function classifyHealth(percent: number): ContextHealth {
  if (percent < HEALTH_THRESHOLDS.healthy) return 'healthy';
  if (percent < HEALTH_THRESHOLDS.warming) return 'warming';
  if (percent < HEALTH_THRESHOLDS.hot) return 'hot';
  return 'critical';
}

/**
 * Append a single record describing the supplied analysis to history.jsonl.
 *
 * Uses the post-compaction `currentContext` view when available so the
 * recorded percent-used reflects what the user is actually working with,
 * not the cumulative session size. Silently swallows I/O errors — trend
 * recording must never break a normal analyze run.
 *
 * @param result - The completed AnalysisResult
 */
export function recordTrend(result: AnalysisResult): void {
  try {
    const breakdown = result.breakdown;
    const view = breakdown.currentContext ?? {
      buckets: breakdown.buckets,
      total_tokens: breakdown.total_tokens,
      usage_percentage: breakdown.usage_percentage,
    };

    let topCategory: CrustsCategory = 'conversation';
    let topCategoryTokens = 0;
    for (const bucket of view.buckets) {
      if (bucket.tokens > topCategoryTokens) {
        topCategory = bucket.category;
        topCategoryTokens = bucket.tokens;
      }
    }

    const record: TrendRecord = {
      sessionId: result.sessionId,
      projectName: result.project,
      timestamp: new Date().toISOString(),
      totalTokens: view.total_tokens,
      percentUsed: view.usage_percentage,
      messageCount: result.messageCount,
      compactionCount: breakdown.compactionEvents.length,
      health: classifyHealth(view.usage_percentage),
      topCategory,
      topCategoryTokens,
      contextLimit: breakdown.context_limit,
    };

    if (!existsSync(CRUSTS_DIR)) {
      mkdirSync(CRUSTS_DIR, { recursive: true });
    }
    appendFileSync(HISTORY_PATH, JSON.stringify(record) + '\n', 'utf-8');
  } catch {
    // Trend recording is best-effort; never propagate errors.
  }
}

/**
 * Load trend records from history.jsonl, deduped by session id.
 *
 * Re-analyzing the same session over and over should not inflate the
 * history — keep the latest record per session id. Records are returned
 * in chronological order (oldest first) and capped to the requested
 * window size from the tail.
 *
 * @param limit - Maximum number of records to return (default 50)
 * @param projectFilter - Optional substring match on projectName
 * @returns Chronologically-sorted TrendRecord array
 */
export function loadTrendHistory(limit = 50, projectFilter?: string): TrendRecord[] {
  if (!existsSync(HISTORY_PATH)) return [];

  let raw: string;
  try {
    raw = readFileSync(HISTORY_PATH, 'utf-8');
  } catch {
    return [];
  }

  const bySession = new Map<string, TrendRecord>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: TrendRecord;
    try {
      parsed = JSON.parse(line) as TrendRecord;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed.sessionId !== 'string') continue;
    if (projectFilter && !parsed.projectName.toLowerCase().includes(projectFilter.toLowerCase())) {
      continue;
    }
    const existing = bySession.get(parsed.sessionId);
    if (!existing || parsed.timestamp > existing.timestamp) {
      bySession.set(parsed.sessionId, parsed);
    }
  }

  const sorted = [...bySession.values()].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );

  return sorted.slice(-limit);
}

/**
 * Compute aggregate statistics across a list of trend records.
 *
 * Direction is computed by comparing the first third's average percent-used
 * against the last third's average. A delta of more than 5 percentage points
 * is considered a meaningful direction; smaller deltas are reported as flat.
 *
 * @param records - Chronologically-sorted records (oldest first)
 * @returns TrendSummary, or a zeroed summary when records is empty
 */
export function summarizeTrend(records: TrendRecord[]): TrendSummary {
  if (records.length === 0) {
    return {
      count: 0,
      avgPercentUsed: 0,
      avgTotalTokens: 0,
      avgCompactionCount: 0,
      avgMessageCount: 0,
      dominantCategory: 'conversation',
      direction: 'flat',
      percentUsedDelta: 0,
      series: [],
    };
  }

  const sum = (vals: number[]): number => vals.reduce((a, b) => a + b, 0);
  const avg = (vals: number[]): number => (vals.length === 0 ? 0 : sum(vals) / vals.length);

  const percents = records.map((r) => r.percentUsed);
  const totals = records.map((r) => r.totalTokens);
  const compactions = records.map((r) => r.compactionCount);
  const msgCounts = records.map((r) => r.messageCount);

  const counts = new Map<CrustsCategory, number>();
  for (const r of records) {
    counts.set(r.topCategory, (counts.get(r.topCategory) ?? 0) + 1);
  }
  let dominantCategory: CrustsCategory = records[0]!.topCategory;
  let bestCount = 0;
  for (const [cat, n] of counts.entries()) {
    if (n > bestCount) {
      dominantCategory = cat;
      bestCount = n;
    }
  }

  // Direction: compare first-third average vs last-third average
  let percentUsedDelta = 0;
  let direction: TrendSummary['direction'] = 'flat';
  if (records.length >= 3) {
    const third = Math.max(1, Math.floor(records.length / 3));
    const firstAvg = avg(percents.slice(0, third));
    const lastAvg = avg(percents.slice(-third));
    percentUsedDelta = lastAvg - firstAvg;
    if (percentUsedDelta > 5) direction = 'worsening';
    else if (percentUsedDelta < -5) direction = 'improving';
  }

  return {
    count: records.length,
    avgPercentUsed: avg(percents),
    avgTotalTokens: avg(totals),
    avgCompactionCount: avg(compactions),
    avgMessageCount: avg(msgCounts),
    dominantCategory,
    direction,
    percentUsedDelta,
    series: percents,
  };
}

/** Escape a single CSV cell — double internal quotes and wrap if needed. */
function csvEscape(value: string | number | undefined): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Serialise a list of trend records as a CSV document.
 *
 * Columns follow the TrendRecord schema verbatim, including the
 * optional `contextLimit` column (empty for pre-v0.6.0 records that
 * predate that field). Timestamps are kept as ISO strings so they sort
 * lexically in spreadsheets. The header is always emitted.
 *
 * @param records - Trend records (any order; caller decides)
 * @returns CSV text including a trailing newline
 */
export function formatTrendAsCsv(records: TrendRecord[]): string {
  const header = [
    'sessionId',
    'projectName',
    'timestamp',
    'totalTokens',
    'percentUsed',
    'messageCount',
    'compactionCount',
    'health',
    'topCategory',
    'topCategoryTokens',
    'contextLimit',
  ].join(',');

  const lines = records.map((r) => [
    csvEscape(r.sessionId),
    csvEscape(r.projectName),
    csvEscape(r.timestamp),
    csvEscape(r.totalTokens),
    csvEscape(r.percentUsed.toFixed(2)),
    csvEscape(r.messageCount),
    csvEscape(r.compactionCount),
    csvEscape(r.health),
    csvEscape(r.topCategory),
    csvEscape(r.topCategoryTokens),
    csvEscape(r.contextLimit),
  ].join(','));

  return [header, ...lines].join('\n') + '\n';
}
