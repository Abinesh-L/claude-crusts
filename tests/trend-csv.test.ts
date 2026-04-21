import { describe, test, expect } from 'bun:test';
import { formatTrendAsCsv } from '../src/trend.ts';
import type { TrendRecord } from '../src/types.ts';

function record(overrides: Partial<TrendRecord> = {}): TrendRecord {
  return {
    sessionId: 'abc123',
    projectName: 'my-project',
    timestamp: '2026-04-20T12:00:00.000Z',
    totalTokens: 120000,
    percentUsed: 60.5,
    messageCount: 250,
    compactionCount: 1,
    health: 'warming',
    topCategory: 'tools',
    topCategoryTokens: 45000,
    contextLimit: 200000,
    ...overrides,
  };
}

describe('formatTrendAsCsv', () => {
  test('emits header row even when records is empty', () => {
    const csv = formatTrendAsCsv([]);
    expect(csv.split('\n')[0]).toContain('sessionId,projectName');
    expect(csv.split('\n')[0]).toContain('contextLimit');
    expect(csv).toMatch(/\n$/);
  });

  test('serialises each record on its own line', () => {
    const csv = formatTrendAsCsv([record(), record({ sessionId: 'xyz789' })]);
    const lines = csv.split('\n').filter(Boolean);
    expect(lines.length).toBe(3); // header + 2 records
  });

  test('omits undefined contextLimit as an empty cell', () => {
    const csv = formatTrendAsCsv([record({ contextLimit: undefined })]);
    const row = csv.split('\n')[1]!;
    expect(row.endsWith(',')).toBe(true);
  });

  test('escapes commas and quotes in field values', () => {
    const csv = formatTrendAsCsv([record({ projectName: 'foo,bar "baz"' })]);
    const row = csv.split('\n')[1]!;
    expect(row).toContain('"foo,bar ""baz"""');
  });

  test('rounds percentUsed to 2 decimal places', () => {
    const csv = formatTrendAsCsv([record({ percentUsed: 60.5678 })]);
    const row = csv.split('\n')[1]!;
    expect(row).toContain(',60.57,');
  });
});
