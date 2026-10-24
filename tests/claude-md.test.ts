/**
 * CLAUDE.md size advice (0.8.2): one footprint, sized for the session.
 *
 * The waste item, the recommendation, the fix prompt and the optimizer all
 * read the same figure: the CLAUDE.md files the session's own
 * `instructions` records list (2.1.268+), else the disk scan, in the
 * session model's tokens. Their advice follows Claude Code's memory docs:
 * CLAUDE.local.md and @imports load with CLAUDE.md, so only path-scoped
 * rules or a subdirectory CLAUDE.md keep text out of every request.
 *
 * Config reads are sandboxed via CRUSTS_CONFIG_DIR_OVERRIDE; the disk-scan
 * tests redirect HOME / USERPROFILE to a temp folder.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir, tmpdir } from 'os';
import {
  classifySession,
  claudeMdFootprint,
  sessionClaudeMd,
  claudeMdLabel,
  CLAUDE_MD_SPLIT_ADVICE,
} from '../src/classifier.ts';
import { detectWaste, compactTargets } from '../src/waste-detector.ts';
import { generateRecommendations, generateFixPrompts } from '../src/recommender.ts';
import { buildOptimizeReport, buildCompactFocus } from '../src/optimizer.ts';
import { buildInjectionText, compactCommandFor } from '../src/auto-inject.ts';
import { readSystemPromptFiles } from '../src/scanner.ts';
import { sessionProjectPath } from '../src/analyzer.ts';
import { NEWER_TOKENIZER_FACTOR } from '../src/model-context.ts';
import type { ConfigData, CrustsBreakdown, SessionMessage, WasteItem } from '../src/types.ts';

/** Config data with only a CLAUDE.md total from disk (no file list). */
function config(claudeMdTokens = 0): ConfigData {
  return {
    systemPrompt: { files: [], totalEstimatedTokens: claudeMdTokens },
    mcpServers: [],
    memoryFiles: { files: [], totalEstimatedTokens: 0 },
    builtInTools: { tools: [], totalEstimatedTokens: 0 },
    skills: { items: [], totalEstimatedTokens: 0 },
  };
}

/** An `instructions` attachment as Claude Code 2.1.268+ writes it. */
function instructions(
  files: Array<{ path: string; type: string; chars: number }>,
  changed = false,
): SessionMessage {
  const content = files.map((f) => ({ path: f.path, type: f.type, content: 'x'.repeat(f.chars) }));
  return {
    type: 'attachment',
    uuid: `i-${files.length}-${changed}`,
    attachment: { type: 'instructions', files: content, ...(changed ? { changed: true, reason: 'changed' } : {}) },
    rendered: [{ content: content.map((f) => f.content).join('\n') }],
  } as SessionMessage;
}

/** A hand-built breakdown on `model`, optionally carrying a footprint. */
function breakdown(model: string, extra: Partial<CrustsBreakdown> = {}): CrustsBreakdown {
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
      coreSchemaTokens: 0, coreSchemaSource: 'legacy',
      deferredBuiltIn: [], deferredMcp: [], loadedDeferred: [], loadedSchemaTokens: 0,
    },
    model,
    durationSeconds: null,
    compactionEvents: [],
    derivedOverhead: { internalSystemPrompt: null, messageFraming: null },
    ...extra,
  } as CrustsBreakdown;
}

const HOME = homedir();
const USER_FILE = join(HOME, '.claude', 'CLAUDE.md');
const PARENT_FILE = join(HOME, 'work', 'CLAUDE.md');
const PROJECT_FILE = join(HOME, 'work', 'app', 'CLAUDE.md');
const LOCAL_FILE = join(HOME, 'work', 'app', 'CLAUDE.local.md');
const MEMORY_FILE = join(HOME, '.claude', 'projects', 'C--work-app', 'memory', 'MEMORY.md');

/** A recorded footprint over the threshold: 12,000 + 4,000 + 800 chars. */
const RECORDED = [
  { path: USER_FILE, type: 'User', chars: 800 },
  { path: PARENT_FILE, type: 'Project', chars: 4_000 },
  { path: PROJECT_FILE, type: 'Project', chars: 12_000 },
  { path: MEMORY_FILE, type: 'AutoMem', chars: 20_000 },
];

let sandbox: string;
let savedOverride: string | undefined;

