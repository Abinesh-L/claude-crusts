import { describe, test, expect } from 'bun:test';
import { classifySession, countAnalyzedMessages, detectCompactionEvents, estimateAttachmentTokens, isHumanUserText, IMAGE_BLOCK_TOKENS } from '../src/classifier.ts';
import { detectWaste } from '../src/waste-detector.ts';
import type { SessionMessage, ConfigData, TokenUsage, ContentBlock, CrustsCategory } from '../src/types.ts';

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
  test('total_tokens reflects last assistant turn effective input plus its output, not content-sum', () => {
    // Content sum here is tiny (~25 tokens of "ok" text per turn). API says
    // 350,100 effective input (100 input + 350,000 cache_read) plus the
    // turn's own output (100): that response is in the window and gets
    // re-sent on the next request (M14). Without the fix, displayed
    // total_tokens was the content-sum; with the fix it is the API number.
    const msgs: SessionMessage[] = [
      userText('first user question'),
      assistantWithCache(100, 50_000),
      userText('second question'),
      assistantWithCache(100, 350_000), // <- last turn, this is the authoritative window
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.total_tokens).toBe(100 + 0 + 350_000 + 100);
    expect(b.contentSumTokens).toBeDefined();
    expect(b.contentSumTokens).toBeLessThan(b.total_tokens);
    expect(b.usage_percentage).toBeCloseTo((350_200 / b.context_limit) * 100, 1);
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
    expect(b.total_tokens).toBe(1_500_010 + 100); // effective input + last output
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
    expect(b.total_tokens).toBe(120_200 + 100); // + the last turn's output (M14)
  });

  test('currentContext.total_tokens uses the last real assistant turn within the slice', () => {
    // Marker-based compaction at msg 2; post-compact slice starts at msg 3.
    // The last assistant turn (index 5) carries 800K effective input plus
    // its 100-token output — that's the slice's authoritative total, NOT
    // the sum of per-message content.
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
    expect(b.currentContext!.total_tokens).toBe(800_000 + 100);
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
  test('2.1.239 usage shape (iterations[], output_tokens_details, nested cache_creation) parses and total_tokens is effective input plus output', () => {
    // 2 + 18,938 cc + 35,299 cr = 54,239 effective input, + 447 output (M14).
    const b = classifySession([userText('hi'), currentShapeAssistant()], EMPTY_CONFIG);
    expect(b.total_tokens).toBe(54_686);
    expect(b.model).toBe('claude-fable-5');
    expect(b.modelHistory!.segments[0]!.cacheCreationTokens).toBe(18_938);
    expect(Number.isFinite(b.usage_percentage)).toBe(true);
  });

  test('flat cache_creation 0 with ephemeral_1h 815,917 counts the nested tokens and a 1M window via the usage signal', () => {
    // 815,917 effective input (all nested) + the fixture's 447 output (M14).
    const b = classifySession([userText('hi'), nestedOnlyAssistant(815_917)], EMPTY_CONFIG);
    expect(b.total_tokens).toBe(815_917 + 447);
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
    // The fixture model is a bare claude-fable-5, which the M13 native-1M
    // table resolves to a 1,000,000-token window. Window total = 50,000
    // effective input + 447 output (M14), so free = 1,000,000 - 50,447.
    const b = classifySession([userText('hi'), nestedOnlyAssistant(50_000)], EMPTY_CONFIG);
    expect(Number.isFinite(b.free_tokens)).toBe(true);
    expect(b.free_tokens).toBe(949_553);
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
    // Raw content accounting: `tokens` is window-reconciled since M18, the
    // unscaled component cost lives in `contentTokens`.
    expect(tools.contentTokens).toBe(20_500);
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
    // Raw content accounting (see M18): the reconciled `tokens` is scaled.
    expect(b.buckets.find((x) => x.category === 'tools')!.contentTokens).toBe(21_100);
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

// ---------------------------------------------------------------------------
// M7: human-typed user text vs machine-written user records, skill bodies
// via sourceToolUseID, STATE_TOOLS results
// ---------------------------------------------------------------------------

/** A user-role record Claude Code wrote itself (string content, as in the JSONL). */
function machineUser(content: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return {
    type: 'user',
    uuid: `m-${content.slice(0, 12)}-${Object.keys(extra).join('')}`,
    message: { role: 'user', content },
    ...extra,
  } as SessionMessage;
}

/** Assistant text turn with an exact output_tokens count. */
function assistantText(text: string, outputTokens: number): SessionMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 5_000, output_tokens: outputTokens },
    },
  } as SessionMessage;
}

/** Real-shaped `<task-notification>` record (background task / Workflow completion). */
const TASK_NOTIFICATION = machineUser(
  '<task-notification>\n<task-id>b1yhzz9oz</task-id>\n<tool-use-id>toolu_016TZmq4</tool-use-id>\n'
  + '<output-file>C:\\Temp\\tasks\\b1yhzz9oz.output</output-file>\n<status>completed</status>\n'
  + '<summary>Background command completed: bun test (198 pass)</summary>\n</task-notification>',
);

/** Category of message `index` in a classified breakdown. */
function categoryAt(msgs: SessionMessage[], index: number): CrustsCategory {
  return classifySession(msgs, EMPTY_CONFIG).messages[index]!.category;
}

describe('M7 isHumanUserText: only prompts the person typed qualify', () => {
  test('accepts plain human prompts (string and text-block content)', () => {
    expect(isHumanUserText(userText('fix the parser'))).toBe(true);
    expect(isHumanUserText(machineUser('fix the parser'))).toBe(true);
  });

  test('rejects every machine-written user record shape seen in real sessions', () => {
    const rejected: SessionMessage[] = [
      toolResult('t1', 'output'),
      TASK_NOTIFICATION,
      machineUser('<local-command-stdout>Set model to Opus 4.7</local-command-stdout>'),
      machineUser('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>', { isMeta: true }),
      machineUser('<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>'),
      machineUser('<command-message>context</command-message>\n<command-args></command-args>'),
      machineUser('[Request interrupted by user]'),
      machineUser('[Request interrupted by user for tool use]'),
      machineUser('## Context Usage\n**Model:** claude-fable-5[1m]\n**Tokens:** 55.4k / 1m', { isMeta: true }),
      machineUser('Continue from where you left off.', { isMeta: true }),
      { ...userText('# Update Config Skill\nModify Claude Code configuration'), isMeta: true, sourceToolUseID: 'toolu_skill' },
      { ...userText('Summary of the conversation so far'), isCompactSummary: true },
      { type: 'assistant', message: { role: 'assistant', content: 'hi' } } as SessionMessage,
    ];
    for (const msg of rejected) {
      expect(isHumanUserText(msg)).toBe(false);
    }
  });

  test('a marker is matched after leading whitespace, not anywhere in the text', () => {
    expect(isHumanUserText(machineUser('  \n<task-notification>late</task-notification>'))).toBe(false);
    expect(isHumanUserText(userText('why did the <task-notification> show up twice?'))).toBe(true);
  });
});

