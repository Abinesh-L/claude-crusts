import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  DEFAULT_WASTE_THRESHOLDS,
  DEFAULT_AUTO_INJECT,
  loadWasteThresholds,
  loadAutoInjectConfig,
  loadAutocompactBufferTokens,
  recordInjection,
  crustsConfigPath,
  describeThresholdOverrides,
  stripBom,
} from '../src/config.ts';
import { AUTOCOMPACT_BUFFER_TOKENS } from '../src/model-context.ts';

describe('DEFAULT_WASTE_THRESHOLDS', () => {
  test('contains all expected keys with positive numeric defaults', () => {
    for (const key of Object.keys(DEFAULT_WASTE_THRESHOLDS)) {
      const v = DEFAULT_WASTE_THRESHOLDS[key as keyof typeof DEFAULT_WASTE_THRESHOLDS];
      expect(typeof v).toBe('number');
      expect(v).toBeGreaterThan(0);
    }
  });

  test('defaults match historical waste-detector constants', () => {
    expect(DEFAULT_WASTE_THRESHOLDS.staleReadThreshold).toBe(15);
    expect(DEFAULT_WASTE_THRESHOLDS.oversizedSystemThreshold).toBe(1500);
    expect(DEFAULT_WASTE_THRESHOLDS.cacheOverheadThreshold).toBe(0.6);
    expect(DEFAULT_WASTE_THRESHOLDS.resolutionLookback).toBe(10);
    expect(DEFAULT_WASTE_THRESHOLDS.claudeMdOversizedThreshold).toBe(1500);
  });
});

describe('loadWasteThresholds', () => {
  test('returns an object with every default key populated', () => {
    const active = loadWasteThresholds();
    for (const key of Object.keys(DEFAULT_WASTE_THRESHOLDS)) {
      expect(typeof active[key as keyof typeof active]).toBe('number');
    }
  });
});

describe('describeThresholdOverrides', () => {
  test('returns an array of strings (empty when no overrides)', () => {
    const notes = describeThresholdOverrides();
    expect(Array.isArray(notes)).toBe(true);
    for (const n of notes) expect(typeof n).toBe('string');
  });
});

describe('stripBom', () => {
  test('strips a leading UTF-8 BOM (U+FEFF)', () => {
    const withBom = '﻿{"a":1}';
    expect(stripBom(withBom)).toBe('{"a":1}');
  });

  test('leaves BOM-less strings untouched', () => {
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
  });

  test('handles empty string', () => {
    expect(stripBom('')).toBe('');
  });

  test('only strips the FIRST character — embedded U+FEFF is preserved', () => {
    const embedded = 'prefix﻿suffix';
    expect(stripBom(embedded)).toBe('prefix﻿suffix');
  });

  test('produces JSON-parseable output from a BOM-prefixed config blob', () => {
    const raw = '﻿' + JSON.stringify({ autoInject: { enabled: true, threshold: 42 } });
    const parsed = JSON.parse(stripBom(raw));
    expect(parsed.autoInject.threshold).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Sandboxed config-file tests (M15/M16): autocompact buffer override and
// explicit-threshold detection. CRUSTS_CONFIG_DIR_OVERRIDE redirects every
// read/write to a temp dir so the developer's real ~/.claude-crusts is
// never touched.
// ---------------------------------------------------------------------------

describe('config file overrides (sandboxed)', () => {
  let sandbox: string;
  let savedOverride: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'crusts-config-'));
    savedOverride = process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
    process.env.CRUSTS_CONFIG_DIR_OVERRIDE = sandbox;
  });

  afterEach(() => {
    if (savedOverride === undefined) {
      delete process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
    } else {
      process.env.CRUSTS_CONFIG_DIR_OVERRIDE = savedOverride;
    }
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('crustsConfigPath resolves inside the override dir', () => {
    expect(crustsConfigPath()).toBe(join(sandbox, 'config.json'));
  });

  test('loadAutocompactBufferTokens defaults to AUTOCOMPACT_BUFFER_TOKENS with no config', () => {
    expect(loadAutocompactBufferTokens()).toBe(AUTOCOMPACT_BUFFER_TOKENS);
    expect(AUTOCOMPACT_BUFFER_TOKENS).toBe(33_000);
  });

  test('loadAutocompactBufferTokens honours a valid override', () => {
    writeFileSync(crustsConfigPath(), JSON.stringify({ autocompactBufferTokens: 21_000 }), 'utf-8');
    expect(loadAutocompactBufferTokens()).toBe(21_000);
  });

  test('loadAutocompactBufferTokens rejects invalid overrides', () => {
    writeFileSync(crustsConfigPath(), JSON.stringify({ autocompactBufferTokens: '21000' }), 'utf-8');
    expect(loadAutocompactBufferTokens()).toBe(AUTOCOMPACT_BUFFER_TOKENS);
    writeFileSync(crustsConfigPath(), JSON.stringify({ autocompactBufferTokens: -5 }), 'utf-8');
    expect(loadAutocompactBufferTokens()).toBe(AUTOCOMPACT_BUFFER_TOKENS);
  });

  test('loadAutoInjectConfig marks a config.json threshold as explicit', () => {
    writeFileSync(crustsConfigPath(), JSON.stringify({ autoInject: { enabled: true, threshold: 47 } }), 'utf-8');
    const cfg = loadAutoInjectConfig();
    expect(cfg.threshold).toBe(47);
    expect(cfg.thresholdExplicit).toBe(true);
  });

  test('loadAutoInjectConfig reports no explicit threshold when the key is absent or invalid', () => {
    const none = loadAutoInjectConfig();
    expect(none.thresholdExplicit).toBe(false);
    expect(none.threshold).toBe(DEFAULT_AUTO_INJECT.threshold);

    writeFileSync(crustsConfigPath(), JSON.stringify({ autoInject: { enabled: true, threshold: 250 } }), 'utf-8');
    const invalid = loadAutoInjectConfig();
    expect(invalid.thresholdExplicit).toBe(false);
    expect(invalid.threshold).toBe(DEFAULT_AUTO_INJECT.threshold);
  });

  test('recordInjection does not materialise the default threshold into config.json', () => {
    // If recordInjection wrote the defaults-expanded view, threshold 70
    // would land on disk and read back as an explicit user choice on the
    // next load, silently disabling the headroom default gate.
    writeFileSync(crustsConfigPath(), JSON.stringify({ autoInject: { enabled: true } }), 'utf-8');
    recordInjection('session-x');
    const onDisk = JSON.parse(readFileSync(crustsConfigPath(), 'utf-8'));
    expect(onDisk.autoInject.lastInjectionSessionId).toBe('session-x');
    expect(onDisk.autoInject.enabled).toBe(true);
    expect('threshold' in onDisk.autoInject).toBe(false);
    expect('thresholdExplicit' in onDisk.autoInject).toBe(false);
    expect(loadAutoInjectConfig().thresholdExplicit).toBe(false);
  });

  test('recordInjection preserves an explicit threshold verbatim', () => {
    writeFileSync(crustsConfigPath(), JSON.stringify({ autoInject: { enabled: true, threshold: 47 } }), 'utf-8');
    recordInjection('session-y');
    const cfg = loadAutoInjectConfig();
    expect(cfg.threshold).toBe(47);
    expect(cfg.thresholdExplicit).toBe(true);
    expect(cfg.lastInjectionSessionId).toBe('session-y');
  });
});
