/**
 * 0.8.2: per-session summaries written by the auto-inject hook, kept in
 * `~/.claude-crusts/sessions/<sessionId>.json` so a session's history
 * outlives Claude Code's transcript cleanup (cleanupPeriodDays).
 *
 * Every test sandboxes the crusts folder with CRUSTS_CONFIG_DIR_OVERRIDE;
 * the end-to-end test also points HOME / USERPROFILE and the inject-log and
 * calibration overrides into the sandbox, so nothing under ~/.claude or
 * ~/.claude-crusts is read or written.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  recordSessionSummary,
  readSessionSummary,
  loadSessionSummaries,
  sessionSummaryPath,
  SUMMARY_REFRESH_MS,
} from '../src/session-summary.ts';
import type { SessionObservation, SessionSummaryRecord } from '../src/session-summary.ts';
import { crustsSessionsDir, writeFileAtomic } from '../src/config.ts';
import type { CompactionEvent, CrustsBreakdown, SessionMessage } from '../src/types.ts';

const SID = '0b5f2c1e-7d3a-4c2b-9e8f-1a2b3c4d5e6f';
const TRANSCRIPT = join('C:', 'Users', 'someone', '.claude', 'projects', 'C--work-app', `${SID}.jsonl`);
const T0 = Date.parse('2026-10-24T12:00:00.000Z');
const MINUTE = 60_000;

/** A 1M-window breakdown with a live window of `live` tokens. */
function breakdownAt(live: number, overrides: Partial<CrustsBreakdown> = {}): CrustsBreakdown {
  return {
    buckets: [],
    total_tokens: live,
    context_limit: 1_000_000,
    free_tokens: 1_000_000 - live,
    usage_percentage: live / 10_000,
    messages: [],
    toolBreakdown: {
      loadedTools: [], usedTools: [], unusedTools: [], schemaTokens: 0, callTokens: 0, resultTokens: 0,
      coreSchemaTokens: 0, coreSchemaSource: 'legacy', deferredBuiltIn: [], deferredMcp: [], loadedDeferred: [], loadedSchemaTokens: 0,
    },
    model: 'claude-opus-4-8',
    claudeCodeVersion: '2.1.310',
    durationSeconds: null,
    compactionEvents: [],
    compaction: {
      trigger: 967_000,
      autoCompactWindow: 1_000_000,
      windowSource: 'default',
      bufferTokens: 33_000,
      idle: { enabled: true, minTokens: 200_000, afterMinutes: 54, cacheTtl: '1h', applies: false },
    },
    ...overrides,
  } as CrustsBreakdown;
}

/** A marker compaction whose boundary record sits at `index`. */
function marker(index: number, preTokens: number, tokensAfter: number, extra: Partial<CompactionEvent> = {}): CompactionEvent {
  return {
    beforeIndex: index,
    afterIndex: index + 2,
    tokensBefore: preTokens,
    tokensAfter,
    tokensDropped: preTokens - tokensAfter,
    detection: 'marker',
    trigger: 'auto',
    postTokens: 12_000,
    ...extra,
  };
}

/** Records with compact_boundary records at indices 2 and 6, timed as given. */
function records(boundaryTimes: [string, string] = ['2026-10-24T10:00:00.000Z', '2026-10-24T11:00:00.000Z']): SessionMessage[] {
  const rows: SessionMessage[] = [];
  for (let i = 0; i < 9; i++) rows.push({ type: 'user', timestamp: '2026-10-24T09:00:00.000Z' } as SessionMessage);
  rows[2] = { type: 'system', subtype: 'compact_boundary', timestamp: boundaryTimes[0] } as SessionMessage;
  rows[6] = { type: 'system', subtype: 'compact_boundary', timestamp: boundaryTimes[1] } as SessionMessage;
  return rows;
}

/** An observation of the test session. */
function observe(breakdown: CrustsBreakdown, extra: Partial<SessionObservation> = {}): SessionObservation {
  return { sessionId: SID, transcriptPath: TRANSCRIPT, breakdown, messages: records(), ...extra };
}

/** The stored summary file, parsed. */
function stored(): SessionSummaryRecord {
  return JSON.parse(readFileSync(sessionSummaryPath(SID)!, 'utf-8')) as SessionSummaryRecord;
}

