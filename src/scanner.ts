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
import { CORE_TOOL_NAMES, LEGACY_CORE_SCHEMA_TOKENS, mcpServerName } from './built-in-tools.ts';
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
const ANALYZED_RECORD_TYPES: ReadonlySet<string> = new Set(['user', 'assistant', 'system', 'attachment']);

/** Model marker Claude Code writes on placeholder assistant records */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * Decide whether one parsed JSONL record takes part in context analysis.
 *
 * Keeps exactly the records that are part of the API conversation:
 *   - `user` and `assistant` turns
 *   - `attachment` records — per-turn context Claude Code injects into the
 *     request (hook output, skill/tool/agent listings, task reminders,
 *     nested CLAUDE.md, auto-loaded files, IDE context). They are real
 *     window content; the classifier maps `attachment.type` to a category
 *     and estimates their tokens from the payload text.
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
 * Parse a JSON file into a plain object, tolerating absence and corruption.
 *
 * @param path - Absolute path to the JSON file
 * @returns The parsed object, or null when missing / unreadable / not an object
 */
function readJsonRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupted config -- treat as absent
  }
  return null;
}

/**
 * Extract the server names from a parsed `mcpServers` config value.
 *
 * @param value - The `mcpServers` value from a config file
 * @returns Object keys, or an empty array when the value is not an object
 */
function mcpServerNamesFrom(value: unknown): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

/**
 * Normalise a filesystem path for comparison across slash styles.
 *
 * ~/.claude.json keys project paths with forward slashes while callers
 * often hold backslash paths on Windows; compare them case-insensitively
 * with a single separator style.
 *
 * @param path - Path in either slash style
 * @returns Lower-cased forward-slash form without a trailing separator
 */
function normalizePathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** One install record inside ~/.claude/plugins/installed_plugins.json */
interface PluginInstall {
  plugin: string;
  installPath: string;
}

/**
 * Read the installed-plugin registry and resolve each install's cache path.
 *
 * User-scoped installs always apply; project-scoped installs apply only
 * when their recorded `projectPath` matches the analyzed project (both
 * slash styles accepted). Installs whose cache directory no longer exists
 * are skipped.
 *
 * @param projectPath - The analyzed project directory, when known
 * @returns One entry per applicable install with the bare plugin name
 */
function readInstalledPlugins(projectPath?: string): PluginInstall[] {
  const registry = readJsonRecord(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'));
  const plugins = registry?.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return [];

  const installs: PluginInstall[] = [];
  const projectKey = projectPath ? normalizePathKey(projectPath) : null;
  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    // Keys look like `vercel@claude-plugins-official` -- the bare plugin
    // name is what tool names embed (`mcp__plugin_vercel_vercel__*`).
    const plugin = key.split('@')[0];
    if (!plugin || !Array.isArray(value)) continue;
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const install = entry as { scope?: unknown; installPath?: unknown; projectPath?: unknown };
      if (typeof install.installPath !== 'string' || install.installPath.length === 0) continue;
      if (install.scope === 'project') {
        if (!projectKey || typeof install.projectPath !== 'string') continue;
        if (normalizePathKey(install.projectPath) !== projectKey) continue;
      }
      if (!existsSync(install.installPath)) continue;
      installs.push({ plugin, installPath: install.installPath });
    }
  }
  return installs;
}

/**
 * Read MCP server configurations from every location Claude Code uses.
 *
 * Discovery order (first occurrence of a name wins):
 * 1. ~/.claude/settings.json `mcpServers` (legacy location) -- 'global'
 * 2. ~/.claude.json `mcpServers` -- 'global'
 * 3. ~/.claude.json `projects[<projectPath>].mcpServers` -- 'project'
 *    (project keys matched across slash styles)
 * 4. installed plugins' <installPath>/.mcp.json, named
 *    `plugin_<plugin>_<server>` to match their tool-name prefix -- 'plugin'
 * 5. <projectPath>/.mcp.json -- 'project'
 * 6. servers observed in the session itself (`mcp__<server>__` tool-name
 *    prefixes; see `collectObservedMcpServers`) -- 'observed'
 *
 * MCP schemas are deferred, so every server carries a 0-token upfront cost
 * (`MCP_TOKENS_PER_TOOL`); the classifier charges ToolSearch loads.
 *
 * @param projectPath - Path to the project directory
 * @param observedServers - Server names observed in the session JSONL
 * @returns Array of MCPServerInfo objects, deduped by name
 */
