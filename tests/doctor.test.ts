import { describe, test, expect } from 'bun:test';
import { aggregateStatus, runDoctor } from '../src/doctor.ts';
import type { DoctorCheck } from '../src/doctor.ts';

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

  test('returns the expected nine checks', () => {
    expect(report.checks.length).toBe(9);
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
