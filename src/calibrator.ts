/**
 * /context output parser for ground truth calibration.
 *
 * Parses the output of Claude Code's /context command to extract
 * exact token totals per bucket. Saves calibration data so future
 * analyses can show accuracy comparisons.
 *
 * Expected /context output format (approximate):
 *   System prompt:  11,200 tokens
 *   System tools:   14,600 tokens
 *   Custom agents:   0 tokens
 *   Memory files:    800 tokens
 *   MCP tools:       0 tokens
 *   Messages:       98,000 tokens
 *   Free space:     74,400 tokens
 *   Total:         200,000 tokens
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createInterface } from 'readline';
import chalk from 'chalk';
import Table from 'cli-table3';
import type {
  CalibrationData,
  CalibrationComparison,
  CrustsBreakdown,
} from './types.ts';
import { TOTAL_BUILTIN_TOOL_TOKENS } from './built-in-tools.ts';

/** Directory where CRUSTS stores its own data */
export const CRUSTS_DIR = join(homedir(), '.claude-crusts');

/** Path to saved calibration data */
const CALIBRATION_PATH = join(CRUSTS_DIR, 'calibration.json');

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a token count from a line like "System prompt:  11,200 tokens".
 *
 * Handles comma-separated numbers, optional "tokens" suffix, and
 * various whitespace patterns.
 *
 * @param line - A single line from /context output
 * @returns Parsed token count, or null if the line doesn't match
 */
function parseTokenLine(line: string): { label: string; tokens: number } | null {
  // Match patterns like "  System prompt:  11,200 tokens" or "System prompt: 11200"
  const match = line.match(/^\s*([^:]+):\s*([\d,]+)\s*(?:tokens?)?\s*$/i);
  if (!match) return null;

  const label = match[1]!.trim().toLowerCase();
  const tokens = parseInt(match[2]!.replace(/,/g, ''), 10);
  if (isNaN(tokens)) return null;

  return { label, tokens };
}

/**
 * Parse the full /context output into structured calibration data.
 *
 * Looks for known bucket labels and extracts their token counts.
 * Unknown lines are silently skipped.
 *
 * @param output - The raw /context output text
 * @returns Parsed CalibrationData, or null if parsing fails
 */
