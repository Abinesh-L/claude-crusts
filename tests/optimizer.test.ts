import { describe, test, expect } from 'bun:test';
import { buildOptimizeReport } from '../src/optimizer.ts';
import type { CrustsBreakdown, WasteItem, ConfigData, SessionMessage, MCPBreakdown } from '../src/types.ts';

function emptyBreakdown(extra?: Partial<CrustsBreakdown>): CrustsBreakdown {
  return {
    buckets: [],
    total_tokens: 10_000,
    context_limit: 200_000,
    free_tokens: 190_000,
    usage_percentage: 5,
    messages: [],
    toolBreakdown: {
      loadedTools: [], usedTools: [], unusedTools: [],
      schemaTokens: 0, callTokens: 0, resultTokens: 0,
    },
    model: 'claude-opus-4-7',
    durationSeconds: null,
    compactionEvents: [],
    configOverhead: { systemPrompt: 0, memoryFiles: 0, mcpSchemas: 0, builtInTools: 0, skills: 0 },
    totalMessages: 0,
    derivedOverhead: { internalSystemPrompt: null, messageFraming: null },
    ...extra,
  } as CrustsBreakdown;
}

function emptyConfigData(claudeMdTokens = 500): ConfigData {
  return {
    systemPrompt: { files: [], totalEstimatedTokens: claudeMdTokens },
    mcpServers: [],
    memoryFiles: { files: [], totalEstimatedTokens: 0 },
    builtInTools: { tools: [], totalEstimatedTokens: 0 },
    skills: { items: [], totalEstimatedTokens: 0 },
  };
}

function readMsg(path: string, toolUseId: string, resultText: string): [SessionMessage, SessionMessage] {
  return [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: path } }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: resultText }],
      },
    },
  ] as SessionMessage[] as [SessionMessage, SessionMessage];
}

