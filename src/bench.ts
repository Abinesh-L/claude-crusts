/**
 * Bench harness — deterministic before/after measurement around a live
 * `/compact` event in Claude Code.
 *
 * Replaces the PowerShell "paste, switch window, press Enter" pause from
 * test-v0.7.ps1 with a single native command that tails the session JSONL
 * and auto-captures the delta the moment Claude Code writes its
 * `compact_boundary` marker.
 *
 * Typical use:
 *   claude-crusts bench compact [session-id]
 *   claude-crusts bench compact --focus "drop stale read of types.ts"
 *
 * Exit semantics:
 *   - compaction detected before timeout → prints delta, exits 0
 *   - timeout reached with no compaction → prints BEFORE only, exits 2
 *   - session resolution / parse failure → exits 1
 *
 * Survival extraction:
 *   When a compaction is detected, the first post-boundary `isCompactSummary`
 *   message is scanned for file-path references. That list is what `optimize`
 *   would point at as "survived the compact," and the `--ab` layer in a
 *   later release diffs this list across blind vs. focused runs.
 */

import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import chalk from 'chalk';
import { parseSession } from './scanner.ts';
import { classifySession } from './classifier.ts';
import { gatherConfigData } from './analyzer.ts';
import { copyToClipboard } from './clipboard.ts';
import type { SessionInfo, SessionMessage, CrustsBreakdown, ConfigData } from './types.ts';

/** Polling interval for the JSONL tail (milliseconds). */
const POLL_INTERVAL_MS = 1_000;

/** How long to wait after `compact_boundary` is detected before re-parsing,
 *  giving Claude Code a moment to finish writing the summary + first assistant. */
const POST_BOUNDARY_SETTLE_MS = 2_500;

/** Default timeout before the bench gives up (seconds). */
const DEFAULT_TIMEOUT_SEC = 900;

/**
 * File extensions counted as real file references.
 *
 * The summary text Claude writes is free-form prose and contains plenty of
 * JavaScript-shaped constructs like `Math.abs`, `console.log`, `chalk.bold`
 * that our naive `name.ext` regex would happily accept. Whitelisting keeps
 * the survivor list honest. Extend this set when the ecosystem adds common
 * file types we start caring about — JSON/YAML/Lock/source files dominate.
 */
const FILE_EXTENSION_WHITELIST: ReadonlySet<string> = new Set([
  // TypeScript / JavaScript
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'd.ts',
  // Docs / markup
  'md', 'mdx', 'txt', 'rst', 'adoc',
  // Data / config
  'json', 'jsonl', 'json5', 'yaml', 'yml', 'toml', 'ini', 'env', 'properties',
  'xml', 'csv', 'tsv',
  // Package / lock files
  'lock',
  // Web
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'vue', 'svelte', 'astro',
  // Shell / scripting
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  // Systems / compiled
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'm', 'mm',
  'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx',
  'cs', 'vb', 'fs',
  'php', 'scala', 'clj', 'lua', 'r', 'jl', 'pl', 'pm',
  // Infra
  'dockerfile', 'tf', 'tfvars', 'hcl',
  // Data / binary we'd still want to know about
  'sql', 'graphql', 'gql', 'proto',
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf',
]);

/**
 * Candidate match for a file-shaped token in summary text.
 *
 * The regex captures `name` and `ext` groups; callers decide whether the
 * extension is in the whitelist. We accept cross-platform separators
 * (`/` and `\`), optional drive prefix, and the relative `./` / `../`
 * prefixes that show up often in Claude's summary prose.
 */
const FILE_REF_PATTERN = /(?:[a-zA-Z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w\-]+[\\/])*([\w\-][\w\-.]*)\.([a-zA-Z][a-zA-Z0-9]{0,7})\b/g;

