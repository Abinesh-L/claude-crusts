/**
 * Duplicate-read rule (0.8.2 F3): range-aware and edit-aware.
 *
 * A Read covers the lines it delivered, so paging through a file is not a
 * duplicate; an earlier read is waste only for the lines a later read of the
 * same file delivered again with no edit in between, sized as that share of
 * its tokens; Claude Code's unchanged-file stub gives the model no second
 * copy. The fixtures follow the record shapes Claude Code writes: a Read
 * tool_use (`file_path`, 1-based `offset`, `limit`), a tool_result whose
 * every line starts with its number and a tab, and on main-session records
 * the structured `toolUseResult` (`type: 'text'`, `file.startLine`,
 * `file.numLines`) or `type: 'file_unchanged'` for the stub.
 *
 * All tests sandbox config reads via CRUSTS_CONFIG_DIR_OVERRIDE so the
 * developer's real ~/.claude-crusts/config.json (waste thresholds) can never
 * leak into the expectations.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { classifySession } from '../src/classifier.ts';
import { detectWaste } from '../src/waste-detector.ts';
import { generateRecommendations, generateFixPrompts } from '../src/recommender.ts';
import { buildCompactFocus } from '../src/optimizer.ts';
import { compactCommandFor } from '../src/auto-inject.ts';
import type { ConfigData, ContentBlock, SessionMessage, WasteItem } from '../src/types.ts';

const EMPTY_CONFIG: ConfigData = {
  systemPrompt: { files: [], totalEstimatedTokens: 0 },
  mcpServers: [],
  memoryFiles: { files: [], totalEstimatedTokens: 0 },
  builtInTools: { tools: [], totalEstimatedTokens: 0 },
  skills: { items: [], totalEstimatedTokens: 0 },
};

const FILE = 'C:/proj/src/app.ts';

/**
 * Text of lines `[start, start + count)` of a synthetic source file, every
 * line the same length (so a share of lines is the same share of text);
 * `tag` marks a version of the file.
 */
function fileLines(start: number, count: number, tag = 'v1'): string[] {
  return Array.from({ length: count }, (_, k) => `const line${String(start + k).padStart(5, '0')} = '${tag} ${'x'.repeat(40)}';`);
}

/** Read output as Claude Code renders it: each line prefixed by its number and a separator. */
function numbered(start: number, lines: string[], separator = '\t'): string {
  return lines.map((line, k) => `${start + k}${separator}${line}`).join('\n');
}

/** A user prompt record. */
function prompt(text: string): SessionMessage {
  return { type: 'user', uuid: `p-${text.length}`, message: { role: 'user', content: [{ type: 'text', text }] } } as SessionMessage;
}

/** An assistant record carrying one tool_use block. */
function call(id: string, name: string, input: Record<string, unknown>): SessionMessage {
  return {
    type: 'assistant',
    uuid: `a-${id}`,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 0, output_tokens: 0 } },
  } as SessionMessage;
}

/** A Read call; `range` holds `offset` (1-based first line) and `limit`. */
function readCall(id: string, filePath: string, range: { offset?: number; limit?: number; pages?: string } = {}): SessionMessage {
  return call(id, 'Read', { file_path: filePath, ...range });
}

/** A user record carrying one tool_result block. */
function result(id: string, content: string | ContentBlock[], extra: Partial<SessionMessage> = {}, isError = false): SessionMessage {
  return {
    type: 'user',
    uuid: `u-${id}`,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
    ...extra,
  } as SessionMessage;
}

/**
 * A Read result for lines `[start, start + lines.length)`. `structured`
 * adds the main-session `toolUseResult` copy (subagent transcripts mostly
 * lack it, so the rule must also work from the numbered text alone).
 */
function readResult(
  id: string,
  start: number,
  lines: string[],
  opts: { structured?: boolean; separator?: string } = {},
): SessionMessage {
  const structured = opts.structured ?? true;
  return result(id, numbered(start, lines, opts.separator), structured
    ? { toolUseResult: { type: 'text', file: { filePath: FILE, content: lines.join('\n'), numLines: lines.length, startLine: start, totalLines: 5_000 } } }
    : {});
}

/** Claude Code 2.1.310's stub for a re-read of an unchanged file (same offset and limit). */
const WASTED_CALL_STUB = 'Wasted call \u2014 file unchanged since your last Read. Refer to that earlier tool_result instead.';

