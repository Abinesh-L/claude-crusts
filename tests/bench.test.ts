import { describe, test, expect } from 'bun:test';
import { writeFileSync, mkdtempSync, appendFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  chunkContainsCompactBoundary,
  extractFileRefs,
  runBenchCompact,
  compareBenchResults,
  loadBenchResult,
  reextractSummaryRefs,
} from '../src/bench.ts';
import type { BenchResult, BenchSnapshot } from '../src/bench.ts';
import type { SessionInfo } from '../src/types.ts';

// ---------------------------------------------------------------------------
// chunkContainsCompactBoundary
// ---------------------------------------------------------------------------

describe('chunkContainsCompactBoundary', () => {
  test('returns false for empty or whitespace chunk', () => {
    expect(chunkContainsCompactBoundary('')).toBe(false);
    expect(chunkContainsCompactBoundary('   \n\n')).toBe(false);
  });

  test('returns false when the keyword appears only inside quoted text (not as a record subtype)', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'I ran compact_boundary once before' } });
    expect(chunkContainsCompactBoundary(line)).toBe(false);
  });

  test('returns true when a system record with subtype compact_boundary is present', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { preTokens: 150000 },
    });
    expect(chunkContainsCompactBoundary(line)).toBe(true);
  });

  test('ignores partial trailing lines safely', () => {
    const complete = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
    const partial = '{"type":"system","subty';
    const chunk = `${complete}\n${partial}`;
    // Neither a complete compact_boundary record
    expect(chunkContainsCompactBoundary(chunk)).toBe(false);
  });

  test('finds compact_boundary when preceded by normal records', () => {
    const normal = JSON.stringify({ type: 'user', message: { role: 'user', content: 'ok' } });
    const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 200000 } });
    const chunk = `${normal}\n${boundary}\n`;
    expect(chunkContainsCompactBoundary(chunk)).toBe(true);
  });

  test('does not match a non-system record that happens to have subtype compact_boundary', () => {
    const malformed = JSON.stringify({ type: 'user', subtype: 'compact_boundary' });
    expect(chunkContainsCompactBoundary(malformed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractFileRefs
// ---------------------------------------------------------------------------

describe('extractFileRefs', () => {
  test('returns empty array for empty input', () => {
    expect(extractFileRefs('')).toEqual([]);
  });

  test('finds simple relative file paths', () => {
    const text = 'Read src/hooks.ts and src/watcher.ts. Also touched CLAUDE.md.';
    const refs = extractFileRefs(text);
    expect(refs).toContain('src/hooks.ts');
    expect(refs).toContain('src/watcher.ts');
    expect(refs).toContain('CLAUDE.md');
  });

  test('finds Windows-style absolute paths', () => {
    const text = 'Modified C:\\Users\\me\\proj\\file.ts';
    const refs = extractFileRefs(text);
    expect(refs.some((r) => r.endsWith('file.ts'))).toBe(true);
  });

  test('de-duplicates repeated mentions', () => {
    const text = 'config.ts was changed. Then config.ts again. And config.ts once more.';
    const refs = extractFileRefs(text);
    const configHits = refs.filter((r) => r === 'config.ts');
    expect(configHits.length).toBe(1);
  });

  test('does not match version numbers like 1.0.0', () => {
    expect(extractFileRefs('bumped to 1.0.0').length).toBe(0);
    expect(extractFileRefs('version 2.3.4-beta')).toEqual([]);
  });

  test('returns refs sorted for stable output', () => {
    const refs = extractFileRefs('Modified z.ts, a.ts, m.ts');
    expect(refs).toEqual(refs.slice().sort());
  });

  // --- extension-whitelist hardening (from bench Run 1 observations) ---

  test('rejects JavaScript method calls masquerading as file refs', () => {
    const text = 'We call Math.abs and console.log then chalk.bold and chalk.green.';
    const refs = extractFileRefs(text);
    expect(refs).not.toContain('Math.abs');
    expect(refs).not.toContain('console.log');
    expect(refs).not.toContain('chalk.bold');
    expect(refs).not.toContain('chalk.green');
  });

  test('rejects method-call tokens whose tail is not a whitelisted extension', () => {
    // `.find`, `.Also`, `.Bold` etc. are not in the extension whitelist → dropped.
    // Note: `Commander.js` is a known limitation — `.js` IS whitelisted, so it
    // slips through. We accept this trade-off to keep the extension rule simple.
    const text = 'Ran comparisons.find then blocks...Also failed. chalk.Bold errored.';
    const refs = extractFileRefs(text);
    expect(refs).not.toContain('comparisons.find');
    expect(refs).not.toContain('blocks...Also');
    expect(refs).not.toContain('chalk.Bold');
  });

  test('rejects malformed tokens like 4.7...2', () => {
    expect(extractFileRefs('bumped to 4.7...2')).toEqual([]);
  });

  test('keeps lock files, package.json, and markdown', () => {
    const text = 'Inspected ../package.json and bun.lock. Updated README.md and ROADMAP.md.';
    const refs = extractFileRefs(text);
    expect(refs).toContain('../package.json');
    expect(refs).toContain('bun.lock');
    expect(refs).toContain('README.md');
    expect(refs).toContain('ROADMAP.md');
  });

  test('keeps dotted-prefix relative paths like ./built-in-tools.ts', () => {
    const refs = extractFileRefs('Re-read ./built-in-tools.ts and ./version.ts.');
    expect(refs).toContain('./built-in-tools.ts');
    expect(refs).toContain('./version.ts');
  });

  test('keeps .jsonl, .yaml, .toml, .sql, .py, .go, .rs extensions', () => {
    const refs = extractFileRefs('Touched session.jsonl, config.yaml, Cargo.toml, schema.sql, util.py, main.go, lib.rs');
    expect(refs).toContain('session.jsonl');
    expect(refs).toContain('config.yaml');
    expect(refs).toContain('Cargo.toml');
    expect(refs).toContain('schema.sql');
    expect(refs).toContain('util.py');
    expect(refs).toContain('main.go');
    expect(refs).toContain('lib.rs');
  });

  test('rejects extensions outside the whitelist', () => {
    // ".xyz" is not a code/config/doc extension — should be rejected.
    const refs = extractFileRefs('Opened mystery.xyz and exotic.qqq.');
    expect(refs).not.toContain('mystery.xyz');
    expect(refs).not.toContain('exotic.qqq');
  });

  test('rejects purely-numeric extensions like .2 or .07', () => {
    expect(extractFileRefs('weights.07')).toEqual([]);
    expect(extractFileRefs('model.2')).toEqual([]);
  });

  test('handles repeated calls (global regex lastIndex reset)', () => {
    const text = 'See src/hooks.ts and src/watcher.ts.';
    const a = extractFileRefs(text);
    const b = extractFileRefs(text);
    expect(a).toEqual(b);
    expect(a).toContain('src/hooks.ts');
  });
});

// ---------------------------------------------------------------------------
// runBenchCompact — integration paths that don't require Claude Code
// ---------------------------------------------------------------------------

/** Build a SessionInfo pointing at a JSONL we've staged on disk. */
function stageSession(jsonl: string): SessionInfo {
  const dir = mkdtempSync(join(tmpdir(), 'crusts-bench-test-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, jsonl, 'utf-8');
  return {
    id: '11111111-2222-3333-4444-555555555555',
    path,
    project: 'test',
    sizeMB: 0,
    messageCount: jsonl.split('\n').filter(Boolean).length,
    modifiedAt: new Date(),
  };
}

/** Minimal assistant message so classifier has something to work with. */
function assistantLine(text: string, inputTokens = 1000): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text }],
      usage: { input_tokens: inputTokens, output_tokens: 50 },
    },
  });
}

function userLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

describe('runBenchCompact — error path', () => {
  test('returns status=error when session file is missing', async () => {
    const session: SessionInfo = {
      id: 'missing',
      path: join(tmpdir(), 'does-not-exist-' + Date.now() + '.jsonl'),
      project: 'test',
      sizeMB: 0,
      messageCount: 0,
      modifiedAt: new Date(),
    };
    const result = await runBenchCompact(session, { json: true, timeoutSec: 1, pollIntervalMs: 50 });
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/does not exist/);
  });
});

describe('runBenchCompact — timeout path', () => {
  test('returns status=timeout when no compact_boundary appears within the window', async () => {
    const jsonl = [userLine('hello'), assistantLine('hi there')].join('\n') + '\n';
    const session = stageSession(jsonl);

    const result = await runBenchCompact(session, {
      json: true,
      timeoutSec: 1,
      pollIntervalMs: 100,
    });

    expect(result.status).toBe('timeout');
    expect(result.before).toBeDefined();
    expect(result.after).toBeUndefined();
    expect(result.delta).toBeUndefined();
    expect(result.waitSec).toBeGreaterThanOrEqual(0.9);
    expect(result.waitSec).toBeLessThan(3);
  }, 15_000);
});

describe('runBenchCompact — compacted path', () => {
  test('detects an appended compact_boundary and produces a delta', async () => {
    // Seed a minimal valid session: one user, one assistant.
    const baseline = [userLine('hello'), assistantLine('hi there', 5_000)].join('\n') + '\n';
    const session = stageSession(baseline);

    // Kick off the bench with a short poll interval.
    const pending = runBenchCompact(session, {
      json: true,
      timeoutSec: 10,
      pollIntervalMs: 100,
    });

    // After a brief delay, append the compact_boundary + summary + first post-boundary assistant.
    await new Promise((r) => setTimeout(r, 300));
    const boundary = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { preTokens: 5000 },
    });
    const summary = JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      message: { role: 'user', content: 'Summary mentions src/hooks.ts and src/watcher.ts.' },
    });
    const postAssistant = assistantLine('ack', 500);
    appendFileSync(session.path, boundary + '\n' + summary + '\n' + postAssistant + '\n');

    const result = await pending;

    expect(result.status).toBe('compacted');
    expect(result.after).toBeDefined();
    expect(result.delta).toBeDefined();
    expect(result.delta!.compactionCount).toBe(1);
    // Summary survivor list should include the two .ts refs we embedded.
    expect(result.summaryFileRefs).toContain('src/hooks.ts');
    expect(result.summaryFileRefs).toContain('src/watcher.ts');
  }, 30_000);

  test('persists the result envelope to --output when provided', async () => {
    const baseline = [userLine('hello'), assistantLine('hi', 3_000)].join('\n') + '\n';
    const session = stageSession(baseline);
    const outPath = join(tmpdir(), `crusts-bench-out-${Date.now()}.json`);

    const pending = runBenchCompact(session, {
      json: true,
      timeoutSec: 10,
      pollIntervalMs: 100,
      outputPath: outPath,
    });

    await new Promise((r) => setTimeout(r, 300));
    const boundary = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { preTokens: 3000 },
    });
    const summary = JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      message: { role: 'user', content: 'Summary.' },
    });
    appendFileSync(session.path, boundary + '\n' + summary + '\n' + assistantLine('ok', 200) + '\n');

    const result = await pending;
    expect(result.status).toBe('compacted');

    const { readFileSync, existsSync } = await import('fs');
    expect(existsSync(outPath)).toBe(true);
    const written = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(written.status).toBe('compacted');
    expect(written.delta.compactionCount).toBe(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// compareBenchResults + loadBenchResult
// ---------------------------------------------------------------------------

function snap(overrides: Partial<BenchSnapshot> = {}): BenchSnapshot {
  return {
    tokensTotal: 100_000,
    tokensCurrentContext: 100_000,
    usagePercentage: 50,
    messageCount: 50,
    wasteCount: 5,
    compactionCount: 0,
    contextLimit: 200_000,
    ...overrides,
  };
}

function result(overrides: Partial<BenchResult> = {}): BenchResult {
  return {
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    sessionPath: '/tmp/x.jsonl',
    status: 'compacted',
    before: snap({ tokensCurrentContext: 180_000, usagePercentage: 90, wasteCount: 15 }),
    after: snap({ tokensCurrentContext: 20_000, usagePercentage: 10, wasteCount: 1, compactionCount: 1 }),
    delta: {
      tokensTotal: 0,
      tokensCurrentContext: -160_000,
      usagePercentage: -80,
      wasteCount: -14,
      compactionCount: 1,
    },
    summaryFileRefs: [],
    waitSec: 5.0,
    ...overrides,
  };
}

describe('compareBenchResults', () => {
  test('computes onlyInA / onlyInB / inBoth from summary file refs', () => {
    const a = result({ summaryFileRefs: ['src/hooks.ts', 'src/watcher.ts', 'common.ts'] });
    const b = result({ summaryFileRefs: ['src/hooks.ts', 'src/calibrator.ts', 'common.ts'] });

    const cmp = compareBenchResults(a, b);

    expect(cmp.inBoth).toEqual(['common.ts', 'src/hooks.ts']);
    expect(cmp.onlyInA).toEqual(['src/watcher.ts']);
    expect(cmp.onlyInB).toEqual(['src/calibrator.ts']);
  });

  test('uses provided labels when given', () => {
    const cmp = compareBenchResults(result(), result(), { a: 'blind', b: 'focused' });
    expect(cmp.labels.a).toBe('blind');
    expect(cmp.labels.b).toBe('focused');
  });

  test('falls back to session-id-prefix labels when none provided', () => {
    const cmp = compareBenchResults(result({ sessionId: '12345678-xxxx' }), result({ sessionId: '87654321-yyyy' }));
    expect(cmp.labels.a).toContain('12345678');
    expect(cmp.labels.b).toContain('87654321');
  });

  test('produces insights when one side has more file refs', () => {
    const a = result({ summaryFileRefs: ['a.ts'] });
    const b = result({ summaryFileRefs: ['a.ts', 'b.ts', 'c.ts'] });
    const cmp = compareBenchResults(a, b);
    expect(cmp.insights.some((i) => i.includes('more file path'))).toBe(true);
  });

  test('insight mentions exclusive survivors on each side', () => {
    const a = result({ summaryFileRefs: ['only-a.ts', 'shared.ts'] });
    const b = result({ summaryFileRefs: ['only-b.ts', 'shared.ts'] });
    const cmp = compareBenchResults(a, b);
    expect(cmp.insights.some((i) => i.includes('only-a.ts'))).toBe(true);
    expect(cmp.insights.some((i) => i.includes('only-b.ts'))).toBe(true);
  });

  test('before-delta reflects B - A', () => {
    const a = result();
    const b = result({ before: snap({ tokensCurrentContext: 180_000, usagePercentage: 90, wasteCount: 20 }) });
    const cmp = compareBenchResults(a, b);
    expect(cmp.before.delta.tokensCurrentContext).toBe(180_000 - 180_000); // both identical in this setup
    expect(cmp.before.delta.wasteCount).toBe(20 - 15);
  });

  test('after-delta is undefined when either side has no after snapshot', () => {
    const a = result({ after: undefined, delta: undefined, status: 'timeout' });
    const b = result();
    const cmp = compareBenchResults(a, b);
    expect(cmp.after.delta).toBeUndefined();
  });

  test('empty summaries produce empty diff sets and no crash', () => {
    const a = result({ summaryFileRefs: [] });
    const b = result({ summaryFileRefs: [] });
    const cmp = compareBenchResults(a, b);
    expect(cmp.onlyInA).toEqual([]);
    expect(cmp.onlyInB).toEqual([]);
    expect(cmp.inBoth).toEqual([]);
  });
});

describe('loadBenchResult', () => {
  test('throws when file is missing', () => {
    expect(() => loadBenchResult(join(tmpdir(), 'nonexistent-' + Date.now() + '.json'))).toThrow(/not found/);
  });

  test('throws when file is not valid JSON', () => {
    const p = join(tmpdir(), `bench-bad-${Date.now()}.json`);
    writeFileSync(p, 'not json at all', 'utf-8');
    expect(() => loadBenchResult(p)).toThrow(/not valid JSON/);
  });

  test('throws when required fields are missing', () => {
    const p = join(tmpdir(), `bench-partial-${Date.now()}.json`);
    writeFileSync(p, JSON.stringify({ sessionId: 'x' }), 'utf-8');
    expect(() => loadBenchResult(p)).toThrow(/missing required/);
  });

  test('loads a well-formed result and preserves fields', () => {
    const p = join(tmpdir(), `bench-ok-${Date.now()}.json`);
    const r = result({ summaryFileRefs: ['a.ts'] });
    writeFileSync(p, JSON.stringify(r), 'utf-8');
    const loaded = loadBenchResult(p);
    expect(loaded.status).toBe('compacted');
    expect(loaded.summaryFileRefs).toEqual(['a.ts']);
  });
});

// ---------------------------------------------------------------------------
// reextractSummaryRefs
// ---------------------------------------------------------------------------

describe('reextractSummaryRefs', () => {
  test('rewrites summaryFileRefs by re-reading the session JSONL', async () => {
    // Stage a JSONL that contains a compact_boundary followed by an
    // isCompactSummary message mentioning a mix of real files and JS symbols.
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100, output_tokens: 50 } },
      }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 100000 } }),
      JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        message: { role: 'user', content: 'Touched CLAUDE.md, src/hooks.ts, bun.lock. Also called Math.abs and console.log.' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ack' }], usage: { input_tokens: 50, output_tokens: 10 } },
      }),
    ];
    const sessionDir = mkdtempSync(join(tmpdir(), 'crusts-reextract-session-'));
    const sessionPath = join(sessionDir, 'session.jsonl');
    writeFileSync(sessionPath, lines.join('\n') + '\n', 'utf-8');

    // Stage a bench result with a polluted refs list (as if from the old regex).
    const resultPath = join(tmpdir(), `bench-reextract-${Date.now()}.json`);
    const polluted: BenchResult = {
      sessionId: 'abcdefgh-1111-2222-3333-444444444444',
      sessionPath,
      status: 'compacted',
      before: { tokensTotal: 100000, tokensCurrentContext: 100000, usagePercentage: 50, messageCount: 3, wasteCount: 5, compactionCount: 0, contextLimit: 200000 },
      after: { tokensTotal: 10000, tokensCurrentContext: 10000, usagePercentage: 5, messageCount: 5, wasteCount: 0, compactionCount: 1, contextLimit: 200000 },
      delta: { tokensTotal: -90000, tokensCurrentContext: -90000, usagePercentage: -45, wasteCount: -5, compactionCount: 1 },
      summaryFileRefs: ['CLAUDE.md', 'src/hooks.ts', 'bun.lock', 'Math.abs', 'console.log', 'chalk.bold'],
      waitSec: 5,
    };
    writeFileSync(resultPath, JSON.stringify(polluted, null, 2), 'utf-8');

    const { result, priorRefCount, newRefCount } = await reextractSummaryRefs(resultPath);

    expect(priorRefCount).toBe(6);
    expect(newRefCount).toBeLessThan(priorRefCount); // noise dropped
    expect(result.summaryFileRefs).toContain('CLAUDE.md');
    expect(result.summaryFileRefs).toContain('src/hooks.ts');
    expect(result.summaryFileRefs).toContain('bun.lock');
    expect(result.summaryFileRefs).not.toContain('Math.abs');
    expect(result.summaryFileRefs).not.toContain('console.log');
    expect(result.summaryFileRefs).not.toContain('chalk.bold');

    // File on disk must be updated in place.
    const reloaded = JSON.parse(readFileSync(resultPath, 'utf-8'));
    expect(reloaded.summaryFileRefs).toEqual(result.summaryFileRefs);
  });

  test('throws when no compact_boundary is in the session JSONL', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'crusts-reextract-nb-'));
    const sessionPath = join(sessionDir, 'session.jsonl');
    writeFileSync(sessionPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n', 'utf-8');

    const resultPath = join(tmpdir(), `bench-reextract-nobound-${Date.now()}.json`);
    writeFileSync(resultPath, JSON.stringify({
      sessionId: 'x',
      sessionPath,
      status: 'compacted',
      before: { tokensTotal: 0, tokensCurrentContext: 0, usagePercentage: 0, messageCount: 0, wasteCount: 0, compactionCount: 0, contextLimit: 200000 },
    }), 'utf-8');

    await expect(reextractSummaryRefs(resultPath)).rejects.toThrow(/no compact_boundary/);
  });

  test('throws when the session JSONL is missing', async () => {
    const resultPath = join(tmpdir(), `bench-reextract-missing-${Date.now()}.json`);
    writeFileSync(resultPath, JSON.stringify({
      sessionId: 'x',
      sessionPath: join(tmpdir(), 'does-not-exist-' + Date.now() + '.jsonl'),
      status: 'compacted',
      before: { tokensTotal: 0, tokensCurrentContext: 0, usagePercentage: 0, messageCount: 0, wasteCount: 0, compactionCount: 0, contextLimit: 200000 },
    }), 'utf-8');
    await expect(reextractSummaryRefs(resultPath)).rejects.toThrow(/not found/);
  });
});