describe('0.8.2 session summaries (sandboxed)', () => {
  let sandbox: string;
  let savedOverride: string | undefined;

  beforeEach(() => {
    sandbox = resolve(mkdtempSync(join(tmpdir(), 'crusts-sessions-')));
    savedOverride = process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
    process.env.CRUSTS_CONFIG_DIR_OVERRIDE = sandbox;
  });

  afterEach(() => {
    if (savedOverride === undefined) delete process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
    else process.env.CRUSTS_CONFIG_DIR_OVERRIDE = savedOverride;
    rmSync(sandbox, { recursive: true, force: true });
  });

  test('the sessions folder follows CRUSTS_CONFIG_DIR_OVERRIDE', () => {
    expect(crustsSessionsDir()).toBe(join(sandbox, 'sessions'));
    expect(sessionSummaryPath(SID)).toBe(join(sandbox, 'sessions', `${SID}.json`));
  });

  test('first write stores every v1 field', () => {
    expect(recordSessionSummary(observe(breakdownAt(412_345)), T0)).toBe('written');
    const summary = stored();
    expect(summary).toEqual({
      v: 1,
      sessionId: SID,
      project: 'C--work-app',
      transcriptPath: TRANSCRIPT,
      firstSeen: '2026-10-24T12:00:00.000Z',
      lastSeen: '2026-10-24T12:00:00.000Z',
      claudeCodeVersion: '2.1.310',
      model: 'claude-opus-4-8',
      contextLimit: 1_000_000,
      autoCompactWindow: 1_000_000,
      trigger: 967_000,
      peakTokens: 412_345,
      lastTokens: 412_345,
      compactions: [],
      advisories: { count: 0, lastAt: null },
    });
    expect(readSessionSummary(SID)).toEqual(summary);
    // Indented JSON with a trailing newline, and no temp file left behind.
    expect(readFileSync(sessionSummaryPath(SID)!, 'utf-8').endsWith('}\n')).toBe(true);
    expect(readdirSync(join(sandbox, 'sessions'))).toEqual([`${SID}.json`]);
  });

  test('an unchanged session does not rewrite the file', () => {
    recordSessionSummary(observe(breakdownAt(300_000)), T0);
    const before = readFileSync(sessionSummaryPath(SID)!, 'utf-8');
    expect(recordSessionSummary(observe(breakdownAt(300_000)), T0 + MINUTE)).toBe('unchanged');
    expect(readFileSync(sessionSummaryPath(SID)!, 'utf-8')).toBe(before);
  });

  test('lastSeen is refreshed at most every 10 minutes while nothing changes', () => {
    expect(SUMMARY_REFRESH_MS).toBe(10 * MINUTE);
    recordSessionSummary(observe(breakdownAt(300_000)), T0);
    expect(recordSessionSummary(observe(breakdownAt(300_000)), T0 + 9 * MINUTE)).toBe('unchanged');
    expect(stored().lastSeen).toBe(new Date(T0).toISOString());
    expect(recordSessionSummary(observe(breakdownAt(300_000)), T0 + 10 * MINUTE)).toBe('refreshed');
    expect(stored().lastSeen).toBe(new Date(T0 + 10 * MINUTE).toISOString());
    expect(stored().firstSeen).toBe(new Date(T0).toISOString());
    expect(recordSessionSummary(observe(breakdownAt(300_000)), T0 + 15 * MINUTE)).toBe('unchanged');
  });

  test('a change is written at once and moves lastSeen', () => {
    recordSessionSummary(observe(breakdownAt(300_000)), T0);
    expect(recordSessionSummary(observe(breakdownAt(310_000)), T0 + MINUTE)).toBe('written');
    expect(stored().lastTokens).toBe(310_000);
    expect(stored().lastSeen).toBe(new Date(T0 + MINUTE).toISOString());
  });

  test('a new compaction is added with its boundary time, and the peak keeps the old window', () => {
    recordSessionSummary(observe(breakdownAt(900_000)), T0);
    const first = marker(2, 950_000, 80_000);
    expect(recordSessionSummary(observe(breakdownAt(85_000, { compactionEvents: [first] })), T0 + MINUTE)).toBe('written');
    let summary = stored();
    expect(summary.compactions).toEqual([
      { at: '2026-10-24T10:00:00.000Z', trigger: 'auto', idle: false, preTokens: 950_000, postTokens: 12_000, tokensAfter: 80_000 },
    ]);
    expect(summary.peakTokens).toBe(950_000);
    expect(summary.lastTokens).toBe(85_000);

    const second = marker(6, 700_000, 60_000, { trigger: 'manual', postTokens: undefined });
    recordSessionSummary(observe(breakdownAt(61_000, { compactionEvents: [first, second] })), T0 + 2 * MINUTE);
    summary = stored();
    expect(summary.compactions.map((c) => c.at)).toEqual(['2026-10-24T10:00:00.000Z', '2026-10-24T11:00:00.000Z']);
    expect(summary.compactions[1]).toEqual({
      at: '2026-10-24T11:00:00.000Z', trigger: 'manual', idle: false, preTokens: 700_000, postTokens: null, tokensAfter: 60_000,
    });
    expect(summary.peakTokens).toBe(950_000);
  });

  test("the transcript's account of a compaction wins, and compactions it no longer holds are kept", () => {
    const first = marker(2, 950_000, 80_000);
    const second = marker(6, 700_000, 61_500);
    recordSessionSummary(observe(breakdownAt(61_000, { compactionEvents: [first, second] })), T0);
    // The first turn after the second compaction landed (exact tokensAfter)
    // and its idle notice followed the boundary.
    const settled = marker(6, 700_000, 58_000, { idle: true });
    recordSessionSummary(observe(breakdownAt(62_000, { compactionEvents: [first, settled] })), T0 + MINUTE);
    expect(stored().compactions[1]).toMatchObject({ idle: true, tokensAfter: 58_000 });
    expect(stored().compactions.length).toBe(2);
    // A trimmed transcript (history before the last compaction removed)
    // only holds the second boundary now, at index 2 of the shorter file.
    const trimmed = records(['2026-10-24T11:00:00.000Z', '2026-10-24T11:30:00.000Z']);
    const after = marker(2, 700_000, 58_000, { idle: true });
    recordSessionSummary(observe(breakdownAt(70_000, { compactionEvents: [after] }), { messages: trimmed }), T0 + 2 * MINUTE);
    expect(stored().compactions.map((c) => c.preTokens)).toEqual([950_000, 700_000]);
  });

  test('the starting Claude Code version stays put; the model follows the session', () => {
    recordSessionSummary(observe(breakdownAt(100_000, { claudeCodeVersion: '2.1.300' })), T0);
    // A trimmed transcript opens with later records; a /model switch moves the model.
    recordSessionSummary(observe(breakdownAt(120_000, { claudeCodeVersion: '2.1.310', model: 'claude-fable-5' })), T0 + MINUTE);
    expect(stored()).toMatchObject({ claudeCodeVersion: '2.1.300', model: 'claude-fable-5' });
  });

  test('token-drop guesses are not recorded as compactions', () => {
    const guess: CompactionEvent = { ...marker(2, 400_000, 100_000), detection: 'heuristic', trigger: undefined, postTokens: undefined };
    recordSessionSummary(observe(breakdownAt(100_000, { compactionEvents: [guess] })), T0);
    expect(stored().compactions).toEqual([]);
  });

  test('advisories are counted with the time of the latest', () => {
    recordSessionSummary(observe(breakdownAt(880_000), { advisoryAt: '2026-10-24T12:00:00.500Z' }), T0);
    expect(stored().advisories).toEqual({ count: 1, lastAt: '2026-10-24T12:00:00.500Z' });
    recordSessionSummary(observe(breakdownAt(880_000)), T0 + MINUTE);
    expect(stored().advisories).toEqual({ count: 1, lastAt: '2026-10-24T12:00:00.500Z' });
    recordSessionSummary(observe(breakdownAt(890_000), { advisoryAt: '2026-10-24T12:06:00.000Z' }), T0 + 6 * MINUTE);
    expect(stored().advisories).toEqual({ count: 2, lastAt: '2026-10-24T12:06:00.000Z' });
  });

  test('the live window, trigger and window follow the compaction model', () => {
    const post = breakdownAt(950_000, {
      currentContext: { buckets: [], total_tokens: 70_400.6, free_tokens: 0, usage_percentage: 7, startIndex: 3 },
      compaction: {
        trigger: null, autoCompactWindow: 400_000, windowSource: 'disabled', bufferTokens: 33_000,
        idle: { enabled: false, minTokens: 200_000, afterMinutes: 54, cacheTtl: 'unknown', applies: false },
      },
    });
    recordSessionSummary(observe(post), T0);
    expect(stored()).toMatchObject({ lastTokens: 70_401, trigger: null, autoCompactWindow: 400_000 });
    // A breakdown without a compaction model: the window less the buffer, as the inject gate reads it.
    const bare = breakdownAt(100_000, { compaction: undefined, context_limit: 200_000 });
    recordSessionSummary({ ...observe(bare), sessionId: 'bare-session', bufferTokens: 40_000 }, T0);
    expect(readSessionSummary('bare-session')).toMatchObject({ trigger: 160_000, autoCompactWindow: 200_000, contextLimit: 200_000 });
  });

  test('a corrupt summary is replaced safely', () => {
    const path = sessionSummaryPath(SID)!;
    mkdirSync(join(sandbox, 'sessions'), { recursive: true });
    writeFileSync(path, '{"v":1,"sessionId":"' + SID + '","compactions":[{"at":', 'utf-8');
    expect(readSessionSummary(SID)).toBeNull();
    expect(recordSessionSummary(observe(breakdownAt(200_000)), T0)).toBe('written');
    expect(stored()).toMatchObject({ v: 1, sessionId: SID, firstSeen: new Date(T0).toISOString(), lastTokens: 200_000 });
    // Valid JSON in the wrong shape, or naming another session, is replaced too.
    writeFileSync(path, JSON.stringify({ ...stored(), peakTokens: 'lots' }), 'utf-8');
    expect(recordSessionSummary(observe(breakdownAt(200_000)), T0 + MINUTE)).toBe('written');
    expect(stored().peakTokens).toBe(200_000);
    writeFileSync(path, JSON.stringify({ ...stored(), sessionId: 'someone-else' }), 'utf-8');
    expect(recordSessionSummary(observe(breakdownAt(200_000)), T0 + 2 * MINUTE)).toBe('written');
    expect(stored().sessionId).toBe(SID);
    expect(readdirSync(join(sandbox, 'sessions'))).toEqual([`${SID}.json`]);
  });

  test('a summary from a newer schema is left alone', () => {
    const path = sessionSummaryPath(SID)!;
    mkdirSync(join(sandbox, 'sessions'), { recursive: true });
    const newer = JSON.stringify({ v: 2, sessionId: SID, whatever: true });
    writeFileSync(path, newer, 'utf-8');
    expect(recordSessionSummary(observe(breakdownAt(200_000)), T0)).toBe('skipped');
    expect(readFileSync(path, 'utf-8')).toBe(newer);
  });

  test('an id that cannot be a file name is skipped, and errors never throw', () => {
    expect(sessionSummaryPath('../escape')).toBeNull();
    expect(recordSessionSummary({ ...observe(breakdownAt(1)), sessionId: '../escape' }, T0)).toBe('skipped');
    expect(existsSync(join(sandbox, 'sessions'))).toBe(false);
    const broken = { ...breakdownAt(1), compactionEvents: undefined } as unknown as CrustsBreakdown;
    expect(recordSessionSummary(observe(broken), T0)).toBe('failed');
  });

  test('loadSessionSummaries returns valid summaries, most recently seen first', () => {
    recordSessionSummary({ ...observe(breakdownAt(1_000)), sessionId: 'older' }, T0);
    recordSessionSummary({ ...observe(breakdownAt(2_000)), sessionId: 'newer' }, T0 + MINUTE);
    writeFileSync(join(sandbox, 'sessions', 'junk.json'), 'not json', 'utf-8');
    writeFileSync(join(sandbox, 'sessions', 'newer.json.123.456.tmp'), '{}', 'utf-8');
    expect(loadSessionSummaries().map((s) => s.sessionId)).toEqual(['newer', 'older']);
  });

  test('loadSessionSummaries is empty when the folder does not exist', () => {
    expect(loadSessionSummaries()).toEqual([]);
  });

  test('writeFileAtomic replaces a file in place and leaves no temp file', () => {
    const target = join(sandbox, 'nested', 'file.json');
    writeFileAtomic(target, 'one\n');
    writeFileAtomic(target, 'two\n');
    expect(readFileSync(target, 'utf-8')).toBe('two\n');
    expect(readdirSync(join(sandbox, 'nested'))).toEqual(['file.json']);
  });
});