beforeEach(() => {
  sandbox = resolve(mkdtempSync(join(tmpdir(), 'crusts-claudemd-')));
  savedOverride = process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
  process.env.CRUSTS_CONFIG_DIR_OVERRIDE = sandbox;
});

afterEach(() => {
  if (savedOverride === undefined) delete process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
  else process.env.CRUSTS_CONFIG_DIR_OVERRIDE = savedOverride;
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('claudeMdFootprint', () => {
  test('lists the recorded files, largest first, without auto-memory', () => {
    const fp = claudeMdFootprint([instructions(RECORDED)], config(99), 1);
    expect(fp.source).toBe('recorded');
    expect(fp.files.map((f) => f.path)).toEqual([PROJECT_FILE, PARENT_FILE, USER_FILE]);
    expect(fp.files.map((f) => f.tokens)).toEqual([3_000, 1_000, 200]);
    expect(fp.tokens).toBe(4_200);
  });

  test('scales by the tokenizer factor', () => {
    const fp = claudeMdFootprint([instructions(RECORDED)], config(), NEWER_TOKENIZER_FACTOR);
    expect(fp.tokens).toBe(Math.round(3_000 * NEWER_TOKENIZER_FACTOR) + Math.round(1_000 * NEWER_TOKENIZER_FACTOR)
      + Math.round(200 * NEWER_TOKENIZER_FACTOR));
  });

  test('a delta replaces the files it carries and adds new ones', () => {
    const fp = claudeMdFootprint([
      instructions(RECORDED),
      instructions([{ path: PROJECT_FILE, type: 'Project', chars: 2_000 }, { path: LOCAL_FILE, type: 'Local', chars: 400 }], true),
    ], config(), 1);
    expect(fp.files.find((f) => f.path === PROJECT_FILE)!.tokens).toBe(500);
    expect(fp.files.find((f) => f.path === LOCAL_FILE)!.tokens).toBe(100);
    expect(fp.tokens).toBe(500 + 1_000 + 200 + 100);
  });

  test('a later full record starts over', () => {
    const fp = claudeMdFootprint([
      instructions(RECORDED),
      instructions([{ path: USER_FILE, type: 'User', chars: 800 }]),
    ], config(), 1);
    expect(fp.files.map((f) => f.path)).toEqual([USER_FILE]);
    expect(fp.tokens).toBe(200);
  });

  test('without a recorded list, the disk total is scaled', () => {
    const fp = claudeMdFootprint([], config(2_000), NEWER_TOKENIZER_FACTOR);
    expect(fp.source).toBe('disk');
    expect(fp.tokens).toBe(Math.round(2_000 * NEWER_TOKENIZER_FACTOR));
    expect(fp.files).toEqual([]);
  });
});

describe('sessionClaudeMd', () => {
  test('the classifier sets the footprint from the session record', () => {
    const b = classifySession([instructions(RECORDED)], config(50));
    expect(b.claudeMd!.source).toBe('recorded');
    expect(b.claudeMd!.files.length).toBe(3);
  });

  test('files carry their share of the text Claude Code sent, so the advice and the buckets agree', () => {
    const files = [
      { path: PROJECT_FILE, type: 'Project', content: 'p'.repeat(6_000) },
      { path: MEMORY_FILE, type: 'AutoMem', content: 'm'.repeat(2_000) },
    ];
    // The sent text adds a preamble and a header per file to the contents.
    const record = {
      type: 'attachment',
      uuid: 'i-sent',
      attachment: { type: 'instructions', files },
      rendered: [{ content: 'Codebase and user instructions are shown below.\n' + files.map((f) => `Contents of ${f.path}:\n\n${f.content}`).join('\n\n') }],
    } as unknown as SessionMessage;
    const msgs: SessionMessage[] = [
      record,
      { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'hi' } } as SessionMessage,
      { type: 'assistant', uuid: 'a-1', message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 40_000, output_tokens: 10 } } } as SessionMessage,
    ];
    const b = classifySession(msgs, config());
    // 6,000 chars is 1,500 tokens; the file's share of the preamble and headers adds to it.
    expect(b.claudeMd!.tokens).toBeGreaterThan(1_500);
    // Top 5 shows the bucket's figure (knownClaudeMd); rounding apart, they match.
    expect(Math.abs(b.claudeMd!.tokens - b.derivedOverhead!.internalSystemPrompt!.derivation.knownClaudeMd)).toBeLessThanOrEqual(1);
  });

  test('a hand-built breakdown falls back to the disk total in its model tokens', () => {
    expect(sessionClaudeMd(breakdown('claude-opus-4-7'), config(2_000)).tokens).toBe(Math.round(2_000 * NEWER_TOKENIZER_FACTOR));
    expect(sessionClaudeMd(breakdown('claude-sonnet-4-5'), config(2_000)).tokens).toBe(2_000);
  });

  test('labels are home-relative', () => {
    expect(claudeMdLabel(PROJECT_FILE)).toBe('~/work/app/CLAUDE.md');
    expect(claudeMdLabel('/srv/repo/CLAUDE.md')).toBe('/srv/repo/CLAUDE.md');
  });
});

