/**
 * Cross-command consistency regression tests.
 *
 * Different CRUSTS commands that all surface the "what /compact should I run?"
 * question MUST produce byte-identical strings for the same session — otherwise
 * users get contradictory guidance depending on which command they happened to
 * invoke.
 *
 * The commands in question:
 *   1. `fix`      → recommender.ts:generateFixPrompts().compactCommand    (block 3)
 *   2. `optimize` → optimizer.ts:buildOptimizeReport() → kind:'compact-focus'
 *   3. `analyze`  → recommender.ts:generateRecommendations() → first priority-1 rec
 *
 * All three delegate to optimizer.ts:buildCompactFocus(). If a future change
 * re-forks one path, these assertions fail and re-prompt the fix.
 */

import { describe, test, expect } from 'bun:test';
import { generateFixPrompts, generateRecommendations } from '../src/recommender.ts';
import { buildOptimizeReport } from '../src/optimizer.ts';
import type { CrustsBreakdown, WasteItem, ConfigData } from '../src/types.ts';

function breakdownAt(usagePct: number): CrustsBreakdown {
  return {
    buckets: [],
    total_tokens: Math.round(200_000 * (usagePct / 100)),
    context_limit: 200_000,
    free_tokens: 200_000 - Math.round(200_000 * (usagePct / 100)),
    usage_percentage: usagePct,
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
  } as CrustsBreakdown;
}

function emptyConfig(): ConfigData {
  return {
    systemPrompt: { files: [], totalEstimatedTokens: 500 },
    mcpServers: [],
    memoryFiles: { files: [], totalEstimatedTokens: 0 },
    builtInTools: { tools: [], totalEstimatedTokens: 0 },
    skills: { items: [], totalEstimatedTokens: 0 },
  };
}

/** Realistic waste fixture with all three targetable types. */
function fixtureWaste(): WasteItem[] {
  return [
    {
      type: 'duplicate_read',
      severity: 'high',
      description: '"renderer.ts" read 6 times',
      estimated_tokens: 1800,
      recommendation: '',
      message_range: [40, 120],
    },
    {
      type: 'stale_read',
      severity: 'medium',
      description: '"classifier.ts" read 40 msgs ago',
      estimated_tokens: 900,
      recommendation: '',
      message_range: [30, 40],
    },
    {
      type: 'resolved_exchange',
      severity: 'medium',
      description: 'resolved debug exchange',
      estimated_tokens: 600,
      recommendation: '',
      message_range: [110, 120],
    },
  ];
}

describe('cross-command /compact focus consistency (Bug #7)', () => {
  test('fix block 3 text === optimize compact-focus action for the same session', () => {
    const breakdown = breakdownAt(65);
    const waste = fixtureWaste();
    const config = emptyConfig();

    const fix = generateFixPrompts(breakdown, waste, config);
    const optimize = buildOptimizeReport('sid', breakdown, waste, config, [], '/tmp/proj');
    const compactFocusFix = optimize.fixes.find((f) => f.kind === 'compact-focus');

    expect(fix.compactCommand).not.toBeNull();
    expect(compactFocusFix).toBeDefined();
    expect(fix.compactCommand).toBe(compactFocusFix!.action);
  });

  test('analyze priority-1 compact recommendation === optimize compact-focus action', () => {
    const breakdown = breakdownAt(65);
    const waste = fixtureWaste();
    const config = emptyConfig();

    const recs = generateRecommendations(breakdown, waste, config, []);
    const optimize = buildOptimizeReport('sid', breakdown, waste, config, [], '/tmp/proj');
    const compactFocusFix = optimize.fixes.find((f) => f.kind === 'compact-focus');
    const priority1Compact = recs.recommendations.find(
      (r) => r.priority === 1 && r.action.startsWith('/compact'),
    );

    expect(priority1Compact).toBeDefined();
    expect(compactFocusFix).toBeDefined();
    expect(priority1Compact!.action).toBe(compactFocusFix!.action);
  });

  test('fix compactCommand contains the targeted drop-instructions, not the old thematic hint', () => {
    // Old buildCompactCommand produced `/compact focus on the <file>, <file> changes`.
    // New path produces `/compact focus "keep only latest read of ...; drop stale read of ..."`.
    // Guard against silent regression to the old format.
    const fix = generateFixPrompts(breakdownAt(65), fixtureWaste(), emptyConfig());
    expect(fix.compactCommand).toContain('/compact focus "');
    expect(fix.compactCommand).toContain('keep only latest read of renderer.ts');
    expect(fix.compactCommand).toContain('drop stale read of classifier.ts');
    expect(fix.compactCommand).not.toContain('focus on the');
  });
});
