/**
 * JSONL file and config file discovery and parsing.
 *
 * Discovers session files at ~/.claude/projects/, reads MCP configs,
 * memory files, and system prompt files. Streams JSONL lines for
 * memory-efficient parsing of large session files.
 */

import { homedir } from 'os';
import { join, basename, dirname } from 'path';
import { createReadStream, existsSync, statSync, readdirSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import chalk from 'chalk';
import type {
  SessionMessage,
  SessionInfo,
  FileContent,
  MCPServerInfo,
  MemoryFileSummary,
  SkillInfo,
} from './types.ts';
import { BUILT_IN_TOOLS, TOTAL_BUILTIN_TOOL_TOKENS } from './built-in-tools.ts';
import type { BuiltInTool } from './built-in-tools.ts';

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

/**
 * Stream-parse a JSONL session file line by line.
 *
 * Snapshots the file size at open time and only reads up to that byte
 * offset. This ensures that when CRUSTS is invoked from within Claude
 * Code (as a Bash tool call), any messages appended to the JSONL during
 * the analysis itself are excluded.
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

      // Skip non-message types we don't analyze
      const type = parsed.type as string;
      if (type === 'file-history-snapshot' || type === 'progress' || type === 'last-prompt') {
        continue;
      }

      // Filter out synthetic messages (session exit/resume artifacts)
      if (type === 'assistant' && parsed.model === '<synthetic>') {
        continue;
      }

      // Accept user, assistant, and system types
      if (type === 'user' || type === 'assistant' || type === 'system') {
        messages.push(parsed as unknown as SessionMessage);
      }
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
 * Get the hardcoded list of built-in Claude Code tools.
 *
 * Returns the known ~40 built-in tools with their names and estimated
 * schema token costs. Total is approximately 11,600 tokens.
 *
 * @returns Object with tool list and total token estimate
 */
export function getBuiltInToolList(): {
  tools: BuiltInTool[];
  totalEstimatedTokens: number;
} {
  return {
    tools: BUILT_IN_TOOLS,
    totalEstimatedTokens: TOTAL_BUILTIN_TOOL_TOKENS,
  };
}
