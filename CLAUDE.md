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
- **index.ts**: CLI entrypoint with 23 user-facing Commander.js commands (see the CLI Commands table above; `trend` gains `--format csv` / `--output` flags)
- **analyzer.ts**: Pipeline orchestrator, project path decoding, trend recording
- **scanner.ts**: Session discovery, JSONL streaming, config readers (MCP, memory, skills, settings models, compaction settings). `discoverSessions` fills `SessionInfo.claudeCodeVersion` via `readClaudeCodeVersion(path)`, a chunked head probe (64 KB steps, 1 MB cap) for the first record with a non-empty `version`; `detectClaudeCodeVersion(messages)` does the same over parsed records and feeds `breakdown.claudeCodeVersion` in the classifier. `parseSession` skips lines that lead with a non-analysed `type` before `JSON.parse` (2.1.300 writes `api-request`, `api-request-blob` and `api-request-shape` copies of every request) and marks a `compact_boundary` with `idleCompaction: true` when Claude Code's "Compacted while idle" informational notice follows it. `readCompactionSettings(projectPath?, env?)` reads `autoCompactEnabled` / `DISABLE_AUTO_COMPACT`, `autoCompactWindow`, `modelSettings.<model>.autoCompactWindow`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `idleCompaction`, `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` (floored at 100K) and `CLAUDE_CODE_DISABLE_1M_CONTEXT` from the settings files (local project > project > user), their `env` blocks, and the process environment (which wins; hooks inherit Claude Code's environment)
- **classifier.ts**: Core engine — classification, token estimation, compaction detection, derived overhead, auto-trim. `computeModelHistory` walks non-synthetic assistant turns and builds `ModelHistory` (one segment per contiguous same-model run, with per-segment input/output/cache token sums). `breakdown.model` reports the LAST non-synthetic model (current state), not the first. Window resolution reads every span of the current model family (`sameFamilyMessages`), not just the last span. `detectViaMarkers` skips carried-over assistants after a boundary (`isPreCompactionCarryover`: timestamped before the boundary, or, only for the first response after the boundary with no newer prompt before it, an in-flight turn within 10 minutes that sits above `postTokens + POST_COMPACTION_ALLOWANCE` and nearer `preTokens`), records `firstLiveIndex` and `postTokens`, and sets `tokensAfter` from the first live turn. `liveWindowTokens` is the single live-window total: the last turn from `firstLiveIndex` on, or before the first live turn the estimate `postTokens` + the fixed context + re-attached files. Before the first response, the session model comes from Claude Code's `model` attachment (`announcedModel`). Attachments are sized from `rendered` (2.1.268+, `RENDERED_ATTACHMENTS_SINCE`); an unrendered 2.1.268+ attachment was never sent and costs 0; `instructionsOverhead` replaces the disk CLAUDE.md/memory figures with the session's own `instructions` attachments: the latest full one plus every later delta (`changed: true`, written on resume), each split by AutoMem share. `breakdown.compaction` carries the compaction model (see model-context.ts).
- **waste-detector.ts**: 6 waste detection rules (edit-aware)
- **recommender.ts**: 8 recommendation patterns (compact command, compaction prediction, idle compaction, duplicate reads, top consumers, MCP info, CLAUDE.md size, session habit) + fix prompt generator. "Messages until auto-compaction" projects the live window's growth per message since it started (`windowGrowth`: from the last compaction's `tokensAfter`, or the first turn's input; no projection under 4 messages). `buildCompactCommand` (used by `fix` block 3) and `recommendCompactCommand` (used by `analyze` priority-1) both delegate to `optimizer.ts:buildCompactFocus` so all three commands — `fix`, `analyze`, `optimize` — emit byte-identical `/compact focus "..."` strings on the same session
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
- **model-context.ts**: Model-to-context-window resolution, the compaction model, and the shared usage helpers. `effectiveInput(usage)` = `input_tokens + cacheCreationTokens(usage) + cache_read_input_tokens`, where `cacheCreationTokens` takes the larger of the flat `cache_creation_input_tokens` and the nested `cache_creation.ephemeral_5m + ephemeral_1h` sum, except for zeroed copies (`isZeroedUsageCopy`: input, cache_creation_input, cache_read and output all 0), which a continuation file writes for the previous conversation's last turns while the nested breakdown keeps the old window; they carry no usage. Every "how big was the window on this turn" computation goes through it. `resolveContextLimitWithSignal(modelId, messages, {limitOverride, settingsModels, disable1m})` resolves the window from the full signal priority list: payload `limitOverride` > latest recorded `## Context Usage` (/context) record whose `**Model:**` line names this model family (`detectContextCommandWindow(messages, modelId)`; 200k/500k/1m all observed) > `CLAUDE_CODE_DISABLE_1M_CONTEXT` (200K) > model-id `[1m]` regex > settings.json model when its family matches the session model > usage above 200K (conclusive 1M) > native 1M (`getNativeContextLimit`, from Claude Code's model-config docs: Fable, Sonnet 5+, Haiku 5.5+, Opus 4.7+, Mythos 5+; IDs parsed by `parseClaudeModelId` as family + major + minor, date and variant tolerated) > 200K default (Opus 4.6, Sonnet 4.6, older). `signal` is `payload | context-command | disable-1m | model-id | settings | usage | native | default`. `resolveCompactionModel(limit, model, liveTokens, settings, cacheTtl)` returns `{trigger, autoCompactWindow, windowSource, bufferTokens, idle}`: trigger = min(auto-compact window, limit) - buffer (env > per-model `/autocompact` window > top-level `autoCompactWindow` > the window), null when auto-compaction is off; idle compaction applies when enabled, the latest cache write is not the 5-minute TTL (`latestCacheTtl`), and the live window is at or above the idle threshold. Claude Code strips `[1m]` from JSONL, so the settings/usage/native signals carry recorded sessions where the variant is gone.
- **optimizer.ts**: Ranked actionable fixes with ROI. `buildOptimizeReport` generates a sorted list of fixes (compact-focus, .claudeignore append, CLAUDE.md rule append, MCP disable info, CLAUDE.md oversized warning), each tagged with estimated token savings. `applyFix` handles the auto-apply pipeline: per-fix confirmation, backup to `~/.claude-crusts/backups/<filename>.<timestamp>.bak`, atomic write, clipboard fallback for non-file fixes. `pruneBackups` keeps only the last 10 backups per filename. Noise-pattern detection groups repeated reads of `node_modules/`, `dist/`, `build/`, `.next/`, `target/`, `.git/`, and `*.lock` files.
- **doctor.ts**: Sanity-check command. Nine checks cover Claude Code install, settings.json validity, session discovery, hook/statusline install state, calibration presence, trend history readability, and optimize-backup-dir writability. Each check returns `pass | warn | fail`; `aggregateStatus` picks the worst of the three as the overall verdict.
- **config.ts**: Shared user-level config store at `~/.claude-crusts/config.json`. Exports `loadConfig` / `saveConfig` (merge-safe: sibling keys preserved on partial writes; atomic: temp file + rename, so concurrent hooks never tear the file), `loadWasteThresholds` (returns effective thresholds merging user overrides into `DEFAULT_WASTE_THRESHOLDS`), and `describeThresholdOverrides` (human-readable delta list used by `--verbose`). `hooks.ts` has been migrated to use these helpers so the hook state no longer clobbers the waste-thresholds key.
- **session-diff.ts**: Intra-session diff engine. `computeSessionDiff(messages, config, sessionId, fromIndex, toIndex)` runs `classifySession` at two cutpoints and returns per-category deltas. Complements `comparator.ts` (which diffs two *different* sessions). Renderer prints a coloured cli-table with green/yellow highlights for negative/positive deltas.
- **bench.ts**: Measurement harness for `/compact` events. `runBenchCompact(session, options)` captures a BEFORE snapshot, tails the session JSONL for a `compact_boundary` record, then captures AFTER — replacing the fragile "paste-and-switch-window" PowerShell flow. Extracts "what survived" from the post-boundary `isCompactSummary` message via `extractFileRefs`, which uses a `FILE_EXTENSION_WHITELIST` so JS method calls like `Math.abs` / `console.log` don't pollute the survivor list. `compareBenchResults(a, b)` diffs two bench envelopes to produce `onlyInA` / `onlyInB` / `inBoth` sets — the A/B experiment payload. `reextractSummaryRefs(resultPath)` re-runs the extractor against the session JSONL so old bench outputs can be cleaned after the regex is tightened, without recompacting the session. Exit semantics: 0 on compact, 2 on timeout, 1 on error.
- **auto-inject.ts**: Hook-triggered fix injection. Installed as a `UserPromptSubmit` hook in Claude Code settings; runs on every prompt submit, which includes background-task reports, `/loop` iterations and cross-session messages. `promptSkipReason(prompt)` skips `/compact`, `/clear` (and its aliases `/reset`, `/new`), slash-command echoes and interrupts before the transcript parse. The hook builds config from the session's own project (the project root decoded from the transcript's folder as `analyze` does, else `payload.cwd`, which follows a mid-session `cd`; the slug; observed MCP servers). `shouldInject(breakdown, config, sessionId)` gate-keeps on `enabled`, usage ≥ `threshold` while that point comes before Claude Code's trigger (else the headroom gate: within max(20K, 10% of the auto-compact window) of `breakdown.compaction.trigger`), and a per-session min-gap (`autoInject.lastInjections`, the newest 50 sessions kept). When the gate opens, `buildInjectionText` synthesises a session-specific advisory with the `/compact focus "..."` from `compactCommandFor(waste)` and a "Why now" line naming this session's trigger and idle compaction, and `runAutoInject` emits it as `hookSpecificOutput.additionalContext` (for Claude) plus `systemMessage` (`buildUserNotice`, a one-line notice shown to the person whichever turn it rides on). Each injection is also appended to `~/.claude-crusts/auto-inject.log` (JSONL) via `writeInjectionLog` for audit/transparency — `readInjectionLog(limit?)` returns entries newest-first, skipping corrupt lines. Fire-and-forget: all errors swallowed so a bug never blocks the user's prompt. Opt-in via `hooks auto-inject enable`; audit history via `hooks auto-inject log`.
- **completion.ts**: Shell-completion script emitters. `generateCompletionScript(shell)` dispatches to `generateBashCompletion` / `generateZshCompletion` / `generatePowerShellCompletion`, each returning a script text the user sources from their shell profile. Scripts cover top-level subcommand completion and session-id prefix completion for the dozen commands that take `[session-id]`. Session IDs are sourced via `claude-crusts completion ids` — an internal subcommand that prints one ID per line so completion scripts don't need jq, awk, or PowerShell JSON parsing. `SUBCOMMANDS` and `SESSION_ID_SUBCOMMANDS` lists are hard-coded here and must be kept in sync with `index.ts` command additions; `tests/completion.test.ts` guards against drift on the core command names.
- **.claude/commands/crusts.md**: Custom slash command — runs `npx claude-crusts analyze --json` and gives actionable advice

