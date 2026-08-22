/**
 * JSONL file and config file discovery and parsing.
 *
 * Discovers session files at ~/.claude/projects/, reads MCP configs,
 * memory files, and system prompt files. Streams JSONL lines for
 * memory-efficient parsing of large session files.
 */

import { homedir } from 'os';
import { join, basename, dirname } from 'path';
import {
  createReadStream,
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
  openSync,
  readSync,
  closeSync,
} from 'fs';
import { createInterface } from 'readline';
import { StringDecoder } from 'string_decoder';
import chalk from 'chalk';
import type {
  SessionMessage,
  SessionInfo,
  FileContent,
  MCPServerInfo,
  MemoryFileSummary,
  SkillInfo,
  ConfigData,
} from './types.ts';
import { CORE_TOOL_NAMES, LEGACY_CORE_SCHEMA_TOKENS } from './built-in-tools.ts';
import { loadCoreSchemaOverride } from './calibrator.ts';

/** Average tokens per character (rough English text heuristic) */
const CHARS_PER_TOKEN = 4;

/** MCP tools are loaded on-demand (deferred) — upfront schema cost is 0 */
const MCP_TOKENS_PER_TOOL = 0;

// ---------------------------------------------------------------------------
// PART A: Session Discovery
// ---------------------------------------------------------------------------

/**
 * Discover all JSONL session files under the Claude Code projects directory.
 *
 * Walks ~/.claude/projects/ (or a custom base path) to find .jsonl files,
 * skipping subagent files. Returns session metadata sorted by most recent first.
 *
 * @param basePath - Override the default ~/.claude/projects/ path
 * @returns Array of SessionInfo objects sorted by modifiedAt descending
 */
export function discoverSessions(basePath?: string): SessionInfo[] {
  const base = basePath ?? join(homedir(), '.claude', 'projects');

  if (!existsSync(base)) {
    console.error(
      chalk.red('Claude Code sessions not found. Is Claude Code installed?')
    );
    console.error(chalk.dim(`  Expected path: ${base}`));
    return [];
  }

  const sessions: SessionInfo[] = [];
  let projectDirs: string[];

  try {
    projectDirs = readdirSync(base);
  } catch {
    console.error(chalk.red(`Cannot read directory: ${base}`));
    return [];
  }

  for (const project of projectDirs) {
    const projectDir = join(base, project);
    let entries: string[];

    try {
      const stat = statSync(projectDir);
      if (!stat.isDirectory()) continue;
      entries = readdirSync(projectDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;

      const filePath = join(projectDir, entry);
      try {
        const stat = statSync(filePath);
        sessions.push({
          id: basename(entry, '.jsonl'),
          path: filePath,
          project,
          modifiedAt: stat.mtime,
          sizeBytes: stat.size,
          claudeCodeVersion: readClaudeCodeVersion(filePath),
        });
      } catch {
        continue;
      }
    }
  }

  if (sessions.length === 0) {
    console.error(
      chalk.yellow('No sessions found. Run a Claude Code session first.')
    );
  }

  sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return sessions;
}

/** Bytes read per probe step while looking for the first versioned record */
const VERSION_PROBE_CHUNK_BYTES = 64 * 1024;

/** Upper bound on bytes scanned for a version before giving up */
export const VERSION_PROBE_MAX_BYTES = 1024 * 1024;

/**
 * Extract a non-empty `version` string from one parsed JSONL record.
 *
 * @param record - JSON-parsed record
 * @returns The version, or undefined when absent or empty
 */
function recordVersion(record: unknown): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const version = (record as { version?: unknown }).version;
  return typeof version === 'string' && version.length > 0 ? version : undefined;
}

/**
 * Claude Code version that wrote a parsed session: the first record that
 * carries a non-empty `version` field.
 *
 * Every API-conversation record (user, assistant, system, attachment)
 * carries the version of the Claude Code build that appended it, so the
 * first one is the version the session started on.
 *
 * @param messages - Parsed session messages in file order
 * @returns Version string (e.g. `2.1.239`), or undefined when none is present
 */
