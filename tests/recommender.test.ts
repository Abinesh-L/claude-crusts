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
import type { ClassifiedMessage, CompactionEvent, ConfigData, CrustsBreakdown } from '../src/types.ts';

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

// ---------------------------------------------------------------------------
// M17: the "start fresh sessions" habit counts only AUTO compactions —
// deliberate /compact runs (trigger 'manual') are not a habit problem
// ---------------------------------------------------------------------------

describe('M17 session habit counts only auto compactions (sandboxed)', () => {
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

  /** Marker compaction event with a given trigger (undefined = heuristic). */
  function event(trigger?: 'auto' | 'manual'): CompactionEvent {
    return {
      beforeIndex: 0,
      afterIndex: 1,
      tokensBefore: 150_000,
      tokensAfter: 9_000,
      tokensDropped: 141_000,
      detection: trigger === undefined ? 'heuristic' : 'marker',
      trigger,
    };
  }

  const HABIT = 'Habit: use /clear between distinct tasks';

  function habitRec(events: CompactionEvent[]) {
    const bd = breakdownTokens(100_000, 200_000, 20);
    bd.compactionEvents = events;
    const report = generateRecommendations(bd, [], emptyConfig(), []);
    return report.recommendations.find((r) => r.action === HABIT);
  }

  test('a manual-only session does not emit the start-fresh habit', () => {
    expect(habitRec([event('manual'), event('manual'), event('manual')])).toBeUndefined();
  });

  test('three auto compactions emit the habit and count only the auto ones', () => {
    const rec = habitRec([event('manual'), event('auto'), event('auto'), event('auto')]);
    expect(rec).toBeDefined();
    expect(rec!.reason).toContain('3 auto-compactions');
  });

  test('two auto compactions among many manual ones stay below the bar', () => {
    expect(habitRec([
      event('auto'), event('auto'),
      event('manual'), event('manual'), event('manual'), event('manual'),
    ])).toBeUndefined();
  });

  test('heuristic events without a trigger are not counted', () => {
    expect(habitRec([event(), event(), event()])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Review fix: attachment rows are excluded from the compaction-prediction
// per-message average, so the priority recommendation and the summary
// `estimated_messages_until_compaction` can never disagree
// ---------------------------------------------------------------------------

describe('review fix: compaction prediction excludes attachment rows (sandboxed)', () => {
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

  /** Attachment row: real window tokens, but not a message (M11). */
  function attachmentRow(index: number, cumulative: number): ClassifiedMessage {
    return {
      index,
      category: 'system',
      tokens: 0,
      cumulativeTokens: cumulative,
      accuracy: 'estimated',
      contentPreview: '[attachment: task_reminder]',
      isAttachment: true,
    };
  }

  /** Parse "~N messages until auto-compaction" out of a recommendation. */
  function predictedMessages(report: ReturnType<typeof generateRecommendations>): number | undefined {
    const rec = report.recommendations.find((r) => r.action.includes('until auto-compaction'));
    const m = rec?.action.match(/~(\d+) messages until auto-compaction/);
    return m ? Number(m[1]) : undefined;
  }

  test('prediction recommendation and estimated_messages_until_compaction agree on a fixture with attachment rows', () => {
    // 1 real message + 2 attachment rows at 15,000 tokens on a 200K window.
    // Undiluted average: 15,000/msg -> floor((167,000 - 15,000) / 15,000)
    // = 10 messages left. The raw row count (3) diluted the average to
    // 5,000/msg and printed ~30 in the SAME dashboard that summarized ~10.
    const bd = breakdownTokens(15_000, 200_000, 1);
    bd.messages = [
      bd.messages[0]!,
      attachmentRow(1, 15_000),
      attachmentRow(2, 15_000),
    ];
    const report = generateRecommendations(bd, [], emptyConfig(), []);

    expect(report.estimated_messages_until_compaction).toBe(10);
    expect(predictedMessages(report)).toBe(10);
  });

  test('post-compaction slice with attachment rows: both counters still agree', () => {
    // currentContext at startIndex 2; the slice holds 2 real + 2 attachment
    // rows at 15,000 tokens. Undiluted: 7,500/msg -> 20 messages left.
    const bd = breakdownTokens(15_000, 200_000, 2);
    const real = bd.messages;
    bd.messages = [
      attachmentRow(0, 0), attachmentRow(1, 0),   // pre-compaction rows
      real[0]!, attachmentRow(3, 100), real[1]!, attachmentRow(5, 15_000),
    ];
    bd.compactionEvents = [{
      beforeIndex: 1, afterIndex: 2,
      tokensBefore: 150_000, tokensAfter: 15_000, tokensDropped: 135_000,
      detection: 'marker', trigger: 'auto',
    }];
    bd.currentContext = {
      buckets: [],
      total_tokens: 15_000,
      free_tokens: 185_000,
      usage_percentage: 7.5,
      startIndex: 2,
    } as CrustsBreakdown['currentContext'];

    const report = generateRecommendations(bd, [], emptyConfig(), []);
    expect(report.estimated_messages_until_compaction).toBe(20);
    expect(predictedMessages(report)).toBe(20);
  });
});
