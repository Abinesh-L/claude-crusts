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
 *   - read-deny          : add `Read(...)` deny rules for the noise paths this
 *                          session read to the project's
 *                          `.claude/settings.local.json`, so Claude Code
 *                          refuses to read them
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
import { join, basename, dirname, isAbsolute, resolve } from 'path';
import { createInterface } from 'readline';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import { copyToClipboard } from './clipboard.ts';
import { CRUSTS_DIR } from './calibrator.ts';
import { loadWasteThresholds, stripBom, writeFileAtomic } from './config.ts';
import type { CrustsBreakdown, WasteItem, ConfigData, SessionMessage, ClassifiedMessage } from './types.ts';
import { sessionClaudeMd, claudeMdLabel, CLAUDE_MD_SPLIT_ADVICE } from './classifier.ts';
import { compactTargets, resultTokens } from './waste-detector.ts';

/**
 * Noise paths that shouldn't be re-read into context repeatedly.
 *
 * Each regex matches a path relative to the project root and captures what
 * the deny rule covers, as the path spells it: a folder (`folder: true`,
 * everything under it is covered) or, for lock files, which mix `.lock`,
 * `.json` and `.yaml` names, the file itself.
 *
 * `node_modules`, `.git` and lock files are noise wherever they sit, so
 * their rule covers every copy at any depth. Output folders (`output: true`:
 * `dist`, `build`, `.next`, `target`) share their names with source
 * folders in many projects (Go's `build/`, electron-builder's resources,
 * `com/android/build` packages), and a Read deny rule also blocks editing and
 * creating files there. So they match case-sensitively, the capture is the
 * folder's own path from the project root (the rule covers that folder
 * only), and `detectNoiseReads` proposes them only when git shows the folder
 * holds output (`gitOutputFolder`).
 */
