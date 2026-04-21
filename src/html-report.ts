/**
 * HTML report generator.
 *
 * Produces a standalone HTML file with the full CRUSTS analysis —
 * single file, no external dependencies, all CSS inline.
 * Supports both single-session and comparison reports.
 */

import type {
  AnalysisResult,
  ComparisonResult,
  CrustsCategory,
  CrustsBucket,
  WasteItem,
  Recommendation,
  FixPrompts,
} from './types.ts';
import { VERSION } from './version.ts';

/** CSS hex colors matching terminal category colors */
const CATEGORY_COLORS: Record<CrustsCategory, string> = {
  conversation: '#00bcd4',
  retrieved: '#5c6bc0',
  user: '#4caf50',
  system: '#ffb300',
  tools: '#ab47bc',
  state: '#b0bec5',
};

/** Human-readable labels */
const CATEGORY_LABELS: Record<CrustsCategory, string> = {
  conversation: 'C Conversation',
  retrieved: 'R Retrieved',
  user: 'U User Input',
  system: 'S System',
  tools: 'T Tools',
  state: 'S State/Memory',
};

/** Health status colors */
const HEALTH_COLORS: Record<string, string> = {
  healthy: '#4caf50',
  warming: '#ffb300',
  hot: '#f44336',
  critical: '#d50000',
};

/** Severity colors */
const SEVERITY_COLORS: Record<string, string> = {
  high: '#f44336',
  medium: '#ffb300',
  low: '#5c6bc0',
  info: '#78909c',
};

/**
 * Escape HTML special characters.
 *
 * @param str - Raw string
 * @returns HTML-safe string
 */
function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Format a number with locale separators.
 *
 * @param n - Number to format
 * @returns Formatted string
 */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Format duration in seconds as human-readable.
 *
 * @param seconds - Duration in seconds, or null
 * @returns Formatted string or empty string
 */
function fmtDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

// ---------------------------------------------------------------------------
// Shared CSS
// ---------------------------------------------------------------------------

