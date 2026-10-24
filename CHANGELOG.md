# Changelog

All notable changes to claude-crusts are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 0.8.0 predate this changelog; their feature history is
summarised in the README and the GitHub release pages.

## [Unreleased]

## [0.8.2] - 2026-10-24

claude-crusts 0.8.2 reads more of what the session itself recorded, and
stops recommending things Claude Code ignores: a `.claudeignore`, a
status hook on an event that shows nothing, moving CLAUDE.md text into
CLAUDE.local.md, and treating healthy cache reads as waste.

### Fixed

- The System bucket uses the system prompt the session recorded. From
  Claude Code 2.1.268 a transcript carries a copy by default
  (`prompt_snapshot`; bare mode records none unless asked to). crusts
  derived the size as a residual, which also absorbed every under-estimate
  around the turn it was taken from. On 62 `/context` outputs recorded in
  the author's transcripts, the median gap to Claude Code's own
  system-prompt figure fell from 24.7K tokens to 59. Sessions without a
  copy still derive it.
- Estimates follow the model's tokenizer. Claude 4.7 and later models
  (every Fable and Mythos) count about 30% more tokens for the same text
  (Anthropic's token-counting docs), and crusts' text divisors were
  measured on the older tokenizer. Content estimates, CLAUDE.md, memory
  and skills now scale by 1.3 on those models, per model in a session that
  switched; exact API usage is never scaled. Against the same 62 outputs
  the median error for messages went from 3.3% to 2.9%, and the median
  scale that reconciliation applies from 1.11 to 1.06.
- Between a compaction and the first response after it, the window is
  estimated from Claude Code's `postTokens`, which is a chars/4 count of the
  summary and the files it re-attaches, so it is now scaled for the model's
  tokenizer. The estimate uses the same system prompt figure as the System
  bucket, and counts the re-attached files Claude Code has not recorded yet
  (they appear in Retrieved). Against the next request's exact size on 50
  compactions, the median error went from 9.9% to 6.2% (worst 34.7% to
  25.5%).
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` accepts `k` and `M` suffixes, as Claude
  Code does from 2.1.304. crusts ignored a value such as `200k`; a session
  from an older Claude Code, which read `200k` as its 100K floor, keeps
  that reading.
- `optimize --apply` no longer writes `.claudeignore`, a file Claude Code
  never reads. The fix, renamed `read-deny`, adds `Read(...)` deny rules for
  the noise paths the session read to the project's
  `.claude/settings.local.json`, so Claude Code refuses to read them (and to
  edit or write files there). The merge keeps every other setting and rule,
  never adds a rule twice, refuses a file that is not valid JSON, backs the
  file up and writes atomically. `node_modules`, `.git` and lock files are
  denied at any depth (`package-lock.json` and `pnpm-lock.yaml` are now
  detected). Since a deny rule also blocks editing, an output folder
  (`dist`, `build`, `.next`, `target`) gets a rule only for the folder that
  was read, spelled exactly as read, and only when git ignores it or tracks
  nothing in it: folders such as Go's `build/` or a Java package named
  `build` hold source. Reads outside the project no longer count, and each
  read is sized from its own result in the model's tokens. An existing
  `.claudeignore` can be deleted.
- `optimize` writes to the project the session ran in (the folder it
  started in), not the folder the shell is in, which could write the rules
  where they never applied. The CLAUDE.md "Files to avoid reading" section
  is offered only where the deny rules cannot apply: next to them it saved
  nothing and added tokens to every request.
- crusts reads a session's project settings, CLAUDE.md and MCP servers from
  the folder the session started in (its first record's `cwd`). It decoded
  the transcript folder's name instead, which fails for any project path
  with a hyphen, dot or space, so those projects' settings were not read.
- The cache waste rule flagged every healthy session: it fired when cache
  reads passed 60% of a session's input, and reads are the healthy case
  (about a tenth of the input price; 95-97% of input is normal). It now
  reports cache re-writes: requests that wrote most of an already-cached
  prompt again because the cache expired (5-minute or 1-hour TTL) or the
  model, system prompt, tools or earlier messages changed. Each API response
  counts once, and each agent's first request and the first request after a
  compaction are expected writes. The cause comes from the API's own
  diagnosis (`message.diagnostics.cache_miss_reason`, Claude Code 2.1.214+)
  or from the gap since that agent's previous request against the cache
  TTL, timed from the records written as each request is sent. The item
  says what happened, for example "12 cache re-writes after the cache
  expired (gaps over 1 h) re-wrote 1.4M tokens; the largest after a 3 h
  break at message #812", and names `promptCacheTtl` when it would help.
  On 15 of the author's sessions the old rule flagged all 15, five of them
  with no re-write at all; the new rule flags 9.
- Duplicate reads are range-aware. A Read covers the lines it delivered
  (Claude Code's recorded `startLine`/`numLines`, else the line numbers in
  the result), so paging through a file (lines 1-200, then 201-400) is no
  longer a duplicate, and an earlier read counts only for the lines a later
  read delivered again. Descriptions name the lines:
  `"app.ts" read 3 times (earlier reads at #2 lines 101-200 are redundant)`.
  Re-reads after an edit call (MultiEdit, NotebookEdit and failed calls
  included), the same lines with different text, images re-taken at the
  same path, and reads Claude Code answered with its "file unchanged" stub
  are not duplicates. An earlier read counts once 100 tokens or more of it
  came back, so the few lines where one page meets the next are never
  listed. When an earlier read also holds lines read only once, the item is
  no `/compact` target: "keep only latest read" would drop those lines. On
  the author's 19 transcripts (66 compaction windows) the rule flagged 187
  files and 440K tokens; it now flags 5 files and 3.0K tokens.
- Waste items after a compaction number messages as the timeline does
  (from the start of the session), so every item in one report uses the
  same numbering.
- Read sizes come from the call's own result. With parallel calls another
  call's record can come first (13% of Read calls), so duplicate and stale
  read sizes could come from the wrong record. The duplicate rule also
  stops at the analysed range, so `--until` no longer counts later re-reads.
- The status hook shows something. Up to 0.8.1, `hooks enable` installed
  `claude-crusts status` on Claude Code's `Notification` event, which
  discards a hook's output, so no notice ever appeared. It now installs
  `claude-crusts status --hook` on `Stop`, and after each response Claude
  Code shows one line: `CRUSTS: 62.4% (warming) | 45 msgs | 1 compaction`.
  Hook mode reads the payload on stdin (waiting at most 1 s), reports the
  session in `transcript_path`, stays silent when `stop_hook_active` is
  true or on any error, and never asks Claude to keep working. Claude Code
  runs the hook by name, so `hooks enable` first checks that the
  `claude-crusts` on your PATH is 0.8.2 or later and installs nothing
  otherwise, and `doctor` warns when an installed hook's command would
  fail. Run `claude-crusts hooks enable` once to move an existing install;
  `hooks status` and `doctor` flag the old entry.
- `hooks enable|disable` and `hooks auto-inject enable|disable` no longer
  destroy a settings.json that does not parse (a trailing comma, say); they
  rewrote it as the hooks block alone. They now leave such a file untouched,
  back up settings.json to `~/.claude-crusts/backups/` before every write
  (the newest 10 kept), and remove only crusts' own commands.
- `status` reads the session's own project settings, CLAUDE.md and memory,
  as `analyze` does. It read only the user-level files, so on sessions with
  no API usage yet it disagreed with `analyze` (11.4% against 14.4% on three
  of the author's sessions).
- CLAUDE.md advice. crusts said to move CLAUDE.md text into CLAUDE.local.md
  to save tokens, but Claude Code loads CLAUDE.local.md alongside CLAUDE.md,
  so the move saved nothing. The advice now follows Claude Code's memory
  docs: instructions that only matter for part of the codebase go into
  path-scoped rules (`.claude/rules/` files with `paths:`) or a CLAUDE.md in
  that folder, which load only when Claude works there. The size checked is
  that of the files the session recorded loading (2.1.268+), in the model's
  tokens, named one by one: a parent folder's CLAUDE.md, CLAUDE.local.md and
  imported files count, and the project's `.claude/settings.json`, which is
  never sent, no longer does. On the author's machine the old figure missed
  a parent folder's CLAUDE.md in every session of one project, and a 12K
  token imported AGENTS.md in another. Top 5 consumers and the advice show
  the same CLAUDE.md figure (if Claude Code re-sent a changed CLAUDE.md
  mid-session, Top 5 counts both copies the window holds), and `fix` gives
  the size note beside its blocks rather than inside the block meant for
  CLAUDE.md.
- Top 5 consumers sizes each file read from its own result: parallel reads
  were charged another call's result. The compaction summary is counted in
  the model's tokens, as its bucket counts it.
- A `/compact` suggestion no longer counts a large CLAUDE.md toward what it
  frees, and the CLAUDE.md item no longer takes one of its three target
  slots: Claude Code reads CLAUDE.md again after every compaction. This
  applies to `fix`, `optimize`, the recommendations and the auto-inject
  advisory.
- Waste reports no longer print "~0 tokens" next to the cache item.

### Added

- Session summaries that outlive transcripts. Claude Code deletes
  transcripts older than `cleanupPeriodDays` (30 days unless set), and
  crusts cannot analyze a session without one: on the author's machine 12
  of the 21 sessions that received advisories no longer have a transcript.
  The auto-inject hook now keeps a small summary per session in
  `~/.claude-crusts/sessions/<sessionId>.json` (schema v1): model, context
  window, auto-compact window and trigger, peak and last window size, every
  compaction Claude Code marked (time, trigger, idle, size before and after)
  and the advisories it gave. It is built from the analysis the hook
  already runs, written atomically, and rewritten only when something
  changed. `hooks auto-inject status` shows how many are kept and where.
- `doctor` checks transcript retention: it warns when
  `~/.claude/settings.json` has no `cleanupPeriodDays` or a value under 90,
  recommends 365, and says how many session summaries crusts keeps. It
  also warns on a value Claude Code rejects (not a whole number) and, when
  the newest transcripts come from a Claude Code older than 2.1.310, on a
  value large enough to have made background cleanup delete recent files
  there, such as pasted images (about 100 million days; ordinary long
  retention such as 3650 never was).
  `doctor` now reads a settings.json saved with a byte-order mark, as
  Claude Code does.

### Changed

- `wasteThresholds.cacheRewriteThreshold` (default 0.25, the share of a
  session's cache-write tokens that went to re-writes) replaces
  `cacheOverheadThreshold`, which is ignored; `--verbose` notes it.
  Re-writes under 50,000 tokens never produce an item.
- `optimize --filter` rejects an unknown fix kind with exit code 1 (it
  used to filter every fix out); `claudeignore` still selects `read-deny`.
  `--project-path` defaults to the folder the session started in.
- `doctor` runs 10 checks. Its Hook integration check warns when the old
  Notification status hook is still installed.
- JSON output: `breakdown.claudeMd` lists the CLAUDE.md files the session
  loads with their tokens, `derivedOverhead.recordedSystemPrompt` holds the
  recorded system prompt's size, the `read-deny` fix carries `denyRules`,
  and the oversized-CLAUDE.md waste item reads "CLAUDE.md files add ~N
  tokens to every request (...)". Waste items carry `compactable: false`
  when a `/compact` cannot act on them safely, the fix prompts carry
  `claudeMdNote`, and the analysis result carries `projectPath`.

### Known limits

- Bucket composition still uses text estimates, now scaled for the
  tokenizer; dense content (tool-name lists, JSON) still runs low. 2.1.300
  transcripts record every request exactly; exact composition is planned.
- Right after a compaction, crusts does not itemize some of the context
  Claude Code sends again (the skills listing, among others). The estimate
  counts the re-attached files twice to stand in for it, and the rows of a
  few such windows (4 of 48 right after `/compact` on the author's
  sessions) stay outside reconciliation's guard band, so they do not add up
  to TOTAL.
- The Stop status hook parses the whole transcript after each response:
  a fraction of a second on most sessions, about 1 second on a 186 MB
  transcript.
- Session summaries exist only where the auto-inject hook runs, start with
  this version, and miss a session's last response after its last prompt.
  The retention check reads `~/.claude/settings.json` only.
- The cache rule reads the session's own transcript. Claude Code writes
  subagents' requests to separate files (`<session>/subagents/`), which
  crusts does not read, so their re-writes are not counted.
- The auto-inject hook runs only when a prompt is submitted, so a window
  that crosses your threshold during a long turn is advised at the next
  prompt, and an idle compaction, which happens while no prompt arrives,
  gets no advisory first. The per-launch `claude --autocompact` flag is
  invisible to crusts.

## [0.8.1] - 2026-10-17

claude-crusts 0.8.1 fixes the context math and the auto-inject hook on
Claude Code 2.1.26x-2.1.302 sessions. Of the 23 advisories 0.8.0 logged on
the author's machine, 20 still have transcripts. Replayed, the 8 that fired
on a 7-18% window are now silent and the other 12 fire at the same numbers.

### Fixed

- Window size for current models: Claude Code's own table puts Fable,
  Sonnet 5 and later, Haiku 5.5 and Opus 4.7 and later at 1M with no
  `[1m]` variant, and Opus 4.6 and Sonnet 4.6 at 200K without it. crusts
  missed point releases (`claude-opus-5-5`, `claude-fable-5-1`) and held
  Opus 4.7 and 4.8 at 200K, so those sessions read about 5x hot and the
  hook fired at a real 16-18%. Model IDs now parse as family and version;
  `CLAUDE_CODE_DISABLE_1M_CONTEXT` holds every model at 200K.
- Window evidence across model switches: every run of the same model counts,
  and a recorded `/context` output is matched to the model it names. Before
  the first response, the model comes from Claude Code's own model record,
  so a new session no longer starts at the 200K default.
- Continued and compacted sessions: a continuation file repeats the previous
  conversation's last turns with zeroed usage, and an in-flight turn can land
  after the boundary. crusts read them as the live window. The System bucket
  absorbed a whole earlier conversation (807K inside a 117K window), and the
  first prompt after a compaction read 82-84%. Those records are now ignored,
  and once a new prompt follows the boundary every turn counts as live. The
  fixed Claude Code context is derived from the first turn whose window the
  file records, and capped by the smallest live window.
- Right after a compaction, before the first response, the window is
  estimated as Claude Code's `postTokens` plus the fixed context and
  re-attached files. `postTokens` leaves the fixed context out: the first
  live turn sat 45K-77K above it (median about 59K).
- Attachments are sized from the exact text Claude Code sent (`rendered`,
  2.1.268+); attachments it never sent cost nothing. The session's own
  CLAUDE.md and memory records (the latest full one plus the memory updates
  written on resume) replace the disk copies, so ancestor CLAUDE.md files
  count and a grown MEMORY.md does not. "Top consumers" uses the same
  figures.
- "Messages until auto-compaction" projects the window's growth since it
  started (since the last compaction, or the first turn) and waits for 4
  messages. Every compaction used to be followed by "~19 messages until
  auto-compaction, act soon" at 9%. The timeline footer prints the same
  projection and reads the live window, so compacted sessions no longer
  show "already past the auto-compact trigger" at 12%.
- The hook reads the session's project (CLAUDE.md, memory folder, project
  settings, MCP servers) from the transcript's project folder, so a `cd`
  into a subfolder keeps the project's settings.
- The default gate's margin scales with the auto-compact window: max(20K,
  10% of it). A 200K auto-compact window on a 1M model is advised from
  147K, not 67K. An explicit `threshold` that sits past the trigger falls
  back to the headroom gate instead of never firing.
- The 5-minute gap between advisories is kept per session, so two sessions
  side by side each get their own advisory.
- `/reset` and `/new` (aliases of `/clear`) no longer get an advisory.
- With auto-compaction off, the advisory and notice no longer say Claude
  Code will compact the session. Windows print as "1M", not "1,000K".
- The advisory's "Dominant categories" names the three largest buckets.
- `config.json` is written atomically and retried while another process
  reads it, and the log line is written first, so two sessions recording an
  injection at once cannot drop `enabled` and `threshold` or lose a log
  entry.

### Added

- Claude Code's compaction settings, read the way 2.1.302 reads them: the
  auto-compact window (`autoCompactWindow`, the per-model window
  `/autocompact` saves, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; 100K-1M),
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `autoCompactEnabled`,
  `DISABLE_AUTO_COMPACT` and `DISABLE_COMPACT`, and idle compaction
  (`idleCompaction`, `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`). User, project
  and local settings layer as in Claude Code, a per-model window matches the
  model's dated and provider IDs, and a settings `env` block wins over the
  shell. Predictions, the default gate and the advisory use the session's
  real trigger.
- Idle compaction (rolled out in stages from Claude Code 2.1.286, announced
  in 2.1.299): a 200K+ conversation on the one-hour cache that sits idle
  about 54 minutes can be compacted. `analyze` and the timeline warn when it
  applies, naming the `/compact` to run before a break, the advisory says
  so, and idle compactions are labelled from either of Claude Code's idle
  notices (2.1.289 recorded them as manual). Turn it off with
  `"idleCompaction": false` in settings.json, or the Idle compaction row in
  `/config` on 2.1.302+.
- The hook shows each advisory to you as a one-line notice
  (`systemMessage`), not only through Claude's reply. It skips `/compact`,
  `/clear`, slash-command echoes and interrupts.

### Changed

- A compaction's size after (`tokensAfter`) is the first live turn's window,
  not `postTokens`. Until that turn exists it is the estimate above, and the
  timeline marks it with `~`. `postTokens`, `firstLiveIndex` and `idle` are
  kept on the event.
- JSON output: `breakdown.compaction` holds the compaction model. In
  `derivedOverhead.internalSystemPrompt.derivation`,
  `firstAssistantInputTokens` is the anchor turn's input (the first turn
  whose whole window the transcript records), `knownFirstUserMessage`
  counts every recorded message before it, and `knownCarriedOver` and
  `anchorIndex` are new. `estimated_messages_until_compaction` is null
  until the window has 4 messages.
- Transcript parsing skips 2.1.300's per-request copies without parsing them.

### Known limits

- Bucket composition still uses chars/4 (text) and chars/3.3 (code)
  estimates; current models run about 2.5 chars per token on dense tool
  output, so estimated buckets read low before reconciliation scales them to
  the API total. 2.1.300 transcripts record every request exactly; exact
  composition is planned for 0.9.0.
- Between a compaction and the first response after it, the window is an
  estimate: within about -17% to +19% of the next request on real sessions,
  and about a third low at the first prompt of a continued session.
- The hook runs only when a prompt is submitted, so a window that crosses
  your threshold during a long turn is reported at the next prompt, and an
  idle compaction happens while no prompt arrives.
- The per-launch `claude --autocompact` flag is invisible to crusts.

## [0.8.0] - 2026-08-22

claude-crusts 0.8.0 catches up with Claude Code 2.1.1xx-2.1.239 session
files and fixes the accounting errors they caused.

### Fixed

- Correct totals: one API response split across several JSONL lines is now
  counted once per `message.id` group (it was over-counted 2.4x to 3.4x,
  with Tools and Retrieved inflated most). Resume replays are deduplicated
  by `uuid`, synthetic and API-error records are filtered on the fields
  Claude Code actually writes, and non-API `system` records (turn
  durations, away summaries, local commands) no longer count as messages.
- Correct window size: fable-5 and opus-5 sessions, the `[1m]` model in
  `settings.json`, the statusline payload's `context_window_size`, and
  pasted `/context` output all feed context-limit detection. A fresh 1M
  session no longer reads as 81% hot.
- Correct compaction math: auto-compaction is modelled as a 33K-token
  headroom buffer (83.5% of a 200K window, 96.7% of 1M) instead of a flat
  80%; the window total includes the last response's output tokens; and
  compaction events use Claude Code's own `postTokens` and trigger
  (auto/manual), with per-event context limits across model switches.
- System bucket restored: the fixed Claude Code context (system prompt,
  core tool schemas, memory, skills, hooks) is derived again instead of
  being discarded above the old 15K cap.
- `calibrate` parses the current `/context` markdown table (k/m suffixes,
  deferred rows, autocompact buffer, window size) as well as the legacy
  colon format, and pins the "System tools" row as a core-schema override.

### Added

- Attachment records (hook output, skill and tool listings, task
  reminders, nested CLAUDE.md, memory files, IDE context) are kept and
  classified into their CRUSTS categories.
- Non-human user records (task notifications, slash-command wrappers,
  skill bodies, interrupt stubs) are classified by what they are and no
  longer masquerade as your prompt.
- Tool catalogue rebuilt: PowerShell, Workflow, ScheduleWakeup and the
  other core tools are recognised by name; ToolSearch-loaded deferred
  tools are charged at their load point (about 1,000 tokens per built-in,
  330 per MCP tool) and tracked as loaded; MCP servers are discovered from
  `~/.claude.json`, installed plugins, and the session itself.
- Context-limit signal priority list with `--verbose` reporting: statusline
  payload, latest `/context` transcript record, `[1m]` model id,
  `settings.json` model on family match, usage above 200K, native-1M model
  table, then the 200K default.
- Buckets reconcile to the API window total and expose the raw classifier
  estimate as `contentTokens`; trend records carry a `bucketBasis` column
  (also in the CSV export).
- `claudeCodeVersion` captured per session and shown to the classifier for
  version-keyed core-schema costs.
- `autocompactBufferTokens` config override for the auto-compaction buffer.

### Changed

- Auto-inject advisory: same `[claude-crusts advisory]` prefix, but the
  default gate is headroom-based (it fires when the window is close to the
  real auto-compaction trigger) and the advisory text explains the 33K
  buffer correctly. An explicit `threshold` in config still behaves as
  before.
- `analyze` recommendations and `watch` predictions count messages against
  the buffer-based trigger instead of the flat 80% threshold.

### Removed

- Placeholder tool names (`Tool_30` to `Tool_40`) and the retired
  TodoRead/TodoWrite entries.
- The flat `COMPACTION_THRESHOLD` (0.80) constant, replaced by
  `AUTOCOMPACT_BUFFER_TOKENS`.
- The 1K-15K acceptance cap on the derived internal system prompt,
  replaced by a relative bound.

[Unreleased]: https://github.com/Abinesh-L/claude-crusts/compare/v0.8.2...HEAD
[0.8.2]: https://github.com/Abinesh-L/claude-crusts/releases/tag/v0.8.2
[0.8.1]: https://github.com/Abinesh-L/claude-crusts/releases/tag/v0.8.1
[0.8.0]: https://github.com/Abinesh-L/claude-crusts/releases/tag/v0.8.0
