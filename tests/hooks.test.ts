/**
 * The after-response status hook (0.8.2): `hooks enable` installs
 * `claude-crusts status --hook` on Claude Code's Stop event, migrating the
 * 0.8.1-and-earlier `claude-crusts status` entry off Notification (where
 * Claude Code discards a hook's systemMessage and stdout, so it showed
 * nothing), and `status --hook` prints one `{"systemMessage": ...}` object.
 *
 * Settings round-trips run in-process against a temp settings.json, with
 * config.json and the backup folder redirected into the sandbox. Hook-mode
 * runs spawn the real CLI with HOME / USERPROFILE redirected, so nothing
 * under the developer's ~/.claude or ~/.claude-crusts is read or written.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  enableHooks,
  disableHooks,
  hooksStatus,
  enableAutoInject,
  disableAutoInject,
  detectStatusHooks,
  parseHookPayload,
  summarizeStatus,
  HOOK_COMMAND,
  HOOK_EVENT,
  HOOK_STDIN_TIMEOUT_MS,
  LEGACY_HOOK_COMMAND,
  LEGACY_HOOK_EVENT,
} from '../src/hooks.ts';
import { checkHookIntegration } from '../src/doctor.ts';
import type { CrustsBreakdown } from '../src/types.ts';

/** Strip ANSI color codes from CLI output. */
function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

/** A hook command check that finds nothing wrong (the real one runs claude-crusts --version). */
const commandWorks = (): string | null => null;

/**
 * Run a function and return what it printed with console.log, uncoloured.
 *
 * @param fn - The function to run
 * @returns The printed lines joined with newlines
 */
function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return stripAnsi(lines.join('\n'));
}

/** The legacy group `hooks enable` wrote on Notification up to 0.8.1. */
const LEGACY_GROUP = { matcher: '', hooks: [{ type: 'command', command: 'claude-crusts status' }] };

/** Someone else's hooks that every operation must leave exactly as they are. */
const USER_NOTIFICATION_GROUP = { matcher: 'permission_prompt', hooks: [{ type: 'command', command: 'notify-send "Claude needs you"' }] };
const USER_STOP_GROUP = { hooks: [{ type: 'command', command: 'say done', timeout: 5 }] };
const AUTO_INJECT_GROUP = { matcher: '', hooks: [{ type: 'command', command: 'claude-crusts auto-inject' }] };

/** A settings.json as a 0.8.1 user has it: other keys, other hooks, the legacy entry. */
function legacySettings(): Record<string, unknown> {
  return {
    model: 'opus',
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' },
    hooks: {
      Notification: [LEGACY_GROUP, USER_NOTIFICATION_GROUP],
      Stop: [USER_STOP_GROUP],
      UserPromptSubmit: [AUTO_INJECT_GROUP],
    },
    statusLine: { type: 'command', command: 'my-statusline' },
  };
}

