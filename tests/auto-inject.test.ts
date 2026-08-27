import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { shouldInject, buildInjectionText, writeInjectionLog, readInjectionLog } from '../src/auto-inject.ts';
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
    toolBreakdown: { loadedTools: [], usedTools: [], unusedTools: [], schemaTokens: 0, callTokens: 0, resultTokens: 0, coreSchemaTokens: 0, coreSchemaSource: 'legacy', deferredBuiltIn: [], deferredMcp: [], loadedDeferred: [], loadedSchemaTokens: 0 },
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

  test('explicit threshold: refuses when usage is below it', () => {
    const cfg = { ...DEFAULT_AUTO_INJECT, enabled: true, threshold: 70, thresholdExplicit: true };
    const d = shouldInject(breakdownAt(65), cfg, 'sid');
    expect(d.inject).toBe(false);
    if (!d.inject) expect(d.reason).toContain('threshold');
  });

  test('explicit threshold: injects when usage crosses it and min-gap elapsed', () => {
    const cfg = { ...DEFAULT_AUTO_INJECT, enabled: true, threshold: 70, thresholdExplicit: true, minGapMs: 1000 };
    const d = shouldInject(breakdownAt(85), cfg, 'sid');
    expect(d.inject).toBe(true);
    if (d.inject) expect(d.usagePercent).toBe(85);
  });

  test('explicit threshold 47 still injects at modest usage (fixed-percentage gate honoured)', () => {
    // A user who pinned a low threshold keeps that behaviour; the headroom
    // default must not silently replace an explicit config.json choice.
    const cfg = { ...DEFAULT_AUTO_INJECT, enabled: true, threshold: 47, thresholdExplicit: true };
    const d = shouldInject(breakdownAt(50), cfg, 'sid');
    expect(d.inject).toBe(true);
    if (d.inject) expect(d.usagePercent).toBe(50);
  });

  test('default gate: 200K window at 65% (130K) is short of the headroom gate', () => {
    // Gate = autocompactTrigger(200K) - max(20K, 10% of 200K)
    //      = 167,000 - 20,000 = 147,000 tokens.
    const cfg = { ...DEFAULT_AUTO_INJECT, enabled: true };
    const d = shouldInject(breakdownAt(65), cfg, 'sid');
    expect(d.inject).toBe(false);
    if (!d.inject) expect(d.reason).toContain('headroom gate');
  });

  test('default gate: 200K window at 75% (150K) is inside the headroom margin and injects', () => {
    const cfg = { ...DEFAULT_AUTO_INJECT, enabled: true };
    const d = shouldInject(breakdownAt(75), cfg, 'sid');
    expect(d.inject).toBe(true);
  });

  test('default gate: 1M window at 70% does NOT inject (still 267K clear of the trigger)', () => {
    // 700,000 tokens on 1M: trigger 967,000, margin max(20K, 100K) = 100K,
    // gate 867,000. The old 70%-of-window default fired here pointlessly.
    const bd = breakdownAt(70, { context_limit: 1_000_000, total_tokens: 700_000, usage_percentage: 70 });
    const cfg = { ...DEFAULT_AUTO_INJECT, enabled: true };
    const d = shouldInject(bd, cfg, 'sid');
    expect(d.inject).toBe(false);
    if (!d.inject) expect(d.reason).toContain('headroom gate');
  });

  test('default gate: 1M window at 90% (900K) is past the gate and injects', () => {
    const bd = breakdownAt(90, { context_limit: 1_000_000, total_tokens: 900_000, usage_percentage: 90 });
    const cfg = { ...DEFAULT_AUTO_INJECT, enabled: true };
    const d = shouldInject(bd, cfg, 'sid');
    expect(d.inject).toBe(true);
    if (d.inject) expect(d.usagePercent).toBe(90);
  });

  test('default gate honours a custom autocompact buffer (bufferTokens param)', () => {
    // Buffer 53K on 200K: trigger 147,000, gate 127,000; 130K now injects
    // even though it refused under the default 33K buffer.
    const cfg = { ...DEFAULT_AUTO_INJECT, enabled: true };
    const refused = shouldInject(breakdownAt(65), cfg, 'sid');
    expect(refused.inject).toBe(false);
    const d = shouldInject(breakdownAt(65), cfg, 'sid', Date.now(), 53_000);
    expect(d.inject).toBe(true);
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

  test('advisory prefix is exactly [claude-crusts advisory] and stays on the first line', () => {
    const text = buildInjectionText(breakdownAt(80), [], 80);
    expect(text.startsWith('[claude-crusts advisory] ')).toBe(true);
  });

  test('explains the 33K headroom trigger instead of the old flat 80% claim', () => {
    const text = buildInjectionText(breakdownAt(80), [], 80);
    expect(text).toContain('33K');
    expect(text).not.toContain('reaches 80%');
  });

  test('dominant-categories fallback reads currentContext buckets when present', () => {
    // Lifetime buckets say conversation/tools; the live window is dominated
    // by state. The advisory describes the CURRENT context, so the state
    // bucket must be the one surfaced.
    const bd = breakdownAt(50, {
      currentContext: {
        buckets: [
          { category: 'state', tokens: 90_000, percentage: 60, accuracy: 'estimated' },
          { category: 'retrieved', tokens: 45_000, percentage: 30, accuracy: 'estimated' },
          { category: 'user', tokens: 15_000, percentage: 10, accuracy: 'estimated' },
        ],
        total_tokens: 150_000,
        free_tokens: 50_000,
        usage_percentage: 75,
        startIndex: 0,
      },
    } as Partial<CrustsBreakdown>);
    const text = buildInjectionText(bd, [], 75);
    expect(text).toContain('state 60%');
    expect(text).not.toContain('conversation 40%');
  });
});