/** The older wording of the same stub. */
const OLD_UNCHANGED_STUB = 'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current \u2014 refer to that instead of re-reading.';

/** Run the pipeline and keep the duplicate-read items. */
function duplicates(msgs: SessionMessage[], untilIndex?: number): WasteItem[] {
  const breakdown = classifySession(msgs, EMPTY_CONFIG, untilIndex);
  return detectWaste(msgs, breakdown, EMPTY_CONFIG).filter((w) => w.type === 'duplicate_read');
}

/** Estimated tokens of the classified row at `index`. */
function rowTokens(msgs: SessionMessage[], index: number): number {
  return classifySession(msgs, EMPTY_CONFIG).messages[index]!.tokens;
}

let sandbox: string;
let savedOverride: string | undefined;

beforeEach(() => {
  sandbox = resolve(mkdtempSync(join(tmpdir(), 'crusts-waste-')));
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

describe('duplicate reads are range-aware', () => {
  test('paging through a file (lines 1-200, then 201-400) is not flagged', () => {
    const msgs = [
      prompt('read app.ts'),
      readCall('r1', FILE, { offset: 1, limit: 200 }), readResult('r1', 1, fileLines(1, 200)),
      readCall('r2', FILE, { offset: 201, limit: 200 }), readResult('r2', 201, fileLines(201, 200)),
    ];
    expect(duplicates(msgs)).toEqual([]);
  });

  test('the same range read twice is flagged at the earlier read\'s full tokens', () => {
    // 1-200, 201-400, then 1-200 again: Claude Code only stubs a re-read with
    // the same offset and limit as the latest read of the file, so this one
    // delivered a second full copy of lines 1-200.
    const msgs = [
      prompt('read app.ts'),
      readCall('r1', FILE, { offset: 1, limit: 200 }), readResult('r1', 1, fileLines(1, 200)),
      readCall('r2', FILE, { offset: 201, limit: 200 }), readResult('r2', 201, fileLines(201, 200)),
      readCall('r3', FILE, { offset: 1, limit: 200 }), readResult('r3', 1, fileLines(1, 200)),
    ];
    const dupes = duplicates(msgs);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.description).toBe('"app.ts" read 3 times (earlier reads at #2 are redundant)');
    expect(dupes[0]!.estimated_tokens).toBe(rowTokens(msgs, 2));
    expect(dupes[0]!.message_range).toEqual([1, 2]);
    expect(dupes[0]!.severity).toBe('medium');
  });

  test('a full read then an overlapping partial read is flagged for the overlap only', () => {
    const msgs = [
      prompt('read app.ts'),
      readCall('r1', FILE), readResult('r1', 1, fileLines(1, 400)),
      readCall('r2', FILE, { offset: 101, limit: 100 }), readResult('r2', 101, fileLines(101, 100)),
    ];
    const dupes = duplicates(msgs);
    expect(dupes).toHaveLength(1);
    // 100 of the 400 lines the first read delivered were delivered again
    expect(dupes[0]!.estimated_tokens).toBe(Math.round(rowTokens(msgs, 2) * 0.25));
    expect(dupes[0]!.description).toBe('"app.ts" read 2 times (earlier reads at #2 lines 101-200 are redundant)');
  });

  test('the repeated share is weighed by line text, not line count', () => {
    // Lines 1-3 are blank-ish, line 4 is long: re-reading only line 4
    // repeats nearly all of the first read's text, not a quarter of it.
    const lines = ['', '}', '', `const table = [${'1, '.repeat(400)}];`];
    const msgs = [
      prompt('read app.ts'),
      readCall('r1', FILE, { offset: 1, limit: 4 }), readResult('r1', 1, lines),
      readCall('r2', FILE, { offset: 4, limit: 1 }), readResult('r2', 4, [lines[3]!]),
    ];
    const dupes = duplicates(msgs);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.estimated_tokens).toBeGreaterThan(rowTokens(msgs, 2) * 0.95);
    expect(dupes[0]!.description).toContain('#2 line 4 are redundant');
  });

  test('a read without limit covers the lines it delivered, not the whole file', () => {
    // No limit: Claude Code stopped at its 2,000-line default, so the next
    // page (offset 2001) is new content, not a re-read of "the whole file".
    const short = (start: number, count: number): string[] =>
      Array.from({ length: count }, (_, k) => `row ${start + k}`);
    const msgs = [
      prompt('read the log'),
      readCall('r1', FILE), readResult('r1', 1, short(1, 2_000)),
      readCall('r2', FILE, { offset: 2_001, limit: 2_000 }), readResult('r2', 2_001, short(2_001, 2_000)),
    ];
    expect(duplicates(msgs)).toEqual([]);
  });

  test('later reads that overlap each other are counted once (union, not sum)', () => {
    // r1 = 1-400; r2 = 1-200 and r3 = 101-300 repeat 300 of its lines, not
    // 400. r2 is itself repeated by r3 on lines 101-200.
    const msgs = [
      prompt('read app.ts'),
      readCall('r1', FILE), readResult('r1', 1, fileLines(1, 400)),
      readCall('r2', FILE, { offset: 1, limit: 200 }), readResult('r2', 1, fileLines(1, 200)),
      readCall('r3', FILE, { offset: 101, limit: 200 }), readResult('r3', 101, fileLines(101, 200)),
    ];
    const dupes = duplicates(msgs);
    expect(dupes).toHaveLength(1);
    const expected = Math.round(rowTokens(msgs, 2) * 0.75) + Math.round(rowTokens(msgs, 4) * 0.5);
    expect(dupes[0]!.estimated_tokens).toBe(expected);
    expect(dupes[0]!.description).toBe('"app.ts" read 3 times (earlier reads at #2 lines 1-300, #4 lines 101-200 are redundant)');
  });

  test('ranges come from the numbered text when no structured result was written', () => {
    // Subagent transcripts mostly lack toolUseResult; 2.1.3xx may use ':'
    // for files with tab-indented lines; before 2.1.86 the lines were padded
    // with an arrow (cat -n format).
    for (const separator of ['\t', ':', '\u2192']) {
      const plain = (id: string, start: number, count: number): SessionMessage =>
        readResult(id, start, fileLines(start, count), { structured: false, separator });
      const paging = [
        prompt('read app.ts'),
        readCall('r1', FILE, { offset: 1, limit: 200 }), plain('r1', 1, 200),
        readCall('r2', FILE, { offset: 201, limit: 200 }), plain('r2', 201, 200),
      ];
      expect(duplicates(paging)).toEqual([]);

      const overlap = [
        prompt('read app.ts'),
        readCall('r1', FILE, { offset: 1, limit: 200 }), plain('r1', 1, 200),
        readCall('r2', FILE, { offset: 151, limit: 200 }), plain('r2', 151, 200),
      ];
      const dupes = duplicates(overlap);
      expect(dupes).toHaveLength(1);
      expect(dupes[0]!.description).toContain('#2 lines 151-200 are redundant');
    }
  });

  test('paths match across slash style and case', () => {
    const msgs = [
      prompt('read app.ts'),
      readCall('r1', 'C:\\proj\\src\\app.ts', { offset: 1, limit: 200 }), readResult('r1', 1, fileLines(1, 200)),
      readCall('r2', FILE, { offset: 201, limit: 50 }), readResult('r2', 201, fileLines(201, 50)),
      readCall('r3', 'c:/PROJ/src/app.ts', { offset: 1, limit: 200 }), readResult('r3', 1, fileLines(1, 200)),
    ];
    expect(duplicates(msgs)).toHaveLength(1);
  });
});