describe('hooks enable / disable / status on a temp settings.json', () => {
  let sandbox: string;
  let settingsPath: string;
  let backupsDir: string;
  let configDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    sandbox = resolve(mkdtempSync(join(tmpdir(), 'crusts-hooks-')));
    settingsPath = join(sandbox, 'claude', 'settings.json');
    backupsDir = join(sandbox, 'backups');
    configDir = join(sandbox, 'crusts-config');
    mkdirSync(join(sandbox, 'claude'), { recursive: true });
    for (const key of ['CRUSTS_CONFIG_DIR_OVERRIDE', 'CRUSTS_BACKUP_DIR_OVERRIDE']) saved[key] = process.env[key];
    process.env.CRUSTS_CONFIG_DIR_OVERRIDE = configDir;
    process.env.CRUSTS_BACKUP_DIR_OVERRIDE = backupsDir;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** Write the temp settings.json. */
  function writeSettingsFile(settings: unknown): void {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }

  /** Read back the temp settings.json. */
  function readSettingsFile(): Record<string, unknown> {
    return JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
  }

  /** The sandboxed crusts config.json, or {} when not written yet. */
  function readCrustsConfig(): Record<string, unknown> {
    const path = join(configDir, 'config.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown> : {};
  }

  /** Backups written so far. */
  function backups(): string[] {
    return existsSync(backupsDir) ? readdirSync(backupsDir).sort() : [];
  }

  test('enable installs nothing when the hook command would fail here', () => {
    writeSettingsFile({ model: 'opus' });
    const problem = 'claude-crusts is not on your PATH.';
    const out = captureLog(() => enableHooks(settingsPath, () => problem));
    expect(out).toContain(`CRUSTS hooks not enabled. ${problem}`);
    expect(readSettingsFile()).toEqual({ model: 'opus' });
    expect(backups()).toEqual([]);
    expect(readCrustsConfig().hooksEnabled).toBeUndefined();
  });

  test('enable on a missing settings.json creates one Stop entry and no backup', () => {
    const out = captureLog(() => enableHooks(settingsPath, commandWorks));
    expect(out).toContain('CRUSTS hooks enabled.');

    const settings = readSettingsFile();
    expect(settings).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'claude-crusts status --hook', timeout: 30 }] }] },
    });
    expect(detectStatusHooks(settings)).toEqual({ installed: true, legacy: false });
    expect(readCrustsConfig().hooksEnabled).toBe(true);
    expect(backups()).toEqual([]);
  });

  test('enable migrates the legacy Notification entry and leaves everything else untouched', () => {
    writeSettingsFile(legacySettings());
    const before = readFileSync(settingsPath, 'utf-8');

    const out = captureLog(() => enableHooks(settingsPath, commandWorks));
    expect(out).toContain('Moved the CRUSTS status hook from the Notification event');
    expect(out).toContain('CRUSTS hooks enabled.');

    const after = readSettingsFile();
    const expected = legacySettings();
    const hooks = expected.hooks as Record<string, unknown[]>;
    hooks.Notification = [USER_NOTIFICATION_GROUP];
    hooks.Stop = [USER_STOP_GROUP, { hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 30 }] }];
    expect(after).toEqual(expected);
    // Key order of the file is kept, including `hooks` staying in place.
    expect(Object.keys(after)).toEqual(['model', 'env', 'hooks', 'statusLine']);
    expect(Object.keys(after.hooks as object)).toEqual(['Notification', 'Stop', 'UserPromptSubmit']);
    expect(detectStatusHooks(after)).toEqual({ installed: true, legacy: false });

    // The previous file was backed up byte for byte before the write.
    const written = backups();
    expect(written.length).toBe(1);
    expect(written[0]).toMatch(/^settings\.json\..+\.bak$/);
    expect(readFileSync(join(backupsDir, written[0]!), 'utf-8')).toBe(before);
    expect(out).toContain(join(backupsDir, written[0]!));
  });

  test('enable is idempotent: a second run changes nothing and writes no backup', () => {
    writeSettingsFile(legacySettings());
    captureLog(() => enableHooks(settingsPath, commandWorks));
    const once = readFileSync(settingsPath, 'utf-8');
    const backupsAfterFirst = backups();

    const out = captureLog(() => enableHooks(settingsPath, commandWorks));
    expect(out).toContain('already enabled');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(once);
    expect(backups()).toEqual(backupsAfterFirst);
    const stops = (readSettingsFile().hooks as Record<string, unknown[]>).Stop!;
    expect(stops.filter((g) => JSON.stringify(g).includes(HOOK_COMMAND)).length).toBe(1);
  });

  test('enable with the Stop entry present still removes a leftover legacy entry', () => {
    writeSettingsFile({
      hooks: {
        Notification: [LEGACY_GROUP],
        Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 30 }] }],
      },
    });
    const out = captureLog(() => enableHooks(settingsPath, commandWorks));
    expect(out).toContain('Removed the old CRUSTS status hook from the Notification event');
    const after = readSettingsFile();
    expect(after).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 30 }] }] } });
    expect(detectStatusHooks(after)).toEqual({ installed: true, legacy: false });
  });

  test('disable removes the Stop and legacy entries and nothing else', () => {
    writeSettingsFile(legacySettings());
    captureLog(() => enableHooks(settingsPath, commandWorks));
    // A legacy entry that reappeared (an old crusts run) goes too.
    const withLegacy = readSettingsFile();
    (withLegacy.hooks as Record<string, unknown[]>).Notification!.unshift(LEGACY_GROUP);
    writeSettingsFile(withLegacy);

    const out = captureLog(() => disableHooks(settingsPath));
    expect(out).toContain('CRUSTS hooks disabled.');

    const expected = legacySettings();
    (expected.hooks as Record<string, unknown[]>).Notification = [USER_NOTIFICATION_GROUP];
    expect(readSettingsFile()).toEqual(expected);
    expect(detectStatusHooks(readSettingsFile())).toEqual({ installed: false, legacy: false });
    expect(readCrustsConfig().hooksEnabled).toBe(false);
  });

  test('enable then disable on a file with no other hooks restores it exactly', () => {
    const original = { model: 'opus', permissions: { allow: ['Bash(git status)'] } };
    writeSettingsFile(original);
    const before = readFileSync(settingsPath, 'utf-8');
    captureLog(() => enableHooks(settingsPath, commandWorks));
    captureLog(() => disableHooks(settingsPath));
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
  });

  test('only the exact command on the exact event is crusts\' own', () => {
    const mixedLegacyGroup = {
      matcher: '',
      hooks: [
        { type: 'command', command: 'claude-crusts status' },
        { type: 'command', command: 'log-notification.sh' },
      ],
    };
    const lookalikes = {
      hooks: {
        Notification: [
          mixedLegacyGroup,
          { hooks: [{ type: 'command', command: 'claude-crusts status --verbose' }] },
          { hooks: [{ type: 'command', command: HOOK_COMMAND }] },
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: 'claude-crusts status' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'claude-crusts status' }] }],
      },
    };
    writeSettingsFile(lookalikes);
    captureLog(() => enableHooks(settingsPath, commandWorks));
    captureLog(() => disableHooks(settingsPath));

    // Only the legacy command inside the mixed Notification group is gone;
    // the group keeps its matcher and the other command.
    const expected = JSON.parse(JSON.stringify(lookalikes)) as typeof lookalikes;
    expected.hooks.Notification[0] = { matcher: '', hooks: [{ type: 'command', command: 'log-notification.sh' }] };
    expect(readSettingsFile()).toEqual(expected);
  });

  test('disable with nothing installed leaves the file alone', () => {
    writeSettingsFile({ model: 'opus', hooks: { Stop: [USER_STOP_GROUP] } });
    const before = readFileSync(settingsPath, 'utf-8');
    const out = captureLog(() => disableHooks(settingsPath));
    expect(out).toContain('not currently enabled');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
    expect(backups()).toEqual([]);
  });

  test('a settings.json that does not parse is never rewritten', () => {
    const broken = '{\n  "model": "opus",\n  "hooks": {},\n}\n';
    writeFileSync(settingsPath, broken, 'utf-8');
    const enableOut = captureLog(() => enableHooks(settingsPath, commandWorks));
    const disableOut = captureLog(() => disableHooks(settingsPath));
    const autoOut = captureLog(() => enableAutoInject(settingsPath));
    expect(enableOut).toContain('Cannot read');
    expect(enableOut).toContain('left unchanged');
    expect(disableOut).toContain('Cannot read');
    expect(autoOut).toContain('Cannot read');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(broken);
    expect(backups()).toEqual([]);
    expect(readCrustsConfig().hooksEnabled).toBeUndefined();
  });

  test('a malformed hooks value is reported, not replaced', () => {
    const odd = { model: 'opus', hooks: { Stop: { command: 'say done' } } };
    writeSettingsFile(odd);
    const before = readFileSync(settingsPath, 'utf-8');
    const out = captureLog(() => enableHooks(settingsPath, commandWorks));
    expect(out).toContain('"hooks.Stop" is not a list');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
  });

  test('a UTF-8 BOM in settings.json is tolerated', () => {
    writeFileSync(settingsPath, '﻿' + JSON.stringify({ model: 'opus' }, null, 2) + '\n', 'utf-8');
    captureLog(() => enableHooks(settingsPath, commandWorks));
    const after = readSettingsFile();
    expect(after.model).toBe('opus');
    expect(detectStatusHooks(after).installed).toBe(true);
  });

  test('backups are pruned to the newest ten', () => {
    mkdirSync(backupsDir, { recursive: true });
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(backupsDir, `settings.json.2020-01-01T00-00-${String(i).padStart(2, '0')}-000Z.bak`), '{}', 'utf-8');
    }
    writeFileSync(join(backupsDir, 'CLAUDE.md.2020-01-01T00-00-00-000Z.bak'), 'x', 'utf-8');
    writeSettingsFile({ model: 'opus' });
    captureLog(() => enableHooks(settingsPath, commandWorks));

    const kept = backups().filter((f) => f.startsWith('settings.json.'));
    expect(kept.length).toBe(10);
    // The new backup survives; the oldest ones went.
    expect(kept.some((f) => !f.startsWith('settings.json.2020-'))).toBe(true);
    expect(kept).not.toContain('settings.json.2020-01-01T00-00-00-000Z.bak');
    // Other files' backups are not touched.
    expect(backups()).toContain('CLAUDE.md.2020-01-01T00-00-00-000Z.bak');
  });

  test('hooks status reports the current install, a legacy one, and both', () => {
    expect(captureLog(() => hooksStatus(settingsPath))).toContain('CRUSTS hooks: not enabled');

    writeSettingsFile({ hooks: { Notification: [LEGACY_GROUP] } });
    let out = captureLog(() => hooksStatus(settingsPath));
    expect(out).toContain('old install on the Notification event, which shows nothing');
    expect(out).toContain('hooks enable');

    captureLog(() => enableHooks(settingsPath, commandWorks));
    out = captureLog(() => hooksStatus(settingsPath));
    expect(out).toContain('CRUSTS hooks: enabled (Stop hook');
    expect(out).not.toContain('Notification');

    const both = readSettingsFile();
    (both.hooks as Record<string, unknown[]>).Notification = [LEGACY_GROUP];
    writeSettingsFile(both);
    out = captureLog(() => hooksStatus(settingsPath));
    expect(out).toContain('CRUSTS hooks: enabled (Stop hook');
    expect(out).toContain('An old CRUSTS hook is also on the Notification event');
  });

  test('auto-inject enable / disable and the status hook leave each other alone', () => {
    writeSettingsFile({ hooks: { Stop: [USER_STOP_GROUP] } });
    captureLog(() => enableHooks(settingsPath, commandWorks));
    captureLog(() => enableAutoInject(settingsPath));
    let settings = readSettingsFile();
    expect(detectStatusHooks(settings).installed).toBe(true);
    expect((settings.hooks as Record<string, unknown[]>).UserPromptSubmit).toEqual([AUTO_INJECT_GROUP]);

    captureLog(() => disableHooks(settingsPath));
    settings = readSettingsFile();
    expect(settings).toEqual({ hooks: { Stop: [USER_STOP_GROUP], UserPromptSubmit: [AUTO_INJECT_GROUP] } });

    captureLog(() => disableAutoInject(settingsPath));
    expect(readSettingsFile()).toEqual({ hooks: { Stop: [USER_STOP_GROUP] } });
  });
});