export function detectClaudeCodeVersion(messages: SessionMessage[]): string | undefined {
  for (const msg of messages) {
    const version = recordVersion(msg);
    if (version) return version;
  }
  return undefined;
}

/**
 * Read the Claude Code version from the head of a session file without
 * parsing the whole file.
 *
 * Real files open with a few small unversioned bookkeeping records
 * (`last-prompt`, `mode`, `permission-mode`) before the first versioned
 * record, which is usually a SessionStart hook attachment that can be tens
 * of KB. The probe reads 64 KB chunks, parses each complete line, and stops
 * at the first version found or after `VERSION_PROBE_MAX_BYTES`, so
 * `discoverSessions` stays cheap on multi-MB files.
 *
 * @param filePath - Absolute path to the .jsonl file
 * @returns Version string, or undefined when none is found in the probed head
 */
export function readClaudeCodeVersion(filePath: string): string | undefined {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const chunk = Buffer.alloc(VERSION_PROBE_CHUNK_BYTES);
    // StringDecoder carries a multi-byte sequence split across chunks
    // instead of emitting a replacement char that would break that line.
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let position = 0;

    while (position < VERSION_PROBE_MAX_BYTES) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      pending += decoder.write(chunk.subarray(0, bytesRead));

      const lines = pending.split('\n');
      // The last element is either an incomplete line or '' after a newline.
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.includes('"version"')) continue;
        try {
          const version = recordVersion(JSON.parse(line));
          if (version) return version;
        } catch {
          // Malformed line: keep probing
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to recover from a failed close on a read-only handle
      }
    }
  }
}

/** Record types that carry conversation the model actually receives */
const ANALYZED_RECORD_TYPES: ReadonlySet<string> = new Set(['user', 'assistant', 'system']);

/** Model marker Claude Code writes on placeholder assistant records */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * Decide whether one parsed JSONL record takes part in context analysis.
 *
 * Keeps exactly the records that are part of the API conversation:
 *   - `user` and `assistant` turns
 *   - `system` records ONLY when `subtype === 'compact_boundary'`. Every
 *     other system subtype (turn_duration, api_error, away_summary,
 *     local_command, scheduled_task_fire, model_refusal_fallback, ...) is
 *     transcript bookkeeping that never reaches the model; keeping them
 *     inflated message counts and spread framing overhead over phantom rows.
 *
 * Drops placeholder assistants even when their type matches:
 *   - `message.model === '<synthetic>'` ("No response requested.", API error
 *     stand-ins). The marker lives on `message.model`; no record carries a
 *     top-level `model` key, which is why the old top-level check never fired.
 *   - `isApiErrorMessage === true`, the explicit flag on API error placeholders.
 *
 * Everything else (progress, last-prompt, file-history-snapshot, queue
 * operations, mode changes, ...) is not conversation and is ignored.
 *
 * @param parsed - One JSON-parsed JSONL line
 * @returns True when the record should be pushed into the session message list
 */
export function isAnalyzedRecord(parsed: Record<string, unknown>): boolean {
  const type = parsed.type;
  if (typeof type !== 'string' || !ANALYZED_RECORD_TYPES.has(type)) return false;

  if (type === 'system') {
    return parsed.subtype === 'compact_boundary';
  }

  if (parsed.isApiErrorMessage === true) return false;

  const message = parsed.message as { model?: unknown } | undefined;
  if (message && typeof message === 'object' && message.model === SYNTHETIC_MODEL) {
    return false;
  }

  return true;
}

