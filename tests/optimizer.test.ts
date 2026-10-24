import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { buildOptimizeReport, parseFixKinds, FIX_KINDS, gitOutputFolder } from '../src/optimizer.ts';
import type { OptimizeOptions } from '../src/optimizer.ts';
import { classifySession } from '../src/classifier.ts';
import { spawnSync } from 'child_process';
import { NEWER_TOKENIZER_FACTOR } from '../src/model-context.ts';
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
      coreSchemaTokens: 0, coreSchemaSource: 'legacy',
      deferredBuiltIn: [], deferredMcp: [], loadedDeferred: [], loadedSchemaTokens: 0,
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

  test('does not flag src/ or other legitimate reads', () => {
    const msgs: SessionMessage[] = [
      ...readMsg('/tmp/proj/src/index.ts', 'r1', 'a'.repeat(4000)),
    ];
    const report = buildOptimizeReport('sid', emptyBreakdown(), [], emptyConfigData(), msgs, '/tmp/proj');
    expect(report.fixes.some((f) => f.kind === 'read-deny')).toBe(false);
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
    // 3,000 disk tokens on Opus 4.7's tokenizer, minus the 1,500 threshold
    expect(warning!.estimatedSavings).toBe(Math.round(3000 * NEWER_TOKENIZER_FACTOR) - 1500);
    expect(warning!.autoApplicable).toBe(false);
  });

  test('ranks fixes by savings descending and sums total saveable', () => {
    const waste: WasteItem[] = [
      { type: 'duplicate_read', severity: 'high', description: '"r.ts" read 6 times', estimated_tokens: 2500, recommendation: '' },
    ];
    const msgs: SessionMessage[] = [
      ...readMsg('/tmp/proj/node_modules/a/b.js', 'r1', 'x'.repeat(10000)),
    ];
    const report = buildOptimizeReport('sid', classifySession(msgs, emptyConfigData(2500)), waste, emptyConfigData(2500), msgs, '/tmp/proj');
    expect(report.fixes.some((f) => f.kind === 'read-deny')).toBe(true);
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

// The read-deny fix reads the project's .claude/settings.local.json, CLAUDE.md
// and .claudeignore, so these tests run against a temp project folder. The
// config dir override keeps loadWasteThresholds off the real ~/.claude-crusts.
describe('buildOptimizeReport: read-deny fix', () => {
  let sandbox: string;
  let project: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    sandbox = resolve(mkdtempSync(join(tmpdir(), 'crusts-read-deny-')));
    project = join(sandbox, 'proj');
    mkdirSync(project, { recursive: true });
    savedConfigDir = process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
    process.env.CRUSTS_CONFIG_DIR_OVERRIDE = join(sandbox, 'config');
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
    else process.env.CRUSTS_CONFIG_DIR_OVERRIDE = savedConfigDir;
    rmSync(sandbox, { recursive: true, force: true });
  });

  /**
   * Build the report for these messages against the temp project, sized from
   * their classification. Output folders count as confirmed unless the
   * options say otherwise (`gitOutputFolder` has its own tests).
   */
  function report(msgs: SessionMessage[], options: OptimizeOptions = {}, at: string = project) {
    return buildOptimizeReport('sid', classifySession(msgs, emptyConfigData()), [], emptyConfigData(), msgs, at, { isOutputFolder: () => true, ...options });
  }

  /** Classified tokens of the tool_result answering `id`. */
  function resultRow(msgs: SessionMessage[], id: string): number {
    const index = msgs.findIndex((m) => m.type === 'user' && Array.isArray(m.message?.content)
      && m.message!.content.some((b) => b.type === 'tool_result' && b.tool_use_id === id));
    return classifySession(msgs, emptyConfigData()).messages[index]!.tokens;
  }

  test('proposes anchored Read deny rules for noise paths read in the project', () => {
    const msgs: SessionMessage[] = [
      ...readMsg(join(project, 'node_modules', 'chalk', 'index.js'), 'r1', 'a'.repeat(4000)),
      ...readMsg(join(project, 'dist', 'bundle.js'), 'r2', 'b'.repeat(3000)),
    ];
    const fix = report(msgs).fixes.find((f) => f.kind === 'read-deny');
    expect(fix).toBeDefined();
    expect(fix!.autoApplicable).toBe(true);
    // node_modules is noise at any depth; an output folder's rule names the folder read.
    expect(fix!.denyRules).toEqual(['Read(/**/node_modules/**)', 'Read(/dist/**)']);
    expect(fix!.action).toBe('Read(/**/node_modules/**)\nRead(/dist/**)');
    expect(fix!.applyTarget).toBe(join(project, '.claude', 'settings.local.json'));
    expect(fix!.applyContent).toBeUndefined();
    expect(fix!.title).toBe('Make Claude Code refuse to read node_modules/ and dist/');
    expect(fix!.description).toContain('node_modules (installed deps): 1 file(s) read');
    expect(fix!.description).toContain('Claude Code will refuse to read these paths');
    expect(fix!.description).not.toContain('—');
    // Each read costs its own classified result row, the figure every view uses.
    expect(fix!.estimatedSavings).toBe(resultRow(msgs, 'r1') + resultRow(msgs, 'r2'));
  });

  test('an output folder git does not confirm gets no rule; node_modules still does', () => {
    const msgs: SessionMessage[] = [
      ...readMsg(join(project, 'node_modules', 'chalk', 'index.js'), 'r1', 'a'.repeat(4000)),
      ...readMsg(join(project, 'build', 'ci', 'Dockerfile'), 'r2', 'b'.repeat(3000)),
    ];
    const asked: string[] = [];
    const fix = report(msgs, { isOutputFolder: (_root, folder) => { asked.push(folder); return false; } })
      .fixes.find((f) => f.kind === 'read-deny');
    expect(asked).toEqual(['build']);
    expect(fix!.denyRules).toEqual(['Read(/**/node_modules/**)']);
  });

  test('output folders match their own spelling and are anchored where they were read', () => {
    const msgs: SessionMessage[] = [
      ...readMsg(join(project, 'llvm', 'lib', 'Target', 'X86', 'X86ISelLowering.cpp'), 'r1', 'a'.repeat(4000)),
      ...readMsg(join(project, 'packages', 'web', 'dist', 'bundle.js'), 'r2', 'b'.repeat(4000)),
    ];
    const fix = report(msgs).fixes.find((f) => f.kind === 'read-deny');
    // LLVM's Target/ is source: only lowercase target/ is an output folder.
    expect(fix!.denyRules).toEqual(['Read(/packages/web/dist/**)']);
    expect(fix!.title).toBe('Make Claude Code refuse to read packages/web/dist/');
  });

  test('nested copies of a noise folder share one any-depth rule', () => {
    const msgs: SessionMessage[] = [
      ...readMsg(join(project, 'node_modules', 'a.js'), 'r1', 'a'.repeat(2000)),
      ...readMsg(join(project, 'packages', 'web', 'node_modules', 'react', 'index.js'), 'r2', 'b'.repeat(2000)),
    ];
    const fix = report(msgs).fixes.find((f) => f.kind === 'read-deny');
    expect(fix!.denyRules).toEqual(['Read(/**/node_modules/**)']);
    expect(fix!.description).toContain('node_modules (installed deps): 2 file(s) read');
  });

  test('lock files get one rule per file name, including package-lock.json and pnpm-lock.yaml', () => {
    const msgs: SessionMessage[] = [
      ...readMsg(join(project, 'bun.lock'), 'r1', 'a'.repeat(2000)),
      ...readMsg(join(project, 'packages', 'a', 'package-lock.json'), 'r2', 'b'.repeat(2000)),
      ...readMsg(join(project, 'pnpm-lock.yaml'), 'r3', 'c'.repeat(2000)),
    ];
    const fix = report(msgs).fixes.find((f) => f.kind === 'read-deny');
    expect(fix!.denyRules).toEqual(['Read(/**/bun.lock)', 'Read(/**/package-lock.json)', 'Read(/**/pnpm-lock.yaml)']);
    expect(fix!.description).toContain('bun.lock (lock file, auto-generated)');
  });

  test('skips reads outside the project: a rule in its settings cannot block them', () => {
    const msgs: SessionMessage[] = [
      ...readMsg(join(sandbox, 'elsewhere', 'node_modules', 'x', 'index.js'), 'r1', 'a'.repeat(9000)),
    ];
    expect(report(msgs).fixes.some((f) => f.kind === 'read-deny')).toBe(false);
  });

  test('matches noise folders below the project root only', () => {
    // A project that lives inside a folder named "build": its own source is not build output.
    const nested = join(sandbox, 'build', 'app');
    mkdirSync(nested, { recursive: true });
    const src = readMsg(join(nested, 'src', 'index.ts'), 'r1', 'a'.repeat(9000));
    expect(report(src, {}, nested).fixes.some((f) => f.kind === 'read-deny')).toBe(false);

    const out = readMsg(join(nested, 'build', 'out.js'), 'r2', 'a'.repeat(9000));
    expect(report(out, {}, nested).fixes.find((f) => f.kind === 'read-deny')!.denyRules).toEqual(['Read(/build/**)']);
  });

  test('rules keep the path\'s spelling and failed reads are not counted', () => {
    const [failedUse] = readMsg(join(project, 'dist', 'missing.js'), 'r1', '');
    const failedResult = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'File does not exist.'.repeat(50), is_error: true }] },
    } as SessionMessage;
    const msgs: SessionMessage[] = [
      failedUse,
      failedResult,
      ...readMsg(join(project, 'Cargo.lock'), 'r2', 'c'.repeat(2000)),
    ];
    const fix = report(msgs).fixes.find((f) => f.kind === 'read-deny');
    expect(fix!.denyRules).toEqual(['Read(/**/Cargo.lock)']);
    expect(fix!.title).toBe('Make Claude Code refuse to read Cargo.lock');
  });

  test('a relative read path resolves against the record\'s cwd', () => {
    const [use, result] = readMsg('node_modules/x/index.js', 'r1', 'a'.repeat(4000));
    use.cwd = project;
    const fix = report([use, result]).fixes.find((f) => f.kind === 'read-deny');
    expect(fix!.denyRules).toEqual(['Read(/**/node_modules/**)']);
  });

  test('rules already in settings.local.json are not proposed again', () => {
    mkdirSync(join(project, '.claude'));
    writeFileSync(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { deny: ['Read(/**/node_modules/**)'] } }),
    );
    const msgs: SessionMessage[] = [
      ...readMsg(join(project, 'node_modules', 'a.js'), 'r1', 'a'.repeat(4000)),
      ...readMsg(join(project, 'dist', 'b.js'), 'r2', 'b'.repeat(3000)),
    ];
    const fix = report(msgs).fixes.find((f) => f.kind === 'read-deny');
    expect(fix!.denyRules).toEqual(['Read(/dist/**)']);
    expect(fix!.estimatedSavings).toBe(resultRow(msgs, 'r2'));

    writeFileSync(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { deny: ['Read(/**/node_modules/**)', 'Read(/dist/**)'] } }),
    );
    expect(report(msgs).fixes.some((f) => f.kind === 'read-deny')).toBe(false);
  });

  test('says when settings.local.json is not valid JSON', () => {
    mkdirSync(join(project, '.claude'));
    writeFileSync(join(project, '.claude', 'settings.local.json'), '{ "permissions": ');
    const msgs = readMsg(join(project, 'dist', 'b.js'), 'r1', 'b'.repeat(3000));
    const fix = report(msgs).fixes.find((f) => f.kind === 'read-deny');
    expect(fix!.description).toContain('.claude/settings.local.json cannot be updated yet: it is not valid JSON');
  });

  test('says that an existing .claudeignore has no effect', () => {
    writeFileSync(join(project, '.claudeignore'), 'dist/\n');
    const msgs = readMsg(join(project, 'dist', 'b.js'), 'r1', 'b'.repeat(3000));
    const fix = report(msgs).fixes.find((f) => f.kind === 'read-deny');
    expect(fix!.description).toContain('.claudeignore has no effect');
  });

  test('offers the CLAUDE.md section only where the deny rules cannot apply', () => {
    writeFileSync(join(project, 'CLAUDE.md'), '# Project\n');
    const msgs = readMsg(join(project, 'dist', 'b.js'), 'r1', 'b'.repeat(3000));
    // Next to enforced deny rules it saves nothing and costs tokens every request.
    expect(report(msgs).fixes.some((f) => f.kind === 'claudemd-rule')).toBe(false);

    // Filtered to it, the section is the only protection on offer.
    const md = report(msgs, { filter: ['claudemd-rule'] }).fixes.find((f) => f.kind === 'claudemd-rule');
    expect(md).toBeDefined();
    expect(md!.applyContent).toContain('- dist (build output)');
    expect(md!.applyContent).not.toContain('\u2014');

    // A settings file the deny rules cannot be merged into: offered alongside.
    mkdirSync(join(project, '.claude'));
    writeFileSync(join(project, '.claude', 'settings.local.json'), '{ "permissions": ');
    expect(report(msgs).fixes.some((f) => f.kind === 'claudemd-rule')).toBe(true);
  });

  test('without a project folder, no file fix is offered', () => {
    const msgs = readMsg(join(project, 'node_modules', 'a.js'), 'r1', 'a'.repeat(4000));
    const out = buildOptimizeReport('sid', classifySession(msgs, emptyConfigData()), [], emptyConfigData(), msgs, undefined);
    expect(out.fixes.some((f) => f.kind === 'read-deny' || f.kind === 'claudemd-rule')).toBe(false);
  });
});

