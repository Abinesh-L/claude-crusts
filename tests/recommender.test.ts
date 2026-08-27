/**
 * M15 regression tests: the auto-compaction trigger is a 33K headroom
 * buffer below the window size, not a flat 80%.
 *
 * The flat-80% model was only coincidentally close on 200K windows and far
 * off on 1M: a 1M session at 700K (70%) was reported near/past compaction
 * when it actually had 267K tokens of runway before the 967,000 trigger.
 *
 * All tests sandbox config reads via CRUSTS_CONFIG_DIR_OVERRIDE so the
 * developer's real ~/.claude-crusts/config.json can never leak into the
 * expectations (generateRecommendations reads the buffer override).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { generateRecommendations } from '../src/recommender.ts';
import { autocompactTrigger, AUTOCOMPACT_BUFFER_TOKENS } from '../src/model-context.ts';
import type { ClassifiedMessage, ConfigData, CrustsBreakdown } from '../src/types.ts';

/** Minimal classified rows so per-message averages are computable. */
function rows(n: number): ClassifiedMessage[] {
  const out: ClassifiedMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      index: i,
      category: i % 2 === 0 ? 'user' : 'conversation',
      tokens: 100,
      cumulativeTokens: (i + 1) * 100,
      accuracy: 'estimated',
      contentPreview: `msg ${i}`,
    });
  }
  return out;
}

/** Breakdown fixture at an absolute token level on a given window. */
function breakdownTokens(totalTokens: number, contextLimit: number, msgCount: number): CrustsBreakdown {
  return {
    buckets: [],
    total_tokens: totalTokens,
    context_limit: contextLimit,
    free_tokens: Math.max(0, contextLimit - totalTokens),
    usage_percentage: (totalTokens / contextLimit) * 100,
    messages: rows(msgCount),
    toolBreakdown: {
      loadedTools: [], usedTools: [], unusedTools: [],
      schemaTokens: 0, callTokens: 0, resultTokens: 0,
      coreSchemaTokens: 0, coreSchemaSource: 'legacy',
      deferredBuiltIn: [], deferredMcp: [], loadedDeferred: [], loadedSchemaTokens: 0,
    },
    model: 'claude-opus-4-7',
    durationSeconds: null,
    compactionEvents: [],
    configOverhead: { systemPrompt: 0, memoryFiles: 0, mcpSchemas: 0, builtInTools: 0, skills: 0 },
    totalMessages: msgCount,
    derivedOverhead: { internalSystemPrompt: null, messageFraming: null },
  } as CrustsBreakdown;
}

function emptyConfig(): ConfigData {
  return {
    systemPrompt: { files: [], totalEstimatedTokens: 0 },
    mcpServers: [],
    memoryFiles: { files: [], totalEstimatedTokens: 0 },
    builtInTools: { tools: [], totalEstimatedTokens: 0 },
    skills: { items: [], totalEstimatedTokens: 0 },
  };
}

describe('autocompactTrigger', () => {
  test('200K window triggers at 167,000', () => {
    expect(autocompactTrigger(200_000)).toBe(167_000);
  });

  test('1M window triggers at 967,000', () => {
    expect(autocompactTrigger(1_000_000)).toBe(967_000);
  });

  test('custom buffer is honoured', () => {
    expect(autocompactTrigger(200_000, 50_000)).toBe(150_000);
  });

  test('tiny windows clamp at zero instead of going negative', () => {
    expect(autocompactTrigger(10_000, AUTOCOMPACT_BUFFER_TOKENS)).toBe(0);
  });
});

describe('compaction prediction uses the headroom buffer, not 80% (sandboxed)', () => {
  let sandbox: string;
  let savedOverride: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'crusts-recommender-'));
    savedOverride = process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
    process.env.CRUSTS_CONFIG_DIR_OVERRIDE = sandbox;
  });

  afterEach(() => {
    if (savedOverride === undefined) {
      delete process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
    } else {
      process.env.CRUSTS_CONFIG_DIR_OVERRIDE = savedOverride;
    }
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('1M session at 700K reports messages remaining against the 967K trigger, not PAST', () => {
    // 20 messages, avg 35K each: (967,000 - 700,000) / 35,000 = 7 messages
    // left. Under the old 80% model the trigger was 800,000 and this
    // session looked 2 messages from compaction.
    const bd = breakdownTokens(700_000, 1_000_000, 20);
    const report = generateRecommendations(bd, [], emptyConfig(), []);

    expect(report.estimated_messages_until_compaction).toBe(7);
    const past = report.recommendations.find((r) => r.action.includes('PAST'));
    expect(past).toBeUndefined();
    const soon = report.recommendations.find((r) => r.action.includes('until auto-compaction'));
    expect(soon).toBeDefined();
    expect(soon!.action).toContain('~7 messages');
    expect(soon!.reason).toContain('967,000');
  });

  test('200K session at 168K is PAST the 167,000 trigger', () => {
    // 168,000 >= autocompactTrigger(200,000): compaction is imminent.
    const bd = breakdownTokens(168_000, 200_000, 20);
    const report = generateRecommendations(bd, [], emptyConfig(), []);

    expect(report.estimated_messages_until_compaction).toBe(0);
    const past = report.recommendations.find((r) => r.action.includes('PAST'));
    expect(past).toBeDefined();
    expect(past!.priority).toBe(1);
    expect(past!.reason).toContain('167,000');
    expect(past!.reason).toContain('headroom');
  });

  test('autocompactBufferTokens config override moves the trigger', () => {
    // 160K on 200K with the default 33K buffer: trigger 167,000, still 1
    // message of runway (40 msgs, avg 4K). With a 50K buffer override the
    // trigger drops to 150,000 and the same session is PAST.
    const bd = breakdownTokens(160_000, 200_000, 40);

    const before = generateRecommendations(bd, [], emptyConfig(), []);
    expect(before.recommendations.find((r) => r.action.includes('PAST'))).toBeUndefined();
    expect(before.estimated_messages_until_compaction).toBe(1);

    writeFileSync(join(sandbox, 'config.json'), JSON.stringify({ autocompactBufferTokens: 50_000 }), 'utf-8');
    const after = generateRecommendations(bd, [], emptyConfig(), []);
    const past = after.recommendations.find((r) => r.action.includes('PAST'));
    expect(past).toBeDefined();
    expect(past!.reason).toContain('150,000');
    expect(after.estimated_messages_until_compaction).toBe(0);
  });

  test('no recommendation text claims a flat 80% trigger any more', () => {
    const levels = [breakdownTokens(168_000, 200_000, 20), breakdownTokens(700_000, 1_000_000, 20)];
    for (const bd of levels) {
      const report = generateRecommendations(bd, [], emptyConfig(), []);
      for (const rec of report.recommendations) {
        expect(rec.reason).not.toContain('80%');
        expect(rec.action).not.toContain('80%');
      }
    }
  });
});
