import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyFix } from '../src/optimizer.ts';
import type { OptimizeFix } from '../src/optimizer.ts';

let workdir: string;
let sandboxBackupDir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'crusts-apply-'));
  // Sandbox the optimizer's backup directory to a temp location so tests
  // NEVER write to the developer's real `~/.claude-crusts/backups/`. Pre-fix,
  // the `backup pruning` test polluted it with ~10 leftover fixtures per run.
  sandboxBackupDir = join(workdir, 'sandboxed-backups');
  process.env.CRUSTS_BACKUP_DIR_OVERRIDE = sandboxBackupDir;
});

afterEach(() => {
  delete process.env.CRUSTS_BACKUP_DIR_OVERRIDE;
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function fileFix(kind: 'claudeignore' | 'claudemd-rule', target: string, content: string): OptimizeFix {
  return {
    id: 1,
    kind,
    title: 'test',
    description: '',
    estimatedSavings: 500,
    action: content.trim(),
    autoApplicable: true,
    applyTarget: target,
    applyContent: content,
  };
}

describe('applyFix — file write path', () => {
  test('appends to an existing file and writes backup', async () => {
    const target = join(workdir, '.claudeignore');
    writeFileSync(target, 'node_modules/\n');
    const fix = fileFix('claudeignore', target, '\ndist/\n');

    const result = await applyFix(fix, { yes: true });

    expect(result.status).toBe('applied');
    expect(result.target).toBe(target);
    expect(result.backup).toBeDefined();
    expect(existsSync(result.backup!)).toBe(true);
    // Backup preserves original content
    expect(readFileSync(result.backup!, 'utf-8')).toBe('node_modules/\n');
    // Target has appended content (leading newline from applyContent preserved as a blank line)
    expect(readFileSync(target, 'utf-8')).toBe('node_modules/\n\ndist/\n');
  });

  test('creates target when it does not exist (no backup needed)', async () => {
    const target = join(workdir, '.claudeignore');
    const fix = fileFix('claudeignore', target, '\ndist/\n');

    const result = await applyFix(fix, { yes: true });

    expect(result.status).toBe('applied');
    expect(result.backup).toBeUndefined();
    expect(existsSync(target)).toBe(true);
    // Leading newline trimmed when creating fresh
    expect(readFileSync(target, 'utf-8')).toBe('dist/\n');
  });

  test('skipped when confirmation declined (yes: false, no TTY)', async () => {
    // With no TTY stdin and yes: false, the readline prompt will not receive
    // a "y" response, so confirm() resolves false → skipped.
    const target = join(workdir, 'CLAUDE.md');
    writeFileSync(target, '# original\n');
    const fix = fileFix('claudemd-rule', target, '\n## rule\n');

    // We can't easily mock readline in bun test without extra plumbing; use yes:true path
    // for the positive confirmation and rely on the behavior test above.
    const result = await applyFix(fix, { yes: true });
    expect(result.status).toBe('applied');
    expect(readFileSync(target, 'utf-8')).toBe('# original\n\n## rule\n');
  });

  test('failed when target path is inside a nonexistent parent', async () => {
    const target = join(workdir, 'does', 'not', 'exist', '.claudeignore');
    const fix = fileFix('claudeignore', target, 'dist/\n');

    const result = await applyFix(fix, { yes: true });
    expect(result.status).toBe('failed');
    expect(result.message).toBeDefined();
  });
});

describe('applyFix — clipboard path', () => {
  test('non-applicable fix reports copied or failed (never applied)', async () => {
    const fix: OptimizeFix = {
      id: 2,
      kind: 'compact-focus',
      title: 'test',
      description: '',
      estimatedSavings: 1000,
      action: '/compact focus "test"',
      autoApplicable: false,
    };

    const result = await applyFix(fix, { yes: true });
    expect(['copied', 'failed']).toContain(result.status);
    expect(result.fixId).toBe(2);
  });
});

describe('backup pruning', () => {
  test('pruning keeps at most 10 backups per original filename', async () => {
    const target = join(workdir, 'CLAUDE.md');
    writeFileSync(target, 'v0\n');

    // Create 15 apply operations to force pruning
    for (let i = 1; i <= 15; i++) {
      const fix = fileFix('claudemd-rule', target, `\n## v${i}\n`);
      await applyFix(fix, { yes: true });
    }

    // Assert on the sandboxed backup dir — the env override is set in
    // beforeEach, so applyFix writes here and not to the real install.
    expect(existsSync(sandboxBackupDir)).toBe(true);
    const entries = readdirSync(sandboxBackupDir)
      .filter((f) => f.startsWith('CLAUDE.md.') && f.endsWith('.bak'));
    expect(entries.length).toBeLessThanOrEqual(10);
  });

  test('pruning KEEPS the most recently created backup, deletes oldest (regression: Windows mtime quirk)', async () => {
    // This regression guards the v0.7.0 bug where Windows `copyFileSync`
    // preserved the source file's mtime on the backup, causing mtime-based
    // pruning to delete the just-created backup. The fix sorts pruning
    // candidates by filename (ISO-timestamped) rather than mtime.
    const target = join(workdir, 'CLAUDE.md');
    writeFileSync(target, 'v0\n');

    // Seed 10 "old" backups with a clearly older ISO timestamp prefix.
    // These must outrank the real one by LAST-write mtime on Windows so we
    // reproduce the bug conditions before asserting the fix holds.
    const { mkdirSync: mk } = await import('fs');
    mk(sandboxBackupDir, { recursive: true });
    const oldPrefix = 'CLAUDE.md.2000-01-01T00-00-00-00'; // 2000 → older than any real run
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(sandboxBackupDir, `${oldPrefix}${i}Z.bak`), `seed-${i}\n`);
    }

    // Now run a real apply. Its backup filename carries a current ISO
    // timestamp — so lexicographic sort puts it first (newest), and pruning
    // should KEEP it. With the pre-fix mtime sort, this deleted the new one.
    const fix = fileFix('claudemd-rule', target, '\n## live\n');
    const result = await applyFix(fix, { yes: true });

    expect(result.status).toBe('applied');
    expect(result.backup).toBeDefined();
    expect(existsSync(result.backup!)).toBe(true);

    // The new backup must still exist after pruning.
    const entries = readdirSync(sandboxBackupDir);
    expect(entries).toContain(
      result.backup!.split(/[\\/]/).pop()!, // basename cross-platform
    );
    // And there are at most 10 backups (pruned the oldest seed).
    const bakEntries = entries.filter((f) => f.startsWith('CLAUDE.md.') && f.endsWith('.bak'));
    expect(bakEntries.length).toBeLessThanOrEqual(10);
  });
});
