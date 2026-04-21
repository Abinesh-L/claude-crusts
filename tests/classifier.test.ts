import { describe, test, expect } from 'bun:test';
import { classifySession, detectCompactionEvents } from '../src/classifier.ts';
import type { SessionMessage, ConfigData } from '../src/types.ts';

function assistant(inputTokens: number): SessionMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: inputTokens,
        output_tokens: 100,
      },
    },
  };
}

function compactBoundary(preTokens: number): SessionMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata: { trigger: 'auto', preTokens },
    isMeta: true,
  };
}

describe('detectCompactionEvents', () => {
  test('detects marker-based compaction from compact_boundary', () => {
    const msgs: SessionMessage[] = [
      assistant(50_000),
      assistant(120_000),
      compactBoundary(150_000),
      assistant(30_000),
      assistant(40_000),
    ];
    const events = detectCompactionEvents(msgs);
    expect(events.length).toBe(1);
    expect(events[0]!.detection).toBe('marker');
    expect(events[0]!.tokensBefore).toBe(150_000);
    expect(events[0]!.tokensAfter).toBe(30_000);
    expect(events[0]!.tokensDropped).toBe(120_000);
  });

  test('falls back to heuristic when no marker present', () => {
    const msgs: SessionMessage[] = [
      assistant(150_000),
      assistant(160_000),
      assistant(20_000),
      assistant(25_000),
    ];
    const events = detectCompactionEvents(msgs);
    expect(events.length).toBe(1);
    expect(events[0]!.detection).toBe('heuristic');
    expect(events[0]!.tokensDropped).toBeGreaterThan(30_000);
  });

  test('returns empty array when no compaction', () => {
    const msgs: SessionMessage[] = [
      assistant(10_000),
      assistant(15_000),
      assistant(20_000),
    ];
    expect(detectCompactionEvents(msgs)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bug #9 regression — total_tokens from API effective-input, not content-sum
// ---------------------------------------------------------------------------

/** Assistant message with explicit cache-read usage, for Bug #9 tests. */
function assistantWithCache(
  inputTokens: number,
  cacheRead: number,
  output = 100,
): SessionMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
      },
    },
  } as SessionMessage;
}

function userText(text: string): SessionMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as SessionMessage;
}

const EMPTY_CONFIG: ConfigData = {
  systemPrompt: { files: [], totalEstimatedTokens: 0 },
  mcpServers: [],
  memoryFiles: { files: [], totalEstimatedTokens: 0 },
  builtInTools: { tools: [], totalEstimatedTokens: 0 },
  skills: { items: [], totalEstimatedTokens: 0 },
};

describe('Bug #9 — total_tokens uses API effective input', () => {
  test('total_tokens reflects last assistant turn effective input, not content-sum', () => {
    // Content sum here is tiny (~25 tokens of "ok" text per turn). API says
    // 350K (100 input + 350,000 cache_read + small cache_creation). Without
    // the fix, displayed total_tokens was the content-sum; with the fix, it
    // must be the API number.
    const msgs: SessionMessage[] = [
      userText('first user question'),
      assistantWithCache(100, 50_000),
      userText('second question'),
      assistantWithCache(100, 350_000), // <- last turn, this is the authoritative window
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.total_tokens).toBe(100 + 0 + 350_000);
    expect(b.contentSumTokens).toBeDefined();
    expect(b.contentSumTokens).toBeLessThan(b.total_tokens);
    expect(b.usage_percentage).toBeCloseTo((350_100 / b.context_limit) * 100, 1);
  });

  test('free_tokens is clamped at zero when effective input exceeds context_limit', () => {
    // Defensive: shouldn't happen in practice (the API errors past limit)
    // but guard against negative FREE displays for any pathological case.
    // 1.5M > 1M (the 1M promotion the usage-heuristic triggers on this size)
    // so total > limit is forced regardless of model resolution.
    const msgs: SessionMessage[] = [
      userText('q'),
      assistantWithCache(10, 1_500_000),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.total_tokens).toBe(1_500_010);
    expect(b.total_tokens).toBeGreaterThan(b.context_limit);
    expect(b.free_tokens).toBe(0);
  });

  test('falls back to content-sum when no assistant turn has usage data', () => {
    // Fixtures without usage fields: behaviour unchanged from pre-Bug-#9.
    const msgs: SessionMessage[] = [
      userText('q'),
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'response' }] } } as SessionMessage,
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.contentSumTokens).toBeDefined();
    expect(b.total_tokens).toBe(b.contentSumTokens!);
  });

  test('synthetic assistant turns are skipped when picking the effective input source', () => {
    // Post-compaction summary messages carry model='<synthetic>' and no usage.
    // The classifier must walk past them to find the last REAL assistant turn.
    const msgs: SessionMessage[] = [
      userText('q1'),
      assistantWithCache(100, 50_000),
      { type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'summary' }] } } as SessionMessage,
      userText('q2'),
      assistantWithCache(200, 120_000), // This is the last REAL one — must win
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.total_tokens).toBe(120_200);
  });

  test('currentContext.total_tokens uses the last real assistant turn within the slice', () => {
    // Marker-based compaction at msg 2; post-compact slice starts at msg 3.
    // The last assistant turn (index 5) carries 800K effective input — that's
    // the slice's authoritative total, NOT the sum of per-message content.
    const msgs: SessionMessage[] = [
      userText('q1'),
      assistantWithCache(100, 150_000),
      compactBoundary(150_000),                                // index 2
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'summary' }] }, isCompactSummary: true } as SessionMessage,
      userText('q2'),
      assistantWithCache(500, 799_500),                        // index 5 — 800K effective
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.currentContext).toBeDefined();
    expect(b.currentContext!.total_tokens).toBe(800_000);
    expect(b.currentContext!.contentSumTokens).toBeDefined();
    expect(b.currentContext!.contentSumTokens).toBeLessThan(b.currentContext!.total_tokens);
  });

  test('currentContext never displays a usage_percentage above 100% when API data is present', () => {
    // The exact symptom from session 2eee1df7: even if content-sum would go
    // over context_limit (e.g. 1.74M on a 1M window), API-derived total is
    // bounded and displayed percentage stays sane.
    const msgs: SessionMessage[] = [
      userText('q0'),
      assistantWithCache(100, 100_000),
      compactBoundary(100_000),
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'summary' }] }, isCompactSummary: true } as SessionMessage,
      // Many post-compact turns with large cache reads — last one sets the tone.
      userText('q1'),
      assistantWithCache(1, 150_000),
      userText('q2'),
      assistantWithCache(1, 170_000), // last turn: 170K window
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.currentContext).toBeDefined();
    // 170K < 200K limit → ≤ 100%
    expect(b.currentContext!.usage_percentage).toBeLessThanOrEqual(100);
  });
});
