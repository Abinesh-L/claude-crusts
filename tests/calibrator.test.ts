import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PassThrough } from 'stream';
import {
  parseContextOutput,
  parseTokenFigure,
  parseTokensHeader,
  parseContextWindowSize,
  saveCalibration,
  loadCalibration,
  loadCoreSchemaOverride,
  compareWithEstimates,
  readPastedBlock,
} from '../src/calibrator.ts';
import type { CrustsBreakdown } from '../src/types.ts';

/**
 * The real /context block logged in session 24b8260b (Claude Code 2.1.220,
 * 2026-07-29). Category rows copied verbatim; the per-tool sub-table is
 * shortened to two rows, which is all the parser needs to prove it ignores
 * them.
 */
const REAL_TABLE_2_1_220 = `## Context Usage

**Model:** claude-opus-5
**Tokens:** 419.2k / 1m (42%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 4.1k | 0.4% |
| System tools | 21.1k | 2.1% |
| MCP tools | 1.3k | 0.1% |
| MCP tools (deferred) | 23.4k | 2.3% |
| System tools (deferred) | 16.2k | 1.6% |
| Custom agents | 314 | 0.0% |
| Memory files | 10.5k | 1.1% |
| Skills | 5k | 0.5% |
| Messages | 376.9k | 37.7% |
| Free space | 580.8k | 58.1% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__claude_ai_Function_Health__authenticate | claude_ai_Function_Health | 181 |
| mcp__playwright__browser_take_screenshot | playwright | 577 |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| User | C:\\Users\\abine\\.claude\\CLAUDE.md | 94 |
| AutoMem | C:\\Users\\abine\\.claude\\projects\\x\\memory\\MEMORY.md | 6.5k |

### Skills

| Skill | Source | Tokens |
|-------|-------|--------|
| graphify-windows | User | ~120 |
| vercel:deploy | Plugin (vercel) | ~50 |
`;

/** A 2.1.193 block (session 2eee1df7) that carries the Autocompact buffer row. */
const REAL_TABLE_WITH_BUFFER = `## Context Usage

**Model:** claude-opus-4-8[1m]
**Tokens:** 662.4k / 1m (66%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2.6k | 0.3% |
| System tools | 17.2k | 1.7% |
| MCP tools (deferred) | 8k | 0.8% |
| System tools (deferred) | 14.9k | 1.5% |
| Custom agents | 314 | 0.0% |
| Memory files | 1.8k | 0.2% |
| Skills | 4.2k | 0.4% |
| Messages | 637.5k | 63.8% |
| Free space | 303.3k | 30.3% |
| Autocompact buffer | 33k | 3.3% |
`;

describe('parseTokenFigure', () => {
  test('handles plain, comma, k, m, and tilde figures', () => {
    expect(parseTokenFigure('11,200')).toBe(11_200);
    expect(parseTokenFigure('11200 tokens')).toBe(11_200);
    expect(parseTokenFigure('21.1k')).toBe(21_100);
    expect(parseTokenFigure('5k')).toBe(5_000);
    expect(parseTokenFigure('1m')).toBe(1_000_000);
    expect(parseTokenFigure('200K')).toBe(200_000);
    expect(parseTokenFigure('~120')).toBe(120);
    expect(parseTokenFigure('314')).toBe(314);
  });

  test('rejects non-figures', () => {
    expect(parseTokenFigure('Tokens')).toBeNull();
    expect(parseTokenFigure('--------')).toBeNull();
    expect(parseTokenFigure('playwright')).toBeNull();
    expect(parseTokenFigure('2.1%')).toBeNull();
    expect(parseTokenFigure('')).toBeNull();
  });
});

describe('parseTokensHeader / parseContextWindowSize', () => {
  test('parses the bold Tokens header', () => {
    expect(parseTokensHeader('**Tokens:** 419.2k / 1m (42%)')).toEqual({ used: 419_200, window: 1_000_000 });
  });

  test('parses a 500k window and a 200k window', () => {
    expect(parseContextWindowSize('**Tokens:** 534k / 500k (107%)')).toBe(500_000);
    expect(parseContextWindowSize('Tokens: 12.3k / 200k (6%)')).toBe(200_000);
  });

  test('returns null when no header is present', () => {
    expect(parseTokensHeader('System prompt: 11,200 tokens')).toBeNull();
    expect(parseContextWindowSize('')).toBeNull();
  });
});

