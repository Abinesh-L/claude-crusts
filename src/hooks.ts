/**
 * Claude Code hook integration — opt-in auto-status after responses.
 *
 * Manages a hook entry in `~/.claude/settings.json` that runs
 * `claude-crusts status` after each assistant response. Users toggle
 * it on/off with `claude-crusts hooks enable|disable`.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import chalk from 'chalk';
import { CRUSTS_DIR } from './calibrator.ts';

/** Path to Claude Code's global settings */
const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

/** Path to CRUSTS hook state file */
const CRUSTS_CONFIG_PATH = join(CRUSTS_DIR, 'config.json');

/** The exact command string we install — used for idempotent detection */
const HOOK_COMMAND = 'claude-crusts status';

// ---------------------------------------------------------------------------
// Settings I/O helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file, returning a default on any error.
 *
 * @param path - Absolute path to the JSON file
 * @param fallback - Default value when the file is missing or corrupt
 * @returns Parsed JSON or the fallback
 */
function readJson(path: string, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (!existsSync(path)) return { ...fallback };
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return { ...fallback };
  }
}

/**
 * Write a JSON object to a file with pretty-printing.
 *
 * Creates parent directories if needed.
 *
 * @param path - Absolute path to the file
 * @param data - Object to serialize
 */
function writeJson(path: string, data: Record<string, unknown>): void {
  const dir = join(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Hook detection
// ---------------------------------------------------------------------------

/**
 * Check whether a CRUSTS hook is present in the parsed settings.
 *
 * Scans all hook event arrays for a command matching HOOK_COMMAND.
 *
 * @param settings - Parsed settings.json contents
 * @returns True if a CRUSTS hook is installed
 */
function hasCrustsHook(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks || typeof hooks !== 'object') return false;

  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const group = entry as { hooks?: { type?: string; command?: string }[] };
      if (!Array.isArray(group.hooks)) continue;
      for (const h of group.hooks) {
        if (h.command === HOOK_COMMAND) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Install a CRUSTS notification hook into Claude Code settings.
 *
 * Idempotent — skips if the hook is already present. Writes the
 * hook entry into settings.json and records the state in config.json.
 */
export function enableHooks(): void {
  const settings = readJson(CLAUDE_SETTINGS_PATH);

  if (hasCrustsHook(settings)) {
    console.log(chalk.yellow('  CRUSTS hooks are already enabled.'));
    return;
  }

  // Ensure hooks.Notification array exists
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown[]>;
  if (!Array.isArray(hooks.Notification)) {
    hooks.Notification = [];
  }

  // Append CRUSTS hook entry
  hooks.Notification.push({
    matcher: '',
    hooks: [{ type: 'command', command: HOOK_COMMAND }],
  });

  writeJson(CLAUDE_SETTINGS_PATH, settings);
  writeJson(CRUSTS_CONFIG_PATH, {
    hooksEnabled: true,
    installedAt: new Date().toISOString(),
  });

  console.log(chalk.green('  CRUSTS hooks enabled.'));
  console.log(chalk.dim('  Context health will appear after each Claude Code response.'));
  console.log(chalk.dim('  Run `claude-crusts hooks disable` to turn off.'));
}

/**
 * Remove the CRUSTS hook from Claude Code settings.
 *
 * Surgically removes only the CRUSTS entry — leaves all other hooks intact.
 * Cleans up empty arrays/objects in the hooks structure.
 */
export function disableHooks(): void {
  const settings = readJson(CLAUDE_SETTINGS_PATH);

  if (!hasCrustsHook(settings)) {
    console.log(chalk.yellow('  CRUSTS hooks are not currently enabled.'));
    writeJson(CRUSTS_CONFIG_PATH, { hooksEnabled: false });
    return;
  }

  const hooks = settings.hooks as Record<string, unknown[]>;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const group = entry as { hooks?: { type?: string; command?: string }[] };
      if (!Array.isArray(group.hooks)) continue;
      group.hooks = group.hooks.filter((h) => h.command !== HOOK_COMMAND);
    }
    // Remove entries with no hooks left
    hooks[event] = entries.filter((e) => {
      const g = e as { hooks?: unknown[] };
      return Array.isArray(g.hooks) && g.hooks.length > 0;
    });
    // Remove empty event arrays
    if (hooks[event]!.length === 0) {
      delete hooks[event];
    }
  }

  // Remove empty hooks object
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }

  writeJson(CLAUDE_SETTINGS_PATH, settings);
  writeJson(CRUSTS_CONFIG_PATH, { hooksEnabled: false });

  console.log(chalk.yellow('  CRUSTS hooks disabled.'));
}

/**
 * Report whether CRUSTS hooks are enabled.
 *
 * Cross-references CRUSTS config.json with the actual settings.json
 * to detect manual modifications or discrepancies.
 */
export function hooksStatus(): void {
  const config = readJson(CRUSTS_CONFIG_PATH);
  const settings = readJson(CLAUDE_SETTINGS_PATH);
  const actuallyInstalled = hasCrustsHook(settings);
  const configSays = config.hooksEnabled === true;

  if (actuallyInstalled && configSays) {
    console.log(chalk.green('  CRUSTS hooks: enabled'));
    console.log(chalk.dim(`  Installed at: ${config.installedAt as string ?? 'unknown'}`));
  } else if (actuallyInstalled && !configSays) {
    console.log(chalk.yellow('  CRUSTS hooks: enabled (found in settings.json, but CRUSTS config says disabled)'));
    console.log(chalk.dim('  Run `claude-crusts hooks disable` then `enable` to sync state.'));
  } else if (!actuallyInstalled && configSays) {
    console.log(chalk.yellow('  CRUSTS hooks: disabled (hook was removed from settings.json)'));
    console.log(chalk.dim('  Run `claude-crusts hooks enable` to re-install.'));
  } else {
    console.log(chalk.dim('  CRUSTS hooks: not enabled'));
    console.log(chalk.dim('  Run `claude-crusts hooks enable` to auto-show context health after responses.'));
  }
}
