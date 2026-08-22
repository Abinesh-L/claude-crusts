import { describe, test, expect } from 'bun:test';
import {
  getContextLimit,
  detectContextLimitFromUsage,
  resolveContextLimit,
  resolveContextLimitWithSignal,
  effectiveInput,
  cacheCreationTokens,
  DEFAULT_CONTEXT_LIMIT,
  MODEL_CONTEXT_LIMITS,
} from '../src/model-context.ts';

function msg(input: number, cacheCreation = 0, cacheRead = 0) {
  return { message: { usage: { input_tokens: input, cache_creation_input_tokens: cacheCreation, cache_read_input_tokens: cacheRead } } };
}

describe('getContextLimit', () => {
  test('1M bracketed variant (lowercase)', () => {
    expect(getContextLimit('claude-opus-4-7[1m]')).toBe(1_000_000);
  });

  test('1M bracketed variant (uppercase M)', () => {
    expect(getContextLimit('claude-opus-4-7[1M]')).toBe(1_000_000);
  });

  test('1M hyphen-suffix variant', () => {
    expect(getContextLimit('claude-opus-4-7-1m')).toBe(1_000_000);
  });

  test('standard Sonnet 4.6 falls through to 200K', () => {
    expect(getContextLimit('claude-sonnet-4-6')).toBe(200_000);
  });

  test('standard Opus 4.7 (no variant) falls through to 200K', () => {
    expect(getContextLimit('claude-opus-4-7')).toBe(200_000);
  });

  test('standard Haiku falls through to 200K', () => {
    expect(getContextLimit('claude-haiku-4-5-20251001')).toBe(200_000);
  });

  test('undefined returns default', () => {
    expect(getContextLimit(undefined)).toBe(DEFAULT_CONTEXT_LIMIT);
  });

  test('empty string returns default', () => {
    expect(getContextLimit('')).toBe(DEFAULT_CONTEXT_LIMIT);
  });

  test('synthetic marker returns default', () => {
    expect(getContextLimit('<synthetic>')).toBe(DEFAULT_CONTEXT_LIMIT);
  });

  test('unknown model returns default', () => {
    expect(getContextLimit('some-future-model')).toBe(DEFAULT_CONTEXT_LIMIT);
  });
});

describe('detectContextLimitFromUsage', () => {
  test('empty messages returns default', () => {
    expect(detectContextLimitFromUsage([])).toBe(DEFAULT_CONTEXT_LIMIT);
  });

  test('all messages under 200K returns default', () => {
    expect(detectContextLimitFromUsage([msg(6, 8000, 120_000), msg(6, 0, 50_000)])).toBe(DEFAULT_CONTEXT_LIMIT);
  });

  test('any message exceeding 200K promotes to 1M', () => {
    expect(detectContextLimitFromUsage([msg(6, 0, 100_000), msg(6, 0, 350_000)])).toBe(1_000_000);
  });

  test('sum of input + cache_creation + cache_read counts', () => {
    // 6 + 100_000 + 150_000 = 250_006 > 200_000
    expect(detectContextLimitFromUsage([msg(6, 100_000, 150_000)])).toBe(1_000_000);
  });

  test('messages without usage are ignored', () => {
    expect(detectContextLimitFromUsage([{ message: {} }, msg(6, 0, 50_000)])).toBe(DEFAULT_CONTEXT_LIMIT);
  });
});

describe('resolveContextLimit', () => {
  test('takes model ID when variant is preserved', () => {
    expect(resolveContextLimit('claude-opus-4-7[1m]', [msg(6, 0, 1000)])).toBe(1_000_000);
  });

  test('falls back to usage when variant is stripped', () => {
    expect(resolveContextLimit('claude-opus-4-7', [msg(6, 0, 500_000)])).toBe(1_000_000);
  });

  test('standard session stays at 200K', () => {
    expect(resolveContextLimit('claude-sonnet-4-6', [msg(6, 0, 100_000)])).toBe(DEFAULT_CONTEXT_LIMIT);
  });

  test('undefined model + small usage returns default', () => {
    expect(resolveContextLimit(undefined, [])).toBe(DEFAULT_CONTEXT_LIMIT);
  });
});

describe('MODEL_CONTEXT_LIMITS table', () => {
  test('contains at least the 1M entry', () => {
    expect(MODEL_CONTEXT_LIMITS.length).toBeGreaterThanOrEqual(1);
    expect(MODEL_CONTEXT_LIMITS.some((e) => e.limit === 1_000_000)).toBe(true);
  });

  test('DEFAULT_CONTEXT_LIMIT is 200K', () => {
    expect(DEFAULT_CONTEXT_LIMIT).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
// v0.8.0 M4 — shared effectiveInput() reconciles flat vs nested cache_creation
// ---------------------------------------------------------------------------

describe('effectiveInput (M4 usage drift)', () => {
  test('flat cache_creation 0 with ephemeral_1h 815,917 yields 815,917 (real 24b8260b:2371 shape)', () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 815_917 },
    };
    expect(cacheCreationTokens(usage)).toBe(815_917);
    expect(effectiveInput(usage)).toBe(815_917);
  });

  test('flat and nested agree: input + cache_creation + cache_read', () => {
    const usage = {
      input_tokens: 2,
      output_tokens: 447,
      cache_creation_input_tokens: 18_938,
      cache_read_input_tokens: 35_299,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 18_938 },
    };
    expect(effectiveInput(usage)).toBe(54_239);
  });

  test('takes the larger of flat and nested when they disagree in either direction', () => {
    expect(effectiveInput({
      input_tokens: 10,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 90 },
    })).toBe(10 + 120 + 5);
    expect(effectiveInput({
      input_tokens: 10,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 90 },
    })).toBe(10 + 200 + 5);
  });

  test('legacy flat-only usage still sums the three fields', () => {
    expect(effectiveInput({ input_tokens: 6, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 120_000 })).toBe(128_006);
  });

  test('missing usage, missing fields, and non-finite values count as 0', () => {
    expect(effectiveInput(undefined)).toBe(0);
    expect(effectiveInput({})).toBe(0);
    expect(cacheCreationTokens(undefined)).toBe(0);
    expect(effectiveInput({ input_tokens: Number.NaN, cache_read_input_tokens: -5 })).toBe(0);
  });

  test('usage heuristic promotes to 1M on nested-only cache_creation above 200K', () => {
    const nestedOnly = {
      message: {
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 815_917 },
        },
      },
    };
    expect(detectContextLimitFromUsage([nestedOnly])).toBe(1_000_000);
    expect(resolveContextLimitWithSignal('claude-fable-5', [nestedOnly])).toEqual({ limit: 1_000_000, signal: 'usage' });
  });
});
