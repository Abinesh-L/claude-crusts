/**
 * Claude Code statusline integration — ambient context-health glyph.
 *
 * Installs a `statusLine` entry in `~/.claude/settings.json` that runs
 * `claude-crusts statusline` on every statusline refresh. The command
 * reads Claude Code's JSON payload from stdin, classifies the active
 * session, and prints a single colored glyph + percentage.
 *
 * Three public surfaces:
 *   - installStatusline / uninstallStatusline / statuslineStatus
 *     mirror the hooks.ts API for install/uninstall/status subcommands.
 *   - renderStatusline formats an analysis breakdown into the one-line
 *     glyph output shown in Claude Code's statusline.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import chalk from 'chalk';
import { CRUSTS_DIR } from './calibrator.ts';
import { stripBom } from './config.ts';
import type { CrustsBreakdown } from './types.ts';

/** Path to Claude Code's global settings */
const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

/** Path to CRUSTS statusline state file */
const STATUSLINE_CONFIG_PATH = join(CRUSTS_DIR, 'statusline.json');

/** The exact command string we install — used for idempotent detection */
export const STATUSLINE_COMMAND = 'claude-crusts statusline';

/** Glyph rendered in the statusline — one monospace column on every terminal */
const GLYPH = '●';

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
// Statusline detection
// ---------------------------------------------------------------------------

/**
 * Check whether the CRUSTS statusline is configured in settings.
 *
 * @param settings - Parsed settings.json contents
 * @returns True if the CRUSTS statusline command is the active statusLine
 */
function hasCrustsStatusline(settings: Record<string, unknown>): boolean {
  const sl = settings.statusLine as { type?: string; command?: string } | undefined;
  if (!sl || typeof sl !== 'object') return false;
  return sl.command === STATUSLINE_COMMAND;
}

// ---------------------------------------------------------------------------
// Install / uninstall / status
// ---------------------------------------------------------------------------

/**
 * Install the CRUSTS statusline into Claude Code settings.
 *
 * Idempotent — skips if already installed. Warns and aborts if a
 * different statusLine command is already configured, to avoid
 * clobbering the user's own setup.
 */
export function installStatusline(): void {
  const settings = readJson(CLAUDE_SETTINGS_PATH);

  if (hasCrustsStatusline(settings)) {
    console.log(chalk.yellow('  CRUSTS statusline is already installed.'));
    return;
  }

  const existing = settings.statusLine as { command?: string } | undefined;
  if (existing && typeof existing === 'object' && existing.command) {
    console.log(chalk.red(`  A different statusLine is already configured: ${existing.command}`));
    console.log(chalk.dim('  Remove it manually from ~/.claude/settings.json before installing CRUSTS.'));
    return;
  }

  settings.statusLine = {
    type: 'command',
    command: STATUSLINE_COMMAND,
    padding: 0,
  };

  writeJson(CLAUDE_SETTINGS_PATH, settings);
  writeJson(STATUSLINE_CONFIG_PATH, {
    installed: true,
    installedAt: new Date().toISOString(),
  });

  console.log(chalk.green('  CRUSTS statusline installed.'));
  console.log(chalk.dim('  A one-character context-health glyph will appear in your Claude Code statusline.'));
  console.log(chalk.dim('  Run `claude-crusts statusline uninstall` to remove.'));
}

/**
 * Remove the CRUSTS statusline entry from Claude Code settings.
 *
 * Only removes the entry if its command matches ours — never clobbers
 * a user-configured statusLine that has replaced CRUSTS.
 */
export function uninstallStatusline(): void {
  const settings = readJson(CLAUDE_SETTINGS_PATH);

  if (!hasCrustsStatusline(settings)) {
    console.log(chalk.yellow('  CRUSTS statusline is not currently installed.'));
    writeJson(STATUSLINE_CONFIG_PATH, { installed: false });
    return;
  }

  delete settings.statusLine;
  writeJson(CLAUDE_SETTINGS_PATH, settings);
  writeJson(STATUSLINE_CONFIG_PATH, { installed: false });

  console.log(chalk.yellow('  CRUSTS statusline removed.'));
}

/**
 * Report whether the CRUSTS statusline is installed.
 *
 * Cross-references the local config file with the actual settings.json
 * contents to detect manual modifications.
 */
export function statuslineStatus(): void {
  const config = readJson(STATUSLINE_CONFIG_PATH);
  const settings = readJson(CLAUDE_SETTINGS_PATH);
  const actuallyInstalled = hasCrustsStatusline(settings);
  const configSays = config.installed === true;

  if (actuallyInstalled && configSays) {
    console.log(chalk.green('  CRUSTS statusline: installed'));
    console.log(chalk.dim(`  Installed at: ${(config.installedAt as string) ?? 'unknown'}`));
  } else if (actuallyInstalled && !configSays) {
    console.log(chalk.yellow('  CRUSTS statusline: installed (found in settings.json, but CRUSTS config says not installed)'));
    console.log(chalk.dim('  Run `claude-crusts statusline uninstall` then `install` to sync state.'));
  } else if (!actuallyInstalled && configSays) {
    console.log(chalk.yellow('  CRUSTS statusline: not installed (entry was removed from settings.json)'));
    console.log(chalk.dim('  Run `claude-crusts statusline install` to re-install.'));
  } else {
    console.log(chalk.dim('  CRUSTS statusline: not installed'));
    console.log(chalk.dim('  Run `claude-crusts statusline install` to show context health in your statusline.'));
  }
}

// ---------------------------------------------------------------------------
// Runtime rendering
// ---------------------------------------------------------------------------

/**
 * Format a breakdown into the one-line statusline string.
 *
 * Output is a single colored glyph + percentage (e.g. `● 42%`). The
 * glyph colour tracks the same HEALTH_THRESHOLDS used by the `status`
 * command: green <50, yellow <70, red <85, bgRed ≥85.
 *
 * @param breakdown - Classification result for the active session
 * @returns ANSI-coloured one-line string
 */
export function renderStatusline(breakdown: CrustsBreakdown): string {
  const pct = breakdown.currentContext?.usage_percentage ?? breakdown.usage_percentage;
  const color =
    pct < 50 ? chalk.green :
    pct < 70 ? chalk.yellow :
    pct < 85 ? chalk.red :
    chalk.bgRed.white;
  return color(`${GLYPH} ${pct.toFixed(0)}%`);
}

/**
 * Read Claude Code's statusline JSON payload from stdin.
 *
 * Claude Code pipes a JSON object to the statusline command's stdin
 * containing `session_id`, `transcript_path`, `cwd`, `model`, etc.
 * Returns null if stdin is empty or malformed, so the caller can fall
 * back to session auto-resolution.
 *
 * @returns Parsed payload or null
 */
export async function readStatuslinePayload(): Promise<StatuslinePayload | null> {
  if (process.stdin.isTTY) return null;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) return null;
    return JSON.parse(raw) as StatuslinePayload;
  } catch {
    return null;
  }
}

/** Subset of Claude Code's statusline stdin payload we use */
export interface StatuslinePayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  workspace?: { current_dir?: string };
  model?: { id?: string; display_name?: string };
}