## Key Technical Decisions

**Compaction detection** — marker-based, not heuristic:
- Primary: `subtype === 'compact_boundary'` with `compactMetadata.preTokens`
- Also detects: `isCompactSummary: true` (classified as System), `model: '<synthetic>'` (filtered at parse time)
- Fallback: 30K token drop between consecutive assistants (only if no markers)
- Records after a boundary can still describe the OLD window: a continuation file repeats the previous conversation's last turns (timestamped before the boundary, usage zeroed), and an in-flight turn can finish after it. Neither is a live turn; `firstLiveIndex` marks the first one that is.
- `compactMetadata.postTokens` is Claude Code's chars/4 count of what it wrote after compacting (summary, re-attached files, command records), without the fixed context; the first live turn sat 45K-77K above it on real sessions (median about 59K) and 142K once with a large preserved segment. It is never used as the window size on its own. Before the first live turn the window is estimated as postTokens + fixed context + re-attached files: within about -17% to +19% of the next request on real boundaries, and about a third low at a continuation file's first prompt, where no fixed-context anchor exists yet. The re-attached files are counted twice (postTokens already holds their chars/4 size), which offsets postTokens' chars/4 undercount; calibrating both is planned. The timeline marks this size with `~` until the next response.
- Idle compactions (Claude Code 2.1.286+ by reports, announced in 2.1.299; a 200K+ conversation idle about 54 minutes, one-hour cache) are labelled from the "Compacted while idle" or "Compacted after an hour idle" notice; 2.1.289 recorded them with trigger `manual`, 2.1.296 and later `auto`.