describe('parseContextOutput (markdown table, Claude Code 2.1.150+)', () => {
  test('parses the real 2.1.220 table', () => {
    const parsed = parseContextOutput(REAL_TABLE_2_1_220);
    expect(parsed).not.toBeNull();
    const b = parsed!.buckets;
    expect(b.system_prompt).toBe(4_100);
    expect(b.system_tools).toBe(21_100);
    expect(b.mcp_tools).toBe(1_300);
    expect(b.mcp_tools_deferred).toBe(23_400);
    expect(b.system_tools_deferred).toBe(16_200);
    expect(b.custom_agents).toBe(314);
    expect(b.memory_files).toBe(10_500);
    expect(b.skills).toBe(5_000);
    expect(b.messages).toBe(376_900);
    expect(b.free_space).toBe(580_800);
    expect(b.autocompact_buffer).toBe(0);
  });

  test('deferred rows are excluded from total_used (sum of in-window rows equals the header)', () => {
    const parsed = parseContextOutput(REAL_TABLE_2_1_220)!;
    // 4.1k + 21.1k + 1.3k + 314 + 10.5k + 5k + 376.9k = 419,214 ~ header 419.2k
    expect(parsed.total_used).toBe(419_214);
    expect(parsed.reported_used).toBe(419_200);
    expect(Math.abs(parsed.total_used - parsed.reported_used!)).toBeLessThan(100);
  });

  test('exposes the window size, model, and core-schema override', () => {
    const parsed = parseContextOutput(REAL_TABLE_2_1_220)!;
    expect(parsed.window_size).toBe(1_000_000);
    expect(parsed.total_capacity).toBe(1_000_000);
    expect(parsed.model).toBe('claude-opus-5');
    expect(parsed.core_schema_tokens_override).toBe(21_100);
  });

  test('per-tool, memory-file, and skills sub-tables never leak into buckets', () => {
    const parsed = parseContextOutput(REAL_TABLE_2_1_220)!;
    // Memory row 10.5k, not the 94-token CLAUDE.md or the 6.5k MEMORY.md sub-rows.
    expect(parsed.buckets.memory_files).toBe(10_500);
    // Skills row 5k, not ~120 / ~50.
    expect(parsed.buckets.skills).toBe(5_000);
    // MCP tools 1.3k, not 181 / 577.
    expect(parsed.buckets.mcp_tools).toBe(1_300);
  });

  test('deferred rows do not pollute mcp_tools or system_tools when the loaded rows are absent', () => {
    const parsed = parseContextOutput(`
| System prompt | 4.1k | 0.4% |
| MCP tools (deferred) | 18k | 1.8% |
| System tools (deferred) | 16.2k | 1.6% |
| Messages | 100k | 10% |
`);
    expect(parsed).not.toBeNull();
    expect(parsed!.buckets.mcp_tools).toBe(0);
    expect(parsed!.buckets.system_tools).toBe(0);
    expect(parsed!.buckets.mcp_tools_deferred).toBe(18_000);
    expect(parsed!.buckets.system_tools_deferred).toBe(16_200);
    expect(parsed!.total_used).toBe(104_100);
    expect(parsed!.core_schema_tokens_override).toBeNull();
  });

  test('autocompact buffer is parsed, excluded from used, and included in the capacity fallback', () => {
    const parsed = parseContextOutput(REAL_TABLE_WITH_BUFFER)!;
    expect(parsed.buckets.autocompact_buffer).toBe(33_000);
    expect(parsed.model).toBe('claude-opus-4-8[1m]');
    // 2.6k + 17.2k + 314 + 1.8k + 4.2k + 637.5k
    expect(parsed.total_used).toBe(663_614);
    expect(parsed.window_size).toBe(1_000_000);

    // Same rows without the header: capacity = used + free + buffer ~ 1m.
    const noHeader = parseContextOutput(REAL_TABLE_WITH_BUFFER.replace(/\*\*Tokens:\*\*.*\n/, ''))!;
    expect(noHeader.window_size).toBeNull();
    expect(noHeader.total_capacity).toBe(663_614 + 303_300 + 33_000);
  });

  test('a 500k window header is surfaced as-is', () => {
    const parsed = parseContextOutput(`**Tokens:** 534k / 500k (107%)
| System tools | 17.2k | 3.4% |
| Messages | 516.8k | 103% |
| Autocompact buffer | 33k | 6.6% |
`)!;
    expect(parsed.window_size).toBe(500_000);
    expect(parsed.total_capacity).toBe(500_000);
    expect(parsed.reported_used).toBe(534_000);
  });

  test('k/m suffixes work in the colon format too', () => {
    const parsed = parseContextOutput('System prompt: 4.1k\nSystem tools: 21.1k\nMessages: 376.9k\nFree space: 580.8k\nTotal: 1m')!;
    expect(parsed.buckets.system_prompt).toBe(4_100);
    expect(parsed.buckets.system_tools).toBe(21_100);
    expect(parsed.buckets.messages).toBe(376_900);
    expect(parsed.total_capacity).toBe(1_000_000);
  });
});

