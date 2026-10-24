/**
 * Claude Code hook integration: the after-response status notice and the
 * auto-inject hook.
 *
 * `claude-crusts hooks enable` adds a `Stop` hook to `~/.claude/settings.json`
 * that runs `claude-crusts status --hook` each time Claude finishes a
 * response. In hook mode, `status` reads Claude Code's hook payload from
 * stdin and prints one JSON object, `{"systemMessage": "<status line>"}`,
 * which Claude Code shows to the person. It never returns a `decision` and
 * never exits with code 2: on `Stop`, either one makes Claude keep working.
 *
 * Up to 0.8.1, `hooks enable` installed `claude-crusts status` on the
 * `Notification` event instead. Claude Code discards a Notification hook's
 * `systemMessage` and stdout, so that hook showed nothing. `hooks enable`
 * moves it to `Stop`; `hooks disable` removes both.
 *
 * Every write to settings.json is preceded by a backup under
 * `~/.claude-crusts/backups/`, touches only crusts' own entries, and is
 * skipped when the file does not parse (rewriting it would drop the rest).
 */

import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import chalk from 'chalk';
import { loadConfig, saveConfig, stripBom, crustsSessionsDir } from './config.ts';
import { loadSessionSummaries } from './session-summary.ts';
import { CRUSTS_DIR } from './calibrator.ts';
import { discoverSessions, parseSession, collectObservedMcpServers } from './scanner.ts';
import { gatherConfigData, sessionProjectPath } from './analyzer.ts';
import { classifySession, countAnalyzedMessages } from './classifier.ts';
import { getContextHealth } from './recommender.ts';
import type { ContextHealth, CrustsBreakdown } from './types.ts';

/** Path to Claude Code's global settings */
const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

/** The exact command string we install for the after-response status hook */
export const HOOK_COMMAND = 'claude-crusts status --hook';

/** The Claude Code event the status hook runs on: Claude finished a response */
export const HOOK_EVENT = 'Stop';

/**
 * The status hook crusts 0.8.1 and earlier installed, on LEGACY_HOOK_EVENT.
 * Matched exactly and only on that event, so a hook someone else configured
 * is never touched.
 */
export const LEGACY_HOOK_COMMAND = 'claude-crusts status';

/** The event the 0.8.1-and-earlier status hook ran on, where its output was discarded */
export const LEGACY_HOOK_EVENT = 'Notification';

/**
 * Seconds Claude Code allows the status hook before abandoning it. A Stop
 * hook holds up the end of the turn while it runs, and Claude Code's default
 * for command hooks is 600 seconds; the hook normally takes well under one.
 */
const HOOK_TIMEOUT_SECONDS = 30;

/** The exact command string we install for the auto-inject hook */
const AUTO_INJECT_HOOK_COMMAND = 'claude-crusts auto-inject';

/** The event the auto-inject hook runs on */
const AUTO_INJECT_HOOK_EVENT = 'UserPromptSubmit';

/** settings.json backups kept per file name in the backup folder */
const SETTINGS_BACKUPS_KEPT = 10;

// ---------------------------------------------------------------------------
// Settings I/O helpers
// ---------------------------------------------------------------------------

/**
 * Whether a value is a JSON object (not null, not an array).
 *
 * @param value - Any parsed JSON value
 * @returns True for a plain object
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The message of a caught error.
 *
 * @param err - Anything thrown
 * @returns Its message, or its string form
 */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A settings file read for editing: its object, or why it must not be rewritten. */
type SettingsRead =
  | { ok: true; settings: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Read a settings file for editing.
 *
 * A missing or empty file reads as `{}`. A file that does not parse as a
 * JSON object is reported instead: rewriting it from `{}` would drop every
 * other setting in it. Claude Code accepts neither comments nor trailing
 * commas in settings.json, so such a file needs fixing by hand anyway.
 *
 * @param path - Absolute path to the settings file
 * @returns The parsed object, or the reason it cannot be edited
 */
function readSettingsForEdit(path: string): SettingsRead {
  if (!existsSync(path)) return { ok: true, settings: {} };
  let raw: string;
  try {
    raw = stripBom(readFileSync(path, 'utf-8'));
  } catch (err) {
    return { ok: false, reason: errorText(err) };
  }
  if (raw.trim() === '') return { ok: true, settings: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isPlainObject(parsed)) return { ok: true, settings: parsed };
    return { ok: false, reason: 'it does not hold a JSON object' };
  } catch (err) {
    return { ok: false, reason: errorText(err) };
  }
}

