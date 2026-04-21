/**
 * User-level configuration store.
 *
 * Lives at `~/.claude-crusts/config.json`. Multiple modules read from
 * and write to this file (hook toggle state, waste-detection thresholds,
 * future feature flags), so all access goes through `loadConfig` /
 * `saveConfig` to preserve sibling keys on partial updates.
 *
 * Schema today:
 *   {
 *     "hooksEnabled": boolean,
 *     "installedAt": string (ISO),
 *     "wasteThresholds": {
 *       "staleReadThreshold": number,
 *       "oversizedSystemThreshold": number,
 *       "cacheOverheadThreshold": number,
 *       "resolutionLookback": number,
 *       "claudeMdOversizedThreshold": number
 *     }
 *   }
 *
 * All fields are optional. Readers should fall through to defaults for
 * missing keys. Writers merge — never replace the whole file.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CRUSTS_DIR } from './calibrator.ts';

/** Path to the shared config file. */
export const CRUSTS_CONFIG_PATH = join(CRUSTS_DIR, 'config.json');

/** Defaults for the waste-detection thresholds. */
export const DEFAULT_WASTE_THRESHOLDS: WasteThresholds = {
  staleReadThreshold: 15,
  oversizedSystemThreshold: 1_500,
  cacheOverheadThreshold: 0.6,
  resolutionLookback: 10,
  claudeMdOversizedThreshold: 1_500,
};

/** Defaults for hook-triggered auto-injection. */
export const DEFAULT_AUTO_INJECT: AutoInjectConfig = {
  enabled: false,
  threshold: 70,
  minGapMs: 5 * 60 * 1000, // 5 minutes between injections to avoid spam
};

/**
 * Hook-triggered fix injection configuration.
 *
 * When enabled and installed via `hooks auto-inject enable`, crusts runs
 * on every `UserPromptSubmit` event. If the session's usage has crossed
 * `threshold` and the last injection was more than `minGapMs` ago, crusts
 * emits a `UserPromptSubmit` hook payload with `additionalContext` that
 * gets prepended to Claude's context — a specific `/compact focus`
 * recommendation tuned to this session's actual waste.
 */
export interface AutoInjectConfig {
  /** Whether auto-injection is opted in by the user */
  enabled: boolean;
  /** Usage-percentage threshold (0-100) above which injection fires */
  threshold: number;
  /** Minimum time (ms) between two injections on the same session */
  minGapMs: number;
  /** ISO timestamp of the most recent injection (set by runtime) */
  lastInjectionAt?: string;
  /** Session id that received the most recent injection */
  lastInjectionSessionId?: string;
}

/** Tunable thresholds for waste and optimize detection. */
export interface WasteThresholds {
  /** How many messages back before a file read is considered stale */
  staleReadThreshold: number;
  /** System prompt token threshold before we flag it as oversized */
  oversizedSystemThreshold: number;
  /** `cache_read / total_input` ratio that triggers the cache-overhead warning */
  cacheOverheadThreshold: number;
  /** Max messages to look back from a resolution marker */
  resolutionLookback: number;
  /** CLAUDE.md token threshold for the `claudemd-oversized` optimize fix */
  claudeMdOversizedThreshold: number;
}

/**
 * Strip a leading UTF-8 BOM if present.
 *
 * Windows editors (including PowerShell's `Set-Content -Encoding utf8`
 * on PS 5.1) silently prepend a UTF-8 BOM. Node's `readFileSync` with
 * `'utf-8'` does NOT strip the BOM, so `JSON.parse` throws on the
 * leading U+FEFF. That throw is caught by callers and the file gets
 * treated as empty — meaning a user who edits their config in Notepad
 * (which writes BOM) sees their settings silently ignored.
 */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