describe('buildOptimizeReport', () => {
  test('emits no fixes for an empty session', () => {
    const report = buildOptimizeReport('sid', emptyBreakdown(), [], emptyConfigData(), [], '/tmp/proj');
    expect(report.fixes.length).toBe(0);
    expect(report.totalSaveable).toBe(0);
  });

  test('emits compact-focus fix when waste items exist', () => {
    const waste: WasteItem[] = [
      { type: 'duplicate_read', severity: 'high', description: '"renderer.ts" read 6 times', estimated_tokens: 1500, recommendation: '' },
      { type: 'stale_read', severity: 'medium', description: '"classifier.ts" read 40 msgs ago', estimated_tokens: 800, recommendation: '' },
    ];
    const report = buildOptimizeReport('sid', emptyBreakdown(), waste, emptyConfigData(), [], '/tmp/proj');
    const compactFix = report.fixes.find((f) => f.kind === 'compact-focus');
    expect(compactFix).toBeDefined();
    expect(compactFix!.action).toContain('/compact focus');
    expect(compactFix!.action).toContain('renderer.ts');
    expect(compactFix!.estimatedSavings).toBeGreaterThanOrEqual(2300);
    expect(compactFix!.autoApplicable).toBe(false);
  });

  test('detects .claudeignore candidates for repeated noise reads', () => {
    const msgs: SessionMessage[] = [
      ...readMsg('/proj/node_modules/chalk/index.js', 'r1', 'a'.repeat(4000)),
      ...readMsg('/proj/dist/bundle.js', 'r2', 'b'.repeat(3000)),
    ];
    const report = buildOptimizeReport('sid', emptyBreakdown(), [], emptyConfigData(), msgs, '/tmp/proj');
    const ignoreFix = report.fixes.find((f) => f.kind === 'claudeignore');
    expect(ignoreFix).toBeDefined();
    expect(ignoreFix!.autoApplicable).toBe(true);
    expect(ignoreFix!.action).toContain('node_modules/');
    expect(ignoreFix!.action).toContain('dist/');
    expect(ignoreFix!.estimatedSavings).toBeGreaterThan(1000);
  });

  test('does not flag src/ or other legitimate reads', () => {
    const msgs: SessionMessage[] = [
      ...readMsg('/proj/src/index.ts', 'r1', 'a'.repeat(4000)),
    ];
    const report = buildOptimizeReport('sid', emptyBreakdown(), [], emptyConfigData(), msgs, '/tmp/proj');
    expect(report.fixes.some((f) => f.kind === 'claudeignore')).toBe(false);
  });

  test('emits mcp-disable fix when unused MCP servers are present', () => {
    const mcp: MCPBreakdown = {
      servers: [
        { name: 'gmail', source: 'global', invocationCount: 0, tokensSpent: 0, unused: true },
        { name: 'calendar', source: 'global', invocationCount: 5, tokensSpent: 1200, unused: false },
      ],
      unusedServers: ['gmail'],
      totalMcpTokens: 1200,
    };
    const report = buildOptimizeReport('sid', emptyBreakdown({ mcpBreakdown: mcp }), [], emptyConfigData(), [], '/tmp/proj');
    const mcpFix = report.fixes.find((f) => f.kind === 'mcp-disable');
    expect(mcpFix).toBeDefined();
    expect(mcpFix!.action).toContain('gmail');
    expect(mcpFix!.estimatedSavings).toBe(0); // schemas load on-demand
  });

  test('emits claudemd-oversized warning when CLAUDE.md exceeds 1500 tokens', () => {
    const report = buildOptimizeReport('sid', emptyBreakdown(), [], emptyConfigData(3000), [], '/tmp/proj');
    const warning = report.fixes.find((f) => f.kind === 'claudemd-oversized');
    expect(warning).toBeDefined();
    expect(warning!.estimatedSavings).toBe(1500); // 3000 - 1500 threshold
    expect(warning!.autoApplicable).toBe(false);
  });

  test('ranks fixes by savings descending and sums total saveable', () => {
    const waste: WasteItem[] = [
      { type: 'duplicate_read', severity: 'high', description: '"r.ts" read 6 times', estimated_tokens: 2500, recommendation: '' },
    ];
    const msgs: SessionMessage[] = [
      ...readMsg('/proj/node_modules/a/b.js', 'r1', 'x'.repeat(10000)),
    ];
    const report = buildOptimizeReport('sid', emptyBreakdown(), waste, emptyConfigData(2500), msgs, '/tmp/proj');
    expect(report.fixes.length).toBeGreaterThan(0);
    // sorted descending
    for (let i = 1; i < report.fixes.length; i++) {
      expect(report.fixes[i - 1]!.estimatedSavings).toBeGreaterThanOrEqual(report.fixes[i]!.estimatedSavings);
    }
    // total equals sum
    const sum = report.fixes.reduce((s, f) => s + f.estimatedSavings, 0);
    expect(report.totalSaveable).toBe(sum);
  });

  test('minSavings filters out small fixes (but keeps info + secondary)', () => {
    const waste: WasteItem[] = [
      { type: 'duplicate_read', severity: 'high', description: '"r.ts" read 2 times', estimated_tokens: 50, recommendation: '' },
    ];
    const report = buildOptimizeReport('sid', emptyBreakdown(), waste, emptyConfigData(), [], '/tmp/proj', { minSavings: 100 });
    // 50 token fix is below threshold
    expect(report.fixes.some((f) => f.kind === 'compact-focus')).toBe(false);
  });

  test('filter option restricts kinds', () => {
    const waste: WasteItem[] = [
      { type: 'duplicate_read', severity: 'high', description: '"r.ts" read 6 times', estimated_tokens: 2500, recommendation: '' },
    ];
    const report = buildOptimizeReport('sid', emptyBreakdown(), waste, emptyConfigData(3000), [], '/tmp/proj', { filter: ['compact-focus'] });
    expect(report.fixes.every((f) => f.kind === 'compact-focus')).toBe(true);
    expect(report.fixes.some((f) => f.kind === 'claudemd-oversized')).toBe(false);
  });
});
