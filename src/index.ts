#!/usr/bin/env node
/**
 * CRUSTS CLI entrypoint.
 *
 * Context window analyzer for Claude Code — breaks down token usage
 * into the 6 CRUSTS categories: Conversation, Retrieved, User,
 * System, Tools, State & Memory.
 */

import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { discoverSessions, parseSession } from './scanner.ts';
import { analyzeSession, gatherConfigData } from './analyzer.ts';
import { setVerbose, classifySession } from './classifier.ts';
import { runCalibration, renderCalibrationComparison } from './calibrator.ts';
import { compareSessions } from './comparator.ts';
import { generateSessionReport, generateComparisonReport } from './html-report.ts';
import { generateSessionReportMd, generateComparisonReportMd } from './md-report.ts';
import { analyzeLostContent } from './lost-detector.ts';
import { startWatch } from './watcher.ts';
import { startTui } from './tui.ts';
import { enableHooks, disableHooks, hooksStatus, enableAutoInject, disableAutoInject, autoInjectStatus } from './hooks.ts';
import { runAutoInject } from './auto-inject.ts';
import {
  installStatusline,
  uninstallStatusline,
  statuslineStatus,
  renderStatusline,
  readStatuslinePayload,
} from './statusline.ts';
import {
  buildOptimizeReport,
  renderOptimizeReport,
  applyFix,
} from './optimizer.ts';
import type { FixKind } from './optimizer.ts';
import { runDoctor, renderDoctor } from './doctor.ts';
import { generateCompletionScript } from './completion.ts';
import type { CompletionShell } from './completion.ts';
import { computeSessionDiff, renderSessionDiff } from './session-diff.ts';
import {
  runBenchCompact,
  renderBenchResult,
  loadBenchResult,
  compareBenchResults,
  renderBenchComparison,
  reextractSummaryRefs,
} from './bench.ts';
import { renderAnalysis, renderTimeline, renderList, renderWaste, renderFix, renderComparison, renderLost, renderTrend, renderModelHistory } from './renderer.ts';
import { generateFixPrompts } from './recommender.ts';
import { loadTrendHistory, summarizeTrend, formatTrendAsCsv } from './trend.ts';
import { VERSION } from './version.ts';
import type { SessionInfo } from './types.ts';

const program = new Command();

program
  .name('claude-crusts')
  .description('Break down your Claude Code context window into the 6 CRUSTS categories')
  .version(VERSION)
  .option('--path <path>', 'Custom path to JSONL session files')
  .option('--json', 'Output as JSON instead of formatted tables')
  .option('--project <name>', 'Filter by project name')
  .option('--verbose', 'Show derivation debug output');

program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  if (opts.verbose) setVerbose(true);
});

program
  .command('analyze [session-id]')
  .description('Analyze a specific session or the most recent one')
  .option('--until <n>', 'Analyze only up to message N (1-based)')
  .action(async (sessionId: string | undefined, options: { until?: string }, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    const session = resolveSession(sessionId, globals.path, globals.project);
    if (!session) return;

    const untilIndex = options.until ? parseInt(options.until, 10) : undefined;
    const result = await analyzeSession(session.path, session.id, session.project, { untilIndex });
    if (!result) {
      console.error(chalk.red('No messages found in session.'));
      return;
    }

    if (globals.json) {
      const { messages: _msgs, ...jsonResult } = result;
      console.log(JSON.stringify(jsonResult, null, 2));
      return;
    }

    renderAnalysis(
      result.breakdown,
      result.waste,
      result.recommendations,
      result.sessionId,
      result.project,
      result.messageCount,
    );

    if (result.calibration) {
      renderCalibrationComparison(result.calibration);
    }
  });