**Token estimation** — content-aware:
- Assistant messages: `output_tokens` from API (exact)
- Code content: chars / 3.3 (detected via `CODE_PATTERN` regex)
- English text: chars / 4.0
- Includes: tool block metadata (IDs, names), recursive sub-blocks (each estimated with its own divisor, then added as tokens)
- Media: image blocks cost a flat `IMAGE_BLOCK_TOKENS` (1,500); document blocks cost base64 length / 4
- NOT counted: `block.signature`. Thinking text is never persisted in the JSONL (every thinking block has `thinking: ''`); the signature is an opaque verification token, not content

**Derived overhead** — per-session, not hardcoded:
- Internal system prompt: the anchor turn's effective input − known components (CLAUDE.md + core tool schemas [version-keyed, calibration-pinned; see built-in-tools.ts] + memory + skills [skill_listing attachment preferred, else discovery, fallback 476] + every recorded window record before the anchor: user-role records, attachments, and for a compaction window the summary and carried-over content). The anchor is the first turn whose whole window the file records: the fresh first turn, else (a continuation file that opens with a boundary) the first live turn after a boundary. Accepted range: 1,000 up to the smallest live window (every live turn carries the fixed context; the old file-first anchor attributed a whole previous conversation, 790,912 tokens). CLAUDE.md and memory come from the session's `instructions` attachment when recorded. Semantics: "Claude Code fixed context not present in the JSONL".
- Message framing: median of ≤20 consecutive assistant pair deltas from post-compaction window. Range 0-50 tokens/msg. Distributed proportionally across categories.