export function parseContextOutput(output: string): CalibrationData | null {
  const lines = output.split('\n');
  const parsed: Record<string, number> = {};

  for (const line of lines) {
    const result = parseTokenLine(line);
    if (result) {
      parsed[result.label] = result.tokens;
    }
  }

  // Try to find known buckets with flexible key matching
  const find = (keys: string[]): number =>
    keys.reduce((found, key) => {
      if (found > 0) return found;
      for (const [k, v] of Object.entries(parsed)) {
        if (k.includes(key)) return v;
      }
      return 0;
    }, 0);

  const buckets = {
    system_prompt: find(['system prompt', 'system instructions']),
    system_tools: find(['system tool', 'built-in tool', 'tools']),
    custom_agents: find(['custom agent', 'agent']),
    memory_files: find(['memory file', 'memory', 'memdir']),
    mcp_tools: find(['mcp tool', 'mcp']),
    messages: find(['message', 'conversation']),
    free_space: find(['free space', 'free', 'remaining', 'available']),
  };

  const totalUsed = buckets.system_prompt + buckets.system_tools
    + buckets.custom_agents + buckets.memory_files
    + buckets.mcp_tools + buckets.messages;

  // If we didn't parse anything useful, return null
  if (totalUsed === 0 && buckets.free_space === 0) {
    return null;
  }

  const totalCapacity = find(['total', 'capacity', 'context window']);

  return {
    timestamp: new Date().toISOString(),
    buckets,
    total_used: totalUsed,
    total_capacity: totalCapacity || (totalUsed + buckets.free_space),
    raw_output: output,
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Save calibration data to ~/.claude-crusts/calibration.json.
 *
 * Creates the ~/.claude-crusts/ directory if it doesn't exist.
 *
 * @param data - The calibration data to save
 */
export function saveCalibration(data: CalibrationData): void {
  if (!existsSync(CRUSTS_DIR)) {
    mkdirSync(CRUSTS_DIR, { recursive: true });
  }
  writeFileSync(CALIBRATION_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Load saved calibration data.
 *
 * @returns CalibrationData if available, or null
 */
export function loadCalibration(): CalibrationData | null {
  if (!existsSync(CALIBRATION_PATH)) return null;

  try {
    const content = readFileSync(CALIBRATION_PATH, 'utf-8');
    return JSON.parse(content) as CalibrationData;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Compare CRUSTS estimates against /context ground truth.
 *
 * Maps CRUSTS categories to /context buckets and calculates the
 * percentage delta for each.
 *
 * @param breakdown - The CRUSTS analysis breakdown
 * @param calibration - The /context calibration data
 * @returns Array of per-category comparisons
 */
export function compareWithEstimates(
  breakdown: CrustsBreakdown,
  calibration: CalibrationData,
): CalibrationComparison[] {
  const comparisons: CalibrationComparison[] = [];

  const crustsSystem = breakdown.buckets.find((b) => b.category === 'system')?.tokens ?? 0;
  const crustsTools = breakdown.buckets.find((b) => b.category === 'tools')?.tokens ?? 0;
  const crustsState = breakdown.buckets.find((b) => b.category === 'state')?.tokens ?? 0;
  const crustsConvo = breakdown.buckets.find((b) => b.category === 'conversation')?.tokens ?? 0;
  const crustsRetrieved = breakdown.buckets.find((b) => b.category === 'retrieved')?.tokens ?? 0;
  const crustsUser = breakdown.buckets.find((b) => b.category === 'user')?.tokens ?? 0;
  const crustsMessages = crustsConvo + crustsRetrieved + crustsUser;

  const cal = calibration.buckets;

  const add = (category: string, estimate: number, actual: number) => {
    if (actual > 0 || estimate > 0) {
      const delta = actual > 0 ? ((estimate - actual) / actual) * 100 : 0;
      comparisons.push({ category, crustsEstimate: estimate, contextActual: actual, deltaPercent: delta });
    }
  };

  add('System prompt', crustsSystem, cal.system_prompt);
  add('Tools', crustsTools, cal.system_tools + cal.mcp_tools);
  add('Messages', crustsMessages, cal.messages);
  add('Memory', crustsState, cal.memory_files);
  if (cal.custom_agents > 0) {
    add('Custom agents', 0, cal.custom_agents);
  }

  return comparisons;
}

// ---------------------------------------------------------------------------
// Interactive calibration flow
// ---------------------------------------------------------------------------

/**
 * Run the interactive calibration flow.
 *
 * Prompts the user to paste /context output, parses it, saves the
 * calibration data, and reports the result.
 */
export async function runCalibration(): Promise<void> {
  console.log(chalk.bold('\n  CRUSTS Calibration\n'));
  console.log('  Run /context in your Claude Code session, then paste the output below.');
  console.log('  Press Enter twice (empty line) when done.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];
  let emptyCount = 0;

  const output = await new Promise<string>((resolve) => {
    rl.on('line', (line) => {
      if (line.trim() === '') {
        emptyCount++;
        if (emptyCount >= 1 && lines.length > 0) {
          rl.close();
          resolve(lines.join('\n'));
          return;
        }
      } else {
        emptyCount = 0;
        lines.push(line);
      }
    });

    rl.on('close', () => {
      resolve(lines.join('\n'));
    });
  });

  if (lines.length === 0) {
    console.error(chalk.red('\n  No input received. Calibration cancelled.\n'));
    return;
  }

  const data = parseContextOutput(output);
  if (!data) {
    console.error(chalk.red('\n  Could not parse /context output. Expected format:'));
    console.error(chalk.dim('    System prompt:  11,200 tokens'));
    console.error(chalk.dim('    System tools:   14,600 tokens'));
    console.error(chalk.dim('    Messages:       98,000 tokens'));
    console.error(chalk.dim('    Free space:     74,400 tokens\n'));
    return;
  }

  saveCalibration(data);

  console.log(chalk.green('\n  Calibration saved successfully.\n'));

  const table = new Table({
    head: [chalk.dim('Bucket'), chalk.dim('Tokens')],
    style: { head: [], border: [] },
  });

  const b = data.buckets;
  if (b.system_prompt > 0) table.push(['System prompt', b.system_prompt.toLocaleString()]);
  if (b.system_tools > 0) table.push(['System tools', b.system_tools.toLocaleString()]);
  if (b.custom_agents > 0) table.push(['Custom agents', b.custom_agents.toLocaleString()]);
  if (b.memory_files > 0) table.push(['Memory files', b.memory_files.toLocaleString()]);
  if (b.mcp_tools > 0) table.push(['MCP tools', b.mcp_tools.toLocaleString()]);
  if (b.messages > 0) table.push(['Messages', b.messages.toLocaleString()]);
  if (b.free_space > 0) table.push(['Free space', b.free_space.toLocaleString()]);
  table.push([chalk.bold('Total'), chalk.bold(data.total_capacity.toLocaleString())]);

  console.log(table.toString());

  // MCP assumption check — warn immediately on calibration, not just on later analyze.
  if (b.mcp_tools > 0) {
    console.log();
    console.log(chalk.yellow(`  !  MCP tools baseline looks wrong:`));
    console.log(chalk.dim(`     MCP_TOKENS_PER_TOOL = 0 (assumed on-demand load)`));
    console.log(chalk.dim(`     /context MCP tools  = ${b.mcp_tools.toLocaleString()}`));
    console.log(chalk.dim(`     Claude Code on this install costs real tokens for MCP schemas.`));
    console.log(chalk.dim(`     Update MCP_TOKENS_PER_TOOL in src/scanner.ts based on per-server measurement.`));
  }

  console.log(chalk.dim('\n  Future analyses will show accuracy comparison against this data.\n'));
}

/**
 * Render the calibration comparison table.
 *
 * @param comparisons - Array of per-category comparisons
 */
export function renderCalibrationComparison(comparisons: CalibrationComparison[]): void {
  if (comparisons.length === 0) return;

  console.log(chalk.bold('\n  CALIBRATION COMPARISON:'));

  const table = new Table({
    head: [
      chalk.dim('Category'),
      chalk.dim('CRUSTS Est.'),
      chalk.dim('/context Actual'),
      chalk.dim('Delta'),
    ],
    style: { head: [], border: [] },
    colWidths: [18, 14, 16, 10],
  });

  let totalEst = 0;
  let totalActual = 0;

  for (const c of comparisons) {
    const deltaStr = c.contextActual > 0
      ? (c.deltaPercent > 0 ? chalk.yellow(`+${c.deltaPercent.toFixed(1)}%`) : chalk.green(`${c.deltaPercent.toFixed(1)}%`))
      : chalk.dim('n/a');

    table.push([
      c.category,
      c.crustsEstimate.toLocaleString(),
      c.contextActual.toLocaleString(),
      deltaStr,
    ]);

    totalEst += c.crustsEstimate;
    totalActual += c.contextActual;
  }

  console.log(table.toString());

  if (totalActual > 0) {
    const overallAccuracy = 100 - Math.abs(((totalEst - totalActual) / totalActual) * 100);
    const accColor = overallAccuracy >= 90 ? chalk.green : overallAccuracy >= 75 ? chalk.yellow : chalk.red;
    console.log(`  Overall accuracy: ${accColor(overallAccuracy.toFixed(1) + '%')}`);
  }

  // Built-in tool schema baseline check: if /context's "System tools"
  // diverges from our constant by >5%, the per-tool estimates in
  // built-in-tools.ts are stale and should be updated.
  const toolsRow = comparisons.find((c) => c.category === 'Tools');
  if (toolsRow && toolsRow.contextActual > 0) {
    const delta = ((TOTAL_BUILTIN_TOOL_TOKENS - toolsRow.contextActual) / toolsRow.contextActual) * 100;
    if (Math.abs(delta) > 5) {
      console.log();
      console.log(chalk.yellow(`  !  Built-in tool baseline looks stale:`));
      console.log(chalk.dim(`     TOTAL_BUILTIN_TOOL_TOKENS = ${TOTAL_BUILTIN_TOOL_TOKENS.toLocaleString()}`));
      console.log(chalk.dim(`     /context System tools     = ${toolsRow.contextActual.toLocaleString()}`));
      console.log(chalk.dim(`     Delta: ${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`));
      console.log(chalk.dim(`     Update per-tool estimates in src/built-in-tools.ts`));
    }
  }

  console.log();
}
