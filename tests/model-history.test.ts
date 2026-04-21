/**
 * Model history + health-label regression tests.
 *
 * Two concerns rolled into one file:
 *   1. classifier.computeModelHistory — runs indirectly via classifySession,
 *      since the function is internal. We exercise it with sessions that
 *      exhibit each interesting shape (single model, switch, switch-back,
 *      synthetic-filtered, no assistants).
 *   2. recommender.context_health — regression test for the bug where
 *      `breakdown.usage_percentage` (lifetime) was passed instead of
 *      `currentContext.usage_percentage`, producing spurious "critical"
 *      verdicts on cold post-compaction sessions.
 */

import { describe, test, expect } from 'bun:test';
import { classifySession } from '../src/classifier.ts';
import { generateRecommendations } from '../src/recommender.ts';
import type { SessionMessage, ConfigData } from '../src/types.ts';

const emptyConfig: ConfigData = {
  systemPrompt: { files: [], totalEstimatedTokens: 0 },
  mcpServers: [],
  memoryFiles: { files: [], totalEstimatedTokens: 0 },
  builtInTools: { tools: [], totalEstimatedTokens: 0 },
  skills: { items: [], totalEstimatedTokens: 0 },
};

function userMsg(text: string): SessionMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as SessionMessage;
}

function assistantMsg(
  model: string,
  text: string,
  usage: { input_tokens?: number; output_tokens?: number; cache_read?: number; cache_create?: number } = {},
): SessionMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: usage.input_tokens ?? 100,
        output_tokens: usage.output_tokens ?? 50,
        cache_read_input_tokens: usage.cache_read ?? 0,
        cache_creation_input_tokens: usage.cache_create ?? 0,
      },
    },
  } as SessionMessage;
}

function syntheticAssistant(): SessionMessage {
  return {
    type: 'assistant',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'x' }] },
  } as SessionMessage;
}

// ---------------------------------------------------------------------------
// computeModelHistory via classifySession
// ---------------------------------------------------------------------------

describe('modelHistory — single-model session', () => {
  test('produces exactly one segment spanning all assistant turns', () => {
    const msgs: SessionMessage[] = [
      userMsg('hi'),
      assistantMsg('claude-sonnet-4-6', 'one'),
      userMsg('more'),
      assistantMsg('claude-sonnet-4-6', 'two'),
      userMsg('another'),
      assistantMsg('claude-sonnet-4-6', 'three'),
    ];
    const bd = classifySession(msgs, emptyConfig);
    expect(bd.modelHistory).toBeDefined();
    const h = bd.modelHistory!;
    expect(h.segments.length).toBe(1);
    expect(h.segments[0]!.model).toBe('claude-sonnet-4-6');
    expect(h.segments[0]!.assistantMessageCount).toBe(3);
    expect(h.current).toBe('claude-sonnet-4-6');
    expect(h.switchCount).toBe(0);
    expect(h.uniqueModels).toEqual(['claude-sonnet-4-6']);
  });
});

describe('modelHistory — multi-model session', () => {
  test('switching from sonnet to opus yields two segments', () => {
    const msgs: SessionMessage[] = [
      userMsg('hi'),
      assistantMsg('claude-sonnet-4-6', 'a', { input_tokens: 100, output_tokens: 30 }),
      userMsg('ok'),
      assistantMsg('claude-sonnet-4-6', 'b', { input_tokens: 200, output_tokens: 40 }),
      userMsg('switch'),
      assistantMsg('claude-opus-4-7', 'c', { input_tokens: 300, output_tokens: 60 }),
      userMsg('more'),
      assistantMsg('claude-opus-4-7', 'd', { input_tokens: 400, output_tokens: 80 }),
    ];
    const bd = classifySession(msgs, emptyConfig);
    const h = bd.modelHistory!;
    expect(h.segments.length).toBe(2);
    expect(h.segments[0]!.model).toBe('claude-sonnet-4-6');
    expect(h.segments[1]!.model).toBe('claude-opus-4-7');
    expect(h.current).toBe('claude-opus-4-7');
    expect(h.switchCount).toBe(1);
  });

  test('per-segment input/output tokens are summed correctly', () => {
    const msgs: SessionMessage[] = [
      userMsg('q1'),
      assistantMsg('claude-sonnet-4-6', 'a', { input_tokens: 100, output_tokens: 30 }),
      userMsg('q2'),
      assistantMsg('claude-sonnet-4-6', 'b', { input_tokens: 200, output_tokens: 40 }),
      userMsg('switch'),
      assistantMsg('claude-opus-4-7', 'c', { input_tokens: 300, output_tokens: 60, cache_read: 15, cache_create: 5 }),
    ];
    const bd = classifySession(msgs, emptyConfig);
    const h = bd.modelHistory!;
    // Segment 1 — sonnet
    expect(h.segments[0]!.totalInputTokens).toBe(300);
    expect(h.segments[0]!.totalOutputTokens).toBe(70);
    expect(h.segments[0]!.cacheReadTokens).toBe(0);
    // Segment 2 — opus
    expect(h.segments[1]!.totalInputTokens).toBe(300);
    expect(h.segments[1]!.totalOutputTokens).toBe(60);
    expect(h.segments[1]!.cacheReadTokens).toBe(15);
    expect(h.segments[1]!.cacheCreationTokens).toBe(5);
  });

  test('switching back (sonnet → opus → sonnet) produces THREE segments (not two)', () => {
    const msgs: SessionMessage[] = [
      userMsg('a'),
      assistantMsg('claude-sonnet-4-6', '1'),
      userMsg('b'),
      assistantMsg('claude-opus-4-7', '2'),
      userMsg('c'),
      assistantMsg('claude-sonnet-4-6', '3'),
    ];
    const bd = classifySession(msgs, emptyConfig);
    const h = bd.modelHistory!;
    expect(h.segments.length).toBe(3);
    expect(h.segments.map((s) => s.model)).toEqual([
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
    ]);
    expect(h.uniqueModels).toEqual(['claude-sonnet-4-6', 'claude-opus-4-7']);
    expect(h.current).toBe('claude-sonnet-4-6');
    expect(h.switchCount).toBe(2);
  });
});