/**
 * The crusts backup folder, shared with `optimize --apply`:
 * `~/.claude-crusts/backups/`, or `CRUSTS_BACKUP_DIR_OVERRIDE` (tests).
 *
 * @returns Absolute path of the folder (not created here)
 */
function backupDir(): string {
  const override = process.env.CRUSTS_BACKUP_DIR_OVERRIDE;
  return override && override.length > 0 ? override : join(CRUSTS_DIR, 'backups');
}

/**
 * Copy a settings file into the backup folder before it is rewritten.
 *
 * The copy is named `<file name>.<ISO time>.bak`, as `optimize --apply`
 * names its backups, and only the newest SETTINGS_BACKUPS_KEPT copies of
 * that file name are kept. Pruning sorts by name, which carries the time.
 *
 * @param path - The settings file about to be written
 * @returns The backup's path, or undefined when there is no file to copy
 * @throws When the copy fails; the caller must not write without a backup
 */
function backupSettings(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  const name = basename(path);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = join(dir, `${name}.${stamp}.bak`);
  for (let n = 1; existsSync(target); n++) target = join(dir, `${name}.${stamp}-${n}.bak`);
  copyFileSync(path, target);

  try {
    const prefix = `${name}.`;
    const backups = readdirSync(dir)
      .filter((file) => file.startsWith(prefix) && file.endsWith('.bak'))
      .sort((a, b) => b.localeCompare(a));
    for (const stale of backups.slice(SETTINGS_BACKUPS_KEPT)) {
      try { unlinkSync(join(dir, stale)); } catch { /* best effort */ }
    }
  } catch { /* pruning is best effort; the backup itself is written */ }
  return target;
}

/** Outcome of writing an edited settings file. */
type SettingsWrite =
  | { ok: true; backup: string | undefined }
  | { ok: false; message: string };

/**
 * Back up a settings file, then write the edited object over it.
 *
 * Nothing is written when the backup fails. The object is written whole,
 * 2-space indented; keys this module did not edit keep their values and
 * their order.
 *
 * @param path - Absolute path to the settings file
 * @param settings - The edited settings object
 * @returns The backup's path (undefined when the file is new), or what failed
 */
function writeSettings(path: string, settings: Record<string, unknown>): SettingsWrite {
  let backup: string | undefined;
  try {
    backup = backupSettings(path);
  } catch (err) {
    return { ok: false, message: `Could not back up ${path}, so it was left unchanged: ${errorText(err)}` };
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  } catch (err) {
    return { ok: false, message: `Could not write ${path}: ${errorText(err)}` };
  }
  return { ok: true, backup };
}

/**
 * Print why a settings file was left alone.
 *
 * @param path - The settings file
 * @param reason - Why it cannot be edited
 */
function reportUnreadable(path: string, reason: string): void {
  console.log(chalk.red(`  Cannot read ${path} (${reason}).`));
  console.log(chalk.dim('  It was left unchanged. Fix the file, then run this command again.'));
}

// ---------------------------------------------------------------------------
// Hook entries
// ---------------------------------------------------------------------------

/**
 * The hook groups configured for one event.
 *
 * @param settings - Parsed settings.json contents
 * @param event - Hook event name, e.g. `Stop`
 * @returns The event's groups; empty when it has none or they are malformed
 */
function eventGroups(settings: Record<string, unknown>, event: string): unknown[] {
  const hooks = settings.hooks;
  if (!isPlainObject(hooks)) return [];
  const groups = hooks[event];
  return Array.isArray(groups) ? groups : [];
}

/**
 * Whether a hook group runs exactly `command`.
 *
 * @param group - One entry of an event's array (`{ matcher?, hooks: [...] }`)
 * @param command - The command string to look for
 * @returns True when one of the group's hooks has that command
 */
