/**
 * /context output parser for ground truth calibration.
 *
 * Parses the output of Claude Code's /context command to extract
 * exact token totals per bucket. Saves calibration data so future
 * analyses can show accuracy comparisons.
 *
 * Two output formats are understood:
 *
 * Current (Claude Code 2.1.150+), a markdown document:
 *   ## Context Usage
 *   **Model:** claude-opus-5
 *   **Tokens:** 419.2k / 1m (42%)
 *   ### Estimated usage by category
 *   | Category | Tokens | Percentage |
 *   | System prompt | 4.1k | 0.4% |
 *   | System tools | 21.1k | 2.1% |
 *   | MCP tools (deferred) | 23.4k | 2.3% |
 *   | System tools (deferred) | 16.2k | 1.6% |
 *   | Messages | 376.9k | 37.7% |
 *   | Free space | 580.8k | 58.1% |
 *   | Autocompact buffer | 33k | 3.3% |
 *   (followed by per-tool / memory / skills sub-tables that are ignored)
 *
 * Legacy (colon format):
 *   System prompt:  11,200 tokens
 *   System tools:   14,600 tokens
 *   Messages:       98,000 tokens
 *   Free space:     74,400 tokens
 *   Total:         200,000 tokens
 *
 * Rows tagged "(deferred)" list schemas that are NOT loaded into the
 * window and the autocompact buffer is reserved headroom; neither is
 * counted in `total_used`. The "System tools" row is persisted as the
 * core tool-schema override so the classifier can pin its fixed cost to
 * ground truth instead of a version-keyed constant.
 */

import { homedir } from 'os';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createInterface } from 'readline';
import chalk from 'chalk';
import Table from 'cli-table3';
import type {
  CalibrationBuckets,
  CalibrationData,
  CalibrationComparison,
  CrustsBreakdown,
} from './types.ts';
import { lookupCoreSchemaTokens } from './built-in-tools.ts';

/** Directory where CRUSTS stores its own data */
export const CRUSTS_DIR = join(homedir(), '.claude-crusts');

/**
 * Resolve the calibration file path.
 *
 * Respects the `CRUSTS_CALIBRATION_DIR_OVERRIDE` env var as an escape hatch
 * for tests that must sandbox writes away from the developer's real
 * `~/.claude-crusts/calibration.json`. Production never sets this.
 *
 * @returns Absolute path to calibration.json
 */
