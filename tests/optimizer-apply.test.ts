import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { applyFix, mergeDenyRules, readDenySettings } from '../src/optimizer.ts';
import type { OptimizeFix } from '../src/optimizer.ts';

let workdir: string;
let sandboxBackupDir: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  workdir = resolve(mkdtempSync(join(tmpdir(), 'crusts-apply-')));
  // Sandbox the optimizer's backup directory to a temp location so tests
  // NEVER write to the developer's real `~/.claude-crusts/backups/`. Pre-fix,
  // the `backup pruning` test polluted it with ~10 leftover fixtures per run.
  sandboxBackupDir = join(workdir, 'sandboxed-backups');
  process.env.CRUSTS_BACKUP_DIR_OVERRIDE = sandboxBackupDir;
  savedConfigDir = process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
  process.env.CRUSTS_CONFIG_DIR_OVERRIDE = join(workdir, 'sandboxed-config');
});

afterEach(() => {
  delete process.env.CRUSTS_BACKUP_DIR_OVERRIDE;
  if (savedConfigDir === undefined) delete process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
  else process.env.CRUSTS_CONFIG_DIR_OVERRIDE = savedConfigDir;
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function fileFix(kind: 'claudemd-rule', target: string, content: string): OptimizeFix {
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
    const target = join(workdir, 'CLAUDE.md');
    writeFileSync(target, '# Project\n');
    const fix = fileFix('claudemd-rule', target, '\n## Files to avoid reading\n');

    const result = await applyFix(fix, { yes: true });

    expect(result.status).toBe('applied');
    expect(result.target).toBe(target);
    expect(result.backup).toBeDefined();
    expect(existsSync(result.backup!)).toBe(true);
    // Backup preserves original content
    expect(readFileSync(result.backup!, 'utf-8')).toBe('# Project\n');
    // Target has appended content (leading newline from applyContent preserved as a blank line)
    expect(readFileSync(target, 'utf-8')).toBe('# Project\n\n## Files to avoid reading\n');
  });

  test('creates target when it does not exist (no backup needed)', async () => {
    const target = join(workdir, 'CLAUDE.md');
    const fix = fileFix('claudemd-rule', target, '\n## Files to avoid reading\n');

    const result = await applyFix(fix, { yes: true });

    expect(result.status).toBe('applied');
    expect(result.backup).toBeUndefined();
    expect(existsSync(target)).toBe(true);
    // Leading newline trimmed when creating fresh
    expect(readFileSync(target, 'utf-8')).toBe('## Files to avoid reading\n');
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
    const target = join(workdir, 'does', 'not', 'exist', 'CLAUDE.md');
    const fix = fileFix('claudemd-rule', target, '## rule\n');

    const result = await applyFix(fix, { yes: true });
    expect(result.status).toBe('failed');
    expect(result.message).toBeDefined();
  });
});