export function readMCPConfig(projectPath?: string, observedServers?: string[]): MCPServerInfo[] {
  const servers: MCPServerInfo[] = [];
  const push = (name: string, source: MCPServerInfo['source']): void => {
    if (servers.some((s) => s.name === name)) return;
    servers.push({ name, toolCount: null, estimatedSchemaTokens: MCP_TOKENS_PER_TOOL, source });
  };

  // 1. Legacy global settings
  const settings = readJsonRecord(join(homedir(), '.claude', 'settings.json'));
  for (const name of mcpServerNamesFrom(settings?.mcpServers)) push(name, 'global');

  // 2 + 3. ~/.claude.json -- where current Claude Code keeps MCP servers
  const claudeJson = readJsonRecord(join(homedir(), '.claude.json'));
  for (const name of mcpServerNamesFrom(claudeJson?.mcpServers)) push(name, 'global');
  if (projectPath && claudeJson?.projects && typeof claudeJson.projects === 'object' && !Array.isArray(claudeJson.projects)) {
    const wanted = normalizePathKey(projectPath);
    for (const [key, value] of Object.entries(claudeJson.projects as Record<string, unknown>)) {
      if (normalizePathKey(key) !== wanted) continue;
      const project = value as { mcpServers?: unknown } | null;
      for (const name of mcpServerNamesFrom(project?.mcpServers)) push(name, 'project');
    }
  }

  // 4. Installed plugins' bundled MCP servers
  for (const install of readInstalledPlugins(projectPath)) {
    const pluginMcp = readJsonRecord(join(install.installPath, '.mcp.json'));
    for (const name of mcpServerNamesFrom(pluginMcp?.mcpServers)) {
      push('plugin_' + install.plugin + '_' + name, 'plugin');
    }
  }

  // 5. Project-level MCP config
  if (projectPath) {
    const mcpConfig = readJsonRecord(join(projectPath, '.mcp.json'));
    for (const name of mcpServerNamesFrom(mcpConfig?.mcpServers)) push(name, 'project');
  }

  // 6. Servers the session itself proves were connected
  for (const name of observedServers ?? []) push(name, 'observed');

  return servers;
}

/**
 * Read the configured `model` from Claude Code settings files.
 *
 * Claude Code strips the `[1m]` variant from the model IDs it records in
 * the JSONL, but settings.json keeps it, so the configured model is a
 * context-window signal (see `detectSettingsContextLimit` in
 * model-context.ts). Returned highest precedence first: project
 * .claude/settings.local.json, project .claude/settings.json, then
 * ~/.claude/settings.json. Missing files, corrupt JSON, and non-string
 * `model` fields are skipped.
 *
 * @param projectPath - Optional project directory for project-level settings
 * @returns Configured model IDs, highest precedence first (may be empty)
 */
export function readSettingsModels(projectPath?: string): string[] {
  const models: string[] = [];
  const push = (record: Record<string, unknown> | null): void => {
    if (record && typeof record.model === 'string' && record.model.trim() !== '') {
      models.push(record.model.trim());
    }
  };
  if (projectPath) {
    push(readJsonRecord(join(projectPath, '.claude', 'settings.local.json')));
    push(readJsonRecord(join(projectPath, '.claude', 'settings.json')));
  }
  push(readJsonRecord(join(homedir(), '.claude', 'settings.json')));
  return models;
}

/**
 * Collect the MCP server names a session's JSONL proves were connected.
 *
 * Scans assistant `tool_use` block names and `deferred_tools_delta`
 * attachment listings for Anthropic's `mcp__<server>__<tool>` prefix. The
 * JSONL is authoritative: config files may be absent or stale, but a
 * recorded tool name or deferred listing means the server was connected.
 *
 * @param messages - Parsed session messages
 * @returns Distinct server names in first-seen order
 */
export function collectObservedMcpServers(messages: SessionMessage[]): string[] {
  const servers = new Set<string>();
  const add = (name: unknown): void => {
    if (typeof name !== 'string') return;
    const server = mcpServerName(name);
    if (server) servers.add(server);
  };

  for (const msg of messages) {
    if (msg.type === 'attachment' && msg.attachment?.type === 'deferred_tools_delta') {
      for (const value of [msg.attachment.addedNames, msg.attachment.readdedNames]) {
        if (!Array.isArray(value)) continue;
        for (const name of value) add(name);
      }
      continue;
    }
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use') add(block.name);
    }
  }
  return [...servers];
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
 * Read memory files from every location Claude Code uses.
 *
 * Current Claude Code keeps per-project auto-memory at
 * `~/.claude/projects/<projectSlug>/memory/MEMORY.md`; the legacy memdir
 * locations (`~/.claude/memdir/`, `<project>/.claude/memdir/`) are still
 * scanned for old installs. `files` lists each MEMORY.md plus the topic
 * files it links.
 *
 * `totalEstimatedTokens` counts ONLY the MEMORY.md index files: that is
 * what Claude Code injects into the fixed context at session start. Linked
 * topic files load on demand during the session (they arrive as `file`
 * attachment records, which the classifier already counts as Retrieved),
 * so summing them here would double-count and break the fixed-context
 * derivation.
 *
 * @param projectPath - Optional project directory; when provided, also scans
 *   `<projectPath>/.claude/memdir/` for legacy project-scoped memory.
 * @param projectSlug - Optional encoded project dir name (the session file's
 *   parent directory name), used for `~/.claude/projects/<slug>/memory/`.
 * @returns Object with individual file summaries and the injected-at-start
 *   token estimate
 */
