/**
 * Optimize pipeline — turn waste detection output into actionable, ranked fixes
 * with token-savings estimates and safe auto-apply paths.
 *
 * The existing `fix` command generates three generic blocks the user must
 * manually copy-paste. This module generates specific, ROI-tagged fixes that
 * can be applied automatically (with diff preview and confirmation) or copied
 * to the clipboard — closing the last-mile friction that made `fix` a
 * two-step process.
 *
 * Fix categories (v1):
 *   - compact-focus      : `/compact focus "..."` tuned to this session's waste
 *   - claudeignore       : append noise patterns to project `.claudeignore`
 *   - claudemd-rule      : append a rule to project `CLAUDE.md` to prevent
 *                          the waste pattern in future sessions
 *   - mcp-disable        : copy disable command for MCP servers with zero
 *                          invocations this session (informational)
 *   - claudemd-oversized : warn when `CLAUDE.md` exceeds the recommended budget
 *
 * Safety: auto-apply is off by default. Every file-modifying fix writes a
 * backup under `~/.claude-crusts/backups/` before applying, and requires
 * per-fix user confirmation unless `--yes` is passed.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, unlinkSync, utimesSync } from 'fs';
import { join, basename } from 'path';
import { createInterface } from 'readline';
import chalk from 'chalk';
import { copyToClipboard } from './clipboard.ts';
import { CRUSTS_DIR } from './calibrator.ts';
import { loadWasteThresholds } from './config.ts';
import type { CrustsBreakdown, WasteItem, ConfigData, SessionMessage } from './types.ts';

/** Noise path patterns that shouldn't be re-read into context repeatedly. */
const CLAUDEIGNORE_PATTERNS: Array<{ regex: RegExp; rule: string; label: string }> = [
  { regex: /(^|[\\/])node_modules[\\/]/i, rule: 'node_modules/', label: 'node_modules (installed deps)' },
  { regex: /(^|[\\/])dist[\\/]/i, rule: 'dist/', label: 'dist (build output)' },
  { regex: /(^|[\\/])build[\\/]/i, rule: 'build/', label: 'build (build output)' },
  { regex: /(^|[\\/])\.next[\\/]/i, rule: '.next/', label: '.next (Next.js cache)' },
  { regex: /(^|[\\/])target[\\/]/i, rule: 'target/', label: 'target (Rust/JVM build)' },
  { regex: /(^|[\\/])\.git[\\/]/i, rule: '.git/', label: '.git (version control internals)' },
  { regex: /(^|[\\/])(package-lock|bun|yarn|pnpm|cargo|poetry|pipfile)\.lock$/i, rule: '*.lock', label: 'lock files (auto-generated)' },
];

/**
 * Default threshold above which a CLAUDE.md file is flagged as oversized.
 * User can override via `wasteThresholds.claudeMdOversizedThreshold` in
 * `~/.claude-crusts/config.json`.
 */
const CLAUDE_MD_OVERSIZED_THRESHOLD_DEFAULT = 1_500;

/** Default minimum token savings to surface a fix. */
const DEFAULT_MIN_SAVINGS = 100;

/** All fix kinds the optimizer emits. */
export type FixKind =
  | 'compact-focus'
  | 'claudeignore'
  | 'claudemd-rule'
  | 'mcp-disable'
  | 'claudemd-oversized';

/** A single ranked, ROI-tagged fix ready for display or auto-apply. */
export interface OptimizeFix {
  id: number;
  kind: FixKind;
  title: string;
  description: string;
  estimatedSavings: number;
  /** Primary action text (compact command, diff, disable command, etc.) */
  action: string;
  /** True if --apply can modify files to enact this fix */
  autoApplicable: boolean;
  /** Absolute path being modified by auto-apply, if any */
  applyTarget?: string;
  /** Content to write (for file-appending fixes) */
  applyContent?: string;
}

/** Full optimize report: ranked fixes with totals. */
export interface OptimizeReport {
  sessionId: string;
  fixes: OptimizeFix[];
  totalSaveable: number;
  percentOfContext: number;
}

export interface OptimizeOptions {
  minSavings?: number;
  filter?: FixKind[];
}

// ---------------------------------------------------------------------------
// Fix detection
// ---------------------------------------------------------------------------

/**
 * Extract the file path from a Read-style tool invocation block.
 *
 * @param input - `input` object from a `tool_use` block
 * @returns Absolute path string if present
 */
function extractReadPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const p = (input as { file_path?: unknown; path?: unknown }).file_path
    ?? (input as { path?: unknown }).path;
  return typeof p === 'string' ? p : undefined;
}