describe('CLAUDE.md size advice', () => {
  const recorded = (): CrustsBreakdown => breakdown('claude-sonnet-4-5', {
    claudeMd: claudeMdFootprint([instructions(RECORDED)], config(), 1),
  });

  /** True when text tells the user to move content into CLAUDE.local.md. */
  const movesToLocal = (text: string): boolean => /(move|moving)[^.;]*\bto CLAUDE\.local\.md/i.test(text);

  test('the advice names the mechanisms that load on demand', () => {
    expect(CLAUDE_MD_SPLIT_ADVICE).toContain('.claude/rules/');
    expect(CLAUDE_MD_SPLIT_ADVICE).toContain('paths:');
    expect(CLAUDE_MD_SPLIT_ADVICE).toContain('saves nothing');
    expect(CLAUDE_MD_SPLIT_ADVICE).not.toContain('—');
  });

  test('waste item: every file named, sized from the footprint', () => {
    const item = detectWaste([], recorded(), config()).find((w) => w.type === 'oversized_system')!;
    expect(item.description).toContain('~4,200 tokens');
    expect(item.description).toContain('~/work/app/CLAUDE.md ~3,000 tokens');
    expect(item.description).toContain('~/work/CLAUDE.md ~1,000 tokens');
    expect(item.estimated_tokens).toBe(4_200 - 1_500);
    expect(item.recommendation).toBe(CLAUDE_MD_SPLIT_ADVICE);
  });

  test('recommendation and fix prompt carry the same advice', () => {
    const b = recorded();
    const rec = generateRecommendations(b, [], config(), []).recommendations.find((r) => r.action.startsWith('CLAUDE.md files'))!;
    expect(rec.impact).toBe(2_700);
    expect(rec.reason).toContain('~/work/app/CLAUDE.md: 1 lines, ~3,000 tokens');
    expect(rec.reason).toContain(CLAUDE_MD_SPLIT_ADVICE);
    expect(movesToLocal(rec.action + rec.reason)).toBe(false);

    // fix: the size note is for the person, never inside the CLAUDE.md paste block.
    const fix = generateFixPrompts(b, [], config());
    expect(fix.claudeMdSnippet).toBeNull();
    expect(fix.claudeMdNote).toContain('~4,200 tokens');
    expect(fix.claudeMdNote).toContain(CLAUDE_MD_SPLIT_ADVICE);
    expect(movesToLocal(fix.claudeMdNote!)).toBe(false);
  });

  test('optimizer fix names the largest files', () => {
    const fix = buildOptimizeReport('sid', recorded(), [], config(), [], sandbox).fixes.find((f) => f.kind === 'claudemd-oversized')!;
    expect(fix.estimatedSavings).toBe(2_700);
    expect(fix.description).toContain('Largest: ~/work/app/CLAUDE.md ~3,000 tokens, ~/work/CLAUDE.md ~1,000 tokens');
    expect(movesToLocal(fix.description)).toBe(false);
    expect(fix.action).not.toContain('—');
  });

  test('a footprint under the budget produces no advice', () => {
    const small = breakdown('claude-sonnet-4-5', {
      claudeMd: claudeMdFootprint([instructions([{ path: USER_FILE, type: 'User', chars: 800 }])], config(), 1),
    });
    expect(detectWaste([], small, config(9_999)).some((w) => w.type === 'oversized_system')).toBe(false);
    expect(buildOptimizeReport('sid', small, [], config(9_999), [], sandbox).fixes.some((f) => f.kind === 'claudemd-oversized')).toBe(false);
  });
});

