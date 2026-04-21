/**
 * Doctor — sanity check command for a claude-crusts install.
 *
 * Verifies that Claude Code is installed and discoverable, that the user's
 * `~/.claude` tree contains the files crusts depends on, that hooks and the
 * statusline (if enabled) are configured consistently, that calibration
 * data exists, and that the backup directory used by `optimize --apply` is
 * writable. Every check returns `pass | warn | fail` with a short message.
 *
 * This is the "did I set everything up correctly?" command — the natural
 * sidekick to `optimize`, which relies on several of these paths being OK.
 */

import { existsSync, statSync, readFileSync, mkdirSync, accessSync, constants as fsConstants } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import chalk from 'chalk';
import { CRUSTS_DIR } from './calibrator.ts';
import { discoverSessions } from './scanner.ts';
import { VERSION } from './version.ts';

/** A single diagnostic check result. */
export interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

/** Aggregate result across all checks. */
export interface DoctorReport {
  checks: DoctorCheck[];
  overall: 'pass' | 'warn' | 'fail';
}

const CLAUDE_HOME = join(homedir(), '.claude');
const SETTINGS_PATH = join(CLAUDE_HOME, 'settings.json');
const PROJECTS_DIR = join(CLAUDE_HOME, 'projects');
const BACKUPS_DIR = join(CRUSTS_DIR, 'backups');
const HISTORY_PATH = join(CRUSTS_DIR, 'history.jsonl');
const CALIBRATION_PATH = join(CRUSTS_DIR, 'calibration.json');

