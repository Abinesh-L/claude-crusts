<p align="center">
  <img src="https://em-content.zobj.net/source/apple/391/bread_1f35e.png" width="120" alt="CRUSTS logo: a loaf of bread" />
</p>

<h1 align="center">CRUSTS</h1>

<p align="center">
  <strong>Your Claude Code context has crusts. CRUSTS trims them.</strong>
</p>

<p align="center">
  <em>Stale file reads, duplicate tool schemas, resolved exchanges nobody needs,<br/>
  oversized CLAUDE.md files, unused MCP servers — the crusts of your session.<br/>
  CRUSTS finds them, ranks them by token savings, and trims them for you.</em>
</p>

<p align="center">
  <a href="#the-fastest-way-to-start">Quickstart</a> ·
  <a href="#before--after">Before/After</a> ·
  <a href="#cli-commands">Commands</a> ·
  <a href="#why-crusts">Why</a> ·
  <a href="#the-crusts-framework">Framework</a>
</p>

<p align="center">
  <em>Fully offline. Zero API calls. Zero token cost.</em>
</p>

---

## Before / After

Same work session. Same files read, same tools loaded, same conversation. One `claude-crusts optimize --apply` + one `/compact focus "..."` command it generated.

<table>
<tr>
<td width="50%" valign="top">

### 🥖 Stale (before)

```
TOTAL:  143,507 / 200,000  (71.8%)
  Tools         86,460  (60%)
  Retrieved     35,996  (25%)
  Conversation   7,616   (5%)
  System         7,319   (5%)
  User           4,217   (3%)
  State          1,899   (1%)

"index.ts" read 9 times
"types.ts" read 6 times
36 of 40 tool schemas unused
Auto-compaction in ~12 msgs

Context health: HOT
```

</td>
<td width="50%" valign="top">

### 🍞 Fresh (after)

```
TOTAL:   92,108 / 200,000  (46.1%)
  Retrieved     33,801  (37%)
  Tools         18,204  (19%)
  Conversation   7,616   (8%)
  System         7,319   (8%)
  User           3,421   (4%)
  State          1,747   (2%)

No duplicate reads
Stale reads trimmed
Tool schemas pruned (.claudeignore)
Auto-compaction in ~180 msgs

Context health: HEALTHY
```

</td>
</tr>
</table>

**Same session. 51K tokens reclaimed. Same work. Fewer crusts.**

```
┌──────────────────────────────────────────────┐
│  CONTEXT FRESHNESS      ████████ CRISP       │
│  DUPLICATE FILE READS   ░░░░░░░░ PURGED      │
│  UNUSED TOOL SCHEMAS    ░░░░░░░░ REMOVED     │
│  SELF-HEALING HOOK      ████████ LIVE        │
│  OFFLINE / API-FREE     ████████ 100%        │
│  VIBES                  ████████ TOASTY      │
└──────────────────────────────────────────────┘
```

Three commands cover 90% of day-to-day use. You can stop reading right there if those do what you need — the rest of this README is the deep dive.

```bash
# 1. SELF-HEAL — install the hook. Your context silently self-heals from
#    now on: when usage crosses the threshold, CRUSTS injects a targeted
#    /compact focus advisory into Claude's next turn. Zero user action.
claude-crusts hooks auto-inject enable

# 2. ACTIVE FIX — write .claudeignore + CLAUDE.md rules for you.
#    Atomic backups under ~/.claude-crusts/backups/, per-fix confirmation.
claude-crusts optimize --apply

# 3. TUI — the REPL shell where every other command lives.
#    This is the recommended day-to-day entry point. No flags to memorise.
claude-crusts tui
```

> **Start with the TUI.** It's the smoothest way to use CRUSTS — an
> interactive shell with tab completion, clipboard copy for fix blocks,
> and every analysis / management command in one place. Everything below
> is for scripting, CI, and power-user flows.

---

