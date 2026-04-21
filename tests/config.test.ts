import { describe, test, expect } from 'bun:test';
import { DEFAULT_WASTE_THRESHOLDS, loadWasteThresholds, describeThresholdOverrides, stripBom } from '../src/config.ts';

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
