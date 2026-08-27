/**
 * Built-in tool catalogue for Claude Code.
 *
 * Claude Code splits its built-in tools into two groups:
 *
 *   - CORE tools are always in the request's `tools` array. Their schema
 *     text is the /context "System tools" row. It is a fixed per-version
 *     tax the user cannot prune, and it is NOT written to the JSONL, so
 *     it is modelled as one version-keyed constant
 *     (`CORE_SCHEMA_TOKENS_BY_VERSION`) rather than per-tool guesses.
 *   - DEFERRED tools (WebSearch, WebFetch, Cron*, Monitor, SendMessage,
 *     every MCP tool, ...) cost 0 until a `ToolSearch` call loads them.
 *     Claude Code records the deferred name list in
 *     `deferred_tools_delta` attachment records and each load as a
 *     ToolSearch tool_result (`toolUseResult.matches` plus
 *     `tool_reference` blocks). A loaded schema then stays in the window
 *     and, for built-ins, migrates into the /context "System tools" row.
 *
 * Ground truth (pasted /context tables found in session files, 33 tables
 * across Claude Code 2.1.150 to 2.1.220): "System tools" 14.3k-15.9k on
 * 2.1.150, 16.5k-19.4k on 2.1.160-2.1.181, 20.1k-22.8k on 2.1.214-2.1.220.
 * Rows captured after ToolSearch loads include the loaded built-ins, so the
 * table below takes the MINIMUM observed per version band (the pre-load
 * core cost). A saved `claude-crusts calibrate` override always wins.
 *
 * How to re-verify when Claude Code changes its tool set:
 *   1. Open a fresh Claude Code session, run /context BEFORE any ToolSearch
 *      call, and copy the markdown table.
 *   2. Run `claude-crusts calibrate` and paste it. The "System tools" row is
 *      persisted as `core_schema_tokens_override` and overrides this table.
 *   3. If the row differs from `lookupCoreSchemaTokens(<version>)` by more
 *      than ~5%, add a new band to `CORE_SCHEMA_TOKENS_BY_VERSION`.
 */

/**
 * Names of the always-loaded (core) built-in tools.
 *
 * Names only, no per-tool token guesses: the schema text never reaches the
 * JSONL, so per-tool sizes cannot be measured from sessions. Observed as
 * invoked WITHOUT a preceding ToolSearch load across 8 sessions on Claude
 * Code 2.1.92 to 2.1.239 (PowerShell 571 calls, Workflow 60,
 * ScheduleWakeup 68, SendUserFile 16); Artifact and ListAgents appear in
 * subagent tool schemas with 0 invocations.
 *
 * Version note: TaskCreate/TaskUpdate/TaskList/TaskGet were deferred on
 * 2.1.92-2.1.229 and core from 2.1.239; AskUserQuestion was deferred on
 * 2.1.92-2.1.128 and core from 2.1.150. The classifier reconciles this per
 * session: a name that a ToolSearch result loaded is reported as a loaded
 * deferred tool, never as core.
 */
export const CORE_TOOL_NAMES: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'PowerShell',
  'Glob',
  'Grep',
  'Agent',
  'AskUserQuestion',
  'Skill',
  'ToolSearch',
  'Workflow',
  'ScheduleWakeup',
  'SendUserFile',
  'Artifact',
  'ListAgents',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
];

/**
 * Core schema cost before any version signal existed (the March 2026
 * estimate for Claude Code 2.1.9x). Used when the session carries no
 * `version` field or predates the first measured band.
 */
export const LEGACY_CORE_SCHEMA_TOKENS = 9_055;

/**
 * Back-compat alias for the legacy core schema constant.
 *
 * @deprecated Use `resolveCoreSchemaTokens` (per-session) or
 * `lookupCoreSchemaTokens` (per-version) instead.
 */
export const TOTAL_BUILTIN_TOOL_TOKENS = LEGACY_CORE_SCHEMA_TOKENS;

/** One measured band of the core schema cost */
export interface CoreSchemaVersionBand {
  /** First Claude Code version (inclusive) the band applies to */
  minVersion: string;
  /** Core schema tokens (the pre-load /context "System tools" row) */
  tokens: number;
}

/**
 * Core schema cost per Claude Code version band, newest first.
 *
 * A version resolves to the first band whose `minVersion` is <= it.
 * Versions below every band resolve to `LEGACY_CORE_SCHEMA_TOKENS`.
 */
export const CORE_SCHEMA_TOKENS_BY_VERSION: readonly CoreSchemaVersionBand[] = [
  { minVersion: '2.1.214', tokens: 20_500 },
  { minVersion: '2.1.160', tokens: 17_500 },
  { minVersion: '2.1.150', tokens: 15_000 },
];

/**
 * Estimated schema tokens that ONE deferred built-in tool adds to the window
 * when ToolSearch loads it (next-turn effective-input deltas over 19 loads /
 * 32 tools: avg ~1,048; single loads ranged 335 for WebSearch to 3,416 for
 * Monitor).
 */