/**
 * Walk session messages and return read-path → token-cost aggregates,
 * grouped by matching CLAUDEIGNORE_PATTERNS.
 *
 * The token cost attributed to each path is the approximate size of the
 * corresponding tool_result body — a reasonable proxy since the file's
 * contents account for most of the tool_result's tokens.
 */
function detectClaudeignoreCandidates(messages: SessionMessage[]): Map<string, { paths: Set<string>; tokens: number; label: string }> {
  const hits = new Map<string, { paths: Set<string>; tokens: number; label: string }>();
  // Map tool_use_id → { path, pattern }
  const readById = new Map<string, { path: string; rule: string; label: string }>();

  for (const msg of messages) {
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    if (msg.type === 'assistant') {
      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        if (block.name !== 'Read' && block.name !== 'FileReadTool') continue;
        const path = extractReadPath(block.input);
        if (!path) continue;
        const match = CLAUDEIGNORE_PATTERNS.find((p) => p.regex.test(path));
        if (!match) continue;
        if (block.id) readById.set(block.id, { path, rule: match.rule, label: match.label });
      }
    } else if (msg.type === 'user') {
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const meta = readById.get(block.tool_use_id ?? '');
        if (!meta) continue;
        const textLen = typeof block.content === 'string'
          ? block.content.length
          : Array.isArray(block.content)
            ? block.content.reduce((sum, b) => sum + (typeof b === 'object' && b && 'text' in b && typeof b.text === 'string' ? b.text.length : 0), 0)
            : 0;
        const tokens = Math.ceil(textLen / 3.3);
        const bucket = hits.get(meta.rule) ?? { paths: new Set<string>(), tokens: 0, label: meta.label };
        bucket.paths.add(meta.path);
        bucket.tokens += tokens;
        hits.set(meta.rule, bucket);
      }
    }
  }
  return hits;
}

/**
 * Generate a session-specific `/compact focus "..."` string from waste items.
 *
 * Picks the top 3 waste descriptions and synthesises a focus directive
 * targeting exactly those (filenames, resolved exchanges) instead of the
 * generic compact instruction.
 *
 * Exported so `recommender.ts:buildCompactCommand` can share the same
 * algorithm — both commands must produce byte-identical /compact-focus
 * strings on the same session.
 */
export function buildCompactFocus(waste: WasteItem[]): { text: string; savings: number } | null {
  const top = waste.filter((w) => w.severity === 'high' || w.severity === 'medium').slice(0, 3);
  if (top.length === 0) return null;

  const targets: string[] = [];
  let savings = 0;
  for (const item of top) {
    savings += item.estimated_tokens;
    if (item.type === 'duplicate_read') {
      const match = /"([^"]+)"/.exec(item.description);
      if (match) targets.push(`keep only latest read of ${match[1]}`);
    } else if (item.type === 'stale_read') {
      const match = /"([^"]+)"/.exec(item.description);
      if (match) targets.push(`drop stale read of ${match[1]}`);
    } else if (item.type === 'resolved_exchange') {
      if (item.message_range) targets.push(`drop resolved exchange at messages #${item.message_range[0]}-${item.message_range[1]}`);
    }
  }
  if (targets.length === 0) return null;
  return { text: `/compact focus "${targets.join('; ')}"`, savings };
}

/**
 * Build an append-block of noise-pattern rules for project `.claudeignore`.
 */
function renderClaudeignoreAppend(rules: string[]): string {
  return `\n# Added by claude-crusts optimize (${new Date().toISOString().slice(0, 10)})\n${rules.join('\n')}\n`;
}

/**
 * Build a CLAUDE.md append block that tells Claude not to re-read the
 * detected noise patterns in future sessions.
 *
 * Includes an explicit "recovery" note: the rules are *preferences*, not
 * hard bans. If a file under these patterns genuinely becomes relevant
 * (debugging a build artefact, auditing a lock file), Claude is free to
 * re-read it on demand. The goal is to eliminate reflexive reads, not to
 * block needed ones.
 */
