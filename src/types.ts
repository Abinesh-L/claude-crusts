/**
 * CRUSTS type definitions
 *
 * Types for parsing Claude Code session JSONL files and
 * classifying token usage into the 6 CRUSTS categories.
 */

/** The 6 CRUSTS categories for context window classification */
export type CrustsCategory =
  | 'conversation'
  | 'retrieved'
  | 'user'
  | 'system'
  | 'tools'
  | 'state';

/** Short labels for display */
export const CRUSTS_LABELS: Record<CrustsCategory, string> = {
  conversation: 'C  Conversation',
  retrieved: 'R  Retrieved',
  user: 'U  User Input',
  system: 'S  System',
  tools: 'T  Tools',
  state: 'S  State/Memory',
};

// ---------------------------------------------------------------------------
// JSONL message types
// ---------------------------------------------------------------------------

/** Token usage data attached to assistant messages */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** A content block inside a message */
export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image' | 'document';
  text?: string;
  thinking?: string;
  signature?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | ContentBlock[];
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
  source?: {
    type: string;
    media_type?: string;
    data?: string;
  };
}

/**
 * A single line from a session JSONL file.
 *
 * Top-level `type` values observed in real data:
 * - "user" — human messages
 * - "assistant" — model responses (may contain text, thinking, tool_use, tool_result blocks)
 * - "system" — system events (turn_duration, etc.)
 * - "progress" — tool execution progress updates
 * - "file-history-snapshot" — file state snapshots (ignored by CRUSTS)
 */
export interface SessionMessage {
  type: 'user' | 'assistant' | 'system' | 'progress' | 'file-history-snapshot' | 'last-prompt';
  message?: {
    role: string;
    content: string | ContentBlock[];
    model?: string;
    usage?: TokenUsage;
  };
  /** System event subtype (e.g., "turn_duration", "compact_boundary") */
  subtype?: string;
  /** Progress data for tool execution */
  data?: Record<string, unknown>;
  /** Duration in ms for system turn_duration events */
  durationMs?: number;
  /** Message UUID */
  uuid?: string;
  /** Parent message UUID for threading */
  parentUuid?: string | null;
  /** Whether this is a sidechain message */
  isSidechain?: boolean;
  /** Session ID */
  sessionId?: string;
  /** Working directory at time of message */
  cwd?: string;
  /** Timestamp ISO string */
  timestamp?: string;
  /** True for compaction summary messages injected after auto-compact */
  isCompactSummary?: boolean;
  /** True for metadata-only messages (compact boundaries, turn durations) */
  isMeta?: boolean;
  /** Only visible in transcript, not sent to API as normal conversation */
  isVisibleInTranscriptOnly?: boolean;
  /** Compaction metadata on compact_boundary system messages */
  compactMetadata?: {
    trigger: 'auto' | 'manual';
    preTokens: number;
    preCompactDiscoveredTools?: string[];
  };
  /** Model identifier — "<synthetic>" for session exit/resume artifacts */
  model?: string;
}

// ---------------------------------------------------------------------------
// Scanner output types
// ---------------------------------------------------------------------------

/** Info about a discovered session file */
export interface SessionInfo {
  id: string;
  path: string;
  project: string;
  modifiedAt: Date;
  sizeBytes: number;
}

/** A file read with its content and token estimate */
export interface FileContent {
  path: string;
  content: string;
  estimatedTokens: number;
  exists: boolean;
}

/** An MCP server discovered from config */
export interface MCPServerInfo {
  name: string;
  toolCount: number | null;
  estimatedSchemaTokens: number;
  source: 'global' | 'project';
}

/** Summary of memory files */
export interface MemoryFileSummary {
  path: string;
  sizeBytes: number;
  estimatedTokens: number;
  source: 'global' | 'project';
}

/** A skill discovered from Claude Code settings */
export interface SkillInfo {
  name: string;
  source: 'global' | 'project';
  estimatedTokens: number;
}

// ---------------------------------------------------------------------------
// Classifier types
// ---------------------------------------------------------------------------

/** Aggregated config data fed into the classifier from scanner results */
export interface ConfigData {
  systemPrompt: {
    files: FileContent[];
    totalEstimatedTokens: number;
  };
  mcpServers: MCPServerInfo[];
  memoryFiles: {
    files: MemoryFileSummary[];
    totalEstimatedTokens: number;
  };
  builtInTools: {
    tools: { name: string; estimated_tokens: number }[];
    totalEstimatedTokens: number;
  };
  skills: {
    items: SkillInfo[];
    totalEstimatedTokens: number;
  };
}

