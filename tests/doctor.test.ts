import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  aggregateStatus,
  runDoctor,
  checkTranscriptRetention,
  newestRecordedClaudeCodeVersion,
  MIN_RETENTION_DAYS,
  RECOMMENDED_RETENTION_DAYS,
} from '../src/doctor.ts';
import type { DoctorCheck, RetentionContext } from '../src/doctor.ts';
import type { SessionInfo } from '../src/types.ts';

function chk(status: 'pass' | 'warn' | 'fail'): DoctorCheck {
  return { name: 't', status, detail: '' };
}

describe('aggregateStatus', () => {
  test('all pass → pass', () => {
    expect(aggregateStatus([chk('pass'), chk('pass')])).toBe('pass');
  });

  test('any warn, no fail → warn', () => {
    expect(aggregateStatus([chk('pass'), chk('warn'), chk('pass')])).toBe('warn');
  });

  test('any fail dominates warns → fail', () => {
    expect(aggregateStatus([chk('pass'), chk('warn'), chk('fail')])).toBe('fail');
  });

  test('fail-only → fail', () => {
    expect(aggregateStatus([chk('fail')])).toBe('fail');
  });

  test('empty list → pass (vacuous)', () => {
    expect(aggregateStatus([])).toBe('pass');
  });

  test('all fail → fail', () => {
    expect(aggregateStatus([chk('fail'), chk('fail')])).toBe('fail');
  });
});

describe('runDoctor (smoke)', () => {
  const report = runDoctor();

  test('returns the expected ten checks', () => {
    expect(report.checks.length).toBe(10);
  });

  test('includes the transcript retention check', () => {
    expect(report.checks.some((c) => c.name === 'Transcript retention')).toBe(true);
  });

  test('every check has name, status, detail', () => {
    for (const c of report.checks) {
      expect(typeof c.name).toBe('string');
      expect(c.name.length).toBeGreaterThan(0);
      expect(['pass', 'warn', 'fail']).toContain(c.status);
      expect(typeof c.detail).toBe('string');
    }
  });

  test('overall matches aggregateStatus of the same checks', () => {
    expect(report.overall).toBe(aggregateStatus(report.checks));
  });

  test('version check always passes', () => {
    const v = report.checks.find((c) => c.name === 'claude-crusts version');
    expect(v).toBeDefined();
    expect(v!.status).toBe('pass');
  });
});

