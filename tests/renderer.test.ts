/**
 * Review-fix regression: the timeline compaction prediction divides by the
 * analyzed (non-attachment) row count. Raw division diluted the per-message
 * average on attachment-heavy sessions and overstated the remaining runway.
 *
 * Sandboxes CRUSTS_CONFIG_DIR_OVERRIDE because the prediction reads the
 * `autocompactBufferTokens` config override.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { renderTimeline } from '../src/renderer.ts';
import type { ClassifiedMessage } from '../src/types.ts';

/** Strip ANSI color codes from captured console output. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

describe('renderTimeline prediction uses the analyzed row count (sandboxed)', () => {
  let sandbox: string;
  let savedOverride: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'crusts-renderer-'));
    savedOverride = process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
    process.env.CRUSTS_CONFIG_DIR_OVERRIDE = sandbox;
  });

  afterEach(() => {
    if (savedOverride === undefined) {
      delete process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
    } else {
      process.env.CRUSTS_CONFIG_DIR_OVERRIDE = savedOverride;
    }
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('attachment rows do not dilute the per-message average', () => {
    // 4 real messages of 1,000 tokens interleaved with 4 zero-token
    // attachment rows: cumulative 4,000. Undiluted average 1,000/msg ->
    // floor((167,000 - 4,000) / 1,000) = 163 more messages, printed as
    // "~171" (8 rendered rows + 163). The raw divisor (8 rows) halved the
    // average and printed ~334.
    const classified: ClassifiedMessage[] = [];
    let cumulative = 0;
    for (let i = 0; i < 8; i++) {
      const isAttachment = i % 2 === 1;
      if (!isAttachment) cumulative += 1_000;
      classified.push({
        index: i,
        category: isAttachment ? 'system' : 'conversation',
        tokens: isAttachment ? 0 : 1_000,
        cumulativeTokens: cumulative,
        accuracy: 'estimated',
        contentPreview: isAttachment ? '[attachment: task_reminder]' : `msg ${i}`,
        ...(isAttachment ? { isAttachment: true } : {}),
      });
    }

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      renderTimeline(classified, 200_000, []);
    } finally {
      console.log = original;
    }

    const output = stripAnsi(lines.join('\n'));
    expect(output).toContain('Compaction predicted at message ~171');
    expect(output).not.toContain('~334');
  });
});