/** Load the raw config object. Returns {} on missing/corrupt. */
export function loadConfig(): Record<string, unknown> {
  if (!existsSync(CRUSTS_CONFIG_PATH)) return {};
  try {
    const raw = stripBom(readFileSync(CRUSTS_CONFIG_PATH, 'utf-8'));
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Merge `updates` into the existing config and persist.
 *
 * Guarantees sibling keys are preserved — e.g. writing
 * `{ hooksEnabled: false }` won't erase `wasteThresholds`.
 */
export function saveConfig(updates: Record<string, unknown>): void {
  const current = loadConfig();
  const merged = { ...current, ...updates };
  if (!existsSync(CRUSTS_DIR)) mkdirSync(CRUSTS_DIR, { recursive: true });
  writeFileSync(CRUSTS_CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

/**
 * Resolve the active waste thresholds by merging user overrides into defaults.
 *
 * Any unset or invalid override falls through to DEFAULT_WASTE_THRESHOLDS,
 * so users can partially override (e.g. only `staleReadThreshold`).
 *
 * @returns Effective thresholds for this run
 */
export function loadWasteThresholds(): WasteThresholds {
  const cfg = loadConfig();
  const raw = cfg.wasteThresholds as Partial<WasteThresholds> | undefined;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_WASTE_THRESHOLDS };

  const pickNumber = (key: keyof WasteThresholds): number => {
    const v = raw[key];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_WASTE_THRESHOLDS[key];
  };

  return {
    staleReadThreshold: pickNumber('staleReadThreshold'),
    oversizedSystemThreshold: pickNumber('oversizedSystemThreshold'),
    cacheOverheadThreshold: pickNumber('cacheOverheadThreshold'),
    resolutionLookback: pickNumber('resolutionLookback'),
    claudeMdOversizedThreshold: pickNumber('claudeMdOversizedThreshold'),
  };
}

/**
 * Load the auto-inject configuration, merging user values into defaults.
 *
 * `enabled`, `threshold`, and `minGapMs` fall through to `DEFAULT_AUTO_INJECT`
 * for any unset or invalid override. `lastInjectionAt` / `lastInjectionSessionId`
 * are runtime-tracked fields returned verbatim when present.
 */
export function loadAutoInjectConfig(): AutoInjectConfig {
  const cfg = loadConfig();
  const raw = cfg.autoInject as Partial<AutoInjectConfig> | undefined;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_AUTO_INJECT };

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_AUTO_INJECT.enabled,
    threshold: typeof raw.threshold === 'number' && raw.threshold > 0 && raw.threshold <= 100
      ? raw.threshold
      : DEFAULT_AUTO_INJECT.threshold,
    minGapMs: typeof raw.minGapMs === 'number' && raw.minGapMs >= 0
      ? raw.minGapMs
      : DEFAULT_AUTO_INJECT.minGapMs,
    lastInjectionAt: typeof raw.lastInjectionAt === 'string' ? raw.lastInjectionAt : undefined,
    lastInjectionSessionId: typeof raw.lastInjectionSessionId === 'string' ? raw.lastInjectionSessionId : undefined,
  };
}

/**
 * Update the runtime-tracked injection state (timestamp + session id).
 *
 * Called by the auto-inject hook after emitting an injection payload.
 * Merge-safe — preserves the user's `enabled` / `threshold` / `minGapMs`
 * choices and any sibling config keys.
 */
export function recordInjection(sessionId: string): void {
  const current = loadAutoInjectConfig();
  saveConfig({
    autoInject: {
      ...current,
      lastInjectionAt: new Date().toISOString(),
      lastInjectionSessionId: sessionId,
    },
  });
}

/**
 * Return a list of human-readable notes about which thresholds differ from the default.
 *
 * Used by the `--verbose` diagnostic to surface that a user-local
 * `config.json` is actively changing behaviour.
 */
export function describeThresholdOverrides(): string[] {
  const active = loadWasteThresholds();
  const notes: string[] = [];
  for (const key of Object.keys(DEFAULT_WASTE_THRESHOLDS) as (keyof WasteThresholds)[]) {
    if (active[key] !== DEFAULT_WASTE_THRESHOLDS[key]) {
      notes.push(`${key}: ${DEFAULT_WASTE_THRESHOLDS[key]} \u2192 ${active[key]}`);
    }
  }
  return notes;
}