describe('0.8.2 the auto-inject hook keeps a session summary (end to end)', () => {
  /** Environment for a spawned CLI with every user folder inside `sandbox`. */
  function sandboxEnv(sandbox: string, home: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    // Compaction settings from the developer's shell must not move the trigger.
    for (const key of ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'DISABLE_AUTO_COMPACT',
      'DISABLE_COMPACT', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS']) delete env[key];
    return {
      ...env,
      HOME: home,
      USERPROFILE: home,
      CRUSTS_CONFIG_DIR_OVERRIDE: join(sandbox, 'crusts'),
      CRUSTS_INJECT_LOG_DIR: join(sandbox, 'crusts'),
      CRUSTS_CALIBRATION_DIR_OVERRIDE: join(sandbox, 'crusts'),
    };
  }

  test('one prompt past the gate: an advisory, its log entry, and a summary with the compaction', () => {
    const sandbox = resolve(mkdtempSync(join(tmpdir(), 'crusts-hook-summary-')));
    try {
      const home = join(sandbox, 'home');
      const projectDir = join(sandbox, 'projects', 'C--fixture-project');
      mkdirSync(home, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(join(sandbox, 'crusts'), { recursive: true });
      writeFileSync(join(sandbox, 'crusts', 'config.json'), JSON.stringify({ autoInject: { enabled: true } }), 'utf-8');

      const sid = '5e1d7c2a-0f3b-4a9e-8c6d-2b4f6a8c0e1d';
      const usage = (input: number) => ({ input_tokens: input, output_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
      const rows = [
        { type: 'user', uuid: 'u1', version: '2.1.310', timestamp: '2026-10-24T09:00:00.000Z', message: { role: 'user', content: 'start the work' } },
        { type: 'assistant', uuid: 'a1', version: '2.1.310', timestamp: '2026-10-24T09:00:10.000Z', message: { id: 'm1', role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text: 'ok' }], usage: usage(165_000) } },
        { type: 'system', subtype: 'compact_boundary', uuid: 'b1', version: '2.1.310', timestamp: '2026-10-24T09:30:00.000Z', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 168_000, postTokens: 9_000 } },
        { type: 'user', uuid: 's1', version: '2.1.310', timestamp: '2026-10-24T09:30:01.000Z', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation.' } },
        { type: 'user', uuid: 'u2', version: '2.1.310', timestamp: '2026-10-24T09:31:00.000Z', message: { role: 'user', content: 'keep going' } },
        { type: 'assistant', uuid: 'a2', version: '2.1.310', timestamp: '2026-10-24T09:31:10.000Z', message: { id: 'm2', role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text: 'done' }], usage: usage(155_000) } },
      ];
      const transcript = join(projectDir, `${sid}.jsonl`);
      writeFileSync(transcript, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

      const env = sandboxEnv(sandbox, home);
      const hook = Bun.spawnSync({
        cmd: [process.execPath, 'src/index.ts', 'auto-inject'],
        cwd: join(import.meta.dir, '..'),
        env,
        stdin: new TextEncoder().encode(JSON.stringify({
          hook_event_name: 'UserPromptSubmit', session_id: sid, transcript_path: transcript, cwd: home, prompt: 'next step',
        })),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      // 155,900 tokens on a 200K window is past the 147K headroom gate.
      expect(new TextDecoder().decode(hook.stdout)).toContain('[claude-crusts advisory]');

      const summary = JSON.parse(readFileSync(join(sandbox, 'crusts', 'sessions', `${sid}.json`), 'utf-8')) as SessionSummaryRecord;
      const log = readFileSync(join(sandbox, 'crusts', 'auto-inject.log'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as { ts: string });
      expect(summary).toMatchObject({
        v: 1,
        sessionId: sid,
        project: 'C--fixture-project',
        transcriptPath: transcript,
        claudeCodeVersion: '2.1.310',
        model: 'claude-opus-4-6',
        contextLimit: 200_000,
        autoCompactWindow: 200_000,
        trigger: 167_000,
        peakTokens: 168_000,
        lastTokens: 155_900,
        advisories: { count: 1, lastAt: log[0]!.ts },
      });
      // tokensAfter is the first live turn's effective input (its output comes after).
      expect(summary.compactions).toEqual([
        { at: '2026-10-24T09:30:00.000Z', trigger: 'auto', idle: false, preTokens: 168_000, postTokens: 9_000, tokensAfter: 155_000 },
      ]);

      const status = Bun.spawnSync({
        cmd: [process.execPath, 'src/index.ts', 'hooks', 'auto-inject', 'status'],
        cwd: join(import.meta.dir, '..'),
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = new TextDecoder().decode(status.stdout).replace(/\[[0-9;]*m/g, '');
      expect(out).toContain(`Session summaries: 1 kept in ${join(sandbox, 'crusts', 'sessions')}`);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
