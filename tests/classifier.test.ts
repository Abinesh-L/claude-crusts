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
    // 2 + 20_000 + 10_000 = 30_002 effective; known = 20_500 (core schema
    // for the fixture's 2.1.239 version, M6) + 476 (skills fallback) + first
    // user message, so derived lands inside the current 1K-15K band.
    const b = classifySession([
      userText('hi'),
      currentShapeAssistant({
        input_tokens: 2,
        cache_creation_input_tokens: 20_000,
        cache_read_input_tokens: 10_000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20_000 },
      }),
    ], EMPTY_CONFIG);
    const derived = b.derivedOverhead!.internalSystemPrompt;
    expect(derived).not.toBeNull();
    expect(derived!.derivation.firstAssistantInputTokens).toBe(30_002);
    expect(derived!.derivation.knownToolSchemas).toBe(20_500);
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

// ---------------------------------------------------------------------------
// M6: built-in tool catalogue, ToolSearch-loaded deferred tools, PowerShell
// self-call trimming, version-keyed core schema cost
// ---------------------------------------------------------------------------

/** Assistant record carrying one tool_use block and no usage (estimated from content). */
function toolUse(name: string, id: string, input: Record<string, unknown>): SessionMessage {
  return {
    type: 'assistant',
    uuid: `a-${id}`,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  } as SessionMessage;
}

/** User record carrying one tool_result block (string or nested blocks). */
function toolResult(
  toolUseId: string,
  content: string | ContentBlock[],
  extra: Partial<SessionMessage> = {},
): SessionMessage {
  return {
    type: 'user',
    uuid: `u-${toolUseId}`,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
    ...extra,
  } as SessionMessage;
}

/** A real-shaped ToolSearch load: tool_reference blocks plus the structured toolUseResult copy. */
function toolSearchLoad(id: string, names: string[], totalDeferred = 87): [SessionMessage, SessionMessage] {
  return [
    toolUse('ToolSearch', id, { query: `select:${names.join(',')}`, max_results: names.length }),
    toolResult(
      id,
      names.map((tool_name) => ({ type: 'tool_reference', tool_name }) as ContentBlock),
      { toolUseResult: { matches: names, query: `select:${names.join(',')}`, total_deferred_tools: totalDeferred } },
    ),
  ];
}

/** A `deferred_tools_delta` attachment record as Claude Code writes it. */
function deferredDelta(
  addedNames: string[],
  removedNames: string[] = [],
  readdedNames: string[] = [],
): SessionMessage {
  return {
    type: 'attachment',
    uuid: `att-${addedNames.length}-${removedNames.length}`,
    attachment: {
      type: 'deferred_tools_delta',
      addedNames,
      addedLines: addedNames,
      removedNames,
      readdedNames,
      pendingMcpServers: [],
    },
  } as SessionMessage;
}

const CRUSTS_OUTPUT = 'CRUSTS Context Window Analysis\n  TOTAL 12,000 tokens\n  Context health: healthy';

describe('M6 PowerShell CRUSTS self-calls are trimmed like Bash ones', () => {
  const base = [userText('hello'), assistant(1_000)];

  test('a PowerShell claude-crusts call, its result, and the triggering prompt are cut', () => {
    const powershell = [
      userText('run crusts'),
      toolUse('PowerShell', 'ps1', { command: 'bunx claude-crusts analyze --json' }),
      toolResult('ps1', CRUSTS_OUTPUT, { toolUseResult: { stdout: CRUSTS_OUTPUT, stderr: '' } }),
    ];
    const b = classifySession([...base, ...powershell], EMPTY_CONFIG);
    expect(b.messages.length).toBe(base.length);
    expect(b.toolBreakdown.usedTools).not.toContain('PowerShell');
  });

  test('Bash and PowerShell self-calls trim to the same cutoff', () => {
    const viaBash = classifySession([
      ...base, userText('run crusts'),
      toolUse('Bash', 'b1', { command: 'npx claude-crusts analyze' }),
      toolResult('b1', CRUSTS_OUTPUT),
    ], EMPTY_CONFIG);
    const viaPowerShell = classifySession([
      ...base, userText('run crusts'),
      toolUse('PowerShell', 'p1', { command: 'npx claude-crusts analyze' }),
      toolResult('p1', CRUSTS_OUTPUT),
    ], EMPTY_CONFIG);
    expect(viaPowerShell.messages.length).toBe(viaBash.messages.length);
    expect(viaPowerShell.messages.length).toBe(base.length);
  });

  test('a PowerShell call that is not a CRUSTS invocation is kept', () => {
    const msgs = [
      ...base, userText('list files'),
      toolUse('PowerShell', 'p2', { command: 'Get-ChildItem -Recurse' }),
      toolResult('p2', 'a.ts\nb.ts'),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.messages.length).toBe(msgs.length);
    expect(b.toolBreakdown.usedTools).toContain('PowerShell');
  });
});