describe('duplicate reads are edit-aware', () => {
  /** Two reads of lines 1-200 of FILE (identical text) around `between`. */
  function aroundEdit(between: SessionMessage[]): SessionMessage[] {
    return [
      prompt('fix app.ts'),
      readCall('r1', FILE, { offset: 1, limit: 200 }), readResult('r1', 1, fileLines(1, 200)),
      readCall('rx', FILE, { offset: 201, limit: 50 }), readResult('rx', 201, fileLines(201, 50)),
      ...between,
      readCall('r2', FILE, { offset: 1, limit: 200 }), readResult('r2', 1, fileLines(1, 200)),
    ];
  }

  test('without an edit in between, the re-read is flagged (control)', () => {
    expect(duplicates(aroundEdit([]))).toHaveLength(1);
  });

  test('an Edit in between makes the re-read legitimate', () => {
    const edit = [call('e1', 'Edit', { file_path: FILE, old_string: 'a', new_string: 'b' }), result('e1', 'The file has been updated.')];
    expect(duplicates(aroundEdit(edit))).toEqual([]);
  });

  test('Write, MultiEdit and NotebookEdit (notebook_path) count as edits', () => {
    for (const [name, input] of [
      ['Write', { file_path: FILE, content: 'new' }],
      ['MultiEdit', { file_path: FILE, edits: [] }],
      ['NotebookEdit', { notebook_path: FILE, new_source: 'x' }],
    ] as const) {
      const edit = [call('e1', name, input), result('e1', 'ok')];
      expect(duplicates(aroundEdit(edit))).toEqual([]);
    }
  });

  test('a failed edit in between still counts (Claude Code makes the model re-read first)', () => {
    const edit = [
      call('e1', 'Edit', { file_path: FILE, old_string: 'a', new_string: 'b' }),
      result('e1', 'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.', {}, true),
    ];
    expect(duplicates(aroundEdit(edit))).toEqual([]);
  });

  test('an edit of a different file does not excuse the re-read', () => {
    const edit = [call('e1', 'Edit', { file_path: 'C:/proj/src/other.ts', old_string: 'a', new_string: 'b' }), result('e1', 'ok')];
    expect(duplicates(aroundEdit(edit))).toHaveLength(1);
  });

  test('the same lines with different text mean the file changed outside the edit tools', () => {
    // A shell command rewrote the file: the later read is current content.
    const msgs = [
      prompt('fix app.ts'),
      readCall('r1', FILE, { offset: 1, limit: 200 }), readResult('r1', 1, fileLines(1, 200, 'v1')),
      readCall('rx', FILE, { offset: 201, limit: 50 }), readResult('rx', 201, fileLines(201, 50)),
      call('b1', 'Bash', { command: "sed -i 's/v1/v2/' app.ts" }), result('b1', ''),
      readCall('r2', FILE, { offset: 1, limit: 200 }), readResult('r2', 1, fileLines(1, 200, 'v2')),
    ];
    expect(duplicates(msgs)).toEqual([]);
  });
});