function groupHasCommand(group: unknown, command: string): boolean {
  if (!isPlainObject(group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.some((hook) => isPlainObject(hook) && hook.command === command);
}

/**
 * Whether an event has a hook that runs exactly `command`.
 *
 * @param settings - Parsed settings.json contents
 * @param event - Hook event name
 * @param command - The command string to look for
 * @returns True when found
 */
function hasCommandHook(settings: Record<string, unknown>, event: string, command: string): boolean {
  return eventGroups(settings, event).some((group) => groupHasCommand(group, command));
}

/**
 * Append a hook group to an event unless the event already runs `command`.
 *
 * Creates `hooks` and the event's array when they are missing. Refuses,
 * without changing anything, when either exists with the wrong shape:
 * replacing it would drop whatever the person put there.
 *
 * @param settings - Parsed settings.json contents (edited in place)
 * @param event - Hook event name
 * @param command - The command the group runs, used to detect a present entry
 * @param group - The group to append
 * @returns 'added', 'present', or a description of the malformed value
 */
function addCommandHook(
  settings: Record<string, unknown>,
  event: string,
  command: string,
  group: Record<string, unknown>,
): 'added' | 'present' | { invalid: string } {
  if (settings.hooks !== undefined && settings.hooks !== null && !isPlainObject(settings.hooks)) {
    return { invalid: '"hooks" is not an object' };
  }
  const hooks = isPlainObject(settings.hooks) ? settings.hooks : {};
  const groups = hooks[event];
  if (groups !== undefined && groups !== null && !Array.isArray(groups)) {
    return { invalid: `"hooks.${event}" is not a list` };
  }
  if (Array.isArray(groups) && groups.some((g) => groupHasCommand(g, command))) return 'present';

  settings.hooks = hooks;
  if (Array.isArray(groups)) groups.push(group);
  else hooks[event] = [group];
  return 'added';
}

/**
 * Remove every hook that runs exactly `command` from one event.
 *
 * Everything else is left as it was: other commands in the same group
 * stay, a group is dropped only when this removal emptied it, and the event
 * (then `hooks`) is deleted only when that left it empty.
 *
 * @param settings - Parsed settings.json contents (edited in place)
 * @param event - Hook event name
 * @param command - The exact command to remove
 * @returns How many hooks were removed
 */
function removeCommandHooks(settings: Record<string, unknown>, event: string, command: string): number {
  const hooks = settings.hooks;
  if (!isPlainObject(hooks)) return 0;
  const groups = hooks[event];
  if (!Array.isArray(groups)) return 0;

  let removed = 0;
  const kept: unknown[] = [];
  for (const group of groups) {
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const remaining = group.hooks.filter((hook) => !(isPlainObject(hook) && hook.command === command));
    const dropped = group.hooks.length - remaining.length;
    if (dropped === 0) {
      kept.push(group);
      continue;
    }
    removed += dropped;
    if (remaining.length > 0) {
      group.hooks = remaining;
      kept.push(group);
    }
  }
  if (removed === 0) return 0;

  if (kept.length > 0) hooks[event] = kept;
  else delete hooks[event];
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return removed;
}

/** Where crusts' status hook sits in a settings file. */
export interface StatusHookState {
  /** HOOK_COMMAND is configured on the Stop event (the current install) */
  installed: boolean;
  /** LEGACY_HOOK_COMMAND is configured on Notification (0.8.1 and earlier; shows nothing) */
  legacy: boolean;
}

/**
 * Find the status hook, current and legacy, in parsed settings.
 *
 * @param settings - Parsed settings.json contents
 * @returns Which of the two entries are present
 */
export function detectStatusHooks(settings: Record<string, unknown>): StatusHookState {
  return {
    installed: hasCommandHook(settings, HOOK_EVENT, HOOK_COMMAND),
    legacy: hasCommandHook(settings, LEGACY_HOOK_EVENT, LEGACY_HOOK_COMMAND),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Install the CRUSTS status hook on Claude Code's Stop event.
 *
 * Idempotent: an existing Stop entry is kept and no second one is added.
 * The 0.8.1-and-earlier entry on Notification is removed in the same write.
 * settings.json is backed up first and left alone when it does not parse.
 * Claude Code's settings watcher picks up the change in running sessions.
 *
 * @param settingsPath - Settings file to edit (default `~/.claude/settings.json`)
 */
export function enableHooks(settingsPath: string = CLAUDE_SETTINGS_PATH): void {
  const read = readSettingsForEdit(settingsPath);
  if (!read.ok) {
    reportUnreadable(settingsPath, read.reason);
    return;
  }
  const settings = read.settings;

  // Add before removing, so a `hooks` object that held only the legacy
  // entry is reused in place instead of deleted and re-created at the end.
  const added = addCommandHook(settings, HOOK_EVENT, HOOK_COMMAND, {
    hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }],
  });
  if (typeof added === 'object') {
    reportUnreadable(settingsPath, added.invalid);
    return;
  }
  const migrated = removeCommandHooks(settings, LEGACY_HOOK_EVENT, LEGACY_HOOK_COMMAND);

  if (added === 'present' && migrated === 0) {
    console.log(chalk.yellow('  CRUSTS hooks are already enabled.'));
    if (loadConfig().hooksEnabled !== true) saveConfig({ hooksEnabled: true });
    return;
  }

  const written = writeSettings(settingsPath, settings);
  if (!written.ok) {
    console.log(chalk.red(`  ${written.message}`));
    return;
  }
  saveConfig(added === 'added'
    ? { hooksEnabled: true, installedAt: new Date().toISOString() }
    : { hooksEnabled: true });

  if (migrated > 0) {
    console.log(chalk.green(added === 'added'
      ? '  Moved the CRUSTS status hook from the Notification event, where Claude Code shows nothing, to Stop.'
      : '  Removed the old CRUSTS status hook from the Notification event, where Claude Code shows nothing.'));
  }
  console.log(chalk.green('  CRUSTS hooks enabled.'));
  console.log(chalk.dim('  A one-line context health notice will appear after each Claude Code response.'));
  console.log(chalk.dim('  Running sessions pick this up within a few seconds; restart one if no notice appears.'));
  if (written.backup) console.log(chalk.dim(`  Previous settings.json saved to ${written.backup}`));
  console.log(chalk.dim('  Run `claude-crusts hooks disable` to turn off.'));
}

/**
 * Remove the CRUSTS status hook from Claude Code settings.
 *
 * Removes the Stop entry and the legacy Notification entry, nothing else:
 * other hooks in the same groups and events stay. settings.json is backed
 * up first and left alone when it does not parse.
 *
 * @param settingsPath - Settings file to edit (default `~/.claude/settings.json`)
 */
export function disableHooks(settingsPath: string = CLAUDE_SETTINGS_PATH): void {
  const read = readSettingsForEdit(settingsPath);
  if (!read.ok) {
    reportUnreadable(settingsPath, read.reason);
    return;
  }
  const settings = read.settings;
  const removed = removeCommandHooks(settings, HOOK_EVENT, HOOK_COMMAND)
    + removeCommandHooks(settings, LEGACY_HOOK_EVENT, LEGACY_HOOK_COMMAND);

  if (removed === 0) {
    console.log(chalk.yellow('  CRUSTS hooks are not currently enabled.'));
    saveConfig({ hooksEnabled: false });
    return;
  }

  const written = writeSettings(settingsPath, settings);
  if (!written.ok) {
    console.log(chalk.red(`  ${written.message}`));
    return;
  }
  saveConfig({ hooksEnabled: false });

  console.log(chalk.yellow('  CRUSTS hooks disabled.'));
  if (written.backup) console.log(chalk.dim(`  Previous settings.json saved to ${written.backup}`));
}

/**
 * Report whether the CRUSTS status hook is installed.
 *
 * Cross-references CRUSTS config.json with the actual settings.json to
 * detect manual modifications, and reports a legacy Notification entry
 * (which shows nothing) alongside or instead of the current one.
 *
 * @param settingsPath - Settings file to inspect (default `~/.claude/settings.json`)
 */
export function hooksStatus(settingsPath: string = CLAUDE_SETTINGS_PATH): void {
  const config = loadConfig();
  const read = readSettingsForEdit(settingsPath);
  if (!read.ok) {
    console.log(chalk.red(`  CRUSTS hooks: unknown, ${settingsPath} cannot be read (${read.reason}).`));
    return;
  }
  const { installed, legacy } = detectStatusHooks(read.settings);
  const configSays = config.hooksEnabled === true;

  if (installed && configSays) {
    console.log(chalk.green('  CRUSTS hooks: enabled (Stop hook, a notice after each response)'));
    console.log(chalk.dim(`  Installed at: ${config.installedAt as string ?? 'unknown'}`));
  } else if (installed) {
    console.log(chalk.yellow('  CRUSTS hooks: enabled (found in settings.json, but CRUSTS config says disabled)'));
    console.log(chalk.dim('  Run `claude-crusts hooks enable` to sync the state.'));
  } else if (legacy) {
    console.log(chalk.yellow('  CRUSTS hooks: old install on the Notification event, which shows nothing'));
    console.log(chalk.dim('  Claude Code discards a Notification hook\'s output.'));
    console.log(chalk.dim('  Run `claude-crusts hooks enable` to move it to the Stop event.'));
  } else if (configSays) {
    console.log(chalk.yellow('  CRUSTS hooks: disabled (hook was removed from settings.json)'));
    console.log(chalk.dim('  Run `claude-crusts hooks enable` to re-install.'));
  } else {
    console.log(chalk.dim('  CRUSTS hooks: not enabled'));
    console.log(chalk.dim('  Run `claude-crusts hooks enable` to show context health after each response.'));
  }
  if (installed && legacy) {
    console.log(chalk.yellow('  An old CRUSTS hook is also on the Notification event, where it shows nothing.'));
    console.log(chalk.dim('  Run `claude-crusts hooks enable` to remove it.'));
  }
}

// ---------------------------------------------------------------------------
// Status hook runtime (`claude-crusts status --hook`)
// ---------------------------------------------------------------------------

/**
 * How long the status hook waits for Claude Code's payload on stdin.
 *
 * Claude Code writes the payload and closes stdin as the hook starts, so it
 * arrives within milliseconds. The deadline matters only when stdin is a
 * pipe that nobody writes to or closes: an unbounded read would then hold
 * up the end of every response.
 */
export const HOOK_STDIN_TIMEOUT_MS = 1000;

/** The fields of Claude Code's Stop hook payload that the status hook reads. */
export interface StatusHookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  /**
   * True when Claude is already continuing because a Stop hook blocked the
   * previous stop (another hook, or `/goal`). The status hook stays silent
   * then; the notice came with the first stop of that chain.
   */
  stop_hook_active?: boolean;
}

/**
 * Parse a hook payload.
 *
 * @param raw - Text read from stdin
 * @returns The payload, or null unless the text is one JSON object
 */
export function parseHookPayload(raw: string): StatusHookPayload | null {
  const text = stripBom(raw).trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed as StatusHookPayload : null;
  } catch {
    return null;
  }
}

