import { describe, test, expect } from 'bun:test';
import {
  getContextLimit,
  detectContextLimitFromUsage,
  resolveContextLimit,
  resolveContextLimitWithSignal,
  effectiveInput,
  cacheCreationTokens,
  isZeroedUsageCopy,
  DEFAULT_CONTEXT_LIMIT,
  MODEL_CONTEXT_LIMITS,
  getNativeContextLimit,
  parseClaudeModelId,
  resolveCompactionModel,
  latestCacheTtl,
  modelFamily,
  detectContextCommandWindow,
  detectSettingsContextLimit,
  tokenizerFactor,
  NEWER_TOKENIZER_FACTOR,
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
function contextUsageRecord(tokensLine: string, extra: { asBlocks?: boolean; model?: string } = {}) {
  const text = '## Context Usage\n\n**Model:** ' + (extra.model ?? 'claude-fable-5') + '  \n**Tokens:** ' + tokensLine
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

  test('models that need a [1m] variant, and unknown ids, have no native entry', () => {
    // Claude Code model-config docs: Opus 4.6 and Sonnet 4.6 run at 200K
    // without the [1m] variant.
    const ids: Array<string | undefined> = [
      'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
      'some-future-model', undefined,
    ];
    for (const id of ids) {
      expect(getNativeContextLimit(id)).toBeNull();
    }
  });

  test('Opus 4.7 and later, Sonnet 5 and later, Haiku 5.5 and Fable are natively 1M', () => {
    // "Fable 5.1, Fable 5, Sonnet 5 and later, Haiku 5.5, and Opus 4.7 and
    // later get the 1M window with no [1m] variant to select."
    const ids = [
      'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5',
      'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
      'claude-fable-5', 'claude-fable-5-1',
    ];
    for (const id of ids) {
      expect(getNativeContextLimit(id)).toBe(1_000_000);
    }
  });

  test('a variant suffix does not defeat the native match', () => {
    expect(getNativeContextLimit('claude-fable-5[1m]')).toBe(1_000_000);
  });

  test('5-generation point releases and dated IDs resolve to 1M', () => {
    // Real IDs from Claude Code 2.1.28x-2.1.300 transcripts: these ran
    // sessions past 800K effective input, so their window is 1M.
    const ids = [
      'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5',
      'claude-opus-5-5[1m]', 'claude-fable-5-1-20261001', 'claude-opus-5-20260115',
    ];
    for (const id of ids) {
      expect(getNativeContextLimit(id)).toBe(1_000_000);
    }
  });

  test('IDs that do not parse as a Claude model version stay off the native table', () => {
    for (const id of ['claude-opus-5x', 'claude-opus-5-mini', 'claude-opus-5-123', 'opus-5-5', 'claude-haiku-4-4']) {
      expect(getNativeContextLimit(id)).toBeNull();
    }
  });

  test('parseClaudeModelId reads family, major and minor', () => {
    expect(parseClaudeModelId('claude-opus-5-5')).toEqual({ family: 'opus', major: 5, minor: 5 });
    expect(parseClaudeModelId('claude-fable-5')).toEqual({ family: 'fable', major: 5, minor: 0 });
    expect(parseClaudeModelId('claude-haiku-4-5-20251001')).toEqual({ family: 'haiku', major: 4, minor: 5 });
    expect(parseClaudeModelId('claude-opus-4-8[1m]')).toEqual({ family: 'opus', major: 4, minor: 8 });
    expect(parseClaudeModelId('claude-opus-5-mini')).toBeNull();
    expect(parseClaudeModelId(undefined)).toBeNull();
  });

  test('CLAUDE_CODE_DISABLE_1M_CONTEXT holds a native-1M model at 200K', () => {
    expect(resolveContextLimitWithSignal('claude-opus-5-5', [], { disable1m: true }))
      .toEqual({ limit: 200_000, signal: 'disable-1m' });
    // A recorded /context output still wins: it is the window Claude Code measured.
    const measured = contextUsageRecord('300k / 1m (30%)', { model: 'claude-opus-5-5' });
    expect(resolveContextLimitWithSignal('claude-opus-5-5', [measured], { disable1m: true }).signal)
      .toBe('context-command');
  });

  test('a dotted 5-generation session under 200K resolves natively, not to the default', () => {
    expect(resolveContextLimitWithSignal('claude-opus-5-5', []))
      .toEqual({ limit: 1_000_000, signal: 'native' });
  });
});

