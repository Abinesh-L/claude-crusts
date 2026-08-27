/**
 * Regression coverage for the scanner's parse-time filters (v0.8.0 M1-M3).
 *
 *   M1  Resume replays are deduplicated by uuid (first occurrence wins).
 *   M2  The synthetic / API-error filter reads `message.model` and
 *       `isApiErrorMessage`; detectViaMarkers skips placeholders when
 *       picking tokensAfter.
 *   M3  Non-API `system` records (turn_duration, api_error, away_summary,
 *       local_command, scheduled_task_fire, model_refusal_fallback) are
 *       dropped at parse time; only compact_boundary survives.
 *
 * Fixtures are tiny inline JSONL files written to a mkdtemp sandbox. Nothing
 * under ~/.claude or ~/.claude-crusts is touched.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseSession,
  isAnalyzedRecord,
  discoverSessions,
  detectClaudeCodeVersion,
  readClaudeCodeVersion,
  VERSION_PROBE_MAX_BYTES,
} from '../src/scanner.ts';
import { classifySession, detectCompactionEvents } from '../src/classifier.ts';
import type { SessionMessage, ConfigData } from '../src/types.ts';

const sandbox = mkdtempSync(join(tmpdir(), 'crusts-scanner-test-'));
let fixtureCounter = 0;

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const EMPTY_CONFIG: ConfigData = {
  systemPrompt: { files: [], totalEstimatedTokens: 0 },
  mcpServers: [],
  memoryFiles: { files: [], totalEstimatedTokens: 0 },
  builtInTools: { tools: [], totalEstimatedTokens: 0 },
  skills: { items: [], totalEstimatedTokens: 0 },
};

/**
 * Write an array of records as one JSONL fixture inside the sandbox.
 *
 * @param records - Objects to serialise, one per line
 * @returns Absolute path to the written fixture
 */