describe('writeInjectionLog / readInjectionLog', () => {
  let sandbox: string;
  let savedOverride: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'crusts-inject-log-'));
    savedOverride = process.env.CRUSTS_INJECT_LOG_DIR;
    // Redirect the log path to a temp dir so tests never touch the developer's
    // real `~/.claude-crusts/auto-inject.log`.
    process.env.CRUSTS_INJECT_LOG_DIR = sandbox;
  });

  afterEach(() => {
    if (savedOverride === undefined) {
      delete process.env.CRUSTS_INJECT_LOG_DIR;
    } else {
      process.env.CRUSTS_INJECT_LOG_DIR = savedOverride;
    }
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('writes and reads back a single entry', () => {
    writeInjectionLog({
      ts: '2026-04-24T05:39:52.343Z',
      sessionId: 'abc12345-ef67-89ab-cdef-0123456789ab',
      usagePercent: 51.8,
      reclaimableTokens: 15084,
      advisoryText: '[claude-crusts advisory] test',
    });
    const entries = readInjectionLog();
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({
      sessionId: 'abc12345-ef67-89ab-cdef-0123456789ab',
      usagePercent: 51.8,
      reclaimableTokens: 15084,
    });
  });

  test('multiple entries are returned newest-first', () => {
    writeInjectionLog({ ts: '2026-04-24T05:00:00.000Z', sessionId: 'old-sid', usagePercent: 70, reclaimableTokens: 0, advisoryText: 'old' });
    writeInjectionLog({ ts: '2026-04-24T06:00:00.000Z', sessionId: 'new-sid', usagePercent: 80, reclaimableTokens: 0, advisoryText: 'new' });
    const entries = readInjectionLog();
    expect(entries[0]!.sessionId).toBe('new-sid');
    expect(entries[1]!.sessionId).toBe('old-sid');
  });

  test('limit restricts the returned count', () => {
    for (let i = 0; i < 5; i++) {
      writeInjectionLog({
        ts: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
        sessionId: `s${i}`,
        usagePercent: 70,
        reclaimableTokens: 0,
        advisoryText: `advisory-${i}`,
      });
    }
    const entries = readInjectionLog(3);
    expect(entries.length).toBe(3);
    // Newest first — so the last-written entry (i=4) should come first
    expect(entries[0]!.sessionId).toBe('s4');
  });

  test('corrupt lines are silently skipped, valid ones still return', () => {
    const logFile = join(sandbox, 'auto-inject.log');
    writeFileSync(
      logFile,
      [
        'not-json-at-all',
        JSON.stringify({ ts: '2026-01-01T00:00:00Z', sessionId: 's1', usagePercent: 70, reclaimableTokens: 0, advisoryText: '' }),
        '{}', // valid JSON but missing required fields
        '',   // empty line
        JSON.stringify({ ts: '2026-01-02T00:00:00Z', sessionId: 's2', usagePercent: 75, reclaimableTokens: 100, advisoryText: '' }),
      ].join('\n'),
      'utf-8',
    );
    const entries = readInjectionLog();
    expect(entries.length).toBe(2);
    // Newest-first reversal: s2 wins
    expect(entries[0]!.sessionId).toBe('s2');
    expect(entries[1]!.sessionId).toBe('s1');
  });

  test('missing log file returns empty array (no crash)', () => {
    // Fresh sandbox has no file written yet.
    const entries = readInjectionLog();
    expect(entries).toEqual([]);
  });

  test('append preserves earlier entries across writes', () => {
    writeInjectionLog({ ts: '2026-01-01T00:00:00Z', sessionId: 'one', usagePercent: 70, reclaimableTokens: 0, advisoryText: '' });
    writeInjectionLog({ ts: '2026-01-02T00:00:00Z', sessionId: 'two', usagePercent: 70, reclaimableTokens: 0, advisoryText: '' });
    writeInjectionLog({ ts: '2026-01-03T00:00:00Z', sessionId: 'three', usagePercent: 70, reclaimableTokens: 0, advisoryText: '' });
    const entries = readInjectionLog();
    expect(entries.map((e) => e.sessionId)).toEqual(['three', 'two', 'one']);
  });
});
