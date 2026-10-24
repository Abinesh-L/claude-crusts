/**
 * Cache re-write rule (0.8.2 F2): the cache_overhead waste item measures
 * prompt-cache writes that repeated content already cached, not cache reads.
 *
 * Every test runs with CRUSTS_CONFIG_DIR_OVERRIDE pointing at a temp dir, so
 * detectWaste reads default thresholds (or a config.json written here) and
 * never the developer's real ~/.claude-crusts.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { findCacheRewrites, CACHE_TTL_MS } from '../src/cache-rewrites.ts';
import { classifySession } from '../src/classifier.ts';
import { detectWaste } from '../src/waste-detector.ts';
import { describeThresholdOverrides, loadWasteThresholds, DEFAULT_WASTE_THRESHOLDS } from '../src/config.ts';
import { buildCompactFocus } from '../src/optimizer.ts';
import { compactCommandFor } from '../src/auto-inject.ts';
import { renderWaste } from '../src/renderer.ts';
import { generateSessionReportMd } from '../src/md-report.ts';
import { generateSessionReport } from '../src/html-report.ts';
import type { AnalysisResult, ConfigData, SessionMessage, TokenUsage, WasteItem } from '../src/types.ts';

const EMPTY_CONFIG: ConfigData = {
  systemPrompt: { files: [], totalEstimatedTokens: 0 },
  mcpServers: [],
  memoryFiles: { files: [], totalEstimatedTokens: 0 },
  builtInTools: { tools: [], totalEstimatedTokens: 0 },
  skills: { items: [], totalEstimatedTokens: 0 },
};

let sandbox: string;
let savedOverride: string | undefined;

beforeAll(() => {
  sandbox = resolve(mkdtempSync(join(tmpdir(), 'crusts-cache-rewrites-')));
  savedOverride = process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
  process.env.CRUSTS_CONFIG_DIR_OVERRIDE = sandbox;
});

afterAll(() => {
  if (savedOverride === undefined) delete process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
  else process.env.CRUSTS_CONFIG_DIR_OVERRIDE = savedOverride;
  rmSync(resolve(sandbox), { recursive: true, force: true });
});

afterEach(() => {
  const config = join(sandbox, 'config.json');
  if (existsSync(config)) unlinkSync(config);
});

/** Session start used by every fixture. */
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);

/**
 * Minutes after T0 as an ISO timestamp.
 *
 * @param minutes - Minutes after the session start
 * @returns ISO timestamp
 */
function at(minutes: number): string {
  return new Date(T0 + Math.round(minutes * 60_000)).toISOString();
}

/** Options for one request in a fixture session. */
interface RequestOptions {
  model?: string;
  ttl?: '5m' | '1h';
  /** cache_miss_reason type; null (default) = `diagnostics: null` */
  reason?: string | null;
  /** cache_missed_input_tokens on the reason */
  missedTokens?: number;
  /** Omit the diagnostics field (Claude Code before 2.1.214) */
  noDiagnostics?: boolean;
  /** Omit the nested cache_creation TTL split (older Claude Code) */
  noTtlSplit?: boolean;
  /** Split lines the response is written as (2.1.114+) */
  lines?: number;
  /** Write the request on a subagent's sidechain */
  agentId?: string;
}

/**
 * Builds a transcript the way Claude Code records it: a prompt record, then
 * the response's assistant line(s) carrying usage, and tracks what each
 * agent's latest request left in the cache.
 */
class SessionBuilder {
  readonly messages: SessionMessage[] = [];
  private readonly cached = new Map<string, number>();
  private clock = 0;
  private ids = 0;

  /**
   * @param model - Model of every request unless overridden
   * @param ttl - Cache TTL tier of every write unless overridden
   */
  constructor(private readonly model = 'claude-opus-5-5', private readonly ttl: '5m' | '1h' = '1h') {}