/** Parse settings.json, tolerating missing file and corruption. */
function readSettings(): Record<string, unknown> | null {
  if (!existsSync(SETTINGS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Check that the Claude Code ~/.claude home directory exists. */
function checkClaudeHome(): DoctorCheck {
  if (!existsSync(CLAUDE_HOME)) {
    return {
      name: 'Claude Code install',
      status: 'fail',
      detail: `~/.claude does not exist. Install Claude Code before using crusts.`,
    };
  }
  return { name: 'Claude Code install', status: 'pass', detail: `Found ${CLAUDE_HOME}` };
}

/** Check that session JSONL files are discoverable. */
function checkSessions(): DoctorCheck {
  if (!existsSync(PROJECTS_DIR)) {
    return { name: 'Session discovery', status: 'warn', detail: `No ${PROJECTS_DIR} yet; run Claude Code once first.` };
  }
  const sessions = discoverSessions();
  if (sessions.length === 0) {
    return { name: 'Session discovery', status: 'warn', detail: 'No sessions found under ~/.claude/projects.' };
  }
  return {
    name: 'Session discovery',
    status: 'pass',
    detail: `Found ${sessions.length} session(s) (most recent: ${sessions[0]!.id.slice(0, 8)}).`,
  };
}

/** Verify settings.json is readable and valid JSON. */
function checkSettings(): DoctorCheck {
  if (!existsSync(SETTINGS_PATH)) {
    return { name: 'Claude Code settings', status: 'warn', detail: `${SETTINGS_PATH} missing (ok if you haven't customised).` };
  }
  const parsed = readSettings();
  if (parsed === null) {
    return { name: 'Claude Code settings', status: 'fail', detail: `${SETTINGS_PATH} is not valid JSON.` };
  }
  return { name: 'Claude Code settings', status: 'pass', detail: 'settings.json parses cleanly.' };
}

/** Report hooks status based on settings + CRUSTS config cross-reference. */
function checkHooks(): DoctorCheck {
  const settings = readSettings();
  if (!settings) return { name: 'Hook integration', status: 'warn', detail: 'No settings.json — hook status unknown.' };

  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  let installed = false;
  if (hooks && typeof hooks === 'object') {
    for (const entries of Object.values(hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const group = entry as { hooks?: { command?: string }[] };
        if (!Array.isArray(group.hooks)) continue;
        if (group.hooks.some((h) => h.command === 'claude-crusts status')) installed = true;
      }
    }
  }
  return {
    name: 'Hook integration',
    status: 'pass',
    detail: installed ? 'CRUSTS hook installed (after-response status).' : 'Not installed (optional). Run `claude-crusts hooks enable` to enable.',
  };
}

/** Report statusline integration presence. */
function checkStatusline(): DoctorCheck {
  const settings = readSettings();
  if (!settings) return { name: 'Statusline integration', status: 'warn', detail: 'No settings.json — statusline status unknown.' };
  const sl = settings.statusLine as { command?: string } | undefined;
  const mine = sl?.command === 'claude-crusts statusline';
  const other = sl?.command && !mine;
  if (mine) return { name: 'Statusline integration', status: 'pass', detail: 'CRUSTS statusline installed.' };
  if (other) return { name: 'Statusline integration', status: 'warn', detail: `Another statusLine active: ${sl!.command}` };
  return { name: 'Statusline integration', status: 'pass', detail: 'Not installed (optional). Run `claude-crusts statusline install` to enable.' };
}

/** Check presence of calibration data. */
function checkCalibration(): DoctorCheck {
  if (!existsSync(CALIBRATION_PATH)) {
    return {
      name: 'Calibration data',
      status: 'warn',
      detail: 'No calibration saved. Run `claude-crusts calibrate` after `/context` to pin ground-truth token totals.',
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(CALIBRATION_PATH, 'utf-8'));
    const ts = typeof parsed === 'object' && parsed && 'timestamp' in parsed ? String(parsed.timestamp) : 'unknown';
    return { name: 'Calibration data', status: 'pass', detail: `Calibrated at ${ts}.` };
  } catch {
    return { name: 'Calibration data', status: 'fail', detail: `${CALIBRATION_PATH} is corrupt.` };
  }
}

/** Check trend history presence + sanity. */
function checkTrendHistory(): DoctorCheck {
  if (!existsSync(HISTORY_PATH)) {
    return { name: 'Trend history', status: 'warn', detail: 'No history yet (runs after the first `analyze`).' };
  }
  try {
    const size = statSync(HISTORY_PATH).size;
    const lines = readFileSync(HISTORY_PATH, 'utf-8').split('\n').filter(Boolean);
    return { name: 'Trend history', status: 'pass', detail: `${lines.length} record(s), ${size} bytes.` };
  } catch {
    return { name: 'Trend history', status: 'fail', detail: `${HISTORY_PATH} unreadable.` };
  }
}

/** Check that the backup dir for `optimize --apply` is writable. */
function checkBackupsDir(): DoctorCheck {
  try {
    if (!existsSync(BACKUPS_DIR)) mkdirSync(BACKUPS_DIR, { recursive: true });
    accessSync(BACKUPS_DIR, fsConstants.W_OK);
    return { name: 'Optimize backup dir', status: 'pass', detail: `${BACKUPS_DIR} writable.` };
  } catch (err) {
    return { name: 'Optimize backup dir', status: 'fail', detail: `Cannot write to ${BACKUPS_DIR}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Report the installed claude-crusts version. */
function checkVersion(): DoctorCheck {
  return { name: 'claude-crusts version', status: 'pass', detail: VERSION };
}

/**
 * Aggregate a list of check statuses into a single overall verdict.
 *
 * Worst-wins: any `fail` produces `fail`; otherwise any `warn` produces
 * `warn`; else `pass`.
 */
export function aggregateStatus(checks: DoctorCheck[]): 'pass' | 'warn' | 'fail' {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'pass';
}

/** Run every check and return an aggregated report. */
export function runDoctor(): DoctorReport {
  const checks: DoctorCheck[] = [
    checkVersion(),
    checkClaudeHome(),
    checkSettings(),
    checkSessions(),
    checkHooks(),
    checkStatusline(),
    checkCalibration(),
    checkTrendHistory(),
    checkBackupsDir(),
  ];
  return { checks, overall: aggregateStatus(checks) };
}

/** Pretty-print a doctor report to stdout with coloured status tags. */
export function renderDoctor(report: DoctorReport): void {
  const hr = '\u2501'.repeat(52);
  console.log();
  console.log(chalk.bold('  CRUSTS Doctor'));
  console.log(chalk.dim('  ' + hr));
  for (const c of report.checks) {
    const tag =
      c.status === 'pass' ? chalk.green('\u2713 pass') :
      c.status === 'warn' ? chalk.yellow('! warn') :
      chalk.red('\u2717 fail');
    console.log(`  ${tag}  ${chalk.bold(c.name.padEnd(28))} ${chalk.dim(c.detail)}`);
  }
  console.log(chalk.dim('  ' + hr));
  const summary =
    report.overall === 'pass' ? chalk.green('All checks passed.') :
    report.overall === 'warn' ? chalk.yellow('Finished with warnings.') :
    chalk.red('One or more checks failed.');
  console.log(`  ${summary}`);
  console.log();
}