describe('detectStatusHooks', () => {
  test('constants name the Stop event and the legacy Notification entry', () => {
    expect(HOOK_EVENT).toBe('Stop');
    expect(HOOK_COMMAND).toBe('claude-crusts status --hook');
    expect(LEGACY_HOOK_EVENT).toBe('Notification');
    expect(LEGACY_HOOK_COMMAND).toBe('claude-crusts status');
  });

  test('tolerates missing and malformed hook structures', () => {
    expect(detectStatusHooks({})).toEqual({ installed: false, legacy: false });
    expect(detectStatusHooks({ hooks: [] })).toEqual({ installed: false, legacy: false });
    expect(detectStatusHooks({ hooks: { Stop: 'x', Notification: [null, 3, { hooks: 'y' }] } }))
      .toEqual({ installed: false, legacy: false });
  });

  test('the new command on Notification is neither install', () => {
    expect(detectStatusHooks({ hooks: { Notification: [{ hooks: [{ command: HOOK_COMMAND }] }] } }))
      .toEqual({ installed: false, legacy: false });
  });
});

describe('doctor Hook integration check', () => {
  test('warns when settings.json is missing or unreadable', () => {
    const check = checkHookIntegration(null);
    expect(check.name).toBe('Hook integration');
    expect(check.status).toBe('warn');
  });

  test('passes with the Stop hook installed', () => {
    const check = checkHookIntegration({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } }, commandWorks);
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('Stop hook installed');
  });

  test('warns when the installed Stop hook\'s command would fail', () => {
    const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } };
    const check = checkHookIntegration(settings, () => 'The claude-crusts on your PATH is 0.8.1.');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('each response ends with a hook error');
    expect(check.detail).toContain('0.8.1');
  });

  test('passes when not installed (the hook is optional)', () => {
    const check = checkHookIntegration({ hooks: { Stop: [USER_STOP_GROUP] } });
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('Not installed');
  });

  test('warns about the legacy Notification entry, which shows nothing', () => {
    const check = checkHookIntegration({ hooks: { Notification: [LEGACY_GROUP] } });
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('Notification');
    expect(check.detail).toContain('claude-crusts hooks enable');
  });
});