/** Base CSS used in all reports */
const BASE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1a1a2e;
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.6;
    padding: 2rem 1rem;
  }
  .container { max-width: 800px; margin: 0 auto; }
  h1 { color: #fff; font-size: 1.6rem; margin-bottom: 0.25rem; }
  h2 {
    color: #fff;
    font-size: 1.15rem;
    margin: 2rem 0 0.75rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid #333;
  }
  .meta { color: #888; font-size: 0.85rem; margin-bottom: 0.15rem; }
  .card {
    background: #16213e;
    border: 1px solid #2a2a4a;
    border-radius: 8px;
    padding: 1.25rem;
    margin-bottom: 1rem;
  }

  /* Stacked bar */
  .bar-container {
    height: 32px;
    border-radius: 6px;
    overflow: hidden;
    display: flex;
    margin: 0.75rem 0;
  }
  .bar-segment {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    font-weight: 600;
    color: #fff;
    text-shadow: 0 1px 2px rgba(0,0,0,0.6);
    min-width: 2px;
    transition: width 0.3s;
  }

  /* Category table */
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left;
    color: #888;
    font-size: 0.8rem;
    font-weight: 500;
    padding: 0.4rem 0.5rem;
    border-bottom: 1px solid #333;
  }
  td {
    padding: 0.45rem 0.5rem;
    border-bottom: 1px solid #222;
    font-size: 0.9rem;
  }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .cat-dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
  }

  /* Totals row */
  .totals td {
    font-weight: 600;
    border-top: 2px solid #444;
    padding-top: 0.6rem;
  }

  /* Health badge */
  .health-badge {
    display: inline-block;
    padding: 0.15rem 0.6rem;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  /* Severity badges */
  .sev-badge {
    display: inline-block;
    padding: 0.1rem 0.45rem;
    border-radius: 3px;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    color: #fff;
  }

  /* Priority badge */
  .prio-badge {
    display: inline-block;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    text-align: center;
    line-height: 24px;
    font-size: 0.75rem;
    font-weight: 700;
    color: #fff;
    margin-right: 6px;
  }
  .prio-1, .prio-2 { background: #f44336; }
  .prio-3 { background: #ffb300; color: #1a1a2e; }
  .prio-4, .prio-5 { background: #555; }

  /* Waste list */
  .waste-item {
    padding: 0.6rem 0;
    border-bottom: 1px solid #222;
  }
  .waste-item:last-child { border-bottom: none; }
  .waste-desc { margin-bottom: 0.2rem; }
  .waste-rec { color: #00bcd4; font-size: 0.85rem; }
  .waste-tokens { color: #888; font-size: 0.8rem; }

  /* Recommendations */
  .rec-item {
    display: flex;
    align-items: flex-start;
    padding: 0.5rem 0;
    border-bottom: 1px solid #222;
  }
  .rec-item:last-child { border-bottom: none; }
  .rec-body { flex: 1; }
  .rec-action { font-weight: 500; }
  .rec-reason { color: #888; font-size: 0.82rem; margin-top: 0.15rem; }
  .rec-impact { color: #4caf50; font-size: 0.82rem; }

  /* Code blocks with copy */
  .code-block {
    position: relative;
    background: #0d1117;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 1rem;
    margin: 0.5rem 0;
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    font-size: 0.82rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    color: #c9d1d9;
  }
  .copy-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    background: #333;
    border: 1px solid #555;
    color: #ccc;
    border-radius: 4px;
    padding: 0.2rem 0.5rem;
    font-size: 0.72rem;
    cursor: pointer;
    transition: background 0.2s;
  }
  .copy-btn:hover { background: #555; }

  /* Delta styling for comparison */
  .delta-pos { color: #f44336; }
  .delta-neg { color: #4caf50; }
  .delta-zero { color: #888; }

  /* Insight list */
  .insight-item {
    padding: 0.4rem 0;
    padding-left: 1.2rem;
    position: relative;
    font-size: 0.9rem;
  }
  .insight-item::before {
    content: '\\2022';
    position: absolute;
    left: 0;
    color: #4caf50;
  }

  /* Footer */
  .footer {
    text-align: center;
    color: #555;
    font-size: 0.75rem;
    margin-top: 2.5rem;
    padding-top: 1rem;
    border-top: 1px solid #222;
  }
  .footer a { color: #5c6bc0; text-decoration: none; }
  .footer a:hover { text-decoration: underline; }

  /* Usage gauge */
  .gauge-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 0.5rem;
    font-size: 0.85rem;
  }
  .gauge-label { color: #888; }
  .gauge-value { font-weight: 600; }
`;

// ---------------------------------------------------------------------------
// Single-session report
// ---------------------------------------------------------------------------

/**
 * Generate a standalone HTML report for a single session analysis.
 *
 * @param result - Complete analysis result
 * @param fix - Generated fix prompts
 * @returns Complete HTML string
 */
export function generateSessionReport(result: AnalysisResult, fix: FixPrompts): string {
  const bd = result.breakdown;
  const hasCompaction = bd.compactionEvents.length > 0 && bd.currentContext;
  const primaryBuckets = hasCompaction ? bd.currentContext!.buckets : bd.buckets;
  const primaryTotal = hasCompaction ? bd.currentContext!.total_tokens : bd.total_tokens;
  const primaryFree = hasCompaction ? bd.currentContext!.free_tokens : bd.free_tokens;
  const primaryPct = hasCompaction ? bd.currentContext!.usage_percentage : bd.usage_percentage;
  const health = result.recommendations.context_health;
  const healthHex = HEALTH_COLORS[health] ?? '#888';
  const duration = fmtDuration(bd.durationSeconds);

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CRUSTS Report — ${esc(result.sessionId.slice(0, 8))}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<div class="container">

<!-- Header -->
<h1>CRUSTS Context Window Analysis</h1>
<p class="meta">Session: ${esc(result.sessionId.slice(0, 8))} &nbsp;|&nbsp; Model: ${esc(bd.model)} &nbsp;|&nbsp; Project: ${esc(result.project)}</p>
<p class="meta">Messages: ${result.messageCount}${duration ? ` &nbsp;|&nbsp; Duration: ${duration}` : ''} &nbsp;|&nbsp; Health: <span class="health-badge" style="background:${healthHex}">${health}</span></p>
${hasCompaction ? `<p class="meta" style="color:#ffb300">${bd.compactionEvents.length} compaction(s) detected — showing current context</p>` : ''}

<!-- Breakdown -->
<h2>Category Breakdown</h2>
<div class="card">
`;

  // Stacked bar
  html += `<div class="bar-container">`;
  for (const bucket of primaryBuckets) {
    if (bucket.percentage < 0.5) continue;
    const color = CATEGORY_COLORS[bucket.category];
    const label = bucket.percentage >= 5 ? `${bucket.percentage.toFixed(0)}%` : '';
    html += `<div class="bar-segment" style="width:${bucket.percentage}%;background:${color}" title="${esc(CATEGORY_LABELS[bucket.category])}: ${fmt(bucket.tokens)} tokens (${bucket.percentage.toFixed(1)}%)">${label}</div>`;
  }
  html += `</div>`;

  // Category table
  html += `<table>
<tr><th>Category</th><th style="text-align:right">Tokens</th><th style="text-align:right">%</th><th style="text-align:right">Accuracy</th></tr>`;
  for (const bucket of primaryBuckets) {
    const color = CATEGORY_COLORS[bucket.category];
    html += `<tr>
  <td><span class="cat-dot" style="background:${color}"></span>${esc(CATEGORY_LABELS[bucket.category])}</td>
  <td class="num">${fmt(bucket.tokens)}</td>
  <td class="num">${bucket.percentage.toFixed(1)}%</td>
  <td class="num" style="color:#888">${bucket.accuracy === 'estimated' ? '~est' : 'exact'}</td>
</tr>`;
  }
  html += `<tr class="totals">
  <td>Total</td>
  <td class="num">${fmt(primaryTotal)}</td>
  <td class="num">${primaryPct.toFixed(1)}%</td>
  <td></td>
</tr></table>`;

  // Usage gauge
  html += `<div class="gauge-row">
  <span class="gauge-label">Context: ${fmt(primaryTotal)} / ${fmt(bd.context_limit)}</span>
  <span class="gauge-value" style="color:${healthHex}">${primaryPct.toFixed(1)}% used</span>
</div>
<div class="gauge-row">
  <span class="gauge-label">Free space</span>
  <span class="gauge-value">${fmt(primaryFree)} tokens</span>
</div>`;

  if (hasCompaction) {
    html += `<div class="gauge-row" style="margin-top:0.5rem;color:#888">
  <span>Session lifetime: ${fmt(bd.contentSumTokens ?? bd.total_tokens)} tokens across ${result.messageCount} messages</span>
</div>`;
  }

  html += `</div>`;

  // Waste section
  if (result.waste.length > 0) {
    const totalWaste = result.waste.reduce((sum, w) => sum + w.estimated_tokens, 0);
    html += `<h2>Waste Detection</h2>
<div class="card">
<p style="color:#ffb300;margin-bottom:0.75rem">${result.waste.length} issue(s) — ~${fmt(totalWaste)} tokens reclaimable</p>`;

    const grouped = groupBySeverity(result.waste);
    for (const severity of ['high', 'medium', 'low', 'info'] as const) {
      const items = grouped[severity];
      if (!items || items.length === 0) continue;
      const sevColor = SEVERITY_COLORS[severity] ?? '#888';
      for (const item of items) {
        html += `<div class="waste-item">
  <div class="waste-desc"><span class="sev-badge" style="background:${sevColor}">${severity}</span> ${esc(item.description)}</div>
  <div class="waste-rec">&rarr; ${esc(item.recommendation)}</div>
  <div class="waste-tokens">~${fmt(item.estimated_tokens)} tokens</div>
</div>`;
      }
    }
    html += `</div>`;
  }

  // Recommendations
  if (result.recommendations.recommendations.length > 0) {
    html += `<h2>Recommendations</h2>
<div class="card">`;
    for (const rec of result.recommendations.recommendations) {
      const lines = rec.action.split('\n');
      html += `<div class="rec-item">
  <span class="prio-badge prio-${rec.priority}">P${rec.priority}</span>
  <div class="rec-body">
    <div class="rec-action">${lines.map(esc).join('<br>')}</div>
    ${rec.impact > 0 ? `<div class="rec-impact">~${fmt(rec.impact)} tokens saveable</div>` : ''}
    <div class="rec-reason">${esc(rec.reason)}</div>
  </div>
</div>`;
    }
    if (result.recommendations.estimated_messages_until_compaction !== null) {
      html += `<p style="color:#888;font-size:0.82rem;margin-top:0.5rem">Messages until auto-compaction: ~${result.recommendations.estimated_messages_until_compaction}</p>`;
    }
    html += `</div>`;
  }

  // Fix Prompts
  if (fix.sessionPrompt || fix.claudeMdSnippet || fix.compactCommand) {
    html += `<h2>Fix Prompts</h2>`;
    let blockNum = 1;
    if (fix.sessionPrompt) {
      html += renderCodeBlock(`${blockNum}. Paste into your current Claude Code session`, fix.sessionPrompt, blockNum);
      blockNum++;
    }
    if (fix.claudeMdSnippet) {
      html += renderCodeBlock(`${blockNum}. Add to your CLAUDE.md`, fix.claudeMdSnippet, blockNum);
      blockNum++;
    }
    if (fix.compactCommand) {
      html += renderCodeBlock(`${blockNum}. Run this command now`, fix.compactCommand, blockNum);
    }
  }

  // Derived overhead
  const derived = bd.derivedOverhead;
  if (derived?.internalSystemPrompt || derived?.messageFraming) {
    html += `<h2>Derived Overhead</h2>
<div class="card" style="color:#888;font-size:0.85rem">`;
    if (derived.internalSystemPrompt) {
      html += `<p>Internal system prompt: ~${fmt(derived.internalSystemPrompt.tokens)} tokens</p>`;
    }
    if (derived.messageFraming) {
      html += `<p>Message framing: ~${derived.messageFraming.tokensPerMessage} tokens/msg (${derived.messageFraming.sampleCount} samples)</p>`;
    }
    html += `</div>`;
  }

  html += renderFooter();
  html += `</div></body></html>`;
  return html;
}

// ---------------------------------------------------------------------------
// Comparison report
// ---------------------------------------------------------------------------

/**
 * Generate a standalone HTML report comparing two sessions.
 *
 * @param comparison - Comparison result
 * @returns Complete HTML string
 */
export function generateComparisonReport(comparison: ComparisonResult): string {
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CRUSTS Comparison — ${esc(comparison.sessionA.id.slice(0, 8))} vs ${esc(comparison.sessionB.id.slice(0, 8))}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<div class="container">

<!-- Header -->
<h1>CRUSTS Session Comparison</h1>
<p class="meta">A: ${esc(comparison.sessionA.id.slice(0, 8))} (${esc(comparison.sessionA.project)}) — ${comparison.sessionA.messageCount} messages</p>
<p class="meta">B: ${esc(comparison.sessionB.id.slice(0, 8))} (${esc(comparison.sessionB.project)}) — ${comparison.sessionB.messageCount} messages</p>

<!-- Category Deltas -->
<h2>Category Breakdown</h2>
<div class="card">
<table>
<tr><th>Category</th><th style="text-align:right">Session A</th><th style="text-align:right">Session B</th><th style="text-align:right">Delta</th></tr>`;

  for (const d of comparison.categoryDeltas) {
    const color = CATEGORY_COLORS[d.category];
    const sign = d.delta >= 0 ? '+' : '';
    const deltaClass = d.delta > 0 ? 'delta-pos' : d.delta < 0 ? 'delta-neg' : 'delta-zero';
    html += `<tr>
  <td><span class="cat-dot" style="background:${color}"></span>${esc(CATEGORY_LABELS[d.category])}</td>
  <td class="num">${fmt(d.tokensA)}</td>
  <td class="num">${fmt(d.tokensB)}</td>
  <td class="num ${deltaClass}">${sign}${fmt(d.delta)} (${sign}${d.deltaPercent.toFixed(0)}%)</td>
</tr>`;
  }

  const totalSign = comparison.totalDelta >= 0 ? '+' : '';
  const totalDeltaClass = comparison.totalDelta > 0 ? 'delta-pos' : comparison.totalDelta < 0 ? 'delta-neg' : 'delta-zero';
  html += `<tr class="totals">
  <td>Total</td>
  <td class="num">${fmt(comparison.totalA)}</td>
  <td class="num">${fmt(comparison.totalB)}</td>
  <td class="num ${totalDeltaClass}">${totalSign}${fmt(comparison.totalDelta)} (${totalSign}${comparison.totalDeltaPercent.toFixed(0)}%)</td>
</tr></table>
</div>`;

  // Waste comparison
  html += `<h2>Waste Comparison</h2>
<div class="card">
<table>
<tr><th></th><th style="text-align:right">Session A</th><th style="text-align:right">Session B</th></tr>
<tr><td>Issues</td><td class="num">${comparison.waste.countA}</td><td class="num">${comparison.waste.countB}</td></tr>
<tr><td>Reclaimable tokens</td><td class="num">~${fmt(comparison.waste.totalTokensA)}</td><td class="num">~${fmt(comparison.waste.totalTokensB)}</td></tr>
<tr><td>Compactions</td><td class="num">${comparison.compaction.countA}</td><td class="num">${comparison.compaction.countB}</td></tr>
</table>
</div>`;

  // Insights
  if (comparison.insights.length > 0) {
    html += `<h2>Insights</h2>
<div class="card">`;
    for (const insight of comparison.insights) {
      html += `<div class="insight-item">${esc(insight)}</div>`;
    }
    html += `</div>`;
  }

  html += renderFooter();
  html += `</div></body></html>`;
  return html;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render a code block with a copy button.
 *
 * @param label - Section label
 * @param code - Code content
 * @param id - Unique block ID for the copy button
 * @returns HTML string
 */
function renderCodeBlock(label: string, code: string, id: number): string {
  return `<p style="color:#ccc;font-size:0.85rem;margin-top:0.75rem;font-weight:500">${esc(label)}:</p>
<div class="code-block" id="block-${id}"><button class="copy-btn" onclick="copyBlock(${id})">Copy</button>${esc(code)}</div>`;
}

/**
 * Group waste items by severity.
 *
 * @param waste - Array of waste items
 * @returns Grouped object
 */
function groupBySeverity(waste: WasteItem[]): Record<string, WasteItem[]> {
  const grouped: Record<string, WasteItem[]> = {};
  for (const item of waste) {
    const arr = grouped[item.severity];
    if (arr) {
      arr.push(item);
    } else {
      grouped[item.severity] = [item];
    }
  }
  return grouped;
}

/**
 * Render the footer with copy-button JS, version info, and timestamp.
 *
 * @returns HTML string for footer and closing script
 */
function renderFooter(): string {
  const timestamp = new Date().toISOString();
  return `
<div class="footer">
  Generated by <a href="https://github.com/Abinesh-L/claude-crusts">claude-crusts</a> v${VERSION} &nbsp;|&nbsp; ${timestamp}
</div>

<script>
function copyBlock(id) {
  var el = document.getElementById('block-' + id);
  if (!el) return;
  var btn = el.querySelector('.copy-btn');
  var text = el.textContent.replace(/^Copy/, '').trim();
  navigator.clipboard.writeText(text).then(function() {
    if (btn) { btn.textContent = 'Copied!'; setTimeout(function() { btn.textContent = 'Copy'; }, 1500); }
  });
}
</script>`;
}
