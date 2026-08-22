/**
 * M6: built-in tool catalogue.
 *
 * Guards the rebuilt catalogue: real tool names only (no Tool_NN
 * placeholders, no retired TodoRead/TodoWrite), the version-keyed core
 * schema cost, the calibration-override precedence, and the per-tool
 * deferred load costs.
 */

import { describe, test, expect } from 'bun:test';
import {
  CORE_TOOL_NAMES,
  CORE_SCHEMA_TOKENS_BY_VERSION,
  LEGACY_CORE_SCHEMA_TOKENS,
  TOTAL_BUILTIN_TOOL_TOKENS,
  DEFERRED_BUILTIN_LOAD_TOKENS,
  DEFERRED_MCP_LOAD_TOKENS,
  compareVersions,
  lookupCoreSchemaTokens,
  resolveCoreSchemaTokens,
  deferredLoadCost,
  isMcpToolName,
} from '../src/built-in-tools.ts';

describe('CORE_TOOL_NAMES', () => {
  test('contains no placeholder or retired names', () => {
    for (const name of CORE_TOOL_NAMES) {
      expect(name).not.toMatch(/^Tool_\d+$/);
    }
    expect(CORE_TOOL_NAMES).not.toContain('TodoRead');
    expect(CORE_TOOL_NAMES).not.toContain('TodoWrite');
  });

  test('every name is PascalCase without underscores and unique', () => {
    for (const name of CORE_TOOL_NAMES) {
      expect(name).toMatch(/^[A-Z][A-Za-z]+$/);
    }
    expect(new Set(CORE_TOOL_NAMES).size).toBe(CORE_TOOL_NAMES.length);
  });

  test('lists the tools observed as always loaded on current Claude Code', () => {
    for (const name of ['Read', 'Write', 'Edit', 'Bash', 'PowerShell', 'Glob', 'Grep', 'Agent',
      'AskUserQuestion', 'Skill', 'ToolSearch', 'Workflow', 'ScheduleWakeup', 'SendUserFile',
      'Artifact', 'ListAgents', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']) {
      expect(CORE_TOOL_NAMES).toContain(name);
    }
  });

  test('does not list deferred tools as core', () => {
    for (const name of ['WebSearch', 'WebFetch', 'Monitor', 'SendMessage', 'CronCreate', 'NotebookEdit', 'EnterPlanMode']) {
      expect(CORE_TOOL_NAMES).not.toContain(name);
    }
  });
});

describe('CORE_SCHEMA_TOKENS_BY_VERSION', () => {
  test('bands are ordered newest first so the first match is the right band', () => {
    for (let i = 1; i < CORE_SCHEMA_TOKENS_BY_VERSION.length; i++) {
      const newer = CORE_SCHEMA_TOKENS_BY_VERSION[i - 1]!;
      const older = CORE_SCHEMA_TOKENS_BY_VERSION[i]!;
      expect(compareVersions(newer.minVersion, older.minVersion)).toBeGreaterThan(0);
    }
  });

  test('legacy constant is 9,055 and TOTAL_BUILTIN_TOOL_TOKENS aliases it', () => {
    expect(LEGACY_CORE_SCHEMA_TOKENS).toBe(9_055);
    expect(TOTAL_BUILTIN_TOOL_TOKENS).toBe(LEGACY_CORE_SCHEMA_TOKENS);
  });
});

describe('compareVersions', () => {
  test('orders dotted versions numerically, not lexically', () => {
    expect(compareVersions('2.1.239', '2.1.92')).toBeGreaterThan(0);
    expect(compareVersions('2.1.92', '2.1.239')).toBeLessThan(0);
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
  });

  test('treats missing trailing parts as zero and tolerates prefixes', () => {
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
    expect(compareVersions('v2.1.214', '2.1.214')).toBe(0);
    expect(compareVersions('2.1.240-beta.1', '2.1.240')).toBe(0);
  });

  test('returns NaN for non-version strings', () => {
    expect(Number.isNaN(compareVersions('garbage', '2.1.0'))).toBe(true);
    expect(Number.isNaN(compareVersions('2.1.0', ''))).toBe(true);
  });
});

describe('lookupCoreSchemaTokens', () => {
  test('2.1.239 resolves to the 20,500 band', () => {
    expect(lookupCoreSchemaTokens('2.1.239')).toBe(20_500);
  });

  test('band boundaries are inclusive at minVersion', () => {
    expect(lookupCoreSchemaTokens('2.1.214')).toBe(20_500);
    expect(lookupCoreSchemaTokens('2.1.213')).toBe(17_500);
    expect(lookupCoreSchemaTokens('2.1.160')).toBe(17_500);
    expect(lookupCoreSchemaTokens('2.1.159')).toBe(15_000);
    expect(lookupCoreSchemaTokens('2.1.150')).toBe(15_000);
    expect(lookupCoreSchemaTokens('2.1.149')).toBe(9_055);
  });

  test('2.1.92 and unknown versions fall back to the legacy 9,055', () => {
    expect(lookupCoreSchemaTokens('2.1.92')).toBe(9_055);
    expect(lookupCoreSchemaTokens(undefined)).toBe(9_055);
    expect(lookupCoreSchemaTokens('')).toBe(9_055);
    expect(lookupCoreSchemaTokens('not-a-version')).toBe(9_055);
  });

  test('versions newer than every band take the newest band', () => {
    expect(lookupCoreSchemaTokens('2.2.0')).toBe(20_500);
    expect(lookupCoreSchemaTokens('3.0.0')).toBe(20_500);
    expect(lookupCoreSchemaTokens('2.1.240-beta.1')).toBe(20_500);
  });
});

describe('resolveCoreSchemaTokens', () => {
  test('calibration override wins over the version table', () => {
    expect(resolveCoreSchemaTokens('2.1.239', 21_100)).toEqual({ tokens: 21_100, source: 'calibration' });
    expect(resolveCoreSchemaTokens(undefined, 14_300)).toEqual({ tokens: 14_300, source: 'calibration' });
  });

  test('version table applies when there is no usable override', () => {
    expect(resolveCoreSchemaTokens('2.1.239', null)).toEqual({ tokens: 20_500, source: 'version' });
    expect(resolveCoreSchemaTokens('2.1.239', undefined)).toEqual({ tokens: 20_500, source: 'version' });
    expect(resolveCoreSchemaTokens('2.1.239', 0)).toEqual({ tokens: 20_500, source: 'version' });
    expect(resolveCoreSchemaTokens('2.1.239', -5)).toEqual({ tokens: 20_500, source: 'version' });
    expect(resolveCoreSchemaTokens('2.1.239', Number.NaN)).toEqual({ tokens: 20_500, source: 'version' });
  });

  test('legacy fallback uses the caller-supplied baseline', () => {
    expect(resolveCoreSchemaTokens('2.1.92', null)).toEqual({ tokens: 9_055, source: 'legacy' });
    expect(resolveCoreSchemaTokens(undefined, null)).toEqual({ tokens: 9_055, source: 'legacy' });
    expect(resolveCoreSchemaTokens(undefined, null, 0)).toEqual({ tokens: 0, source: 'legacy' });
    expect(resolveCoreSchemaTokens('2.1.92', null, 1_234)).toEqual({ tokens: 1_234, source: 'legacy' });
  });

  test('a fractional override is rounded', () => {
    expect(resolveCoreSchemaTokens('2.1.239', 21_100.4).tokens).toBe(21_100);
  });
});

describe('deferred load costs', () => {
  test('built-in deferred tools cost 1,000 and MCP tools 330 per load', () => {
    expect(DEFERRED_BUILTIN_LOAD_TOKENS).toBe(1_000);
    expect(DEFERRED_MCP_LOAD_TOKENS).toBe(330);
    expect(deferredLoadCost('Monitor')).toBe(1_000);
    expect(deferredLoadCost('WebSearch')).toBe(1_000);
    expect(deferredLoadCost('mcp__playwright__browser_click')).toBe(330);
  });

  test('isMcpToolName follows the mcp__<server>__<tool> convention', () => {
    expect(isMcpToolName('mcp__playwright__browser_click')).toBe(true);
    expect(isMcpToolName('mcp__plugin_vercel_vercel__get_project')).toBe(true);
    expect(isMcpToolName('WebSearch')).toBe(false);
    expect(isMcpToolName('mcpTool')).toBe(false);
  });
});