/**
 * Read a hook payload from stdin, waiting at most `timeoutMs`.
 *
 * Resolves null when stdin is a terminal, empty, or not one JSON object.
 * At the deadline the read stops and whatever arrived is parsed. stdin is
 * then paused and destroyed: an open pipe left in flowing mode keeps the
 * process alive after the deadline (Node 22 and Bun 1.4 both). Never rejects.
 *
 * @param timeoutMs - Deadline for the payload (default HOOK_STDIN_TIMEOUT_MS)
 * @returns The payload, or null
 */
export function readHookPayload(timeoutMs: number = HOOK_STDIN_TIMEOUT_MS): Promise<StatusHookPayload | null> {
  return new Promise((resolve) => {
    let stdin: NodeJS.ReadStream;
    try {
      stdin = process.stdin;
      if (stdin.isTTY) {
        resolve(null);
        return;
      }
    } catch {
      resolve(null); // no usable stdin handle
      return;
    }
    const chunks: Buffer[] = [];
    let settled = false;
    const onData = (chunk: Buffer | string): void => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', finish);
      stdin.off('error', finish);
      // A late error on a released stdin must not become an uncaught one.
      stdin.on('error', () => {});
      try {
        stdin.pause();
        stdin.destroy();
      } catch { /* already closed */ }
      resolve(parseHookPayload(Buffer.concat(chunks).toString('utf-8')));
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.on('data', onData);
    stdin.on('end', finish);
    stdin.on('error', finish);
  });
}