describe('parseContextOutput (legacy colon format)', () => {
  test('parses standard /context output', () => {
    const input = `
      System prompt:  11,200 tokens
      System tools:   14,600 tokens
      Custom agents:      0 tokens
      Memory files:     800 tokens
      MCP tools:          0 tokens
      Messages:      98,000 tokens
      Free space:    74,400 tokens
      Total:        200,000 tokens
    `;
    const parsed = parseContextOutput(input);
    expect(parsed).not.toBeNull();
    expect(parsed!.buckets.system_prompt).toBe(11_200);
    expect(parsed!.buckets.system_tools).toBe(14_600);
    expect(parsed!.buckets.memory_files).toBe(800);
    expect(parsed!.buckets.messages).toBe(98_000);
    expect(parsed!.buckets.free_space).toBe(74_400);
    expect(parsed!.total_capacity).toBe(200_000);
    expect(parsed!.window_size).toBeNull();
    expect(parsed!.core_schema_tokens_override).toBe(14_600);
  });

  test('handles numbers without commas or units', () => {
    const parsed = parseContextOutput('System prompt: 11200\nMessages: 50000');
    expect(parsed).not.toBeNull();
    expect(parsed!.buckets.system_prompt).toBe(11_200);
    expect(parsed!.buckets.messages).toBe(50_000);
  });

  test('returns null for unparseable input', () => {
    expect(parseContextOutput('')).toBeNull();
    expect(parseContextOutput('no numbers here at all')).toBeNull();
    expect(parseContextOutput('| Category | Tokens | Percentage |\n|----|----|----|')).toBeNull();
  });

  test('falls back to used + free when no total line present', () => {
    const parsed = parseContextOutput(`
      System prompt:  1,000 tokens
      Messages:      10,000 tokens
      Free space:   189,000 tokens
    `);
    expect(parsed).not.toBeNull();
    expect(parsed!.total_used).toBe(11_000);
    expect(parsed!.total_capacity).toBe(200_000);
  });

  test('a bare "Tools" line still maps to system_tools but never steals the MCP row', () => {
    const parsed = parseContextOutput('Tools: 9,000\nMCP tools: 1,300\nMessages: 5,000')!;
    expect(parsed.buckets.system_tools).toBe(9_000);
    expect(parsed.buckets.mcp_tools).toBe(1_300);

    const mcpOnly = parseContextOutput('MCP tools: 1,300\nMessages: 5,000')!;
    expect(mcpOnly.buckets.system_tools).toBe(0);
    expect(mcpOnly.buckets.mcp_tools).toBe(1_300);
  });
});

describe('compareWithEstimates', () => {
  function breakdownWith(tokens: Record<string, number>): CrustsBreakdown {
    const categories = ['conversation', 'retrieved', 'user', 'system', 'tools', 'state'] as const;
    return {
      buckets: categories.map((category) => ({
        category,
        tokens: tokens[category] ?? 0,
        percentage: 0,
        message_count: 0,
        label: category,
      })),
    } as unknown as CrustsBreakdown;
  }

  test('Tools compares against loaded schemas only (deferred rows excluded)', () => {
    const cal = parseContextOutput(REAL_TABLE_2_1_220)!;
    const rows = compareWithEstimates(breakdownWith({ tools: 22_400, system: 4_100 }), cal);
    const tools = rows.find((r) => r.category === 'Tools')!;
    expect(tools.contextActual).toBe(21_100 + 1_300);
    expect(tools.deltaPercent).toBeCloseTo(0, 5);
    const system = rows.find((r) => r.category === 'System prompt')!;
    expect(system.contextActual).toBe(4_100);
  });
});

