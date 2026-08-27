import { describe, test, expect } from 'bun:test';
import { summarizeTrend } from '../src/trend.ts';
import type { TrendRecord } from '../src/types.ts';

function rec(percent: number, topCategory: TrendRecord['topCategory'] = 'tools'): TrendRecord {
  return {
    sessionId: Math.random().toString(36).slice(2),
    projectName: 'test',
    timestamp: new Date().toISOString(),
    totalTokens: Math.round(percent * 2000),
    percentUsed: percent,
    messageCount: 100,
    compactionCount: 0,
    health: percent < 50 ? 'healthy' : percent < 70 ? 'warming' : percent < 85 ? 'hot' : 'critical',
    topCategory,
    topCategoryTokens: 50_000,
  };
}

describe('summarizeTrend', () => {
  test('empty records returns zeroed summary', () => {
    const s = summarizeTrend([]);
    expect(s.count).toBe(0);
    expect(s.direction).toBe('flat');
    expect(s.series).toEqual([]);
  });

  test('detects worsening trend when percent rises >5pp', () => {
    const records = [rec(20), rec(25), rec(22), rec(50), rec(55), rec(60)];
    const s = summarizeTrend(records);
    expect(s.direction).toBe('worsening');
    expect(s.percentUsedDelta).toBeGreaterThan(5);
  });

  test('detects improving trend when percent falls >5pp', () => {
    const records = [rec(70), rec(65), rec(72), rec(30), rec(25), rec(20)];
    const s = summarizeTrend(records);
    expect(s.direction).toBe('improving');
    expect(s.percentUsedDelta).toBeLessThan(-5);
  });

  test('flat trend when delta is small', () => {
    const records = [rec(50), rec(51), rec(52), rec(51), rec(50), rec(52)];
    const s = summarizeTrend(records);
    expect(s.direction).toBe('flat');
  });

  test('picks dominant category by frequency', () => {
    const records = [
      rec(50, 'tools'),
      rec(50, 'tools'),
      rec(50, 'tools'),
      rec(50, 'retrieved'),
      rec(50, 'conversation'),
    ];
    expect(summarizeTrend(records).dominantCategory).toBe('tools');
  });
});

// ---------------------------------------------------------------------------
// v0.8.0 M18 — trend records carry the bucket reconciliation basis
// ---------------------------------------------------------------------------

import { buildTrendRecord } from '../src/trend.ts';
import type { AnalysisResult, CrustsBreakdown, ConfigData } from '../src/types.ts';

/** Minimal AnalysisResult around a fabricated breakdown (no I/O involved). */
function analysisResult(breakdown: CrustsBreakdown): AnalysisResult {
  return {
    sessionId: 'sess-m18',
    project: 'proj',
    messageCount: 12,
    breakdown,
    waste: [],
    recommendations: { recommendations: [], estimated_messages_until_compaction: null, context_health: 'healthy' },
    calibration: null,
    configData: {} as ConfigData,
    messages: [],
  };
}

/** Breakdown fixture with reconciled (window-basis) buckets. */
function reconciledBreakdown(overrides: Partial<CrustsBreakdown> = {}): CrustsBreakdown {
  return {
    buckets: [
      { category: 'conversation', tokens: 700, percentage: 58.3, accuracy: 'exact', contentTokens: 620 },
      { category: 'tools', tokens: 500, percentage: 41.7, accuracy: 'estimated', contentTokens: 445 },
    ],
    total_tokens: 1_200,
    contentSumTokens: 1_065,
    reconciliation: { scale: 1_200 / 1_065, basis: 'api' },
    context_limit: 200_000,
    free_tokens: 198_800,
    usage_percentage: 0.6,
    messages: [],
    toolBreakdown: { loadedTools: [], usedTools: [], unusedTools: [], schemaTokens: 0, callTokens: 0, resultTokens: 0, coreSchemaTokens: 0, coreSchemaSource: 'legacy', deferredBuiltIn: [], deferredMcp: [], loadedDeferred: [], loadedSchemaTokens: 0 },
    model: 'claude-fable-5',
    durationSeconds: null,
    compactionEvents: [],
    derivedOverhead: { internalSystemPrompt: null, messageFraming: null },
    ...overrides,
  } as CrustsBreakdown;
}

describe('M18 buildTrendRecord bucket reconciliation basis', () => {
  test('reconciled buckets record bucketBasis window and a top category bounded by the total', () => {
    const rec = buildTrendRecord(analysisResult(reconciledBreakdown()));
    expect(rec.bucketBasis).toBe('window');
    expect(rec.topCategory).toBe('conversation');
    expect(rec.topCategoryTokens).toBe(700);
    expect(rec.topCategoryTokens).toBeLessThanOrEqual(rec.totalTokens);
  });

  test('content-basis buckets (reconciliation guard fired) record bucketBasis content', () => {
    const rec = buildTrendRecord(analysisResult(reconciledBreakdown({
      reconciliation: { scale: 3.2, basis: 'content' },
    })));
    expect(rec.bucketBasis).toBe('content');
  });

  test('compacted sessions read the basis from the reconciled currentContext view', () => {
    const bd = reconciledBreakdown({
      // Lifetime stays content-basis in compacted sessions; the record must
      // reflect the currentContext view it is built from.
      reconciliation: { scale: 1, basis: 'content' },
      compactionEvents: [{ beforeIndex: 2, afterIndex: 4, tokensBefore: 150_000, tokensAfter: 40_000, tokensDropped: 110_000, detection: 'marker' }] as CrustsBreakdown['compactionEvents'],
      currentContext: {
        buckets: [
          { category: 'system', tokens: 39_000, percentage: 95.1, accuracy: 'estimated', contentTokens: 38_000 },
          { category: 'conversation', tokens: 2_000, percentage: 4.9, accuracy: 'exact', contentTokens: 1_950 },
        ],
        total_tokens: 41_000,
        contentSumTokens: 39_950,
        reconciliation: { scale: 41_000 / 39_950, basis: 'api' },
        free_tokens: 159_000,
        usage_percentage: 20.5,
        startIndex: 4,
      },
    });
    const rec = buildTrendRecord(analysisResult(bd));
    expect(rec.bucketBasis).toBe('window');
    expect(rec.topCategory).toBe('system');
    expect(rec.topCategoryTokens).toBe(39_000);
    expect(rec.totalTokens).toBe(41_000);
  });
});
