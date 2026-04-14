# CLAUDE.md — claude-crusts: Context Window Analyzer for Claude Code

## Identity

You are working on **claude-crusts** (the npm package name and CLI binary). The framework is called **CRUSTS** (always uppercase). It analyzes Claude Code's context window by classifying every token into 6 categories: Conversation, Retrieved, User, System, Tools, State. It tells users WHY their context is filling up and WHAT to do about it. Fully offline, zero API calls.

## CLI Commands

Binary name: `claude-crusts`. Entrypoint: `src/index.ts`.

**Slash command**: `/crusts` inside Claude Code (via `.claude/commands/crusts.md`) — runs analyze and gives actionable advice.

```
claude-crusts analyze [session-id]              — 6-category breakdown + waste detection + recommendations
claude-crusts waste [session-id]                — Detailed waste report with per-file analysis + top 5 consumers
claude-crusts fix [session-id]                  — 3 pasteable prompt blocks (session, CLAUDE.md, /compact)
claude-crusts timeline [session-id]             — Message-by-message context growth with compaction markers
claude-crusts list                              — All discovered sessions (age, size, project)
claude-crusts compare <session-a> <session-b>   — Side-by-side comparison with per-category deltas + insights
claude-crusts lost [session-id]                 — What was lost during compaction (files, conversations, tools, instructions)
claude-crusts watch [session-id]                — Live-monitor a session with compact dashboard
claude-crusts report [session-id]               — Generate standalone report (HTML or Markdown)
claude-crusts calibrate                         — Cross-reference against /context output
claude-crusts trend                              — Cross-session trends (sparkline, averages, direction)
claude-crusts tui [session-id]                   — Interactive REPL shell with tab completion + clipboard copy
claude-crusts status [session-id]                — One-line context health (fast path, used by hooks)
claude-crusts hooks enable|disable|status        — Manage Claude Code hook integration
```

Global flags: `--json`, `--project <name>`, `--path <path>`, `--verbose`
Subcommand flags: `--until <n>` on analyze/waste/timeline
Report flags: `--format <html|md>` (default: html), `--compare <id>` for comparison report, `--output <path>` for custom file path
Watch flags: `--interval <ms>` polling interval (default: 2000)
Trend flags: `--limit <n>` number of sessions (default: 50)

## Rules

- TypeScript strict mode, Bun runtime
- Commander.js for CLI, chalk for colors, cli-table3 for tables
- NO React/Ink — lightweight terminal output only
- Stream-parse JSONL files (they can be multi-MB)
- Every function must have JSDoc comments
- MIT license

## Format

- 2-space indentation, single quotes, semicolons
- kebab-case file naming
- Named exports only (no default exports)
- Explicit `.ts` import extensions (Bun bundler resolution)
- `import type` for type-only imports (`verbatimModuleSyntax: true`)
- Array indexing requires `!` postfix (`noUncheckedIndexedAccess: true`)

## Architecture

```
scanner.ts → classifier.ts → waste-detector.ts → recommender.ts → renderer.ts
                  ↑                                                     ↑
              analyzer.ts (orchestrates)                         calibrator.ts
                  ↓                                             comparator.ts
              trend.ts (history)                                lost-detector.ts
                                                                watcher.ts
                                                                tui.ts
                                                                clipboard.ts
                                                                hooks.ts
                                                                html-report.ts
                                                                md-report.ts
```

Supporting: `types.ts`, `built-in-tools.ts`

### File Responsibilities

- **types.ts**: All shared types and interfaces (including ComparisonResult, CategoryDelta, TrendRecord, TrendSummary, SkillInfo)
- **index.ts**: CLI entrypoint with 14 Commander.js commands (including hooks subcommands)
- **analyzer.ts**: Pipeline orchestrator, project path decoding, trend recording
- **scanner.ts**: Session discovery, JSONL streaming, config readers (MCP, memory, skills)
- **classifier.ts**: Core engine — classification, token estimation, compaction detection, derived overhead, auto-trim
- **waste-detector.ts**: 6 waste detection rules (edit-aware)
- **recommender.ts**: 7 recommendation patterns + fix prompt generator
- **renderer.ts**: 8 render functions (dashboard, timeline, list, waste, fix, comparison, lost, trend). Bar chart guarantees ≥1 filled block for categories ≥1%
- **calibrator.ts**: /context parser, calibration storage, comparison. Exports `CRUSTS_DIR` (~/.claude-crusts)
- **trend.ts**: Cross-session trend tracking — append-only JSONL history, deduped by session id, sparkline + direction detection
- **comparator.ts**: Cross-session comparison engine with 5 auto-insight rules
- **html-report.ts**: Standalone HTML report generator (session + comparison modes)
- **md-report.ts**: Standalone Markdown report generator (session + comparison modes)
- **lost-detector.ts**: Compaction loss analysis — reconstructs what was dropped. Detects tool_use ID filenames and replaces with "Agent sub-task result". Extracts meaningful descriptions from agent/tool results
- **watcher.ts**: Live session monitor with compact dashboard, inline compaction line (flash effect on new compaction, settles to yellow), category labels `C R U Sys T St`
- **built-in-tools.ts**: 40 built-in tool schemas, total 9,055 tokens
- **tui.ts**: Interactive REPL shell — session picker, command dispatch (analyze/waste/fix/copy/timeline/lost/status/compare/trend), readline-based prompt with session ID indicator, tab completion for commands + session IDs, clipboard copy for fix blocks
- **clipboard.ts**: Cross-platform clipboard utility — `clip` (Windows), `pbcopy` (macOS), `xclip`/`xsel` (Linux)
- **hooks.ts**: Claude Code hook integration — reads/writes `~/.claude/settings.json` hooks, manages `~/.claude-crusts/config.json` toggle state
- **.claude/commands/crusts.md**: Custom slash command — runs `npx claude-crusts analyze --json` and gives actionable advice

