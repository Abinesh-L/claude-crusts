import { describe, test, expect } from 'bun:test';
import { classifySession } from '../src/classifier.ts';
import { generateSessionReportMd } from '../src/md-report.ts';
import { generateSessionReport } from '../src/html-report.ts';
import type {
  AnalysisResult,
  ConfigData,
  FixPrompts,
  SessionMessage,
} from '../src/types.ts';

// ---------------------------------------------------------------------------
// v0.8.0 M18 — report category rows must sum to the Total row now that the
// buckets are window-reconciled.
// ---------------------------------------------------------------------------

const EMPTY_CONFIG: ConfigData = {
  systemPrompt: { files: [], totalEstimatedTokens: 0 },
  mcpServers: [],
  memoryFiles: { files: [], totalEstimatedTokens: 0 },
  builtInTools: { tools: [], totalEstimatedTokens: 0 },
  skills: { items: [], totalEstimatedTokens: 0 },
};

const NO_FIX: FixPrompts = { sessionPrompt: null, claudeMdSnippet: null, compactCommand: null };

function userText(text: string): SessionMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as SessionMessage;
}

function assistantWithCache(inputTokens: number, cacheRead: number): SessionMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cacheRead,
        output_tokens: 100,
      },
    },
  } as SessionMessage;
}

/** Analysis result over a real classifySession run (no I/O, no LLM). */
function analyze(msgs: SessionMessage[]): AnalysisResult {
  const breakdown = classifySession(msgs, EMPTY_CONFIG);
  return {
    sessionId: 'abcdef1234567890',
    project: 'report-fixture',
    messageCount: msgs.length,
    breakdown,
    waste: [],
    recommendations: { recommendations: [], estimated_messages_until_compaction: null, context_health: 'healthy' },
    calibration: null,
    configData: EMPTY_CONFIG,
    messages: msgs,
  };
}

/** In-band fixture: content sum lands close to the API window total. */
function inBandMessages(): SessionMessage[] {
  return [
    userText('crust '.repeat(800)),
    assistantWithCache(100, 1_000),
  ];
}

/** Compacted fixture whose current-context slice reconciles in band. */
function compactedMessages(): SessionMessage[] {
  return [
    userText('q1'),
    assistantWithCache(100, 40_000),
    { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 150_000 }, isMeta: true } as SessionMessage,
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'summary '.repeat(500) }] }, isCompactSummary: true } as SessionMessage,
    userText('q2'),
    assistantWithCache(100, 40_000),
  ];
}

/** Parse "1,234" into 1234. */
function num(s: string): number {
  return parseInt(s.replace(/,/g, ''), 10);
}

/** Extract the six category-row token values from the md table. */
function mdCategoryTokens(md: string): number[] {
  const rows = md.split('\n').filter((l) => /^\| [A-Z] [\w/ ]+ \| [\d,]+ \|/.test(l));
  return rows.map((l) => num(l.split('|')[2]!.trim()));
}

/** Extract the Total-row token value from the md table. */
function mdTotalTokens(md: string): number {
  const m = md.match(/^\| \*\*Total\*\* \| \*\*([\d,]+)\*\*/m);
  expect(m).not.toBeNull();
  return num(m![1]!);
}

describe('M18 md report window reconciliation', () => {
  test('category rows sum EXACTLY to the Total row (no compaction)', () => {
    const result = analyze(inBandMessages());
    // Precondition: this fixture reconciles on the api basis.
    expect(result.breakdown.reconciliation!.basis).toBe('api');
    const md = generateSessionReportMd(result, NO_FIX);
    const rows = mdCategoryTokens(md);
    expect(rows.length).toBe(6);
    expect(rows.reduce((a, b) => a + b, 0)).toBe(mdTotalTokens(md));
    expect(mdTotalTokens(md)).toBe(result.breakdown.total_tokens);
  });

  test('compacted report shows the current-context view and its rows sum to Total', () => {
    const result = analyze(compactedMessages());
    expect(result.breakdown.currentContext!.reconciliation!.basis).toBe('api');
    const md = generateSessionReportMd(result, NO_FIX);
    const rows = mdCategoryTokens(md);
    expect(rows.length).toBe(6);
    expect(rows.reduce((a, b) => a + b, 0)).toBe(mdTotalTokens(md));
    expect(mdTotalTokens(md)).toBe(result.breakdown.currentContext!.total_tokens);
  });
});

describe('M18 html report window reconciliation', () => {
  test('category table cells sum EXACTLY to the Total cell', () => {
    const result = analyze(inBandMessages());
    const html = generateSessionReport(result, NO_FIX);
    // Category table sits between the section heading and the usage gauge
    // that follows it (the CSS also mentions gauge-row, so search AFTER the
    // heading).
    const start = html.indexOf('<h2>Category Breakdown</h2>');
    expect(start).toBeGreaterThan(-1);
    const section = html.slice(start, html.indexOf('gauge-row', start));
    // Pure-number .num cells are the six token cells plus the Total cell
    // (percentage cells carry a % sign, accuracy cells carry text).
    const cells = [...section.matchAll(/class="num">([\d,]+)<\/td>/g)].map((m) => num(m[1]!));
    expect(cells.length).toBe(7);
    const total = cells.pop()!;
    expect(cells.reduce((a, b) => a + b, 0)).toBe(total);
    expect(total).toBe(result.breakdown.total_tokens);
  });
});