/** Classification result for a single message */
export interface ClassifiedMessage {
  index: number;
  category: CrustsCategory;
  tokens: number;
  cumulativeTokens: number;
  accuracy: 'exact' | 'estimated';
  contentPreview: string;
  toolName?: string;
}

/** Breakdown of tool token usage */
export interface ToolBreakdown {
  /** Tools loaded (schema overhead) */
  loadedTools: string[];
  /** Tools actually invoked during the session */
  usedTools: string[];
  /** Tools loaded but never used */
  unusedTools: string[];
  /** Token cost per tool category */
  schemaTokens: number;
  callTokens: number;
  resultTokens: number;
}

// ---------------------------------------------------------------------------
// Analysis output types
// ---------------------------------------------------------------------------

/** Per-category token count and percentage */
export interface CrustsBucket {
  category: CrustsCategory;
  tokens: number;
  percentage: number;
  accuracy: 'exact' | 'estimated';
}

/** A detected compaction event in the session */
export interface CompactionEvent {
  /** Index of the compact_boundary message (or assistant before the drop for heuristic) */
  beforeIndex: number;
  /** Index of the first assistant message after compaction */
  afterIndex: number;
  /** Cumulative input_tokens before compaction */
  tokensBefore: number;
  /** Cumulative input_tokens after compaction */
  tokensAfter: number;
  /** Size of the drop */
  tokensDropped: number;
  /** Detection method: 'marker' (compact_boundary) or 'heuristic' (token drop) */
  detection: 'marker' | 'heuristic';
  /** Index of the compaction summary message (isCompactSummary), if found */
  summaryIndex?: number;
  /** Estimated tokens in the compaction summary */
  summaryTokens?: number;
}

/**
 * Values derived from THIS SESSION's API usage data, not hardcoded.
 * Different sessions will produce different values depending on model,
 * system prompt version, and tool configuration at the time.
 */
export interface DerivedOverhead {
  /** Internal system prompt tokens derived from first assistant input_tokens */
  internalSystemPrompt: {
    tokens: number;
    /** Breakdown of the derivation for transparency */
    derivation: {
      firstAssistantInputTokens: number;
      knownClaudeMd: number;
      knownToolSchemas: number;
      knownMemory: number;
      knownSkills: number;
      knownFirstUserMessage: number;
      totalKnown: number;
    };
  } | null;
  /** Per-message framing overhead derived from input_token deltas */
  messageFraming: {
    tokensPerMessage: number;
    /** Total framing tokens added to the breakdown */
    totalTokens: number;
    /** Number of message-pair samples used */
    sampleCount: number;
    /** All sampled per-message framing values for verification */
    samples: number[];
  } | null;
}

/** Full CRUSTS breakdown for a session */
export interface CrustsBreakdown {
  buckets: CrustsBucket[];
  total_tokens: number;
  context_limit: number;
  free_tokens: number;
  usage_percentage: number;
  messages: ClassifiedMessage[];
  toolBreakdown: ToolBreakdown;
  /** Model name extracted from first non-synthetic assistant message */
  model: string;
  /** Session duration in seconds, or null if timestamps unavailable */
  durationSeconds: number | null;
  /** Detected compaction events */
  compactionEvents: CompactionEvent[];
  /** If compaction occurred, breakdown of only post-last-compaction context */
  currentContext?: {
    buckets: CrustsBucket[];
    total_tokens: number;
    free_tokens: number;
    usage_percentage: number;
    startIndex: number;
  };
  /** Values derived from THIS SESSION's API usage data */
  derivedOverhead?: DerivedOverhead;
}

/** A detected waste item with recommendation */
export interface WasteItem {
  type:
    | 'stale_read'
    | 'duplicate_read'
    | 'oversized_system'
    | 'resolved_exchange'
    | 'cache_overhead'
    | 'unused_result';
  severity: 'high' | 'medium' | 'low' | 'info';
  description: string;
  estimated_tokens: number;
  recommendation: string;
  message_range?: [number, number];
}

