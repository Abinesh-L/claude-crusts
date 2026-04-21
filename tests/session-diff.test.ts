import { describe, test, expect } from 'bun:test';
import { computeSessionDiff } from '../src/session-diff.ts';
import type { SessionMessage, ConfigData } from '../src/types.ts';

function userMsg(text: string): SessionMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as SessionMessage;
}

function assistantMsg(text: string, inputTokens = 100, outputTokens = 50): SessionMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  } as SessionMessage;
}

function makeSession(n: number): SessionMessage[] {
  const msgs: SessionMessage[] = [];
  // Assistant input grows with message index to mirror real sessions, where
  // each turn's API-reported input_tokens reflects cumulative context
  // re-sent via cache. Without this, `total_tokens` (now API-derived) would
  // be constant across slices and diff tests would spuriously report 0 growth.
  for (let i = 0; i < n; i++) {
    msgs.push(
      i % 2 === 0
        ? userMsg(`u${i} ${'x'.repeat(200)}`)
        : assistantMsg(`a${i} ${'y'.repeat(200)}`, 100 + i * 10),
    );
  }
  return msgs;
}

const emptyConfig: ConfigData = {
  systemPrompt: { files: [], totalEstimatedTokens: 0 },
  mcpServers: [],
  memoryFiles: { files: [], totalEstimatedTokens: 0 },
  builtInTools: { tools: [], totalEstimatedTokens: 0 },
  skills: { items: [], totalEstimatedTokens: 0 },
};

describe('computeSessionDiff', () => {
  test('throws on empty session', () => {
    expect(() => computeSessionDiff([], emptyConfig, 'sid', 1, 5)).toThrow(/empty/i);
  });

  test('throws when from >= to', () => {
    const msgs = makeSession(20);
    expect(() => computeSessionDiff(msgs, emptyConfig, 'sid', 10, 5)).toThrow(/less than/);
    expect(() => computeSessionDiff(msgs, emptyConfig, 'sid', 5, 5)).toThrow();
  });

  test('clamps out-of-range indices', () => {
    const msgs = makeSession(20);
    const diff = computeSessionDiff(msgs, emptyConfig, 'sid', -5, 999);
    expect(diff.fromIndex).toBe(1);
    expect(diff.toIndex).toBe(20);
  });

  test('reports positive totalDelta as context grows', () => {
    const msgs = makeSession(30);
    const diff = computeSessionDiff(msgs, emptyConfig, 'sid', 5, 25);
    expect(diff.totalTo).toBeGreaterThan(diff.totalFrom);
    expect(diff.totalDelta).toBe(diff.totalTo - diff.totalFrom);
    expect(diff.totalDelta).toBeGreaterThan(0);
  });

  test('emits one row per CRUSTS category in stable order', () => {
    const msgs = makeSession(20);
    const diff = computeSessionDiff(msgs, emptyConfig, 'sid', 5, 15);
    const expectedCategories = ['conversation', 'retrieved', 'user', 'system', 'tools', 'state'];
    expect(diff.categoryDeltas.map((c) => c.category)).toEqual(expectedCategories);
  });

  test('preserves sessionId in the result', () => {
    const msgs = makeSession(10);
    const diff = computeSessionDiff(msgs, emptyConfig, 'abc123', 2, 8);
    expect(diff.sessionId).toBe('abc123');
  });
});