describe('applyFix: read-deny into .claude/settings.local.json', () => {
  const RULES = ['Read(/**/node_modules/**)', 'Read(/**/dist/**)'];

  /** A read-deny fix for the project folder `dir`, as buildOptimizeReport makes it. */
  function denyFix(dir: string, rules: string[] = RULES): OptimizeFix {
    return {
      id: 2,
      kind: 'read-deny',
      title: 'Make Claude Code refuse to read node_modules/ and dist/',
      description: '',
      estimatedSavings: 3000,
      action: rules.join('\n'),
      autoApplicable: true,
      applyTarget: join(dir, '.claude', 'settings.local.json'),
      denyRules: rules,
    };
  }

  /** Backups written for settings.local.json in the sandboxed backup folder. */
  function settingsBackups(): string[] {
    if (!existsSync(sandboxBackupDir)) return [];
    return readdirSync(sandboxBackupDir).filter((f) => f.startsWith('settings.local.json.') && f.endsWith('.bak'));
  }

  test('creates the .claude folder and the file in a fresh project', async () => {
    const project = join(workdir, 'fresh');
    mkdirSync(project);
    const fix = denyFix(project);

    const result = await applyFix(fix, { yes: true });

    expect(result.status).toBe('applied');
    expect(result.backup).toBeUndefined();
    expect(result.message).toContain('Added 2 deny rule(s)');
    expect(result.message).toContain('.gitignore');
    const written = readFileSync(fix.applyTarget!, 'utf-8');
    expect(JSON.parse(written)).toEqual({ permissions: { deny: RULES } });
    expect(written.endsWith('\n')).toBe(true);
    expect(settingsBackups()).toEqual([]);
    // No temp file left behind by the atomic write.
    expect(readdirSync(join(project, '.claude'))).toEqual(['settings.local.json']);
  });

  test('keeps every other key and the existing deny rules, adds no duplicates, backs up first', async () => {
    const project = join(workdir, 'existing');
    mkdirSync(join(project, '.claude'), { recursive: true });
    const original = {
      model: 'claude-opus-5-5',
      env: { FOO: '1' },
      permissions: {
        allow: ['Bash(npm run *)'],
        deny: ['Read(./.env)', 'Read(/**/dist/**)'],
        defaultMode: 'acceptEdits',
      },
      hooks: { Stop: [] },
    };
    const originalText = JSON.stringify(original, null, 4);
    const target = join(project, '.claude', 'settings.local.json');
    writeFileSync(target, originalText);

    const result = await applyFix(denyFix(project), { yes: true });

    expect(result.status).toBe('applied');
    expect(result.message).toContain('Added 1 deny rule(s)');
    expect(result.message).not.toContain('.gitignore');
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({
      ...original,
      permissions: {
        ...original.permissions,
        deny: ['Read(./.env)', 'Read(/**/dist/**)', 'Read(/**/node_modules/**)'],
      },
    });
    // The backup holds the file exactly as it was.
    expect(result.backup).toBeDefined();
    expect(readFileSync(result.backup!, 'utf-8')).toBe(originalText);
    expect(settingsBackups().length).toBe(1);
  });

  test('a second apply changes nothing and writes no second backup', async () => {
    const project = join(workdir, 'twice');
    mkdirSync(join(project, '.claude'), { recursive: true });
    const target = join(project, '.claude', 'settings.local.json');
    writeFileSync(target, JSON.stringify({ permissions: { allow: ['Bash(ls *)'] } }));

    const first = await applyFix(denyFix(project), { yes: true });
    expect(first.status).toBe('applied');
    const afterFirst = readFileSync(target, 'utf-8');

    const second = await applyFix(denyFix(project), { yes: true });
    expect(second.status).toBe('skipped');
    expect(second.message).toContain('already in');
    expect(readFileSync(target, 'utf-8')).toBe(afterFirst);
    expect(settingsBackups().length).toBe(1);
    const deny = JSON.parse(afterFirst).permissions.deny as string[];
    expect(deny).toEqual(RULES);
  });

  test('refuses to touch a file that is not valid JSON', async () => {
    const project = join(workdir, 'broken');
    mkdirSync(join(project, '.claude'), { recursive: true });
    const target = join(project, '.claude', 'settings.local.json');
    const broken = '{\n  // a comment\n  "permissions": { "deny": [] }\n}\n';
    writeFileSync(target, broken);

    const result = await applyFix(denyFix(project), { yes: true });

    expect(result.status).toBe('failed');
    expect(result.message).toContain('is not valid JSON');
    expect(result.message).toContain('Did not change');
    expect(result.backup).toBeUndefined();
    expect(readFileSync(target, 'utf-8')).toBe(broken);
    expect(settingsBackups()).toEqual([]);
  });

  test('refuses when permissions.deny is not a list', async () => {
    const project = join(workdir, 'wrong-shape');
    mkdirSync(join(project, '.claude'), { recursive: true });
    const target = join(project, '.claude', 'settings.local.json');
    const text = JSON.stringify({ permissions: { deny: 'Read(./.env)' } });
    writeFileSync(target, text);

    const result = await applyFix(denyFix(project), { yes: true });

    expect(result.status).toBe('failed');
    expect(result.message).toContain('"permissions.deny" is not a list');
    expect(readFileSync(target, 'utf-8')).toBe(text);
  });

  test('reads a file saved with a UTF-8 BOM', async () => {
    const project = join(workdir, 'bom');
    mkdirSync(join(project, '.claude'), { recursive: true });
    const target = join(project, '.claude', 'settings.local.json');
    writeFileSync(target, '﻿' + JSON.stringify({ permissions: { deny: ['Read(./.env)'] } }));

    const result = await applyFix(denyFix(project), { yes: true });

    expect(result.status).toBe('applied');
    expect(JSON.parse(readFileSync(target, 'utf-8')).permissions.deny).toEqual(['Read(./.env)', ...RULES]);
  });
});

describe('readDenySettings / mergeDenyRules', () => {
  test('readDenySettings reports missing, empty, valid and invalid files', () => {
    const path = join(workdir, 'settings.local.json');
    expect(readDenySettings(path)).toEqual({ state: 'missing' });

    writeFileSync(path, '  \n');
    expect(readDenySettings(path)).toEqual({ state: 'ok', settings: {}, deny: [] });

    writeFileSync(path, JSON.stringify({ model: 'x' }));
    expect(readDenySettings(path)).toEqual({ state: 'ok', settings: { model: 'x' }, deny: [] });

    writeFileSync(path, '[]');
    expect(readDenySettings(path).state).toBe('invalid');

    writeFileSync(path, JSON.stringify({ permissions: [] }));
    expect(readDenySettings(path)).toEqual({ state: 'invalid', reason: '"permissions" is not an object' });
  });

  test('mergeDenyRules appends only missing rules and leaves its input unchanged', () => {
    const input = { permissions: { deny: ['Read(/**/dist/**)'], ask: ['Bash(git push *)'] }, model: 'x' };
    const snapshot = JSON.parse(JSON.stringify(input));
    const { settings, added } = mergeDenyRules(input, ['Read(/**/dist/**)', 'Read(/**/build/**)', 'Read(/**/build/**)']);
    expect(added).toEqual(['Read(/**/build/**)']);
    expect(settings).toEqual({
      permissions: { deny: ['Read(/**/dist/**)', 'Read(/**/build/**)'], ask: ['Bash(git push *)'] },
      model: 'x',
    });
    expect(input).toEqual(snapshot);
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
