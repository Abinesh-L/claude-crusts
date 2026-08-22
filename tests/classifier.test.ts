import { describe, test, expect } from 'bun:test';
import { classifySession, detectCompactionEvents, IMAGE_BLOCK_TOKENS } from '../src/classifier.ts';
import type { SessionMessage, ConfigData, TokenUsage, ContentBlock } from '../src/types.ts';

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

// ---------------------------------------------------------------------------
// v0.8.0 M4 — usage drift, block estimation, claudeCodeVersion
// ---------------------------------------------------------------------------

/**
 * Assistant record in the exact shape Claude Code 2.1.239 writes: split-line
 * metadata (requestId, message.id, version) plus the nested usage fields
 * (cache_creation, iterations[], output_tokens_details, server_tool_use).
 */
function currentShapeAssistant(
  usageOverrides: Partial<TokenUsage> = {},
  extra: { version?: string; content?: ContentBlock[] } = {},
): SessionMessage {
  const usage: TokenUsage = {
    input_tokens: 2,
    cache_creation_input_tokens: 18_938,
    cache_read_input_tokens: 35_299,
    output_tokens: 447,
    output_tokens_details: { thinking_tokens: 54 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    cache_creation: { ephemeral_1h_input_tokens: 18_938, ephemeral_5m_input_tokens: 0 },
    iterations: [{
      input_tokens: 2,
      output_tokens: 447,
      cache_read_input_tokens: 35_299,
      cache_creation_input_tokens: 18_938,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 18_938 },
      type: 'message',
    }],
    ...usageOverrides,
  };
  return {
    type: 'assistant',
    uuid: 'a-current',
    requestId: 'req_011CeHBPEmUFKB5rAs6EsuR1',
    version: extra.version ?? '2.1.239',
    message: {
      id: 'msg_011CeHBPHcNZYmmfxHse6wBd',
      role: 'assistant',
      model: 'claude-fable-5',
      content: extra.content ?? [{ type: 'text', text: 'ok' }],
      usage,
    },
  } as SessionMessage;
}

/** Nested-only usage: flat cache_creation 0, all tokens under ephemeral_1h. */
function nestedOnlyAssistant(tokens: number): SessionMessage {
  return currentShapeAssistant({
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: tokens },
  });
}

describe('M4 usage drift: nested cache_creation and current usage shape', () => {
  test('2.1.239 usage shape (iterations[], output_tokens_details, nested cache_creation) parses and total_tokens is the effective input', () => {
    const b = classifySession([userText('hi'), currentShapeAssistant()], EMPTY_CONFIG);
    expect(b.total_tokens).toBe(54_239);
    expect(b.model).toBe('claude-fable-5');
    expect(b.modelHistory!.segments[0]!.cacheCreationTokens).toBe(18_938);
    expect(Number.isFinite(b.usage_percentage)).toBe(true);
  });

  test('flat cache_creation 0 with ephemeral_1h 815,917 gives total_tokens 815,917 and a 1M window via the usage signal', () => {
    const b = classifySession([userText('hi'), nestedOnlyAssistant(815_917)], EMPTY_CONFIG);
    expect(b.total_tokens).toBe(815_917);
    expect(b.context_limit).toBe(1_000_000);
    expect(b.usage_percentage).toBeLessThan(100);
    expect(b.modelHistory!.segments[0]!.cacheCreationTokens).toBe(815_917);
  });

  test('compaction tokensAfter honours nested cache_creation when the flat field is 0', () => {
    const msgs: SessionMessage[] = [
      assistant(120_000),
      compactBoundary(150_000),
      nestedOnlyAssistant(30_000),
    ];
    const events = detectCompactionEvents(msgs);
    expect(events.length).toBe(1);
    expect(events[0]!.tokensAfter).toBe(30_000);
    expect(events[0]!.afterIndex).toBe(2);
  });

  test('heuristic compaction detection uses the reconciled effective input', () => {
    const events = detectCompactionEvents([nestedOnlyAssistant(160_000), nestedOnlyAssistant(20_000)]);
    expect(events.length).toBe(1);
    expect(events[0]!.detection).toBe('heuristic');
    expect(events[0]!.tokensBefore).toBe(160_000);
    expect(events[0]!.tokensAfter).toBe(20_000);
  });

  test('derived internal system prompt reads the first turn with non-zero effective input (input_tokens 2)', () => {
    // 2 + 8_000 + 4_000 = 12_002 effective; known = 476 (skills fallback) +
    // first user message, so derived lands inside the current 1K-15K band.
    const b = classifySession([
      userText('hi'),
      currentShapeAssistant({
        input_tokens: 2,
        cache_creation_input_tokens: 8_000,
        cache_read_input_tokens: 4_000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 8_000 },
      }),
    ], EMPTY_CONFIG);
    const derived = b.derivedOverhead!.internalSystemPrompt;
    expect(derived).not.toBeNull();
    expect(derived!.derivation.firstAssistantInputTokens).toBe(12_002);
  });

  test('cache-overhead waste rule sees nested cache_read ratio through the same helper', () => {
    // Sanity: nested-only usage must not produce NaN ratios downstream.
    const b = classifySession([userText('hi'), nestedOnlyAssistant(50_000)], EMPTY_CONFIG);
    expect(Number.isFinite(b.free_tokens)).toBe(true);
    expect(b.free_tokens).toBe(150_000);
  });
});