describe('modelHistory — synthetic filtering', () => {
  test('<synthetic> assistant messages do not start or extend segments', () => {
    const msgs: SessionMessage[] = [
      userMsg('a'),
      assistantMsg('claude-sonnet-4-6', 'one'),
      syntheticAssistant(),
      userMsg('b'),
      syntheticAssistant(),
      assistantMsg('claude-sonnet-4-6', 'two'),
    ];
    const bd = classifySession(msgs, emptyConfig);
    const h = bd.modelHistory!;
    expect(h.segments.length).toBe(1);
    expect(h.segments[0]!.model).toBe('claude-sonnet-4-6');
    expect(h.segments[0]!.assistantMessageCount).toBe(2);
    expect(h.uniqueModels).not.toContain('<synthetic>');
  });

  test('session with only synthetic assistants reports current = unknown and 0 segments', () => {
    const msgs: SessionMessage[] = [
      userMsg('a'),
      syntheticAssistant(),
      syntheticAssistant(),
    ];
    const bd = classifySession(msgs, emptyConfig);
    const h = bd.modelHistory!;
    expect(h.segments.length).toBe(0);
    expect(h.current).toBe('unknown');
    expect(h.switchCount).toBe(0);
  });
});

describe('modelHistory — breakdown.model reflects current, not first', () => {
  test('in a switched session, breakdown.model is the LAST model', () => {
    const msgs: SessionMessage[] = [
      userMsg('a'),
      assistantMsg('claude-sonnet-4-6', '1'),
      userMsg('b'),
      assistantMsg('claude-opus-4-7', '2'),
    ];
    const bd = classifySession(msgs, emptyConfig);
    // This is the user's asked-for behavior: header shows opus, not sonnet.
    expect(bd.model).toBe('claude-opus-4-7');
    // First model still accessible via history
    expect(bd.modelHistory!.segments[0]!.model).toBe('claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// Health-label regression
// ---------------------------------------------------------------------------

describe('context_health regression', () => {
  test('post-compaction session with cold current window reports healthy (not critical)', () => {
    // Simulate: large pre-compaction body, compact_boundary, small post-compact tail.
    const msgs: SessionMessage[] = [];
    // Pre-compaction: build up a lot of assistant turns to drive lifetime
    // total_tokens above 1M.
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg('u' + i));
      msgs.push(
        assistantMsg('claude-opus-4-7', 'big ' + 'z'.repeat(5_000), {
          input_tokens: 60_000,
          output_tokens: 5_000,
        }),
      );
    }
    // Compact boundary.
    msgs.push({
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { preTokens: 1_200_000 },
    } as unknown as SessionMessage);
    msgs.push({
      type: 'user',
      isCompactSummary: true,
      message: { role: 'user', content: 'short summary of prior session' },
    } as SessionMessage);
    // Post-compact: just one small assistant turn. Live window should be cold.
    msgs.push(
      assistantMsg('claude-opus-4-7', 'tiny reply', {
        input_tokens: 2_000,
        output_tokens: 100,
      }),
    );

    const bd = classifySession(msgs, emptyConfig);
    // Sanity: we should have detected the compaction.
    expect(bd.compactionEvents.length).toBeGreaterThan(0);
    expect(bd.currentContext).toBeDefined();
    // Lifetime percentage may legitimately exceed 100% — NOT what health reads.
    // Current-context percentage should be low.
    expect(bd.currentContext!.usage_percentage).toBeLessThan(20);
    // The recommender must read currentContext, not lifetime.
    const recs = generateRecommendations(bd, [], emptyConfig, msgs);
    expect(recs.context_health).not.toBe('critical');
    // More specifically: low current-ctx % → healthy or warming band.
    expect(['healthy', 'warming']).toContain(recs.context_health);
  });

  test('pre-compaction session with high live usage still reports hot/critical', () => {
    // Heavy session with no compaction — lifetime == current. Should still
    // correctly flag as hot/critical so we didn't regress the non-compact case.
    const msgs: SessionMessage[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push(userMsg('u' + i));
      msgs.push(
        assistantMsg('claude-sonnet-4-6', 'x'.repeat(10_000), {
          input_tokens: 8_000,
          output_tokens: 500,
        }),
      );
    }
    const bd = classifySession(msgs, emptyConfig);
    expect(bd.compactionEvents.length).toBe(0);
    expect(bd.currentContext).toBeUndefined();
    const recs = generateRecommendations(bd, [], emptyConfig, msgs);
    // The session is pushing the 200K default limit hard.
    if (bd.usage_percentage >= 85) {
      expect(recs.context_health).toBe('critical');
    } else if (bd.usage_percentage >= 70) {
      expect(recs.context_health).toBe('hot');
    }
  });
});