function writeFixture(records: unknown[]): string {
  const path = join(sandbox, `fixture-${++fixtureCounter}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return path;
}

/**
 * Build a user text record in the shape Claude Code writes.
 *
 * @param uuid - Record uuid (omit for uuid-less fixtures)
 * @param text - Prompt text
 * @returns Plain object ready for JSON serialisation
 */
function userRecord(uuid: string | undefined, text: string): Record<string, unknown> {
  return {
    type: 'user',
    ...(uuid ? { uuid } : {}),
    cwd: 'C:\\proj',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

/**
 * Build an assistant record with API usage in the shape Claude Code writes.
 *
 * @param uuid - Record uuid (omit for uuid-less fixtures)
 * @param input - `usage.input_tokens`
 * @param output - `usage.output_tokens`
 * @param extra - Extra top-level keys (e.g. isApiErrorMessage) or a model override
 * @returns Plain object ready for JSON serialisation
 */
function assistantRecord(
  uuid: string | undefined,
  input: number,
  output: number,
  extra: { model?: string; isApiErrorMessage?: boolean; text?: string } = {},
): Record<string, unknown> {
  return {
    type: 'assistant',
    ...(uuid ? { uuid } : {}),
    cwd: 'C:\\proj',
    ...(extra.isApiErrorMessage !== undefined ? { isApiErrorMessage: extra.isApiErrorMessage } : {}),
    message: {
      id: `msg_${uuid ?? 'x'}`,
      role: 'assistant',
      model: extra.model ?? 'claude-opus-4-8',
      content: [{ type: 'text', text: extra.text ?? 'ok' }],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

/**
 * Build a compact_boundary system record.
 *
 * @param uuid - Record uuid
 * @param preTokens - `compactMetadata.preTokens`
 * @returns Plain object ready for JSON serialisation
 */
function boundaryRecord(uuid: string, preTokens: number): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid,
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens, postTokens: 8_000 },
  };
}

/**
 * Build a compaction summary user record.
 *
 * @param uuid - Record uuid
 * @returns Plain object ready for JSON serialisation
 */
function summaryRecord(uuid: string): Record<string, unknown> {
  return {
    type: 'user',
    uuid,
    isCompactSummary: true,
    message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
  };
}

// ---------------------------------------------------------------------------
// M1: uuid dedupe
// ---------------------------------------------------------------------------

describe('parseSession uuid dedupe (M1)', () => {
  /** Six-line block: prompt, answer, boundary, summary, prompt, answer. */
  const block = (cwd: string, replayOutputZero = false): Record<string, unknown>[] => [
    { ...userRecord('u1', 'first question'), cwd },
    { ...assistantRecord('a1', 1_000, 100), cwd },
    { ...boundaryRecord('b1', 150_000), cwd },
    { ...summaryRecord('s1'), cwd },
    { ...userRecord('u2', 'second question'), cwd },
    // Real replays of an assistant sometimes carry zero usage; the first
    // occurrence (with real usage) must win.
    { ...(replayOutputZero ? assistantRecord('a2', 0, 0) : assistantRecord('a2', 30_000, 200)), cwd },
  ];

  test('a replayed block with a duplicated compact_boundary is counted once', async () => {
    const path = writeFixture([
      ...block('C:\\proj'),
      { type: 'queue-operation', operation: 'dequeue', uuid: 'q1' },
      ...block('C:\\proj\\sub', true),
    ]);
    const messages = await parseSession(path);

    expect(messages.length).toBe(6);
    expect(new Set(messages.map((m) => m.uuid)).size).toBe(6);
    // First copy wins: the kept a2 carries its real usage, not the zero replay.
    const a2 = messages.find((m) => m.uuid === 'a2')!;
    expect(a2.message?.usage?.output_tokens).toBe(200);
    expect(a2.cwd).toBe('C:\\proj');

    const events = detectCompactionEvents(messages);
    expect(events.length).toBe(1);
    expect(events[0]!.tokensBefore).toBe(150_000);
    expect(events[0]!.tokensAfter).toBe(30_000);

    const b = classifySession(messages, EMPTY_CONFIG);
    expect(b.compactionEvents.length).toBe(1);
    expect(b.modelHistory.segments.length).toBe(1);
    // 100 + 200, NOT 100 + 200 + 100 + 0 from the replay.
    expect(b.modelHistory.segments[0]!.totalOutputTokens).toBe(300);
    expect(b.modelHistory.segments[0]!.assistantMessageCount).toBe(2);
  });

  test('records without a uuid are never deduplicated', async () => {
    const path = writeFixture([
      userRecord(undefined, 'same'),
      userRecord(undefined, 'same'),
      userRecord(undefined, 'same'),
      assistantRecord(undefined, 10, 5),
      assistantRecord(undefined, 10, 5),
    ]);
    const messages = await parseSession(path);
    expect(messages.length).toBe(5);
  });

  test('a uuid seen on a dropped record also suppresses its replay', async () => {
    // The first copy is a synthetic placeholder (dropped); its replay must
    // not sneak in as a fresh record either.
    const path = writeFixture([
      assistantRecord('syn', 0, 0, { model: '<synthetic>', text: 'No response requested.' }),
      assistantRecord('syn', 0, 0, { model: '<synthetic>', text: 'No response requested.' }),
      assistantRecord('real', 500, 50),
    ]);
    const messages = await parseSession(path);
    expect(messages.map((m) => m.uuid)).toEqual(['real']);
  });

  test('detectViaMarkers belt: duplicate boundary uuids yield one event, uuid-less boundaries stay separate', () => {
    const withUuid: SessionMessage[] = [
      { type: 'system', subtype: 'compact_boundary', uuid: 'b', compactMetadata: { trigger: 'auto', preTokens: 100_000 } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 20_000, output_tokens: 10 } } },
      { type: 'system', subtype: 'compact_boundary', uuid: 'b', compactMetadata: { trigger: 'auto', preTokens: 100_000 } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 21_000, output_tokens: 10 } } },
    ];
    expect(detectCompactionEvents(withUuid).length).toBe(1);

    const withoutUuid: SessionMessage[] = withUuid.map((m) => {
      const { uuid: _uuid, ...rest } = m;
      return rest as SessionMessage;
    });
    expect(detectCompactionEvents(withoutUuid).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// M2: synthetic / API-error filter
// ---------------------------------------------------------------------------

describe('parseSession synthetic and API-error filter (M2)', () => {
  test('message.model "<synthetic>" directly after a boundary is dropped and tokensAfter comes from the next real assistant', async () => {
    const path = writeFixture([
      userRecord('u1', 'q1'),
      assistantRecord('a1', 140_000, 100),
      boundaryRecord('b1', 150_000),
      // Real shape: zero usage, message.model '<synthetic>', NO top-level model key.
      assistantRecord('syn', 0, 0, { model: '<synthetic>', text: 'No response requested.', isApiErrorMessage: false }),
      summaryRecord('s1'),
      userRecord('u2', 'q2'),
      assistantRecord('a2', 25_000, 80),
    ]);
    const messages = await parseSession(path);

    expect(messages.some((m) => m.message?.model === '<synthetic>')).toBe(false);
    expect(messages.length).toBe(6);

    const events = detectCompactionEvents(messages);
    expect(events.length).toBe(1);
    expect(events[0]!.tokensAfter).toBe(25_000);
    expect(events[0]!.tokensDropped).toBe(125_000);
    expect(events[0]!.afterIndex).toBe(messages.findIndex((m) => m.uuid === 'a2'));
  });

  test('isApiErrorMessage: true records are dropped even with a real model id', async () => {
    const path = writeFixture([
      userRecord('u1', 'q1'),
      assistantRecord('err', 0, 0, { text: 'API Error: Server is temporarily limiting requests', isApiErrorMessage: true }),
      assistantRecord('a1', 3_000, 40, { isApiErrorMessage: false }),
    ]);
    const messages = await parseSession(path);
    expect(messages.map((m) => m.uuid)).toEqual(['u1', 'a1']);
  });

  test('a real assistant that only LOOKS synthetic at the top level is kept', async () => {
    // Legacy filter read a top-level `model` key that no record carries.
    // A stray top-level key must not drop a real API response.
    const path = writeFixture([
      { ...assistantRecord('a1', 3_000, 40), model: '<synthetic>' },
    ]);
    const messages = await parseSession(path);
    expect(messages.length).toBe(1);
  });

  test('detectViaMarkers skips synthetic and zero-usage assistants injected post-parse', () => {
    const msgs: SessionMessage[] = [
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 90_000 } },
      { type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [], usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 12_000, output_tokens: 10 } } },
    ];
    const events = detectCompactionEvents(msgs);
    expect(events.length).toBe(1);
    expect(events[0]!.tokensAfter).toBe(12_000);
    expect(events[0]!.afterIndex).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// M3: non-API system records
// ---------------------------------------------------------------------------

describe('parseSession system records (M3)', () => {
  const phantom = (subtype: string, uuid: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'system',
    subtype,
    uuid,
    ...extra,
  });

  /**
   * Fixture layout (kept records numbered):
   *   0 q0  1 a0  2 boundary  3 q1  4 a1  5 q2  6 a2  7 q3  8 a3  9 q4  10 a4  11 q5  12 a5
   * Phantom system records are interleaved throughout. Post-boundary
   * assistants grow by exactly 120 input tokens per pair so framing derives
   * a stable median (output 100 + ~1 token of prompt text + ~19 framing).
   */
  const records = [
    phantom('turn_duration', 'p1', { durationMs: 2_017_763, messageCount: 203, isMeta: true }),
    userRecord('q0', 'q0'),
    assistantRecord('a0', 1_000, 100),
    phantom('api_error', 'p2', { error: { status: 529 }, retryInMs: 1_000, retryAttempt: 1, maxRetries: 10 }),
    phantom('away_summary', 'p3', { content: 'Long recap text shown to the user only. (disable recaps in /config)' }),
    boundaryRecord('b1', 150_000),
    phantom('local_command', 'p4', { content: '<command-name>/context</command-name>' }),
    userRecord('q1', 'q1'),
    assistantRecord('a1', 5_000, 100),
    phantom('scheduled_task_fire', 'p5', { content: 'Claude resuming /loop wakeup' }),
    userRecord('q2', 'q2'),
    assistantRecord('a2', 5_120, 100),
    phantom('turn_duration', 'p6', { durationMs: 10, messageCount: 4, isMeta: true }),
    userRecord('q3', 'q3'),
    assistantRecord('a3', 5_240, 100),
    phantom('model_refusal_fallback', 'p7', { originalModel: 'claude-fable-5', fallbackModel: 'claude-opus-5' }),
    userRecord('q4', 'q4'),
    assistantRecord('a4', 5_360, 100),
    userRecord('q5', 'q5'),
    assistantRecord('a5', 5_480, 100),
  ];

  test('only compact_boundary survives among system records', async () => {
    const messages = await parseSession(writeFixture(records));
    expect(messages.length).toBe(13);
    const systemRecords = messages.filter((m) => m.type === 'system');
    expect(systemRecords.length).toBe(1);
    expect(systemRecords[0]!.subtype).toBe('compact_boundary');
  });

  test('messageCount and the system bucket exclude phantom rows', async () => {
    const messages = await parseSession(writeFixture(records));
    const b = classifySession(messages, EMPTY_CONFIG);

    expect(b.messages.length).toBe(13);
    const systemCount = b.messages.filter((m) => m.category === 'system').length;
    expect(systemCount).toBe(1);
    expect(b.compactionEvents.length).toBe(1);
    expect(b.compactionEvents[0]!.tokensAfter).toBe(5_000);
  });

  test('framing totalTokens is tokensPerMessage times the REAL message count', async () => {
    const messages = await parseSession(writeFixture(records));
    const b = classifySession(messages, EMPTY_CONFIG);
    const framing = b.derivedOverhead.messageFraming;

    expect(framing).not.toBeNull();
    expect(framing!.tokensPerMessage).toBeGreaterThan(0);
    expect(framing!.totalTokens).toBe(framing!.tokensPerMessage * 13);
    // Sanity: 7 phantom rows would have added 7 * tokensPerMessage before the fix.
    expect(framing!.totalTokens).toBeLessThan(framing!.tokensPerMessage * 20);
  });
});

// ---------------------------------------------------------------------------
// v0.8.0 M11 — attachment records are kept
// ---------------------------------------------------------------------------

describe('parseSession attachment records (M11)', () => {
  test('attachment records are kept with their payload', async () => {
    const messages = await parseSession(writeFixture([
      { type: 'attachment', uuid: 'att-1', attachment: { type: 'skill_listing', content: 's'.repeat(400) } },
      userRecord('u1', 'hello'),
      { type: 'attachment', uuid: 'att-2', attachment: { type: 'task_reminder', content: 't'.repeat(80) } },
      assistantRecord('a1', 100, 10),
    ]));
    expect(messages.length).toBe(4);
    expect(messages[0]!.type).toBe('attachment');
    expect(messages[0]!.attachment!.type).toBe('skill_listing');
    expect(messages[2]!.attachment!.type).toBe('task_reminder');
  });

  test('isAnalyzedRecord accepts attachment records', () => {
    expect(isAnalyzedRecord({ type: 'attachment', attachment: { type: 'hook_success', content: 'ok' } })).toBe(true);
  });

  test('attachment replays are deduplicated by uuid like any other record', async () => {
    const att = { type: 'attachment', uuid: 'att-dup', attachment: { type: 'task_reminder', content: 'r'.repeat(40) } };
    const messages = await parseSession(writeFixture([userRecord('u1', 'hi'), att, att]));
    expect(messages.length).toBe(2);
    expect(messages.filter((m) => m.type === 'attachment').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isAnalyzedRecord unit coverage
// ---------------------------------------------------------------------------

describe('isAnalyzedRecord', () => {
  test('keeps user, assistant, and compact_boundary system records', () => {
    expect(isAnalyzedRecord({ type: 'user', message: { role: 'user', content: 'hi' } })).toBe(true);
    expect(isAnalyzedRecord({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [] } })).toBe(true);
    expect(isAnalyzedRecord({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 1 } })).toBe(true);
  });

  test('drops every other system subtype', () => {
    for (const subtype of ['turn_duration', 'api_error', 'away_summary', 'local_command', 'scheduled_task_fire', 'model_refusal_fallback', 'bridge_status', 'informational', 'agents_killed']) {
      expect(isAnalyzedRecord({ type: 'system', subtype })).toBe(false);
    }
    expect(isAnalyzedRecord({ type: 'system' })).toBe(false);
  });

  test('drops synthetic and API-error placeholders', () => {
    expect(isAnalyzedRecord({ type: 'assistant', message: { model: '<synthetic>' } })).toBe(false);
    expect(isAnalyzedRecord({ type: 'assistant', isApiErrorMessage: true, message: { model: 'claude-opus-5' } })).toBe(false);
    expect(isAnalyzedRecord({ type: 'assistant', isApiErrorMessage: false, message: { model: 'claude-opus-5' } })).toBe(true);
  });

  test('drops bookkeeping record types and malformed shapes', () => {
    for (const type of ['progress', 'last-prompt', 'file-history-snapshot', 'queue-operation', 'mode', 'permission-mode', 'ai-title']) {
      expect(isAnalyzedRecord({ type })).toBe(false);
    }
    expect(isAnalyzedRecord({})).toBe(false);
    expect(isAnalyzedRecord({ type: 42 })).toBe(false);
  });
});

describe('parseSession malformed input', () => {
  test('skips malformed lines and blank lines without dropping the rest', async () => {
    const path = join(sandbox, 'malformed.jsonl');
    writeFileSync(path, [
      JSON.stringify(userRecord('u1', 'hello')),
      '',
      '{not json',
      JSON.stringify(assistantRecord('a1', 10, 5)),
    ].join('\n'), 'utf-8');
    const messages = await parseSession(path);
    expect(messages.map((m) => m.uuid)).toEqual(['u1', 'a1']);
  });

  test('returns an empty array for a missing file', async () => {
    const messages = await parseSession(join(sandbox, 'does-not-exist.jsonl'));
    expect(messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v0.8.0 M4 — claudeCodeVersion capture
// ---------------------------------------------------------------------------

describe('claudeCodeVersion (M4)', () => {
  /**
   * Fixture mirroring a real file head: unversioned bookkeeping records
   * first, then a large versioned SessionStart attachment, then turns.
   *
   * @returns Records ready for `writeFixture`
   */
  function versionedRecords(): unknown[] {
    return [
      { type: 'last-prompt', lastPrompt: 'hi' },
      { type: 'mode', mode: 'default' },
      { type: 'permission-mode', permissionMode: 'auto' },
      { type: 'attachment', uuid: 'att-1', version: '2.1.239', attachment: { type: 'hook_success', content: 'x'.repeat(20_000) } },
      { ...userRecord('u1', 'hello'), version: '2.1.239' },
      { ...assistantRecord('a1', 100, 10), version: '2.1.240' },
    ];
  }

  test('readClaudeCodeVersion returns the first non-empty version in the file head', () => {
    const path = writeFixture(versionedRecords());
    expect(readClaudeCodeVersion(path)).toBe('2.1.239');
  });

  test('readClaudeCodeVersion finds a version that sits beyond the first 64 KB chunk', () => {
    const records = [
      { type: 'last-prompt', lastPrompt: 'hi' },
      // 100 KB unversioned line pushes the first versioned record past one chunk
      { type: 'file-history-snapshot', snapshot: { blob: 'y'.repeat(100_000) } },
      { ...userRecord('u1', 'hello'), version: '2.1.224' },
    ];
    expect(readClaudeCodeVersion(writeFixture(records))).toBe('2.1.224');
  });

  test('readClaudeCodeVersion survives a multi-byte character straddling the chunk boundary', () => {
    const head = JSON.stringify({ type: 'last-prompt', lastPrompt: 'hi' }) + '\n';
    const prefix = '{"type":"user","version":"2.1.239","message":{"role":"user","content":"';
    let start = Buffer.byteLength(head) + prefix.length;
    let filler = '';
    // Make byte 65,536 land on the SECOND byte of a 2-byte character.
    if ((65_536 - start) % 2 === 0) {
      filler = 'a';
      start += 1;
    }
    const body = filler + 'é'.repeat(40_000);
    const line = prefix + body + '"}}\n';
    const path = join(sandbox, 'utf8-boundary.jsonl');
    writeFileSync(path, head + line, 'utf-8');
    expect(readClaudeCodeVersion(path)).toBe('2.1.239');
  });

  test('readClaudeCodeVersion ignores a "version" key that is not top-level', () => {
    const records = [
      userRecord('u1', 'paste: {"version":"9.9.9"}'),
      { ...assistantRecord('a1', 100, 10), version: '2.1.224' },
    ];
    expect(readClaudeCodeVersion(writeFixture(records))).toBe('2.1.224');
  });

  test('readClaudeCodeVersion returns undefined when nothing in the probe window is versioned', () => {
    expect(readClaudeCodeVersion(writeFixture([userRecord('u1', 'hello'), assistantRecord('a1', 1, 1)]))).toBeUndefined();
    expect(readClaudeCodeVersion(join(sandbox, 'missing.jsonl'))).toBeUndefined();
    // Versioned record only after the probe cap: not found, and no crash
    const late = [
      { type: 'file-history-snapshot', snapshot: { blob: 'z'.repeat(VERSION_PROBE_MAX_BYTES + 10) } },
      { ...userRecord('u1', 'hello'), version: '2.1.224' },
    ];
    expect(readClaudeCodeVersion(writeFixture(late))).toBeUndefined();
  });

  test('discoverSessions populates SessionInfo.claudeCodeVersion', () => {
    const base = join(sandbox, 'projects');
    const projectDir = join(base, 'C--proj');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'sess-1.jsonl'), versionedRecords().map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    writeFileSync(join(projectDir, 'sess-2.jsonl'), JSON.stringify(userRecord('u9', 'legacy')) + '\n', 'utf-8');
    const sessions = discoverSessions(base);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    expect(byId.get('sess-1')!.claudeCodeVersion).toBe('2.1.239');
    expect(byId.get('sess-2')!.claudeCodeVersion).toBeUndefined();
  });

  test('parseSession keeps version on records and detectClaudeCodeVersion picks the first non-empty one', async () => {
    const messages = await parseSession(writeFixture([
      { ...userRecord('u0', 'first'), version: '' },
      ...versionedRecords(),
    ]));
    // The unversioned u0 turn survives first; detectClaudeCodeVersion skips
    // its empty version and picks the SessionStart attachment's (kept per M11)
    expect(messages[0]!.version).toBe('');
    expect(detectClaudeCodeVersion(messages)).toBe('2.1.239');
    expect(detectClaudeCodeVersion([])).toBeUndefined();
  });
});