describe('0.8.1 /context outputs are matched to the model they measured', () => {
  test('a /context output from another model family is skipped', () => {
    const fable = contextUsageRecord('300k / 1m (30%)', { model: 'claude-fable-5-1' });
    expect(detectContextCommandWindow([fable], 'claude-opus-4-6')).toBeNull();
    expect(resolveContextLimitWithSignal('claude-opus-4-6', [fable]).signal).toBe('default');
  });

  test('the same family matches across a [1m] variant and without a model filter', () => {
    const opus = contextUsageRecord('287.3k / 1m (29%)', { model: 'claude-opus-4-8[1m]' });
    expect(detectContextCommandWindow([opus], 'claude-opus-4-8')).toBe(1_000_000);
    expect(detectContextCommandWindow([opus])).toBe(1_000_000);
  });

  test('the newest matching output wins over a newer one from another model', () => {
    const opus = contextUsageRecord('177.2k / 1m (18%)', { model: 'claude-opus-4-8' });
    const other = contextUsageRecord('55.4k / 200k (28%)', { model: 'claude-sonnet-4-6' });
    expect(detectContextCommandWindow([opus, other], 'claude-opus-4-8')).toBe(1_000_000);
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
      expect(resolveContextLimitWithSignal('claude-opus-4-6', [], { limitOverride: bad }).signal).toBe('default');
    }
  });

  test('context-command outranks model-id', () => {
    expect(resolveContextLimitWithSignal('claude-opus-4-7[1m]', [contextUsageRecord('55.4k / 200k (28%)', { model: 'claude-opus-4-7[1m]' })]))
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

  test('Opus 4.6, Sonnet 4.6 and Haiku 4.5 stay at 200K without a signal', () => {
    for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']) {
      expect(resolveContextLimitWithSignal(id, [msg(6, 0, 100_000)]))
        .toEqual({ limit: DEFAULT_CONTEXT_LIMIT, signal: 'default' });
    }
  });

  test('Opus 4.7 and 4.8 resolve to their native 1M without a signal', () => {
    for (const id of ['claude-opus-4-7', 'claude-opus-4-8']) {
      expect(resolveContextLimitWithSignal(id, [msg(6, 0, 100_000)]))
        .toEqual({ limit: 1_000_000, signal: 'native' });
    }
  });

  test('back-compat wrapper threads options through', () => {
    expect(resolveContextLimit('claude-opus-4-7', [], { limitOverride: 300_000 })).toBe(300_000);
  });
});

describe('0.8.1 resolveCompactionModel', () => {
  test("defaults: the trigger is the window minus 33K and idle compaction applies from 200K", () => {
    const m = resolveCompactionModel(1_000_000, 'claude-opus-5-5', 350_000);
    expect(m.trigger).toBe(967_000);
    expect(m.autoCompactWindow).toBe(1_000_000);
    expect(m.windowSource).toBe('default');
    expect(m.bufferTokens).toBe(33_000);
    expect(m.idle).toEqual({ enabled: true, minTokens: 200_000, afterMinutes: 54, cacheTtl: 'unknown', applies: true });
    expect(resolveCompactionModel(200_000, 'claude-opus-4-6', 50_000).trigger).toBe(167_000);
  });

  test('idle compaction does not apply under its threshold, or when it is off', () => {
    expect(resolveCompactionModel(1_000_000, 'claude-opus-5-5', 150_000).idle.applies).toBe(false);
    const off = resolveCompactionModel(1_000_000, 'claude-opus-5-5', 600_000, {
      autoCompactEnabled: true, idleCompaction: false, idleCompactMinTokens: 200_000, disable1m: false,
    });
    expect(off.idle.enabled).toBe(false);
    expect(off.idle.applies).toBe(false);
    expect(off.trigger).toBe(967_000);
  });

  test('auto-compact windows: env beats the per-model window, which beats the top level; all capped at the window', () => {
    const base = { autoCompactEnabled: true, idleCompaction: true, idleCompactMinTokens: 200_000, disable1m: false };
    const settings = { ...base, autoCompactWindow: 500_000, modelAutoCompactWindows: { 'claude-opus-5-5': 400_000 } };
    expect(resolveCompactionModel(1_000_000, 'claude-opus-5-5', 0, settings))
      .toMatchObject({ autoCompactWindow: 400_000, windowSource: 'model-setting', trigger: 367_000 });
    expect(resolveCompactionModel(1_000_000, 'claude-fable-5-1', 0, settings))
      .toMatchObject({ autoCompactWindow: 500_000, windowSource: 'setting', trigger: 467_000 });
    expect(resolveCompactionModel(1_000_000, 'claude-opus-5-5', 0, { ...settings, envAutoCompactWindow: 300_000 }))
      .toMatchObject({ autoCompactWindow: 300_000, windowSource: 'env' });
    expect(resolveCompactionModel(200_000, 'claude-opus-4-6', 0, { ...base, autoCompactWindow: 500_000 }).autoCompactWindow)
      .toBe(200_000);
  });

  test('auto-compaction off: no trigger and no idle compaction', () => {
    const m = resolveCompactionModel(1_000_000, 'claude-opus-5-5', 900_000, {
      autoCompactEnabled: false, idleCompaction: false, idleCompactMinTokens: 200_000, disable1m: false,
    });
    expect(m.trigger).toBeNull();
    expect(m.windowSource).toBe('disabled');
    expect(m.idle.applies).toBe(false);
  });

  test("crusts' own buffer override moves the trigger", () => {
    const m = resolveCompactionModel(1_000_000, 'claude-opus-5-5', 0, {
      autoCompactEnabled: true, idleCompaction: true, idleCompactMinTokens: 200_000, disable1m: false, bufferTokens: 50_000,
    });
    expect(m.trigger).toBe(950_000);
    expect(m.bufferTokens).toBe(50_000);
  });
});

