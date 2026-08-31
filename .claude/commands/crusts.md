Run the CRUSTS context window analyzer and give me actionable advice.

Steps:

1. Run this command in the terminal and capture the full JSON output:
   ```
   npx claude-crusts analyze --json
   ```

2. Parse the JSON result. Focus on:
   - `breakdown.usage_percentage` and `breakdown.context_limit`
   - `breakdown.buckets` (the 6 CRUSTS categories with token counts; each bucket's `tokens` is reconciled so the buckets sum to the API window total, while `contentTokens` keeps the raw classifier estimate)
   - `waste` array (each item has `description`, `estimated_tokens`, `severity`, `recommendation`)
   - `recommendations.context_health` (healthy/warming/hot/critical)
   - `recommendations.estimated_messages_until_compaction`
   - `recommendations.recommendations` (prioritized action items)

3. If context health is "healthy" (usage <50%), say so briefly:
   "Context is healthy at X%. No action needed."
   Then stop.

4. If context is warming, hot, or critical, give specific advice:

   **Files to stop re-reading:** Look at waste items with type "duplicate_read". List the exact filenames and say: "These files are already in your context. Reference them by name instead of reading them again."

   **Compact or wait:**
   - If `estimated_messages_until_compaction` is >30, say "No urgency — you have ~N messages before auto-compaction."
   - If it's 10-30, say "Consider running /compact soon."
   - If it's <10, say "Compact now" and provide the exact command.

   **Specific /compact focus:** If the recommendations include a compact focus suggestion, give the exact `/compact focus on ...` command to paste.

   **Fresh session:** If there have been 3+ compaction events OR usage is critical, suggest `/clear` and starting fresh instead.

5. Keep the response short and direct. No tables, no category breakdowns — just tell me what to do right now.