/**
 * Stream-parse a JSONL session file line by line.
 *
 * Snapshots the file size at open time and only reads up to that byte
 * offset. This ensures that when CRUSTS is invoked from within Claude
 * Code (as a Bash tool call), any messages appended to the JSONL during
 * the analysis itself are excluded.
 *
 * Two parse-time filters keep the result honest:
 *   - Resume replays: resuming a session re-appends whole branches with
 *     their original `uuid`s (a compact_boundary plus hundreds of assistant
 *     records in real files). The first occurrence of a uuid wins; every
 *     later copy is skipped. Records without a uuid are never deduplicated.
 *   - Record selection: see `isAnalyzedRecord` for which types survive.
 *
 * Malformed lines are skipped with a warning logged to stderr.
 *
 * @param filePath - Absolute path to the .jsonl file
 * @returns Promise resolving to an array of parsed SessionMessage objects
 */
export async function parseSession(filePath: string): Promise<SessionMessage[]> {
  if (!existsSync(filePath)) {
    console.error(chalk.red(`Session file not found: ${filePath}`));
    return [];
  }

  // Snapshot file size BEFORE reading — anything appended after this
  // point (e.g. tool_result from this very CRUSTS run) is ignored.
  const snapshotSize = statSync(filePath).size;

  const messages: SessionMessage[] = [];
  const seenUuids = new Set<string>();
  let lineNumber = 0;
  let skippedLines = 0;

  const stream = createReadStream(filePath, {
    encoding: 'utf-8',
    end: snapshotSize - 1,
  });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    lineNumber++;
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;

      // Resume replays: first occurrence of a uuid wins, later copies skipped.
      const uuid = parsed.uuid;
      if (typeof uuid === 'string' && uuid.length > 0) {
        if (seenUuids.has(uuid)) continue;
        seenUuids.add(uuid);
      }

      if (!isAnalyzedRecord(parsed)) continue;

      messages.push(parsed as unknown as SessionMessage);
    } catch {
      skippedLines++;
    }
  }

  if (skippedLines > 0) {
    console.error(
      chalk.dim(`  Skipped ${skippedLines} malformed line(s) in ${basename(filePath)}`)
    );
  }

  return messages;
}

/**
 * Get the most recent session file.
 *
 * Convenience wrapper around discoverSessions that returns only the
 * latest session by modification time.
 *
 * @param basePath - Override the default session directory
 * @returns The most recent SessionInfo, or null if none found
 */
export function getLatestSession(basePath?: string): SessionInfo | null {
  const sessions = discoverSessions(basePath);
  return sessions[0] ?? null;
}

// ---------------------------------------------------------------------------
// PART B: Config & Context File Reading
// ---------------------------------------------------------------------------

/**
 * Estimate tokens from a string using the chars/4 heuristic.
 *
 * @param text - The text to estimate
 * @returns Estimated token count
 */
function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Safely read a file and return its content with token estimate.
 *
 * @param filePath - Absolute path to the file
 * @returns FileContent with content and token estimate, or empty if missing
 */
function safeReadFile(filePath: string): FileContent {
  if (!existsSync(filePath)) {
    return { path: filePath, content: '', estimatedTokens: 0, exists: false };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return {
      path: filePath,
      content,
      estimatedTokens: estimateTokensFromText(content),
      exists: true,
    };
  } catch {
    return { path: filePath, content: '', estimatedTokens: 0, exists: false };
  }
}

/**
 * Read system prompt files (CLAUDE.md, settings) and estimate their token cost.
 *
 * Reads the user-level and project-level CLAUDE.md files, plus any
 * project-level .claude/settings.json. Returns each file's content
 * and a total token estimate for the System category.
 *
 * @param projectPath - Path to the project directory (for project-level files)
 * @returns Object with individual file contents and total estimated tokens
 */
export function readSystemPromptFiles(projectPath?: string): {
  files: FileContent[];
  totalEstimatedTokens: number;
} {
  const files: FileContent[] = [];

  // User-level CLAUDE.md
  files.push(safeReadFile(join(homedir(), '.claude', 'CLAUDE.md')));

  // Project-level files
  if (projectPath) {
    files.push(safeReadFile(join(projectPath, 'CLAUDE.md')));
    files.push(safeReadFile(join(projectPath, '.claude', 'settings.json')));
  }

  const existing = files.filter((f) => f.exists);
  const totalEstimatedTokens = existing.reduce(
    (sum, f) => sum + f.estimatedTokens,
    0
  );

  return { files: existing, totalEstimatedTokens };
}