  /**
   * Tokens the agent's latest request left in the cache.
   *
   * @param agentId - Subagent id, or undefined for the main conversation
   * @returns Cached prefix size
   */
  cachedFor(agentId?: string): number {
    return this.cached.get(agentId ?? 'main') ?? 0;
  }

  /**
   * Append a prompt after `gapMinutes` and its response.
   *
   * @param gapMinutes - Minutes since the previous request was sent
   * @param read - cache_read_input_tokens
   * @param write - cache_creation_input_tokens
   * @param opts - Request options
   * @returns this
   */
  request(gapMinutes: number, read: number, write: number, opts: RequestOptions = {}): this {
    this.clock += gapMinutes;
    const side = opts.agentId !== undefined ? { isSidechain: true, agentId: opts.agentId } : {};
    this.messages.push({ type: 'user', timestamp: at(this.clock), message: { role: 'user', content: 'next step' }, ...side });
    const ttl = opts.ttl ?? this.ttl;
    const usage: TokenUsage = {
      input_tokens: 4,
      output_tokens: 300,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write,
      ...(opts.noTtlSplit ? {} : {
        cache_creation: ttl === '1h'
          ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write }
          : { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 },
      }),
    };
    const id = ++this.ids;
    const reason = opts.reason ?? null;
    for (let k = 0; k < (opts.lines ?? 1); k++) {
      const message: NonNullable<SessionMessage['message']> = {
        role: 'assistant',
        id: `msg_${id}`,
        model: opts.model ?? this.model,
        content: [{ type: 'text', text: 'done' }],
        usage: { ...usage },
      };
      if (!opts.noDiagnostics) {
        message.diagnostics = reason === null ? null : {
          cache_miss_reason: { type: reason, ...(opts.missedTokens !== undefined ? { cache_missed_input_tokens: opts.missedTokens } : {}) },
        };
      }
      this.messages.push({ type: 'assistant', timestamp: at(this.clock + 0.2 + k * 0.05), requestId: `req_${id}`, message, ...side });
    }
    this.clock += 0.5;
    this.cached.set(opts.agentId ?? 'main', read + write);
    return this;
  }

  /**
   * The agent's first request: nothing cached yet, everything written.
   *
   * @param write - Tokens written (fixed context and first prompt)
   * @param opts - Request options
   * @returns this
   */
  start(write = 30_000, opts: RequestOptions = {}): this {
    return this.request(0, 0, write, opts);
  }

  /**
   * Ordinary turns: each reads the whole cached prefix and writes only the
   * new exchange.
   *
   * @param count - Number of turns
   * @param growth - Tokens each turn adds
   * @param opts - Request options
   * @returns this
   */
  turns(count: number, growth = 4_000, opts: RequestOptions = {}): this {
    for (let k = 0; k < count; k++) this.request(1, this.cachedFor(opts.agentId), growth, opts);
    return this;
  }

  /**
   * A re-write: only `stillCached` tokens (the shared system part) are read
   * back; the rest of the prefix is written again with the new exchange.
   *
   * @param gapMinutes - Minutes since the previous request
   * @param opts - Request options plus the part still cached
   * @returns this
   */
  rewrite(gapMinutes: number, opts: RequestOptions & { stillCached?: number } = {}): this {
    const still = opts.stillCached ?? 25_000;
    return this.request(gapMinutes, still, this.cachedFor(opts.agentId) - still + 4_000, opts);
  }

  /**
   * A compaction: boundary, summary, then the first request of the new
   * window, which reads nothing and writes the summarized context.
   *
   * @param write - Tokens the first post-compaction request writes
   * @returns this
   */
  compact(write = 60_000): this {
    this.clock += 1;
    this.messages.push({
      type: 'system', subtype: 'compact_boundary', uuid: `boundary-${this.ids}`, timestamp: at(this.clock), isMeta: true,
      compactMetadata: { trigger: 'manual', preTokens: this.cachedFor(), postTokens: 20_000 },
    });
    this.messages.push({ type: 'user', timestamp: at(this.clock), isCompactSummary: true, message: { role: 'user', content: 'Summary of the work so far. '.repeat(40) } });
    return this.request(1, 0, write);
  }
}