describe('a later read that delivered no content is not a second copy', () => {
  /** Lines 1-200, then 201-250, then `again` as the reply to a re-read of 1-200. */
  function reReadAnsweredBy(again: SessionMessage): SessionMessage[] {
    return [
      prompt('read app.ts'),
      readCall('r1', FILE, { offset: 1, limit: 200 }), readResult('r1', 1, fileLines(1, 200)),
      readCall('rx', FILE, { offset: 201, limit: 50 }), readResult('rx', 201, fileLines(201, 50)),
      readCall('r2', FILE, { offset: 1, limit: 200 }), again,
    ];
  }

  test('Claude Code\'s file_unchanged stub (structured result) is not flagged', () => {
    const stub = result('r2', WASTED_CALL_STUB, { toolUseResult: { type: 'file_unchanged', file: { filePath: FILE } } });
    expect(duplicates(reReadAnsweredBy(stub))).toEqual([]);
  });

  test('the stub texts are recognised without a structured result', () => {
    const seeded = `<system-reminder>This file is already in your context (see "Contents of ${FILE}" above) and has not changed on disk. Use that content instead of re-reading.</system-reminder>`;
    for (const text of [WASTED_CALL_STUB, OLD_UNCHANGED_STUB, seeded]) {
      expect(duplicates(reReadAnsweredBy(result('r2', text)))).toEqual([]);
    }
  });

  test('an error or a short notice is not flagged', () => {
    const error = result('r2', 'File content (30000 tokens) exceeds maximum allowed tokens (25000).', {}, true);
    const notice = result('r2', '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>');
    expect(duplicates(reReadAnsweredBy(error))).toEqual([]);
    expect(duplicates(reReadAnsweredBy(notice))).toEqual([]);
  });

  test('a stub as the EARLIER read is not waste either', () => {
    const msgs = [
      prompt('read app.ts'),
      readCall('r1', FILE, { offset: 1, limit: 200 }), result('r1', WASTED_CALL_STUB, { toolUseResult: { type: 'file_unchanged', file: { filePath: FILE } } }),
      readCall('r2', FILE, { offset: 1, limit: 200 }), readResult('r2', 1, fileLines(1, 200)),
    ];
    expect(duplicates(msgs)).toEqual([]);
  });
});

