# Changelog

All notable changes to claude-crusts are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 0.8.0 predate this changelog; their feature history is
summarised in the README and the GitHub release pages.

## [Unreleased]

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

[Unreleased]: https://github.com/Abinesh-L/claude-crusts/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/Abinesh-L/claude-crusts/releases/tag/v0.8.0