/** Summary metadata for a session */
export interface SessionSummary {
  id: string;
  model: string;
  duration_minutes: number;
  message_count: number;
  total_tokens: number;
  first_timestamp?: string;
  last_timestamp?: string;
  project?: string;
}

/** A single row in the timeline view */
export interface TimelineEntry {
  message_number: number;
  tokens: number;
  cumulative_tokens: number;
  category: CrustsCategory;
  content_preview: string;
}

/** Context health classification */
export type ContextHealth = 'healthy' | 'warming' | 'hot' | 'critical';

/** A prioritized recommendation */
export interface Recommendation {
  priority: 1 | 2 | 3 | 4 | 5;
  action: string;
  impact: number;
  reason: string;
}

/** Full recommendation report */
export interface RecommendationReport {
  recommendations: Recommendation[];
  estimated_messages_until_compaction: number | null;
  context_health: ContextHealth;
}

/** Parsed calibration data from /context output */
export interface CalibrationData {
  timestamp: string;
  buckets: {
    system_prompt: number;
    system_tools: number;
    custom_agents: number;
    memory_files: number;
    mcp_tools: number;
    messages: number;
    free_space: number;
  };
  total_used: number;
  total_capacity: number;
  raw_output: string;
}

/** Comparison of CRUSTS estimate vs /context ground truth */
export interface CalibrationComparison {
  category: string;
  crustsEstimate: number;
  contextActual: number;
  deltaPercent: number;
}

/** Generated fix prompts for pasting into Claude Code or CLAUDE.md */
export interface FixPrompts {
  /** Text to paste into the current Claude Code session */
  sessionPrompt: string | null;
  /** Snippet to add to CLAUDE.md for future sessions */
  claudeMdSnippet: string | null;
  /** A specific /compact command ready to paste */
  compactCommand: string | null;
}

// ---------------------------------------------------------------------------
// Compare types
// ---------------------------------------------------------------------------

/** Per-category delta in a comparison */
export interface CategoryDelta {
  category: CrustsCategory;
  tokensA: number;
  tokensB: number;
  delta: number;
  deltaPercent: number;
}

/** Waste comparison summary */
export interface WasteComparison {
  countA: number;
  countB: number;
  totalTokensA: number;
  totalTokensB: number;
}

/** Compaction comparison summary */
export interface CompactionComparison {
  countA: number;
  countB: number;
}

/** Full comparison result between two sessions */
export interface ComparisonResult {
  sessionA: { id: string; project: string; messageCount: number };
  sessionB: { id: string; project: string; messageCount: number };
  totalA: number;
  totalB: number;
  totalDelta: number;
  totalDeltaPercent: number;
  categoryDeltas: CategoryDelta[];
  waste: WasteComparison;
  compaction: CompactionComparison;
  insights: string[];
}

// ---------------------------------------------------------------------------
// Trend types
// ---------------------------------------------------------------------------

/** A single historical analyze run, persisted to ~/.claude-crusts/history.jsonl */
export interface TrendRecord {
  sessionId: string;
  projectName: string;
  timestamp: string;
  totalTokens: number;
  percentUsed: number;
  messageCount: number;
  compactionCount: number;
  health: ContextHealth;
  topCategory: CrustsCategory;
  topCategoryTokens: number;
}

/** Aggregate summary computed across a list of TrendRecords */
export interface TrendSummary {
  count: number;
  avgPercentUsed: number;
  avgTotalTokens: number;
  avgCompactionCount: number;
  avgMessageCount: number;
  /** Most frequent top category across the records */
  dominantCategory: CrustsCategory;
  /** Direction of percent-used trend across the window: 'improving' = decreasing */
  direction: 'improving' | 'worsening' | 'flat';
  /** Delta in percentUsed: average of last third minus average of first third */
  percentUsedDelta: number;
  /** Sparkline-ready series of percentUsed for the records */
  series: number[];
}

/** Full analysis result from the orchestrator */
export interface AnalysisResult {
  sessionId: string;
  project: string;
  messageCount: number;
  breakdown: CrustsBreakdown;
  waste: WasteItem[];
  recommendations: RecommendationReport;
  calibration: CalibrationComparison[] | null;
  configData: ConfigData;
  messages: SessionMessage[];
}

/** A trend record together with the percent-used delta vs the previous record */
export interface TrendRecordWithDelta extends TrendRecord {
  percentUsedDelta: number | null;
}