function renderClaudemdRuleAppend(labels: string[]): string {
  const lines = labels.map((l) => `- ${l}`);
  const recovery = [
    '',
    '**Recovery note:** these are preferences, not hard bans. If any of these files ',
    'become relevant to a specific debugging or auditing task, re-read them on demand. ',
    'Files remain on disk and can always be re-read — this rule only discourages ',
    'reflexive reads that silently inflate context.',
  ].join('');
  return `\n## Files to avoid reading\n\n${lines.join('\n')}\n${recovery}\n`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce a ranked, ROI-tagged list of fixes for the given session.
 *
 * Fixes are sorted by `estimatedSavings` descending, filtered by `minSavings`
 * and `filter`, and given stable `id`s for user reference in `--filter` /
 * `--apply` flows.
 */
export function buildOptimizeReport(
  sessionId: string,
  breakdown: CrustsBreakdown,
  waste: WasteItem[],
  configData: ConfigData,
  messages: SessionMessage[],
  projectPath: string,
  options: OptimizeOptions = {},
): OptimizeReport {
  const minSavings = options.minSavings ?? DEFAULT_MIN_SAVINGS;
  const fixes: OptimizeFix[] = [];
  let nextId = 1;

  // 1. compact-focus — session-specific compact command from top waste
  const focus = buildCompactFocus(waste);
  if (focus && focus.savings >= minSavings) {
    fixes.push({
      id: nextId++,
      kind: 'compact-focus',
      title: 'Session-specific /compact command',
      description: 'Targets the top waste items in this session rather than a generic compact.',
      estimatedSavings: focus.savings,
      action: focus.text,
      autoApplicable: false,
    });
  }

  // 2. claudeignore — noise paths being re-read
  const ignoreHits = detectClaudeignoreCandidates(messages);
  if (ignoreHits.size > 0) {
    const rules: string[] = [];
    const labels: string[] = [];
    let totalTokens = 0;
    const claudeignorePath = join(projectPath, '.claudeignore');
    const existing = existsSync(claudeignorePath) ? readFileSync(claudeignorePath, 'utf-8') : '';
    for (const [rule, data] of ignoreHits) {
      if (existing.includes(rule)) continue;
      rules.push(rule);
      labels.push(`${data.label} — ${data.paths.size} file(s), ~${data.tokens.toLocaleString()} tokens`);
      totalTokens += data.tokens;
    }
    if (rules.length > 0 && totalTokens >= minSavings) {
      const appendContent = renderClaudeignoreAppend(rules);
      fixes.push({
        id: nextId++,
        kind: 'claudeignore',
        title: `Add ${rules.length} noise pattern(s) to .claudeignore`,
        description: labels.join('\n   '),
        estimatedSavings: totalTokens,
        action: appendContent.trim(),
        autoApplicable: true,
        applyTarget: claudeignorePath,
        applyContent: appendContent,
      });

      // 3. claudemd-rule — also append a prose rule to CLAUDE.md to deter Read calls
      const claudeMdPath = join(projectPath, 'CLAUDE.md');
      if (existsSync(claudeMdPath)) {
        const existingMd = readFileSync(claudeMdPath, 'utf-8');
        if (!existingMd.includes('Files to avoid reading')) {
          const ruleAppend = renderClaudemdRuleAppend(labels.map((l) => l.split(' — ')[0] ?? l));
          fixes.push({
            id: nextId++,
            kind: 'claudemd-rule',
            title: 'Add "Files to avoid reading" section to CLAUDE.md',
            description: 'Prevents future sessions from re-reading the same noise.',
            estimatedSavings: Math.round(totalTokens / 2), // secondary protection, don't double-count fully
            action: ruleAppend.trim(),
            autoApplicable: true,
            applyTarget: claudeMdPath,
            applyContent: ruleAppend,
          });
        }
      }
    }
  }

  // 4. mcp-disable — configured MCP servers with zero invocations
  if (breakdown.mcpBreakdown && breakdown.mcpBreakdown.unusedServers.length > 0) {
    const unused = breakdown.mcpBreakdown.unusedServers;
    fixes.push({
      id: nextId++,
      kind: 'mcp-disable',
      title: `${unused.length} MCP server(s) loaded but never invoked`,
      description: `Unused in this session: ${unused.join(', ')}. Disabling unused servers reduces cognitive clutter (schemas are loaded on-demand so direct token savings are 0 — but a habit of zero-invocation servers suggests dead config).`,
      estimatedSavings: 0,
      action: `# Remove from "mcpServers" in ~/.claude/settings.json or .mcp.json:\n${unused.map((s) => `  "${s}"`).join(',\n')}`,
      autoApplicable: false,
    });
  }

  // 5. claudemd-oversized — system-prompt CLAUDE.md bloat
  const claudeMdThreshold = loadWasteThresholds().claudeMdOversizedThreshold
    ?? CLAUDE_MD_OVERSIZED_THRESHOLD_DEFAULT;
  const claudeMdTokens = configData.systemPrompt.totalEstimatedTokens;
  if (claudeMdTokens > claudeMdThreshold) {
    const excess = claudeMdTokens - claudeMdThreshold;
    if (excess >= minSavings) {
      fixes.push({
        id: nextId++,
        kind: 'claudemd-oversized',
        title: `CLAUDE.md is ${claudeMdTokens.toLocaleString()} tokens (recommended <${claudeMdThreshold.toLocaleString()})`,
        description: 'Consider moving large reference sections (constants tables, file-responsibility lists) to CLAUDE.local.md (project-local, not committed).',
        estimatedSavings: excess,
        action: 'Review CLAUDE.md manually — no safe auto-trim in v1.',
        autoApplicable: false,
      });
    }
  }

  // Filter and sort
  let filtered = fixes.filter((f) => f.estimatedSavings >= minSavings || f.kind === 'mcp-disable' || f.kind === 'claudemd-rule');
  if (options.filter && options.filter.length > 0) {
    filtered = filtered.filter((f) => options.filter!.includes(f.kind));
  }
  filtered.sort((a, b) => b.estimatedSavings - a.estimatedSavings);

  const totalSaveable = filtered.reduce((sum, f) => sum + f.estimatedSavings, 0);
  const contextLimit = breakdown.context_limit;
  const percentOfContext = contextLimit > 0 ? (totalSaveable / contextLimit) * 100 : 0;

  return { sessionId, fixes: filtered, totalSaveable, percentOfContext };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const KIND_ICON: Record<FixKind, string> = {
  'compact-focus': '\u25b6', // ▶
  'claudeignore': '\u2699',  // ⚙
  'claudemd-rule': '\u270e', // ✎
  'mcp-disable': '\u29bf',   // ⦿
  'claudemd-oversized': '\u26a0', // ⚠
};

/** Render the ranked report to stdout. */
export function renderOptimizeReport(report: OptimizeReport): void {
  const hr = '\u2501'.repeat(52);
  console.log();
  console.log(chalk.bold(`  CRUSTS Optimize \u2014 session ${report.sessionId.slice(0, 8)}`));
  console.log(chalk.dim('  ' + hr));
  if (report.fixes.length === 0) {
    console.log(chalk.green('  No actionable fixes above the savings threshold.'));
    console.log();
    return;
  }
  const saveableStr = `${report.totalSaveable.toLocaleString()} tokens`;
  const pctStr = report.percentOfContext >= 0.1 ? ` (${report.percentOfContext.toFixed(1)}% of window)` : '';
  console.log(`  Total saveable: ${chalk.green(saveableStr)}${chalk.dim(pctStr)}`);
  console.log();

  for (const fix of report.fixes) {
    const savings = fix.estimatedSavings > 0
      ? chalk.green(`[-${fix.estimatedSavings.toLocaleString()} tkns]`)
      : chalk.dim('[ info ]   ');
    console.log(`  ${chalk.bold(`${fix.id}.`)} ${KIND_ICON[fix.kind]} ${savings} ${chalk.bold(fix.title)}`);
    for (const line of fix.description.split('\n')) {
      console.log(chalk.dim(`     ${line}`));
    }
    const actionLines = fix.action.split('\n');
    for (const line of actionLines.slice(0, 5)) {
      console.log(`     ${chalk.cyan(line)}`);
    }
    if (actionLines.length > 5) {
      console.log(chalk.dim(`     ... (${actionLines.length - 5} more lines)`));
    }
    if (fix.autoApplicable && fix.applyTarget) {
      console.log(chalk.dim(`     Target: ${fix.applyTarget}`));
    }
    console.log();
  }

  console.log(chalk.dim('  ' + hr));
  const applicable = report.fixes.filter((f) => f.autoApplicable);
  if (applicable.length > 0) {
    console.log(chalk.dim(`  ${applicable.length} fix(es) can be applied with --apply (each requires confirmation).`));
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Apply pipeline
// ---------------------------------------------------------------------------

/** Result of a single apply attempt. */
export interface ApplyResult {
  fixId: number;
  status: 'applied' | 'skipped' | 'copied' | 'failed';
  target?: string;
  backup?: string;
  message?: string;
}

/** Prompt the user for a yes/no confirmation via stdin. */
async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** Maximum backups retained per original filename; older ones are pruned. */
const BACKUPS_PER_FILE = 10;

/**
 * Path to the backup directory; created lazily.
 *
 * Respects the `CRUSTS_BACKUP_DIR_OVERRIDE` env var as an escape hatch for
 * tests that must sandbox the real `~/.claude-crusts/backups/` to avoid
 * polluting a developer's live install state. Production never sets this.
 */
function backupDir(): string {
  const override = process.env.CRUSTS_BACKUP_DIR_OVERRIDE;
  const dir = override && override.length > 0 ? override : join(CRUSTS_DIR, 'backups');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Prune backups so only the newest BACKUPS_PER_FILE remain for a given
 * original filename. Called after each successful backup write to keep
 * `~/.claude-crusts/backups/` from growing unbounded.
 *
 * Sort is **by filename**, not by `statSync().mtimeMs`. Rationale: on
 * Windows, `fs.copyFileSync` delegates to `CopyFileW` which preserves the
 * source file's timestamps on the destination — so a brand-new backup ends
 * up with an mtime inherited from the target file (which may predate older
 * backups). mtime-based pruning then deletes the just-created backup. The
 * filename carries an ISO-8601 timestamp (`<name>.<ts>.bak`) that is both
 * OS-independent and millisecond-precise, so lexicographic descending sort
 * reliably puts the newest backup first.
 *
 * @param originalName - The base filename (e.g. `CLAUDE.md`). Only backups
 *   beginning with `${originalName}.` are considered; siblings for other
 *   files are left alone.
 */
function pruneBackups(originalName: string): void {
  const dir = backupDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const prefix = `${originalName}.`;
  const matches = entries
    .filter((name) => name.startsWith(prefix) && name.endsWith('.bak'))
    .map((name) => ({ name, path: join(dir, name) }))
    // Lexicographic desc on the embedded ISO-8601 timestamp in the filename.
    // Since every backup we write uses the same `<originalName>.<ts>.bak`
    // shape, comparing full filenames is equivalent to comparing timestamps
    // while remaining OS-independent.
    .sort((a, b) => b.name.localeCompare(a.name));
  for (const stale of matches.slice(BACKUPS_PER_FILE)) {
    try { unlinkSync(stale.path); } catch { /* silent — best-effort cleanup */ }
  }
}

/**
 * Apply a single fix, with optional user confirmation.
 *
 * File-modifying fixes (claudeignore, claudemd-rule) are backed up to
 * `~/.claude-crusts/backups/` before writing. Clipboard-only fixes
 * (compact-focus, mcp-disable) copy the action text and report. Fixes
 * flagged `autoApplicable: false` fall through to clipboard copy of
 * their action text.
 */
export async function applyFix(
  fix: OptimizeFix,
  options: { yes?: boolean } = {},
): Promise<ApplyResult> {
  // Copy-to-clipboard path (no file touched)
  if (!fix.autoApplicable) {
    const ok = await copyToClipboard(fix.action);
    return {
      fixId: fix.id,
      status: ok ? 'copied' : 'failed',
      message: ok ? 'Action copied to clipboard. Paste into Claude Code / your terminal.' : 'Clipboard copy failed; action text shown above.',
    };
  }

  if (!fix.applyTarget || fix.applyContent === undefined) {
    return { fixId: fix.id, status: 'failed', message: 'Fix marked auto-applicable but missing target or content.' };
  }

  if (!options.yes) {
    const ok = await confirm(`  Apply fix #${fix.id} \u2192 ${basename(fix.applyTarget)}?`);
    if (!ok) return { fixId: fix.id, status: 'skipped' };
  }

  // Backup the target if it exists, then append
  let backupPath: string | undefined;
  try {
    if (existsSync(fix.applyTarget)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const originalName = basename(fix.applyTarget);
      backupPath = join(backupDir(), `${originalName}.${ts}.bak`);
      copyFileSync(fix.applyTarget, backupPath);
      // On Windows, copyFileSync preserves the source file's mtime on the
      // destination (via CopyFileW). Explicitly touch the backup to "now"
      // so any mtime-based tooling (monitoring, prune fallbacks, test
      // assertions) sees the backup's actual creation time rather than the
      // target's age. Silent-fail: the primary pruning path keys off
      // filenames, not mtime, so this is belt-and-suspenders.
      try { const now = new Date(); utimesSync(backupPath, now, now); } catch { /* best-effort */ }
      const prev = readFileSync(fix.applyTarget, 'utf-8');
      writeFileSync(fix.applyTarget, prev + fix.applyContent, 'utf-8');
      pruneBackups(originalName);
    } else {
      writeFileSync(fix.applyTarget, fix.applyContent.trimStart(), 'utf-8');
    }
    return { fixId: fix.id, status: 'applied', target: fix.applyTarget, backup: backupPath };
  } catch (err) {
    return {
      fixId: fix.id,
      status: 'failed',
      target: fix.applyTarget,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