describe('0.8.1 request copies are not user records', () => {
  test("a 2.1.300 api-request-blob carrying a /context dump does not count as one", () => {
    const blob = {
      type: 'api-request-blob',
      message: { role: 'user', content: '## Context Usage\n\n**Model:** claude-opus-5-5\n**Tokens:** 50k / 200k (25%)' },
    };
    expect(detectContextCommandWindow([blob])).toBeNull();
  });
});

describe('0.8.1 zeroed usage copies describe no request', () => {
  test('all flat fields 0 with a nested old window counts as nothing', () => {
    // A continuation file repeats the previous conversation's last turns
    // like this (seen on a real 2.1.261 file).
    const copy = {
      input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 821_214, ephemeral_5m_input_tokens: 0 },
    };
    expect(isZeroedUsageCopy(copy)).toBe(true);
    expect(cacheCreationTokens(copy)).toBe(0);
    expect(effectiveInput(copy)).toBe(0);
  });

  test('a real turn whose flat cache field is 0 still reads the nested breakdown', () => {
    const real = {
      input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 447,
      cache_creation: { ephemeral_1h_input_tokens: 30_000, ephemeral_5m_input_tokens: 0 },
    };
    expect(isZeroedUsageCopy(real)).toBe(false);
    expect(effectiveInput(real)).toBe(30_002);
  });
});

describe('0.8.1 idle compaction needs the one-hour cache', () => {
  /** A turn whose cache write used the given TTL. */
  const wrote = (ttl: '1h' | '5m') => ({
    message: {
      usage: {
        input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 300_000,
        cache_creation_input_tokens: 5_000,
        cache_creation: ttl === '1h'
          ? { ephemeral_1h_input_tokens: 5_000, ephemeral_5m_input_tokens: 0 }
          : { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 5_000 },
      },
    },
  });
  const readOnly = { message: { usage: { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 305_000, cache_creation_input_tokens: 0 } } };

  test('latestCacheTtl reads the newest cache write, skipping read-only turns', () => {
    expect(latestCacheTtl([wrote('1h'), readOnly])).toBe('1h');
    expect(latestCacheTtl([wrote('1h'), wrote('5m'), readOnly])).toBe('5m');
    expect(latestCacheTtl([readOnly])).toBe('unknown');
  });

  test('a session on the 5-minute cache does not qualify for idle compaction', () => {
    expect(resolveCompactionModel(1_000_000, 'claude-opus-5-5', 400_000, undefined, '5m').idle.applies).toBe(false);
    expect(resolveCompactionModel(1_000_000, 'claude-opus-5-5', 400_000, undefined, '1h').idle.applies).toBe(true);
  });
});