function calibrationPath(): string {
  const override = process.env.CRUSTS_CALIBRATION_DIR_OVERRIDE;
  const dir = override && override.length > 0 ? override : CRUSTS_DIR;
  return join(dir, 'calibration.json');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A token figure as printed by /context: `11,200`, `21.1k`, `1m`, `~120` */
const FIGURE_SOURCE = '~?\\d[\\d,]*(?:\\.\\d+)?\\s*[km]?';
/** Strict full-string figure matcher (for validating a table cell) */
const FIGURE_EXACT = /^~?(\d[\d,]*(?:\.\d+)?)\s*([km])?$/i;
/** `**Tokens:** 419.2k / 1m (42%)`, also `Total: 419.2k / 1m` */
const TOKENS_HEADER = new RegExp(
  '^\\s*\\**\\s*(?:tokens|total|context(?: window)?)\\s*\\**\\s*:?\\s*\\**\\s*'
  + `(${FIGURE_SOURCE})\\s*(?:tokens?)?\\s*/\\s*(${FIGURE_SOURCE})`,
  'i',
);
/** Legacy `Label: 11,200 tokens` row (label may not contain a colon or pipe) */
const COLON_ROW = new RegExp(
  `^\\s*([^:|]+?)\\s*:\\s*\\**\\s*(${FIGURE_SOURCE})\\s*(?:tokens?)?\\s*$`,
  'i',
);
/** Markdown row: first two cells */
const TABLE_ROW = /^\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/;

/**
 * Parse a token figure with an optional k/m suffix.
 *
 * `21.1k` -> 21,100; `1m` -> 1,000,000; `11,200` -> 11,200; `~120` -> 120.
 * Values are rounded to whole tokens.
 *
 * @param raw - The figure text, with or without surrounding whitespace
 * @returns Token count, or null if the text is not a figure
 */
export function parseTokenFigure(raw: string): number | null {
  const match = raw.trim().replace(/\s*tokens?$/i, '').match(FIGURE_EXACT);
  if (!match) return null;
  const base = parseFloat(match[1]!.replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const suffix = (match[2] ?? '').toLowerCase();
  const multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1;
  return Math.round(base * multiplier);
}

/**
 * Normalise a bucket label for matching: strip markdown emphasis, lowercase,
 * collapse whitespace.
 *
 * @param label - Raw label text
 * @returns Normalised label
 */
function normalizeLabel(label: string): string {
  return label.replace(/\*/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Parse a bucket row from either format.
 *
 * Markdown: `| System tools | 21.1k | 2.1% |` (the second cell must be a
 * bare figure, so the per-tool / memory / skills sub-tables whose second
 * column is a server, path, or source never match).
 * Legacy: `System prompt:  11,200 tokens` or `Skills: 5k`.
 *
 * @param line - A single line from /context output
 * @returns Normalised label and token count, or null if the line is not a row
 */
function parseTokenLine(line: string): { label: string; tokens: number } | null {
  const row = line.match(TABLE_ROW);
  if (row) {
    const tokens = parseTokenFigure(row[2]!);
    if (tokens === null) return null;
    return { label: normalizeLabel(row[1]!), tokens };
  }

  const colon = line.match(COLON_ROW);
  if (!colon) return null;
  const tokens = parseTokenFigure(colon[2]!);
  if (tokens === null) return null;
  return { label: normalizeLabel(colon[1]!), tokens };
}

/**
 * Parse the `**Tokens:** 419.2k / 1m (42%)` header line.
 *
 * @param line - A single line from /context output
 * @returns Used and window token counts, or null if the line is not the header
 */
function parseTokensHeaderLine(line: string): { used: number; window: number } | null {
  const match = line.match(TOKENS_HEADER);
  if (!match) return null;
  const used = parseTokenFigure(match[1]!);
  const window = parseTokenFigure(match[2]!);
  if (used === null || window === null || window <= 0) return null;
  return { used, window };
}

/**
 * Find the `**Tokens:** used / window` header anywhere in a /context block.
 *
 * Exposed so the context-limit resolver can read the window size straight
 * from a transcript's `## Context Usage` record without a calibration paste.
 *
 * @param text - Full /context output (or any text containing the header)
 * @returns Used and window token counts, or null if no header is present
 */
export function parseTokensHeader(text: string): { used: number; window: number } | null {
  for (const line of text.split('\n')) {
    const parsed = parseTokensHeaderLine(line);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Convenience wrapper: the context window size a /context block reports.
 *
 * @param text - Full /context output
 * @returns Window size in tokens (e.g. 200,000 / 500,000 / 1,000,000), or null
 */
export function parseContextWindowSize(text: string): number | null {
  return parseTokensHeader(text)?.window ?? null;
}

/**
 * Parse the `**Model:** claude-opus-5` header.
 *
 * @param text - Full /context output
 * @returns Model id as printed (a `[1m]` suffix is retained), or null
 */
function parseModelHeader(text: string): string | null {
  const match = text.match(/^\s*\**\s*model\s*\**\s*:\s*\**\s*(\S+)/im);
  return match ? match[1]!.replace(/\*+$/, '') : null;
}

/**
 * Restrict bucket parsing to the "Estimated usage by category" section when
 * the markdown format is detected, so the per-tool, memory-file, and skills
 * sub-tables that follow cannot be mistaken for bucket rows. Output without
 * that heading (legacy colon format, or a bare pasted table) is returned
 * unchanged.
 *
 * @param output - Full /context output
 * @returns The text region that holds the bucket rows
 */
function extractCategorySection(output: string): string {
  const heading = output.match(/^#{2,4}\s*estimated usage by category.*$/im);
  if (!heading || heading.index === undefined) return output;
  const rest = output.slice(heading.index + heading[0].length);
  const next = rest.search(/^#{1,4}\s/m);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * Build an all-zero bucket set.
 *
 * @returns Fresh CalibrationBuckets with every field at 0
 */
function emptyBuckets(): CalibrationBuckets {
  return {
    system_prompt: 0,
    system_tools: 0,
    custom_agents: 0,
    memory_files: 0,
    mcp_tools: 0,
    messages: 0,
    free_space: 0,
    skills: 0,
    system_tools_deferred: 0,
    mcp_tools_deferred: 0,
    autocompact_buffer: 0,
  };
}

/**
 * Sum the rows that /context counts inside the window.
 *
 * @param b - Bucket set
 * @returns In-window total (deferred rows and the buffer excluded)
 */
function sumInWindow(b: CalibrationBuckets): number {
  return b.system_prompt + b.system_tools + b.custom_agents
    + b.memory_files + b.mcp_tools + b.skills + b.messages;
}

/**
 * Bucket matching rules, applied in order. Each parsed label is claimed by
 * at most one bucket, so the specific rows (deferred, buffer, MCP) are
 * consumed before the broad substring keys (`tools`, `agent`, `memory`) get
 * a chance to swallow them.
 */
const BUCKET_RULES: ReadonlyArray<{
  bucket: keyof CalibrationBuckets | 'total';
  exact?: string[];
  contains?: string[];
}> = [
  { bucket: 'system_tools_deferred', exact: ['system tools (deferred)', 'built-in tools (deferred)'] },
  { bucket: 'mcp_tools_deferred', exact: ['mcp tools (deferred)'] },
  { bucket: 'autocompact_buffer', exact: ['autocompact buffer', 'auto-compact buffer', 'compact buffer'] },
  { bucket: 'skills', exact: ['skills', 'skill'] },
  { bucket: 'system_prompt', contains: ['system prompt', 'system instructions'] },
  { bucket: 'mcp_tools', contains: ['mcp tool', 'mcp'] },
  { bucket: 'system_tools', contains: ['system tool', 'built-in tool', 'builtin tool', 'tools'] },
  { bucket: 'custom_agents', contains: ['custom agent', 'agent'] },
  { bucket: 'memory_files', contains: ['memory file', 'memory', 'memdir'] },
  { bucket: 'messages', contains: ['message', 'conversation'] },
  { bucket: 'free_space', contains: ['free space', 'free', 'remaining', 'available'] },
  { bucket: 'total', contains: ['total', 'capacity', 'context window'] },
];

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
  const header = parseTokensHeader(output);
  const model = parseModelHeader(output);

  // Ordered label -> tokens map (first occurrence wins).
  const parsed = new Map<string, number>();
  for (const line of extractCategorySection(output).split('\n')) {
    if (parseTokensHeaderLine(line)) continue;
    const result = parseTokenLine(line);
    if (result && !parsed.has(result.label)) {
      parsed.set(result.label, result.tokens);
    }
  }

  const buckets = emptyBuckets();
  let totalLine = 0;
  const claimed = new Set<string>();

  const claimFirst = (predicate: (label: string) => boolean): number | null => {
    for (const [label, tokens] of parsed) {
      if (!claimed.has(label) && predicate(label)) {
        claimed.add(label);
        return tokens;
      }
    }
    return null;
  };

  for (const rule of BUCKET_RULES) {
    let value: number | null = null;
    for (const key of rule.exact ?? []) {
      value = claimFirst((label) => label === key);
      if (value !== null) break;
    }
    if (value === null) {
      for (const key of rule.contains ?? []) {
        // A generic key never claims a deferred row; those are handled by
        // the exact rules above (or ignored if unrecognised).
        value = claimFirst((label) => !label.includes('(deferred)') && label.includes(key));
        if (value !== null) break;
      }
    }
    if (value === null) continue;
    if (rule.bucket === 'total') totalLine = value;
    else buckets[rule.bucket] = value;
  }

  const totalUsed = sumInWindow(buckets);
  const deferredSeen = buckets.system_tools_deferred > 0 || buckets.mcp_tools_deferred > 0;

  // If we didn't parse anything useful, return null
  if (totalUsed === 0 && buckets.free_space === 0 && header === null && !deferredSeen) {
    return null;
  }

  const totalCapacity = header?.window
    ?? (totalLine > 0 ? totalLine : totalUsed + buckets.free_space + buckets.autocompact_buffer);

  return {
    timestamp: new Date().toISOString(),
    buckets,
    total_used: totalUsed,
    total_capacity: totalCapacity,
    window_size: header?.window ?? null,
    reported_used: header?.used ?? null,
    model,
    core_schema_tokens_override: buckets.system_tools > 0 ? buckets.system_tools : null,
    raw_output: output,
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Save calibration data to ~/.claude-crusts/calibration.json.
 *
 * Creates the directory if it doesn't exist.
 *
 * @param data - The calibration data to save
 */
export function saveCalibration(data: CalibrationData): void {
  const path = calibrationPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Coerce a stored calibration (possibly written by an older release that
 * lacked the 0.8.0 fields) into the current shape so consumers never see
 * `undefined` buckets.
 *
 * @param raw - Parsed JSON of unknown vintage
 * @returns Normalised CalibrationData, or null if the payload is not a calibration
 */
function normalizeCalibration(raw: unknown): CalibrationData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const rawBuckets = typeof obj.buckets === 'object' && obj.buckets !== null
    ? obj.buckets as Record<string, unknown>
    : {};
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  const buckets = emptyBuckets();
  for (const key of Object.keys(buckets) as Array<keyof CalibrationBuckets>) {
    buckets[key] = num(rawBuckets[key]) ?? 0;
  }
  const totalUsed = num(obj.total_used) ?? sumInWindow(buckets);

  return {
    timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : 'unknown',
    buckets,
    total_used: totalUsed,
    total_capacity: num(obj.total_capacity) ?? totalUsed + buckets.free_space,
    window_size: num(obj.window_size),
    reported_used: num(obj.reported_used),
    model: typeof obj.model === 'string' ? obj.model : null,
    core_schema_tokens_override: num(obj.core_schema_tokens_override)
      ?? (buckets.system_tools > 0 ? buckets.system_tools : null),
    raw_output: typeof obj.raw_output === 'string' ? obj.raw_output : '',
  };
}

/**
 * Load saved calibration data.
 *
 * @returns CalibrationData if available, or null
 */
export function loadCalibration(): CalibrationData | null {
  const path = calibrationPath();
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, 'utf-8');
    return normalizeCalibration(JSON.parse(content));
  } catch {
    return null;
  }
}

/**
 * The core tool-schema token cost pinned by the last calibration, if any.
 *
 * This is the /context "System tools" row (loaded schemas only; deferred
 * schemas are excluded). Consumers should prefer it over any version-keyed
 * constant.
 *
 * @returns Pinned token count, or null when no calibration carries one
 */
export function loadCoreSchemaOverride(): number | null {
  const data = loadCalibration();
  if (!data) return null;
  const value = data.core_schema_tokens_override;
  return value !== null && value > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Compare CRUSTS estimates against /context ground truth.
 *
 * Maps CRUSTS categories to /context buckets and calculates the
 * percentage delta for each. Deferred rows are not loaded, so the Tools
 * comparison uses `system_tools + mcp_tools` only.
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
 * Collect a pasted block from a line stream.
 *
 * The /context markdown contains single blank lines between its sections,
 * so a single empty line cannot terminate input. The block ends on two
 * consecutive empty lines after at least one non-empty line, or on stream
 * close. Trailing blank lines are trimmed.
 *
 * @param input - Readable stream to consume (stdin in production)
 * @param output - Optional writable for readline echo (stdout in production)
 * @returns The pasted text joined with newlines
 */
export function readPastedBlock(
  input: NodeJS.ReadableStream,
  output?: NodeJS.WritableStream,
): Promise<string> {
  const rl = createInterface(output ? { input, output } : { input });
  const lines: string[] = [];
  let emptyCount = 0;
  let settled = false;

  return new Promise<string>((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
      resolve(lines.join('\n'));
    };

    rl.on('line', (line) => {
      if (settled) return;
      if (line.trim() === '') {
        emptyCount++;
        if (emptyCount >= 2 && lines.some((l) => l.trim() !== '')) {
          rl.close();
          finish();
          return;
        }
        if (lines.length > 0) lines.push('');
      } else {
        emptyCount = 0;
        lines.push(line);
      }
    });

    rl.on('close', finish);
  });
}

/**
 * Run the interactive calibration flow.
 *
 * Prompts the user to paste /context output, parses it, saves the
 * calibration data, and reports the result.
 */
export async function runCalibration(): Promise<void> {
  console.log(chalk.bold('\n  CRUSTS Calibration\n'));
  console.log('  Run /context in your Claude Code session, then paste the output below.');
  console.log('  Press Enter twice (two empty lines) when done.\n');

  const output = await readPastedBlock(process.stdin, process.stdout);

  if (output.trim().length === 0) {
    console.error(chalk.red('\n  No input received. Calibration cancelled.\n'));
    return;
  }

  const data = parseContextOutput(output);
  if (!data) {
    console.error(chalk.red('\n  Could not parse /context output. Expected either the /context table:'));
    console.error(chalk.dim('    **Tokens:** 419.2k / 1m (42%)'));
    console.error(chalk.dim('    | System prompt | 4.1k | 0.4% |'));
    console.error(chalk.dim('    | System tools | 21.1k | 2.1% |'));
    console.error(chalk.dim('    | Messages | 376.9k | 37.7% |'));
    console.error(chalk.dim('  or the legacy colon format:'));
    console.error(chalk.dim('    System prompt:  11,200 tokens'));
    console.error(chalk.dim('    Messages:       98,000 tokens\n'));
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
  if (b.skills > 0) table.push(['Skills', b.skills.toLocaleString()]);
  if (b.messages > 0) table.push(['Messages', b.messages.toLocaleString()]);
  if (b.free_space > 0) table.push(['Free space', b.free_space.toLocaleString()]);
  if (b.autocompact_buffer > 0) {
    table.push([chalk.dim('Autocompact buffer (reserved)'), chalk.dim(b.autocompact_buffer.toLocaleString())]);
  }
  if (b.system_tools_deferred > 0) {
    table.push([chalk.dim('System tools (deferred, not loaded)'), chalk.dim(b.system_tools_deferred.toLocaleString())]);
  }
  if (b.mcp_tools_deferred > 0) {
    table.push([chalk.dim('MCP tools (deferred, not loaded)'), chalk.dim(b.mcp_tools_deferred.toLocaleString())]);
  }
  table.push([chalk.bold('Used (in window)'), chalk.bold(data.total_used.toLocaleString())]);
  table.push([chalk.bold('Window'), chalk.bold(data.total_capacity.toLocaleString())]);

  console.log(table.toString());

  if (data.model) {
    console.log(chalk.dim(`\n  Model: ${data.model}`));
  }

  if (data.core_schema_tokens_override !== null) {
    console.log();
    console.log(chalk.dim(`  Core tool-schema cost pinned to ${data.core_schema_tokens_override.toLocaleString()} tokens`));
    console.log(chalk.dim('  (the /context "System tools" row; deferred schemas excluded).'));
  }

  // Loaded MCP schemas cost real tokens; deferred ones do not. Report the
  // loaded figure so the user knows what the comparison is measured against.
  if (b.mcp_tools > 0) {
    console.log();
    console.log(chalk.yellow(`  !  /context reports ${b.mcp_tools.toLocaleString()} tokens of loaded MCP tool schemas.`));
    console.log(chalk.dim(`     Deferred MCP schemas (${b.mcp_tools_deferred.toLocaleString()} tokens) stay outside the window until ToolSearch loads them.`));
  }

  console.log(chalk.dim('\n  Future analyses will show accuracy comparison against this data.\n'));
}

/**
 * Render the calibration comparison table.
 *
 * @param comparisons - Array of per-category comparisons
 */
export function renderCalibrationComparison(
  comparisons: CalibrationComparison[],
  breakdown?: CrustsBreakdown,
): void {
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

  // Core tool schema table check: the analysis already uses the pinned
  // /context "System tools" value when one is saved. If the version-keyed
  // table in built-in-tools.ts disagrees with it by >5%, the table is stale
  // for this Claude Code version and a new band should be added.
  const tb = breakdown?.toolBreakdown;
  if (tb && tb.coreSchemaSource === 'calibration' && tb.coreSchemaTokens > 0) {
    const tableTokens = lookupCoreSchemaTokens(breakdown?.claudeCodeVersion);
    const delta = ((tableTokens - tb.coreSchemaTokens) / tb.coreSchemaTokens) * 100;
    if (Math.abs(delta) > 5) {
      const version = breakdown?.claudeCodeVersion ?? 'unknown version';
      console.log();
      console.log(chalk.yellow(`  !  Core tool schema table looks stale for Claude Code ${version}:`));
      console.log(chalk.dim(`     CORE_SCHEMA_TOKENS_BY_VERSION = ${tableTokens.toLocaleString()}`));
      console.log(chalk.dim(`     calibrated /context System tools = ${tb.coreSchemaTokens.toLocaleString()} (used for this analysis)`));
      console.log(chalk.dim(`     Delta: ${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`));
      console.log(chalk.dim(`     Add a band for this version in src/built-in-tools.ts`));
    }
  }

  console.log();
}