describe('gitOutputFolder', () => {
  let repo: string;

  beforeEach(() => {
    repo = resolve(mkdtempSync(join(tmpdir(), 'crusts-git-output-')));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** Run git in the temp repo. */
  const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });

  test('ignored or untracked folders are output; a folder with tracked files is not', () => {
    git('init', '-q');
    writeFileSync(join(repo, '.gitignore'), 'dist/\n');
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'a.js'), 'x');
    mkdirSync(join(repo, 'build', 'ci'), { recursive: true });
    writeFileSync(join(repo, 'build', 'ci', 'Dockerfile'), 'FROM scratch');
    mkdirSync(join(repo, 'target'));
    writeFileSync(join(repo, 'target', 'app'), 'bin');
    git('add', '.gitignore', 'build');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

    expect(gitOutputFolder(repo, 'dist')).toBe(true);    // ignored
    expect(gitOutputFolder(repo, 'build')).toBe(false);  // holds tracked source
    expect(gitOutputFolder(repo, 'target')).toBe(true);  // untracked, nothing tracked in it
  });

  test('outside a repository nothing is confirmed', () => {
    mkdirSync(join(repo, 'dist'));
    expect(gitOutputFolder(repo, 'dist')).toBe(false);
  });
});

describe('parseFixKinds', () => {
  test('accepts every current kind, trimmed and case-insensitive, without duplicates', () => {
    const parsed = parseFixKinds(` ${FIX_KINDS.join(' , ')} ,READ-DENY,`);
    expect(parsed.kinds).toEqual([...FIX_KINDS]);
    expect(parsed.unknown).toEqual([]);
    expect(parsed.renamed).toEqual([]);
  });

  test('maps the old claudeignore name to read-deny and reports it', () => {
    const parsed = parseFixKinds('claudeignore,compact-focus');
    expect(parsed.kinds).toEqual(['read-deny', 'compact-focus']);
    expect(parsed.renamed).toEqual(['claudeignore']);
  });

  test('returns unknown names instead of dropping them', () => {
    const parsed = parseFixKinds('compact-focus,claude-ignore');
    expect(parsed.kinds).toEqual(['compact-focus']);
    expect(parsed.unknown).toEqual(['claude-ignore']);
  });
});
