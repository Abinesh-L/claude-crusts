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
claude-crusts statusline                         — Render statusline glyph (reads Claude Code JSON on stdin)
claude-crusts statusline install|uninstall|status — Manage Claude Code statusline integration
claude-crusts optimize [session-id]              — Ranked actionable fixes with token-savings ROI (--apply to write changes)
claude-crusts models [session-id]                — Per-session model usage snapshot (one row per contiguous same-model segment)
claude-crusts doctor                             — Sanity-check the install (Claude Code, hooks, statusline, backups)
claude-crusts diff [session-id] --from <n> --to <n>  — Intra-session diff: per-category delta between two message cutpoints
claude-crusts trend --format csv [--output <path>]   — Export trend history as CSV for external analysis
claude-crusts hooks auto-inject enable|disable|status|log — Manage hook-triggered fix injection (UserPromptSubmit); `log` shows history at ~/.claude-crusts/auto-inject.log
claude-crusts auto-inject                        — Internal hook target (reads stdin; emits additionalContext when hot)
claude-crusts bench compact [session-id]         — Tail the session JSONL for a /compact event; write before/after delta to JSON
claude-crusts bench reextract <result.json>      — Re-run the file-ref extractor against an existing bench result (no recompact)
claude-crusts bench compare <a.json> <b.json>    — Diff two bench-compact results (survivor file-ref set + token metrics)
claude-crusts completion <bash|zsh|pwsh>         — Emit a shell completion script (TAB completes subcommands + session IDs)
```

Optimize flags: `--apply`, `--yes`, `--min-savings <n>` (default 100), `--filter <types>` (comma-separated fix kinds), `--project-path <path>` (override cwd for .claudeignore / CLAUDE.md writes)

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
                                                                statusline.ts
                                                                model-context.ts
                                                                optimizer.ts
                                                                doctor.ts
                                                                auto-inject.ts
                                                                session-diff.ts
                                                                config.ts
                                                                bench.ts
                                                                html-report.ts
                                                                md-report.ts
```

Supporting: `types.ts`, `built-in-tools.ts`

### File Responsibilities