describe('0.8.1 review: compaction model matches Claude Code 2.1.302', () => {
  const base = { autoCompactEnabled: true, idleCompaction: true, idleCompactMinTokens: 200_000, disable1m: false };

  test('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE fires at that percent of the window less 20K when earlier', () => {
    // Claude Code: min(floor((1M - 20K) * 50 / 100), 1M - 33K) = 490,000.
    expect(resolveCompactionModel(1_000_000, 'claude-opus-5-5', 0, { ...base, autoCompactPct: 50 }).trigger).toBe(490_000);
    // A percent past the buffer trigger changes nothing.
    expect(resolveCompactionModel(1_000_000, 'claude-opus-5-5', 0, { ...base, autoCompactPct: 99.9 }).trigger).toBe(967_000);
  });

  test("a per-model 'auto' window is the model default, even over a top-level window", () => {
    const m = resolveCompactionModel(1_000_000, 'claude-opus-5-5', 0, {
      ...base, autoCompactWindow: 400_000, modelAutoCompactWindows: { 'claude-opus-5-5': 'auto' },
    });
    expect(m.autoCompactWindow).toBe(1_000_000);
    expect(m.trigger).toBe(967_000);
  });

  test('a per-model window matches the model\'s dated and provider-specific IDs', () => {
    const settings = { ...base, modelAutoCompactWindows: { 'claude-haiku-4-5': 150_000 } };
    for (const id of [
      'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5@20251001',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5[1m]',
    ]) {
      expect(resolveCompactionModel(200_000, id, 0, settings)).toMatchObject({ autoCompactWindow: 150_000, trigger: 117_000 });
    }
    // Another version of the family keeps its own window.
    expect(resolveCompactionModel(200_000, 'claude-haiku-4-6', 0, settings).autoCompactWindow).toBe(200_000);
  });

  test('a suffixed CLAUDE_CODE_AUTO_COMPACT_WINDOW means what the session\'s Claude Code read', () => {
    // "200k": 200K from 2.1.304; earlier versions read 200 and raised it to the 100K floor.
    const settings = { ...base, envAutoCompactWindow: 200_000, envAutoCompactWindowLegacy: 100_000 };
    expect(resolveCompactionModel(1_000_000, 'claude-opus-5-5', 0, settings, '1h', '2.1.310'))
      .toMatchObject({ autoCompactWindow: 200_000, windowSource: 'env', trigger: 167_000 });
    expect(resolveCompactionModel(1_000_000, 'claude-opus-5-5', 0, settings, '1h', '2.1.303'))
      .toMatchObject({ autoCompactWindow: 100_000, windowSource: 'env', trigger: 67_000 });
    expect(resolveCompactionModel(1_000_000, 'claude-opus-5-5', 0, settings).autoCompactWindow).toBe(200_000);
  });

  test('idle compaction only applies on a Claude Code version that has it', () => {
    expect(resolveCompactionModel(1_000_000, 'claude-fable-5-1', 300_000, base, '1h', '2.1.270').idle.applies).toBe(false);
    expect(resolveCompactionModel(1_000_000, 'claude-fable-5-1', 300_000, base, '1h', '2.1.289').idle.applies).toBe(true);
    expect(resolveCompactionModel(1_000_000, 'claude-fable-5-1', 300_000, base, '1h').idle.applies).toBe(true);
  });

  test('a zeroed usage copy still counts as evidence of the window its run reached', () => {
    const copy = {
      message: {
        usage: {
          input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
          cache_creation: { ephemeral_1h_input_tokens: 821_214, ephemeral_5m_input_tokens: 0 },
        },
      },
    };
    expect(detectContextLimitFromUsage([copy])).toBe(1_000_000);
    expect(resolveContextLimitWithSignal('claude-sonnet-4-6', [copy])).toEqual({ limit: 1_000_000, signal: 'usage' });
  });
});

describe('0.8.2 tokenizerFactor: Claude 4.7 and later count about 30% more tokens', () => {
  test('models from Claude 4.7 on, and every Fable and Mythos, use the newer tokenizer', () => {
    for (const id of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-5-5',
      'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5', 'claude-opus-4-7-20260101', 'claude-opus-4-7[1m]']) {
      expect(tokenizerFactor(id)).toBe(NEWER_TOKENIZER_FACTOR);
    }
  });

  test('earlier models and IDs that do not parse keep the base divisors', () => {
    for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001',
      '<synthetic>', 'unknown', 'gpt-5', undefined]) {
      expect(tokenizerFactor(id)).toBe(1);
    }
  });
});