export function readMemoryFiles(projectPath?: string, projectSlug?: string): {
  files: MemoryFileSummary[];
  totalEstimatedTokens: number;
} {
  const globalMemdir = join(homedir(), '.claude', 'memdir');
  const files: MemoryFileSummary[] = [...readMemdirAt(globalMemdir, 'global')];

  if (projectSlug) {
    const projectMemoryDir = join(homedir(), '.claude', 'projects', projectSlug, 'memory');
    files.push(...readMemdirAt(projectMemoryDir, 'project'));
  }

  if (projectPath) {
    const projectMemdir = join(projectPath, '.claude', 'memdir');
    files.push(...readMemdirAt(projectMemdir, 'project'));
  }

  const totalEstimatedTokens = files.reduce(
    (sum, f) => sum + (basename(f.path) === 'MEMORY.md' ? f.estimatedTokens : 0),
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
 * Estimate the listing cost of one skill from its SKILL.md frontmatter.
 *
 * The session's skill listing carries each skill's name plus its
 * frontmatter description, not the SKILL.md body (bodies load on invoke),
 * so the estimate is name + description at chars/4 with a
 * `DEFAULT_SKILL_TOKENS` floor.
 *
 * @param skillMdPath - Absolute path to the SKILL.md file
 * @param name - Skill name as it appears in the listing
 * @returns Estimated listing tokens for this skill
 */
function estimateSkillListingTokens(skillMdPath: string, name: string): number {
  try {
    const head = readFileSync(skillMdPath, 'utf-8').slice(0, 4096);
    const match = head.match(/^description:\s*(.+)$/m);
    if (match?.[1]) {
      return Math.max(
        DEFAULT_SKILL_TOKENS,
        estimateTokensFromText(name + ': ' + match[1]),
      );
    }
  } catch {
    // Unreadable SKILL.md -- fall through to the flat estimate
  }
  return DEFAULT_SKILL_TOKENS;
}

/**
 * List the skill directories (those containing a SKILL.md) under a path.
 *
 * @param skillsDir - Directory whose children are candidate skill dirs
 * @returns Pairs of skill dir name and absolute SKILL.md path
 */
function listSkillDirs(skillsDir: string): Array<{ name: string; skillMdPath: string }> {
  if (!existsSync(skillsDir)) return [];
  const found: Array<{ name: string; skillMdPath: string }> = [];
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = join(skillsDir, entry.name, 'SKILL.md');
      if (existsSync(skillMdPath)) found.push({ name: entry.name, skillMdPath });
    }
  } catch {
    // Unreadable skills dir -- treat as empty
  }
  return found;
}

/**
 * Discover Claude Code skills from settings, skill dirs, and plugins.
 *
 * Discovery order (first occurrence of a name wins):
 * 1. `skills` keys in `~/.claude/settings.json` / project settings (legacy)
 * 2. `~/.claude/skills/<name>/SKILL.md` directories -- 'global'
 * 3. installed plugins' <installPath>/skills/<name>/SKILL.md, named
 *    `<plugin>:<name>` to match Claude Code's listing -- 'plugin'
 *
 * Note the session's own `skill_listing` attachment, when present, is
 * preferred over this discovery by the classifier (it is the authoritative
 * record of what that session actually loaded).
 *
 * @param projectPath - Optional project directory
 * @returns Array of SkillInfo objects, deduped by name
 */
export function readSkillsConfig(projectPath?: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const push = (name: string, source: SkillInfo['source'], estimatedTokens: number): void => {
    if (skills.some((s) => s.name === name)) return;
    skills.push({ name, source, estimatedTokens });
  };

  // 1. Legacy settings.json `skills` keys
  const settings = readJsonRecord(join(homedir(), '.claude', 'settings.json'));
  for (const name of extractSkillNames(settings?.skills)) {
    push(name, 'global', DEFAULT_SKILL_TOKENS);
  }
  if (projectPath) {
    const projectSettings = readJsonRecord(join(projectPath, '.claude', 'settings.json'));
    for (const name of extractSkillNames(projectSettings?.skills)) {
      push(name, 'project', DEFAULT_SKILL_TOKENS);
    }
  }

  // 2. User skill directories
  for (const { name, skillMdPath } of listSkillDirs(join(homedir(), '.claude', 'skills'))) {
    push(name, 'global', estimateSkillListingTokens(skillMdPath, name));
  }

  // 3. Installed plugins' bundled skills
  for (const install of readInstalledPlugins(projectPath)) {
    for (const { name, skillMdPath } of listSkillDirs(join(install.installPath, 'skills'))) {
      const qualified = install.plugin + ':' + name;
      push(qualified, 'plugin', estimateSkillListingTokens(skillMdPath, qualified));
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