/**
 * Read MCP server configurations from global and project settings.
 *
 * Parses ~/.claude/settings.json and <project>/.mcp.json to discover
 * configured MCP servers. Estimates schema token cost based on the
 * number of tools each server exposes.
 *
 * @param projectPath - Path to the project directory
 * @returns Array of MCPServerInfo objects
 */
export function readMCPConfig(projectPath?: string): MCPServerInfo[] {
  const servers: MCPServerInfo[] = [];

  // Global settings
  const globalSettingsPath = join(homedir(), '.claude', 'settings.json');
  if (existsSync(globalSettingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(globalSettingsPath, 'utf-8'));
      const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
      if (mcpServers && typeof mcpServers === 'object') {
        for (const name of Object.keys(mcpServers)) {
          servers.push({
            name,
            toolCount: null,
            estimatedSchemaTokens: MCP_TOKENS_PER_TOOL, // 1 tool minimum estimate
            source: 'global',
          });
        }
      }
    } catch {
      // Skip corrupted settings
    }
  }

  // Project-level MCP config
  if (projectPath) {
    const mcpJsonPath = join(projectPath, '.mcp.json');
    if (existsSync(mcpJsonPath)) {
      try {
        const mcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
        const mcpServers = mcpConfig.mcpServers as Record<string, unknown> | undefined;
        if (mcpServers && typeof mcpServers === 'object') {
          for (const name of Object.keys(mcpServers)) {
            // Don't duplicate if already in global
            if (!servers.some((s) => s.name === name)) {
              servers.push({
                name,
                toolCount: null,
                estimatedSchemaTokens: MCP_TOKENS_PER_TOOL,
                source: 'project',
              });
            }
          }
        }
      } catch {
        // Skip corrupted MCP config
      }
    }
  }

  return servers;
}

/**
 * Read MEMORY.md and its linked files from a single memdir directory.
 *
 * Helper for `readMemoryFiles`. Returns files tagged with the supplied source.
 *
 * @param memdir - Absolute path to the memdir directory
 * @param source - Whether this is the global or project-scoped memdir
 * @returns Array of MemoryFileSummary records
 */