const NOISE_PATHS: Array<{ regex: RegExp; folder: boolean; output: boolean; label: string }> = [
  { regex: /(?:^|\/)(node_modules)\//i, folder: true, output: false, label: 'installed deps' },
  { regex: /^((?:[^/]+\/)*?dist)\//, folder: true, output: true, label: 'build output' },
  { regex: /^((?:[^/]+\/)*?build)\//, folder: true, output: true, label: 'build output' },
  { regex: /^((?:[^/]+\/)*?\.next)\//, folder: true, output: true, label: 'Next.js cache' },
  { regex: /^((?:[^/]+\/)*?target)\//, folder: true, output: true, label: 'Rust/JVM build' },
  { regex: /(?:^|\/)(\.git)\//i, folder: true, output: false, label: 'version control internals' },
  {
    regex: /(?:^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.lock|poetry\.lock|pipfile\.lock)$/i,
    folder: false,
    output: false,
    label: 'lock file, auto-generated',
  },
];

/**
 * Where the read-deny fix writes, relative to the project root: Claude Code's
 * personal per-project settings file, which it keeps out of git when it
 * creates the file itself.
 */
const LOCAL_SETTINGS_PATH = '.claude/settings.local.json';

/**
 * Default threshold above which a CLAUDE.md file is flagged as oversized.
 * User can override via `wasteThresholds.claudeMdOversizedThreshold` in
 * `~/.claude-crusts/config.json`.
 */
const CLAUDE_MD_OVERSIZED_THRESHOLD_DEFAULT = 1_500;

/** Default minimum token savings to surface a fix. */
const DEFAULT_MIN_SAVINGS = 100;

/** All fix kinds the optimizer emits. */
export const FIX_KINDS = [
  'compact-focus',
  'read-deny',
  'claudemd-rule',
  'mcp-disable',
  'claudemd-oversized',
] as const;

/** One of the fix kinds in `FIX_KINDS`. */
export type FixKind = typeof FIX_KINDS[number];

/**
 * Fix kinds renamed since an earlier release, mapped to the current name.
 * `claudeignore` wrote a `.claudeignore` file, which Claude Code never reads;
 * `read-deny` replaced it in 0.8.2.
 */
export const RENAMED_FIX_KINDS: Readonly<Record<string, FixKind>> = {
  claudeignore: 'read-deny',
};

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
  /** Permission rules to add to `permissions.deny` in `applyTarget` (read-deny fixes) */
  denyRules?: string[];
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
  /** Confirms that an output folder (dist, build, .next, target) holds no source; default `gitOutputFolder` */
  isOutputFolder?: (projectPath: string, folder: string) => boolean;
}

/**
 * Parse a comma-separated `--filter` value into fix kinds.
 *
 * Names are trimmed and matched case-insensitively. A renamed kind (see
 * `RENAMED_FIX_KINDS`) still selects its replacement and is listed in
 * `renamed`, so the CLI can say so; names that match no kind are returned in
 * `unknown` instead of silently filtering every fix out.
 *
 * @param value - The raw `--filter` option value
 * @returns The selected kinds (deduplicated), plus unknown and renamed names
 */
export function parseFixKinds(value: string): { kinds: FixKind[]; unknown: string[]; renamed: string[] } {
  const kinds: FixKind[] = [];
  const unknown: string[] = [];
  const renamed: string[] = [];
  for (const raw of value.split(',')) {
    const name = raw.trim().toLowerCase();
    if (name === '') continue;
    const current = (FIX_KINDS as readonly string[]).includes(name)
      ? name as FixKind
      : RENAMED_FIX_KINDS[name];
    if (current === undefined) {
      unknown.push(raw.trim());
      continue;
    }
    if (current !== name) renamed.push(name);
    if (!kinds.includes(current)) kinds.push(current);
  }
  return { kinds, unknown, renamed };
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
 * Path of `target` relative to the folder `root`, with forward slashes, or
 * null when `target` is not inside `root`.
 *
 * Compares case-insensitively on Windows, as Claude Code matches deny rules
 * there.
 */
function projectRelativePath(root: string, target: string): string | null {
  const slashed = (p: string): string => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  const base = slashed(root);
  const full = slashed(target);
  if (!fold(full).startsWith(`${fold(base)}/`)) return null;
  return full.slice(base.length + 1);
}

/** A noise path one session read, with the deny rule that covers it. */
interface NoiseRead {
  /** Claude Code permission rule, e.g. `Read(/**\/node_modules/**)` */
  rule: string;
  /** Display name, e.g. `node_modules (installed deps)` */
  label: string;
  /** Short name for the fix title, e.g. `node_modules/` or `bun.lock` */
  name: string;
  /** For an output folder, its path from the project root, which git must confirm */
  outputFolder?: string;
}

/**
 * Match a project-relative path against `NOISE_PATHS` and build the
 * `Read(...)` deny rule that covers it.
 *
 * Rules use Claude Code's permission path syntax, which is gitignore syntax:
 * a leading `/` anchors at the project (for `.claude/settings.local.json`,
 * the session's primary working directory) and `**` matches any depth, so
 * one rule covers nested copies such as `packages/web/node_modules/`. An
 * output folder's rule names the folder that was read
 * (`Read(/packages/web/dist/**)`), never every folder of that name. A plain
 * relative pattern (`./node_modules/**`) would resolve against Claude's
 * current directory, which follows a `cd` in the shell, and miss the
 * project's top-level folder after one. The name keeps the path's spelling,
 * since rules match case-sensitively outside Windows.
 *
 * @param relative - Path relative to the project root, forward slashes
 * @returns The rule, or null when the path is not noise
 */
function matchNoisePath(relative: string): NoiseRead | null {
  for (const entry of NOISE_PATHS) {
    const covered = entry.regex.exec(relative)?.[1];
    if (!covered) continue;
    const base = covered.split('/').pop()!;
    if (entry.output) {
      return { rule: `Read(/${covered}/**)`, label: `${covered} (${entry.label})`, name: `${covered}/`, outputFolder: covered };
    }
    return {
      rule: entry.folder ? `Read(/**/${base}/**)` : `Read(/**/${base})`,
      label: `${base} (${entry.label})`,
      name: entry.folder ? `${base}/` : base,
    };
  }
  return null;
}

/** Reads of the noise paths one deny rule covers, with their cost. */
interface NoiseReads extends NoiseRead {
  /** Distinct files read */
  paths: Set<string>;
  /** Approximate tokens their read results added to the window */
  tokens: number;
}

/**
 * Whether git shows that a project folder holds output: git ignores it, or
 * tracks no file in it. Without git, or outside a repository, the answer is
 * no, since a Read deny rule on a source folder would also block editing it.
 *
 * @param projectPath - Project root
 * @param folder - Folder path relative to the project root, forward slashes
 * @returns True when a deny rule on the folder cannot hide tracked files
 */
export function gitOutputFolder(projectPath: string, folder: string): boolean {
  const git = (args: string[]) =>
    spawnSync('git', ['-C', projectPath, ...args], { encoding: 'utf-8', timeout: 5_000, windowsHide: true });
  const ignored = git(['check-ignore', '-q', '--', `${folder}/`]);
  if (ignored.status === 0) return true;
  // 1 = not ignored; anything else (128 outside a repository, or no git) = unknown
  if (ignored.status !== 1) return false;
  const tracked = git(['ls-files', '--', folder]);
  return tracked.status === 0 && tracked.stdout.trim() === '';
}

/**
 * Walk session messages and total the reads of noise paths inside the
 * project, one entry per deny rule that covers them (see `matchNoisePath`),
 * in order of first read.
 *
 * Reads outside `projectPath` are skipped: a rule in the project's settings
 * cannot block them. Paths are matched relative to the project root, so a
 * project that itself lives under a folder named `build` is not mistaken for
 * build output. An output folder counts only when `isOutputFolder` confirms
 * it (git, by default). A read that failed (`is_error`) put no file into
 * context and is not counted.
 *
 * Each read costs what its own tool_result row holds in the classification
 * (found by tool_use id, in the session model's tokens), the figure every
 * other view of those reads uses.
 *
 * @param messages - Session messages
 * @param classified - Their classification (`breakdown.messages`)
 * @param projectPath - Project root
 * @param isOutputFolder - Confirms an output folder (default `gitOutputFolder`)
 * @returns One entry per deny rule
 */
function detectNoiseReads(
  messages: SessionMessage[],
  classified: ClassifiedMessage[],
  projectPath: string,
  isOutputFolder: (projectPath: string, folder: string) => boolean = gitOutputFolder,
): NoiseReads[] {
  const confirmed = new Map<string, boolean>();
  const confirm = (folder: string): boolean => {
    let ok = confirmed.get(folder);
    if (ok === undefined) {
      ok = isOutputFolder(projectPath, folder);
      confirmed.set(folder, ok);
    }
    return ok;
  };
  // Keyed by rule; case-folded on Windows, where Claude Code matches deny
  // rules case-insensitively, so `Node_modules` and `node_modules` share one.
  const hits = new Map<string, NoiseReads>();
  const ruleKey = (rule: string): string => (process.platform === 'win32' ? rule.toLowerCase() : rule);
  // Map tool_use_id → the read path and its rule
  const readById = new Map<string, NoiseRead & { path: string }>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    if (msg.type === 'assistant') {
      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        if (block.name !== 'Read' && block.name !== 'FileReadTool') continue;
        const raw = extractReadPath(block.input);
        if (!raw) continue;
        const path = isAbsolute(raw) ? raw : resolve(msg.cwd ?? projectPath, raw);
        const relative = projectRelativePath(projectPath, path);
        if (relative === null) continue;
        const noise = matchNoisePath(relative);
        if (!noise || !block.id) continue;
        if (noise.outputFolder !== undefined && !confirm(noise.outputFolder)) continue;
        readById.set(block.id, { ...noise, path });
      }
    } else if (msg.type === 'user') {
      for (const block of content) {
        if (block.type !== 'tool_result' || block.is_error) continue;
        const meta = readById.get(block.tool_use_id ?? '');
        if (!meta) continue;
        const tokens = resultTokens({ index: i, block, record: msg }, classified);
        const key = ruleKey(meta.rule);
        const bucket = hits.get(key)
          ?? { rule: meta.rule, label: meta.label, name: meta.name, paths: new Set<string>(), tokens: 0 };
        bucket.paths.add(meta.path);
        bucket.tokens += tokens;
        hits.set(key, bucket);
      }
    }
  }
  return [...hits.values()];
}

/** A Claude Code settings file read for a deny-rule merge. */
export type DenySettingsFile =
  | { state: 'missing' }
  | { state: 'ok'; settings: Record<string, unknown>; deny: unknown[] }
  | { state: 'invalid'; reason: string };

/**
 * Read a Claude Code settings file and check that deny rules can be merged
 * into it without losing anything.
 *
 * A missing file, or one holding only whitespace, is fine: there is nothing
 * to keep. Anything else must parse as a JSON object (a leading UTF-8 BOM is
 * stripped first) whose `permissions`, when present, is an object and whose
 * `permissions.deny`, when present, is a list; otherwise the file is reported
 * as invalid so the apply step refuses to overwrite it.
 *
 * @param path - Absolute path of the settings file
 */
export function readDenySettings(path: string): DenySettingsFile {
  if (!existsSync(path)) return { state: 'missing' };
  let raw: string;
  try {
    raw = stripBom(readFileSync(path, 'utf-8'));
  } catch (err) {
    return { state: 'invalid', reason: `it could not be read (${err instanceof Error ? err.message : String(err)})` };
  }
  if (raw.trim() === '') return { state: 'ok', settings: {}, deny: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { state: 'invalid', reason: `it is not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { state: 'invalid', reason: 'it does not hold a JSON object' };
  }
  const settings = parsed as Record<string, unknown>;
  const permissions = settings.permissions;
  if (permissions === undefined) return { state: 'ok', settings, deny: [] };
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) {
    return { state: 'invalid', reason: '"permissions" is not an object' };
  }
  const deny = (permissions as Record<string, unknown>).deny;
  if (deny === undefined) return { state: 'ok', settings, deny: [] };
  if (!Array.isArray(deny)) return { state: 'invalid', reason: '"permissions.deny" is not a list' };
  return { state: 'ok', settings, deny };
}

/**
 * Add deny rules to a parsed settings object without touching anything else.
 *
 * Every other key, every other `permissions` entry and the existing deny
 * rules (in their order) are kept; only rules not already present are
 * appended. The input object is not modified.
 *
 * @param settings - Parsed settings (as `readDenySettings` returned them)
 * @param rules - Permission rules to add, such as `Read(/**\/dist/**)`
 * @returns The merged settings and the rules that were actually added
 */
export function mergeDenyRules(
  settings: Record<string, unknown>,
  rules: string[],
): { settings: Record<string, unknown>; added: string[] } {
  const current = settings.permissions;
  const permissions = typeof current === 'object' && current !== null && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};
  const existing = Array.isArray(permissions.deny) ? permissions.deny as unknown[] : [];
  const added: string[] = [];
  for (const rule of rules) {
    if (!existing.includes(rule) && !added.includes(rule)) added.push(rule);
  }
  return {
    settings: { ...settings, permissions: { ...permissions, deny: [...existing, ...added] } },
    added,
  };
}

/**
 * Join short names for a sentence: `a`, `a and b`, `a, b and c`.
 *
 * @param names - Names in display order
 */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
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
  const top = compactTargets(waste);
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
      if (item.message_range) targets.push(`drop resolved exchange at messages #${item.message_range[0] + 1}-${item.message_range[1]}`);
    }
  }
  if (targets.length === 0) return null;
  return { text: `/compact focus "${targets.join('; ')}"`, savings };
}

/**
 * Build a CLAUDE.md append block that tells Claude not to re-read the
 * detected noise patterns in future sessions.
 *
 * Includes an explicit "recovery" note: the rules are *preferences*, not
 * hard bans. If a file under these patterns genuinely becomes relevant
 * (debugging a build artefact, auditing a lock file), Claude is free to
 * re-read it on demand, unless the read-deny fix's rules also block it
 * (those Claude Code enforces). The goal is to eliminate reflexive reads,
 * not to block needed ones.
 */
function renderClaudemdRuleAppend(labels: string[]): string {
  const lines = labels.map((l) => `- ${l}`);
  const recovery = [
    '',
    '**Recovery note:** these are preferences, not hard bans. If one of these files ',
    'becomes relevant to a specific debugging or auditing task, read it on demand, ',
    'unless a Read deny rule in the Claude Code settings blocks it. This rule only ',
    'discourages reflexive reads that silently inflate context.',
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
 *
 * `projectPath` is the folder the file fixes write to: the session's own
 * project (`AnalysisResult.projectPath`) unless the user names one. Without
 * it the read-deny and CLAUDE.md-rule fixes are not offered.
 */
export function buildOptimizeReport(
  sessionId: string,
  breakdown: CrustsBreakdown,
  waste: WasteItem[],
  configData: ConfigData,
  messages: SessionMessage[],
  projectPath: string | undefined,
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

  // 2. read-deny: noise paths read this session, blocked with Claude Code
  //    permission deny rules (Claude Code has no ignore file for Claude's reads)
  const noiseHits = projectPath ? detectNoiseReads(messages, breakdown.messages, projectPath, options.isOutputFolder) : [];
  if (projectPath && noiseHits.length > 0) {
    const settingsPath = join(projectPath, LOCAL_SETTINGS_PATH);
    const settingsFile = readDenySettings(settingsPath);
    const present = settingsFile.state === 'ok' ? settingsFile.deny : [];
    const rules: string[] = [];
    const names: string[] = [];
    const labels: string[] = [];
    const lines: string[] = [];
    let totalTokens = 0;
    for (const data of noiseHits) {
      if (present.includes(data.rule)) continue;
      rules.push(data.rule);
      names.push(data.name);
      labels.push(data.label);
      lines.push(`${data.label}: ${data.paths.size} file(s) read, ~${data.tokens.toLocaleString()} tokens`);
      totalTokens += data.tokens;
    }
    if (rules.length > 0 && totalTokens >= minSavings) {
      lines.push(
        `Adds Read deny rules to ${LOCAL_SETTINGS_PATH}, your personal settings for this project.`,
        'Claude Code will refuse to read these paths (file reads, searches, @-mentions, and shell commands such as cat that name them) and to edit or write files there.',
        'Remove the rules in /permissions or in that file to undo.',
      );
      if (existsSync(join(projectPath, '.claudeignore'))) {
        lines.push('This project\'s .claudeignore has no effect: Claude Code does not read that file.');
      }
      if (settingsFile.state === 'invalid') {
        lines.push(`${LOCAL_SETTINGS_PATH} cannot be updated yet: ${settingsFile.reason}. Fix the file first; --apply will not change it.`);
      }
      fixes.push({
        id: nextId++,
        kind: 'read-deny',
        title: `Make Claude Code refuse to read ${joinNames(names)}`,
        description: lines.join('\n'),
        estimatedSavings: totalTokens,
        action: rules.join('\n'),
        autoApplicable: true,
        applyTarget: settingsPath,
        denyRules: rules,
      });

      // 3. claudemd-rule: a prose rule in CLAUDE.md, only where the deny rules
      //    cannot apply (settings file not writable, or read-deny filtered
      //    out). Next to them it saves nothing and costs tokens every request.
      const denyUnavailable = settingsFile.state === 'invalid'
        || (options.filter !== undefined && options.filter.length > 0 && !options.filter.includes('read-deny'));
      const claudeMdPath = join(projectPath, 'CLAUDE.md');
      if (denyUnavailable && existsSync(claudeMdPath)) {
        const existingMd = readFileSync(claudeMdPath, 'utf-8');
        if (!existingMd.includes('Files to avoid reading')) {
          const ruleAppend = renderClaudemdRuleAppend(labels);
          fixes.push({
            id: nextId++,
            kind: 'claudemd-rule',
            title: 'Add "Files to avoid reading" section to CLAUDE.md',
            description: 'Asks Claude to avoid these paths in future sessions without blocking them (offered because the deny rules cannot be applied here).',
            estimatedSavings: Math.round(totalTokens / 2), // a request, not a block: count half
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

  // 5. claudemd-oversized: the CLAUDE.md files the session loads at startup
  const claudeMdThreshold = loadWasteThresholds().claudeMdOversizedThreshold
    ?? CLAUDE_MD_OVERSIZED_THRESHOLD_DEFAULT;
  const claudeMd = sessionClaudeMd(breakdown, configData);
  const claudeMdTokens = claudeMd.tokens;
  if (claudeMdTokens > claudeMdThreshold) {
    const excess = claudeMdTokens - claudeMdThreshold;
    if (excess >= minSavings) {
      const largest = claudeMd.files
        .slice(0, 3)
        .map((f) => `${claudeMdLabel(f.path)} ~${f.tokens.toLocaleString()} tokens`)
        .join(', ');
      fixes.push({
        id: nextId++,
        kind: 'claudemd-oversized',
        title: `CLAUDE.md files are ${claudeMdTokens.toLocaleString()} tokens (recommended <${claudeMdThreshold.toLocaleString()})`,
        description: `${largest ? `Largest: ${largest}. ` : ''}Large reference sections (constants tables, file-responsibility lists) are the usual candidates. ${CLAUDE_MD_SPLIT_ADVICE}`,
        estimatedSavings: excess,
        action: 'Review the CLAUDE.md files by hand; there is no safe automatic trim.',
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
  'read-deny': '\u2699',     // ⚙
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
 * Copy a file about to be modified into the backup folder as
 * `<name>.<timestamp>.bak`, then prune that name's older backups.
 *
 * @param target - Existing file about to be modified
 * @returns Path of the backup written
 */
function backupFile(target: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const originalName = basename(target);
  const backupPath = join(backupDir(), `${originalName}.${ts}.bak`);
  copyFileSync(target, backupPath);
  // On Windows, copyFileSync preserves the source file's mtime on the
  // destination (via CopyFileW). Explicitly touch the backup to "now"
  // so any mtime-based tooling (monitoring, prune fallbacks, test
  // assertions) sees the backup's actual creation time rather than the
  // target's age. Silent-fail: the primary pruning path keys off
  // filenames, not mtime, so this is belt-and-suspenders.
  try { const now = new Date(); utimesSync(backupPath, now, now); } catch { /* best-effort */ }
  pruneBackups(originalName);
  return backupPath;
}

/**
 * Apply a single fix, with optional user confirmation.
 *
 * File-modifying fixes (read-deny, claudemd-rule) are backed up to
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

  if (fix.kind === 'read-deny') return applyDenyRules(fix, options);

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
      backupPath = backupFile(fix.applyTarget);
      const prev = readFileSync(fix.applyTarget, 'utf-8');
      writeFileSync(fix.applyTarget, prev + fix.applyContent, 'utf-8');
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

/**
 * Apply a read-deny fix: merge its rules into `permissions.deny` in the
 * project's `.claude/settings.local.json`.
 *
 * The file is parsed first and left untouched when it is not a usable
 * settings object (see `readDenySettings`), so a hand-edited file with a
 * typo is reported instead of overwritten. Every other key and the existing
 * deny rules are kept, and rules already present are not added again, so a
 * second apply changes nothing (and asks nothing). An existing file is backed
 * up before the write; a missing `.claude` folder and file are created; the
 * write is atomic. Claude Code watches its settings files, so running
 * sessions pick the rules up without a restart.
 */
async function applyDenyRules(fix: OptimizeFix, options: { yes?: boolean }): Promise<ApplyResult> {
  const target = fix.applyTarget;
  const rules = fix.denyRules ?? [];
  if (!target || rules.length === 0) {
    return { fixId: fix.id, status: 'failed', message: 'Fix marked auto-applicable but missing target or rules.' };
  }
  const refuse = (reason: string): ApplyResult => ({
    fixId: fix.id,
    status: 'failed',
    target,
    message: `Did not change ${target}: ${reason}. Fix the file, then run optimize --apply again.`,
  });
  const nothingToAdd: ApplyResult = {
    fixId: fix.id,
    status: 'skipped',
    target,
    message: `The rules are already in ${target}; nothing to change.`,
  };

  const before = readDenySettings(target);
  if (before.state === 'invalid') return refuse(before.reason);
  if (mergeDenyRules(before.state === 'ok' ? before.settings : {}, rules).added.length === 0) return nothingToAdd;

  if (!options.yes) {
    const ok = await confirm(`  Apply fix #${fix.id} \u2192 ${LOCAL_SETTINGS_PATH}?`);
    if (!ok) return { fixId: fix.id, status: 'skipped' };
  }

  try {
    // Read again: the file may have changed while the prompt waited.
    const current = readDenySettings(target);
    if (current.state === 'invalid') return refuse(current.reason);
    const { settings, added } = mergeDenyRules(current.state === 'ok' ? current.settings : {}, rules);
    if (added.length === 0) return nothingToAdd;
    const backupPath = current.state === 'missing' ? undefined : backupFile(target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileAtomic(target, JSON.stringify(settings, null, 2) + '\n');
    const gitNote = current.state === 'missing'
      ? ` New file: if git lists it, add ${LOCAL_SETTINGS_PATH} to .gitignore so it stays personal.`
      : '';
    return {
      fixId: fix.id,
      status: 'applied',
      target,
      backup: backupPath,
      message: `Added ${added.length} deny rule(s). Claude Code picks them up without a restart.${gitNote}`,
    };
  } catch (err) {
    return {
      fixId: fix.id,
      status: 'failed',
      target,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