/**
 * The cache_overhead item detectWaste produces for a transcript.
 *
 * @param messages - Fixture transcript
 * @param untilIndex - Optional analysis cutoff (as `--until`)
 * @returns The item, or undefined
 */
function cacheItem(messages: SessionMessage[], untilIndex?: number): WasteItem | undefined {
  const breakdown = classifySession(messages, EMPTY_CONFIG, untilIndex);
  return detectWaste(messages, breakdown, EMPTY_CONFIG).find((w) => w.type === 'cache_overhead');
}

/** A session with two breaks over an hour on the one-hour cache. */
function expirySession(): SessionBuilder {
  return new SessionBuilder().start(30_000).turns(10).rewrite(75).turns(5).rewrite(180).turns(3);
}

describe('healthy sessions', () => {
  test('high cache reads with no re-writes produce no item', () => {
    const s = new SessionBuilder().start(30_000).turns(60, 3_000);
    const report = findCacheRewrites(s.messages);
    // The 0.8.1 rule flagged exactly this: reads are almost all of the input.
    expect(report.cacheReadTokens / report.inputTokens).toBeGreaterThan(0.95);
    expect(report.rewrites).toEqual([]);
    expect(cacheItem(s.messages)).toBeUndefined();
  });

  test('a large new tool result is new content, not a re-write', () => {
    // The turn writes 80K on a 38K prefix, but reads the whole prefix back.
    const s = new SessionBuilder().start(30_000).turns(2);
    s.request(1, s.cachedFor(), 80_000).turns(3);
    expect(findCacheRewrites(s.messages).rewrites).toEqual([]);
  });

  test('a diagnosed miss that still read the prefix back is not a re-write', () => {
    // Seen on a real transcript: messages_changed, cache_missed_input_tokens
    // 188,523, yet only 6,958 tokens written. The usage, not the diagnosis's
    // byte estimate, says how much was written again.
    const s = new SessionBuilder().start(30_000).turns(5);
    s.request(1, s.cachedFor(), 7_000, { reason: 'messages_changed', missedTokens: 188_523 }).turns(2);
    expect(findCacheRewrites(s.messages).rewrites).toEqual([]);
  });

  test('re-writes under 50,000 tokens never produce an item', () => {
    const s = new SessionBuilder().start(20_000).turns(3, 2_000).rewrite(90, { stillCached: 10_000 });
    const report = findCacheRewrites(s.messages);
    expect(report.rewrites.length).toBe(1);
    expect(report.rewrites[0]!.tokens / report.cacheWriteTokens).toBeGreaterThan(0.25);
    expect(cacheItem(s.messages)).toBeUndefined();
  });
});