describe('compact targets leave out what /compact cannot free', () => {
  const claudeMdItem: WasteItem = {
    type: 'oversized_system', severity: 'medium', description: 'CLAUDE.md files add ~9,000 tokens to every request',
    estimated_tokens: 7_500, recommendation: CLAUDE_MD_SPLIT_ADVICE,
  };
  const dupe = (name: string, tokens: number): WasteItem => ({
    type: 'duplicate_read', severity: 'medium', description: `"${name}" read 2 times (earlier reads at #3 are redundant)`,
    estimated_tokens: tokens, recommendation: '', message_range: [3, 4],
  });
  const waste = [claudeMdItem, dupe('a.ts', 900), dupe('b.ts', 800), dupe('c.ts', 700)];

  test('CLAUDE.md size takes no target slot and adds no savings', () => {
    expect(compactTargets(waste).map((w) => w.type)).toEqual(['duplicate_read', 'duplicate_read', 'duplicate_read']);
    const focus = buildCompactFocus(waste)!;
    expect(focus.text).toBe('/compact focus "keep only latest read of a.ts; keep only latest read of b.ts; keep only latest read of c.ts"');
    expect(focus.savings).toBe(2_400);
    expect(compactCommandFor(waste)).toBe(focus.text);
    expect(buildInjectionText(breakdown('claude-sonnet-4-5'), waste, 80)).toContain('~2,400 tokens of reclaimable waste');
  });

  test('alone, it leaves nothing to target', () => {
    expect(buildCompactFocus([claudeMdItem])).toBeNull();
    expect(compactCommandFor([claudeMdItem])).toBe('/compact');
  });
});

describe('readSystemPromptFiles', () => {
  /** Run with HOME / USERPROFILE pointing at a temp folder. */
  function withHome<T>(home: string, fn: () => T): T {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      return fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  test('reads what Claude Code loads at launch: parents, .claude/CLAUDE.md, CLAUDE.local.md; never settings.json', () => {
    const home = join(sandbox, 'home');
    const project = join(home, 'work', 'app');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'user rules');
    writeFileSync(join(home, 'work', 'CLAUDE.md'), 'parent rules');
    writeFileSync(join(project, 'CLAUDE.md'), 'project rules');
    writeFileSync(join(project, '.claude', 'CLAUDE.md'), 'dot-claude rules');
    writeFileSync(join(project, 'CLAUDE.local.md'), 'local rules');
    writeFileSync(join(project, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash(ls:*)"]}}');

    const result = withHome(home, () => readSystemPromptFiles(project));
    expect(result.files.some((f) => f.path.endsWith('settings.json'))).toBe(false);
    // The walk continues above the temp home (real folders, read only); only
    // the files under it are this fixture's.
    const root = home.replace(/\\/g, '/');
    const names = result.files
      .map((f) => f.path.replace(/\\/g, '/'))
      .filter((p) => p.startsWith(root + '/'))
      .map((p) => p.slice(root.length));
    expect(names).toEqual([
      '/.claude/CLAUDE.md',
      '/work/CLAUDE.md',
      '/work/app/CLAUDE.md',
      '/work/app/.claude/CLAUDE.md',
      '/work/app/CLAUDE.local.md',
    ]);
    expect(result.totalEstimatedTokens).toBe(result.files.reduce((sum, f) => sum + f.estimatedTokens, 0));
  });
});

describe('sessionProjectPath', () => {
  /** A user record written in the folder `cwd`. */
  const at = (cwd: string): SessionMessage => ({ type: 'user', cwd, message: { role: 'user', content: 'hi' } } as SessionMessage);

  test('the folder the session started in, which a hyphenated slug cannot decode', () => {
    const project = join(sandbox, 'career-ops');
    mkdirSync(join(project, 'sub'), { recursive: true });
    // Later records follow a cd; the first one is where the session started.
    const msgs = [at(project), at(join(project, 'sub'))];
    expect(sessionProjectPath(msgs, join(sandbox, 'C--x-career-ops', 's.jsonl'))).toBe(project);
  });

  test('a start folder that no longer exists falls back to the slug decode', () => {
    expect(sessionProjectPath([at(join(sandbox, 'gone'))], join(sandbox, 'C--nowhere', 's.jsonl'))).toBeUndefined();
  });
});