export const DEFERRED_BUILTIN_LOAD_TOKENS = 1_000;

/**
 * Estimated schema tokens that ONE deferred MCP tool adds when loaded
 * (17 loads / 65 tools: avg ~328; /context per-tool rows show 170-233).
 */
export const DEFERRED_MCP_LOAD_TOKENS = 330;

/** Where a resolved core schema cost came from */
export type CoreSchemaSource = 'calibration' | 'version' | 'legacy';

/** A resolved core schema cost with its provenance */
export interface CoreSchemaResolution {
  tokens: number;
  source: CoreSchemaSource;
}

/**
 * Check whether a tool name belongs to an MCP server.
 *
 * Anthropic's naming convention is `mcp__<server>__<tool>`.
 *
 * @param name - Tool name as written in tool_use / tool_reference blocks
 * @returns True for MCP tool names
 */
export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__');
}

/**
 * Extract the server segment from an MCP tool name.
 *
 * `mcp__playwright__browser_click` -> `playwright`;
 * `mcp__plugin_vercel_vercel__list_teams` -> `plugin_vercel_vercel`.
 *
 * @param name - Tool name as written in tool_use / tool_reference blocks
 * @returns The server name, or null when the name is not an MCP tool name
 */
export function mcpServerName(name: string): string | null {
  if (!isMcpToolName(name)) return null;
  const server = name.slice('mcp__'.length).split('__')[0];
  return server && server.length > 0 ? server : null;
}

/**
 * Estimated window cost of loading one deferred tool via ToolSearch.
 *
 * @param name - Tool name as reported in the ToolSearch result
 * @returns Tokens added to the window by that schema
 */
export function deferredLoadCost(name: string): number {
  return isMcpToolName(name) ? DEFERRED_MCP_LOAD_TOKENS : DEFERRED_BUILTIN_LOAD_TOKENS;
}

/**
 * Parse a dotted version string into numeric parts.
 *
 * Non-numeric segments (pre-release tags) are truncated at the first
 * non-digit so `2.1.240-beta.1` compares as `2.1.240`.
 *
 * @param version - Version string such as `2.1.239`
 * @returns Numeric parts, or null when the string has no leading number
 */
function parseVersionParts(version: string): number[] | null {
  const trimmed = version.trim().replace(/^v/i, '');
  if (!/^\d/.test(trimmed)) return null;
  const parts: number[] = [];
  for (const segment of trimmed.split('.')) {
    const digits = /^\d+/.exec(segment);
    if (!digits) break;
    parts.push(Number.parseInt(digits[0], 10));
    // A segment with a non-digit suffix (`240-beta`) ends the numeric
    // version; whatever follows belongs to the pre-release tag.
    if (digits[0].length !== segment.length) break;
  }
  return parts.length > 0 ? parts : null;
}

/**
 * Compare two dotted version strings numerically.
 *
 * Missing trailing parts count as 0 (`2.1` equals `2.1.0`).
 *
 * @param a - First version
 * @param b - Second version
 * @returns Negative when a < b, zero when equal, positive when a > b;
 *          `NaN` when either side is not a version string
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  if (!pa || !pb) return Number.NaN;
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Look up the core schema cost for a Claude Code version.
 *
 * @param version - Claude Code version from the session records, if known
 * @returns The matching band's tokens, or the legacy constant when the
 *          version is unknown, unparseable, or older than every band
 */
export function lookupCoreSchemaTokens(version: string | undefined): number {
  return resolveCoreSchemaTokens(version, null).tokens;
}

/**
 * Resolve the core schema cost for one session.
 *
 * Precedence: calibration override (the /context "System tools" row saved
 * by `claude-crusts calibrate`) > version lookup > legacy fallback.
 *
 * @param version - Claude Code version that wrote the session, if known
 * @param override - Saved calibration override; null/undefined/<=0 means none
 * @param legacyTokens - Fallback when neither signal applies
 *        (defaults to `LEGACY_CORE_SCHEMA_TOKENS`; callers that want "no
 *        tool overhead" in a fixture pass 0)
 * @returns Resolved tokens and the signal that produced them
 */
export function resolveCoreSchemaTokens(
  version: string | undefined,
  override: number | null | undefined,
  legacyTokens: number = LEGACY_CORE_SCHEMA_TOKENS,
): CoreSchemaResolution {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return { tokens: Math.round(override), source: 'calibration' };
  }
  if (version) {
    for (const band of CORE_SCHEMA_TOKENS_BY_VERSION) {
      const cmp = compareVersions(version, band.minVersion);
      if (Number.isNaN(cmp)) break;
      if (cmp >= 0) return { tokens: band.tokens, source: 'version' };
    }
  }
  return { tokens: legacyTokens, source: 'legacy' };
}