program
  .command('list')
  .description('List all available sessions with basic stats')
  .action((_options: unknown, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    const sessions = discoverSessions(globals.path);

    if (sessions.length === 0) return;

    // Filter by project if specified
    const filtered = globals.project
      ? sessions.filter((s) => s.project.toLowerCase().includes(globals.project.toLowerCase()))
      : sessions;

    if (globals.json) {
      console.log(JSON.stringify(filtered, null, 2));
      return;
    }

    renderList(filtered);

    // Show context file summary
    const configData = gatherConfigData();
    console.log(chalk.bold('  Context sources:'));
    if (configData.systemPrompt.files.length > 0) {
      console.log(`    System prompt files: ${configData.systemPrompt.files.length} (~${configData.systemPrompt.totalEstimatedTokens.toLocaleString()} tokens)`);
    }
    if (configData.mcpServers.length > 0) {
      console.log(`    MCP servers: ${configData.mcpServers.length} (${configData.mcpServers.map((s) => s.name).join(', ')})`);
    }
    if (configData.memoryFiles.files.length > 0) {
      console.log(`    Memory files: ${configData.memoryFiles.files.length} (~${configData.memoryFiles.totalEstimatedTokens.toLocaleString()} tokens)`);
    }
    console.log(`    Built-in tools: ${configData.builtInTools.tools.length} (~${configData.builtInTools.totalEstimatedTokens.toLocaleString()} tokens)`);
    if (configData.skills.items.length > 0) {
      console.log(`    Skills: ${configData.skills.items.length} (${configData.skills.items.map((s) => s.name).join(', ')})`);
    }
    console.log();
  });

program
  .command('timeline [session-id]')
  .description('Show how context grew over the session message by message')
  .option('--until <n>', 'Analyze only up to message N (1-based)')
  .action(async (sessionId: string | undefined, options: { until?: string }, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    const session = resolveSession(sessionId, globals.path, globals.project);
    if (!session) return;

    const untilIndex = options.until ? parseInt(options.until, 10) : undefined;
    const result = await analyzeSession(session.path, session.id, session.project, { untilIndex });
    if (!result) {
      console.error(chalk.red('No messages found in session.'));
      return;
    }

    if (globals.json) {
      console.log(JSON.stringify(result.breakdown.messages, null, 2));
      return;
    }

    console.log(chalk.bold(`\n  Timeline: ${session.id.slice(0, 8)}`));
    console.log(chalk.dim(`  Messages: ${result.messageCount} | Project: ${session.project}`));

    renderTimeline(result.breakdown.messages, result.breakdown.context_limit, result.breakdown.compactionEvents);
  });

program
  .command('waste [session-id]')
  .description('Focus on waste detection and recommendations')
  .option('--until <n>', 'Analyze only up to message N (1-based)')
  .action(async (sessionId: string | undefined, options: { until?: string }, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    const session = resolveSession(sessionId, globals.path, globals.project);
    if (!session) return;

    const untilIndex = options.until ? parseInt(options.until, 10) : undefined;
    const result = await analyzeSession(session.path, session.id, session.project, { untilIndex });
    if (!result) {
      console.error(chalk.red('No messages found in session.'));
      return;
    }

    if (globals.json) {
      console.log(JSON.stringify({ waste: result.waste, recommendations: result.recommendations }, null, 2));
      return;
    }

    console.log(chalk.bold(`\n  Waste Detection Report`));
    console.log(chalk.dim(`  Session: ${session.id.slice(0, 8)} | Messages: ${result.messageCount}`));

    renderWaste(result.waste, result.recommendations, result.breakdown.total_tokens);
  });

program
  .command('fix [session-id]')
  .description('Generate pasteable fix prompts for a session')
  .action(async (sessionId: string | undefined, _options: unknown, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    const session = resolveSession(sessionId, globals.path, globals.project);
    if (!session) return;

    const result = await analyzeSession(session.path, session.id, session.project);
    if (!result) {
      console.error(chalk.red('No messages found in session.'));
      return;
    }

    const fix = generateFixPrompts(result.breakdown, result.waste, result.configData);

    if (globals.json) {
      console.log(JSON.stringify(fix, null, 2));
      return;
    }

    renderFix(fix, result.sessionId);
  });