/** The one-line context health summary shared by `status` and the Stop hook. */
export interface StatusSummary {
  /** Live-window usage percent (the current context when the session compacted) */
  usagePercent: number;
  /** Health label for that percent (the recommender's 50/70/85 thresholds) */
  health: ContextHealth;
  /** `CRUSTS: 62.4% (warming) | 45 msgs | 1 compaction`, without colour codes */
  line: string;
}

/**
 * Summarise a breakdown as the status one-liner.
 *
 * @param breakdown - Classification result for the session
 * @returns Usage percent, health label and the plain line
 */
export function summarizeStatus(breakdown: CrustsBreakdown): StatusSummary {
  const usagePercent = (breakdown.currentContext ?? breakdown).usage_percentage;
  const health = getContextHealth(usagePercent);
  // Analyzed (non-attachment) rows only, so the one-liner agrees with
  // `analyze` on the same session (M11 exclusion rule).
  const msgCount = countAnalyzedMessages(breakdown.messages);
  const compCount = breakdown.compactionEvents.length;
  const line = `CRUSTS: ${usagePercent.toFixed(1)}% (${health}) | ${msgCount} msgs | ${compCount} compaction${compCount === 1 ? '' : 's'}`;
  return { usagePercent, health, line };
}

/**
 * Parse a session and summarise its live window for the status line.
 *
 * Config comes from the session's own project, as `analyze` reads it: the
 * project root decoded from the transcript's folder (else `cwd`), the
 * folder's slug for memory, and the MCP servers the transcript used. So the
 * status line and `analyze` agree on the window size and the usage.
 *
 * @param sessionPath - Session JSONL path
 * @param cwd - Project root to use when the folder name does not decode
 * @returns The summary, or null for an empty session
 */
