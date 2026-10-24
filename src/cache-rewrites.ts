/**
 * Prompt-cache re-write detection.
 *
 * Claude Code re-sends the whole conversation on every request, and the API
 * serves the unchanged prefix from its prompt cache at about a tenth of the
 * input price. Cache READS are therefore the healthy case: 95-97% of a
 * session's input is normal. The avoidable cost is a cache WRITE that repeats
 * content the previous request had already cached, because the cache expired
 * (5-minute or 1-hour TTL) or the prompt prefix changed (model, system
 * prompt, tools, earlier messages), so most of the prefix was billed again at
 * the cache-write price.
 *
 * `findCacheRewrites` walks one transcript's API requests (split lines
 * folded by `message.id`, one chain per agent), finds the requests that wrote
 * most of the previous request's cached prefix again, and names a cause for
 * each from the API's own diagnosis (`message.diagnostics.cache_miss_reason`,
 * recorded since Claude Code 2.1.214), the gap since that agent's previous
 * request, and the model and cache TTL both requests recorded.
 */

import type { SessionMessage, CompactionEvent } from './types.ts';
import type { UsageLike } from './model-context.ts';
import { cacheCreationTokens, effectiveInput, isZeroedUsageCopy } from './model-context.ts';
import { assistantGroupKey } from './classifier.ts';

/** Lifetime tier of a prompt-cache write. */
export type CacheTtl = '5m' | '1h';

/** How long a cache entry of each tier lives without being used, in ms. */
export const CACHE_TTL_MS: Readonly<Record<CacheTtl, number>> = {
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
};

/**
 * Share of the previous request's cached prefix a request must write again
 * to count as a re-write ("most of its prefix"). An ordinary turn writes only
 * the latest exchange, a few percent of the prefix; every re-write the API
 * diagnosed on real transcripts wrote 60-100% of it again. A large new tool
 * result is new content, not a re-write: the prefix before it is still read
 * from the cache, so it stays below this share.
 */
export const REWRITE_PREFIX_SHARE = 0.5;

/** Diagnosed reasons that locate a change in the prompt prefix. */
const PREFIX_CHANGE_REASONS: ReadonlySet<string> = new Set([
  'model_changed',
  'system_changed',
  'tools_changed',
  'messages_changed',
]);

/**
 * Why a request wrote the cached prefix again.
 *
 * - `expired`: the gap since that agent's previous request exceeded the TTL
 *   of the cache entry it could have read
 * - `model_changed` / `system_changed` / `tools_changed` / `messages_changed`:
 *   the API diagnosed that part of the prefix as changed (a model switch is
 *   also inferred from the recorded models when no diagnosis names one)
 * - `ttl_changed`: no diagnosis and no expiry, but the request wrote with a
 *   different TTL tier than the cache entry it followed (5 minutes vs 1 hour)
 * - `unexplained`: nothing recorded explains it
 */
export type CacheRewriteCause =
  | 'expired'
  | 'model_changed'
  | 'system_changed'
  | 'tools_changed'
  | 'messages_changed'
  | 'ttl_changed'
  | 'unexplained';

/** One API request whose cache write repeated most of an already-cached prefix. */
export interface CacheRewrite {
  /** Index of the response's first line in the messages array */
  messageIndex: number;
  /** Why the prefix was written again */
  cause: CacheRewriteCause;
  /** Cache-write tokens the request was billed for (usage cache_creation) */
  tokens: number;
  /**
   * Time since that agent's previous request was sent (ms), or undefined
   * when the records carry no timestamps. A cache entry's TTL runs from its
   * last use, which was that request.
   */
  gapMs?: number;
  /** TTL of the cache entry the request could have read */
  ttl: CacheTtl;
  /** TTL tier this request wrote with, when its usage records the split */
  writeTtl?: CacheTtl;
  /** `cache_miss_reason.type` the API reported for this request, if any */
  reportedReason?: string;
  /** Model of the previous request, when it differs from this one's */
  fromModel?: string;
  /** Model of this request, when it differs from the previous one's */
  toModel?: string;
  /** True when a subagent made the request (a sidechain record) */
  subagent?: boolean;
}