describe('M7 last human text: machine-written user records never become the U bucket', () => {
  test('last human is a <task-notification> record -> U bucket is the earlier real prompt', () => {
    const msgs = [userText('please fix the parser'), assistant(1_000), TASK_NOTIFICATION];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.messages[0]!.category).toBe('user');
    expect(b.messages[2]!.category).toBe('tools');
    const userBucket = b.buckets.find((x) => x.category === 'user')!;
    expect(userBucket.tokens).toBe(b.messages[0]!.tokens);
    expect(userBucket.tokens).toBeGreaterThan(0);
  });

  test('a trailing <local-command-stdout> record is System, the real prompt stays User', () => {
    const msgs = [
      userText('what model am I on'),
      assistant(1_000),
      machineUser('<local-command-caveat>Caveat: local commands.</local-command-caveat>', { isMeta: true }),
      machineUser('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>'),
      machineUser('<local-command-stdout>Set model to Opus 4.7 (1M context)</local-command-stdout>'),
      machineUser('<command-message>cost</command-message>\n<command-args></command-args>'),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.messages.map((m) => m.category)).toEqual([
      'user', 'conversation', 'system', 'system', 'system', 'system',
    ]);
  });

  test('an interrupt stub stays Conversation and does not displace the human prompt', () => {
    const msgs = [userText('run the suite'), assistant(1_000), machineUser('[Request interrupted by user for tool use]')];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.messages[0]!.category).toBe('user');
    expect(b.messages[2]!.category).toBe('conversation');
  });

  test('an unprefixed isMeta record (scheduled re-prompt) is not human text', () => {
    const msgs = [
      userText('start the overnight loop'),
      assistant(1_000),
      machineUser('AUTONOMOUS OVERNIGHT RUN (user asleep; proceed without asking)', { isMeta: true }),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.messages[0]!.category).toBe('user');
    expect(b.messages[2]!.category).not.toBe('user');
  });

  test('with no human prompt at all there is no U bucket', () => {
    const b = classifySession([TASK_NOTIFICATION, assistant(1_000)], EMPTY_CONFIG);
    expect(b.buckets.find((x) => x.category === 'user')!.tokens).toBe(0);
  });
});

describe('M7 skill bodies arrive as isMeta user records with sourceToolUseID', () => {
  const skillCall = toolUse('Skill', 'toolu_skill', { skill: 'update-config' });
  const skillAck = toolResult('toolu_skill', 'Launching skill: update-config');

  test('800K-char isMeta skill body -> State, not Conversation or User', () => {
    const body: SessionMessage = {
      type: 'user',
      isMeta: true,
      sourceToolUseID: 'toolu_skill',
      message: { role: 'user', content: [{ type: 'text', text: '# Update Config Skill\n' + 'x'.repeat(800_000) }] },
    } as SessionMessage;
    const msgs = [userText('/update-config allow npm'), skillCall, skillAck, body, assistant(250_000)];
    const b = classifySession(msgs, EMPTY_CONFIG);

    expect(b.messages[3]!.category).toBe('state');
    expect(b.messages[3]!.toolName).toBe('Skill');
    expect(b.messages[3]!.tokens).toBeGreaterThanOrEqual(200_000);
    expect(b.messages[0]!.category).toBe('user');

    const bucket = (cat: CrustsCategory) => b.buckets.find((x) => x.category === cat)!.tokens;
    expect(bucket('state')).toBeGreaterThanOrEqual(200_000);
    expect(bucket('conversation')).toBeLessThan(1_000);
    expect(bucket('user')).toBe(b.messages[0]!.tokens);
  });

  test('a sourceToolUseID that resolves to a retrieval tool follows the Retrieved rule', () => {
    const msgs = [
      userText('read it'),
      toolUse('Read', 'toolu_read', { file_path: 'a.ts' }),
      toolResult('toolu_read', 'ok'),
      { ...userText('const a = 1;'), isMeta: true, sourceToolUseID: 'toolu_read' },
    ];
    expect(categoryAt(msgs, 3)).toBe('retrieved');
  });

  test('an unresolved sourceToolUseID is Tools, never User or Conversation', () => {
    const msgs = [userText('go'), { ...userText('Base directory for this skill: C:\\skills\\loop'), isMeta: true, sourceToolUseID: 'toolu_gone' }];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.messages[1]!.category).toBe('tools');
    expect(b.messages[0]!.category).toBe('user');
  });
});

describe('M7 STATE_TOOLS: Agent / TaskOutput / Workflow results are State', () => {
  test('results of subagent-style tools are State while their calls and shell results stay Tools', () => {
    const msgs = [
      userText('delegate'),
      toolUse('Agent', 'toolu_a', { prompt: 'audit the scanner', subagent_type: 'general-purpose' }),
      toolResult('toolu_a', 'Subagent summary: scanner.ts drops attachment records at line 158.'),
      toolUse('TaskOutput', 'toolu_t', { task_id: 'b1' }),
      toolResult('toolu_t', 'bun test: 198 pass, 0 fail'),
      toolUse('Workflow', 'toolu_w', { name: 'deep-research' }),
      toolResult('toolu_w', 'Workflow finished: 3 steps, report written.'),
      toolUse('Bash', 'toolu_b', { command: 'ls' }),
      toolResult('toolu_b', 'a.ts\nb.ts'),
      toolUse('Read', 'toolu_r', { file_path: 'a.ts' }),
      toolResult('toolu_r', 'export const a = 1;'),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.messages.map((m) => m.category)).toEqual([
      'user',
      'tools', 'state',
      'tools', 'state',
      'tools', 'state',
      'tools', 'tools',
      'retrieved', 'retrieved',
    ]);
    expect(b.messages[2]!.toolName).toBe('Agent');
    expect(b.toolBreakdown.usedTools).toEqual(expect.arrayContaining(['Agent', 'TaskOutput', 'Workflow', 'Bash', 'Read']));
  });

  test('the legacy Task subagent result is State too', () => {
    const msgs = [userText('x'), toolUse('Task', 'toolu_legacy', { prompt: 'p' }), toolResult('toolu_legacy', 'done')];
    expect(categoryAt(msgs, 2)).toBe('state');
  });
});