## Key Technical Decisions

**Compaction detection** — marker-based, not heuristic:
- Primary: `subtype === 'compact_boundary'` with `compactMetadata.preTokens`
- Also detects: `isCompactSummary: true` (classified as System), `model: '<synthetic>'` (filtered at parse time)
- Fallback: 30K token drop between consecutive assistants (only if no markers)

**Token estimation** — content-aware:
- Assistant messages: `output_tokens` from API (exact)
- Code content: chars / 3.3 (detected via `CODE_PATTERN` regex)
- English text: chars / 4.0
- Includes: `block.signature`, tool block metadata (IDs, names), recursive sub-blocks

**Derived overhead** — per-session, not hardcoded:
- Internal system prompt: first assistant `input_tokens` − known components (CLAUDE.md + tools 9,055 + memory + discovered skills [fallback 476] + first user message). Range 1K-15K.
- Message framing: median of ≤20 consecutive assistant pair deltas from post-compaction window. Range 0-50 tokens/msg. Distributed proportionally across categories.

**Edit-aware waste detection**:
- Checks for Write/Edit/FileWriteTool/FileEditTool/NotebookEdit between consecutive Read operations
- Re-reads after edits = valid. Only reads with no intervening edit = waste.

**Auto-trim** — 3-phase backward walk:
1. Strip trailing CRUSTS Bash calls and tool_results
2. Strip preceding assistant text/thinking (same turn)
3. Strip the triggering user prompt

**MCP tools** — `MCP_TOKENS_PER_TOOL = 0`. Loaded on-demand by Claude Code, no upfront schema cost.

## All Constants

| Constant | File | Value | Purpose |
|----------|------|-------|---------|
| `CONTEXT_LIMIT` | classifier.ts | 200,000 | Claude context window size |
| `CHARS_PER_TOKEN_TEXT` | classifier.ts | 4.0 | Token divisor for English |
| `CHARS_PER_TOKEN_CODE` | classifier.ts | 3.3 | Token divisor for code |
| `COMPACTION_DROP_THRESHOLD` | classifier.ts | 30,000 | Heuristic fallback threshold |
| `STALE_READ_THRESHOLD` | waste-detector.ts | 15 | Messages before read is "stale" |
| `OVERSIZED_SYSTEM_THRESHOLD` | waste-detector.ts | 1,500 | System prompt token warning |
| `CACHE_OVERHEAD_THRESHOLD` | waste-detector.ts | 0.6 | Cache read ratio warning (60%) |
| `RESOLUTION_LOOKBACK` | waste-detector.ts | 10 | Messages to scan for resolved exchanges |
| `COMPACTION_THRESHOLD` | recommender.ts | 0.80 | Auto-compaction trigger (~80%, actual fires at turn boundaries so heavy turns overshoot to ~85-90%) |
| `HEALTH_THRESHOLDS` | recommender.ts | 50/70/85 | healthy/warming/hot/critical |
| `MCP_TOKENS_PER_TOOL` | scanner.ts | 0 | MCP tools loaded on-demand |
| `TOTAL_BUILTIN_TOOL_TOKENS` | built-in-tools.ts | 9,055 | Sum of 40 tool schemas |
| `CRUSTS_DIR` | calibrator.ts | `~/.claude-crusts` | Calibration + trend data directory |
| `HISTORY_PATH` | trend.ts | `~/.claude-crusts/history.jsonl` | Append-only trend history |
| `DEFAULT_SKILL_TOKENS` | scanner.ts | 60 | Per-skill token estimate fallback |
| `HOOK_COMMAND` | hooks.ts | `claude-crusts status` | Command installed in Claude Code hooks |
| `CRUSTS_CONFIG_PATH` | hooks.ts | `~/.claude-crusts/config.json` | Hook toggle state file |

## Waste Detection Rules

1. **Stale reads**: file read >15 messages ago, filename not referenced since
2. **Duplicate reads**: same file read multiple times, edit-aware (Write/Edit between reads = valid)
3. **Oversized system**: system prompt >1,500 tokens
4. **Resolved exchanges**: short user messages (<100 chars) containing resolution phrases, >500 tokens in preceding 10 messages
5. **Cache overhead**: `cache_read_input_tokens / total_input > 60%`
6. **Unused results**: non-retrieval tool results >200 chars where assistant text <50 chars in next 5 messages

Post-compaction aware: only analyzes messages after `currentContext.startIndex`.

## Known Issues

- `bun.lock` still says `"name": "crusts"` (pre-rename, harmless)
- Report version string is hardcoded in `html-report.ts` and `md-report.ts` footers (not read from package.json)

## Dependencies

Runtime: chalk 5.6.2, cli-table3 0.6.5, commander 14.0.3
Dev: @types/bun 1.3.11, @types/node 25.5.0, typescript 6.0.2