**What CRUSTS does.** Slices your Claude Code context window into 6 categories — **C**onversation, **R**etrieved, **U**ser, **S**ystem, **T**ools, **S**tate/memory — finds the crusts (what's gone stale or never got used), and trims them for you.

```
╔════════════════════════════════════════════════════════════════╗
║  CRUSTS Context Window Analysis                                ║
║  Session: a1b2c3d4 | Model: claude-sonnet-4-6                  ║
║  Messages: 426                                                 ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║  C  Conversation        7,616 tkns   (5.3%)  █░░░░░░░░░░░░░░░░ ║
║  R  Retrieved          35,996 tkns  (25.1%)  ████░░░░░░░░░░░░░ ║
║  U  User Input          4,217 tkns   (2.9%)  █░░░░░░░░░░░░░░░░ ║
║  S  System              7,319 tkns   (5.1%)  █░░░░░░░░░░░░░░░░ ║
║  T  Tools              86,460 tkns  (60.3%)  ██████████░░░░░░░ ║
║  S  State/Memory        1,899 tkns   (1.3%)  █░░░░░░░░░░░░░░░░ ║
║  ──────────────────────────────────────────────────────────────║
║  TOTAL: 143,507 / 200,000 tokens (71.8%)                       ║
║  FREE:  56,493 tokens                                          ║
║                                                                ║
║  WASTE DETECTED:                                               ║
║     "index.ts" read 9 times -- est. ~9,897 tokens              ║
║     "types.ts" read 6 times -- est. ~5,972 tokens              ║
║     ... and 6 more                                             ║
║                                                                ║
║  RECOMMENDATIONS:                                              ║
║     /compact to remove duplicate reads                         ║
║     Review loaded tools -- 36 of 40 were never used            ║
║     Messages until auto-compaction: ~48                        ║
║                                                                ║
║  Context health: HOT                                           ║
╚════════════════════════════════════════════════════════════════╝
```

Fully offline. Zero API calls. Zero token cost.

**Core capabilities:**
- **Self-healing context** — `hooks auto-inject enable` installs a hook that injects a session-specific `/compact focus` into Claude's next turn when you cross the configured threshold. No copy-paste, no user action.
- **Active optimization** — `optimize --apply` writes `.claudeignore` and CLAUDE.md rules for you, with confirmation prompts and backups under `~/.claude-crusts/backups/`.
- **6-category context breakdown** — Conversation, Retrieved, User, System, Tools, State/Memory. See exactly where your tokens are going.
- **Waste detection** — duplicate file reads, unused tool schemas, stale content, resolved exchanges, cache overhead, unused tool results.
- **Past-session analysis** — Claude Code forgets everything when you exit. The JSONL logs don't. Analyze any session from days or weeks ago.
- **Cross-session trends** — sparklines, direction (improving / worsening / flat), recent-session table.
- **Interactive TUI** — `claude-crusts tui` drops you into a REPL shell with tab completion for commands and session IDs.
- **Reports** — standalone HTML/Markdown reports you can screenshot or share.
- **Other:** cross-session comparison, calibration against `/context`, install sanity check (`doctor`), intra-session diff, per-model usage snapshot (`models`), statusline glyph integration, per-MCP-server token accounting, CSV trend export, configurable waste thresholds, `/compact` measurement harness (`bench compact` / `bench compare`).

## Table of Contents

**Get started**
- [The fastest way to start](#the-fastest-way-to-start) — drop into the TUI
- [Installation](#installation) — `npx`, `npm`, `bun`
- [Quick Start](#quick-start) — every command in one glance
- [Use inside Claude Code](#use-inside-claude-code) — `/crusts` slash command

**CLI reference** (all 23 commands)
- Interactive: [`tui`](#claude-crusts-tui-session-id)
- Analysis: [`analyze`](#claude-crusts-analyze-session-id) · [`waste`](#claude-crusts-waste-session-id) · [`fix`](#claude-crusts-fix-session-id) · [`optimize`](#claude-crusts-optimize-session-id) · [`models`](#claude-crusts-models-session-id) · [`timeline`](#claude-crusts-timeline-session-id) · [`lost`](#claude-crusts-lost-session-id) · [`diff`](#claude-crusts-diff-session-id---from-n---to-n) · [`compare`](#claude-crusts-compare-session-a-session-b) · [`trend`](#claude-crusts-trend) · [`status`](#claude-crusts-status-session-id)
- Live: [`watch`](#claude-crusts-watch-session-id) · [`report`](#claude-crusts-report-session-id) · [`list`](#claude-crusts-list)
- Self-healing + active fix: [`hooks auto-inject`](#claude-crusts-hooks-auto-inject-enabledisablestatus) · [`optimize --apply`](#claude-crusts-optimize-session-id)
- Claude Code integration: [`hooks`](#claude-crusts-hooks-enabledisablestatus) · [`statusline`](#claude-crusts-statusline-installuninstallstatus) · [`calibrate`](#claude-crusts-calibrate)
- Install management: [`doctor`](#claude-crusts-doctor)
- Measurement harness: [`bench compact`](#claude-crusts-bench-compact-session-id) · [`bench compare`](#claude-crusts-bench-compare-ajson-bjson) · [`bench reextract`](#claude-crusts-bench-reextract-resultjson)
- Config: [Customising waste thresholds](#customising-waste-thresholds)

**Under the hood**
- [The CRUSTS framework](#the-crusts-framework) — what the 6 categories mean
- [How it works](#how-it-works) — offline parsing, derived overhead, token estimation
- [What the Claude Code leak revealed](#what-the-claude-code-leak-revealed) — the architectural insights CRUSTS uses
- [CRUSTS vs `/context`](#crusts-vs-context) — when to use which
- [Why CRUSTS?](#why-crusts) — the questions behind the number
- [Recommendations in action](#recommendations-in-action) — example outputs
- [Accuracy and limitations](#accuracy-and-limitations) — what's exact vs estimated

**Meta**
- [Contributing](#contributing) · [Feedback](#feedback) · [License](#license)

## The Fastest Way to Start

If you're new to CRUSTS, skip the flag-heavy CLI and just run:

```bash
claude-crusts tui
```

This drops you into an interactive shell that:
- Auto-selects your most recent Claude Code session
- Tab-completes both commands and session IDs
- Runs every analysis / management command by name — no flags to remember
- Copies fix blocks to your clipboard with `copy 1|2|3`
- Type `help` for the full command list, `quit` to exit

**Once you're inside, here's everything you can type:**

```
  CRUSTS Interactive Shell
  Type a command, or "help" for a list of commands.

  ID        Age   Size     Project
  a1b2c3d4  2m    1.2 MB   my-project
  e5f6a7b8  1h    856 KB   another-project
  ...

  Auto-selected most recent session: a1b2c3d4 (my-project)
  Use "select <id>" to switch, or type a command.

crusts:a1b2c3d4> analyze                  # full 6-category breakdown
crusts:a1b2c3d4> waste                    # waste detection report
crusts:a1b2c3d4> fix                      # pasteable fix prompts
  Tip: use "copy 1", "copy 2", or "copy 3" to copy a block to clipboard.

crusts:a1b2c3d4> copy 2                   # copy CLAUDE.md snippet to clipboard
  Copied CLAUDE.md snippet to clipboard.

crusts:a1b2c3d4> optimize                 # ranked fixes with ROI (dry-run)
crusts:a1b2c3d4> models                   # per-model usage snapshot
crusts:a1b2c3d4> timeline                 # message-by-message growth
crusts:a1b2c3d4> diff 40 120              # intra-session delta
crusts:a1b2c3d4> lost                     # what was lost in compaction
crusts:a1b2c3d4> status                   # one-line health check
crusts:a1b2c3d4> compare e5f6a7b8         # compare with another session
crusts:a1b2c3d4> doctor                   # sanity-check the install
crusts:a1b2c3d4> hooks status             # hook install state
crusts:a1b2c3d4> auto-inject status       # self-healing state
crusts:a1b2c3d4> bench compare a.json b.json
crusts:a1b2c3d4> bench reextract blind.json
crusts:a1b2c3d4> trend                    # cross-session trends
crusts:a1b2c3d4> list                     # show all sessions
crusts:a1b2c3d4> select e5f6              # Tab completes session IDs
crusts:a1b2c3d4> help                     # show available commands
crusts:a1b2c3d4> quit                     # exit
```

**CLI-only commands** (don't fit the REPL model): `optimize --apply` (spawns its own readline confirmation dialog), `bench compact` (blocks for minutes tailing a JSONL), `watch`, `calibrate`, `report`. Run those from a separate shell.

The rest of this README documents the standalone CLI for scripting, CI, and advanced use. But for day-to-day use, `tui` is the recommended entry point.

## Installation

```bash
# Run directly without installing
npx claude-crusts analyze

# Or install globally
npm install -g claude-crusts

# With bun
bunx claude-crusts analyze
bun install -g claude-crusts
```

### Shell completion (optional)

Tab-completes subcommands and session IDs at your prompt. One-time install, per shell:

```bash
# bash
claude-crusts completion bash >> ~/.bashrc && source ~/.bashrc

# zsh
claude-crusts completion zsh  >> ~/.zshrc  && source ~/.zshrc
```

```powershell
# PowerShell — append to $PROFILE to persist across sessions
claude-crusts completion pwsh >> $PROFILE
. $PROFILE
```

After installing: `claude-crusts an<TAB>` → `analyze`, `claude-crusts analyze 9b2<TAB>` → expands to the full session ID.

## Quick Start

Start with the TUI — the other commands are here for scripting, CI, and power users.

```bash
# Friction reducers (install once, benefit every session):
claude-crusts hooks auto-inject enable        # self-healing context
claude-crusts optimize --apply                 # writes .claudeignore + CLAUDE.md
claude-crusts statusline install               # ambient health glyph

# Day-to-day:
claude-crusts tui                              # interactive shell (recommended)
claude-crusts analyze                          # 6-category breakdown
claude-crusts waste                            # waste detection report
claude-crusts status                           # one-line health check

# Analysis & forensics:
claude-crusts fix                              # pasteable fix prompts
claude-crusts timeline                         # message-by-message growth
claude-crusts lost                             # what was lost in compaction
claude-crusts diff --from 40 --to 120          # intra-session delta
claude-crusts models                           # per-model usage snapshot
claude-crusts compare <a> <b>                  # side-by-side session diff
claude-crusts trend                            # cross-session trends
claude-crusts watch                            # live-monitor a running session
claude-crusts report                           # standalone HTML or Markdown report
claude-crusts calibrate                        # ground-truth against /context

# Measurement (for A/B experiments around /compact):
claude-crusts bench compact                    # tail JSONL, capture before/after
claude-crusts bench compare a.json b.json      # diff two bench results

# Management:
claude-crusts doctor                           # install sanity check (9 checks)
claude-crusts hooks enable                     # one-line health after every response
```

## Use Inside Claude Code

The easiest way to use CRUSTS — type this inside any Claude Code session:

```
/crusts
```

That's it. Claude Code runs the analysis and tells you what to do — which files to stop re-reading, whether to `/compact` now or wait, and the exact command to paste. No copy-paste, no switching terminals.

This works automatically when you clone or install claude-crusts, because the slash command lives at `.claude/commands/crusts.md` in the repo.

**Two ways to use CRUSTS — they complement each other:**

| | `/crusts` inside Claude Code | CLI / TUI in a separate terminal |
|--|--|--|
| **Best for** | Quick check + immediate action | Deep analysis, monitoring, forensics |
| **Token cost** | Uses some context tokens for Claude to process the JSON | Zero — doesn't touch your session |
| **Features** | Analyze + actionable advice | All 20+ commands: tui, analyze, waste, fix, optimize (+apply), models, doctor, diff, compare, timeline, lost, watch, trend, report, calibrate, bench, hooks, hooks auto-inject, statusline, status |
| **When to use** | Mid-session: "should I compact?" | Separate terminal: detailed views, live monitoring, past session forensics |

Use `/crusts` when you want a quick answer without leaving your session. Use the CLI when you want the full picture without spending tokens on it.

## CLI Commands

### `claude-crusts tui [session-id]`

Interactive REPL shell. Browse sessions, run analysis commands, switch sessions, and compare — all without leaving the app. Features Tab completion for both commands and session IDs, plus clipboard copy for fix blocks.

```bash
claude-crusts tui                    # launch, auto-selects latest session
claude-crusts tui a1b2c3d4           # launch with a specific session pre-selected
```

**See [The Fastest Way to Start](#the-fastest-way-to-start) at the top for the full walkthrough of every command you can type inside the shell.** Below are the details that don't belong in a quickstart:

**Tab completion** works for both commands and session IDs. Type `sel` + Tab to complete `select`, then type the first few characters of a session ID and press Tab to auto-fill it. Works with `select` and `compare` commands.

**Clipboard copy** lets you quickly grab fix blocks after running `fix`. Each block is numbered — use `copy 1` (session prompt), `copy 2` (CLAUDE.md snippet), or `copy 3` (/compact command). Works on Windows (`clip`), macOS (`pbcopy`), and Linux (`xclip`/`xsel`).

### `claude-crusts analyze [session-id]`

Full CRUSTS breakdown of a session. Shows token counts per category, waste detection, and actionable recommendations.

```bash
claude-crusts analyze              # most recent session
claude-crusts analyze a1b2c3d4     # by session ID prefix
claude-crusts analyze --json       # machine-readable output
```

If no session ID is provided, analyzes the most recent session.

### `claude-crusts waste [session-id]`

Deep dive into waste detection. Groups issues by severity and shows estimated reclaimable tokens.

```bash
claude-crusts waste
claude-crusts waste e5f6a7b8       # any past session
```

```
── WASTE DETECTED ──

[MEDIUM] "index.ts" read 9 times (earlier reads at #3, #45, #67, #89,
         #102, #145, #201, #267 are redundant) ~9,897 tkns
  → This file is already in context from msg #267. Tell Claude:
    "In index.ts that you already read, fix the bug"

[MEDIUM] "types.ts" read 6 times (earlier reads are redundant) ~5,972 tkns
  → Avoid re-reading files that haven't changed.

── RECOMMENDATIONS ──

P2 /compact focus on the renderer.ts, classifier.ts, types.ts changes
   Estimated savings: ~11,159 tokens

P3 Top 5 context consumers:
   1. index.ts (read 9x) — 9,897 tokens in duplicates
   2. Tool schemas (40 loaded, 4 used) — ~9,055 tokens
   3. types.ts (read 6x) — 5,972 tokens in duplicates
   4. System prompt (CLAUDE.md + internal) — 6,298 tokens
   5. classifier.ts (read 6x) — 4,659 tokens in duplicates

P5 3 compactions this session — use /clear between distinct tasks
```

Detects:
- **Duplicate file reads** — which files, how many times, which messages, estimated wasted tokens
- **Unused tools** — how many of 40 built-in tools were actually invoked vs loaded
- **Cache overhead** — what percentage of your input is re-reading the same cached content every message
- **Oversized system prompt** — when CLAUDE.md is large enough to consider splitting
- **Compaction patterns** — how often you're hitting auto-compaction and what to do about it

### `claude-crusts fix [session-id]`

The headline feature. Generates three pasteable text blocks — one for your current session, one for your CLAUDE.md, and one /compact command — all tailored to your session's actual waste patterns. No LLM involved.

```bash
claude-crusts fix                  # fix for most recent session
claude-crusts fix e5f6a7b8         # fix for any past session
```

```
CRUSTS Fix — Session a1b2c3d4

1. Paste this into your current Claude Code session:

┌────────────────────────────────────────────────────────────────┐
│ Important: these files are already in your context from        │
│ earlier reads. Do NOT re-read them. Reference your earlier     │
│ reads instead:                                                 │
│ - renderer.ts (already read, at messages #5, #160, #180)       │
│ - classifier.ts (already read, at messages #4, #38, #41, #46)  │
│ - recommender.ts (already read, at messages #149, #210)        │
│                                                                │
│ If you need to check something in these files, say "based on   │
│ [filename] that you already read" instead of reading the file  │
│ again.                                                         │
└────────────────────────────────────────────────────────────────┘

2. Add this to your CLAUDE.md for future sessions:

┌────────────────────────────────────────────────────────────────┐
│ ## Key Project Files                                           │
│ These files are frequently referenced. Read each once at the   │
│ start of a session, then reference from memory:                │
│ - renderer.ts: [describe what this file does]                  │
│ - classifier.ts: [describe what this file does]                │
│ - recommender.ts: [describe what this file does]               │
│                                                                │
│ ## Session Management                                          │
│ - Keep sessions under 200 messages when possible               │
│ - Use /clear between distinct tasks                            │
│ - Run /compact proactively at 60% context usage                │
└────────────────────────────────────────────────────────────────┘

3. Run this command now:

┌────────────────────────────────────────────────────────────────┐
│ /compact focus on the renderer.ts, classifier.ts, types.ts     │
│ changes                                                        │
└────────────────────────────────────────────────────────────────┘
```

Every output is generated from your session data — different sessions produce different files, different urgency levels, and different CLAUDE.md advice.

### `claude-crusts optimize [session-id]`

Closes the last-mile friction of `fix`. Instead of three generic blocks to copy-paste, `optimize` generates a **ranked list of fixes with token-savings ROI**, and the safe ones can be applied directly with `--apply` (backed up to `~/.claude-crusts/backups/`).

```bash
claude-crusts optimize                           # dry-run, ranked report
claude-crusts optimize --apply                   # apply with per-fix confirmation
claude-crusts optimize --apply --yes             # apply without prompting (use with care)
claude-crusts optimize --min-savings 500         # hide fixes below 500 tokens
claude-crusts optimize --filter claudeignore,compact-focus
```

```
CRUSTS Optimize — session a1b2c3d4
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total saveable: 12,400 tokens (6.2% of window)

1. ▶ [-4,200 tkns] Session-specific /compact command
   Targets the top waste items in this session rather than a generic compact.
   /compact focus "keep only latest read of renderer.ts; drop resolved exchange at #42-48"

2. ⚙ [-3,100 tkns] Add 2 noise pattern(s) to .claudeignore
   node_modules — 4 file(s), ~2,100 tokens
   dist — 2 file(s), ~1,000 tokens
   node_modules/
   dist/
   Target: /your/project/.claudeignore

3. ⦿ [ info ]    1 MCP server(s) loaded but never invoked
   Unused in this session: gmail
```

**Fix categories:**

| Kind | Auto-apply | What it does |
|------|:----------:|-------------|
| `compact-focus` | copy to clipboard | Generates a `/compact focus "..."` tuned to your session's exact waste |
| `claudeignore` | ✅ append | Adds noise patterns (`node_modules/`, `dist/`, `*.lock`, etc.) to `.claudeignore` |
| `claudemd-rule` | ✅ append | Adds a "Files to avoid reading" rule block to your `CLAUDE.md` |
| `mcp-disable` | copy to clipboard | Flags MCP servers loaded but never invoked this session |
| `claudemd-oversized` | warn only | Flags a `CLAUDE.md` above the recommended 1,500-token budget |

**Safety guarantees:**
- `--apply` is opt-in; dry-run is the default.
- Every file modification is **backed up** to `~/.claude-crusts/backups/<file>.<timestamp>.bak` before writing.
- Every fix requires per-fix confirmation unless `--yes` is passed.
- No fix ever touches Claude Code's live session state directly.

### `claude-crusts models [session-id]`

Per-session model usage snapshot. Shows every model Claude Code used in the session, in chronological order, with per-segment message counts and token totals. When you switch models mid-session (e.g. sonnet → opus → sonnet), CRUSTS keeps the full flow rather than fixating on the first or last model.

```bash
claude-crusts models                     # current session
claude-crusts models 841f980f            # specific session
claude-crusts models 841f980f --json     # machine-readable
```

```
  Model history — session 841f980f
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Current : claude-opus-4-7  (switched 2 times)

  ┌───┬───────────────────┬──────┬────────┬────────┬─────────┬─────────┬──────────────────┐
  │ # │ Model             │ Msgs │  Input │ Output │ Cache R │ Cache W │ First → Last msg │
  ├───┼───────────────────┼──────┼────────┼────────┼─────────┼─────────┼──────────────────┤
  │ 1 │ claude-sonnet-4-6 │   42 │  8,520 │  3,100 │ 124,000 │   1,200 │ #3 → #184        │
  │ 2 │ claude-opus-4-7   │   18 │  4,700 │  2,800 │  83,000 │     600 │ #186 → #245      │
  │ 3 │ claude-sonnet-4-6 │   12 │  3,200 │  1,100 │  48,000 │     400 │ #247 → #289      │
  └───┴───────────────────┴──────┴────────┴────────┴─────────┴─────────┴──────────────────┘
  Totals: 72 assistant turns, 16,420 input + 7,000 output tokens across 3 segments.
```

When the session used a single model, the table still prints — just one row — so the command's output is always honest: you ran it, and these are the models that were used.

The `analyze` header gets a `(switched from claude-sonnet-4-6)` hint whenever the session switched, so you don't have to run `models` just to notice.

### `claude-crusts doctor`

Sanity-check your install. Runs 9 checks — Claude Code install, settings.json validity, session discovery, hook/statusline presence, calibration data, trend history, backup dir writability — and reports a `pass | warn | fail` verdict.

```bash
claude-crusts doctor
```

```
  CRUSTS Doctor
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓ pass  claude-crusts version         0.7.0
  ✓ pass  Claude Code install           Found ~/.claude
  ✓ pass  Session discovery             Found 12 session(s)
  ✓ pass  Hook integration              CRUSTS hook installed
  ✓ pass  Statusline integration        CRUSTS statusline installed
  ! warn  Calibration data              No calibration saved.
  ✓ pass  Trend history                 42 record(s), 12,276 bytes
  ✓ pass  Optimize backup dir           writable
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Finished with warnings.
```

Exits non-zero on `fail`, so it's safe to wire into CI or a shell rc.

### `claude-crusts timeline [session-id]`

Message-by-message view of how your context grew over the session, including compaction boundaries with exact token counts.

```bash
claude-crusts timeline
claude-crusts timeline --json
```

### `claude-crusts lost [session-id]`

**The feature nobody else offers.** When Claude Code auto-compacts, it silently drops context. `/context` doesn't tell you what was lost. `ccusage` doesn't either. CRUSTS does.

For each compaction event, `lost` reconstructs what existed before and what survived in the summary, then reports what disappeared:

```bash
claude-crusts lost                     # most recent session
claude-crusts lost a1b2c3d4            # specific session
claude-crusts lost --json              # machine-readable output
```

```
╔══════════════════════════════════════════════════════════════════╗
║  What Was Lost in Compaction                                     ║
║  Session: 841f980f | 5 compaction event(s)                       ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  Compaction #1 (at message #420)                                 ║
║  167,040 -> 31,069 tokens (-135,971 dropped)                     ║
║  ──────────────────────────────────────────────────────────────  ║
║  File Reads (2) -- ~2,311 tokens                                 ║
║    File read: PROJECT_BRIEF.md                         ~2,180 #15║
║    File read: CLAUDE_MD.md                               ~131 #14║
║  ──────────────────────────────────────────────────────────────  ║
║  Total: 44,596 tokens lost out of 851,734 pre-compaction (5.2%)  ║
╚══════════════════════════════════════════════════════════════════╝
```

Lost content is categorized into:
- **Lost file reads** — files that were in context but aren't mentioned in the compaction summary
- **Lost conversations** — user/assistant exchanges that disappeared
- **Lost tool results** — tool outputs that were consumed but dropped
- **Lost instructions** — system-level content or user instructions that vanished

### `claude-crusts watch [session-id]`

Live-monitor a Claude Code session as it runs. The terminal updates in real-time as the JSONL file grows — useful for learning how context fills up, debugging waste, and knowing when compaction is about to hit.

```bash
claude-crusts watch                    # watch the most recent session
claude-crusts watch a1b2c3d4           # watch a specific session
claude-crusts watch --interval 1000    # faster polling (1s)
claude-crusts watch --json             # newline-delimited JSON output
```

Shows a compact single-screen dashboard with usage bar, category percentages, waste count, compaction prediction, and last message preview. When a compaction fires during the watch, a highlighted line appears inside the dashboard showing the token drop and how long ago it happened. Press Ctrl+C for a summary of what happened during the watch.

### `claude-crusts list`

Shows all discovered sessions with age, size, and project name. Works across all projects on your machine.

```bash
claude-crusts list
claude-crusts list --project myapp   # filter by project name
```

### `claude-crusts compare <session-a> <session-b>`

Side-by-side comparison of two sessions. Shows per-category token deltas, waste and compaction differences, and auto-generated insights about what changed.

```bash
claude-crusts compare a1b2c3d4 e5f6a7b8
claude-crusts compare a1b2c3d4 e5f6a7b8 --json
```

Insights are rule-based (no LLM): flags tool overhead differences >15%, conversation growth >10%, waste count ratios, compaction mismatches, and overall usage gaps >20%.

### `claude-crusts report [session-id]`

Generate a standalone report file — ready to screenshot, share with teammates, or open in VS Code preview.

```bash
claude-crusts report                              # most recent session (HTML)
claude-crusts report a1b2c3d4                     # specific session
claude-crusts report a1b2c3d4 --format md         # markdown report
claude-crusts report a1b2c3d4 --compare e5f6a7b8  # comparison report
claude-crusts report a1b2c3d4 --compare e5f6a7b8 --format md
claude-crusts report --output my-report.html      # custom output path
```

Supports two formats via `--format`:
- **html** (default) — dark theme, stacked bar chart, copy buttons for fix prompts, no external dependencies
- **md** — standard markdown tables, fenced code blocks, renders in VS Code preview and on GitHub

Default output: `./crusts-report-{prefix}.html` or `./crusts-report-{prefix}.md`.

### `claude-crusts calibrate`

Cross-reference CRUSTS estimates against Claude Code's `/context` output for ground truth comparison. Run `/context` in Claude Code, then paste the output into `claude-crusts calibrate`.

```bash
claude-crusts calibrate
# Then paste your /context output and press Enter twice
```

Also flags stale built-in tool baselines: if Claude Code adds or removes built-in tools, `calibrate` will warn when CRUSTS's internal tool-schema constant drifts more than 5% from `/context`'s reported "System tools" total.

### `claude-crusts trend`

Track how your context usage changes across sessions. Shows a sparkline, per-session averages, direction (improving/worsening/flat), and recent session history. Records are saved automatically each time you run `analyze`.

```bash
claude-crusts trend                              # all sessions
claude-crusts trend --project myapp              # filter by project
claude-crusts trend --limit 10                   # last 10 sessions
claude-crusts trend --json                       # machine-readable
claude-crusts trend --format csv                 # export as CSV to stdout
claude-crusts trend --format csv --output t.csv  # export to a file
```

History is stored at `~/.claude-crusts/history.jsonl` (append-only, deduped by session ID). CSV export is useful for spreadsheet-based analysis — 11 columns including `contextLimit` (blank for pre-v0.6.0 records).

### `claude-crusts diff [session-id] --from <n> --to <n>`

Diff two points within the **same** session. Unlike `compare` (which diffs two different sessions), `diff` shows per-category deltas between two message cutpoints of one session — useful for "which part of my session blew up my context?"

```bash
claude-crusts diff --from 40 --to 120
claude-crusts diff a1b2c3d4 --from 100 --to 300 --json
```

Output is a coloured cli-table with green/yellow highlights for negative/positive deltas. Indices are clamped to the session length; `--from` must be less than `--to`.

### Customising waste thresholds

All waste thresholds (stale-read window, oversized-system limit, cache-overhead ratio, resolution lookback, CLAUDE.md-oversized threshold) can be overridden via `~/.claude-crusts/config.json`:

```json
{
  "wasteThresholds": {
    "staleReadThreshold": 30,
    "oversizedSystemThreshold": 2500,
    "cacheOverheadThreshold": 0.5,
    "resolutionLookback": 15,
    "claudeMdOversizedThreshold": 2000
  }
}
```

Run any analysis with `--verbose` to see which overrides are active. Missing or invalid values fall through to defaults; sibling config keys (hooks, auto-inject state) are preserved by the merge-safe writer.

### `claude-crusts status [session-id]`

One-line context health summary. Fast path — classify only, no waste detection or recommendations. Used by hooks but also useful standalone.

```bash
claude-crusts status
# CRUSTS: 62.4% (warming) | 45 msgs | 1 compaction
```

### `claude-crusts hooks enable|disable|status`

Opt-in Claude Code hook integration. When enabled, `claude-crusts status` runs automatically after each Claude Code response, showing a one-line context health indicator.

```bash
claude-crusts hooks enable           # install hook in ~/.claude/settings.json
claude-crusts hooks disable          # remove hook (other hooks untouched)
claude-crusts hooks status           # check if enabled
```

Not everyone wants context info after every response — this is strictly opt-in.

### `claude-crusts hooks auto-inject enable|disable|status`

**Your context self-heals.** When enabled, crusts installs a `UserPromptSubmit` hook on Claude Code. Before every user prompt, crusts silently analyses the session; if usage has crossed the configured threshold (default 70%) and the last injection was more than `minGapMs` ago (default 5 min), it prepends a targeted advisory to Claude's context — including a `/compact focus "..."` tuned to the top waste items in **this** session.

Claude reads the advisory as part of the turn and can act on it immediately — no copy-paste, no terminal switching, no user action.

```bash
claude-crusts hooks auto-inject enable       # opt in, installs UserPromptSubmit hook
claude-crusts hooks auto-inject disable      # opt out, removes the hook
claude-crusts hooks auto-inject status       # show install + enabled + last-injection-at state
```

Tune via `~/.claude-crusts/config.json`:

```json
{
  "autoInject": {
    "enabled": true,
    "threshold": 70,
    "minGapMs": 300000
  }
}
```

**Safety guarantees:**
- Opt-in. Disabled by default.
- Fire-and-forget. Any error in crusts is swallowed so the hook can never block your prompt.
- Per-session min-gap prevents spam on long sessions.
- Only emits when the threshold is crossed — quiet on healthy sessions.

### `claude-crusts statusline install|uninstall|status`

Ambient one-character context-health glyph in Claude Code's statusline. When installed, a colored `●` + percentage (e.g. `● 42%`) renders in the statusline on every refresh — green < 50%, yellow < 70%, red < 85%, bright-red ≥ 85%.

```bash
claude-crusts statusline install     # add statusLine entry to ~/.claude/settings.json
claude-crusts statusline uninstall   # remove CRUSTS entry (safely; won't clobber other configs)
claude-crusts statusline status      # check if installed
```

Install refuses to overwrite an existing `statusLine` configured by something else. The runtime command itself (`claude-crusts statusline`) reads Claude Code's JSON payload from stdin and swallows all errors — a broken statusline never blocks Claude Code.

### `claude-crusts bench compact [session-id]`

Measurement harness for `/compact` events. Runs a before snapshot, tails the session JSONL for a `compact_boundary` record, then captures the after snapshot the moment Claude Code finishes its summarization — no interactive paste-and-press-Enter pause.

```bash
claude-crusts bench compact                                   # latest session
claude-crusts bench compact 841f980f                          # specific session
claude-crusts bench compact 841f980f --focus "drop stale read of types.ts"
claude-crusts bench compact --output blind.json --timeout 600
```

With `--focus`, the generated `/compact focus "<string>"` is copied to your clipboard before the tail loop starts — you paste it in Claude Code, bench captures the result. Exit codes: `0` on compaction, `2` on timeout, `1` on error.

Output JSON includes before/after token counts, waste counts, compaction counts, and — crucially — `summaryFileRefs`: the list of file paths mentioned in the compact summary. This is the A/B payload: under a focused compact, these are the files you preserved; under a blind compact, these are the files Claude Code's summarizer chose for you.

### `claude-crusts bench compare <a.json> <b.json>`

Diff two bench-compact result files. Produces `onlyInA` / `onlyInB` / `inBoth` sets over the summary file-ref lists, plus side-by-side token metrics.

```bash
claude-crusts bench compare blind.json focused.json --label-a blind --label-b focused
```

```
  CRUSTS bench compare
  ════════════════════════════════════════════════════════════
  Token metrics
  BEFORE  A=180,000 tkns (90.0%)  |  B=175,000 tkns (87.5%)
  AFTER   A=25,000 tkns (12.5%)   |  B=20,000 tkns (10.0%)

  Summary survivor diff
  In both       : 2   common.ts, src/hooks.ts
  Only in A     : 1   tests/foo.test.ts
  Only in B     : 3   src/calibrator.ts, src/watcher.ts, tests/bar.test.ts

  Insights
  · focused summary mentioned 2 more file path(s) than blind (5 vs 3).
  · 3 file(s) referenced only in focused: src/calibrator.ts, src/watcher.ts, tests/bar.test.ts
  · Both runs reclaimed a similar share of context — which is expected; the interesting delta is which content survived.
```

The reclaim amounts for blind vs. focused compacts are usually similar (that's what `/compact` does). The interesting signal is *which files survived* — that's the axis CRUSTS's focus string actually influences.

### `claude-crusts bench reextract <result.json>`

Re-run the file-ref extractor against an existing bench result, rewriting `summaryFileRefs` in place. Useful after tightening the extraction rules — the compact summary is still on disk in the session JSONL, so there's no need to compact again.

```bash
claude-crusts bench reextract blind.json
claude-crusts bench reextract blind.json --session /path/to/session.jsonl  # override
```

The extractor uses an extension whitelist (ts, tsx, js, md, json, jsonl, lock, yml, toml, py, rs, go, etc.) so JavaScript method calls like `Math.abs` or `console.log` that superficially look like `name.ext` don't get counted as file references.

### Global Options

```
--path <path>      Custom path to JSONL session files
--json             Output as JSON instead of formatted tables
--project <name>   Filter by project name
--verbose          Show derivation details (system prompt, framing)
```

## The CRUSTS Framework

CRUSTS classifies every token in your context window into 6 categories:

| Letter | Category | What it captures |
|--------|----------|-----------------|
| **C** | **Conversation** | Chat history — your messages and Claude's responses |
| **R** | **Retrieved** | File reads, grep results, web fetches pulled into context |
| **U** | **User Input** | Your current message and any attachments |
| **S** | **System** | System prompt, CLAUDE.md files, compaction summaries |
| **T** | **Tools** | Tool schemas (~40 built-in + MCP), tool calls, and tool results |
| **S** | **State/Memory** | Memory files, plans, skill metadata, agent summaries |

Each category maps to a different lever you can pull to reclaim context space:

- **Too much R?** → You're re-reading files Claude already has. Use `/compact`.
- **Too much T?** → 40 tool schemas are loaded whether you use them or not. Start fresh sessions for different tasks.
- **Too much S?** → Trim your CLAUDE.md files. They're re-sent every message.
- **Too much C?** → Long session. Time to `/compact` or `/clear` and start fresh.

The framework comes from analyzing how LLM context windows are structured in production — each category represents a distinct type of content that competes for limited token space.

## How It Works

CRUSTS reads Claude Code's session files directly from disk. **No API calls. No network requests. No LLM involved. Fully offline.**

1. Claude Code stores every session as a JSONL file at `~/.claude/projects/<project>/<session-id>.jsonl`
2. CRUSTS parses each message, classifies it into a CRUSTS category, and estimates token cost
3. Compaction boundaries are detected from actual markers in the JSONL — not heuristics
4. Waste detection finds patterns like duplicate file reads, unused tool schemas, and stale context
5. Recommendations tell you exactly what to do: which files to stop re-reading, when to `/compact`, and content-based focus hints for what to preserve

**Past sessions work.** Claude Code forgets everything when a session ends. The JSONL files remain on disk permanently. CRUSTS can analyze sessions from days or weeks ago — useful for understanding why a past session hit compaction unexpectedly or consumed more tokens than expected.

**System prompt is derived, not hardcoded.** Claude Code injects its own internal system prompt at the API level. CRUSTS derives its size from the first assistant message's API token count minus all known components (CLAUDE.md, tool schemas, memory, discovered skills, first user message). Skills are discovered from `settings.json` — not hardcoded. Different sessions with different setups produce different derived values.

**Token estimation** uses `output_tokens` from the API response (exact for assistant messages) and character-based heuristics for everything else (empirically calibrated). Use `claude-crusts calibrate` with `/context` output to measure estimation accuracy for your sessions.

## What the Claude Code Leak Revealed

On March 31, 2026, Claude Code's full TypeScript source (~512K lines) was accidentally exposed via a source map in the npm registry. CRUSTS uses specific architectural insights from community analysis of the leaked source:

| Leaked insight | How CRUSTS uses it |
|----------------|-------------------|
| `isCompactSummary` flag on messages | Identifies compaction summaries in JSONL — these are 3-5K token messages that replace compacted content. Without this flag, they'd be misclassified as regular conversation. |
| `compact_boundary` subtype with `compactMetadata.preTokens` | Precise compaction detection with exact pre/post token counts instead of heuristic-based guessing. |
| `model: "<synthetic>"` on session exit messages | Filters out false compaction events caused by session exit/resume artifacts. |
| Tool schema architecture (~40 tools) | Enables unused tool detection: CRUSTS tracks which tools were loaded vs actually invoked during a session. |
| `block.signature` on thinking blocks | Includes thinking block signatures in token estimation — real content blocks that aren't visible in the message text. |
| Cache read architecture | Detects cache overhead ratio: flags when cache re-reads exceed 90% of input tokens. |

**What was already publicly known:**
- JSONL session logs at `~/.claude/` — the community had already been parsing these
- `/context` command output format — publicly documented by Anthropic

The leak's specific contribution was the compaction markers, synthetic message filtering, and thinking block signatures — which enabled waste detection and compaction prediction features in CRUSTS.

## CRUSTS vs `/context`

Claude Code's built-in `/context` command gives you a snapshot of your current context. CRUSTS builds on top of the same session data but goes further:

| | `/context` | **CRUSTS** |
|--|-----------|------------|
| When it works | Only inside a live session | Any session, past or present |
| What it shows | Token totals by category | Token totals + specific file names, tool names, message numbers |
| Waste detection | "File reads: 21K, save ~6K" (generic) | "app.py read 17 times at messages #12, #34, #56..." (specific) |
| Recommendations | None | 7 patterns with pasteable commands |
| Fix generation | None | Three pasteable prompt blocks (`claude-crusts fix`) |
| Compaction prediction | Shows autocompact buffer size | Calculates messages until compaction triggers |
| History | Current snapshot only | Full session timeline with compaction markers |
| Cross-session | None | Side-by-side comparison with auto-generated insights |
| Compaction detail | None — context is just gone | Reconstructs what was lost: files, conversations, tools, instructions |
| Live monitoring | None | Real-time dashboard with compaction alerts (`claude-crusts watch`) |
| Trend tracking | None | Cross-session sparkline, averages, improving/worsening direction |
| Interactive TUI | None | REPL shell with Tab completion, clipboard copy, all commands interactively |
| Hook integration | None | Opt-in one-line health summary after every response |
| Shareable reports | None | Standalone HTML/Markdown file — screenshot for LinkedIn, share with team |
| Cost | Free (built-in) | Free (offline, zero API calls) |

CRUSTS doesn't replace `/context` — it complements it. Use `/context` for a quick check, use CRUSTS for deep analysis and actionable fixes.

## Why CRUSTS?

CRUSTS answers the question behind the number — not just "how full is my context?" but **"so what?"**

- **"I'm at 75% context — but what's eating it?"** → CRUSTS breakdown shows Tools at 65%, Retrieved at 25%, Conversation at 5%. The problem isn't your chat — it's tool schemas and redundant file reads.
- **"Why does auto-compaction keep surprising me?"** → CRUSTS predicts when it will trigger based on the ~80% threshold from community analysis of the leaked source: "auto-compaction in ~48 messages." (Note: auto-compaction triggers around 80% but checks at turn boundaries — a heavy turn with multiple file reads can overshoot to ~85-90% before it fires.)
- **"Why is my quota depleting so fast?"** → CRUSTS flags cache overhead: when cache re-reads exceed 90% of input tokens, most of your quota is re-sending the same content every message — even at the 90% cache discount.
- **"What can I actually DO about it?"** → Run `claude-crusts fix` — it generates three pasteable blocks: one to paste into your current session (tells Claude which files to stop re-reading), one to add to your CLAUDE.md (prevents the same waste next time), and one /compact command with a content-based focus hint describing what to preserve.

If you've ever been surprised by auto-compaction wiping your carefully built context, CRUSTS helps you see it coming and act before it happens.

## Recommendations in Action

Every CRUSTS recommendation is rule-based (no LLM needed), derived from your session data, and gives you something you can act on immediately.

### Duplicate file reads — with exact files and a pasteable tip

```
⚠  WASTE DETECTED:
   • "app.py" read 17 times (earlier reads at #12, #34, 
     #56, #78, #91, #103, #115, #128, #140, #152, #165, #178, #189, 
     #195, #201, #206 are redundant) — est. ~20,929 tokens
     
     → This file is already in context from msg #206. 
       Instead of "Read app.py and fix X", say:
       "In app.py that you already read, fix X"
   
   • "utils.py" read 7 times — est. ~2,600 tokens
     → Avoid re-reading files that haven't changed.
```

### Specific /compact command with content-based focus

```
💡 P2  /compact focus on the renderer.ts, classifier.ts, types.ts changes
       Estimated savings: ~11,159 tokens
```

This is a command you paste directly into Claude Code. CRUSTS looks at the files you've been working on recently and builds a natural language focus hint, so the compaction LLM knows what to preserve.

### Unused tool detection

```
💡 P3  Top 5 context consumers:
       1. Tool schemas (40 loaded, 4 used) — ~9,055 tokens
       2. index.ts (read 9x) — 9,897 tokens in duplicates
       3. types.ts (read 6x) — 5,972 tokens in duplicates
       4. System prompt (CLAUDE.md + internal) — 6,298 tokens
       5. classifier.ts (read 6x) — 4,659 tokens in duplicates
```

Only 4 of 40 built-in tools were actually invoked (Bash, Read, Write, Edit). The other 36 tool schemas sit in context consuming ~9K tokens whether you use them or not.

### Compaction prediction

```
💡 P4  ~127 messages until auto-compaction
       At your current rate of ~289 tokens/message,
       you'll hit the compaction threshold in ~127 messages.
```

When the countdown gets critical:

```
💡 P1  ⚠ Auto-compaction in ~3 messages. Act now:
       A) /compact (let Claude Code decide what to keep)
       B) /clear (start fresh, /resume later to come back)
       C) Continue (auto-compaction handles it, but you 
          lose control over what's preserved)
```

### CLAUDE.md size warning

```
💡 P5  Your CLAUDE.md is 1,674 tokens (89 lines).
       Consider splitting into CLAUDE.md + CLAUDE.local.md.
       Move project-specific preferences to CLAUDE.local.md.
       Estimated savings: ~874 tokens per message.
```

### Session habit advice

```
💡 P5  3 compaction events in this session.
       Sessions with < 200 messages rarely need compaction.
       Use /clear between distinct tasks instead of 
       continuing in one long session.
```

All of these are generated from patterns in your session data — no LLM, no API calls, no token cost.

## Accuracy and Limitations

CRUSTS produces estimates — like `/context` itself, which Claude Code labels "Estimated usage by category."

**What is exact** (verified against raw JSONL data):
- Duplicate file counts — every file, every read, every message number
- Unused tool detection — loaded vs invoked, exact set difference
- Cache overhead ratio — direct calculation from API usage fields
- Compaction events — detected from actual `compact_boundary` markers in the JSONL

**What is estimated:**
- Per-message token counts — uses chars/3.35 for code, chars/4.0 for English text (empirically measured from session data)
- Category breakdown percentages — based on estimated per-message tokens
- System prompt size — derived from first API response minus known components
- Compaction prediction — based on average token growth rate

**Known limitations:**
- Memory file detection may undercount (conservative approach — reads MEMORY.md + linked files only)
- Skills token estimate is per-skill flat rate (~60 tokens each); falls back to 476 total when no skills are discovered
- CLAUDE.md split recommendations use estimated line ranges
- Token estimation is calibrated for code-heavy sessions — pure English conversation sessions may vary

For ground truth comparison, run `claude-crusts calibrate` and paste your `/context` output.

## Contributing

Contributions welcome! This project uses [Bun](https://bun.sh) and TypeScript.

```bash
# Clone and install
git clone https://github.com/Abinesh-L/claude-crusts.git
cd claude-crusts
bun install

# Run locally
bun run src/index.ts analyze

# Verify your change before committing
bun run typecheck                   # strict TS typecheck
bun test                            # 190+ unit tests (under 10s)
```

Every new user-visible command must land with:
1. Unit tests in `tests/*.test.ts`.
2. A section in this README and the file-responsibilities block in `CLAUDE.md`.

See the **Development Workflow** section of `CLAUDE.md` for the full convention.

The codebase is organized as a pipeline:

```
scanner.ts -> classifier.ts -> waste-detector.ts -> recommender.ts -> renderer.ts
                   |                                                       |
               analyzer.ts (orchestrates)                            calibrator.ts
                   |                                                 comparator.ts
               trend.ts (history)                                    lost-detector.ts
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

Supporting: `types.ts`, `built-in-tools.ts`, `version.ts`.

## Feedback

Have an idea for a feature? Found a bug? [Open an issue](https://github.com/Abinesh-L/claude-crusts/issues) — feature requests are just as welcome as bug reports. I'm actively developing CRUSTS and prioritize based on what people actually need.

## License

MIT

---

*CRUSTS — Conversation, Retrieved, User, System, Tools, State.*