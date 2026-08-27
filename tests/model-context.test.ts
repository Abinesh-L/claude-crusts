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
  getNativeContextLimit,
  modelFamily,
  detectContextCommandWindow,
  detectSettingsContextLimit,
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

// ---------------------------------------------------------------------------
// v0.8.0 M13 — context-limit resolution: the full signal priority list
// ---------------------------------------------------------------------------

/** User record shaped like Claude Code's recorded /context output. */
function contextUsageRecord(tokensLine: string, extra: { asBlocks?: boolean } = {}) {
  const text = '## Context Usage\n\n**Model:** claude-fable-5  \n**Tokens:** ' + tokensLine
    + '\n\n### Estimated usage by category\n\n| Category | Tokens | Percentage |\n| System prompt | 4.1k | 0.4% |';
  return {
    type: 'user',
    message: {
      role: 'user',
      content: extra.asBlocks ? [{ type: 'text', text }] : text,
    },
  };
}

describe('M13 native-1M model table', () => {
  test('bare 5-generation families resolve to 1M', () => {
    for (const id of ['claude-fable-5', 'claude-mythos-5', 'claude-opus-5', 'claude-sonnet-5']) {
      expect(getNativeContextLimit(id)).toBe(1_000_000);
    }
  });

  test('4.x models and unknown ids have no native entry', () => {
    const ids: Array<string | undefined> = [
      'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001', 'some-future-model', undefined,
    ];
    for (const id of ids) {
      expect(getNativeContextLimit(id)).toBeNull();
    }
  });

  test('a variant suffix does not defeat the native match', () => {
    expect(getNativeContextLimit('claude-fable-5[1m]')).toBe(1_000_000);
  });
});

describe('M13 modelFamily', () => {
  test('strips the [1m] variant', () => {
    expect(modelFamily('claude-opus-4-8[1m]')).toBe('claude-opus-4-8');
  });

  test('strips a -1m suffix and lowercases', () => {
    expect(modelFamily('Claude-Opus-4-7-1m')).toBe('claude-opus-4-7');
  });

  test('bare ids are unchanged', () => {
    expect(modelFamily('claude-fable-5')).toBe('claude-fable-5');
  });
});

describe('M13 context-command signal (recorded /context output)', () => {
  test('parses the observed 500K window from the Tokens header', () => {
    expect(detectContextCommandWindow([contextUsageRecord('119.2k / 500k (24%)')])).toBe(500_000);
  });

  test('the latest record wins over earlier ones', () => {
    const messages = [contextUsageRecord('55.4k / 1m (6%)'), contextUsageRecord('90k / 200k (45%)')];
    expect(detectContextCommandWindow(messages)).toBe(200_000);
  });

  test('text-block content parses like string content', () => {
    expect(detectContextCommandWindow([contextUsageRecord('100k / 500k (20%)', { asBlocks: true })])).toBe(500_000);
  });

  test('assistant text containing the marker is ignored', () => {
    const assistantEcho = {
      type: 'assistant',
      message: { role: 'assistant', content: '## Context Usage\n**Tokens:** 1k / 1m (0%)' },
    };
    expect(detectContextCommandWindow([assistantEcho])).toBeNull();
  });

  test('user text with a Tokens header but no marker start is ignored', () => {
    const paste = { type: 'user', message: { role: 'user', content: 'look at this:\n**Tokens:** 419.2k / 1m (42%)' } };
    expect(detectContextCommandWindow([paste])).toBeNull();
  });
});