describe('0.8.2 transcript retention check', () => {
  const dir = join('C:', 'sandbox', '.claude-crusts', 'sessions');
  /** Context with `count` summaries kept and an optional Claude Code version. */
  const ctx = (count: number, claudeCodeVersion?: string): RetentionContext => ({ summaryCount: count, summariesDir: dir, claudeCodeVersion });

  test('passes at a year and names the summaries kept', () => {
    const check = checkTranscriptRetention({ cleanupPeriodDays: 365 }, ctx(3, '2.1.310'));
    expect(check.name).toBe('Transcript retention');
    expect(check.status).toBe('pass');
    expect(check.detail).toBe(`cleanupPeriodDays is 365: Claude Code keeps transcripts for 365 days. crusts keeps 3 session summaries in ${dir}.`);
  });

  test('passes from 90 days up', () => {
    expect(MIN_RETENTION_DAYS).toBe(90);
    expect(checkTranscriptRetention({ cleanupPeriodDays: 90 }, ctx(0)).status).toBe('pass');
    expect(checkTranscriptRetention({ cleanupPeriodDays: 89 }, ctx(0)).status).toBe('warn');
  });

  test('warns when cleanupPeriodDays is missing: the 30-day default deletes transcripts', () => {
    const check = checkTranscriptRetention({}, ctx(12));
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('cleanupPeriodDays is not set, so Claude Code deletes transcripts older than 30 days');
    expect(check.detail).toContain(`crusts keeps 12 session summaries in ${dir}.`);
    expect(check.detail).toContain(`Set "cleanupPeriodDays": ${RECOMMENDED_RETENTION_DAYS} in ~/.claude/settings.json`);
  });

  test('warns under 90 days and names the value', () => {
    const check = checkTranscriptRetention({ cleanupPeriodDays: 45 }, ctx(1));
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('cleanupPeriodDays is 45, so Claude Code deletes transcripts older than 45 days');
    expect(check.detail).toContain(`crusts keeps 1 session summary in ${dir}.`);
    expect(check.detail).toContain('"cleanupPeriodDays": 365');
  });

  test('warns on a value Claude Code rejects and on unreadable settings', () => {
    const zero = checkTranscriptRetention({ cleanupPeriodDays: 0 }, ctx(0));
    expect(zero.status).toBe('warn');
    expect(zero.detail).toContain('cleanupPeriodDays is 0, but Claude Code takes a number of days, 1 or more.');
    expect(checkTranscriptRetention({ cleanupPeriodDays: '365' }, ctx(0)).detail).toContain('cleanupPeriodDays is "365"');
    const broken = checkTranscriptRetention(null, ctx(0));
    expect(broken.status).toBe('warn');
    expect(broken.detail).toContain('is not valid JSON');
  });

  test('says when no summaries exist yet', () => {
    expect(checkTranscriptRetention({}, ctx(0)).detail)
      .toContain(`No session summaries in ${dir} yet; the auto-inject hook (claude-crusts hooks auto-inject enable) keeps one per session.`);
  });

  test('the large-value caveat appears only on Claude Code older than 2.1.310', () => {
    const older = checkTranscriptRetention({}, ctx(0, '2.1.305'));
    expect(older.detail).toContain('Keep it moderate on Claude Code 2.1.305: before 2.1.310, a very large value made background cleanup delete some recent files, such as pasted images.');
    expect(checkTranscriptRetention({}, ctx(0, '2.1.310')).detail).not.toContain('moderate');
    expect(checkTranscriptRetention({}, ctx(0, '2.1.311')).detail).not.toContain('moderate');
    expect(checkTranscriptRetention({}, ctx(0)).detail).not.toContain('moderate');
  });

  test('a value above the recommendation warns on older Claude Code only', () => {
    const older = checkTranscriptRetention({ cleanupPeriodDays: 100_000 }, ctx(2, '2.1.300'));
    expect(older.status).toBe('warn');
    expect(older.detail).toContain('pasted images');
    expect(older.detail).toContain('your newest transcripts are from 2.1.300');
    expect(checkTranscriptRetention({ cleanupPeriodDays: 100_000 }, ctx(2, '2.1.310')).status).toBe('pass');
    expect(checkTranscriptRetention({ cleanupPeriodDays: 100_000 }, ctx(2)).status).toBe('pass');
    expect(checkTranscriptRetention({ cleanupPeriodDays: 365 }, ctx(2, '2.1.300')).status).toBe('pass');
  });

  test('details carry no em dashes', () => {
    const cases: [Record<string, unknown> | null, string | undefined][] = [
      [{}, '2.1.300'], [{ cleanupPeriodDays: 10 }, undefined], [{ cleanupPeriodDays: -1 }, '2.1.300'],
      [null, undefined], [{ cleanupPeriodDays: 400 }, '2.1.300'], [{ cleanupPeriodDays: 400 }, '2.1.310'],
    ];
    for (const [settings, version] of cases) {
      expect(checkTranscriptRetention(settings, ctx(1, version)).detail).not.toContain('\u2014');
    }
  });
});

describe('0.8.2 newestRecordedClaudeCodeVersion', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'crusts-doctor-version-'));
  afterAll(() => {
    rmSync(resolve(sandbox), { recursive: true, force: true });
  });

  /** Write a transcript and describe it as discoverSessions would. */
  function session(id: string, records: unknown[], headVersion?: string): SessionInfo {
    const path = join(sandbox, `${id}.jsonl`);
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    return { id, path, project: 'p', modifiedAt: new Date(), sizeBytes: 0, claudeCodeVersion: headVersion };
  }

  test('reads the version that wrote each transcript last, newest across the sessions', () => {
    const resumed = session('resumed', [
      { type: 'user', version: '2.1.300', message: { role: 'user', content: 'start' } },
      { type: 'user', version: '2.1.310', message: { role: 'user', content: 'after the update' } },
    ], '2.1.300');
    const other = session('other', [{ type: 'user', version: '2.1.309', message: { role: 'user', content: 'x' } }], '2.1.309');
    expect(newestRecordedClaudeCodeVersion([other, resumed])).toBe('2.1.310');
  });

  test('falls back to the head version, and is undefined without any', () => {
    const missing: SessionInfo = { id: 'gone', path: join(sandbox, 'gone.jsonl'), project: 'p', modifiedAt: new Date(), sizeBytes: 0, claudeCodeVersion: '2.1.290' };
    expect(newestRecordedClaudeCodeVersion([missing])).toBe('2.1.290');
    const bare = session('bare', [{ type: 'user', message: { role: 'user', content: 'x' } }]);
    expect(newestRecordedClaudeCodeVersion([bare])).toBeUndefined();
    expect(newestRecordedClaudeCodeVersion([])).toBeUndefined();
  });
});
