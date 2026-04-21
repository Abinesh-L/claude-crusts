import { describe, test, expect } from 'bun:test';
import { shouldInject, buildInjectionText } from '../src/auto-inject.ts';
import type { CrustsBreakdown, WasteItem } from '../src/types.ts';
import { DEFAULT_AUTO_INJECT } from '../src/config.ts';

function breakdownAt(pct: number, overrides: Partial<CrustsBreakdown> = {}): CrustsBreakdown {
  return {
    buckets: [
      { category: 'conversation', tokens: 10000, percentage: 40, accuracy: 'exact' },
      { category: 'tools', tokens: 8000, percentage: 32, accuracy: 'exact' },
      { category: 'retrieved', tokens: 4000, percentage: 16, accuracy: 'exact' },
    ],
    total_tokens: Math.round(pct * 2_000),
    context_limit: 200_000,
    free_tokens: 0,
    usage_percentage: pct,
    messages: [],
    toolBreakdown: { loadedTools: [], usedTools: [], unusedTools: [], schemaTokens: 0, callTokens: 0, resultTokens: 0 },
    model: 'claude-opus-4-7',
    durationSeconds: null,
    compactionEvents: [],
    configOverhead: { systemPrompt: 0, memoryFiles: 0, mcpSchemas: 0, builtInTools: 0, skills: 0 },
    totalMessages: 0,
    derivedOverhead: { internalSystemPrompt: null, messageFraming: null },
    ...overrides,
  } as CrustsBreakdown;
}

describe('shouldInject', () => {
  test('refuses when disabled in config', () => {
    const cfg = { ...DEFAULT_AUTO_INJECT, enabled: false, threshold: 70 };
    const d = shouldInject(breakdownAt(90), cfg, 'sid');
    expect(d.inject).toBe(false);
    if (!d.inject) expect(d.reason).toContain('disabled');
  });

  test('refuses when usage is below threshold', () => {
    const cfg = { ...DEFAULT_AUTO_INJECT, enabled: true, threshold: 70 };
    const d = shouldInject(breakdownAt(65), cfg, 'sid');
    expect(d.inject).toBe(false);
    if (!d.inject) expect(d.reason).toContain('threshold');
  });

  test('injects when usage crosses threshold and min-gap elapsed', () => {
    const cfg = { ...DEFAULT_AUTO_INJECT, enabled: true, threshold: 70, minGapMs: 1000 };
    const d = shouldInject(breakdownAt(85), cfg, 'sid');
    expect(d.inject).toBe(true);
    if (d.inject) expect(d.usagePercent).toBe(85);
  });

  test('refuses when min-gap has not elapsed (same session)', () => {
    const now = 1_000_000;
    const cfg = {
      ...DEFAULT_AUTO_INJECT,
      enabled: true,
      threshold: 70,
      minGapMs: 300_000,
      lastInjectionAt: new Date(now - 60_000).toISOString(), // 1 min ago
      lastInjectionSessionId: 'sid',
    };
    const d = shouldInject(breakdownAt(85), cfg, 'sid', now);
    expect(d.inject).toBe(false);
    if (!d.inject) expect(d.reason).toMatch(/min-gap|last injection/);
  });

  test('allows injection on a different session even within min-gap', () => {
    const now = 1_000_000;
    const cfg = {
      ...DEFAULT_AUTO_INJECT,
      enabled: true,
      threshold: 70,
      minGapMs: 300_000,
      lastInjectionAt: new Date(now - 60_000).toISOString(),
      lastInjectionSessionId: 'other-sid',
    };
    const d = shouldInject(breakdownAt(85), cfg, 'sid', now);
    expect(d.inject).toBe(true);
  });

  test('uses currentContext usage when post-compaction view exists', () => {
    const bd = breakdownAt(50, {
      currentContext: {
        buckets: [],
        total_tokens: 160_000,
        free_tokens: 40_000,
        usage_percentage: 80,
        startIndex: 0,
      },
    } as Partial<CrustsBreakdown>);
    const cfg = { ...DEFAULT_AUTO_INJECT, enabled: true, threshold: 70 };
    const d = shouldInject(bd, cfg, 'sid');
    expect(d.inject).toBe(true);
    if (d.inject) expect(d.usagePercent).toBe(80);
  });
});

describe('buildInjectionText', () => {
  test('includes the usage percentage in the header', () => {
    const text = buildInjectionText(breakdownAt(78), [], 78);
    expect(text).toContain('78.0%');
    expect(text).toContain('claude-crusts advisory');
  });

  test('synthesises a /compact focus line from duplicate_read waste', () => {
    const waste: WasteItem[] = [
      { type: 'duplicate_read', severity: 'high', description: '"renderer.ts" read 6 times', estimated_tokens: 1500, recommendation: '' },
    ];
    const text = buildInjectionText(breakdownAt(80), waste, 80);
    expect(text).toContain('/compact focus');
    expect(text).toContain('renderer.ts');
  });

  test('handles stale_read and resolved_exchange items', () => {
    const waste: WasteItem[] = [
      { type: 'stale_read', severity: 'medium', description: '"classifier.ts" read 40 msgs ago', estimated_tokens: 600, recommendation: '' },
      { type: 'resolved_exchange', severity: 'medium', description: 'resolved', estimated_tokens: 900, recommendation: '', message_range: [42, 48] },
    ];
    const text = buildInjectionText(breakdownAt(80), waste, 80);
    expect(text).toContain('drop stale read of classifier.ts');
    expect(text).toContain('resolved exchange at messages #42-48');
  });

  test('falls back to bare /compact when no actionable waste', () => {
    const text = buildInjectionText(breakdownAt(80), [], 80);
    expect(text).toContain('/compact');
    expect(text).not.toContain('focus "');
  });

  test('includes saveable token count when waste is present', () => {
    const waste: WasteItem[] = [
      { type: 'duplicate_read', severity: 'high', description: '"r.ts" read 6 times', estimated_tokens: 1500, recommendation: '' },
      { type: 'stale_read', severity: 'medium', description: '"c.ts" stale', estimated_tokens: 800, recommendation: '' },
    ];
    const text = buildInjectionText(breakdownAt(80), waste, 80);
    expect(text).toContain('2,300');
    expect(text).toContain('reclaimable');
  });
});
