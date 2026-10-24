/**
 * Doctor — sanity check command for a claude-crusts install.
 *
 * Verifies that Claude Code is installed and discoverable, that the user's
 * `~/.claude` tree contains the files crusts depends on, that Claude Code
 * keeps transcripts long enough to analyse, that hooks and the statusline
 * (if enabled) are configured consistently, that calibration data exists,
 * and that the backup directory used by `optimize --apply` is writable.
 * Every check returns `pass | warn | fail` with a short message.
 *
 * This is the "did I set everything up correctly?" command — the natural
 * sidekick to `optimize`, which relies on several of these paths being OK.
 */

import { existsSync, statSync, readFileSync, mkdirSync, accessSync, constants as fsConstants } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import chalk from 'chalk';
import { CRUSTS_DIR } from './calibrator.ts';
import { discoverSessions, readLatestClaudeCodeVersion } from './scanner.ts';
import { compareVersions } from './built-in-tools.ts';
import { crustsSessionsDir } from './config.ts';
import { loadSessionSummaries } from './session-summary.ts';
import { detectStatusHooks } from './hooks.ts';
import { VERSION } from './version.ts';
import type { SessionInfo } from './types.ts';

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

/**
 * Check that session JSONL files are discoverable.
 *
 * @param sessions - Sessions found under ~/.claude/projects, newest first
 *   (empty when the folder does not exist)
 */
function checkSessions(sessions: SessionInfo[]): DoctorCheck {
  if (!existsSync(PROJECTS_DIR)) {
    return { name: 'Session discovery', status: 'warn', detail: `No ${PROJECTS_DIR} yet; run Claude Code once first.` };
  }
  if (sessions.length === 0) {
    return { name: 'Session discovery', status: 'warn', detail: 'No sessions found under ~/.claude/projects.' };
  }
  return {
    name: 'Session discovery',
    status: 'pass',
    detail: `Found ${sessions.length} session(s) (most recent: ${sessions[0]!.id.slice(0, 8)}).`,
  };
}

/** Claude Code's `cleanupPeriodDays` when the setting is absent. */
const DEFAULT_CLEANUP_PERIOD_DAYS = 30;

/** The transcript retention check warns below this `cleanupPeriodDays`. */
export const MIN_RETENTION_DAYS = 90;

/** The `cleanupPeriodDays` the doctor recommends: a year, not an extreme value. */
export const RECOMMENDED_RETENTION_DAYS = 365;

/**
 * Claude Code version that stopped background cleanup from deleting some
 * recent files, such as pasted images, when `cleanupPeriodDays` is very
 * large (Claude Code changelog, 2.1.310).
 */
export const LARGE_CLEANUP_PERIOD_FIXED_IN = '2.1.310';

/** How many of the most recently modified transcripts are probed for the Claude Code version. */
const VERSION_PROBE_SESSIONS = 5;

/** What the transcript retention check needs besides settings.json. */
export interface RetentionContext {
  /** Session summaries crusts keeps (`loadSessionSummaries().length`) */
  summaryCount: number;
  /** Folder that holds them (`crustsSessionsDir()`) */
  summariesDir: string;
  /** Newest Claude Code version recorded in the transcripts, when known */
  claudeCodeVersion?: string;
}

/**
 * Check how long Claude Code keeps transcripts.
 *
 * Claude Code deletes transcripts older than `cleanupPeriodDays` (30 days
 * when the setting is absent; under 1 is a settings error), and crusts can
 * analyse a session only while its transcript exists. The auto-inject
 * hook's session summaries (session-summary.ts) keep a small record past
 * that. Warns when the setting is absent, invalid or under
 * `MIN_RETENTION_DAYS`, recommending `RECOMMENDED_RETENTION_DAYS`. Before
 * Claude Code 2.1.310 a very large value made background cleanup delete
 * some recent files, such as pasted images, so on an older version the
 * advice says to stay moderate and a value above the recommendation warns.
 * Without a known version that caveat is left out.
 *
 * @param settings - Parsed ~/.claude/settings.json: {} when the file does
 *   not exist, null when it cannot be parsed
 * @param context - The summaries kept and the Claude Code version
 * @returns The check result
 */