/** Cache accounting for one transcript (requests counted once per API response). */
export interface CacheRewriteReport {
  /** Requests that re-wrote most of the cached prefix, in message order */
  rewrites: CacheRewrite[];
  /** Cache-write tokens across every counted request, re-writes included */
  cacheWriteTokens: number;
  /** Cache-read tokens across every counted request */
  cacheReadTokens: number;
  /** Effective input (uncached + cache write + cache read) across every counted request */
  inputTokens: number;
  /** API requests counted (split lines folded, zeroed copies skipped) */
  requests: number;
}

/** One API request: the split lines of one response folded together. */
interface ApiRequest {
  /** Index of the response's first line */
  index: number;
  /** Agent chain the request belongs to (`main`, or a subagent's id) */
  agent: string;
  /** Model recorded on the response */
  model?: string;
  /** Final usage of the response (every split line repeats it) */
  usage: UsageLike;
  /** Diagnosed miss reason; null when none was reported; undefined when not recorded */
  reason?: string | null;
  /** When the request was sent (ms), best estimate */
  sentMs?: number;
  /** First live request after a compaction, whose write is expected */
  freshWindow: boolean;
}

/**
 * Coerce a usage field to a finite non-negative number.
 *
 * @param value - Raw field value from the JSONL
 * @returns The value, or 0 when it is missing, NaN, infinite, or negative
 */