describe('expiries', () => {
  test('re-writes after gaps over the one-hour TTL are flagged with the gap and the TTL', () => {
    const s = expirySession();
    const report = findCacheRewrites(s.messages);
    expect(report.rewrites.map((r) => r.cause)).toEqual(['expired', 'expired']);
    for (const r of report.rewrites) expect(r.ttl).toBe('1h');
    const [first, second] = report.rewrites;
    expect(first!.gapMs).toBeGreaterThan(CACHE_TTL_MS['1h']);
    expect(Math.round(second!.gapMs! / 60_000)).toBe(181);
    // Sized from usage cache_creation: the prefix minus the part still cached, plus the new exchange.
    expect(first!.tokens).toBe(70_000 - 25_000 + 4_000);

    const item = cacheItem(s.messages)!;
    expect(item).toBeDefined();
    expect(item.severity).toBe('info');
    expect(item.estimated_tokens).toBe(0);
    expect(item.description).toStartWith('2 cache re-writes after the cache expired (gaps over 1 h) re-wrote ');
    expect(item.description).toContain(`the largest after a 3 h break at message #${second!.messageIndex + 1}`);
    expect(item.description).toMatch(/Re-writes were \d+% of this session's cache writes\./);
    expect(item.recommendation).toContain('/compact before a long break');
    // A one-hour cache would not have outlived these gaps.
    expect(item.recommendation).not.toContain('promptCacheTtl');
    expect(item.recommendation).not.toMatch(/keep-?alive|ping/i);
  });

  test('a record stamped when the response arrived does not hide a 5-minute expiry', () => {
    // Enough turns that a re-write writes most of the cached prefix again.
    const s = new SessionBuilder('claude-opus-5-5', '5m').start(30_000).turns(8);
    // P: the response takes 6 minutes, and Claude Code writes a
    // deferred_tools_record stamped with the response's time just before it.
    s.turns(1);
    const firstLine = s.messages[s.messages.length - 1]!;
    const arrived = new Date(Date.parse(firstLine.timestamp!) + 6 * 60_000).toISOString();
    firstLine.timestamp = arrived;
    s.messages.splice(s.messages.length - 1, 0, { type: 'attachment', timestamp: arrived, attachment: { type: 'deferred_tools_record' } } as SessionMessage);
    // Q follows the response at once, 6.3 minutes after P was sent: the entry expired.
    s.rewrite(5.8);
    expect(findCacheRewrites(s.messages).rewrites.at(-1)!.cause).toBe('expired');
  });

  test('a queued command keeps its earlier time without pulling the send time back', () => {
    // Enough turns that a re-write writes most of the cached prefix again.
    const s = new SessionBuilder('claude-opus-5-5', '5m').start(30_000).turns(8);
    s.turns(1); // Q
    const prompt = s.messages.length - 2;
    const queuedAt = new Date(Date.parse(s.messages[prompt]!.timestamp!) - 10 * 60_000).toISOString();
    s.messages.splice(prompt + 1, 0, { type: 'attachment', timestamp: queuedAt, attachment: { type: 'queued_command', prompt: 'later' } } as SessionMessage);
    // R comes 4.5 minutes after Q was sent: inside the 5-minute TTL.
    s.rewrite(4);
    expect(findCacheRewrites(s.messages).rewrites.at(-1)!.cause).not.toBe('expired');
  });

  test('a subagent\'s 5-minute expiries name subagentPromptCacheTtl', () => {
    const sub = { agentId: 'a1' };
    const s = new SessionBuilder('claude-opus-5-5', '5m').start(30_000, sub).turns(8, 4_000, sub)
      .rewrite(22, sub).turns(4, 4_000, sub).rewrite(40, sub).turns(2, 4_000, sub);
    const report = findCacheRewrites(s.messages);
    expect(report.rewrites.every((r) => r.subagent === true)).toBe(true);
    const item = cacheItem(s.messages)!;
    expect(item.recommendation).toContain('"subagentPromptCacheTtl": "1h"');
    expect(item.recommendation).not.toContain('"promptCacheTtl"');
  });

  test('expiries on the 5-minute cache within the hour name promptCacheTtl', () => {
    const s = new SessionBuilder('claude-opus-5-5', '5m').start(30_000).turns(8).rewrite(22).turns(4).rewrite(40).turns(2);
    const report = findCacheRewrites(s.messages);
    expect(report.rewrites.map((r) => r.cause)).toEqual(['expired', 'expired']);
    expect(report.rewrites.every((r) => r.ttl === '5m')).toBe(true);
    const item = cacheItem(s.messages)!;
    expect(item.description).toStartWith('2 cache re-writes after the 5-minute cache expired (gaps under 1 h)');
    expect(item.description).toMatch(/the largest after a \d+ min break at message #\d+/);
    expect(item.recommendation).toContain('"promptCacheTtl": "1h"');
  });

  test('without diagnostics the gap against the TTL decides', () => {
    const within = new SessionBuilder().start(30_000).turns(6).rewrite(30, { noDiagnostics: true });
    expect(findCacheRewrites(within.messages).rewrites[0]!.cause).toBe('unexplained');
    const over = new SessionBuilder().start(30_000).turns(6).rewrite(90, { noDiagnostics: true });
    expect(findCacheRewrites(over.messages).rewrites[0]!.cause).toBe('expired');
    // No TTL split recorded (older Claude Code): the 5-minute TTL applies.
    const old = new SessionBuilder().start(30_000, { noTtlSplit: true }).turns(6, 4_000, { noTtlSplit: true })
      .rewrite(30, { noDiagnostics: true, noTtlSplit: true });
    const r = findCacheRewrites(old.messages).rewrites[0]!;
    expect(r.ttl).toBe('5m');
    expect(r.cause).toBe('expired');
  });
});

describe('previous_message_not_found and unavailable', () => {
  test('previous_message_not_found inside the TTL is not called an expiry', () => {
    const s = new SessionBuilder().start(30_000).turns(12).rewrite(20, { reason: 'previous_message_not_found' }).turns(2);
    const [r] = findCacheRewrites(s.messages).rewrites;
    expect(r!.cause).toBe('unexplained');
    expect(r!.reportedReason).toBe('previous_message_not_found');
    expect(r!.ttl).toBe('1h');
    expect(cacheItem(s.messages)!.description).toStartWith('1 cache re-write with no recorded cause re-wrote ');
  });

  test('the same reason after a gap over the TTL is an expiry, and the TTL tier matters', () => {
    const long = new SessionBuilder().start(30_000).turns(8).rewrite(90, { reason: 'previous_message_not_found' });
    expect(findCacheRewrites(long.messages).rewrites[0]!.cause).toBe('expired');
    // 20 minutes outlives the 5-minute cache but not the one-hour cache.
    const short = new SessionBuilder('claude-opus-5-5', '5m').start(30_000).turns(8).rewrite(20, { reason: 'previous_message_not_found' });
    expect(findCacheRewrites(short.messages).rewrites[0]!.cause).toBe('expired');
  });

  test('unavailable means no comparison: an expiry after a long gap, unexplained within the TTL', () => {
    const long = new SessionBuilder().start(30_000).turns(8).rewrite(72 * 60, { reason: 'unavailable' });
    expect(findCacheRewrites(long.messages).rewrites[0]!.cause).toBe('expired');
    const close = new SessionBuilder().start(30_000).turns(8).rewrite(2, { reason: 'unavailable' });
    expect(findCacheRewrites(close.messages).rewrites[0]!.cause).toBe('unexplained');
  });
});

describe('prefix changes', () => {
  test('diagnosed system, tools and messages changes name their cause', () => {
    const s = new SessionBuilder().start(30_000).turns(6)
      .rewrite(1, { reason: 'system_changed' }).turns(2)
      .rewrite(2, { reason: 'tools_changed' }).turns(2)
      .rewrite(1, { reason: 'messages_changed' }).turns(2);
    const report = findCacheRewrites(s.messages);
    expect(report.rewrites.map((r) => r.cause)).toEqual(['system_changed', 'tools_changed', 'messages_changed']);
    const item = cacheItem(s.messages)!;
    expect(item.description).toContain('after earlier messages changed');
    expect(item.description).toContain('1 tool list change (');
    expect(item.description).toContain('1 system prompt change (');
    expect(item.recommendation).toContain('make such changes between tasks');
  });

  test('a diagnosed model switch names both models', () => {
    const s = new SessionBuilder().start(30_000).turns(10)
      .rewrite(1, { model: 'claude-sonnet-5', reason: 'model_changed', missedTokens: 60_000, stillCached: 0 }).turns(3, 4_000, { model: 'claude-sonnet-5' });
    const [r] = findCacheRewrites(s.messages).rewrites;
    expect(r!.cause).toBe('model_changed');
    expect(r!.fromModel).toBe('claude-opus-5-5');
    expect(r!.toModel).toBe('claude-sonnet-5');
    const item = cacheItem(s.messages)!;
    expect(item.description).toContain('after a model switch re-wrote');
    expect(item.description).toContain('(claude-opus-5-5 to claude-sonnet-5)');
    expect(item.recommendation).toContain('Each model has its own cache');
  });

  test('a model switch is inferred from the recorded models when no diagnosis names it', () => {
    const s = new SessionBuilder().start(30_000).turns(6).rewrite(1, { model: 'claude-sonnet-5', noDiagnostics: true, stillCached: 0 });
    expect(findCacheRewrites(s.messages).rewrites[0]!.cause).toBe('model_changed');
  });

  test('a diagnosed change wins over a gap past the TTL', () => {
    const s = new SessionBuilder().start(30_000).turns(6).rewrite(120, { reason: 'tools_changed' });
    expect(findCacheRewrites(s.messages).rewrites[0]!.cause).toBe('tools_changed');
  });

  test('a switch between the 5-minute and one-hour cache is a TTL change, pinned by promptCacheTtl', () => {
    const s = new SessionBuilder('claude-opus-5-5', '5m').start(30_000).turns(12).rewrite(1, { ttl: '1h' }).turns(3, 4_000, { ttl: '1h' });
    const [r] = findCacheRewrites(s.messages).rewrites;
    expect(r!.cause).toBe('ttl_changed');
    expect(r!.ttl).toBe('5m');
    expect(r!.writeTtl).toBe('1h');
    const item = cacheItem(s.messages)!;
    expect(item.description).toContain('after the cache TTL switched re-wrote');
    expect(item.description).toContain('(5 min to 1 h)');
    expect(item.recommendation).toContain('"promptCacheTtl" ("5m" or "1h")');
  });
});

describe('expected writes', () => {
  test('the first request never counts, however much it writes', () => {
    const s = new SessionBuilder().start(300_000).turns(3);
    expect(findCacheRewrites(s.messages).rewrites).toEqual([]);
  });

  test('the first request after a compaction is an expected write', () => {
    const s = new SessionBuilder().start(30_000).turns(10).compact(60_000).turns(3);
    const breakdown = classifySession(s.messages, EMPTY_CONFIG);
    expect(breakdown.compactionEvents.length).toBe(1);
    expect(breakdown.compactionEvents[0]!.firstLiveIndex).toBeDefined();
    expect(findCacheRewrites(s.messages, breakdown.compactionEvents, breakdown.messages.length).rewrites).toEqual([]);
    expect(cacheItem(s.messages)).toBeUndefined();
    // The same request without the compaction marker reads as a re-write.
    expect(findCacheRewrites(s.messages).rewrites.length).toBe(1);
  });

  test("each agent's requests are compared only with that agent's", () => {
    // A subagent's first request writes its own fresh prefix; set against
    // the main conversation's 70K prefix it would look like a re-write.
    const s = new SessionBuilder().start(30_000).turns(10)
      .start(40_000, { agentId: 'a1' }).turns(3, 2_000, { agentId: 'a1' })
      .turns(2);
    expect(findCacheRewrites(s.messages).rewrites).toEqual([]);
  });
});

describe('split lines', () => {
  test('a response written as several lines counts once', () => {
    const s = new SessionBuilder().start(30_000, { lines: 3 }).turns(10, 4_000, { lines: 3 })
      .rewrite(90, { lines: 3 }).turns(3, 4_000, { lines: 3 });
    const report = findCacheRewrites(s.messages);
    expect(report.requests).toBe(15);
    expect(report.cacheWriteTokens).toBe(30_000 + 13 * 4_000 + (70_000 - 25_000 + 4_000));
    // One re-write, not one per line: the later lines repeat the same
    // response and are not compared with its first line.
    expect(report.rewrites.length).toBe(1);
    expect(report.rewrites[0]!.tokens).toBe(70_000 - 25_000 + 4_000);
  });
});

describe('analysed range', () => {
  test('re-writes after the --until cutoff are not counted', () => {
    const s = expirySession();
    expect(cacheItem(s.messages)).toBeDefined();
    const firstRewrite = findCacheRewrites(s.messages).rewrites[0]!;
    expect(cacheItem(s.messages, firstRewrite.messageIndex)).toBeUndefined();
  });
});

describe('thresholds', () => {
  test('cacheRewriteThreshold defaults to a quarter of the cache writes', () => {
    expect(DEFAULT_WASTE_THRESHOLDS.cacheRewriteThreshold).toBe(0.25);
    expect(loadWasteThresholds().cacheRewriteThreshold).toBe(0.25);
  });

  test('cacheRewriteThreshold in config.json raises or lowers the bar', () => {
    const s = expirySession();
    writeFileSync(join(sandbox, 'config.json'), JSON.stringify({ wasteThresholds: { cacheRewriteThreshold: 0.9 } }), 'utf-8');
    expect(cacheItem(s.messages)).toBeUndefined();
    writeFileSync(join(sandbox, 'config.json'), JSON.stringify({ wasteThresholds: { cacheRewriteThreshold: 0.1 } }), 'utf-8');
    expect(cacheItem(s.messages)).toBeDefined();
  });

  test('an old cacheOverheadThreshold is ignored and noted under --verbose', () => {
    writeFileSync(join(sandbox, 'config.json'), JSON.stringify({ wasteThresholds: { cacheOverheadThreshold: 0.99 } }), 'utf-8');
    expect(loadWasteThresholds().cacheRewriteThreshold).toBe(0.25);
    expect(cacheItem(expirySession().messages)).toBeDefined();
    const notes = describeThresholdOverrides();
    expect(notes.some((n) => n.startsWith('cacheOverheadThreshold: ignored'))).toBe(true);
  });
});

describe('consumers', () => {
  /** Strip ANSI color codes from captured console output. */
  const stripAnsi = (s: string): string => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');

  test('the item never becomes a /compact focus target', () => {
    const item = cacheItem(expirySession().messages)!;
    expect(buildCompactFocus([item])).toBeNull();
    expect(compactCommandFor([item])).toBe('/compact');
  });

  test('reports and the waste view print no "~0 tokens" for it', () => {
    const messages = expirySession().messages;
    const breakdown = classifySession(messages, EMPTY_CONFIG);
    const waste = detectWaste(messages, breakdown, EMPTY_CONFIG);
    const item = waste.find((w) => w.type === 'cache_overhead')!;
    const result: AnalysisResult = {
      sessionId: 'abcdef1234567890',
      project: 'cache-fixture',
      messageCount: messages.length,
      breakdown,
      waste,
      recommendations: { recommendations: [], estimated_messages_until_compaction: null, context_health: 'healthy' },
      calibration: null,
      configData: EMPTY_CONFIG,
      messages,
    };
    const fix = { sessionPrompt: null, claudeMdSnippet: null, compactCommand: null };

    const md = generateSessionReportMd(result, fix);
    expect(md).toContain(`- **${item.description}**`);
    expect(md).not.toContain('(~0 tokens)');
    const html = generateSessionReport(result, fix);
    expect(html).toContain('cache re-writes after the cache expired');
    expect(html).not.toContain('<div class="waste-tokens">~0 tokens</div>');

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      renderWaste(waste, result.recommendations, breakdown.total_tokens);
    } finally {
      console.log = original;
    }
    const output = stripAnsi(lines.join('\n'));
    expect(output).toContain(`[INFO] ${item.description}`);
    expect(output).not.toContain('~0 tkns');
  });
});