describe('saveCalibration / loadCalibration / loadCoreSchemaOverride', () => {
  let sandbox: string;
  let savedOverride: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'crusts-calibration-'));
    savedOverride = process.env.CRUSTS_CALIBRATION_DIR_OVERRIDE;
    // Redirect calibration.json to a temp dir so tests never touch the
    // developer's real ~/.claude-crusts/calibration.json.
    process.env.CRUSTS_CALIBRATION_DIR_OVERRIDE = join(sandbox, 'nested');
  });

  afterEach(() => {
    if (savedOverride === undefined) {
      delete process.env.CRUSTS_CALIBRATION_DIR_OVERRIDE;
    } else {
      process.env.CRUSTS_CALIBRATION_DIR_OVERRIDE = savedOverride;
    }
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('round-trips the parsed table and persists the core-schema override', () => {
    const data = parseContextOutput(REAL_TABLE_2_1_220)!;
    saveCalibration(data);
    expect(existsSync(join(sandbox, 'nested', 'calibration.json'))).toBe(true);

    const loaded = loadCalibration()!;
    expect(loaded.buckets).toEqual(data.buckets);
    expect(loaded.window_size).toBe(1_000_000);
    expect(loaded.core_schema_tokens_override).toBe(21_100);
    expect(loadCoreSchemaOverride()).toBe(21_100);

    const onDisk = JSON.parse(readFileSync(join(sandbox, 'nested', 'calibration.json'), 'utf-8'));
    expect(onDisk.core_schema_tokens_override).toBe(21_100);
  });

  test('returns null override when nothing is saved', () => {
    expect(loadCalibration()).toBeNull();
    expect(loadCoreSchemaOverride()).toBeNull();
  });

  test('normalises a pre-0.8.0 calibration file (missing fields become zeros / nulls)', () => {
    const dir = join(sandbox, 'nested');
    saveCalibration(parseContextOutput('System prompt: 1\nMessages: 1')!); // creates the dir
    writeFileSync(join(dir, 'calibration.json'), JSON.stringify({
      timestamp: '2026-04-01T00:00:00.000Z',
      buckets: {
        system_prompt: 11_200,
        system_tools: 14_600,
        custom_agents: 0,
        memory_files: 800,
        mcp_tools: 0,
        messages: 98_000,
        free_space: 74_400,
      },
      total_used: 124_600,
      total_capacity: 200_000,
      raw_output: 'legacy',
    }), 'utf-8');

    const loaded = loadCalibration()!;
    expect(loaded.buckets.skills).toBe(0);
    expect(loaded.buckets.system_tools_deferred).toBe(0);
    expect(loaded.buckets.mcp_tools_deferred).toBe(0);
    expect(loaded.buckets.autocompact_buffer).toBe(0);
    expect(loaded.window_size).toBeNull();
    expect(loaded.reported_used).toBeNull();
    expect(loaded.model).toBeNull();
    // Legacy files still yield an override from their System tools row.
    expect(loaded.core_schema_tokens_override).toBe(14_600);
    expect(loadCoreSchemaOverride()).toBe(14_600);
  });

  test('corrupt calibration file loads as null', () => {
    saveCalibration(parseContextOutput('System prompt: 1\nMessages: 1')!);
    writeFileSync(join(sandbox, 'nested', 'calibration.json'), '{not json', 'utf-8');
    expect(loadCalibration()).toBeNull();
    expect(loadCoreSchemaOverride()).toBeNull();
  });
});

describe('readPastedBlock', () => {
  test('survives the single blank lines inside the /context markdown and ends on two', async () => {
    const input = new PassThrough();
    const pending = readPastedBlock(input);
    input.write(REAL_TABLE_2_1_220);
    input.write('\n\n\n');
    const text = await pending;
    expect(text).toContain('| System tools | 21.1k | 2.1% |');
    expect(text).toContain('| vercel:deploy | Plugin (vercel) | ~50 |');
    expect(parseContextOutput(text)!.buckets.system_tools).toBe(21_100);
  });

  test('ends on stream close without a terminator', async () => {
    const input = new PassThrough();
    const pending = readPastedBlock(input);
    input.end('System prompt: 1,000 tokens\nMessages: 10,000 tokens\n');
    expect(await pending).toBe('System prompt: 1,000 tokens\nMessages: 10,000 tokens');
  });

  test('leading blank lines do not terminate an empty block', async () => {
    const input = new PassThrough();
    const pending = readPastedBlock(input);
    input.write('\n\n\n');
    input.write('Messages: 10,000 tokens\n\n\n');
    expect(await pending).toBe('Messages: 10,000 tokens');
  });
});