describe('M4 block estimation: signatures, images, documents', () => {
  test('signature-only thinking line with output_tokens 0 estimates 0 tokens', () => {
    const thinkingOnly = currentShapeAssistant(
      { output_tokens: 0 },
      { content: [{ type: 'thinking', thinking: '', signature: 'E'.repeat(14_000) }] },
    );
    const b = classifySession([userText('hi'), thinkingOnly], EMPTY_CONFIG);
    expect(b.messages[1]!.tokens).toBe(0);
    expect(b.messages[1]!.accuracy).toBe('estimated');
  });

  test('thinking text itself is still counted when present', () => {
    const withText = currentShapeAssistant(
      { output_tokens: 0 },
      { content: [{ type: 'thinking', thinking: 'plain words '.repeat(100), signature: 'E'.repeat(14_000) }] },
    );
    const b = classifySession([userText('hi'), withText], EMPTY_CONFIG);
    // 1,200 chars of prose at 4.0 chars/token
    expect(b.messages[1]!.tokens).toBe(300);
  });

  test('image block nested in a tool_result costs a flat IMAGE_BLOCK_TOKENS', () => {
    const screenshot: SessionMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(400_000) } }],
        }],
      },
    } as SessionMessage;
    const b = classifySession([userText('hi'), screenshot], EMPTY_CONFIG);
    const tokens = b.messages[1]!.tokens;
    expect(IMAGE_BLOCK_TOKENS).toBe(1_500);
    // Flat image cost plus the tool_use_id metadata chars; never the 100K a base64 char count would give
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_BLOCK_TOKENS);
    expect(tokens).toBeLessThan(IMAGE_BLOCK_TOKENS + 50);
  });

  test('top-level image block in a user message costs IMAGE_BLOCK_TOKENS exactly', () => {
    const pasted: SessionMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'B'.repeat(50_000) } }],
      },
    } as SessionMessage;
    const b = classifySession([userText('hi'), pasted], EMPTY_CONFIG);
    expect(b.messages[1]!.tokens).toBe(IMAGE_BLOCK_TOKENS);
  });

  test('document block costs base64 length / 4 and 0 when no data is present', () => {
    const pdf: SessionMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'C'.repeat(40_000) } }],
      },
    } as SessionMessage;
    const empty: SessionMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'document', source: { type: 'url' } }] },
    } as SessionMessage;
    const b = classifySession([userText('hi'), pdf, empty], EMPTY_CONFIG);
    expect(b.messages[1]!.tokens).toBe(10_000);
    expect(b.messages[2]!.tokens).toBe(0);
  });

  test('nested sub-blocks keep their own estimate instead of being re-divided by the parent divisor', () => {
    const result: SessionMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_22',
          content: [{ type: 'text', text: 'plain words '.repeat(100) }],
        }],
      },
    } as SessionMessage;
    const b = classifySession([userText('hi'), result], EMPTY_CONFIG);
    // 1,200 prose chars / 4.0 = 300, plus ceil('toolu_22'.length / 4) = 2
    expect(b.messages[1]!.tokens).toBe(302);
  });
});

describe('M4 claudeCodeVersion on the breakdown', () => {
  test('exposes the first non-empty version across the analysed records', () => {
    const b = classifySession([
      userText('hi'),
      { ...userText('again'), version: '' } as SessionMessage,
      currentShapeAssistant({}, { version: '2.1.239' }),
      currentShapeAssistant({}, { version: '2.1.240' }),
    ], EMPTY_CONFIG);
    expect(b.claudeCodeVersion).toBe('2.1.239');
  });

  test('is undefined when no record carries a version', () => {
    const b = classifySession([userText('hi'), assistant(1_000)], EMPTY_CONFIG);
    expect(b.claudeCodeVersion).toBeUndefined();
  });
});
