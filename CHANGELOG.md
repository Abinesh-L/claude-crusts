# Changelog

All notable changes to claude-crusts are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 0.8.0 predate this changelog; their feature history is
summarised in the README and the GitHub release pages.

## [Unreleased]

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