describe('M7 analysis cutoff phase 3 uses the human-text predicate', () => {
  const base = [userText('hello'), assistant(1_000)];
  const crustsCall = [
    toolUse('Bash', 'toolu_c', { command: 'npx claude-crusts analyze' }),
    toolResult('toolu_c', CRUSTS_OUTPUT),
  ];

  test('a human prompt before the CRUSTS call is trimmed', () => {
    const b = classifySession([...base, userText('run crusts'), ...crustsCall], EMPTY_CONFIG);
    expect(b.messages.length).toBe(base.length);
  });

  test('a task notification before the CRUSTS call is kept as session content', () => {
    const b = classifySession([...base, TASK_NOTIFICATION, ...crustsCall], EMPTY_CONFIG);
    expect(b.messages.length).toBe(base.length + 1);
    expect(b.messages[base.length]!.category).toBe('tools');
  });
});

describe('M7 resolved-exchange waste rule only fires on human confirmations', () => {
  // 800 exact output tokens of Conversation right before the candidate record,
  // so the rule's 500-token floor is cleared regardless of lookback size.
  const exchange = [userText('why does the parser drop records?'), assistantText('Because scanner.ts filters them. '.repeat(40), 800)];

  /** Count resolved_exchange items for the exchange followed by `tail`. */
  function resolvedCount(tail: SessionMessage): number {
    const msgs = [...exchange, tail];
    const b = classifySession(msgs, EMPTY_CONFIG);
    return detectWaste(msgs, b, EMPTY_CONFIG).filter((w) => w.type === 'resolved_exchange').length;
  }

  test('a human "looks good" still fires (the rule is alive)', () => {
    expect(resolvedCount(userText('looks good, thanks'))).toBe(1);
  });

  test('an interrupt stub does not fire', () => {
    expect(resolvedCount(machineUser('[Request interrupted by user]'))).toBe(0);
  });

  test('slash-command stdout containing a resolution phrase does not fire', () => {
    expect(resolvedCount(machineUser('<local-command-stdout>Looks good: nice and fixed</local-command-stdout>'))).toBe(0);
  });

  test('an isMeta record containing a resolution phrase does not fire', () => {
    expect(resolvedCount(machineUser('got it, perfect', { isMeta: true }))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// M8 — split assistant lines: output_tokens once per message.id group
// ---------------------------------------------------------------------------

/** Usage shared by every line of one split API response (2.1.114+ shape). */
function splitUsage(u: { input?: number; output: number; thinkingTokens?: number }): TokenUsage {
  return {
    input_tokens: u.input ?? 500,
    output_tokens: u.output,
    ...(u.thinkingTokens !== undefined
      ? { output_tokens_details: { thinking_tokens: u.thinkingTokens } }
      : {}),
  };
}

/** One assistant JSONL line of a split API response. */
function splitLine(
  content: ContentBlock[],
  usage: TokenUsage,
  ids: { messageId?: string; requestId?: string } = {},
): SessionMessage {
  return {
    type: 'assistant',
    ...(ids.requestId ? { requestId: ids.requestId } : {}),
    message: {
      role: 'assistant',
      model: 'claude-fable-5',
      content,
      usage,
      ...(ids.messageId ? { id: ids.messageId } : {}),
    },
  } as SessionMessage;
}

describe('M8 split assistant lines: output_tokens counted once per message.id group', () => {
  // 800 chars of plain English -> ~200 tokens at the /4 divisor
  const TEXT_800 = 'word '.repeat(160);
  // ~336 chars of tool_use content (input JSON + id + name) -> ~100 tokens at /3.3
  const BASH_INPUT = { command: 'x'.repeat(310) };

  /** thinking / text / tool_use lines all repeating the same final usage. */
  function threeLineGroup(usage: TokenUsage): SessionMessage[] {
    const ids = { messageId: 'msg_01', requestId: 'req_01' };
    return [
      splitLine([{ type: 'thinking', thinking: '', signature: 's'.repeat(2_000) }], usage, ids),
      splitLine([{ type: 'text', text: TEXT_800 }], usage, ids),
      splitLine([{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: BASH_INPUT }], usage, ids),
    ];
  }

  test('T1: three lines sharing message.id, output 900 -> group sums to 900, not 2,700', () => {
    const msgs = [userText('go'), ...threeLineGroup(splitUsage({ output: 900 }))];
    const b = classifySession(msgs, EMPTY_CONFIG);
    const groupTokens = b.messages.slice(1).reduce((sum, m) => sum + m.tokens, 0);
    expect(groupTokens).toBe(900);
    // The group sum is API-exact but the per-line split is content-estimated
    expect(b.messages.slice(1).every((m) => m.accuracy === 'estimated')).toBe(true);
  });

  test('T2: apportioning follows content share; the thinking line takes the remainder (message.id group)', () => {
    const msgs = [userText('go'), ...threeLineGroup(splitUsage({ output: 900 }))];
    const b = classifySession(msgs, EMPTY_CONFIG);
    const tools = b.buckets.find((x) => x.category === 'tools')!;
    const conv = b.buckets.find((x) => x.category === 'conversation')!;
    // tool_use line ~100 tokens by content share
    expect(tools.tokens).toBeGreaterThanOrEqual(90);
    expect(tools.tokens).toBeLessThanOrEqual(110);
    // thinking remainder (~600) + text (~200) -> conversation ~800
    expect(conv.tokens).toBe(900 - tools.tokens);
    expect(b.messages[1]!.tokens).toBeGreaterThanOrEqual(590);
    expect(b.messages[1]!.tokens).toBeLessThanOrEqual(610);
  });

  test('thinking lines take output_tokens_details.thinking_tokens when the API recorded it (message.id group)', () => {
    const msgs = [userText('go'), ...threeLineGroup(splitUsage({ output: 900, thinkingTokens: 650 }))];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.messages[1]!.tokens).toBe(650);
    const groupTokens = b.messages.slice(1).reduce((sum, m) => sum + m.tokens, 0);
    expect(groupTokens).toBe(900);
  });

  test('legacy message.id group with differing per-line usage keeps per-line output_tokens', () => {
    const mk = (output: number, text: string): SessionMessage =>
      splitLine([{ type: 'text', text }], { input_tokens: 500, output_tokens: output }, { messageId: 'msg_legacy' });
    const msgs = [userText('go'), mk(300, 'alpha'), mk(400, 'beta'), mk(200, 'gamma')];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.messages.slice(1).map((m) => m.tokens)).toEqual([300, 400, 200]);
    expect(b.messages.slice(1).every((m) => m.accuracy === 'exact')).toBe(true);
  });

  test('lines without message.id group by requestId (fallback key)', () => {
    const usage = splitUsage({ output: 500 });
    const msgs = [
      userText('go'),
      splitLine([{ type: 'thinking', thinking: '', signature: 'sig' }], usage, { requestId: 'req_9' }),
      splitLine([{ type: 'text', text: TEXT_800 }], usage, { requestId: 'req_9' }),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.messages[1]!.tokens + b.messages[2]!.tokens).toBe(500);
  });

  test('distinct message.ids are never merged: each response keeps its own output_tokens', () => {
    const msgs = [
      userText('go'),
      splitLine([{ type: 'text', text: 'one' }], splitUsage({ output: 120 }), { messageId: 'msg_a' }),
      splitLine([{ type: 'text', text: 'two' }], splitUsage({ output: 80 }), { messageId: 'msg_b' }),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.messages[1]!.tokens).toBe(120);
    expect(b.messages[2]!.tokens).toBe(80);
    expect(b.messages[1]!.accuracy).toBe('exact');
  });

  test('ClassifiedMessage carries requestId and messageId from the record', () => {
    const msgs = [userText('go'), ...threeLineGroup(splitUsage({ output: 900 }))];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.messages[1]!.messageId).toBe('msg_01');
    expect(b.messages[1]!.requestId).toBe('req_01');
    expect(b.messages[0]!.messageId).toBeUndefined();
    expect(b.messages[0]!.requestId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// M9: framing ordering (lifetime buckets include framing)
// ---------------------------------------------------------------------------

describe('M9: framing ordering', () => {
  test('lifetime buckets and contentSumTokens include framing overhead', () => {
    // Consecutive assistants grow by 141 effective-input tokens per pair
    // while the classified content between them is 101 tokens (100 output
    // + a 1-token prompt), so framing derives 20 tokens/msg from 3 samples.
    const msgs: SessionMessage[] = [
      userText('q0'), assistant(1_000),
      userText('q1'), assistant(1_141),
      userText('q2'), assistant(1_282),
      userText('q3'), assistant(1_423),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    const framing = b.derivedOverhead!.messageFraming;
    expect(framing).not.toBeNull();
    expect(framing!.tokensPerMessage).toBe(20);
    expect(framing!.totalTokens).toBe(160);

    // The M9 invariant: lifetime buckets are computed AFTER the framing
    // distribution, so their sum equals contentSumTokens (before the fix
    // the mutation happened after buildBuckets and never reached them).
    const bucketSum = b.buckets.reduce((sum, x) => sum + x.tokens, 0);
    expect(bucketSum).toBe(b.contentSumTokens);
    // Raw content: 4 x 100 output + 4 x 1-token prompts = 404; framing 160.
    expect(b.contentSumTokens).toBe(564);
    // Each category carries its per-message framing share.
    expect(b.buckets.find((x) => x.category === 'conversation')!.tokens).toBe(543);
    expect(b.buckets.find((x) => x.category === 'user')!.tokens).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// M10: derived fixed context replaces the 1K-15K cap
// ---------------------------------------------------------------------------

describe('M10: derived fixed context', () => {
  /** Config matching the audited real-session knowns (CC 2.1.92-era legacy schema). */
  const LEGACY_CONFIG: ConfigData = {
    systemPrompt: { files: [], totalEstimatedTokens: 1_294 },
    mcpServers: [],
    memoryFiles: { files: [], totalEstimatedTokens: 0 },
    builtInTools: { tools: [], totalEstimatedTokens: 9_055 },
    skills: { items: [], totalEstimatedTokens: 0 },
  };

  test('fixed context of 43,352 (above the old 15K cap) is accepted and lands in System', () => {
    // First assistant effective input 2 + 18,938 + 35,299 = 54,239; known =
    // CLAUDE.md 1,294 + tools 9,055 + memory 0 + skills 476 (fallback) +
    // first user 62 = 10,887. The old absolute 15K ceiling rejected this.
    const b = classifySession([
      userText('w'.repeat(248)),
      currentShapeAssistant({}, { version: '2.1.92' }),
    ], LEGACY_CONFIG);
    const derived = b.derivedOverhead!.internalSystemPrompt;
    expect(derived).not.toBeNull();
    expect(derived!.tokens).toBe(43_352);
    expect(derived!.derivation.firstAssistantInputTokens).toBe(54_239);
    expect(derived!.derivation.totalKnown).toBe(10_887);
    expect(derived!.derivation.knownAttachments).toBe(0);
    const system = b.buckets.find((x) => x.category === 'system')!;
    // Raw content accounting (see M18): the reconciled `tokens` is scaled
    // to the API window total; the derived component sum stays visible in
    // `contentTokens`.
    expect(system.contentTokens).toBe(1_294 + 43_352);
  });

  test('fixed context is rejected when known components leave less than 1K residual', () => {
    // totalInput 502 < known 10,826, so derived is negative. The guard is
    // `derived < 1000 || derived > totalInput`; the upper bound is relative
    // to the turn's own input, never an absolute cap.
    const b = classifySession([
      userText('hi'),
      currentShapeAssistant({
        input_tokens: 2,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 },
      }, { version: '2.1.92' }),
    ], LEGACY_CONFIG);
    expect(b.derivedOverhead!.internalSystemPrompt).toBeNull();
  });

  test('fixed context uses the skill_listing attachment over the discovery fallback', () => {
    const skillListing = {
      type: 'attachment',
      attachment: { type: 'skill_listing', content: 's'.repeat(2_000) },
    } as SessionMessage;
    const b = classifySession([
      skillListing,
      userText('w'.repeat(248)),
      currentShapeAssistant({}, { version: '2.1.92' }),
    ], LEGACY_CONFIG);
    const derived = b.derivedOverhead!.internalSystemPrompt;
    expect(derived).not.toBeNull();
    expect(derived!.derivation.knownSkills).toBe(500);
    // The listing is counted as the skills component, not again as a
    // generic attachment.
    expect(derived!.derivation.knownAttachments).toBe(0);
    expect(derived!.tokens).toBe(54_239 - (10_887 - 476 + 500));
  });

  test('fixed context subtracts only attachments that precede the first assistant', () => {
    /** Attachment fixture carrying `chars` characters of hook output. */
    const hook = (chars: number): SessionMessage => ({
      type: 'attachment',
      attachment: { type: 'hook_success', content: 'h'.repeat(chars) },
    } as SessionMessage);
    const b = classifySession([
      hook(400),
      userText('w'.repeat(248)),
      currentShapeAssistant({}, { version: '2.1.92' }),
      hook(8_000),
    ], LEGACY_CONFIG);
    const derived = b.derivedOverhead!.internalSystemPrompt;
    expect(derived).not.toBeNull();
    expect(derived!.derivation.knownAttachments).toBe(100);
    expect(derived!.tokens).toBe(43_352 - 100);
  });

  test('estimateAttachmentTokens reads every known payload field shape', () => {
    /** Build an attachment record around the given payload. */
    const att = (payload: Record<string, unknown>): SessionMessage =>
      ({ type: 'attachment', attachment: payload } as SessionMessage);
    expect(estimateAttachmentTokens(att({ type: 'x', content: 'a'.repeat(40) }))).toBe(10);
    expect(estimateAttachmentTokens(att({ type: 'hook_additional_context', content: ['b'.repeat(40)] }))).toBe(10);
    expect(estimateAttachmentTokens(att({ type: 'deferred_tools_delta', addedLines: ['l'.repeat(20), 'l'.repeat(20)] }))).toBe(10);
    expect(estimateAttachmentTokens(att({ type: 'nested_memory', content: { content: 'm'.repeat(40) } }))).toBe(10);
    expect(estimateAttachmentTokens(att({ type: 'file', content: { file: { content: 'f'.repeat(40) } } }))).toBe(10);
    expect(estimateAttachmentTokens(att({ type: 'skill_listing', skills: [{ content: 's'.repeat(20) }, { content: 's'.repeat(20) }] }))).toBe(10);
    expect(estimateAttachmentTokens(att({ type: 'queued_command', prompt: 'p'.repeat(40) }))).toBe(10);
    expect(estimateAttachmentTokens({ type: 'user', message: { role: 'user', content: 'hi' } } as SessionMessage)).toBe(0);
  });
});


// ---------------------------------------------------------------------------
// M11: attachment records are kept and classified
// ---------------------------------------------------------------------------

/** Attachment record fixture: `chars` characters of payload text under `content`. */
function attachment(type: string, chars = 40, payload: Record<string, unknown> = {}): SessionMessage {
  return {
    type: 'attachment',
    attachment: { type, content: 'x'.repeat(chars), ...payload },
  } as SessionMessage;
}

/** CRUSTS auto-inject advisory as Claude Code records it (content is a string array). */
function advisoryAttachment(): SessionMessage {
  return {
    type: 'attachment',
    attachment: {
      type: 'hook_additional_context',
      hookName: 'UserPromptSubmit',
      content: ['[claude-crusts advisory] Context is at 71.2%. ~12,000 tokens of reclaimable waste identified.'],
    },
  } as SessionMessage;
}

describe('M11 attachment classification: attachment.type maps to a category', () => {
  const msgs: SessionMessage[] = [
    userText('start'),                      // 0  user (last human)
    attachment('task_reminder'),            // 1  state
    attachment('plan_mode_exit'),           // 2  state  (plan_mode* prefix)
    attachment('plan_file_reference'),      // 3  state
    attachment('skill_listing'),            // 4  system
    attachment('hook_additional_context'),  // 5  system (no advisory marker)
    attachment('date_change'),              // 6  system
    attachment('ultra_effort_enter'),       // 7  system (ultra_effort_* prefix)
    attachment('file'),                     // 8  retrieved
    attachment('edited_text_file'),         // 9  retrieved
    attachment('read_truncation_notice'),   // 10 retrieved
    attachment('queued_command'),           // 11 conversation
    attachment('context_tip'),              // 12 system (unknown type default)
    assistant(1_000),                       // 13 conversation
  ];

  test('categories follow the M11 table including prefix families and the unknown default', () => {
    const b = classifySession(msgs, EMPTY_CONFIG);
    const expected: Array<[number, CrustsCategory]> = [
      [1, 'state'], [2, 'state'], [3, 'state'],
      [4, 'system'], [5, 'system'], [6, 'system'], [7, 'system'],
      [8, 'retrieved'], [9, 'retrieved'], [10, 'retrieved'],
      [11, 'conversation'],
      [12, 'system'],
    ];
    for (const [index, category] of expected) {
      expect(b.messages[index]!.category).toBe(category);
    }
  });

  test('attachment rows carry estimated payload tokens, the isAttachment flag, and a type preview', () => {
    const b = classifySession(msgs, EMPTY_CONFIG);
    const row = b.messages[1]!;
    expect(row.tokens).toBe(10); // 40 chars / 4
    expect(row.accuracy).toBe('estimated');
    expect(row.isAttachment).toBe(true);
    expect(row.contentPreview).toBe('[attachment: task_reminder]');
    expect(b.messages[13]!.isAttachment).toBeUndefined();
  });

  test('attachment tokens land in their buckets', () => {
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.buckets.find((x) => x.category === 'state')!.tokens).toBe(30);
    expect(b.buckets.find((x) => x.category === 'retrieved')!.tokens).toBe(30);
    expect(b.buckets.find((x) => x.category === 'system')!.tokens).toBe(50);
  });

  test('countAnalyzedMessages excludes attachment rows (messageCount basis)', () => {
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.messages.length).toBe(14);
    expect(countAnalyzedMessages(b.messages)).toBe(2);
  });

  test('a leading attachment does not steal the first-message system rule', () => {
    const b = classifySession([
      attachment('hook_success'),
      userText('Contents of CLAUDE.md (project instructions)'),
      assistant(1_000),
    ], EMPTY_CONFIG);
    expect(b.messages[0]!.category).toBe('system'); // hook_success attachment
    expect(b.messages[1]!.category).toBe('system'); // first API record, CLAUDE.md marker
  });

  test('a real-shaped task_reminder (object item array) estimates tokens and lands in State', () => {
    // Claude Code writes task_reminder content as an array of task objects
    // ({id, subject, description}), not strings; their string fields are
    // the injected text. 1 + 39 + 80 = 120 chars -> 30 tokens.
    const reminder = {
      type: 'attachment',
      attachment: {
        type: 'task_reminder',
        content: [{ id: '1', subject: 's'.repeat(39), description: 'd'.repeat(80) }],
        itemCount: 1,
      },
    } as SessionMessage;
    const b = classifySession([userText('go'), reminder, assistant(1_000)], EMPTY_CONFIG);
    const row = b.messages[1]!;
    expect(row.category).toBe('state');
    expect(row.tokens).toBe(30);
  });

  test('a trailing attachment never becomes the U bucket', () => {
    const b = classifySession([
      userText('please fix the parser'),
      assistant(1_000),
      attachment('queued_command', 40, { prompt: 'next prompt' }),
    ], EMPTY_CONFIG);
    expect(b.messages[0]!.category).toBe('user');
    expect(b.messages[2]!.category).toBe('conversation');
  });
});

describe('M11 findAnalysisCutoff strips the CRUSTS auto-inject advisory', () => {
  const base = [userText('hello'), assistant(1_000)];

  test('advisory between the triggering prompt and the CRUSTS call is trimmed with the invocation', () => {
    const b = classifySession([
      ...base,
      userText('run crusts'),
      advisoryAttachment(),
      assistantText('running the analysis now', 10),
      toolUse('Bash', 'adv1', { command: 'npx claude-crusts analyze' }),
      toolResult('adv1', CRUSTS_OUTPUT),
    ], EMPTY_CONFIG);
    expect(b.messages.length).toBe(base.length);
  });

  test('a trailing advisory alone is trimmed but the real prompt keeps the U bucket', () => {
    const b = classifySession([
      userText('q1'),
      assistant(1_000),
      userText('q2'),
      advisoryAttachment(),
    ], EMPTY_CONFIG);
    expect(b.messages.length).toBe(3);
    expect(b.messages[2]!.category).toBe('user');
  });

  test('a mid-session advisory is kept and classified as System', () => {
    const msgs = [userText('q1'), advisoryAttachment(), assistant(1_000), userText('q2'), assistant(1_100)];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.messages.length).toBe(msgs.length);
    const row = b.messages[1]!;
    expect(row.category).toBe('system');
    expect(row.isAttachment).toBe(true);
    expect(row.tokens).toBeGreaterThan(0);
  });

  test('a hook_additional_context attachment without the marker is never trimmed', () => {
    const msgs = [...base, userText('q2'), attachment('hook_additional_context')];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.messages.length).toBe(msgs.length);
  });
});

describe('M11 attachments and per-message statistics', () => {
  test('framing: attachment tokens count in the expected delta but not the per-message divisor', () => {
    // Between each assistant pair: 100 output + 25 attachment tokens +
    // 1 prompt token = 126 expected, actual delta 146 -> 20 framing tokens
    // over TWO framed messages (assistant + prompt; the attachment is not
    // a message), so 10 tokens/msg.
    const msgs: SessionMessage[] = [
      userText('q0'), assistant(1_000),
      attachment('hook_success', 100), userText('q1'), assistant(1_146),
      attachment('hook_success', 100), userText('q2'), assistant(1_292),
      attachment('hook_success', 100), userText('q3'), assistant(1_438),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    const framing = b.derivedOverhead!.messageFraming;
    expect(framing).not.toBeNull();
    expect(framing!.tokensPerMessage).toBe(10);
    // Distributed over the 8 real messages only, never the 3 attachments.
    expect(framing!.totalTokens).toBe(80);
    expect(countAnalyzedMessages(b.messages)).toBe(8);

    // Attachment rows receive no framing share: System is exactly the
    // three payloads (3 x 25); the sum invariant still holds.
    expect(b.buckets.find((x) => x.category === 'system')!.tokens).toBe(75);
    const bucketSum = b.buckets.reduce((sum, x) => sum + x.tokens, 0);
    expect(bucketSum).toBe(b.contentSumTokens);
  });
});

// ---------------------------------------------------------------------------
// v0.8.0 M13 — context-limit threading: payload override, recorded /context
// output, settings signal, native-1M table
// ---------------------------------------------------------------------------

describe('M13 context-limit resolution threading', () => {
  test('limitOverride (statusline payload context_window_size) wins outright', () => {
    const b = classifySession([userText('hi'), assistantWithCache(100, 50_000)], EMPTY_CONFIG, undefined, undefined, 500_000);
    expect(b.context_limit).toBe(500_000);
  });

  test('a recorded /context output sets the window (observed 500K shape)', () => {
    const contextRecord = {
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: '## Context Usage\n\n**Model:** claude-opus-4-7  \n**Tokens:** 119.2k / 500k (24%)' },
    } as SessionMessage;
    const b = classifySession([userText('hi'), assistantWithCache(100, 50_000), contextRecord], EMPTY_CONFIG);
    expect(b.context_limit).toBe(500_000);
  });

  test('configData.settingsModels promotes a family-matching bare model to 1M', () => {
    const cfg: ConfigData = { ...EMPTY_CONFIG, settingsModels: ['claude-opus-4-7[1m]'] };
    const b = classifySession([userText('hi'), assistantWithCache(100, 50_000)], cfg);
    expect(b.context_limit).toBe(1_000_000);
  });

  test('a bare fable-5 session resolves to the native 1M window', () => {
    const b = classifySession([userText('hi'), currentShapeAssistant()], EMPTY_CONFIG);
    expect(b.context_limit).toBe(1_000_000);
  });

  test('a bare 4.x session with no signal stays at 200K', () => {
    const b = classifySession([userText('hi'), assistantWithCache(100, 50_000)], EMPTY_CONFIG);
    expect(b.context_limit).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
// v0.8.0 M17 — compaction event fidelity: postTokens, trigger,
// cumulativeDroppedTokens, preserved messages, per-event context limits
// ---------------------------------------------------------------------------

describe('M17 compaction event fidelity', () => {
  /** Assistant line carrying an explicit model id, for model-span tests. */
  function modelAssistant(model: string, inputTokens: number): SessionMessage {
    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        model,
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: inputTokens, output_tokens: 100 },
      },
    };
  }

  /** compact_boundary with full compactMetadata control. */
  function boundaryWithMeta(
    meta: NonNullable<SessionMessage['compactMetadata']>,
    uuid?: string,
  ): SessionMessage {
    return { type: 'system', subtype: 'compact_boundary', compactMetadata: meta, isMeta: true, uuid };
  }

  test('tokensAfter prefers compactMetadata.postTokens over the scanned assistant', () => {
    // Observed shape: the first assistant after the boundary belongs to an
    // in-flight PRE-compaction turn (676,916 effective input), while Claude
    // Code recorded the real post-compaction size as postTokens 12,867.
    const msgs: SessionMessage[] = [
      assistant(120_000),
      boundaryWithMeta({ trigger: 'auto', preTokens: 843_784, postTokens: 12_867 }, 'b1'),
      userText('u1'), userText('u2'), userText('u3'), userText('u4'),
      assistant(676_916),
    ];
    const events = detectCompactionEvents(msgs);
    expect(events.length).toBe(1);
    expect(events[0]!.tokensAfter).toBe(12_867);
    expect(events[0]!.tokensDropped).toBe(843_784 - 12_867);
    // afterIndex (the start of the new window slice) still comes from the scan.
    expect(events[0]!.afterIndex).toBe(6);
    expect(events[0]!.trigger).toBe('auto');
  });

  test('the forward scan for tokensAfter has no 10-record cap', () => {
    // Without postTokens, a boundary followed by a long run of user records
    // previously fell off the 10-record window and reported tokensAfter 0
    // (i.e. tokensDropped = preTokens).
    const msgs: SessionMessage[] = [
      assistant(120_000),
      boundaryWithMeta({ trigger: 'manual', preTokens: 150_000 }, 'b1'),
      ...Array.from({ length: 12 }, (_, k) => userText(`filler ${k}`)),
      assistant(30_000),
    ];
    const events = detectCompactionEvents(msgs);
    expect(events.length).toBe(1);
    expect(events[0]!.afterIndex).toBe(14);
    expect(events[0]!.tokensAfter).toBe(30_000);
    expect(events[0]!.tokensDropped).toBe(120_000);
    expect(events[0]!.trigger).toBe('manual');
  });

  test('trigger and cumulativeDroppedTokens are copied from compactMetadata', () => {
    const msgs: SessionMessage[] = [
      assistant(100_000),
      boundaryWithMeta({
        trigger: 'manual',
        preTokens: 100_000,
        postTokens: 6_000,
        cumulativeDroppedTokens: 835_855,
      }, 'b1'),
      assistant(40_000),
    ];
    const events = detectCompactionEvents(msgs);
    expect(events[0]!.trigger).toBe('manual');
    expect(events[0]!.cumulativeDroppedTokens).toBe(835_855);
  });

  test('heuristic events carry no trigger', () => {
    const msgs: SessionMessage[] = [
      assistant(150_000),
      assistant(160_000),
      assistant(20_000),
    ];
    const events = detectCompactionEvents(msgs);
    expect(events[0]!.detection).toBe('heuristic');
    expect(events[0]!.trigger).toBeUndefined();
  });

  test('preservedMessages uuids resolve to pre-boundary indices and join the current-context slice', () => {
    const pinned: SessionMessage = {
      type: 'user',
      uuid: 'u-keep',
      message: { role: 'user', content: 'pinned instructions that Claude Code carried across the boundary' },
    };
    const msgs: SessionMessage[] = [
      pinned,                                                    // index 0 — preserved
      assistant(50_000),                                         // index 1
      boundaryWithMeta({
        trigger: 'auto',
        preTokens: 150_000,
        postTokens: 9_000,
        preservedMessages: { anchorUuid: 'u-keep', uuids: ['u-keep', 'missing-uuid'] },
      }, 'b1'),                                                  // index 2
      assistant(30_000),                                         // index 3
    ];

    const events = detectCompactionEvents(msgs);
    // Unknown uuids are dropped; the known one resolves to its index.
    expect(events[0]!.preservedMessageIndices).toEqual([0]);

    // The preserved user prompt is re-sent in the new window: its tokens
    // appear in currentContext even though it sits before startIndex.
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.currentContext).toBeDefined();
    expect(b.currentContext!.startIndex).toBe(3);
    const userTokens = b.currentContext!.buckets.find((x) => x.category === 'user')!.tokens;
    expect(userTokens).toBeGreaterThan(0);
    expect(userTokens).toBe(b.messages[0]!.tokens);

    // Same session without preservedMessages: nothing before startIndex counts.
    const bare = msgs.map((m) => m === msgs[2] ? boundaryWithMeta({
      trigger: 'auto', preTokens: 150_000, postTokens: 9_000,
    }, 'b1') : m);
    const b2 = classifySession(bare, EMPTY_CONFIG);
    expect(b2.currentContext!.buckets.find((x) => x.category === 'user')!.tokens).toBe(0);
  });

  test('pre-switch 200K events keep their own limit while the breakdown reports the current window', () => {
    // Window ran on opus-4-6 (200K, auto-compaction at ~167K), then the
    // user switched to fable-5 (native 1M). The event's limit must stay
    // 200K; breakdown.context_limit reports the CURRENT window's 1M.
    const msgs: SessionMessage[] = [
      userText('start'),
      modelAssistant('claude-opus-4-6', 120_000),
      modelAssistant('claude-opus-4-6', 166_000),
      boundaryWithMeta({ trigger: 'auto', preTokens: 167_235, postTokens: 10_000 }, 'b1'),
      modelAssistant('claude-fable-5', 40_000),
      modelAssistant('claude-fable-5', 60_000),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.compactionEvents.length).toBe(1);
    expect(b.compactionEvents[0]!.contextLimit).toBe(200_000);
    expect(b.context_limit).toBe(1_000_000);
  });

  test('single-model sessions resolve the same limit for events and breakdown', () => {
    const msgs: SessionMessage[] = [
      userText('start'),
      modelAssistant('claude-fable-5', 120_000),
      boundaryWithMeta({ trigger: 'auto', preTokens: 967_000, postTokens: 12_000 }, 'b1'),
      modelAssistant('claude-fable-5', 40_000),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.context_limit).toBe(1_000_000);
    expect(b.compactionEvents[0]!.contextLimit).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// v0.8.0 M18 — window reconciliation
// ---------------------------------------------------------------------------

import { reconcileBuckets, RECONCILE_SCALE_MIN, RECONCILE_SCALE_MAX } from '../src/classifier.ts';
import type { CrustsBucket } from '../src/types.ts';

/** Raw (content-basis) bucket for direct reconcileBuckets tests. */
function rawBucket(category: CrustsCategory, tokens: number): CrustsBucket {
  return { category, tokens, percentage: 0, accuracy: 'estimated', contentTokens: tokens };
}

/** Sum of the window-basis token values across a bucket array. */
function bucketSum(buckets: CrustsBucket[]): number {
  return buckets.reduce((s, b) => s + b.tokens, 0);
}

/** Sum of the reported percentages across a bucket array. */
function percentageSum(buckets: CrustsBucket[]): number {
  return buckets.reduce((s, b) => s + b.percentage, 0);
}

describe('M18 reconcileBuckets (unit)', () => {
  test('floor plus remainder lands the sum EXACTLY on the API total, remainder on the largest bucket', () => {
    const raw = [
      rawBucket('conversation', 100),
      rawBucket('tools', 200),
      rawBucket('retrieved', 300),
    ];
    const { buckets, reconciliation } = reconcileBuckets(raw, 700);
    expect(reconciliation.basis).toBe('api');
    expect(reconciliation.scale).toBeCloseTo(700 / 600, 5);
    expect(bucketSum(buckets)).toBe(700);
    // floors: 116 + 233 + 350 = 699; the 1-token remainder goes to the
    // largest bucket (retrieved, contentTokens 300)
    expect(buckets.find((b) => b.category === 'conversation')!.tokens).toBe(116);
    expect(buckets.find((b) => b.category === 'tools')!.tokens).toBe(233);
    expect(buckets.find((b) => b.category === 'retrieved')!.tokens).toBe(351);
    // contentTokens stay raw
    expect(buckets.map((b) => b.contentTokens)).toEqual([100, 200, 300]);
    expect(percentageSum(buckets)).toBeCloseTo(100, 1);
  });

  test('scale below the guard band leaves the buckets on the content basis and records the scale', () => {
    const raw = [rawBucket('conversation', 400), rawBucket('tools', 200)];
    const { buckets, reconciliation } = reconcileBuckets(raw, 200); // scale 0.333
    expect(reconciliation.basis).toBe('content');
    expect(reconciliation.scale).toBeCloseTo(200 / 600, 5);
    expect(reconciliation.scale).toBeLessThan(RECONCILE_SCALE_MIN);
    expect(buckets.find((b) => b.category === 'conversation')!.tokens).toBe(400);
    expect(bucketSum(buckets)).toBe(600);
  });

  test('scale above the guard band is also refused', () => {
    const raw = [rawBucket('conversation', 100)];
    const { reconciliation } = reconcileBuckets(raw, 1_000); // scale 10
    expect(reconciliation.basis).toBe('content');
    expect(reconciliation.scale).toBeGreaterThan(RECONCILE_SCALE_MAX);
  });

  test('no API total means scale 1 on the content basis', () => {
    const raw = [rawBucket('conversation', 100), rawBucket('tools', 50)];
    const { buckets, reconciliation } = reconcileBuckets(raw, null);
    expect(reconciliation).toEqual({ scale: 1, basis: 'content' });
    expect(bucketSum(buckets)).toBe(150);
  });
});

describe('M18 window reconciliation through classifySession', () => {
  /** In-band fixture: content sum lands close to the API window total. */
  function inBandMessages(): SessionMessage[] {
    return [
      userText('crust '.repeat(800)), // ~4,800 chars of plain English
      assistantWithCache(100, 1_000), // effective input 1,100 + output 100
    ];
  }

  test('T3: no-compaction buckets sum EXACTLY to total_tokens and percentages sum to 100', () => {
    const b = classifySession(inBandMessages(), EMPTY_CONFIG);
    expect(b.compactionEvents.length).toBe(0);
    expect(b.reconciliation).toBeDefined();
    expect(b.reconciliation!.basis).toBe('api');
    expect(b.reconciliation!.scale).toBeGreaterThanOrEqual(RECONCILE_SCALE_MIN);
    expect(b.reconciliation!.scale).toBeLessThanOrEqual(RECONCILE_SCALE_MAX);
    expect(b.buckets.reduce((s, x) => s + x.tokens, 0)).toBe(b.total_tokens);
    const pctSum = b.buckets.reduce((s, x) => s + x.percentage, 0);
    expect(Math.abs(pctSum - 100)).toBeLessThanOrEqual(0.1);
    // Raw accounting preserved alongside
    expect(b.buckets.reduce((s, x) => s + x.contentTokens, 0)).toBeCloseTo(b.contentSumTokens!, 5);
  });

  test('T4: compacted sessions keep lifetime buckets raw but reconcile currentContext', () => {
    // First assistant effective input 40,100: the M10 derivation accepts
    // ~39.6K of fixed context into System (re-injected after compaction,
    // so it counts in the current slice too). The post-compact assistant
    // then reports a comparable window (40,100 + 100 output), landing the
    // slice's scale in band, like a real compacted session.
    const msgs: SessionMessage[] = [
      userText('q1'),
      assistantWithCache(100, 40_000),
      compactBoundary(150_000),
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'summary '.repeat(500) }] }, isCompactSummary: true } as SessionMessage,
      userText('q2'),
      assistantWithCache(100, 40_000),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.compactionEvents.length).toBe(1);
    // Lifetime stays on the content basis — the API total describes only
    // the last window, so scaling lifetime would fabricate a composition.
    expect(b.reconciliation!.basis).toBe('content');
    expect(b.reconciliation!.scale).toBe(1);
    expect(b.buckets.reduce((s, x) => s + x.tokens, 0)).toBeCloseTo(b.contentSumTokens!, 5);
    // currentContext IS the live window: always reconciled when in band.
    const cc = b.currentContext!;
    expect(cc.reconciliation).toBeDefined();
    expect(cc.reconciliation!.basis).toBe('api');
    expect(cc.buckets.reduce((s, x) => s + x.tokens, 0)).toBe(cc.total_tokens);
    const pctSum = cc.buckets.reduce((s, x) => s + x.percentage, 0);
    expect(Math.abs(pctSum - 100)).toBeLessThanOrEqual(0.1);
  });

  test('T5: no-usage session reconciles with scale 1 and tokens === contentTokens', () => {
    const msgs: SessionMessage[] = [
      userText('q'),
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'response' }] } } as SessionMessage,
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.reconciliation!.scale).toBe(1);
    for (const bucket of b.buckets) {
      expect(bucket.tokens).toBe(bucket.contentTokens);
    }
    // total falls back to content sum, so the sum invariant still holds
    expect(b.buckets.reduce((s, x) => s + x.tokens, 0)).toBeCloseTo(b.total_tokens, 5);
  });

  test('T6: an out-of-band scale is exposed but NOT applied (basis stays content)', () => {
    // First assistant input is tiny, so the M10 derivation is rejected
    // (residual < 1K) and nothing absorbs the gap; the LAST assistant then
    // reports a 350K window against a few tokens of classified content.
    // The drift is a classification-defect tripwire, not estimation noise.
    const msgs: SessionMessage[] = [
      userText('q'),
      assistantWithCache(100, 300),
      userText('q2'),
      assistantWithCache(100, 350_000),
    ];
    const b = classifySession(msgs, EMPTY_CONFIG);
    expect(b.reconciliation!.basis).toBe('content');
    expect(b.reconciliation!.scale).toBeGreaterThan(RECONCILE_SCALE_MAX);
    for (const bucket of b.buckets) {
      expect(bucket.tokens).toBe(bucket.contentTokens);
    }
    // The defect stays visible: bucket sum does NOT match the API total.
    expect(b.buckets.reduce((s, x) => s + x.tokens, 0)).not.toBe(b.total_tokens);
  });
});