**Edit-aware waste detection**:
- Checks for Write/Edit/FileWriteTool/FileEditTool/NotebookEdit between consecutive Read operations
- Re-reads after edits = valid. Only reads with no intervening edit = waste.

**Auto-trim** — 3-phase backward walk:
1. Strip trailing CRUSTS Bash calls and tool_results
2. Strip preceding assistant text/thinking (same turn)
3. Strip the triggering user prompt

**MCP tools**: `MCP_TOKENS_PER_TOOL = 0` for configured-but-deferred servers. Deferred schemas (MCP and deferred built-ins) cost 0 until a `ToolSearch` call loads them; each load is then charged once per distinct tool at the result index (~330 per MCP tool, ~1,000 per deferred built-in).

**Dynamic context limit** — resolved per-session via `resolveContextLimitWithSignal(model, messages, {limitOverride, settingsModels, disable1m})` in `model-context.ts`, over every span of the current model family (evidence from an earlier run of the same model counts; another model's does not). Priority (first hit wins): (1) live payload `context_window.context_window_size`; (2) latest `## Context Usage` record for this model in the transcript (a free integer: 200k/500k/1m all observed); (3) `CLAUDE_CODE_DISABLE_1M_CONTEXT` (200K); (4) model-ID `[1m]` regex; (5) settings.json `[1m]` model whose family matches the session model; (6) usage heuristic: any turn's effective input above 200K proves 1M (a 200K model would have errored); (7) native 1M per Claude Code's docs (Fable, Sonnet 5+, Haiku 5.5+, Opus 4.7+, Mythos 5+, point releases and dated IDs included); (8) 200K default (Opus 4.6, Sonnet 4.6, older and unrecognised IDs).

**Compaction model** — `breakdown.compaction` (from `resolveCompactionModel`), matching Claude Code 2.1.302: the token trigger is the auto-compact window minus the 33K buffer, where the window is `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (floored at 100K, capped at 1M), else the per-model window `/autocompact` saves under `modelSettings` ('auto' = the model default), else the top-level `autoCompactWindow`, else the context window (capped at it). Settings files layer user < project < local, and a file's top-level window replaces the per-model windows below it; window values outside 100K-1M are ignored. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` fires at min(floor((window - 20K) * pct / 100), window - buffer). Null when auto-compaction is off (`autoCompactEnabled: false`, `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`). Idle compaction (`IDLE_COMPACTION_SINCE`, 2.1.286) applies when it is on, the session's latest cache write was not the 5-minute TTL, and the live window is at or above `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` (200K default); it is rolled out in stages, so crusts says "may". Recommendations, the timeline, the default inject gate and the advisory all read this model.

**Model ID sources** — Claude Code **strips the `[1m]` variant** from the `model` field it writes to JSONL, so for recorded sessions the regex never matches and the usage heuristic is load-bearing. The live statusline path sidesteps this: `classifySession(messages, config, untilIndex, modelOverride, limitOverride)` accepts an optional `modelOverride` (threaded from the stdin payload's `model.id`, which Claude Code preserves with the variant) and an optional `limitOverride` (the payload's `context_window.context_window_size`, which wins over every recorded signal). Result: statusline on a fresh 1M session correctly shows small percentages even before any usage crosses 200K.

**Multi-model sessions (model switching)** — when a user switches Claude models mid-session, `computeModelHistory` in `classifier.ts` builds a `ModelHistory` with one `ModelSegment` per contiguous same-model run. `breakdown.model` is the LAST non-synthetic model (current state); the first model is preserved in `modelHistory.segments[0]`. The analyze header appends "(switched from X)" when `switchCount > 0`. The `models` command renders the full per-segment table with input/output/cache-read/cache-write token sums from `usage.*` (exact, not estimated).

**Health label reads current, not lifetime** — `recommender.ts` passes `breakdown.currentContext?.usage_percentage ?? breakdown.usage_percentage` to `getContextHealth`. Using `breakdown.usage_percentage` alone was a bug: post-compaction sessions accumulate lifetime tokens that routinely exceed the context limit, reading as "critical" even when the live window is cold. The fallback path preserves correct behaviour for pre-compaction sessions where `currentContext` is undefined.

**Window reconciliation (v0.8.0)** — bucket `tokens` are scaled (floor + remainder to the largest bucket) so their sum equals the API window `total_tokens` exactly; the raw classifier estimate is preserved per bucket as `contentTokens`. `currentContext` buckets are always reconciled when usage data exists; lifetime buckets are reconciled only when the session never compacted (a compacted lifetime is a cumulative-flow number, kept on the content basis). Guard band: if the scale factor falls outside [0.7, 1.4] the buckets stay on the content basis (`reconciliation.basis === 'content'`) and the scale is printed under `--verbose`, keeping estimator drift visible instead of masking it. Trend records carry `bucketBasis` (`window` or `content`; blank for pre-0.8 records).

## All Constants

| Constant | File | Value | Purpose |
|----------|------|-------|---------|
| `DEFAULT_CONTEXT_LIMIT` | model-context.ts | 200,000 | Fallback window size; the signal priority list (payload, /context record, `[1m]` variant, settings.json, usage above 200K, native 1M per Claude Code's docs) can resolve any other window |
| `NATIVE_1M_FROM` | model-context.ts | fable any, mythos 5+, sonnet 5+, haiku 5.5+, opus 4.7+ | First natively-1M version per family (`getNativeContextLimit`) |
| `IDLE_COMPACT_MIN_TOKENS` / `IDLE_COMPACT_FLOOR_TOKENS` / `IDLE_COMPACT_AFTER_MINUTES` | model-context.ts | 200,000 / 100,000 / 54 | Idle compaction default threshold, the lowest threshold Claude Code accepts, and the idle minutes before it fires |
| `IDLE_COMPACTION_SINCE` | model-context.ts | 2.1.286 | First Claude Code version reported compacting idle sessions (announced in 2.1.299, rolled out in stages) |
| `MIN_MESSAGES_FOR_RUNWAY` | recommender.ts | 4 | Messages a live window needs before "messages until auto-compaction" is projected |
| `RECENT_INJECTIONS_KEPT` | config.ts | 50 | Sessions whose last-injection time config.json keeps for the per-session min-gap |
| `RENDERED_ATTACHMENTS_SINCE` | classifier.ts | 2.1.268 | First version that writes `rendered` on every sent attachment; an unrendered attachment from it on costs 0 |
| `POST_COMPACTION_ALLOWANCE` / `IN_FLIGHT_WINDOW_MS` | classifier.ts | 100,000 / 10 min | Carry-over test for the first response after a boundary: it must sit more than this above `postTokens` AND nearer `preTokens` than `postTokens`, within this time of the boundary. Not a bound on live turns (one sat 142K above `postTokens`; the midpoint test kept it live) |
| `CHARS_PER_TOKEN_TEXT` | classifier.ts | 4.0 | Token divisor for English |
| `CHARS_PER_TOKEN_CODE` | classifier.ts | 3.3 | Token divisor for code |
| `COMPACTION_DROP_THRESHOLD` | classifier.ts | 30,000 | Heuristic fallback threshold |
| `STALE_READ_THRESHOLD` | waste-detector.ts | 15 | Messages before read is "stale" |
| `OVERSIZED_SYSTEM_THRESHOLD` | waste-detector.ts | 1,500 | System prompt token warning |
| `CACHE_OVERHEAD_THRESHOLD` | waste-detector.ts | 0.6 | Cache read ratio warning (60%) |
| `RESOLUTION_LOOKBACK` | waste-detector.ts | 10 | Messages to scan for resolved exchanges |
| `AUTOCOMPACT_BUFFER_TOKENS` | model-context.ts | 33,000 | Auto-compaction headroom buffer; trigger = auto-compact window − buffer (167,000 on 200K, 967,000 on 1M with no `autoCompactWindow` setting; see `resolveCompactionModel`). `autocompactBufferTokens` in config.json overrides. Fires at turn boundaries, so heavy turns overshoot |
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
| `DEFAULT_AUTO_INJECT` | config.ts | `{enabled:false, threshold:70, minGapMs:300000}` | Default auto-injection config (opt-in via `hooks auto-inject enable`). The `threshold` percent gates ONLY when the user set it explicitly in config.json (`thresholdExplicit`) and that point comes before the trigger; otherwise the gate is headroom-based: inject when the window is within max(20,000, 10% of the auto-compact window) tokens of `breakdown.compaction.trigger` |
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

- Interleaved concurrent-session chains: a JSONL where several prompt chains interleave (parallel Claude Code panes on one session file) shows unmarked >30K drops between consecutive assistants. Chain reconstruction from `last-prompt.leafUuid` is deferred (v0.8.0 mitigates it: phantom rows are dropped at parse time and compaction detection prefers markers over the drop heuristic)
- Subagent session files are not discovered or merged into the parent analysis (`--include-subagents` deferred)
- Attachment records are assumed to persist in the window on later turns; if Claude Code re-injects some types per turn (task_reminder is the big one), those buckets can over-count. Settling evidence: framing-delta sign across turns with large task reminders
- `CORE_SCHEMA_TOKENS_BY_VERSION` values are minimums read off /context rows that may already include ToolSearch-loaded built-ins; a saved `calibrate` override is always the authority
- Text divisors (4.0 / 3.3 chars per token) under-count current models (about 2.45 chars per token on tool results), so estimated buckets read low before reconciliation scales them; buckets with exact assistant output are relatively over-weighted. 2.1.268+ transcripts record the fixed context (`prompt_snapshot`) and 2.1.300 records every request (`api-request-shape` + `api-request-blob`), which allows exact composition (planned)
- Kept thinking dropped at a model switch or a cache-prefix mismatch (`thinking_drop` attachments) still counts in Conversation
- The skills listing re-sent after a compaction is not recorded, so post-compaction views can miss it (about 7K tokens)
- `hooks enable` installs `claude-crusts status` on the Notification event, where Claude Code discards `systemMessage` and plain stdout; it shows nothing. A Stop-hook notice is the planned replacement
- The auto-inject hook runs only on prompt submit: a crossing inside a long autonomous turn is advised at the next prompt, and idle compaction happens while no prompt arrives
- The per-launch `claude --autocompact` flag and any server-side auto-compact window are invisible to crusts; the settings files and environment it can read are covered
- Between a compaction and the first response after it, TOTAL is an estimate (see Compaction detection); the records after the first prompt (the prompt, a command's skill body) are not yet added to it

## Dependencies

Runtime: chalk 5.6.2, cli-table3 0.6.5, commander 14.0.3
Dev: @types/bun 1.3.11, @types/node 25.5.0, typescript 6.0.2