describe('M6 ToolSearch-loaded deferred tools', () => {
  const DEFERRED = [
    'WebSearch', 'WebFetch', 'Monitor', 'CronCreate',
    'mcp__playwright__browser_click', 'mcp__playwright__browser_snapshot',
  ];

  /** Session: deferred pool announced, two loads (one repeat), WebSearch + PowerShell used. */
  function fixture(): SessionMessage[] {
    const [search1, result1] = toolSearchLoad('ts1', ['WebSearch', 'WebFetch']);
    const [search2, result2] = toolSearchLoad('ts2', ['mcp__playwright__browser_snapshot', 'WebSearch'], 85);
    return [
      deferredDelta(DEFERRED),
      userText('look this up'),
      search1,
      result1,
      toolUse('WebSearch', 'ws1', { query: 'claude code context window' }),
      toolResult('ws1', 'Result: the window is 200K or 1M.'),
      toolUse('PowerShell', 'ps1', { command: 'Get-Date' }),
      toolResult('ps1', 'Saturday'),
      search2,
      result2,
      toolUse('mcp__playwright__browser_snapshot', 'snap1', {}),
      toolResult('snap1', '- document\n  - heading "Home"'),
    ];
  }

  test('loadedDeferred lists each loaded name once, in first-load order', () => {
    const b = classifySession(fixture(), EMPTY_CONFIG);
    expect(b.toolBreakdown.loadedDeferred).toEqual(['WebSearch', 'WebFetch', 'mcp__playwright__browser_snapshot']);
    expect(b.toolBreakdown.totalDeferredReported).toBe(85);
  });

  test('loadedTools = core + used-without-ToolSearch + loaded; unused excludes unloaded deferred names', () => {
    const config: ConfigData = {
      ...EMPTY_CONFIG,
      builtInTools: { tools: ['Read', 'Bash', 'ToolSearch'], totalEstimatedTokens: 0 },
    };
    const b = classifySession(fixture(), config);
    const tb = b.toolBreakdown;
    for (const name of ['Read', 'Bash', 'ToolSearch', 'PowerShell', 'WebSearch', 'WebFetch', 'mcp__playwright__browser_snapshot']) {
      expect(tb.loadedTools).toContain(name);
    }
    // Deferred but never loaded: cost 0, never "loaded", never "unused"
    for (const name of ['Monitor', 'CronCreate', 'mcp__playwright__browser_click']) {
      expect(tb.loadedTools).not.toContain(name);
      expect(tb.unusedTools).not.toContain(name);
    }
    expect(tb.unusedTools).toContain('WebFetch');
    expect(tb.unusedTools).toContain('Read');
    expect(tb.unusedTools).toContain('Bash');
    expect(tb.unusedTools).not.toContain('PowerShell');
    expect(tb.unusedTools).not.toContain('WebSearch');
    expect(tb.unusedTools).not.toContain('ToolSearch');
    expect(new Set(tb.loadedTools).size).toBe(tb.loadedTools.length);
  });

  test('deferredBuiltIn / deferredMcp come from deferred_tools_delta records and honour removals', () => {
    const msgs = [
      ...fixture(),
      deferredDelta(['EndConversation'], ['CronCreate', 'mcp__playwright__browser_click'], ['Monitor']),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.toolBreakdown.deferredBuiltIn).toEqual(['WebSearch', 'WebFetch', 'Monitor', 'EndConversation']);
    expect(b.toolBreakdown.deferredMcp).toEqual(['mcp__playwright__browser_snapshot']);
  });

  test('a session without deferred_tools_delta records reports empty deferred lists, not a crash', () => {
    const b = classifySession([userText('hi'), assistant(1_000)], EMPTY_CONFIG);
    expect(b.toolBreakdown.deferredBuiltIn).toEqual([]);
    expect(b.toolBreakdown.deferredMcp).toEqual([]);
    expect(b.toolBreakdown.loadedDeferred).toEqual([]);
    expect(b.toolBreakdown.loadedSchemaTokens).toBe(0);
    expect(b.toolBreakdown.totalDeferredReported).toBeUndefined();
  });

  test('each load is charged once at the ToolSearch result index: 1,000 per built-in, 330 per MCP tool', () => {
    const msgs = fixture();
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.toolBreakdown.loadedSchemaTokens).toBe(2_330);
    expect(b.toolBreakdown.schemaTokens).toBe(2_330);

    const firstResult = b.messages[3]!;
    const secondResult = b.messages[9]!;
    expect(firstResult.category).toBe('tools');
    expect(firstResult.accuracy).toBe('estimated');
    expect(firstResult.tokens).toBeGreaterThanOrEqual(2_000);
    expect(firstResult.tokens).toBeLessThan(2_100);
    // Second load: browser_snapshot is new (330), WebSearch is a repeat (0)
    expect(secondResult.tokens).toBeGreaterThanOrEqual(330);
    expect(secondResult.tokens).toBeLessThan(430);

    const toolsBucket = b.buckets.find((x) => x.category === 'tools')!;
    const toolsFromMessages = b.messages
      .filter((m) => m.category === 'tools')
      .reduce((sum, m) => sum + m.tokens, 0);
    expect(toolsBucket.tokens).toBe(toolsFromMessages);
    expect(toolsBucket.tokens).toBeGreaterThanOrEqual(2_330);
  });

  test('falls back to tool_reference blocks when the structured toolUseResult copy is missing', () => {
    const msgs = [
      userText('load'),
      toolUse('ToolSearch', 'ts9', { query: 'select:Monitor' }),
      toolResult('ts9', [{ type: 'tool_reference', tool_name: 'Monitor' } as ContentBlock]),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.toolBreakdown.loadedDeferred).toEqual(['Monitor']);
    expect(b.toolBreakdown.loadedSchemaTokens).toBe(1_000);
    expect(b.toolBreakdown.loadedTools).toContain('Monitor');
    expect(b.toolBreakdown.unusedTools).toContain('Monitor');
  });

  test('a ToolSearch miss (No matching deferred tools found) loads nothing', () => {
    const msgs = [
      userText('load'),
      toolUse('ToolSearch', 'ts8', { query: 'select:Nope' }),
      toolResult('ts8', [{ type: 'text', text: 'No matching deferred tools found' } as ContentBlock],
        { toolUseResult: { matches: [], query: 'select:Nope', total_deferred_tools: 87 } }),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.toolBreakdown.loadedDeferred).toEqual([]);
    expect(b.toolBreakdown.loadedSchemaTokens).toBe(0);
    expect(b.toolBreakdown.totalDeferredReported).toBe(87);
  });

  test('a non-ToolSearch result whose toolUseResult happens to carry matches is not a load', () => {
    const msgs = [
      userText('grep'),
      toolUse('Grep', 'g1', { pattern: 'matches' }),
      toolResult('g1', 'src/a.ts:1:matches', { toolUseResult: { matches: ['WebSearch'], total_deferred_tools: 3 } }),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.toolBreakdown.loadedDeferred).toEqual([]);
    expect(b.toolBreakdown.loadedSchemaTokens).toBe(0);
  });

  test('configured MCP server names are not listed as tools', () => {
    const config: ConfigData = {
      ...EMPTY_CONFIG,
      mcpServers: [{ name: 'playwright', source: 'global', estimatedSchemaTokens: 0, toolCount: 0 } as ConfigData['mcpServers'][number]],
    };
    const b = classifySession(fixture(), config);
    expect(b.toolBreakdown.loadedTools).not.toContain('playwright');
    expect(b.toolBreakdown.unusedTools).not.toContain('playwright');
  });
});