export async function buildStatusSummary(sessionPath: string, cwd?: string): Promise<StatusSummary | null> {
  const messages = await parseSession(sessionPath);
  if (messages.length === 0) return null;
  const projectRoot = sessionProjectPath(messages, sessionPath) ?? (cwd && existsSync(cwd) ? cwd : undefined);
  const configData = gatherConfigData(projectRoot, basename(dirname(sessionPath)), collectObservedMcpServers(messages));
  return summarizeStatus(classifySession(messages, configData));
}

/** Options the `status` command passes to hook mode. */
export interface StatusHookOptions {
  /** Explicit session id prefix from the command line; wins over the payload */
  sessionId?: string;
  /** Custom projects directory (`--path`) */
  basePath?: string;
  /** Project name filter (`--project`) */
  project?: string;
}

/**
 * Pick the session the status hook reports on: an explicit id prefix, else
 * the payload's transcript, else the payload's session id, else the most
 * recent session. Prints nothing.
 *
 * @param payload - The hook payload, or null when none arrived
 * @param options - Command-line selection
 * @returns The session file, or null when none matches
 */
function resolveHookSession(payload: StatusHookPayload | null, options: StatusHookOptions): string | null {
  const transcript = payload?.transcript_path;
  if (!options.sessionId && typeof transcript === 'string' && transcript && existsSync(transcript)) {
    return transcript;
  }
  let sessions = discoverSessions(options.basePath);
  if (options.project) {
    const filter = options.project.toLowerCase();
    sessions = sessions.filter((s) => s.project.toLowerCase().includes(filter));
  }
  const payloadId = typeof payload?.session_id === 'string' && payload.session_id ? payload.session_id : undefined;
  const wanted = options.sessionId ?? payloadId;
  if (wanted) {
    const match = sessions.find((s) => s.id.startsWith(wanted));
    if (match) return match.path;
    if (options.sessionId) return null;
  }
  return sessions[0]?.path ?? null;
}