program
  .command('optimize [session-id]')
  .description('Ranked, actionable fixes with token-savings ROI (auto-apply with --apply)')
  .option('--apply', 'Apply auto-applicable fixes with per-fix confirmation')
  .option('--yes', 'Skip per-fix confirmations (requires --apply)')
  .option('--min-savings <n>', 'Skip fixes saving less than N tokens', '100')
  .option('--filter <types>', 'Only show fixes of listed kinds (comma-separated)')
  .option('--project-path <path>', 'Project root for .claudeignore / CLAUDE.md writes (default: cwd)')
  .action(async (sessionId: string | undefined, options: { apply?: boolean; yes?: boolean; minSavings?: string; filter?: string; projectPath?: string }, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    const session = resolveSession(sessionId, globals.path, globals.project);
    if (!session) return;

    const result = await analyzeSession(session.path, session.id, session.project);
    if (!result) {
      console.error(chalk.red('No messages found in session.'));
      return;
    }

    const minSavings = parseInt(options.minSavings ?? '100', 10);
    const filter = options.filter
      ? options.filter.split(',').map((s) => s.trim()).filter(Boolean) as FixKind[]
      : undefined;

    const projectPath = options.projectPath
      ? resolve(options.projectPath)
      : process.cwd();

    const report = buildOptimizeReport(
      result.sessionId,
      result.breakdown,
      result.waste,
      result.configData,
      result.messages,
      projectPath,
      { minSavings, filter },
    );

    if (globals.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    renderOptimizeReport(report);

    if (!options.apply) return;
    if (report.fixes.length === 0) return;

    console.log(chalk.bold('  Applying fixes...'));
    console.log();
    for (const fix of report.fixes) {
      const result = await applyFix(fix, { yes: options.yes });
      const tag =
        result.status === 'applied' ? chalk.green('\u2713 applied') :
        result.status === 'copied' ? chalk.cyan('\u2713 copied') :
        result.status === 'skipped' ? chalk.dim('\u2014 skipped') :
        chalk.red('\u2717 failed');
      console.log(`  ${tag}  fix #${fix.id} \u2014 ${fix.title}`);
      if (result.backup) console.log(chalk.dim(`     backup: ${result.backup}`));
      if (result.message) console.log(chalk.dim(`     ${result.message}`));
    }
    console.log();
  });

program
  .command('compare <session-a> <session-b>')
  .description('Compare two sessions side by side')
  .action(async (sessionIdA: string, sessionIdB: string, _options: unknown, cmd: Command) => {
    const globals = cmd.optsWithGlobals();

    const sessionA = resolveSession(sessionIdA, globals.path, globals.project);
    if (!sessionA) {
      console.error(chalk.red(`No session found matching: ${sessionIdA}`));
      return;
    }
    const sessionB = resolveSession(sessionIdB, globals.path, globals.project);
    if (!sessionB) {
      console.error(chalk.red(`No session found matching: ${sessionIdB}`));
      return;
    }

    const [resultA, resultB] = await Promise.all([
      analyzeSession(sessionA.path, sessionA.id, sessionA.project),
      analyzeSession(sessionB.path, sessionB.id, sessionB.project),
    ]);

    if (!resultA) {
      console.error(chalk.red(`No messages found in session A (${sessionIdA}).`));
      return;
    }
    if (!resultB) {
      console.error(chalk.red(`No messages found in session B (${sessionIdB}).`));
      return;
    }

    const comparison = compareSessions(resultA, resultB);

    if (globals.json) {
      console.log(JSON.stringify(comparison, null, 2));
      return;
    }

    renderComparison(comparison);
  });

program
  .command('lost [session-id]')
  .description('Show what was lost during compaction')
  .action(async (sessionId: string | undefined, _options: unknown, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    const session = resolveSession(sessionId, globals.path, globals.project);
    if (!session) return;

    const result = await analyzeSession(session.path, session.id, session.project);
    if (!result) {
      console.error(chalk.red('No messages found in session.'));
      return;
    }

    if (result.breakdown.compactionEvents.length === 0) {
      console.log(chalk.green('\n  No compaction events in this session.'));
      console.log(chalk.dim('  Use `claude-crusts analyze` to see the full context breakdown.\n'));
      return;
    }

    // Parse raw messages for the lost detector
    const rawMessages = await parseSession(session.path);

    const lostAnalysis = analyzeLostContent(
      rawMessages,
      result.breakdown.messages,
      result.breakdown.compactionEvents,
      result.sessionId,
      result.project,
    );

    if (!lostAnalysis) {
      console.log(chalk.green('\n  No compaction events in this session.\n'));
      return;
    }

    if (globals.json) {
      console.log(JSON.stringify(lostAnalysis, null, 2));
      return;
    }

    renderLost(lostAnalysis);
  });

program
  .command('watch [session-id]')
  .description('Live-monitor a session as it runs')
  .option('--interval <ms>', 'Polling interval in milliseconds', '2000')
  .action(async (sessionId: string | undefined, options: { interval?: string }, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    const session = resolveSession(sessionId, globals.path, globals.project);
    if (!session) return;

    const intervalMs = parseInt(options.interval ?? '2000', 10);
    if (isNaN(intervalMs) || intervalMs < 200) {
      console.error(chalk.red('Interval must be at least 200ms.'));
      return;
    }

    await startWatch(session, intervalMs, !!globals.json);
  });

program
  .command('report [session-id]')
  .description('Generate a standalone report (HTML or Markdown)')
  .option('--compare <id>', 'Compare with a second session')
  .option('--output <path>', 'Custom output file path')
  .option('--format <fmt>', 'Output format: html or md (default: html)', 'html')
  .action(async (sessionId: string | undefined, options: { compare?: string; output?: string; format?: string }, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    const format = (options.format ?? 'html').toLowerCase();

    if (format !== 'html' && format !== 'md') {
      console.error(chalk.red(`Unknown format: ${format}. Use "html" or "md".`));
      return;
    }

    const session = resolveSession(sessionId, globals.path, globals.project);
    if (!session) return;

    const result = await analyzeSession(session.path, session.id, session.project);
    if (!result) {
      console.error(chalk.red('No messages found in session.'));
      return;
    }

    let content: string;
    let defaultName: string;

    if (options.compare) {
      // Comparison report
      const sessionB = resolveSession(options.compare, globals.path, globals.project);
      if (!sessionB) {
        console.error(chalk.red(`No session found matching: ${options.compare}`));
        return;
      }
      const resultB = await analyzeSession(sessionB.path, sessionB.id, sessionB.project);
      if (!resultB) {
        console.error(chalk.red(`No messages found in session B (${options.compare}).`));
        return;
      }
      const comparison = compareSessions(result, resultB);

      if (globals.json) {
        console.log(JSON.stringify(comparison, null, 2));
        return;
      }

      content = format === 'md'
        ? generateComparisonReportMd(comparison)
        : generateComparisonReport(comparison);
      defaultName = `crusts-compare-${session.id.slice(0, 8)}-${sessionB.id.slice(0, 8)}.${format}`;
    } else {
      // Single session report
      if (globals.json) {
        const { messages: _msgs, ...jsonResult } = result;
        console.log(JSON.stringify(jsonResult, null, 2));
        return;
      }

      const fix = generateFixPrompts(result.breakdown, result.waste, result.configData);
      content = format === 'md'
        ? generateSessionReportMd(result, fix)
        : generateSessionReport(result, fix);
      defaultName = `crusts-report-${session.id.slice(0, 8)}.${format}`;
    }

    const outPath = resolve(options.output ?? defaultName);
    writeFileSync(outPath, content, 'utf-8');
    console.log(chalk.green(`\n  Report saved to: ${outPath}\n`));
  });

program
  .command('calibrate')
  .description('Paste /context output for ground truth calibration')
  .action(async () => {
    await runCalibration();
  });

program
  .command('trend')
  .description('Show trends across your recent sessions')
  .option('--limit <n>', 'Number of sessions to include (default 50)')
  .option('--format <fmt>', 'Output format: terminal (default) | csv')
  .option('--output <path>', 'Write output to file instead of stdout (csv mode)')
  .action((_options: { limit?: string; format?: string; output?: string }, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    const limit = _options.limit ? parseInt(_options.limit, 10) : 50;
    const records = loadTrendHistory(limit, globals.project as string | undefined);

    if (_options.format === 'csv') {
      const csv = formatTrendAsCsv(records);
      if (_options.output) {
        writeFileSync(resolve(_options.output), csv, 'utf-8');
        console.log(chalk.green(`  Wrote ${records.length} record(s) to ${resolve(_options.output)}`));
      } else {
        process.stdout.write(csv);
      }
      return;
    }

    if (globals.json) {
      const summary = summarizeTrend(records);
      console.log(JSON.stringify({ records, summary }, null, 2));
      return;
    }

    const summary = summarizeTrend(records);
    renderTrend(records, summary);
  });

program
  .command('tui [session-id]')
  .description('Interactive REPL shell — browse sessions, run commands, compare')
  .action(async (sessionId: string | undefined, _options: unknown, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    await startTui(globals.path, sessionId);
  });

program
  .command('status [session-id]')
  .description('One-line context health summary (used by hooks)')
  .action(async (sessionId: string | undefined, _options: unknown, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    const session = resolveSession(sessionId, globals.path, globals.project);
    if (!session) return;

    const messages = await parseSession(session.path);
    if (messages.length === 0) return;

    const configData = gatherConfigData();
    const breakdown = classifySession(messages, configData);

    const view = breakdown.currentContext ?? {
      usage_percentage: breakdown.usage_percentage,
    };
    const pct = view.usage_percentage;
    const msgCount = breakdown.messages.length;
    const compCount = breakdown.compactionEvents.length;

    const healthLabel = pct < 50 ? 'healthy' : pct < 70 ? 'warming' : pct < 85 ? 'hot' : 'critical';
    const color = pct < 50 ? chalk.green : pct < 70 ? chalk.yellow : pct < 85 ? chalk.red : chalk.bgRed.white;

    console.log(color(`CRUSTS: ${pct.toFixed(1)}% (${healthLabel}) | ${msgCount} msgs | ${compCount} compaction${compCount === 1 ? '' : 's'}`));
  });

const hooksCmd = program
  .command('hooks')
  .description('Manage Claude Code hook integration');

hooksCmd
  .command('enable')
  .description('Enable CRUSTS after-response hook in Claude Code')
  .action(() => enableHooks());

hooksCmd
  .command('disable')
  .description('Disable CRUSTS after-response hook')
  .action(() => disableHooks());

hooksCmd
  .command('status')
  .description('Show whether CRUSTS hooks are installed')
  .action(() => hooksStatus());

const autoInjectCmd = hooksCmd
  .command('auto-inject')
  .description('Manage hook-triggered fix injection (UserPromptSubmit event)');

autoInjectCmd
  .command('enable')
  .description('Install the UserPromptSubmit hook that auto-injects a /compact focus recommendation when context gets hot')
  .action(() => enableAutoInject());

autoInjectCmd
  .command('disable')
  .description('Remove the auto-inject hook from Claude Code settings')
  .action(() => disableAutoInject());

autoInjectCmd
  .command('status')
  .description('Show whether auto-inject is installed and enabled')
  .action(() => autoInjectStatus());

program
  .command('auto-inject', { hidden: true })
  .description('Internal: hook target for UserPromptSubmit (reads JSON on stdin, emits additionalContext when threshold crossed)')
  .action(async () => {
    await runAutoInject();
  });

const statuslineCmd = program
  .command('statusline')
  .description('Render the Claude Code statusline glyph (reads JSON on stdin)')
  .action(async (_options: unknown, cmd: Command) => {
    try {
      const globals = cmd.optsWithGlobals();
      const payload = await readStatuslinePayload();

      let sessionPath: string;
      if (payload?.transcript_path && existsSync(payload.transcript_path)) {
        sessionPath = payload.transcript_path;
      } else {
        const session = resolveSession(payload?.session_id, globals.path, globals.project);
        if (!session) return;
        sessionPath = session.path;
      }

      const messages = await parseSession(sessionPath);
      if (messages.length === 0) return;

      const configData = gatherConfigData();
      const breakdown = classifySession(messages, configData, undefined, payload?.model?.id);
      process.stdout.write(renderStatusline(breakdown));
    } catch {
      // Statusline must never break Claude Code — swallow all errors.
    }
  });

statuslineCmd
  .command('install')
  .description('Install the CRUSTS statusline into Claude Code settings')
  .action(() => installStatusline());

statuslineCmd
  .command('uninstall')
  .description('Remove the CRUSTS statusline from Claude Code settings')
  .action(() => uninstallStatusline());

statuslineCmd
  .command('status')
  .description('Show whether the CRUSTS statusline is installed')
  .action(() => statuslineStatus());

program
  .command('diff [session-id]')
  .description('Diff two points within the same session — per-category delta between --from and --to')
  .requiredOption('--from <n>', 'Earlier message cutpoint (1-based, exclusive)')
  .requiredOption('--to <n>', 'Later message cutpoint (1-based, exclusive)')
  .action(async (sessionId: string | undefined, options: { from: string; to: string }, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    const session = resolveSession(sessionId, globals.path, globals.project);
    if (!session) return;

    const messages = await parseSession(session.path);
    if (messages.length === 0) {
      console.error(chalk.red('No messages found in session.'));
      return;
    }

    const from = parseInt(options.from, 10);
    const to = parseInt(options.to, 10);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      console.error(chalk.red('--from and --to must be integers.'));
      return;
    }

    const configData = gatherConfigData();
    try {
      const diff = computeSessionDiff(messages, configData, session.id, from, to);
      if (globals.json) {
        console.log(JSON.stringify(diff, null, 2));
        return;
      }
      renderSessionDiff(diff);
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program
  .command('models [session-id]')
  .description('Per-session model usage snapshot — one row per contiguous run of a single model')
  .action(async (sessionId: string | undefined, _options: unknown, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    const session = resolveSession(sessionId, globals.path, globals.project);
    if (!session) return;

    const result = await analyzeSession(session.path, session.id, session.project);
    if (!result) {
      console.error(chalk.red('No messages found in session.'));
      return;
    }

    const history = result.breakdown.modelHistory;
    if (!history) {
      console.error(chalk.yellow('This session has no recorded model history (pre-v0.7.0 data).'));
      return;
    }

    if (globals.json) {
      console.log(JSON.stringify(history, null, 2));
      return;
    }

    renderModelHistory(history, result.sessionId);
  });

program
  .command('doctor')
  .description('Sanity-check your claude-crusts install (Claude Code, hooks, statusline, backups)')
  .action((_options: unknown, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    const report = runDoctor();
    if (globals.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    renderDoctor(report);
    if (report.overall === 'fail') process.exit(1);
  });

const benchGroup = program
  .command('bench')
  .description('Benchmarking harnesses (non-destructive measurement helpers)');

benchGroup
  .command('compact [session-id]')
  .description('Tail the session JSONL, wait for a /compact event, and print the before/after delta')
  .option('--focus <string>', 'Also copy `/compact focus "<string>"` to the clipboard before waiting')
  .option('--timeout <seconds>', 'Seconds to wait for a compact_boundary record (default 900)', '900')
  .option('--output <path>', 'Write the before/after/delta envelope as JSON to this path')
  .action(async (
    sessionId: string | undefined,
    options: { focus?: string; timeout?: string; output?: string },
    cmd: Command,
  ) => {
    const globals = cmd.optsWithGlobals();
    const session = resolveSession(sessionId, globals.path, globals.project);
    if (!session) return;

    const timeoutSec = options.timeout ? parseInt(options.timeout, 10) : undefined;
    const result = await runBenchCompact(session, {
      focus: options.focus,
      timeoutSec: Number.isFinite(timeoutSec as number) ? timeoutSec : undefined,
      outputPath: options.output,
      json: Boolean(globals.json),
    });

    if (globals.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      renderBenchResult(result);
    }

    if (result.status === 'timeout') process.exit(2);
    if (result.status === 'error') process.exit(1);
  });

benchGroup
  .command('reextract <result-json>')
  .description('Re-run the file-ref extractor against an existing bench result (useful after tightening the regex)')
  .option('--session <path>', 'Override the session JSONL path (defaults to sessionPath recorded in the result)')
  .action(async (resultPath: string, options: { session?: string }, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    try {
      const { result, priorRefCount, newRefCount } = await reextractSummaryRefs(resultPath, options.session);
      if (globals.json) {
        console.log(JSON.stringify({ resultPath, priorRefCount, newRefCount, summaryFileRefs: result.summaryFileRefs }, null, 2));
        return;
      }
      console.log();
      console.log(chalk.bold('  bench reextract'));
      console.log(chalk.dim('  ' + '═'.repeat(60)));
      console.log(`  Result file : ${resultPath}`);
      console.log(`  Refs before : ${priorRefCount}`);
      console.log(`  Refs after  : ${chalk.green(newRefCount.toString())}`);
      console.log(chalk.dim('  ' + '═'.repeat(60)));
      const refs = result.summaryFileRefs ?? [];
      for (const ref of refs.slice(0, 40)) {
        console.log(chalk.dim(`    · ${ref}`));
      }
      if (refs.length > 40) console.log(chalk.dim(`    · … (${refs.length - 40} more)`));
      console.log();
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

benchGroup
  .command('compare <a-json> <b-json>')
  .description('Diff two bench-compact result files (produced with `bench compact --output`)')
  .option('--label-a <name>', 'Display label for run A (default: session id prefix)')
  .option('--label-b <name>', 'Display label for run B (default: session id prefix)')
  .action((aPath: string, bPath: string, options: { labelA?: string; labelB?: string }, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    try {
      const a = loadBenchResult(aPath);
      const b = loadBenchResult(bPath);
      const comparison = compareBenchResults(a, b, { a: options.labelA, b: options.labelB });
      if (globals.json) {
        console.log(JSON.stringify(comparison, null, 2));
      } else {
        renderBenchComparison(comparison);
      }
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

program
  .command('completion <shell>')
  .description('Emit a shell completion script (bash | zsh | pwsh). Use `ids` to print session IDs for scripts.')
  .action((shell: string, _options: unknown, cmd: Command) => {
    // `ids` is a hidden convention used by the generated scripts themselves —
    // one session id per line, no formatting, no colours. Keeps the scripts
    // from needing to parse JSON or ship jq as a dependency.
    if (shell === 'ids') {
      const globals = cmd.optsWithGlobals();
      const sessions = discoverSessions(globals.path);
      for (const s of sessions) process.stdout.write(`${s.id}\n`);
      return;
    }
    const normalised = shell === 'powershell' ? 'pwsh' : shell;
    if (normalised !== 'bash' && normalised !== 'zsh' && normalised !== 'pwsh') {
      console.error(chalk.red(`Unknown shell: "${shell}". Use one of: bash, zsh, pwsh.`));
      process.exit(1);
    }
    process.stdout.write(generateCompletionScript(normalised as CompletionShell));
  });

program.parse();

/**
 * Resolve a session by ID prefix or find the latest one.
 * Optionally filter by project name.
 */
function resolveSession(
  sessionId: string | undefined,
  basePath: string | undefined,
  projectFilter: string | undefined,
): SessionInfo | null {
  let sessions = discoverSessions(basePath);
  if (sessions.length === 0) return null;

  if (projectFilter) {
    sessions = sessions.filter((s) =>
      s.project.toLowerCase().includes(projectFilter.toLowerCase()),
    );
    if (sessions.length === 0) {
      console.error(chalk.yellow(`No sessions found for project filter: ${projectFilter}`));
      return null;
    }
  }

  if (!sessionId) return sessions[0] ?? null;

  const match = sessions.find((s) => s.id.startsWith(sessionId));
  if (!match) {
    console.error(chalk.red(`No session found matching: ${sessionId}`));
    return null;
  }
  return match;
}