describe('M6 core schema cost: calibration override > version table > legacy baseline', () => {
  test('a 2.1.239 session resolves 20,500 core tokens into the Tools bucket', () => {
    const b = classifySession([userText('hi'), currentShapeAssistant({}, { version: '2.1.239' })], EMPTY_CONFIG);
    expect(b.toolBreakdown.coreSchemaTokens).toBe(20_500);
    expect(b.toolBreakdown.coreSchemaSource).toBe('version');
    expect(b.toolBreakdown.schemaTokens).toBe(20_500);
    const tools = b.buckets.find((x) => x.category === 'tools')!;
    expect(tools.tokens).toBe(20_500);
    expect(tools.accuracy).toBe('estimated');
  });

  test('a 2.1.92 session keeps the scanner baseline (legacy)', () => {
    const config: ConfigData = { ...EMPTY_CONFIG, builtInTools: { tools: [], totalEstimatedTokens: 9_055 } };
    const b = classifySession([userText('hi'), currentShapeAssistant({}, { version: '2.1.92' })], config);
    expect(b.toolBreakdown.coreSchemaTokens).toBe(9_055);
    expect(b.toolBreakdown.coreSchemaSource).toBe('legacy');
  });

  test('an unversioned fixture with a zero baseline adds no core cost', () => {
    const b = classifySession([userText('hi'), assistant(1_000)], EMPTY_CONFIG);
    expect(b.toolBreakdown.coreSchemaTokens).toBe(0);
    expect(b.toolBreakdown.coreSchemaSource).toBe('legacy');
    expect(b.buckets.find((x) => x.category === 'tools')!.tokens).toBe(0);
  });

  test('the calibration override wins over the version table and feeds the derivation', () => {
    const config: ConfigData = {
      ...EMPTY_CONFIG,
      builtInTools: { tools: [], totalEstimatedTokens: 0, coreSchemaOverride: 21_100 },
    };
    const b = classifySession([
      userText('hi'),
      currentShapeAssistant({
        input_tokens: 2,
        cache_creation_input_tokens: 20_000,
        cache_read_input_tokens: 10_000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20_000 },
      }, { version: '2.1.239' }),
    ], config);
    expect(b.toolBreakdown.coreSchemaTokens).toBe(21_100);
    expect(b.toolBreakdown.coreSchemaSource).toBe('calibration');
    expect(b.buckets.find((x) => x.category === 'tools')!.tokens).toBe(21_100);
    expect(b.derivedOverhead!.internalSystemPrompt!.derivation.knownToolSchemas).toBe(21_100);
  });

  test('a null override is ignored', () => {
    const config: ConfigData = {
      ...EMPTY_CONFIG,
      builtInTools: { tools: [], totalEstimatedTokens: 0, coreSchemaOverride: null },
    };
    const b = classifySession([userText('hi'), currentShapeAssistant({}, { version: '2.1.214' })], config);
    expect(b.toolBreakdown.coreSchemaTokens).toBe(20_500);
    expect(b.toolBreakdown.coreSchemaSource).toBe('version');
  });

  test('the same core cost is applied to the post-compaction window', () => {
    const msgs: SessionMessage[] = [
      userText('hi'),
      currentShapeAssistant({ input_tokens: 2, cache_creation_input_tokens: 150_000, cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 150_000 } }, { version: '2.1.239' }),
      compactBoundary(150_000),
      userText('after'),
      currentShapeAssistant({ input_tokens: 2, cache_creation_input_tokens: 30_000, cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 30_000 } }, { version: '2.1.239' }),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.compactionEvents.length).toBe(1);
    const currentTools = b.currentContext!.buckets.find((x) => x.category === 'tools')!;
    expect(currentTools.tokens).toBe(20_500);
  });
});