/**
 * `claude-crusts status --hook`: the body of the Stop hook.
 *
 * Prints exactly one JSON object, `{"systemMessage": "<status line>"}`,
 * which Claude Code shows to the person when Claude finishes a response, or
 * prints nothing. It never prints a `decision` and never exits with code 2
 * (on Stop either one makes Claude keep working), stays silent when
 * `stop_hook_active` is true, and swallows every error.
 *
 * @param options - Session selection from the command line
 */
export async function runStatusHook(options: StatusHookOptions = {}): Promise<void> {
  try {
    const payload = await readHookPayload();
    if (payload?.stop_hook_active === true) return;
    const sessionPath = resolveHookSession(payload, options);
    if (!sessionPath) return;
    const cwd = typeof payload?.cwd === 'string' ? payload.cwd : undefined;
    const summary = await buildStatusSummary(sessionPath, cwd);
    if (!summary) return;
    process.stdout.write(JSON.stringify({ systemMessage: summary.line }) + '\n');
  } catch {
    // The status hook must never break Claude Code: no output on failure.
  }
}

// ---------------------------------------------------------------------------
// Auto-inject hook (UserPromptSubmit event)
// ---------------------------------------------------------------------------

/**
 * Check whether the auto-inject hook is present in settings.
 * Scoped to `UserPromptSubmit` since that's the only event we install on.
 *
 * @param settings - Parsed settings.json contents
 * @returns True when the auto-inject command is configured
 */
function hasAutoInjectHook(settings: Record<string, unknown>): boolean {
  return hasCommandHook(settings, AUTO_INJECT_HOOK_EVENT, AUTO_INJECT_HOOK_COMMAND);
}

/**
 * Install the auto-inject hook on `UserPromptSubmit` and flip the
 * `autoInject.enabled` flag in CRUSTS config. settings.json is backed up
 * first and left alone when it does not parse.
 *
 * @param settingsPath - Settings file to edit (default `~/.claude/settings.json`)
 */
export function enableAutoInject(settingsPath: string = CLAUDE_SETTINGS_PATH): void {
  const read = readSettingsForEdit(settingsPath);
  if (!read.ok) {
    reportUnreadable(settingsPath, read.reason);
    return;
  }
  const settings = read.settings;

  const added = addCommandHook(settings, AUTO_INJECT_HOOK_EVENT, AUTO_INJECT_HOOK_COMMAND, {
    matcher: '',
    hooks: [{ type: 'command', command: AUTO_INJECT_HOOK_COMMAND }],
  });
  if (typeof added === 'object') {
    reportUnreadable(settingsPath, added.invalid);
    return;
  }
  if (added === 'present') {
    console.log(chalk.yellow('  CRUSTS auto-inject hook is already installed.'));
    // Still ensure the config flag is on — installed without enabled is a confused state
    const cfg = loadConfig();
    const ai = (cfg.autoInject as { enabled?: boolean } | undefined) ?? {};
    saveConfig({ autoInject: { ...ai, enabled: true } });
    return;
  }

  const written = writeSettings(settingsPath, settings);
  if (!written.ok) {
    console.log(chalk.red(`  ${written.message}`));
    return;
  }
  const cfg = loadConfig();
  const ai = (cfg.autoInject as { enabled?: boolean } | undefined) ?? {};
  saveConfig({
    autoInject: { ...ai, enabled: true, installedAt: new Date().toISOString() },
  });

  console.log(chalk.green('  CRUSTS auto-inject enabled.'));
  console.log(chalk.dim('  When this session\'s context crosses the threshold, CRUSTS adds a /compact focus'));
  console.log(chalk.dim('  advisory to Claude\'s next turn. Claude decides whether to act on it — CRUSTS'));
  console.log(chalk.dim('  never runs /compact directly, so your work is never auto-compacted.'));
  console.log(chalk.dim('  Defaults: fires when the window nears the auto-compaction trigger (within max(20K, 10% of limit)'));
  console.log(chalk.dim('  tokens of it), min-gap 5min. Set an explicit "threshold" (usage %) in ~/.claude-crusts/config.json'));
  console.log(chalk.dim('  under "autoInject" to use a fixed percentage gate instead.'));
  if (written.backup) console.log(chalk.dim(`  Previous settings.json saved to ${written.backup}`));
  console.log(chalk.dim('  Disable anytime: `claude-crusts hooks auto-inject disable`.'));
}