- **types.ts**: All shared types and interfaces (including ComparisonResult, CategoryDelta, TrendRecord, TrendSummary, SkillInfo)
- **index.ts**: CLI entrypoint with 18 Commander.js commands (adds `optimize`, `doctor`, `diff` to the hooks/statusline groups; `trend` gains `--format csv` / `--output` flags)
- **analyzer.ts**: Pipeline orchestrator, project path decoding, trend recording
- **scanner.ts**: Session discovery, JSONL streaming, config readers (MCP, memory, skills). `discoverSessions` fills `SessionInfo.claudeCodeVersion` via `readClaudeCodeVersion(path)`, a chunked head probe (64 KB steps, 1 MB cap) for the first record with a non-empty `version`; `detectClaudeCodeVersion(messages)` does the same over parsed records and feeds `breakdown.claudeCodeVersion` in the classifier
- **classifier.ts**: Core engine — classification, token estimation, compaction detection, derived overhead, auto-trim. `computeModelHistory` walks non-synthetic assistant turns and builds `ModelHistory` (one segment per contiguous same-model run, with per-segment input/output/cache token sums). `breakdown.model` reports the LAST non-synthetic model (current state), not the first.
- **waste-detector.ts**: 6 waste detection rules (edit-aware)
- **recommender.ts**: 7 recommendation patterns + fix prompt generator. `buildCompactCommand` (used by `fix` block 3) and `recommendCompactCommand` (used by `analyze` priority-1) both delegate to `optimizer.ts:buildCompactFocus` so all three commands — `fix`, `analyze`, `optimize` — emit byte-identical `/compact focus "..."` strings on the same session
- **renderer.ts**: 8 render functions (dashboard, timeline, list, waste, fix, comparison, lost, trend). Bar chart guarantees ≥1 filled block for categories ≥1%
- **calibrator.ts**: /context parser, calibration storage, comparison. Exports `CRUSTS_DIR` (~/.claude-crusts). Parses both the current markdown table (`| Label | 21.1k | 2.1% |`, `k`/`m` suffixes, `**Tokens:** used / window` header, bucket rows scoped to the "Estimated usage by category" section so per-tool / memory / skills sub-tables are ignored) and the legacy colon format. `(deferred)` rows and the autocompact buffer are captured but excluded from `total_used`; `window_size` and `model` are exposed; the "System tools" row is persisted as `core_schema_tokens_override` (read via `loadCoreSchemaOverride()`), which the classifier prefers over any version-keyed schema constant. `parseTokensHeader` / `parseContextWindowSize` are exported for transcript-based window detection. `readPastedBlock` ends on two consecutive empty lines (the table contains single blank lines). Tests sandbox the file via `CRUSTS_CALIBRATION_DIR_OVERRIDE`.
- **trend.ts**: Cross-session trend tracking — append-only JSONL history, deduped by session id, sparkline + direction detection
- **comparator.ts**: Cross-session comparison engine with 5 auto-insight rules
- **html-report.ts**: Standalone HTML report generator (session + comparison modes)
- **md-report.ts**: Standalone Markdown report generator (session + comparison modes)
- **lost-detector.ts**: Compaction loss analysis — reconstructs what was dropped. Detects tool_use ID filenames and replaces with "Agent sub-task result". Extracts meaningful descriptions from agent/tool results
- **watcher.ts**: Live session monitor with compact dashboard, inline compaction line (flash effect on new compaction, settles to yellow), category labels `C R U Sys T St`
- **built-in-tools.ts**: core tool catalogue. `CORE_TOOL_NAMES` (20 always-loaded names, no per-tool token guesses; Task* and AskUserQuestion are version-dependent), `CORE_SCHEMA_TOKENS_BY_VERSION` (core schema cost per Claude Code version band: >=2.1.214 -> 20,500; 2.1.160+ -> 17,500; 2.1.150+ -> 15,000; else `LEGACY_CORE_SCHEMA_TOKENS` 9,055, which `TOTAL_BUILTIN_TOOL_TOKENS` aliases for back-compat), `resolveCoreSchemaTokens(version, override, legacy)` (calibration override > version table > legacy), and the deferred load costs `DEFERRED_BUILTIN_LOAD_TOKENS` 1,000 / `DEFERRED_MCP_LOAD_TOKENS` 330 charged per distinct tool at the ToolSearch result that loaded it. The classifier derives `toolBreakdown.loadedTools` = core names + tools invoked without a ToolSearch load + `loadedDeferred` (from `toolUseResult.matches` / `tool_reference` blocks); `deferredBuiltIn` / `deferredMcp` come from `deferred_tools_delta` attachment records and are never listed as loaded or unused. `isCrustsShellCall` treats `PowerShell` like `Bash` so Windows self-calls are trimmed
- **tui.ts**: Interactive REPL shell — session picker, command dispatch (analyze/waste/fix/copy/timeline/lost/status/compare/trend), readline-based prompt with session ID indicator, tab completion for commands + session IDs, clipboard copy for fix blocks
- **clipboard.ts**: Cross-platform clipboard utility — `clip` (Windows), `pbcopy` (macOS), `xclip`/`xsel` (Linux)
- **hooks.ts**: Claude Code hook integration — reads/writes `~/.claude/settings.json` hooks, manages `~/.claude-crusts/config.json` toggle state
- **statusline.ts**: Claude Code statusline integration — installs a `statusLine` entry that runs `claude-crusts statusline` on every refresh. Exposes `renderStatusline` (one-glyph + % output) and `readStatuslinePayload` (stdin JSON reader with fallback to null on any error — statusline must never break Claude Code); the payload's `model.id` and `context_window.context_window_size` are threaded into `classifySession` as `modelOverride` / `limitOverride`
- **model-context.ts**: Model-to-context-window resolution plus the shared usage helpers. `effectiveInput(usage)` = `input_tokens + cacheCreationTokens(usage) + cache_read_input_tokens`, where `cacheCreationTokens` takes the larger of the flat `cache_creation_input_tokens` and the nested `cache_creation.ephemeral_5m + ephemeral_1h` sum (they disagree on real records; one turn had flat 0 vs nested 815,917). Every "how big was the window on this turn" computation (classifier window total, compaction detection, framing derivation, model history, cache-overhead waste rule) goes through it. `resolveContextLimitWithSignal(modelId, messages, {limitOverride, settingsModels})` resolves the window from the full signal priority list: payload `limitOverride` > latest recorded `## Context Usage` (/context) user record's `**Tokens:** used / window` header (parsed via calibrator's `parseContextWindowSize`; 200k/500k/1m all observed) > model-id `[1m]` regex > settings.json model when its family matches the session model (`detectSettingsContextLimit`; models supplied by scanner's `readSettingsModels` through `ConfigData.settingsModels`) > usage above 200K (conclusive 1M) > native-1M table `NATIVE_1M_MODEL_PATTERN` (bare fable-5/mythos-5/opus-5/sonnet-5) > 200K default. `signal` is `payload | context-command | model-id | settings | usage | native | default`; the classifier prints it under `--verbose`. The 4.x models (opus-4-6/4-7/4-8, sonnet-4-6) stay at 200K without a signal. `resolveContextLimit` is a back-compat wrapper that drops the signal. Claude Code strips `[1m]` from JSONL, so the settings/usage/native signals carry recorded sessions where the variant is gone.
- **optimizer.ts**: Ranked actionable fixes with ROI. `buildOptimizeReport` generates a sorted list of fixes (compact-focus, .claudeignore append, CLAUDE.md rule append, MCP disable info, CLAUDE.md oversized warning), each tagged with estimated token savings. `applyFix` handles the auto-apply pipeline: per-fix confirmation, backup to `~/.claude-crusts/backups/<filename>.<timestamp>.bak`, atomic write, clipboard fallback for non-file fixes. `pruneBackups` keeps only the last 10 backups per filename. Noise-pattern detection groups repeated reads of `node_modules/`, `dist/`, `build/`, `.next/`, `target/`, `.git/`, and `*.lock` files.
- **doctor.ts**: Sanity-check command. Nine checks cover Claude Code install, settings.json validity, session discovery, hook/statusline install state, calibration presence, trend history readability, and optimize-backup-dir writability. Each check returns `pass | warn | fail`; `aggregateStatus` picks the worst of the three as the overall verdict.
- **config.ts**: Shared user-level config store at `~/.claude-crusts/config.json`. Exports `loadConfig` / `saveConfig` (merge-safe: sibling keys preserved on partial writes), `loadWasteThresholds` (returns effective thresholds merging user overrides into `DEFAULT_WASTE_THRESHOLDS`), and `describeThresholdOverrides` (human-readable delta list used by `--verbose`). `hooks.ts` has been migrated to use these helpers so the hook state no longer clobbers the waste-thresholds key.
- **session-diff.ts**: Intra-session diff engine. `computeSessionDiff(messages, config, sessionId, fromIndex, toIndex)` runs `classifySession` at two cutpoints and returns per-category deltas. Complements `comparator.ts` (which diffs two *different* sessions). Renderer prints a coloured cli-table with green/yellow highlights for negative/positive deltas.
- **bench.ts**: Measurement harness for `/compact` events. `runBenchCompact(session, options)` captures a BEFORE snapshot, tails the session JSONL for a `compact_boundary` record, then captures AFTER — replacing the fragile "paste-and-switch-window" PowerShell flow. Extracts "what survived" from the post-boundary `isCompactSummary` message via `extractFileRefs`, which uses a `FILE_EXTENSION_WHITELIST` so JS method calls like `Math.abs` / `console.log` don't pollute the survivor list. `compareBenchResults(a, b)` diffs two bench envelopes to produce `onlyInA` / `onlyInB` / `inBoth` sets — the A/B experiment payload. `reextractSummaryRefs(resultPath)` re-runs the extractor against the session JSONL so old bench outputs can be cleaned after the regex is tightened, without recompacting the session. Exit semantics: 0 on compact, 2 on timeout, 1 on error.
- **auto-inject.ts**: Hook-triggered fix injection. Installed as a `UserPromptSubmit` hook in Claude Code settings; runs on every user submit. `shouldInject(breakdown, config, sessionId)` gate-keeps on `enabled`, usage ≥ `threshold`, and per-session min-gap. When the gate opens, `buildInjectionText` synthesises a session-specific advisory with a `/compact focus "..."` tuned to top waste, and `runAutoInject` emits it as a `hookSpecificOutput.additionalContext` payload so Claude sees it prepended to the turn's context. Each injection is also appended to `~/.claude-crusts/auto-inject.log` (JSONL) via `writeInjectionLog` for audit/transparency — `readInjectionLog(limit?)` returns entries newest-first, skipping corrupt lines. Fire-and-forget: all errors swallowed so a bug never blocks the user's prompt. Opt-in via `hooks auto-inject enable`; audit history via `hooks auto-inject log`.
- **completion.ts**: Shell-completion script emitters. `generateCompletionScript(shell)` dispatches to `generateBashCompletion` / `generateZshCompletion` / `generatePowerShellCompletion`, each returning a script text the user sources from their shell profile. Scripts cover top-level subcommand completion and session-id prefix completion for the dozen commands that take `[session-id]`. Session IDs are sourced via `claude-crusts completion ids` — an internal subcommand that prints one ID per line so completion scripts don't need jq, awk, or PowerShell JSON parsing. `SUBCOMMANDS` and `SESSION_ID_SUBCOMMANDS` lists are hard-coded here and must be kept in sync with `index.ts` command additions; `tests/completion.test.ts` guards against drift on the core command names.
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
- Includes: tool block metadata (IDs, names), recursive sub-blocks (each estimated with its own divisor, then added as tokens)
- Media: image blocks cost a flat `IMAGE_BLOCK_TOKENS` (1,500); document blocks cost base64 length / 4
- NOT counted: `block.signature`. Thinking text is never persisted in the JSONL (every thinking block has `thinking: ''`); the signature is an opaque verification token, not content

**Derived overhead** — per-session, not hardcoded:
- Internal system prompt: first assistant `input_tokens` − known components (CLAUDE.md + core tool schemas [version-keyed, calibration-pinned; see built-in-tools.ts] + memory + discovered skills [fallback 476] + first user message). Range 1K-15K.
- Message framing: median of ≤20 consecutive assistant pair deltas from post-compaction window. Range 0-50 tokens/msg. Distributed proportionally across categories.

**Edit-aware waste detection**:
- Checks for Write/Edit/FileWriteTool/FileEditTool/NotebookEdit between consecutive Read operations
- Re-reads after edits = valid. Only reads with no intervening edit = waste.

**Auto-trim** — 3-phase backward walk:
1. Strip trailing CRUSTS Bash calls and tool_results
2. Strip preceding assistant text/thinking (same turn)
3. Strip the triggering user prompt

**MCP tools**: `MCP_TOKENS_PER_TOOL = 0` for configured-but-deferred servers. Deferred schemas (MCP and deferred built-ins) cost 0 until a `ToolSearch` call loads them; each load is then charged once per distinct tool at the result index (~330 per MCP tool, ~1,000 per deferred built-in).

**Dynamic context limit** — resolved per-session via `resolveContextLimitWithSignal(model, messages, {limitOverride, settingsModels})` in `model-context.ts`. Priority (first hit wins): (1) live payload `context_window.context_window_size`; (2) latest `## Context Usage` record in the transcript (a free integer: 200k/500k/1m all observed); (3) model-ID `[1m]` regex; (4) settings.json `[1m]` model whose family matches the session model; (5) usage heuristic: any turn's effective input above 200K proves 1M (a 200K model would have errored); (6) native-1M families (bare fable-5/mythos-5/opus-5/sonnet-5 IDs); (7) 200K default, where 4.x models land without a signal.

**Model ID sources** — Claude Code **strips the `[1m]` variant** from the `model` field it writes to JSONL, so for recorded sessions the regex never matches and the usage heuristic is load-bearing. The live statusline path sidesteps this: `classifySession(messages, config, untilIndex, modelOverride, limitOverride)` accepts an optional `modelOverride` (threaded from the stdin payload's `model.id`, which Claude Code preserves with the variant) and an optional `limitOverride` (the payload's `context_window.context_window_size`, which wins over every recorded signal). Result: statusline on a fresh 1M session correctly shows small percentages even before any usage crosses 200K.

**Multi-model sessions (model switching)** — when a user switches Claude models mid-session, `computeModelHistory` in `classifier.ts` builds a `ModelHistory` with one `ModelSegment` per contiguous same-model run. `breakdown.model` is the LAST non-synthetic model (current state); the first model is preserved in `modelHistory.segments[0]`. The analyze header appends "(switched from X)" when `switchCount > 0`. The `models` command renders the full per-segment table with input/output/cache-read/cache-write token sums from `usage.*` (exact, not estimated).

**Health label reads current, not lifetime** — `recommender.ts` passes `breakdown.currentContext?.usage_percentage ?? breakdown.usage_percentage` to `getContextHealth`. Using `breakdown.usage_percentage` alone was a bug: post-compaction sessions accumulate lifetime tokens that routinely exceed the context limit, reading as "critical" even when the live window is cold. The fallback path preserves correct behaviour for pre-compaction sessions where `currentContext` is undefined.

## All Constants

| Constant | File | Value | Purpose |
|----------|------|-------|---------|
| `DEFAULT_CONTEXT_LIMIT` | model-context.ts | 200,000 | Fallback window size; the signal priority list (payload, /context record, `[1m]` variant, settings.json, usage above 200K, native-1M 5-generation families) can resolve any other window |
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
| `CORE_SCHEMA_TOKENS_BY_VERSION` | built-in-tools.ts | 20,500 / 17,500 / 15,000 | Core tool schema cost by Claude Code version band (>=2.1.214 / >=2.1.160 / >=2.1.150); `LEGACY_CORE_SCHEMA_TOKENS` 9,055 below that (aliased as `TOTAL_BUILTIN_TOOL_TOKENS`); a saved calibrate override wins |
| `DEFERRED_BUILTIN_LOAD_TOKENS` / `DEFERRED_MCP_LOAD_TOKENS` | built-in-tools.ts | 1,000 / 330 | Per-tool window cost charged when ToolSearch loads a deferred schema |
| `CRUSTS_DIR` | calibrator.ts | `~/.claude-crusts` | Calibration + trend data directory |
| `HISTORY_PATH` | trend.ts | `~/.claude-crusts/history.jsonl` | Append-only trend history |
| `DEFAULT_SKILL_TOKENS` | scanner.ts | 60 | Per-skill token estimate fallback |
| `HOOK_COMMAND` | hooks.ts | `claude-crusts status` | Command installed in Claude Code hooks |
| `CRUSTS_CONFIG_PATH` | hooks.ts | `~/.claude-crusts/config.json` | Hook toggle state file |
| `STATUSLINE_COMMAND` | statusline.ts | `claude-crusts statusline` | Command installed as Claude Code statusLine |
| `STATUSLINE_CONFIG_PATH` | statusline.ts | `~/.claude-crusts/statusline.json` | Statusline toggle state file |
| `CRUSTS_CONFIG_PATH` | config.ts | `~/.claude-crusts/config.json` | Shared user config (hooks + wasteThresholds) |
| `DEFAULT_WASTE_THRESHOLDS` | config.ts | see source | Defaults merged with user overrides |
| `BACKUPS_PER_FILE` | optimizer.ts | 10 | Max backups kept per original filename under `~/.claude-crusts/backups/` |
| `DEFAULT_AUTO_INJECT` | config.ts | `{enabled:false, threshold:70, minGapMs:300000}` | Default auto-injection config (opt-in via `hooks auto-inject enable`) |
| `AUTO_INJECT_HOOK_COMMAND` | hooks.ts | `claude-crusts auto-inject` | Command installed as Claude Code `UserPromptSubmit` hook |

## Waste Detection Rules

1. **Stale reads**: file read >15 messages ago, filename not referenced since
2. **Duplicate reads**: same file read multiple times, edit-aware (Write/Edit between reads = valid)
3. **Oversized system**: system prompt >1,500 tokens
4. **Resolved exchanges**: short user messages (<100 chars) containing resolution phrases, >500 tokens in preceding 10 messages
5. **Cache overhead**: `cache_read_input_tokens / total_input > 60%`
6. **Unused results**: non-retrieval tool results >200 chars where assistant text <50 chars in next 5 messages

Post-compaction aware: only analyzes messages after `currentContext.startIndex`.

## Development Workflow — Regression Coverage

Every non-trivial change must land with unit test coverage.

**When you add a new feature, you must:**

1. **Add unit tests.** Every new module or exported function lands with coverage in `tests/*.test.ts`. `bun test` runs in under 10 seconds — the fast feedback loop.
2. **Read the output critically.** Exit 0 from the suite is necessary but not sufficient. When running commands manually, eyeball: category-sum consistency with displayed totals, `Context health:` label matching the `%` shown, correct model in the header (LAST non-synthetic assistant), no NaN / Infinity / undefined leaking into user-facing numbers.
3. **When a feature has a numeric invariant worth enforcing**, add a unit test that asserts the invariant (see `tests/model-history.test.ts` for the post-compaction-health pattern and `tests/classifier.test.ts` for the API-effective-input invariants).

**Cadence:**

- Before any `git commit` on a feature branch: `bun test` must pass (`bun run typecheck` too).
- Before moving the `v*` tag or pushing: do a manual `analyze` on a known-real session and eyeball the numbers. Unit tests catch most regressions, but a live session is the only way to notice display-level weirdness.
- Before any `git push origin v*` or `npm publish`: a second live run on a session with compactions in it, confirming `TOTAL`, `FREE`, `usage_percentage`, and `Context health:` are all consistent with each other and bounded by `context_limit`.

## Known Issues

- `bun.lock` still says `"name": "crusts"` (pre-rename, harmless)
- Report version string is hardcoded in `html-report.ts` and `md-report.ts` footers (not read from package.json)

## Dependencies

Runtime: chalk 5.6.2, cli-table3 0.6.5, commander 14.0.3
Dev: @types/bun 1.3.11, @types/node 25.5.0, typescript 6.0.2