describe('parseHookPayload', () => {
  test('reads a JSON object, BOM and surrounding whitespace tolerated', () => {
    expect(parseHookPayload('﻿  {"session_id":"abc","stop_hook_active":true}\n')).toEqual({
      session_id: 'abc',
      stop_hook_active: true,
    });
  });

  test('anything but one JSON object is null', () => {
    expect(parseHookPayload('')).toBeNull();
    expect(parseHookPayload('   ')).toBeNull();
    expect(parseHookPayload('[1,2]')).toBeNull();
    expect(parseHookPayload('"text"')).toBeNull();
    expect(parseHookPayload('{"session_id":')).toBeNull();
  });
});

describe('summarizeStatus', () => {
  /** A minimal breakdown for the status line. */
  function breakdown(pct: number, current?: number): CrustsBreakdown {
    return {
      usage_percentage: pct,
      currentContext: current === undefined ? undefined : { usage_percentage: current },
      messages: [{ isAttachment: false }, { isAttachment: true }, { isAttachment: false }],
      compactionEvents: current === undefined ? [] : [{}],
    } as unknown as CrustsBreakdown;
  }

  test('formats the line without colour codes', () => {
    const summary = summarizeStatus(breakdown(62.44));
    expect(summary).toEqual({ usagePercent: 62.44, health: 'warming', line: 'CRUSTS: 62.4% (warming) | 2 msgs | 0 compactions' });
  });

  test('reads the current context after a compaction', () => {
    const summary = summarizeStatus(breakdown(240, 12));
    expect(summary.health).toBe('healthy');
    expect(summary.line).toBe('CRUSTS: 12.0% (healthy) | 2 msgs | 1 compaction');
  });
});