describe('duplicate read sizing and scope', () => {
  test('parallel reads are sized from their own results, not the next record', () => {
    // Claude Code writes parallel calls as consecutive assistant lines and
    // then their results, so the record after the first call is the second
    // call, not the first call's result.
    const other = 'C:/proj/src/other.ts';
    const msgs = [
      prompt('read both'),
      readCall('a1', FILE, { offset: 1, limit: 200 }),
      readCall('b1', other, { offset: 1, limit: 5 }),
      readResult('a1', 1, fileLines(1, 200)),
      result('b1', numbered(1, fileLines(1, 5))),
      readCall('ax', FILE, { offset: 201, limit: 50 }), readResult('ax', 201, fileLines(201, 50)),
      readCall('a2', FILE, { offset: 1, limit: 200 }), readResult('a2', 1, fileLines(1, 200)),
    ];
    const dupes = duplicates(msgs);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.estimated_tokens).toBe(rowTokens(msgs, 3));
  });

  test('a repeated share under 100 tokens is not reported', () => {
    const tiny = (id: string): SessionMessage => readResult(id, 1, ['a = 1;', 'b = 2;']);
    const msgs = [
      prompt('read app.ts'),
      readCall('r1', FILE, { offset: 1, limit: 2 }), tiny('r1'),
      readCall('rx', FILE, { offset: 3, limit: 2 }), readResult('rx', 3, ['c = 3;', 'd = 4;']),
      readCall('r2', FILE, { offset: 1, limit: 2 }), tiny('r2'),
    ];
    expect(duplicates(msgs)).toEqual([]);
  });

  test('reads past --until are not part of the view', () => {
    const msgs = [
      prompt('read app.ts'),
      readCall('r1', FILE, { offset: 1, limit: 200 }), readResult('r1', 1, fileLines(1, 200)),
      readCall('rx', FILE, { offset: 201, limit: 50 }), readResult('rx', 201, fileLines(201, 50)),
      readCall('r2', FILE, { offset: 1, limit: 200 }), readResult('r2', 1, fileLines(1, 200)),
    ];
    expect(duplicates(msgs)).toHaveLength(1);
    expect(duplicates(msgs, 5)).toEqual([]);
  });

  test('an unchanged image read twice is flagged; a re-taken one is not', () => {
    const png = 'C:/proj/shot.png';
    const image = (data: string): ContentBlock[] => [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }];
    const twice = (second: string): SessionMessage[] => [
      prompt('look at the screenshot'),
      readCall('i1', png), result('i1', image('AAAA')),
      call('b1', 'Bash', { command: 'take-screenshot' }), result('b1', 'saved'),
      readCall('i2', png), result('i2', image(second)),
    ];
    const same = duplicates(twice('AAAA'));
    expect(same).toHaveLength(1);
    expect(same[0]!.description).toBe('"shot.png" read 2 times (earlier reads at #2 are redundant)');
    expect(duplicates(twice('BBBB'))).toEqual([]);
  });
});

describe('duplicate descriptions keep the shape consumers parse', () => {
  /** A session whose live window is past 50% with one partly repeated file. */
  function session(): SessionMessage[] {
    const msgs = [
      prompt('read app.ts'),
      readCall('r1', FILE), readResult('r1', 1, fileLines(1, 400)),
      readCall('r2', FILE, { offset: 101, limit: 100 }), readResult('r2', 101, fileLines(101, 100)),
      readCall('r3', FILE, { offset: 401, limit: 100 }), readResult('r3', 401, fileLines(401, 100)),
    ];
    msgs.push({
      type: 'assistant',
      uuid: 'a-final',
      message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 150_000, output_tokens: 100 } },
    } as SessionMessage);
    return msgs;
  }

  test('recommendations, fix prompts and /compact focus name the file and the repeated lines', () => {
    const msgs = session();
    const breakdown = classifySession(msgs, EMPTY_CONFIG);
    const waste = detectWaste(msgs, breakdown, EMPTY_CONFIG);
    const dupe = waste.find((w) => w.type === 'duplicate_read')!;
    expect(dupe.description).toMatch(/"app\.ts" read 3 times/);
    expect(dupe.description).toMatch(/reads at #2 lines 101-200 are/);

    const recs = generateRecommendations(breakdown, waste, EMPTY_CONFIG, msgs).recommendations;
    expect(recs.some((r) => r.action === 'app.ts read 3x \u2014 earlier reads at #2 lines 101-200 are waste')).toBe(true);

    const fix = generateFixPrompts(breakdown, waste, EMPTY_CONFIG);
    expect(fix.sessionPrompt).toContain('- app.ts (already read, at messages #2 lines 101-200)');

    const focus = buildCompactFocus(waste)!;
    expect(focus.text).toContain('keep only latest read of app.ts');
    expect(compactCommandFor(waste)).toBe(focus.text);
    expect(fix.compactCommand).toBe(focus.text);
  });
});