export function checkTranscriptRetention(
  settings: Record<string, unknown> | null,
  context: RetentionContext,
): DoctorCheck {
  const name = 'Transcript retention';
  const count = context.summaryCount;
  const summaries = count > 0
    ? `crusts keeps ${count} session ${count === 1 ? 'summary' : 'summaries'} in ${context.summariesDir}.`
    : `No session summaries in ${context.summariesDir} yet; the auto-inject hook (claude-crusts hooks auto-inject enable) keeps one per session.`;
  const version = context.claudeCodeVersion;
  const olderClaudeCode = version !== undefined && compareVersions(version, LARGE_CLEANUP_PERIOD_FIXED_IN) < 0;
  const advice = `Set "cleanupPeriodDays": ${RECOMMENDED_RETENTION_DAYS} in ~/.claude/settings.json to keep transcripts for a year.`
    + (olderClaudeCode
      ? ` Keep it moderate on Claude Code ${version}: before ${LARGE_CLEANUP_PERIOD_FIXED_IN}, a very large value made background cleanup delete some recent files, such as pasted images.`
      : '');

  if (settings === null) {
    return { name, status: 'warn', detail: `~/.claude/settings.json is not valid JSON, so the retention period cannot be read. ${summaries}` };
  }
  const days = settings.cleanupPeriodDays;
  if (days === undefined) {
    return {
      name,
      status: 'warn',
      detail: `cleanupPeriodDays is not set, so Claude Code deletes transcripts older than ${DEFAULT_CLEANUP_PERIOD_DAYS} days and crusts can no longer analyze those sessions. ${summaries} ${advice}`,
    };
  }
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 1) {
    return {
      name,
      status: 'warn',
      detail: `cleanupPeriodDays is ${JSON.stringify(days)}, but Claude Code takes a number of days, 1 or more. ${summaries} ${advice}`,
    };
  }
  if (days < MIN_RETENTION_DAYS) {
    return {
      name,
      status: 'warn',
      detail: `cleanupPeriodDays is ${days}, so Claude Code deletes transcripts older than ${days} days and crusts can no longer analyze those sessions. ${summaries} ${advice}`,
    };
  }
  if (days > RECOMMENDED_RETENTION_DAYS && olderClaudeCode) {
    return {
      name,
      status: 'warn',
      detail: `cleanupPeriodDays is ${days}. Before Claude Code ${LARGE_CLEANUP_PERIOD_FIXED_IN}, a very large value made background cleanup delete some recent files, such as pasted images, and your newest transcripts are from ${version}. Update Claude Code, or use ${RECOMMENDED_RETENTION_DAYS}. ${summaries}`,
    };
  }
  return { name, status: 'pass', detail: `cleanupPeriodDays is ${days}: Claude Code keeps transcripts for ${days} days. ${summaries}` };
}

/**
 * The newest Claude Code version recorded at the end of the most recently
 * modified transcripts: the build that wrote to them last, which is the
 * installed one unless Claude Code updated since. Read from the transcripts,
 * as session discovery reads versions, rather than by running `claude`.
 *
 * @param sessions - Discovered sessions, most recently modified first
 * @returns The version, or undefined when none of them records one
 */
export function newestRecordedClaudeCodeVersion(sessions: SessionInfo[]): string | undefined {
  let newest: string | undefined;
  for (const session of sessions.slice(0, VERSION_PROBE_SESSIONS)) {
    const version = readLatestClaudeCodeVersion(session.path) ?? session.claudeCodeVersion;
    if (!version || Number.isNaN(compareVersions(version, version))) continue;
    if (newest === undefined || compareVersions(version, newest) > 0) newest = version;
  }
  return newest;
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

/** Report the status hook's install state from ~/.claude/settings.json. */
function checkHooks(): DoctorCheck {
  return checkHookIntegration(readSettings());
}

/**
 * The 'Hook integration' check for parsed settings.
 *
 * Passes with the Stop hook installed or with none (it is optional). Warns
 * when the 0.8.1-and-earlier entry on the Notification event is still there:
 * Claude Code discards that hook's output, so it shows nothing.
 *
 * @param settings - Parsed settings.json, or null when missing or unreadable
 * @returns The check result
 */
export function checkHookIntegration(settings: Record<string, unknown> | null): DoctorCheck {
  const name = 'Hook integration';
  if (!settings) return { name, status: 'warn', detail: 'settings.json is missing or unreadable, so the hook state is unknown.' };

  const { installed, legacy } = detectStatusHooks(settings);
  if (legacy) {
    return {
      name,
      status: 'warn',
      detail: 'Old CRUSTS hook on the Notification event shows nothing (Claude Code discards its output). Run `claude-crusts hooks enable` to move it to Stop.',
    };
  }
  return {
    name,
    status: 'pass',
    detail: installed
      ? 'CRUSTS Stop hook installed (context health after each response).'
      : 'Not installed (optional). Run `claude-crusts hooks enable` to enable.',
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
  // Discovered once for session discovery and the retention check's version.
  const sessions = existsSync(PROJECTS_DIR) ? discoverSessions() : [];
  const checks: DoctorCheck[] = [
    checkVersion(),
    checkClaudeHome(),
    checkSettings(),
    checkSessions(sessions),
    checkTranscriptRetention(existsSync(SETTINGS_PATH) ? readSettings() : {}, {
      summaryCount: loadSessionSummaries().length,
      summariesDir: crustsSessionsDir(),
      claudeCodeVersion: newestRecordedClaudeCodeVersion(sessions),
    }),
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
