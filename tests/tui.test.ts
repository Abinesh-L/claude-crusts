/**
 * TUI dispatch tests.
 *
 * Black-box-ish coverage: we drive `executeCommand` directly with a hand-built
 * TuiState and capture stdout to assert the right code path fired. We don't
 * spin up readline or require a TTY — those are exercised by manual smoke
 * tests (see BENCH-OBSERVATIONS.md and test-v0.7.ps1).
 *
 * What's covered:
 *   - Unknown commands are rejected with a friendly hint.
 *   - quit / exit / q return false (loop termination).
 *   - help includes each new command group so users can discover them.
 *   - The new v0.7.0 commands route without throwing when their prerequisites
 *     are absent (e.g. no selected session) — they should print guidance.
 *   - `optimize apply` inside the TUI is deliberately short-circuited to a
 *     CLI pointer, not the write pipeline (readline collision).
 *   - `bench compact` inside the TUI is deliberately short-circuited to a
 *     CLI pointer (long-running blocking watcher).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { executeCommand, type TuiState } from '../src/tui.ts';

// ---------------------------------------------------------------------------
// stdout capture
// ---------------------------------------------------------------------------

let capturedOut: string[] = [];
let originalLog: typeof console.log;
let originalWrite: typeof process.stdout.write;

beforeEach(() => {
  capturedOut = [];
  originalLog = console.log;
  originalWrite = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => {
    capturedOut.push(args.map((a) => String(a)).join(' '));
  };
  // Silence stdout.write (used by "Analyzing session..." hints).
  process.stdout.write = ((_chunk: unknown) => true) as typeof process.stdout.write;
});

afterEach(() => {
  console.log = originalLog;
  process.stdout.write = originalWrite;
});

function out(): string {
  // Strip ANSI codes so assertions don't care about terminal styling.
  return capturedOut.join('\n').replace(/\[[0-9;]*m/g, '');
}

function emptyState(): TuiState {
  return {
    sessions: [],
    current: null,
    result: null,
    lastFix: null,
    basePath: undefined,
  };
}

// ---------------------------------------------------------------------------
// Exit / help / unknown
// ---------------------------------------------------------------------------

describe('exit handling', () => {
  test('quit returns false', async () => {
    expect(await executeCommand('quit', emptyState())).toBe(false);
  });
  test('exit returns false', async () => {
    expect(await executeCommand('exit', emptyState())).toBe(false);
  });
  test('q returns false', async () => {
    expect(await executeCommand('q', emptyState())).toBe(false);
  });
  test('everything else returns true', async () => {
    expect(await executeCommand('help', emptyState())).toBe(true);
    expect(await executeCommand('list', emptyState())).toBe(true);
    expect(await executeCommand('', emptyState())).toBe(true);
  });
});

describe('unknown command', () => {
  test('prints a friendly hint', async () => {
    await executeCommand('frobnicate', emptyState());
    expect(out()).toMatch(/Unknown command: frobnicate/);
    expect(out()).toMatch(/help/);
  });
});

describe('help output', () => {
  test('lists every new v0.7.0 command group', async () => {
    await executeCommand('help', emptyState());
    const text = out();
    // Pre-existing commands
    expect(text).toMatch(/analyze/);
    expect(text).toMatch(/waste/);
    expect(text).toMatch(/compare/);
    // New in v0.7.0
    expect(text).toMatch(/optimize/);
    expect(text).toMatch(/doctor/);
    expect(text).toMatch(/diff/);
    expect(text).toMatch(/hooks/);
    expect(text).toMatch(/auto-inject/);
    expect(text).toMatch(/bench compare/);
    expect(text).toMatch(/bench reextract/);
    // Out-of-scope disclaimer
    expect(text).toMatch(/Out of scope.*optimize --apply.*bench compact/);
  });

  test('? is an alias for help', async () => {
    await executeCommand('?', emptyState());
    expect(out()).toMatch(/Session/);
    expect(out()).toMatch(/Analysis/);
  });
});

// ---------------------------------------------------------------------------
// Commands that require a selected session — graceful when absent
// ---------------------------------------------------------------------------

describe('session-requiring commands without a selection', () => {
  test('analyze warns and continues', async () => {
    const ok = await executeCommand('analyze', emptyState());
    expect(ok).toBe(true);
    expect(out()).toMatch(/No session selected/);
  });

  test('waste warns and continues', async () => {
    const ok = await executeCommand('waste', emptyState());
    expect(ok).toBe(true);
    expect(out()).toMatch(/No session selected/);
  });

  test('optimize warns and continues', async () => {
    const ok = await executeCommand('optimize', emptyState());
    expect(ok).toBe(true);
    expect(out()).toMatch(/No session selected/);
  });

  test('diff warns about usage when indexes missing', async () => {
    const ok = await executeCommand('diff', emptyState());
    expect(ok).toBe(true);
    // Either "No session selected" OR "Usage: diff ..." — both acceptable.
    expect(out()).toMatch(/No session selected|Usage: diff/);
  });
});

// ---------------------------------------------------------------------------
// Subcommand routing (no external side-effects we want to provoke)
// ---------------------------------------------------------------------------

describe('optimize subcommands', () => {
  test('optimize apply routes to the CLI pointer (no write attempted)', async () => {
    await executeCommand('optimize apply', emptyState());
    expect(out()).toMatch(/CLI-only/);
    expect(out()).toMatch(/claude-crusts optimize --apply/);
  });
});

describe('hooks subcommands', () => {
  test('hooks with no subcommand falls through to status', async () => {
    const ok = await executeCommand('hooks', emptyState());
    expect(ok).toBe(true);
    // hooksStatus prints some human-readable text; just ensure it didn't throw.
    expect(out().length).toBeGreaterThan(0);
  });

  test('hooks with unknown subcommand warns', async () => {
    await executeCommand('hooks frobnicate', emptyState());
    expect(out()).toMatch(/Unknown hooks subcommand/);
  });
});

describe('auto-inject subcommands', () => {
  test('auto-inject with no subcommand falls through to status', async () => {
    const ok = await executeCommand('auto-inject', emptyState());
    expect(ok).toBe(true);
    expect(out().length).toBeGreaterThan(0);
  });

  test('auto-inject with unknown subcommand warns', async () => {
    await executeCommand('auto-inject frobnicate', emptyState());
    expect(out()).toMatch(/Unknown auto-inject subcommand/);
  });
});

describe('bench subcommands', () => {
  test('bench with no subcommand prints usage', async () => {
    await executeCommand('bench', emptyState());
    expect(out()).toMatch(/Usage: bench compare/);
    expect(out()).toMatch(/bench reextract/);
  });

  test('bench compact is deliberately routed to CLI', async () => {
    await executeCommand('bench compact', emptyState());
    expect(out()).toMatch(/CLI-only/);
  });

  test('bench compare without paths prints usage', async () => {
    await executeCommand('bench compare', emptyState());
    expect(out()).toMatch(/Usage: bench compare/);
  });

  test('bench reextract without path prints usage', async () => {
    await executeCommand('bench reextract', emptyState());
    expect(out()).toMatch(/Usage: bench reextract/);
  });

  test('bench compare with missing files reports the error', async () => {
    await executeCommand('bench compare /tmp/nonexistent-a.json /tmp/nonexistent-b.json', emptyState());
    expect(out()).toMatch(/not found|not valid JSON/);
  });
});

// ---------------------------------------------------------------------------
// doctor — no prerequisites, should always run
// ---------------------------------------------------------------------------

describe('doctor', () => {
  test('runs without a selected session and prints a report', async () => {
    const ok = await executeCommand('doctor', emptyState());
    expect(ok).toBe(true);
    expect(out()).toMatch(/CRUSTS Doctor|doctor|check/i);
  });
});

// ---------------------------------------------------------------------------
// trend — no prerequisites, should always run
// ---------------------------------------------------------------------------

describe('trend', () => {
  test('runs without a selected session', async () => {
    const ok = await executeCommand('trend', emptyState());
    expect(ok).toBe(true);
  });
});

describe('models', () => {
  test('warns when no session is selected', async () => {
    const ok = await executeCommand('models', emptyState());
    expect(ok).toBe(true);
    expect(out()).toMatch(/No session selected/);
  });

  test('appears in help output', async () => {
    await executeCommand('help', emptyState());
    expect(out()).toMatch(/models/);
  });
});
