# CRUSTS — Context Window Analyzer for Claude Code

**See what's eating your tokens.** CRUSTS breaks down your Claude Code context window into 6 categories, detects waste, and tells you exactly what to do about it.

```
╔════════════════════════════════════════════════════════════════╗
║  CRUSTS Context Window Analysis                                ║
║  Session: a1b2c3d4 | Model: claude                             ║
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

**What it does:**
- **Breaks down your context** into 6 categories — see exactly where your tokens are going
- **Detects waste** — duplicate file reads, unused tool schemas, stale content
- **Gives you the fix** — run `claude-crusts fix` to get three pasteable blocks: one for your current session, one for your CLAUDE.md, and one /compact command. All generated from your data, no LLM needed.
- **Works on past sessions** — Claude Code forgets everything when you exit. The JSONL logs don't. Analyze any session from days or weeks ago.

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

## Quick Start

```bash
# 1. See what's in your context window right now
claude-crusts analyze

# 2. Find wasted tokens with specific file names and recommendations
claude-crusts waste

# 3. Get pasteable prompts to fix the waste — no LLM needed
claude-crusts fix

# 4. Watch token growth over time with compaction markers
claude-crusts timeline

# 5. Analyze any past session — Claude Code forgot it, CRUSTS didn't
claude-crusts analyze <session-id>

# 6. See what was lost during auto-compaction
claude-crusts lost

# 7. Live-monitor a session as it runs
claude-crusts watch

# 8. Compare two sessions side by side
claude-crusts compare <session-a> <session-b>

# 9. Generate a shareable report (HTML or Markdown)
claude-crusts report
```

## Use Inside Claude Code

The easiest way to use CRUSTS — type this inside any Claude Code session:

```
/crusts
```

That's it. Claude Code runs the analysis and tells you what to do — which files to stop re-reading, whether to `/compact` now or wait, and the exact command to paste. No copy-paste, no switching terminals.

This works automatically when you clone or install claude-crusts, because the slash command lives at `.claude/commands/crusts.md` in the repo.

**Two ways to use CRUSTS — they complement each other:**

| | `/crusts` inside Claude Code | CLI in a separate terminal |
|--|--|--|
| **Best for** | Quick check + immediate action | Deep analysis, monitoring, forensics |
| **Token cost** | Uses some context tokens for Claude to process the JSON | Zero — doesn't touch your session |
| **Features** | Analyze + actionable advice | All 10 commands: watch, lost, timeline, compare, report, etc. |
| **When to use** | Mid-session: "should I compact?" | Separate terminal: detailed views, live monitoring, past session forensics |

Use `/crusts` when you want a quick answer without leaving your session. Use the CLI when you want the full picture without spending tokens on it.

## CLI Commands

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
│ - renderer.ts (already read, at messages #5, #160, #180)   │
│ - classifier.ts (already read, at messages #4, #38, #41, #46)  │
│ - recommender.ts (already read, at messages #149, #210)    |
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
║  Compaction #1 (at message #420)                               ║
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

**System prompt is derived, not hardcoded.** Claude Code injects its own internal system prompt at the API level. CRUSTS derives its size from the first assistant message's API token count minus all known components (CLAUDE.md, tool schemas, memory, skills, first user message). Different sessions with different setups produce different derived values.

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
- Memory file detection may undercount (conservative approach)
- Skills tracked as a fixed estimate (~476 tokens)
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

# Type check
bun run typecheck
```

The codebase is organized as a pipeline:

```
scanner.ts → classifier.ts → waste-detector.ts → recommender.ts → renderer.ts
                ↑                                                      ↑
            analyzer.ts (orchestrates)                          calibrator.ts
                                                                comparator.ts
                                                                html-report.ts
                                                                md-report.ts
                                                                lost-detector.ts
                                                                watcher.ts
```

See [ROADMAP.md](ROADMAP.md) for planned features and contribution opportunities.

## Feedback

Have an idea for a feature? Found a bug? [Open an issue](https://github.com/Abinesh-L/claude-crusts/issues) — feature requests are just as welcome as bug reports. I'm actively developing CRUSTS and prioritize based on what people actually need. Check the [roadmap](ROADMAP.md) for what's planned, or suggest something completely new.

## License

MIT

---

*CRUSTS — Conversation, Retrieved, User, System, Tools, State.*