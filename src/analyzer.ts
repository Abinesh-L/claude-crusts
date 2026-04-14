/**
 * Main analysis orchestrator.
 *
 * Coordinates scanning, classification, waste detection,
 * recommendation generation, and calibration comparison
 * into a single analysis pipeline.
 */

import { dirname, basename } from 'path';
import { existsSync } from 'fs';
import {
  parseSession,
  readSystemPromptFiles,
  readMCPConfig,
  readMemoryFiles,
  readSkillsConfig,
  getBuiltInToolList,
} from './scanner.ts';
import { classifySession } from './classifier.ts';
import { detectWaste } from './waste-detector.ts';
import { generateRecommendations } from './recommender.ts';
import { loadCalibration, compareWithEstimates } from './calibrator.ts';
import { recordTrend } from './trend.ts';
import type {
  AnalysisResult,
  ConfigData,
} from './types.ts';

/**
 * Gather config data from scanner functions.
 *
 * Reads system prompt files, MCP config, memory files, and
 * built-in tool definitions to produce the ConfigData needed
 * by the classifier for accurate token estimation.
 *
 * @param projectPath - Optional project path for project-level configs
 * @returns Aggregated config data
 */
export function gatherConfigData(projectPath?: string): ConfigData {
  const skillItems = readSkillsConfig(projectPath);
  return {
    systemPrompt: readSystemPromptFiles(projectPath),
    mcpServers: readMCPConfig(projectPath),
    memoryFiles: readMemoryFiles(projectPath),
    builtInTools: getBuiltInToolList(),
    skills: {
      items: skillItems,
      totalEstimatedTokens: skillItems.reduce((sum, s) => sum + s.estimatedTokens, 0),
    },
  };
}

/**
 * Derive the project directory path from a session file path.
 *
 * Session files live at ~/.claude/projects/<project-slug>/<session-id>.jsonl.
 * The project slug encodes the original directory path (e.g., "C--Users-foo-myproject").
 * We decode it back to the real directory path.
 *
 * @param sessionPath - Path to the session JSONL file
 * @returns Decoded project directory path, or undefined if not derivable
 */
function deriveProjectPath(sessionPath: string): string | undefined {
  const projectDir = dirname(sessionPath);
  const projectSlug = basename(projectDir);

  // Decode slug: "C--Users-foo-myproject" → "C:/Users/foo/myproject"
  // Pattern: "C-" at start means "C:", then "--" separates path components
  const decoded = projectSlug
    .replace(/^([A-Za-z])-{2}/, '$1:/')   // "C--" → "C:/"
    .replace(/-{2}/g, '/')                  // remaining "--" → "/"
    .replace(/-/g, '/');                    // remaining single "-" → "/"

  // Verify the decoded path exists
  if (existsSync(decoded)) {
    return decoded;
  }

  return undefined;
}

/**
 * Run the full CRUSTS analysis pipeline on a session.
 *
 * Orchestrates all analysis stages:
 * 1. Parse the JSONL session file
 * 2. Read config files for accurate estimation
 * 3. Classify all messages into CRUSTS categories
 * 4. Detect waste patterns
 * 5. Generate prioritized recommendations
 * 6. Compare against calibration data if available
 *
 * @param sessionPath - Absolute path to the session JSONL file
 * @param sessionId - Session ID for the result
 * @param project - Project name for the result
 * @param options - Optional: projectPath for config discovery, untilIndex for cutoff
 * @returns Complete analysis result
 */
export async function analyzeSession(
  sessionPath: string,
  sessionId: string,
  project: string,
  options?: { projectPath?: string; untilIndex?: number },
): Promise<AnalysisResult | null> {
  // 1. Parse JSONL (file size snapshot prevents reading messages appended during analysis)
  const messages = await parseSession(sessionPath);
  if (messages.length === 0) return null;

  // 2. Derive project path if not explicitly provided
  const resolvedProjectPath = options?.projectPath ?? deriveProjectPath(sessionPath);

  // 3. Read config files
  const configData = gatherConfigData(resolvedProjectPath);

  // 4. Classify (auto-trims CRUSTS invocation unless untilIndex overrides)
  const breakdown = classifySession(messages, configData, options?.untilIndex);

  // 5. Detect waste (compaction-aware: uses currentContext if available)
  const waste = detectWaste(messages, breakdown, configData);

  // 6. Generate recommendations
  const recommendations = generateRecommendations(breakdown, waste, configData, messages);

  // 7. Calibration comparison
  let calibration = null;
  const calibrationData = loadCalibration();
  if (calibrationData) {
    calibration = compareWithEstimates(breakdown, calibrationData);
  }

  const result: AnalysisResult = {
    sessionId,
    project,
    messageCount: breakdown.messages.length,
    breakdown,
    waste,
    recommendations,
    calibration,
    configData,
    messages,
  };

  // Persist a one-line summary for the `trend` command. Best-effort —
  // recordTrend swallows its own I/O errors.
  recordTrend(result);

  return result;
}
