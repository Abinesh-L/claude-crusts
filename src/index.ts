#!/usr/bin/env node
/**
 * CRUSTS CLI entrypoint.
 *
 * Context window analyzer for Claude Code — breaks down token usage
 * into the 6 CRUSTS categories: Conversation, Retrieved, User,
 * System, Tools, State & Memory.
 */

import { writeFileSync } from 'fs';
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
import { enableHooks, disableHooks, hooksStatus } from './hooks.ts';
import { renderAnalysis, renderTimeline, renderList, renderWaste, renderFix, renderComparison, renderLost, renderTrend } from './renderer.ts';
import { generateFixPrompts } from './recommender.ts';
import { loadTrendHistory, summarizeTrend } from './trend.ts';
import type { SessionInfo } from './types.ts';

const program = new Command();

program
  .name('claude-crusts')
  .description('Break down your Claude Code context window into the 6 CRUSTS categories')
  .version('0.5.0')
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

    const fix = generateFixPrompts(result.breakdown, result.waste, result.configData, result.messages);

    if (globals.json) {
      console.log(JSON.stringify(fix, null, 2));
      return;
    }

    renderFix(fix, result.sessionId);
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

      const fix = generateFixPrompts(result.breakdown, result.waste, result.configData, result.messages);
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
  .action((_options: { limit?: string }, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    const limit = _options.limit ? parseInt(_options.limit, 10) : 50;
    const records = loadTrendHistory(limit, globals.project as string | undefined);

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