function readMemdirAt(memdir: string, source: 'global' | 'project'): MemoryFileSummary[] {
  const files: MemoryFileSummary[] = [];
  if (!existsSync(memdir)) return files;

  const memoryMdPath = join(memdir, 'MEMORY.md');
  if (!existsSync(memoryMdPath)) return files;

  try {
    const stat = statSync(memoryMdPath);
    const content = readFileSync(memoryMdPath, 'utf-8');
    files.push({
      path: memoryMdPath,
      sizeBytes: stat.size,
      estimatedTokens: estimateTokensFromText(content),
      source,
    });

    const linkPattern = /\[.*?\]\(([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = linkPattern.exec(content)) !== null) {
      const refPath = join(memdir, match[1]!);
      if (existsSync(refPath)) {
        try {
          const refStat = statSync(refPath);
          if (!refStat.isFile()) continue;
          const refContent = readFileSync(refPath, 'utf-8');
          files.push({
            path: refPath,
            sizeBytes: refStat.size,
            estimatedTokens: estimateTokensFromText(refContent),
            source,
          });
        } catch {
          // skip unreadable files
        }
      }
    }
  } catch {
    // skip if unreadable
  }

  return files;
}

/**
 * Read memory files from the global and (optionally) project-scoped memdirs.
 *
 * Counts MEMORY.md and files referenced from it. Claude Code loads memory
 * on-demand, so this produces a conservative estimate that matches /context
 * ground truth (~1.8K tokens for typical sessions).
 *
 * @param projectPath - Optional project directory; when provided, also scans
 *   `<projectPath>/.claude/memdir/` for project-scoped memory.
 * @returns Object with individual file summaries and total estimated tokens
 */
export function readMemoryFiles(projectPath?: string): {
  files: MemoryFileSummary[];
  totalEstimatedTokens: number;
} {
  const globalMemdir = join(homedir(), '.claude', 'memdir');
  const files: MemoryFileSummary[] = [...readMemdirAt(globalMemdir, 'global')];

  if (projectPath) {
    const projectMemdir = join(projectPath, '.claude', 'memdir');
    files.push(...readMemdirAt(projectMemdir, 'project'));
  }

  const totalEstimatedTokens = files.reduce(
    (sum, f) => sum + f.estimatedTokens,
    0,
  );

  return { files, totalEstimatedTokens };
}

/** Per-skill token estimate when no token cost is recorded in settings.json */
const DEFAULT_SKILL_TOKENS = 60;

/**
 * Pull skill names out of a parsed `skills` value in settings.json.
 *
 * Tolerates several shapes seen in the wild: array of strings, array of
 * objects with `name`, or an object keyed by skill name.
 *
 * @param raw - The parsed `skills` value from settings.json
 * @returns Array of skill names (may be empty)
 */
function extractSkillNames(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
          return (entry as { name: string }).name;
        }
        return null;
      })
      .filter((n): n is string => !!n);
  }
  if (typeof raw === 'object') {
    return Object.keys(raw as Record<string, unknown>);
  }
  return [];
}

/**
 * Discover Claude Code skills configured in global and project settings.
 *
 * Mirrors the structure of `readMCPConfig`. Reads `~/.claude/settings.json`
 * and `<projectPath>/.claude/settings.json` for a `skills` key. Each skill is
 * given a flat token estimate (`DEFAULT_SKILL_TOKENS`); the classifier sums
 * the discovered tokens to replace the legacy hardcoded constant.
 *
 * @param projectPath - Optional project directory
 * @returns Array of SkillInfo objects, deduped by name
 */
export function readSkillsConfig(projectPath?: string): SkillInfo[] {
  const skills: SkillInfo[] = [];

  const globalSettingsPath = join(homedir(), '.claude', 'settings.json');
  if (existsSync(globalSettingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(globalSettingsPath, 'utf-8'));
      for (const name of extractSkillNames(settings.skills)) {
        skills.push({ name, source: 'global', estimatedTokens: DEFAULT_SKILL_TOKENS });
      }
    } catch {
      // Skip corrupted settings
    }
  }

  if (projectPath) {
    const projectSettingsPath = join(projectPath, '.claude', 'settings.json');
    if (existsSync(projectSettingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(projectSettingsPath, 'utf-8'));
        for (const name of extractSkillNames(settings.skills)) {
          if (!skills.some((s) => s.name === name)) {
            skills.push({ name, source: 'project', estimatedTokens: DEFAULT_SKILL_TOKENS });
          }
        }
      } catch {
        // Skip corrupted settings
      }
    }
  }

  return skills;
}

/**
 * Get the core built-in tool catalogue for the classifier.
 *
 * Returns the always-loaded tool names (`CORE_TOOL_NAMES`), the legacy
 * baseline schema cost, and any calibration override saved by
 * `claude-crusts calibrate`. The effective per-session cost is resolved in
 * the classifier from the session's Claude Code version, so the baseline
 * here only applies to unversioned (pre-2.1.150) sessions.
 *
 * @returns Core tool names, legacy baseline tokens, and the calibration override (null when none)
 */
export function getBuiltInToolList(): ConfigData['builtInTools'] {
  return {
    tools: [...CORE_TOOL_NAMES],
    totalEstimatedTokens: LEGACY_CORE_SCHEMA_TOKENS,
    coreSchemaOverride: loadCoreSchemaOverride(),
  };
}
