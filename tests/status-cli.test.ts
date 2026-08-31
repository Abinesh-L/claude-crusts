/**
 * Review-fix regression: `claude-crusts status` (the hook-facing one-liner)
 * reports the analyzed (non-attachment) message count, matching `analyze`
 * on the same session. Before the fix it printed the raw row count, which
 * included every attachment record M11 keeps at parse time.
 *
 * Spawns the real CLI against a sandboxed projects dir with HOME /
 * USERPROFILE redirected so config discovery never reads the developer's
 * ~/.claude, and the config/calibration overrides pointed into the sandbox
 * so nothing under ~/.claude-crusts is touched.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/** Strip ANSI color codes from CLI output. */
function stripAnsi(s: string): string {
  return s.replace(/\[[0-9;]*m/g, '');
}

describe('status CLI message count matches analyze (attachment rows excluded)', () => {
  test('a session with 2 real messages + 2 attachments prints "2 msgs"', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'crusts-status-'));
    try {
      const home = join(sandbox, 'home');
      const projectsBase = join(sandbox, 'projects');
      const projectDir = join(projectsBase, 'test-project');
      mkdirSync(home, { recursive: true });
      mkdirSync(projectDir, { recursive: true });

      const records = [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hello there' }] } },
        { type: 'attachment', uuid: 'a1', attachment: { type: 'task_reminder', content: 'reminder '.repeat(20) } },
        { type: 'attachment', uuid: 'a2', attachment: { type: 'hook_success', content: 'hook output '.repeat(10) } },
        {
          type: 'assistant', uuid: 's1',
          message: {
            role: 'assistant', model: 'claude-opus-4-7',
            content: [{ type: 'text', text: 'hi' }],
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        },
      ];
      writeFileSync(
        join(projectDir, 'status-fixture.jsonl'),
        records.map((r) => JSON.stringify(r)).join('\n') + '\n',
        'utf-8',
      );

      const result = Bun.spawnSync({
        cmd: [process.execPath, 'src/index.ts', 'status', 'status-fixture', '--path', projectsBase],
        cwd: join(import.meta.dir, '..'),
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CRUSTS_CONFIG_DIR_OVERRIDE: join(sandbox, 'crusts-config'),
          CRUSTS_CALIBRATION_DIR_OVERRIDE: join(sandbox, 'crusts-cal'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const stdout = stripAnsi(new TextDecoder().decode(result.stdout));
      expect(stdout).toContain('CRUSTS:');
      // 2 real messages; the raw row count (4, attachments included) is the
      // regression this pins: status must agree with analyze's messageCount.
      expect(stdout).toMatch(/\| 2 msgs \|/);
      expect(stdout).not.toContain('4 msgs');
    } finally {
      try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