/** Input knobs for a bench run. */
export interface BenchCompactOptions {
  /** Focus string; if set, we emit `/compact focus "<this>"` to the clipboard. */
  focus?: string;
  /** Hard upper bound before we give up and return a timeout result. */
  timeoutSec?: number;
  /** If set, persist `{before, after, delta}` to this JSON path on success. */
  outputPath?: string;
  /** If true, suppress human output and print a single JSON envelope. */
  json?: boolean;
  /** Override the poll cadence (tests pass small values for speed). */
  pollIntervalMs?: number;
}

/** A single snapshot — projection of the breakdown we care about at a cutpoint. */
export interface BenchSnapshot {
  tokensTotal: number;
  tokensCurrentContext: number;
  usagePercentage: number;
  messageCount: number;
  wasteCount: number;
  compactionCount: number;
  contextLimit: number;
}

/** The delta between two snapshots + the summary survivor list. */
export interface BenchResult {
  sessionId: string;
  sessionPath: string;
  status: 'compacted' | 'timeout' | 'error';
  before: BenchSnapshot;
  after?: BenchSnapshot;
  /** Absolute delta (after - before). Undefined when status !== 'compacted'. */
  delta?: {
    tokensTotal: number;
    tokensCurrentContext: number;
    usagePercentage: number;
    wasteCount: number;
    compactionCount: number;
  };
  /** File paths mentioned in the compact summary message (what survived). */
  summaryFileRefs?: string[];
  /** Claude-generated compact summary text (truncated to 2KB for the report). */
  summaryExcerpt?: string;
  /** Whether a `/compact focus` command was staged to the user's clipboard. */
  focusCommandStaged?: boolean;
  /** Seconds spent waiting for the boundary. */
  waitSec: number;
  /** Error message when status === 'error'. */
  message?: string;
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Reduce a full breakdown to the fields that matter for a compact delta.
 *
 * `tokensCurrentContext` is the post-compaction window if one exists, falling
 * back to `total_tokens` for pre-compaction sessions. That choice matches what
 * `status` / `statusline` show to the user.
 *
 * @param breakdown - Output of `classifySession`
 * @param messages - Messages used to build that breakdown (for waste/compaction counts derived elsewhere)
 * @param wasteCount - Number of waste items detected in this slice
 * @returns Projection suitable for delta math
 */
function toSnapshot(breakdown: CrustsBreakdown, messages: SessionMessage[], wasteCount: number): BenchSnapshot {
  const current = breakdown.currentContext;
  return {
    tokensTotal: breakdown.total_tokens,
    tokensCurrentContext: current?.total_tokens ?? breakdown.total_tokens,
    usagePercentage: current?.usage_percentage ?? breakdown.usage_percentage,
    messageCount: messages.length,
    wasteCount,
    compactionCount: breakdown.compactionEvents.length,
    contextLimit: breakdown.context_limit,
  };
}

/**
 * Parse the session, classify it, and run waste detection once.
 *
 * Imported lazily from `./waste-detector` to avoid pulling the whole detection
 * graph into bench's module-init path when it isn't needed (e.g. under test).
 */
async function captureSnapshot(session: SessionInfo, configData: ConfigData): Promise<BenchSnapshot> {
  const messages = await parseSession(session.path);
  const breakdown = classifySession(messages, configData);
  const { detectWaste } = await import('./waste-detector.ts');
  const waste = detectWaste(messages, breakdown, configData);
  return toSnapshot(breakdown, messages, waste.length);
}

/**
 * Parse + classify + return the raw messages so we can inspect the summary.
 *
 * Used for the AFTER capture where we also want to pull file refs from the
 * `isCompactSummary` message.
 */
async function captureSnapshotWithMessages(
  session: SessionInfo,
  configData: ConfigData,
): Promise<{ snapshot: BenchSnapshot; messages: SessionMessage[] }> {
  const messages = await parseSession(session.path);
  const breakdown = classifySession(messages, configData);
  const { detectWaste } = await import('./waste-detector.ts');
  const waste = detectWaste(messages, breakdown, configData);
  return { snapshot: toSnapshot(breakdown, messages, waste.length), messages };
}

// ---------------------------------------------------------------------------
// JSONL tail
// ---------------------------------------------------------------------------

/**
 * Read bytes `[startOffset, endOffset)` from `path` as UTF-8.
 *
 * We tail by comparing `statSync().size` between ticks and reading only the
 * newly-appended slice — identical to how `watcher.ts` ticks, but this path
 * needs the raw JSONL lines, not a re-parse, so we keep it local.
 */
function readBetween(path: string, startOffset: number, endOffset: number): string {
  if (endOffset <= startOffset) return '';
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(endOffset - startOffset);
    readSync(fd, buffer, 0, buffer.length, startOffset);
    return buffer.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Scan a chunk of newly-appended JSONL for a `compact_boundary` record.
 *
 * Exported for tests: a pure function over a string chunk lets us verify the
 * detection without having to stage a real Claude Code session.
 *
 * @param chunk - Newly-appended bytes, possibly containing partial final line
 * @returns True if any complete line is a `compact_boundary` system record
 */
export function chunkContainsCompactBoundary(chunk: string): boolean {
  if (!chunk.includes('compact_boundary')) return false;
  const lines = chunk.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { type?: string; subtype?: string };
      if (parsed.type === 'system' && parsed.subtype === 'compact_boundary') return true;
    } catch {
      // Partial or malformed line — skip, we'll see it again next tick.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Summary extraction
// ---------------------------------------------------------------------------

/**
 * Locate the first `isCompactSummary` message *after* the given index and
 * return its raw text. Returns `''` if not yet present.
 */
function extractSummaryText(messages: SessionMessage[], afterIndex: number): string {
  for (let i = afterIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || !msg.isCompactSummary) continue;
    const content = msg.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((b) => (typeof b === 'object' && b && 'text' in b && typeof b.text === 'string' ? b.text : ''))
        .join('\n');
    }
  }
  return '';
}

/**
 * Pull out path-shaped tokens from a block of summary text.
 *
 * Strategy: find every `name.ext` candidate via `FILE_REF_PATTERN`, then
 * reject any whose extension isn't in `FILE_EXTENSION_WHITELIST`. This
 * eliminates the primary noise class — JavaScript method calls like
 * `Math.abs`, `console.log`, `chalk.bold` — while still picking up the
 * files that actually matter for an A/B survivor diff. De-duplicated and
 * sorted for stable output.
 *
 * Additional rejections:
 *   - version-like strings (`1.0.0`, `4.7.2`) — the tail segment is digits
 *   - numeric extensions (`.2`, `.07`) — never a real file
 *   - segments shorter than 3 chars total — too ambiguous
 */
export function extractFileRefs(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  // Reset regex state (global regex carries lastIndex across invocations).
  FILE_REF_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_REF_PATTERN.exec(text)) !== null) {
    const full = match[0];
    const ext = match[2]?.toLowerCase();
    if (!ext) continue;

    if (full.length < 3) continue;
    // Reject semver-like triples: "1.0.0", "4.7.2", "2.3.4-beta".
    if (/^\d+(?:\.\d+){1,}[\w\-]*$/.test(full)) continue;
    // Reject purely-numeric extensions (already covered by whitelist but cheap).
    if (/^\d+$/.test(ext)) continue;
    if (!FILE_EXTENSION_WHITELIST.has(ext)) continue;

    seen.add(full);
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Core loop
// ---------------------------------------------------------------------------

/**
 * Poll the session file until a `compact_boundary` record appears or the
 * timeout elapses.
 *
 * @returns Result envelope; caller is responsible for printing.
 */
export async function runBenchCompact(
  session: SessionInfo,
  options: BenchCompactOptions = {},
): Promise<BenchResult> {
  const timeoutSec = options.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const pollMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const startedAt = Date.now();
  const configData = gatherConfigData();

  if (!existsSync(session.path)) {
    return {
      sessionId: session.id,
      sessionPath: session.path,
      status: 'error',
      before: emptySnapshot(),
      waitSec: 0,
      message: `Session file does not exist: ${session.path}`,
    };
  }

  // --- BEFORE snapshot ---
  const before = await captureSnapshot(session, configData);
  const baselineCompactions = before.compactionCount;
  const baselineSize = statSync(session.path).size;

  // --- Clipboard-stage the focused compact command if requested ---
  let focusCommandStaged = false;
  if (options.focus) {
    const command = `/compact focus "${options.focus.replace(/"/g, '\\"')}"`;
    focusCommandStaged = await copyToClipboard(command);
  }

  if (!options.json) {
    printWaitingBanner(session, before, options, focusCommandStaged, timeoutSec);
  }

  // --- Tail loop ---
  let lastSize = baselineSize;
  const deadline = startedAt + timeoutSec * 1_000;
  let compactDetected = false;

  while (Date.now() < deadline) {
    await sleep(pollMs);

    let currentSize: number;
    try {
      currentSize = statSync(session.path).size;
    } catch {
      continue; // Windows occasionally throws EBUSY during Claude Code writes.
    }

    if (currentSize <= lastSize) continue;

    const chunk = readBetween(session.path, lastSize, currentSize);
    lastSize = currentSize;

    if (chunkContainsCompactBoundary(chunk)) {
      compactDetected = true;
      break;
    }
  }

  const waitSec = Math.round((Date.now() - startedAt) / 100) / 10;

  if (!compactDetected) {
    return {
      sessionId: session.id,
      sessionPath: session.path,
      status: 'timeout',
      before,
      focusCommandStaged,
      waitSec,
      message: `No compact_boundary record appeared within ${timeoutSec}s.`,
    };
  }

  // Give Claude Code a beat to finish writing the summary + first assistant.
  await sleep(POST_BOUNDARY_SETTLE_MS);

  // --- AFTER snapshot ---
  const { snapshot: after, messages: afterMessages } = await captureSnapshotWithMessages(session, configData);

  // If for some reason the compaction wasn't recognised by the classifier
  // (rare — a truncated write after our boundary detection), surface as error
  // rather than pretending the delta is meaningful.
  if (after.compactionCount <= baselineCompactions) {
    return {
      sessionId: session.id,
      sessionPath: session.path,
      status: 'error',
      before,
      after,
      focusCommandStaged,
      waitSec,
      message: 'Detected compact_boundary in JSONL but classifier did not register a new compaction event.',
    };
  }

  const summaryText = extractSummaryText(afterMessages, before.messageCount);
  const summaryFileRefs = extractFileRefs(summaryText);
  const summaryExcerpt = summaryText.length > 2_048 ? summaryText.slice(0, 2_048) + '…' : summaryText;

  const delta = {
    tokensTotal: after.tokensTotal - before.tokensTotal,
    tokensCurrentContext: after.tokensCurrentContext - before.tokensCurrentContext,
    usagePercentage: after.usagePercentage - before.usagePercentage,
    wasteCount: after.wasteCount - before.wasteCount,
    compactionCount: after.compactionCount - before.compactionCount,
  };

  const result: BenchResult = {
    sessionId: session.id,
    sessionPath: session.path,
    status: 'compacted',
    before,
    after,
    delta,
    summaryFileRefs,
    summaryExcerpt,
    focusCommandStaged,
    waitSec,
  };

  if (options.outputPath) {
    try {
      await writeFile(options.outputPath, JSON.stringify(result, null, 2), 'utf-8');
    } catch (err) {
      // Non-fatal: persistence failure shouldn't invalidate the measurement.
      if (!options.json) {
        console.error(chalk.yellow(`  (failed to write ${options.outputPath}: ${err instanceof Error ? err.message : String(err)})`));
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Emit the "waiting for compaction" banner that surrounds the tail loop.
 */
function printWaitingBanner(
  session: SessionInfo,
  before: BenchSnapshot,
  options: BenchCompactOptions,
  focusStaged: boolean,
  timeoutSec: number,
): void {
  const hr = '═'.repeat(60);
  console.log();
  console.log(chalk.bold('  CRUSTS bench compact'));
  console.log(chalk.dim(`  ${hr}`));
  console.log(`  Session     : ${chalk.cyan(session.id.slice(0, 8))}  (${session.project})`);
  console.log(`  Context     : ${before.contextLimit.toLocaleString()} tokens`);
  console.log(`  BEFORE      : ${chalk.yellow(before.tokensCurrentContext.toLocaleString())} tokens` +
              ` (${before.usagePercentage.toFixed(1)}%)` +
              `  waste=${before.wasteCount}  compactions=${before.compactionCount}`);
  if (options.focus) {
    if (focusStaged) {
      console.log(chalk.green('  Clipboard   : ') + chalk.dim('/compact focus "' + options.focus + '" staged — paste in Claude Code.'));
    } else {
      console.log(chalk.red('  Clipboard   : failed to stage command (no clipboard helper found).'));
      console.log(chalk.dim(`  Run manually: /compact focus "${options.focus}"`));
    }
  } else {
    console.log(chalk.dim('  Run /compact (or /compact focus "...") in Claude Code when ready.'));
  }
  console.log(chalk.dim(`  Timeout     : ${timeoutSec}s  (poll ${POLL_INTERVAL_MS}ms)`));
  console.log(chalk.dim(`  ${hr}`));
  console.log(chalk.dim('  Tailing session JSONL for compact_boundary…'));
  console.log();
}

/**
 * Pretty-print a result envelope. Safe to call on any status.
 */
export function renderBenchResult(result: BenchResult): void {
  const hr = '═'.repeat(60);

  if (result.status === 'error') {
    console.log(chalk.red('  bench compact failed.'));
    if (result.message) console.log(chalk.dim(`  ${result.message}`));
    console.log();
    return;
  }

  if (result.status === 'timeout') {
    console.log(chalk.yellow(`  Timeout after ${result.waitSec}s — no compact_boundary record appeared.`));
    console.log(chalk.dim('  BEFORE snapshot captured; AFTER was never recorded.'));
    console.log();
    return;
  }

  const { before, after, delta, summaryFileRefs } = result;
  if (!after || !delta) return;

  console.log();
  console.log(chalk.bold('  Compaction detected — delta captured'));
  console.log(chalk.dim(`  ${hr}`));
  console.log(`  BEFORE  tokens=${fmt(before.tokensCurrentContext)}  usage=${before.usagePercentage.toFixed(1)}%  waste=${before.wasteCount}  compactions=${before.compactionCount}`);
  console.log(`  AFTER   tokens=${fmt(after.tokensCurrentContext)}  usage=${after.usagePercentage.toFixed(1)}%  waste=${after.wasteCount}  compactions=${after.compactionCount}`);
  console.log();
  console.log(`  delta tokens      : ${signed(delta.tokensCurrentContext)}`);
  console.log(`  delta usage       : ${signed(delta.usagePercentage, (n) => `${n.toFixed(1)}%`)}`);
  console.log(`  delta waste       : ${signed(delta.wasteCount)}`);
  console.log(`  delta compactions : ${signed(delta.compactionCount)}`);
  console.log();

  if (summaryFileRefs && summaryFileRefs.length > 0) {
    console.log(chalk.bold(`  Survived compact summary  (${summaryFileRefs.length} file refs):`));
    for (const ref of summaryFileRefs.slice(0, 20)) {
      console.log(chalk.dim(`    · ${ref}`));
    }
    if (summaryFileRefs.length > 20) {
      console.log(chalk.dim(`    · … (${summaryFileRefs.length - 20} more)`));
    }
  } else {
    console.log(chalk.dim('  Compact summary did not mention any file paths.'));
  }
  console.log();
  console.log(chalk.dim(`  Wait time: ${result.waitSec}s`));
  console.log();
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function signed(n: number, format: (n: number) => string = (x) => fmt(x)): string {
  const prefix = n > 0 ? '+' : '';
  const body = `${prefix}${format(n)}`;
  if (n < 0) return chalk.green(body);
  if (n > 0) return chalk.red(body);
  return chalk.dim(body);
}

function emptySnapshot(): BenchSnapshot {
  return {
    tokensTotal: 0,
    tokensCurrentContext: 0,
    usagePercentage: 0,
    messageCount: 0,
    wasteCount: 0,
    compactionCount: 0,
    contextLimit: 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// A/B comparison — two bench envelopes
// ---------------------------------------------------------------------------

/**
 * Pairwise comparison of two bench results — the offline half of the A/B
 * experiment. Each run is expected to have been written via
 * `bench compact --output <path>`; this loader tolerates loose JSON so
 * ad-hoc results can still be compared.
 */
export interface BenchComparison {
  labels: { a: string; b: string };
  before: {
    a: BenchSnapshot;
    b: BenchSnapshot;
    /** Same-metric deltas (B − A). Positive = B started higher. */
    delta: Partial<Record<keyof BenchSnapshot, number>>;
  };
  after: {
    a?: BenchSnapshot;
    b?: BenchSnapshot;
    delta?: Partial<Record<keyof BenchSnapshot, number>>;
  };
  /** File refs that survived only in run A's compact summary. */
  onlyInA: string[];
  /** File refs that survived only in run B's compact summary. */
  onlyInB: string[];
  /** File refs that survived in both summaries. */
  inBoth: string[];
  /** Plain-English one-liners for each notable observation. */
  insights: string[];
}

/**
 * Parse a bench result JSON file written by `bench compact --output`.
 *
 * Throws a friendly error when the file is missing or malformed — the CLI
 * catches and prints.
 */
export function loadBenchResult(path: string): BenchResult {
  if (!existsSync(path)) {
    throw new Error(`bench result file not found: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`bench result is not valid JSON: ${path} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`bench result is empty or malformed: ${path}`);
  }
  const r = parsed as BenchResult;
  if (!r.before || !r.status) {
    throw new Error(`bench result missing required fields (before/status): ${path}`);
  }
  return r;
}

/**
 * Diff two bench envelopes.
 *
 * Delta convention is `b - a` so "focused minus blind" reads left-to-right in
 * the direction users care about. Insights are heuristics, not inferences —
 * they flag observations worth mentioning in a demo narrative but stop short
 * of claiming causation.
 *
 * @param a - First bench run (conventionally the "blind" compact)
 * @param b - Second bench run (conventionally the "focused" compact)
 * @param labels - Optional override for display names
 */
export function compareBenchResults(
  a: BenchResult,
  b: BenchResult,
  labels?: { a?: string; b?: string },
): BenchComparison {
  const labelA = labels?.a ?? `A (${a.sessionId.slice(0, 8)})`;
  const labelB = labels?.b ?? `B (${b.sessionId.slice(0, 8)})`;

  const beforeDelta = snapshotDelta(a.before, b.before);
  const afterDelta = a.after && b.after ? snapshotDelta(a.after, b.after) : undefined;

  const aRefs = new Set(a.summaryFileRefs ?? []);
  const bRefs = new Set(b.summaryFileRefs ?? []);
  const onlyInA = [...aRefs].filter((r) => !bRefs.has(r)).sort();
  const onlyInB = [...bRefs].filter((r) => !aRefs.has(r)).sort();
  const inBoth = [...aRefs].filter((r) => bRefs.has(r)).sort();

  const insights: string[] = [];

  // 1. Coverage comparison — which summary mentioned more file paths?
  if (aRefs.size > 0 || bRefs.size > 0) {
    const diff = bRefs.size - aRefs.size;
    if (diff > 0) {
      insights.push(`${labelB} summary mentioned ${diff} more file path(s) than ${labelA} (${bRefs.size} vs ${aRefs.size}).`);
    } else if (diff < 0) {
      insights.push(`${labelA} summary mentioned ${-diff} more file path(s) than ${labelB} (${aRefs.size} vs ${bRefs.size}).`);
    } else {
      insights.push(`Both summaries mentioned the same number of file paths (${aRefs.size}).`);
    }
  }

  // 2. Exclusive survivors — the core A/B story.
  if (onlyInB.length > 0) {
    insights.push(`${onlyInB.length} file(s) referenced only in ${labelB}: ${previewList(onlyInB)}`);
  }
  if (onlyInA.length > 0) {
    insights.push(`${onlyInA.length} file(s) referenced only in ${labelA}: ${previewList(onlyInA)}`);
  }

  // 3. Token reclaim comparison — sanity check that both ran a compact.
  if (a.delta && b.delta) {
    const aReclaim = -a.delta.tokensCurrentContext;
    const bReclaim = -b.delta.tokensCurrentContext;
    if (aReclaim > 0 && bReclaim > 0) {
      const ratio = bReclaim / aReclaim;
      if (Math.abs(1 - ratio) < 0.1) {
        insights.push(`Both runs reclaimed a similar share of context (${aReclaim.toLocaleString()} vs ${bReclaim.toLocaleString()} tokens) — which is expected; the interesting delta is which content survived.`);
      } else if (ratio > 1) {
        insights.push(`${labelB} reclaimed ${Math.round((ratio - 1) * 100)}% more tokens than ${labelA}.`);
      } else {
        insights.push(`${labelA} reclaimed ${Math.round((1 / ratio - 1) * 100)}% more tokens than ${labelB}.`);
      }
    }
  }

  return {
    labels: { a: labelA, b: labelB },
    before: { a: a.before, b: b.before, delta: beforeDelta },
    after: { a: a.after, b: b.after, delta: afterDelta },
    onlyInA,
    onlyInB,
    inBoth,
    insights,
  };
}

/**
 * Pretty-print a comparison. Mirrors the shape used by the per-run renderer
 * so two consecutive invocations read symmetrically.
 */
export function renderBenchComparison(cmp: BenchComparison): void {
  const hr = '═'.repeat(60);
  console.log();
  console.log(chalk.bold('  CRUSTS bench compare'));
  console.log(chalk.dim(`  ${hr}`));
  console.log(`  A: ${chalk.cyan(cmp.labels.a)}`);
  console.log(`  B: ${chalk.cyan(cmp.labels.b)}`);
  console.log();

  console.log(chalk.bold('  Token metrics'));
  renderSnapshotRow('BEFORE', cmp.before.a, cmp.before.b);
  if (cmp.after.a && cmp.after.b) {
    renderSnapshotRow('AFTER ', cmp.after.a, cmp.after.b);
  } else {
    console.log(chalk.dim('  AFTER  not available for one or both runs.'));
  }
  console.log();

  console.log(chalk.bold('  Summary survivor diff'));
  console.log(`  In both       : ${chalk.dim(cmp.inBoth.length.toString())}  ${previewList(cmp.inBoth, 5)}`);
  console.log(`  Only in A     : ${chalk.yellow(cmp.onlyInA.length.toString())}  ${previewList(cmp.onlyInA, 5)}`);
  console.log(`  Only in B     : ${chalk.green(cmp.onlyInB.length.toString())}  ${previewList(cmp.onlyInB, 5)}`);
  console.log();

  if (cmp.insights.length > 0) {
    console.log(chalk.bold('  Insights'));
    for (const line of cmp.insights) {
      console.log(`  · ${line}`);
    }
    console.log();
  }
  console.log(chalk.dim(`  ${hr}`));
  console.log();
}

/** Compute per-field delta `b - a` for the numeric fields of BenchSnapshot. */
function snapshotDelta(a: BenchSnapshot, b: BenchSnapshot): Partial<Record<keyof BenchSnapshot, number>> {
  return {
    tokensTotal: b.tokensTotal - a.tokensTotal,
    tokensCurrentContext: b.tokensCurrentContext - a.tokensCurrentContext,
    usagePercentage: b.usagePercentage - a.usagePercentage,
    messageCount: b.messageCount - a.messageCount,
    wasteCount: b.wasteCount - a.wasteCount,
    compactionCount: b.compactionCount - a.compactionCount,
    contextLimit: b.contextLimit - a.contextLimit,
  };
}

/** One-line side-by-side snapshot comparison used by renderBenchComparison. */
function renderSnapshotRow(label: string, a: BenchSnapshot, b: BenchSnapshot): void {
  const row = `  ${label}  A=${fmt(a.tokensCurrentContext)} tkns (${a.usagePercentage.toFixed(1)}%)  |  B=${fmt(b.tokensCurrentContext)} tkns (${b.usagePercentage.toFixed(1)}%)`;
  console.log(row);
}

/**
 * Re-extract the summary file-ref list for an existing bench result.
 *
 * Use case: a bench run captured a polluted survivor list under an older
 * version of `extractFileRefs`, and we'd rather not re-compact the session
 * just to get a clean list. The compact summary is still present in the
 * session JSONL, so we can find it, re-run the current extractor, and
 * overwrite `summaryFileRefs` in the result file in place.
 *
 * The target summary is the one immediately following the last
 * `compact_boundary` record, which matches the pairing bench uses when it
 * builds the `summaryExcerpt` at capture time.
 *
 * @param resultPath - Path to a bench result JSON (produced by `--output`)
 * @param sessionPath - Optional override for the session JSONL to read;
 *   defaults to `result.sessionPath`
 * @returns The updated result + the number of refs before/after
 */
export async function reextractSummaryRefs(
  resultPath: string,
  sessionPath?: string,
): Promise<{ result: BenchResult; priorRefCount: number; newRefCount: number }> {
  const result = loadBenchResult(resultPath);
  const path = sessionPath ?? result.sessionPath;
  if (!existsSync(path)) {
    throw new Error(`session JSONL not found for re-extract: ${path}`);
  }

  const messages = await parseSession(path);

  // Find the LAST compact_boundary and the first isCompactSummary after it —
  // same pairing convention the capture path uses.
  let boundaryIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.type === 'system' && (m as { subtype?: string }).subtype === 'compact_boundary') {
      boundaryIndex = i;
      break;
    }
  }
  if (boundaryIndex < 0) {
    throw new Error(`no compact_boundary record found in ${path}`);
  }

  const summaryText = extractSummaryText(messages, boundaryIndex);
  if (!summaryText) {
    throw new Error(`compact_boundary found at index ${boundaryIndex} but no isCompactSummary message followed it`);
  }

  const priorRefs = result.summaryFileRefs ?? [];
  const newRefs = extractFileRefs(summaryText);
  result.summaryFileRefs = newRefs;
  result.summaryExcerpt = summaryText.length > 2_048 ? summaryText.slice(0, 2_048) + '…' : summaryText;

  await writeFile(resultPath, JSON.stringify(result, null, 2), 'utf-8');

  return { result, priorRefCount: priorRefs.length, newRefCount: newRefs.length };
}

/**
 * Render the first `n` items of `items` as a comma-separated preview with
 * an ellipsis when truncated.
 */
function previewList(items: string[], n = 5): string {
  if (items.length === 0) return chalk.dim('(none)');
  const head = items.slice(0, n).join(', ');
  const tail = items.length > n ? chalk.dim(` (+${items.length - n} more)`) : '';
  return head + tail;
}
