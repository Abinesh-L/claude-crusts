/**
 * Interactive TUI — REPL-style session explorer.
 *
 * Launch with `claude-crusts tui` to enter an interactive shell.
 * Browse sessions, run any analysis command, switch between sessions —
 * all without leaving the app.
 *
 * Commands inside the TUI:
 *   list / ls           — show all sessions
 *   select <id>         — load a session by ID prefix
 *   analyze             — full CRUSTS breakdown of current session
 *   waste               — waste detection report
 *   fix                 — pasteable fix prompts
 *   timeline            — message-by-message context growth
 *   lost                — what was lost in compaction
 *   trend               — cross-session trends
 *   compare <id>        — compare current session with another
 *   status              — one-line health check
 *   help / ?            — show available commands
 *   quit / exit / q     — exit the TUI
 */

import { createInterface } from 'readline';
import chalk from 'chalk';
import { discoverSessions, parseSession } from './scanner.ts';
import { analyzeSession, gatherConfigData } from './analyzer.ts';
import { classifySession } from './classifier.ts';
import { analyzeLostContent } from './lost-detector.ts';
import { compareSessions } from './comparator.ts';
import { loadTrendHistory, summarizeTrend } from './trend.ts';
import { generateFixPrompts } from './recommender.ts';
import {
  renderAnalysis,
  renderTimeline,
  renderList,
  renderWaste,
  renderFix,
  renderComparison,
  renderLost,
  renderTrend,
} from './renderer.ts';
import type { SessionInfo, AnalysisResult, FixPrompts } from './types.ts';
import { copyToClipboard } from './clipboard.ts';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Current TUI state */
interface TuiState {
  sessions: SessionInfo[];
  current: SessionInfo | null;
  result: AnalysisResult | null;
  lastFix: FixPrompts | null;
  basePath: string | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Print the welcome banner and help text.
 */
function printBanner(): void {
  console.log();
  console.log(chalk.bold('  CRUSTS Interactive Shell'));
  console.log(chalk.dim('  Type a command, or "help" for a list of commands.'));
  console.log();
}

/**
 * Print available commands.
 */
function printHelp(): void {
  console.log();
  console.log(chalk.bold('  Session'));
  console.log(chalk.dim('    list, ls') + '           Show all discovered sessions');
  console.log(chalk.dim('    select <id>') + '        Load a session by ID prefix');
  console.log();
  console.log(chalk.bold('  Analysis') + chalk.dim(' (requires a selected session)'));
  console.log(chalk.dim('    analyze') + '            Full 6-category CRUSTS breakdown');
  console.log(chalk.dim('    waste') + '              Waste detection report');
  console.log(chalk.dim('    fix') + '                Pasteable fix prompts');
  console.log(chalk.dim('    copy <1|2|3>') + '       Copy a fix block to clipboard');
  console.log(chalk.dim('    timeline') + '           Message-by-message context growth');
  console.log(chalk.dim('    lost') + '               What was lost in compaction');
  console.log(chalk.dim('    status') + '             One-line health summary');
  console.log(chalk.dim('    compare <id>') + '       Compare with another session');
  console.log();
  console.log(chalk.bold('  Global'));
  console.log(chalk.dim('    trend') + '              Cross-session trends');
  console.log(chalk.dim('    help, ?') + '            Show this help');
  console.log(chalk.dim('    quit, exit, q') + '      Exit');
  console.log();
}

/**
 * Resolve a session from the discovered list by ID prefix.
 *
 * @param sessions - Available sessions
 * @param prefix - ID prefix to match
 * @returns Matched session or null
 */
function findSession(sessions: SessionInfo[], prefix: string): SessionInfo | null {
  const match = sessions.find((s) => s.id.startsWith(prefix));
  if (!match) {
    console.log(chalk.red(`  No session found matching: ${prefix}`));
    return null;
  }
  return match;
}

/**
 * Load (or reload) analysis data for the current session.
 *
 * @param state - TUI state (mutated: sets result)
 * @returns True if analysis succeeded
 */
async function ensureAnalysis(state: TuiState): Promise<boolean> {
  if (!state.current) {
    console.log(chalk.yellow('  No session selected. Use "select <id>" or "list" first.'));
    return false;
  }
  if (state.result && state.result.sessionId === state.current.id) {
    return true; // Already loaded
  }
  process.stdout.write(chalk.dim('  Analyzing session...\r'));
  const result = await analyzeSession(
    state.current.path,
    state.current.id,
    state.current.project,
  );
  if (!result) {
    console.log(chalk.red('  No messages found in session.'));
    state.result = null;
    return false;
  }
  state.result = result;
  return true;
}

/**
 * Print the current session indicator in the prompt.
 *
 * @param state - TUI state
 * @returns Prompt string
 */
function getPrompt(state: TuiState): string {
  if (state.current) {
    const id = state.current.id.slice(0, 8);
    return chalk.cyan(`crusts:${id}`) + chalk.dim('> ');
  }
  return chalk.cyan('crusts') + chalk.dim('> ');
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

/**
 * Execute a single TUI command.
 *
 * @param input - Raw user input
 * @param state - TUI state (mutated in place)
 * @returns False if the TUI should exit, true to continue
 */
async function executeCommand(input: string, state: TuiState): Promise<boolean> {
  const trimmed = input.trim();
  if (!trimmed) return true;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0]!.toLowerCase();
  const arg = parts[1];

  switch (cmd) {
    case 'quit':
    case 'exit':
    case 'q':
      return false;

    case 'help':
    case '?':
      printHelp();
      return true;

    case 'list':
    case 'ls': {
      state.sessions = discoverSessions(state.basePath);
      if (state.sessions.length === 0) {
        console.log(chalk.yellow('  No sessions found.'));
      } else {
        renderList(state.sessions);
      }
      return true;
    }

    case 'select': {
      if (!arg) {
        console.log(chalk.yellow('  Usage: select <session-id-prefix>'));
        return true;
      }
      // Refresh session list
      state.sessions = discoverSessions(state.basePath);
      const session = findSession(state.sessions, arg);
      if (session) {
        state.current = session;
        state.result = null; // Force re-analysis
        state.lastFix = null;
        console.log(chalk.green(`  Selected session: ${session.id.slice(0, 8)} (${session.project})`));
      }
      return true;
    }

    case 'analyze': {
      if (!(await ensureAnalysis(state))) return true;
      const r = state.result!;
      renderAnalysis(
        r.breakdown, r.waste, r.recommendations,
        r.sessionId, r.project, r.messageCount,
      );
      return true;
    }

    case 'waste': {
      if (!(await ensureAnalysis(state))) return true;
      const r = state.result!;
      renderWaste(r.waste, r.recommendations, r.breakdown.total_tokens);
      return true;
    }

    case 'fix': {
      if (!(await ensureAnalysis(state))) return true;
      const r = state.result!;
      const fix = generateFixPrompts(r.breakdown, r.waste, r.configData, r.messages);
      state.lastFix = fix;
      renderFix(fix, r.sessionId);
      if (fix.sessionPrompt || fix.claudeMdSnippet || fix.compactCommand) {
        console.log(chalk.dim('  Tip: use "copy 1", "copy 2", or "copy 3" to copy a block to clipboard.'));
        console.log();
      }
      return true;
    }

    case 'copy': {
      if (!state.lastFix) {
        console.log(chalk.yellow('  Run "fix" first to generate copyable blocks.'));
        return true;
      }
      const blockNum = arg ? parseInt(arg, 10) : 0;
      const blocks: { label: string; content: string | null }[] = [
        { label: 'session prompt', content: state.lastFix.sessionPrompt },
        { label: 'CLAUDE.md snippet', content: state.lastFix.claudeMdSnippet },
        { label: '/compact command', content: state.lastFix.compactCommand },
      ];
      const available = blocks.filter((b) => b.content !== null);
      if (available.length === 0) {
        console.log(chalk.green('  No fix blocks to copy.'));
        return true;
      }
      if (!arg || blockNum < 1 || blockNum > 3) {
        console.log(chalk.yellow('  Usage: copy <1|2|3>'));
        for (let i = 0; i < blocks.length; i++) {
          if (blocks[i]!.content) {
            console.log(chalk.dim(`    ${i + 1} — ${blocks[i]!.label}`));
          }
        }
        return true;
      }
      const target = blocks[blockNum - 1];
      if (!target || !target.content) {
        console.log(chalk.yellow(`  Block ${blockNum} is empty.`));
        return true;
      }
      const ok = await copyToClipboard(target.content);
      if (ok) {
        console.log(chalk.green(`  Copied ${target.label} to clipboard.`));
      } else {
        console.log(chalk.red('  Failed to copy — clipboard command not available.'));
        console.log(chalk.dim('  Select and copy the text manually from the fix output above.'));
      }
      return true;
    }

    case 'timeline': {
      if (!(await ensureAnalysis(state))) return true;
      const r = state.result!;
      renderTimeline(
        r.breakdown.messages,
        r.breakdown.context_limit,
        r.breakdown.compactionEvents,
      );
      return true;
    }

    case 'lost': {
      if (!(await ensureAnalysis(state))) return true;
      const r = state.result!;
      if (r.breakdown.compactionEvents.length === 0) {
        console.log(chalk.green('  No compaction events in this session.'));
        return true;
      }
      const messages = await parseSession(state.current!.path);
      const configData = gatherConfigData();
      const breakdown = classifySession(messages, configData);
      const lostAnalysis = analyzeLostContent(
        messages,
        breakdown.messages,
        r.breakdown.compactionEvents,
        state.current!.id,
        state.current!.project,
      );
      if (lostAnalysis) {
        renderLost(lostAnalysis);
      } else {
        console.log(chalk.green('  No compaction events in this session.'));
      }
      return true;
    }

    case 'status': {
      if (!(await ensureAnalysis(state))) return true;
      const r = state.result!;
      const view = r.breakdown.currentContext ?? {
        usage_percentage: r.breakdown.usage_percentage,
      };
      const pct = view.usage_percentage;
      const msgCount = r.messageCount;
      const compCount = r.breakdown.compactionEvents.length;
      const healthLabel = pct < 50 ? 'healthy' : pct < 70 ? 'warming' : pct < 85 ? 'hot' : 'critical';
      const color = pct < 50 ? chalk.green : pct < 70 ? chalk.yellow : pct < 85 ? chalk.red : chalk.bgRed.white;
      console.log(color(`  CRUSTS: ${pct.toFixed(1)}% (${healthLabel}) | ${msgCount} msgs | ${compCount} compaction${compCount === 1 ? '' : 's'}`));
      return true;
    }

    case 'compare': {
      if (!arg) {
        console.log(chalk.yellow('  Usage: compare <session-id-prefix>'));
        return true;
      }
      if (!state.current) {
        console.log(chalk.yellow('  No session selected. Use "select <id>" first.'));
        return true;
      }
      state.sessions = discoverSessions(state.basePath);
      const other = findSession(state.sessions, arg);
      if (!other) return true;
      process.stdout.write(chalk.dim('  Comparing sessions...\r'));
      if (!(await ensureAnalysis(state))) return true;
      const otherResult = await analyzeSession(other.path, other.id, other.project);
      if (!otherResult) {
        console.log(chalk.red('  Comparison failed — the other session has no messages.'));
        return true;
      }
      const comparison = compareSessions(state.result!, otherResult);
      renderComparison(comparison);
      return true;
    }

    case 'trend': {
      const records = loadTrendHistory(50);
      const summary = summarizeTrend(records);
      renderTrend(records, summary);
      return true;
    }

    default:
      console.log(chalk.yellow(`  Unknown command: ${cmd}. Type "help" for available commands.`));
      return true;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Launch the interactive TUI REPL.
 *
 * Presents a session picker and command prompt. The user can browse
 * sessions, run analysis commands, switch sessions, and compare —
 * all within a single interactive shell.
 *
 * @param basePath - Optional custom path to JSONL session files
 * @param initialSessionId - Optional session ID to pre-select
 */
export async function startTui(basePath?: string, initialSessionId?: string): Promise<void> {
  // Guard: must be a TTY
  if (!process.stdin.isTTY) {
    console.error(chalk.red('TUI requires an interactive terminal (TTY).'));
    process.exit(1);
  }

  const state: TuiState = {
    sessions: discoverSessions(basePath),
    current: null,
    result: null,
    lastFix: null,
    basePath,
  };

  printBanner();

  // Auto-select session if provided or show list
  if (initialSessionId) {
    const match = findSession(state.sessions, initialSessionId);
    if (match) {
      state.current = match;
      console.log(chalk.green(`  Selected session: ${match.id.slice(0, 8)} (${match.project})`));
      console.log();
    }
  } else if (state.sessions.length > 0) {
    // Show sessions and auto-select the most recent
    renderList(state.sessions);
    state.current = state.sessions[0]!;
    console.log(chalk.green(`  Auto-selected most recent session: ${state.current.id.slice(0, 8)} (${state.current.project})`));
    console.log(chalk.dim('  Use "select <id>" to switch, or type a command.'));
    console.log();
  } else {
    console.log(chalk.yellow('  No sessions found. Make sure Claude Code has been used in a project.'));
    console.log();
  }

  /** Commands that take a session ID argument */
  const SESSION_ARG_CMDS = new Set(['select', 'compare']);

  /** All available TUI commands */
  const ALL_CMDS = [
    'analyze', 'waste', 'fix', 'copy', 'timeline', 'lost', 'status',
    'compare', 'trend', 'list', 'ls', 'select', 'help', 'quit', 'exit', 'q',
  ];

  /**
   * Tab-completion handler.
   *
   * - Bare input: completes command names
   * - After `select` or `compare`: completes session ID prefixes
   */
  const completer = (line: string): [string[], string] => {
    const trimmed = line.trimStart();
    const parts = trimmed.split(/\s+/);

    if (parts.length <= 1) {
      // Complete command name
      const prefix = parts[0] ?? '';
      const hits = ALL_CMDS.filter((c) => c.startsWith(prefix.toLowerCase()));
      return [hits.length > 0 ? hits : ALL_CMDS, prefix];
    }

    // Complete session ID after select/compare
    const cmd = parts[0]!.toLowerCase();
    if (SESSION_ARG_CMDS.has(cmd)) {
      const idPrefix = parts[1] ?? '';
      const ids = state.sessions.map((s) => s.id.slice(0, 8));
      const hits = ids.filter((id) => id.startsWith(idPrefix));
      return [hits, idPrefix];
    }

    return [[], ''];
  };

  // REPL loop
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: getPrompt(state),
    terminal: true,
    completer,
  });

  rl.prompt();

  rl.on('line', async (line: string) => {
    const shouldContinue = await executeCommand(line, state);
    if (!shouldContinue) {
      console.log(chalk.dim('  Goodbye.'));
      rl.close();
      process.exit(0);
    }
    // Update prompt (session may have changed)
    rl.setPrompt(getPrompt(state));
    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}