describe('claude-crusts status --hook (spawned CLI)', () => {
  let sandbox: string;
  let projectsBase: string;
  let transcriptPath: string;
  let env: Record<string, string | undefined>;
  const repoRoot = join(import.meta.dir, '..');

  /** One user prompt and one assistant reply with usage. */
  function writeFixture(path: string): void {
    const records = [
      { type: 'user', uuid: 'u1', sessionId: 'hook-fixture', message: { role: 'user', content: [{ type: 'text', text: 'hello there' }] } },
      {
        type: 'assistant', uuid: 'a1', sessionId: 'hook-fixture',
        message: {
          role: 'assistant', model: 'claude-opus-4-6',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 40_000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
    ];
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  }

  beforeEach(() => {
    sandbox = resolve(mkdtempSync(join(tmpdir(), 'crusts-hookmode-')));
    const home = join(sandbox, 'home');
    projectsBase = join(sandbox, 'projects');
    const projectDir = join(projectsBase, 'hook-project');
    mkdirSync(home, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    transcriptPath = join(projectDir, 'hook-fixture.jsonl');
    writeFixture(transcriptPath);
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CRUSTS_CONFIG_DIR_OVERRIDE: join(sandbox, 'crusts-config'),
      CRUSTS_CALIBRATION_DIR_OVERRIDE: join(sandbox, 'crusts-cal'),
      CRUSTS_BACKUP_DIR_OVERRIDE: join(sandbox, 'crusts-backups'),
      CRUSTS_INJECT_LOG_DIR: join(sandbox, 'crusts-log'),
    };
  });

  afterEach(() => {
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /**
   * Run `status --hook` with `stdin` as its input.
   *
   * @param stdin - Payload text, or undefined for an empty (closed) stdin
   * @param extraArgs - More command-line arguments
   * @returns Exit code and decoded stdout
   */
  function runHook(stdin: string | undefined, extraArgs: string[] = []): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync({
      cmd: [process.execPath, 'src/index.ts', 'status', '--hook', ...extraArgs],
      cwd: repoRoot,
      env,
      stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode ?? -1,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  }

  /** A Stop payload for the fixture transcript. */
  function stopPayload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      session_id: 'hook-fixture',
      transcript_path: transcriptPath,
      cwd: sandbox,
      permission_mode: 'default',
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'hi',
      background_tasks: [],
      session_crons: [],
      ...overrides,
    });
  }

  /** Assert stdout is exactly one JSON object holding only a status systemMessage. */
  function expectStatusMessage(stdout: string): string {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['systemMessage']);
    const message = parsed.systemMessage as string;
    expect(typeof message).toBe('string');
    expect(message).toMatch(/^CRUSTS: \d+\.\d% \((healthy|warming|hot|critical)\) \| \d+ msgs \| \d+ compactions?$/);
    expect(message).not.toContain('\u001b');
    expect(message).not.toContain('\n');
    return message;
  }

  test('prints exactly one JSON object with a systemMessage and nothing else', () => {
    const { exitCode, stdout } = runHook(stopPayload());
    expect(exitCode).toBe(0);
    const message = expectStatusMessage(stdout);
    // 40,500 tokens of a 200K window (claude-opus-4-6 is not natively 1M).
    expect(message).toBe('CRUSTS: 20.3% (healthy) | 2 msgs | 0 compactions');
    expect(stdout).not.toContain('decision');
    expect(stdout.trim()).toBe(stdout.trimEnd());
  });

  test('stop_hook_active true prints nothing', () => {
    const { exitCode, stdout } = runHook(stopPayload({ stop_hook_active: true }));
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('a stale transcript_path falls back to the session id, then the latest session', () => {
    const byId = runHook(stopPayload({ transcript_path: join(sandbox, 'gone.jsonl') }), ['--path', projectsBase]);
    expect(byId.exitCode).toBe(0);
    expectStatusMessage(byId.stdout);

    const latest = runHook(stopPayload({ transcript_path: join(sandbox, 'gone.jsonl'), session_id: 'no-such-id' }), ['--path', projectsBase]);
    expect(latest.exitCode).toBe(0);
    expectStatusMessage(latest.stdout);
  });

  test('empty stdin and malformed JSON fall back to the latest session, exit 0', () => {
    const empty = runHook(undefined, ['--path', projectsBase]);
    expect(empty.exitCode).toBe(0);
    expectStatusMessage(empty.stdout);

    const garbage = runHook('this is not json', ['--path', projectsBase]);
    expect(garbage.exitCode).toBe(0);
    expectStatusMessage(garbage.stdout);
  });

  test('an empty transcript and a missing projects folder print nothing, exit 0', () => {
    writeFileSync(transcriptPath, '', 'utf-8');
    const empty = runHook(stopPayload(), ['--path', projectsBase]);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toBe('');

    const nowhere = runHook(stopPayload({ transcript_path: join(sandbox, 'gone.jsonl') }), ['--path', join(sandbox, 'no-projects')]);
    expect(nowhere.exitCode).toBe(0);
    expect(nowhere.stdout).toBe('');
  });

  test('stdin left open with no payload does not hang', async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, 'src/index.ts', 'status', '--hook', '--path', projectsBase],
      cwd: repoRoot,
      env,
      stdin: 'pipe', // never written to, never closed
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      proc.exited.then((code) => ({ code })),
      new Promise<{ code: 'hung' }>((done) => { timer = setTimeout(() => done({ code: 'hung' }), 10_000); }),
    ]);
    clearTimeout(timer);
    const elapsed = Date.now() - started;
    if (outcome.code === 'hung') proc.kill();
    try { proc.stdin.end(); } catch { /* the child is gone */ }
    expect(outcome.code).toBe(0);
    // It waited for the payload deadline (the pipe really stayed open), then
    // gave up instead of hanging.
    expect(elapsed).toBeGreaterThanOrEqual(HOOK_STDIN_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(10_000);
    // No payload arrived, so the latest session is reported.
    expectStatusMessage(await new Response(proc.stdout).text());
  }, 15_000);
});