function tokenField(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The agent chain a record belongs to. The main conversation and each
 * subagent keep their own cache, so a request is compared only with the
 * previous request of the same agent.
 *
 * @param msg - Session record
 * @returns `main`, or `agent:<id>` for sidechain records
 */
function agentOf(msg: SessionMessage): string {
  return msg.isSidechain ? `agent:${msg.agentId ?? ''}` : 'main';
}

/**
 * Parse a record's ISO timestamp.
 *
 * @param msg - Session record
 * @returns Milliseconds since the epoch, or undefined when absent or invalid
 */
function timestampMs(msg: SessionMessage): number | undefined {
  if (!msg.timestamp) return undefined;
  const ms = Date.parse(msg.timestamp);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * TTL tier a request wrote its cache with: one hour when the nested usage
 * breakdown records ephemeral_1h tokens, five minutes when it records
 * ephemeral_5m tokens.
 *
 * @param usage - Usage of one request
 * @returns The tier, or undefined when the request wrote nothing or the
 *   breakdown is absent (Claude Code before 2.1.1xx)
 */
function writeTtlOf(usage: UsageLike): CacheTtl | undefined {
  if (tokenField(usage.cache_creation?.ephemeral_1h_input_tokens) > 0) return '1h';
  if (tokenField(usage.cache_creation?.ephemeral_5m_input_tokens) > 0) return '5m';
  return undefined;
}

/**
 * The cache-miss reason the API reported on one assistant line.
 *
 * @param msg - Assistant record
 * @returns The reason type; null when the line records diagnostics without a
 *   reason (no divergence found, or the comparison was still running);
 *   undefined when the line has no diagnostics field (before 2.1.214)
 */
function reportedReason(msg: SessionMessage): string | null | undefined {
  const message = msg.message;
  if (!message || !('diagnostics' in message)) return undefined;
  const type = message.diagnostics?.cache_miss_reason?.type;
  return typeof type === 'string' && type.length > 0 ? type : null;
}

/**
 * Attachments Claude Code stamps with the response's own time, written just
 * before its first line: they say when the response arrived, not when the
 * request was sent.
 */
const RESPONSE_TIME_ATTACHMENTS = new Set(['deferred_tools_record']);

/**
 * When a request was sent: the newest input its agent recorded since its
 * previous response that is older than the response's first line, else the
 * first line itself. The newest, not the last in file order: a queued
 * command is written after the tool result but keeps the time it was queued.
 *
 * @param inputs - Timestamps (ms) of the agent's inputs since its previous response
 * @param firstLineMs - Timestamp of the response's first line
 * @returns The send time, or undefined when nothing carries a timestamp
 */
function sendTime(inputs: number[] | undefined, firstLineMs: number | undefined): number | undefined {
  let newest: number | undefined;
  for (const ms of inputs ?? []) {
    if (firstLineMs !== undefined && ms >= firstLineMs) continue;
    if (newest === undefined || ms > newest) newest = ms;
  }
  return newest ?? firstLineMs;
}

/**
 * Fold the analysed records into API requests, in order.
 *
 * Split lines of one response (same `message.id`, else `requestId`, the
 * classifier's grouping) count once. `<synthetic>` placeholders, zeroed usage
 * copies and records without input are skipped: they describe no request.
 * A request's send time comes from the prompts, tool results and attachments
 * its agent recorded after its previous response (Claude Code writes them
 * just before sending; see `sendTime`), leaving out the attachments stamped
 * at response time (`RESPONSE_TIME_ATTACHMENTS`).
 *
 * @param messages - Parsed session messages
 * @param end - Exclusive end of the analysed range
 * @param freshWindowLines - First live assistant line after each compaction
 * @returns Requests in message order
 */
function collectRequests(messages: SessionMessage[], end: number, freshWindowLines: ReadonlySet<number>): ApiRequest[] {
  const requests: ApiRequest[] = [];
  const byKey = new Map<string, ApiRequest>();
  const inputsMs = new Map<string, number[]>();

  for (let i = 0; i < end; i++) {
    const msg = messages[i]!;
    const agent = agentOf(msg);
    if (msg.type === 'user' || msg.type === 'attachment') {
      if (msg.type === 'attachment' && RESPONSE_TIME_ATTACHMENTS.has(msg.attachment?.type ?? '')) continue;
      const ms = timestampMs(msg);
      if (ms !== undefined) {
        const inputs = inputsMs.get(agent);
        if (inputs) inputs.push(ms);
        else inputsMs.set(agent, [ms]);
      }
      continue;
    }
    if (msg.type !== 'assistant') continue;
    const usage = msg.message?.usage;
    if (!usage || msg.message?.model === '<synthetic>') continue;
    if (isZeroedUsageCopy(usage) || effectiveInput(usage) === 0) continue;

    const key = assistantGroupKey(msg) ?? `line:${i}`;
    let request = byKey.get(key);
    if (!request) {
      request = {
        index: i,
        agent,
        model: msg.message?.model,
        usage,
        sentMs: sendTime(inputsMs.get(agent), timestampMs(msg)),
        freshWindow: false,
      };
      byKey.set(key, request);
      requests.push(request);
    }
    if (freshWindowLines.has(i)) request.freshWindow = true;
    const reason = reportedReason(msg);
    if (reason !== undefined && typeof request.reason !== 'string') request.reason = reason;
    inputsMs.delete(agent);
  }

  return requests;
}

/**
 * Name the cause of one re-write.
 *
 * Order of evidence:
 *   1. A diagnosed `*_changed` reason: the API located the change.
 *   2. A gap over the TTL of the entry the request could have read: the
 *      entry had expired. `previous_message_not_found` and `unavailable`
 *      mean the API produced no comparison, so they count as an expiry only
 *      through this test; a diagnosis of `null` means the requests matched
 *      but the entry was gone, which the gap explains the same way.
 *   3. A different model from the previous request (each model has its own
 *      cache), for records without a model_changed diagnosis.
 *   4. A different TTL tier from the entry it followed: the writes switched
 *      between the 5-minute and the 1-hour cache.
 *   5. Otherwise unexplained.
 *
 * @param request - The re-writing request
 * @param previous - That agent's previous request
 * @param tokens - Cache-write tokens of the request
 * @param entryTtl - Tier of that agent's latest earlier cache write, if known
 * @param writeTtl - Tier this request wrote with, if known
 * @returns The classified re-write
 */
function classifyRewrite(
  request: ApiRequest,
  previous: ApiRequest,
  tokens: number,
  entryTtl: CacheTtl | undefined,
  writeTtl: CacheTtl | undefined,
): CacheRewrite {
  const ttl = entryTtl ?? writeTtl ?? '5m';
  const gapMs = request.sentMs !== undefined && previous.sentMs !== undefined
    ? Math.max(0, request.sentMs - previous.sentMs)
    : undefined;
  const reason = typeof request.reason === 'string' ? request.reason : undefined;
  const modelChanged = previous.model !== undefined && request.model !== undefined && previous.model !== request.model;

  let cause: CacheRewriteCause;
  if (reason !== undefined && PREFIX_CHANGE_REASONS.has(reason)) cause = reason as CacheRewriteCause;
  else if (gapMs !== undefined && gapMs > CACHE_TTL_MS[ttl]) cause = 'expired';
  else if (modelChanged) cause = 'model_changed';
  else if (entryTtl !== undefined && writeTtl !== undefined && entryTtl !== writeTtl) cause = 'ttl_changed';
  else cause = 'unexplained';

  return {
    messageIndex: request.index,
    cause,
    tokens,
    ttl,
    ...(gapMs !== undefined ? { gapMs } : {}),
    ...(writeTtl !== undefined ? { writeTtl } : {}),
    ...(reason !== undefined ? { reportedReason: reason } : {}),
    ...(modelChanged ? { fromModel: previous.model, toModel: request.model } : {}),
    ...(request.agent !== 'main' ? { subagent: true } : {}),
  };
}

/**
 * Find the requests in a transcript that wrote an already-cached prompt
 * prefix again.
 *
 * A request is a re-write when the prefix its agent's previous request left
 * in the cache (that request's cache reads plus writes) was mostly not read
 * back: at least `REWRITE_PREFIX_SHARE` of it was written again, measured as
 * min(cache write, prefix - cache read), so new content a turn appends never
 * counts. Each agent's first request and the first live request after each
 * compaction are expected writes and never count. A re-write is sized by the
 * cache-write tokens its usage records: diagnostics'
 * `cache_missed_input_tokens` is a byte-derived magnitude, not a billed count.
 *
 * @param messages - Parsed session messages (`parseSession`)
 * @param compactionEvents - The session's compactions (`firstLiveIndex` marks
 *   each fresh window's first request)
 * @param endIndex - Exclusive end of the analysed range (`--until`, auto-trim)
 * @returns Re-writes with causes, plus the cache totals they are measured against
 */
export function findCacheRewrites(
  messages: SessionMessage[],
  compactionEvents: readonly CompactionEvent[] = [],
  endIndex: number = messages.length,
): CacheRewriteReport {
  const end = Math.max(0, Math.min(endIndex, messages.length));
  const freshWindowLines = new Set<number>();
  for (const event of compactionEvents) {
    if (event.firstLiveIndex !== undefined) freshWindowLines.add(event.firstLiveIndex);
  }

  const requests = collectRequests(messages, end, freshWindowLines);
  const rewrites: CacheRewrite[] = [];
  const previousByAgent = new Map<string, ApiRequest>();
  const entryTtlByAgent = new Map<string, CacheTtl>();
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let inputTokens = 0;

  for (const request of requests) {
    const written = cacheCreationTokens(request.usage);
    const read = tokenField(request.usage.cache_read_input_tokens);
    cacheWriteTokens += written;
    cacheReadTokens += read;
    inputTokens += effectiveInput(request.usage);

    const previous = previousByAgent.get(request.agent);
    const entryTtl = entryTtlByAgent.get(request.agent);
    const writeTtl = writeTtlOf(request.usage);
    if (previous && !request.freshWindow) {
      // The previous request's whole prompt sits in the cache (Claude Code
      // puts a breakpoint at its end), whether it was read or written then.
      const carried = cacheCreationTokens(previous.usage) + tokenField(previous.usage.cache_read_input_tokens);
      const rewritten = Math.min(written, Math.max(0, carried - read));
      if (carried > 0 && rewritten >= carried * REWRITE_PREFIX_SHARE) {
        rewrites.push(classifyRewrite(request, previous, written, entryTtl, writeTtl));
      }
    }
    previousByAgent.set(request.agent, request);
    if (writeTtl !== undefined) entryTtlByAgent.set(request.agent, writeTtl);
  }

  return { rewrites, cacheWriteTokens, cacheReadTokens, inputTokens, requests: requests.length };
}