/**
 * Remove the auto-inject hook from `UserPromptSubmit` entries and flip
 * the `autoInject.enabled` flag to false. Other UserPromptSubmit hooks
 * (installed by the user or other tools) are left intact. settings.json is
 * backed up first and left alone when it does not parse.
 *
 * @param settingsPath - Settings file to edit (default `~/.claude/settings.json`)
 */
export function disableAutoInject(settingsPath: string = CLAUDE_SETTINGS_PATH): void {
  const read = readSettingsForEdit(settingsPath);
  if (!read.ok) {
    reportUnreadable(settingsPath, read.reason);
    return;
  }
  const settings = read.settings;

  if (removeCommandHooks(settings, AUTO_INJECT_HOOK_EVENT, AUTO_INJECT_HOOK_COMMAND) === 0) {
    console.log(chalk.yellow('  CRUSTS auto-inject hook is not currently installed.'));
    const cfg = loadConfig();
    const ai = (cfg.autoInject as { enabled?: boolean } | undefined) ?? {};
    saveConfig({ autoInject: { ...ai, enabled: false } });
    return;
  }

  const written = writeSettings(settingsPath, settings);
  if (!written.ok) {
    console.log(chalk.red(`  ${written.message}`));
    return;
  }
  const cfg = loadConfig();
  const ai = (cfg.autoInject as { enabled?: boolean } | undefined) ?? {};
  saveConfig({ autoInject: { ...ai, enabled: false } });

  console.log(chalk.yellow('  CRUSTS auto-inject disabled.'));
  if (written.backup) console.log(chalk.dim(`  Previous settings.json saved to ${written.backup}`));
}

/**
 * Report the install + enabled state of the auto-inject hook, and the
 * session summaries it keeps (see session-summary.ts).
 *
 * @param settingsPath - Settings file to inspect (default `~/.claude/settings.json`)
 */
export function autoInjectStatus(settingsPath: string = CLAUDE_SETTINGS_PATH): void {
  const read = readSettingsForEdit(settingsPath);
  if (!read.ok) {
    console.log(chalk.red(`  CRUSTS auto-inject: unknown, ${settingsPath} cannot be read (${read.reason}).`));
    return;
  }
  const cfg = loadConfig();
  const ai = cfg.autoInject as { enabled?: boolean; threshold?: number; minGapMs?: number; lastInjectionAt?: string } | undefined;
  const installed = hasAutoInjectHook(read.settings);
  const enabled = ai?.enabled === true;

  if (installed && enabled) {
    console.log(chalk.green('  CRUSTS auto-inject: ENABLED'));
    console.log(chalk.dim(`  Threshold: ${ai?.threshold ?? 70}%`));
    console.log(chalk.dim(`  Min gap between injections: ${((ai?.minGapMs ?? 300_000) / 1000).toFixed(0)}s`));
    if (ai?.lastInjectionAt) console.log(chalk.dim(`  Last injection: ${ai.lastInjectionAt}`));
  } else if (installed && !enabled) {
    console.log(chalk.yellow('  CRUSTS auto-inject: INSTALLED but disabled'));
    console.log(chalk.dim('  Hook is in settings.json, but autoInject.enabled is false in CRUSTS config.'));
  } else if (!installed && enabled) {
    console.log(chalk.yellow('  CRUSTS auto-inject: config says enabled, but hook not in settings.json'));
    console.log(chalk.dim('  Run `claude-crusts hooks auto-inject enable` to re-install.'));
  } else {
    console.log(chalk.dim('  CRUSTS auto-inject: not installed'));
    console.log(chalk.dim('  Run `claude-crusts hooks auto-inject enable` to opt in.'));
  }

  const summaries = loadSessionSummaries().length;
  console.log(chalk.dim(summaries > 0
    ? `  Session summaries: ${summaries} kept in ${crustsSessionsDir()}`
    : `  Session summaries: none yet (the hook keeps one per session in ${crustsSessionsDir()})`));
}
