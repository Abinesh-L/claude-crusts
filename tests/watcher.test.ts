/**
 * Review-fix regression: the watch surfaces report analyzed (non-attachment)
 * message counts, matching `analyze` on the same session (M11 exclusion
 * rule). Before the fix `watch --json` (and the dashboard) counted raw rows,
 * inflating the count by every attachment record Claude Code injected.
 */

import { describe, test, expect } from 'bun:test';
import { renderJsonUpdate } from '../src/watcher.ts';
import { countAnalyzedMessages } from '../src/classifier.ts';
import type { ClassifiedMessage, CrustsBreakdown, SessionInfo } from '../src/types.ts';

/** A classified row; attachment rows carry `isAttachment: true`. */
function row(index: number, isAttachment = false): ClassifiedMessage {
  return {
    index,
    category: isAttachment ? 'system' : 'conversation',
    tokens: 100,
    cumulativeTokens: (index + 1) * 100,
    accuracy: 'estimated',
    contentPreview: isAttachment ? '[attachment: hook_success]' : `msg ${index}`,
    ...(isAttachment ? { isAttachment: true } : {}),
  };
}

/** Minimal breakdown: 3 real messages interleaved with 2 attachment rows. */
function breakdownWithAttachments(): CrustsBreakdown {
  return {
    buckets: [],
    total_tokens: 500,
    context_limit: 200_000,
    free_tokens: 199_500,
    usage_percentage: 0.25,
    messages: [row(0), row(1, true), row(2), row(3, true), row(4)],
    toolBreakdown: {
      loadedTools: [], usedTools: [], unusedTools: [],
      schemaTokens: 0, callTokens: 0, resultTokens: 0,
      coreSchemaTokens: 0, coreSchemaSource: 'legacy',
      deferredBuiltIn: [], deferredMcp: [], loadedDeferred: [], loadedSchemaTokens: 0,
    },
    model: 'claude-opus-4-7',
    durationSeconds: null,
    compactionEvents: [],
    derivedOverhead: { internalSystemPrompt: null, messageFraming: null },
  } as unknown as CrustsBreakdown;
}

const SESSION: SessionInfo = {
  id: 'watcher-fixture',
  path: 'unused',
  project: 'test',
  modifiedAt: new Date(),
  sizeBytes: 0,
};

describe('watch --json messageCount matches analyze (attachment rows excluded)', () => {
  test('renderJsonUpdate reports the analyzed count, not the raw row count', () => {
    const bd = breakdownWithAttachments();
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      renderJsonUpdate(bd, 0, null, SESSION);
    } finally {
      console.log = original;
    }

    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as { messageCount: number };
    // 3 real messages; the 2 attachment rows are injected context, not
    // messages. analyze prints countAnalyzedMessages — watch must agree.
    expect(parsed.messageCount).toBe(3);
    expect(parsed.messageCount).toBe(countAnalyzedMessages(bd.messages));
    expect(parsed.messageCount).not.toBe(bd.messages.length);
  });
});
