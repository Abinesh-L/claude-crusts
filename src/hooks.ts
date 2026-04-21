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
import { loadConfig, saveConfig, stripBom } from './config.ts';

/** Path to Claude Code's global settings */
const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

/** The exact command string we install for the after-response status hook */
const HOOK_COMMAND = 'claude-crusts status';

/** The exact command string we install for the auto-inject hook */
const AUTO_INJECT_HOOK_COMMAND = 'claude-crusts auto-inject';

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
    return JSON.parse(stripBom(readFileSync(path, 'utf-8'))) as Record<string, unknown>;
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
  saveConfig({
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
    saveConfig({ hooksEnabled: false });
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
  saveConfig({ hooksEnabled: false });

  console.log(chalk.yellow('  CRUSTS hooks disabled.'));
}

/**
 * Report whether CRUSTS hooks are enabled.
 *
 * Cross-references CRUSTS config.json with the actual settings.json
 * to detect manual modifications or discrepancies.
 */
export function hooksStatus(): void {
  const config = loadConfig();
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

// ---------------------------------------------------------------------------
// Auto-inject hook (UserPromptSubmit event)
// ---------------------------------------------------------------------------

/**
 * Check whether the auto-inject hook is present in settings.
 * Scoped to `UserPromptSubmit` since that's the only event we install on.
 */
function hasAutoInjectHook(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks || typeof hooks !== 'object') return false;
  const entries = hooks.UserPromptSubmit;
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    const group = entry as { hooks?: { type?: string; command?: string }[] };
    if (!Array.isArray(group.hooks)) continue;
    if (group.hooks.some((h) => h.command === AUTO_INJECT_HOOK_COMMAND)) return true;
  }
  return false;
}

/**
 * Install the auto-inject hook on `UserPromptSubmit` and flip the
 * `autoInject.enabled` flag in CRUSTS config.
 */
export function enableAutoInject(): void {
  const settings = readJson(CLAUDE_SETTINGS_PATH);

  if (hasAutoInjectHook(settings)) {
    console.log(chalk.yellow('  CRUSTS auto-inject hook is already installed.'));
    // Still ensure the config flag is on — installed without enabled is a confused state
    const cfg = loadConfig();
    const ai = (cfg.autoInject as { enabled?: boolean } | undefined) ?? {};
    saveConfig({ autoInject: { ...ai, enabled: true } });
    return;
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;
  if (!Array.isArray(hooks.UserPromptSubmit)) hooks.UserPromptSubmit = [];

  hooks.UserPromptSubmit.push({
    matcher: '',
    hooks: [{ type: 'command', command: AUTO_INJECT_HOOK_COMMAND }],
  });

  writeJson(CLAUDE_SETTINGS_PATH, settings);
  const cfg = loadConfig();
  const ai = (cfg.autoInject as { enabled?: boolean } | undefined) ?? {};
  saveConfig({
    autoInject: { ...ai, enabled: true, installedAt: new Date().toISOString() },
  });

  console.log(chalk.green('  CRUSTS auto-inject enabled.'));
  console.log(chalk.dim('  When this session\'s context crosses the threshold, CRUSTS adds a /compact focus'));
  console.log(chalk.dim('  advisory to Claude\'s next turn. Claude decides whether to act on it — CRUSTS'));
  console.log(chalk.dim('  never runs /compact directly, so your work is never auto-compacted.'));
  console.log(chalk.dim('  Defaults: threshold 70%, min-gap 5min. Override in ~/.claude-crusts/config.json under "autoInject".'));
  console.log(chalk.dim('  Disable anytime: `claude-crusts hooks auto-inject disable`.'));
}

/**
 * Remove the auto-inject hook from `UserPromptSubmit` entries and flip
 * the `autoInject.enabled` flag to false. Other UserPromptSubmit hooks
 * (installed by the user or other tools) are left intact.
 */
export function disableAutoInject(): void {
  const settings = readJson(CLAUDE_SETTINGS_PATH);

  if (!hasAutoInjectHook(settings)) {
    console.log(chalk.yellow('  CRUSTS auto-inject hook is not currently installed.'));
    const cfg = loadConfig();
    const ai = (cfg.autoInject as { enabled?: boolean } | undefined) ?? {};
    saveConfig({ autoInject: { ...ai, enabled: false } });
    return;
  }

  const hooks = settings.hooks as Record<string, unknown[]>;
  const entries = hooks.UserPromptSubmit;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const group = entry as { hooks?: { type?: string; command?: string }[] };
      if (!Array.isArray(group.hooks)) continue;
      group.hooks = group.hooks.filter((h) => h.command !== AUTO_INJECT_HOOK_COMMAND);
    }
    hooks.UserPromptSubmit = entries.filter((e) => {
      const g = e as { hooks?: unknown[] };
      return Array.isArray(g.hooks) && g.hooks.length > 0;
    });
    if (hooks.UserPromptSubmit.length === 0) delete hooks.UserPromptSubmit;
    if (Object.keys(hooks).length === 0) delete settings.hooks;
  }

  writeJson(CLAUDE_SETTINGS_PATH, settings);
  const cfg = loadConfig();
  const ai = (cfg.autoInject as { enabled?: boolean } | undefined) ?? {};
  saveConfig({ autoInject: { ...ai, enabled: false } });

  console.log(chalk.yellow('  CRUSTS auto-inject disabled.'));
}

/** Report the install + enabled state of the auto-inject hook. */
export function autoInjectStatus(): void {
  const settings = readJson(CLAUDE_SETTINGS_PATH);
  const cfg = loadConfig();
  const ai = cfg.autoInject as { enabled?: boolean; threshold?: number; minGapMs?: number; lastInjectionAt?: string } | undefined;
  const installed = hasAutoInjectHook(settings);
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
}