describe('M13 settings signal', () => {
  test('a [1m] settings model promotes a bare session model of the same family', () => {
    expect(detectSettingsContextLimit('claude-opus-4-8', ['claude-opus-4-8[1m]'])).toBe(1_000_000);
  });

  test('a different-family settings model is ignored', () => {
    expect(detectSettingsContextLimit('claude-opus-4-8', ['claude-fable-5[1m]'])).toBeNull();
  });

  test('the highest-precedence family match decides; a bare model is not a signal', () => {
    expect(detectSettingsContextLimit('claude-opus-4-8', ['claude-opus-4-8', 'claude-opus-4-8[1m]'])).toBeNull();
  });

  test('empty and undefined inputs yield no signal', () => {
    expect(detectSettingsContextLimit('claude-opus-4-8', [])).toBeNull();
    expect(detectSettingsContextLimit(undefined, ['claude-opus-4-8[1m]'])).toBeNull();
    expect(detectSettingsContextLimit('claude-opus-4-8', undefined)).toBeNull();
  });

  test('a bare settings alias names the family (opus[1m] covers claude-opus-4-8 and claude-opus-5)', () => {
    expect(detectSettingsContextLimit('claude-opus-4-8', ['opus[1m]'])).toBe(1_000_000);
    expect(detectSettingsContextLimit('claude-opus-5', ['opus[1m]'])).toBe(1_000_000);
    expect(detectSettingsContextLimit('claude-fable-5', ['fable[1m]'])).toBe(1_000_000);
  });

  test('an alias of a different family, or a longer alias, never matches', () => {
    expect(detectSettingsContextLimit('claude-fable-5', ['opus[1m]'])).toBeNull();
    expect(detectSettingsContextLimit('claude-opus-4-8', ['opusplan[1m]'])).toBeNull();
    expect(detectSettingsContextLimit('claude-opus-4-8', ['op[1m]'])).toBeNull();
  });
});

describe('M13 resolveContextLimitWithSignal priority order', () => {
  test('payload override outranks every other signal and is a free integer', () => {
    const messages = [contextUsageRecord('300k / 1m (30%)'), msg(6, 0, 250_000)];
    expect(resolveContextLimitWithSignal('claude-opus-4-7[1m]', messages, { limitOverride: 500_000 }))
      .toEqual({ limit: 500_000, signal: 'payload' });
  });

  test('zero, negative, and non-finite overrides are ignored', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveContextLimitWithSignal('claude-opus-4-7', [], { limitOverride: bad }).signal).toBe('default');
    }
  });

  test('context-command outranks model-id', () => {
    expect(resolveContextLimitWithSignal('claude-opus-4-7[1m]', [contextUsageRecord('55.4k / 200k (28%)')]))
      .toEqual({ limit: 200_000, signal: 'context-command' });
  });

  test('the observed 500K window resolves via context-command', () => {
    expect(resolveContextLimitWithSignal('claude-fable-5', [contextUsageRecord('119.2k / 500k (24%)')]))
      .toEqual({ limit: 500_000, signal: 'context-command' });
  });

  test('model-id [1m] still resolves on its own', () => {
    expect(resolveContextLimitWithSignal('claude-opus-4-7[1m]', []))
      .toEqual({ limit: 1_000_000, signal: 'model-id' });
  });

  test('settings [1m] promotes a bare opus-4-8 session and outranks usage', () => {
    expect(resolveContextLimitWithSignal('claude-opus-4-8', [msg(6, 0, 250_000)], { settingsModels: ['claude-opus-4-8[1m]'] }))
      .toEqual({ limit: 1_000_000, signal: 'settings' });
    expect(resolveContextLimitWithSignal('claude-opus-4-8', [], { settingsModels: ['claude-opus-4-8[1m]'] }))
      .toEqual({ limit: 1_000_000, signal: 'settings' });
  });

  test('a settings alias promotes a bare 4.x session of that family', () => {
    expect(resolveContextLimitWithSignal('claude-opus-4-8', [], { settingsModels: ['opus[1m]'] }))
      .toEqual({ limit: 1_000_000, signal: 'settings' });
  });

  test('usage above 200K outranks the native table', () => {
    expect(resolveContextLimitWithSignal('claude-fable-5', [msg(6, 0, 250_000)]))
      .toEqual({ limit: 1_000_000, signal: 'usage' });
  });

  test('bare fable-5 resolves to native 1M without any usage', () => {
    expect(resolveContextLimitWithSignal('claude-fable-5', []))
      .toEqual({ limit: 1_000_000, signal: 'native' });
  });

  test('bare 4.x models stay at 200K without a signal', () => {
    for (const id of ['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-4-6']) {
      expect(resolveContextLimitWithSignal(id, [msg(6, 0, 100_000)]))
        .toEqual({ limit: DEFAULT_CONTEXT_LIMIT, signal: 'default' });
    }
  });

  test('back-compat wrapper threads options through', () => {
    expect(resolveContextLimit('claude-opus-4-7', [], { limitOverride: 300_000 })).toBe(300_000);
  });
});
