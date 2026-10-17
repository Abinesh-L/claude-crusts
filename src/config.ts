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
 *     "autocompactBufferTokens": number,
 *     "autoInject": { "enabled": boolean, "threshold": number, "minGapMs": number },
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

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { CRUSTS_DIR } from './calibrator.ts';
import { AUTOCOMPACT_BUFFER_TOKENS } from './model-context.ts';

/** Default path to the shared config file (no env override applied). */
export const CRUSTS_CONFIG_PATH = join(CRUSTS_DIR, 'config.json');

/**
 * Resolve the directory holding `config.json`, honouring a test-only
 * override via the `CRUSTS_CONFIG_DIR_OVERRIDE` env var so unit tests can
 * sandbox reads/writes away from the developer's real `~/.claude-crusts`
 * (same pattern as `CRUSTS_CALIBRATION_DIR_OVERRIDE` / `CRUSTS_INJECT_LOG_DIR`).
 */
function configDir(): string {
  const override = process.env.CRUSTS_CONFIG_DIR_OVERRIDE;
  return override && override.length > 0 ? override : CRUSTS_DIR;
}

/** Resolve the active config-file path (override-aware, computed per call). */
export function crustsConfigPath(): string {
  return join(configDir(), 'config.json');
}

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
  /**
   * Usage-percentage threshold (0-100) above which injection fires.
   * Honoured only when the user explicitly set it in config.json and that
   * point comes before the auto-compaction trigger (see
   * `thresholdExplicit`); otherwise the gate is headroom-based: inject when
   * the window is within `max(20K, 10% of the auto-compact window)` tokens of
   * the auto-compaction trigger (`breakdown.compaction`, see
   * `resolveCompactionModel` in model-context.ts).
   */
  threshold: number;
  /**
   * True when `threshold` came from an explicit value in config.json rather
   * than `DEFAULT_AUTO_INJECT`. Set by `loadAutoInjectConfig`; never
   * persisted back to disk.
   */
  thresholdExplicit?: boolean;
  /** Minimum time (ms) between two injections on the same session */
  minGapMs: number;
  /** ISO timestamp of the most recent injection on any session (set by runtime) */
  lastInjectionAt?: string;
  /** Session id that received the most recent injection */
  lastInjectionSessionId?: string;
  /** Most recent injection per session id (ISO timestamps; set by runtime,
   * the newest `RECENT_INJECTIONS_KEPT` sessions kept) */
  lastInjections?: Record<string, string>;
}

/** How many sessions' last-injection times config.json keeps. */
export const RECENT_INJECTIONS_KEPT = 50;

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
  const path = crustsConfigPath();
  if (!existsSync(path)) return {};
  try {
    const raw = stripBom(readFileSync(path, 'utf-8'));
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
 *
 * The write is atomic (a temp file in the same folder, then a rename over
 * config.json), so a reader never sees a half-written file. Two sessions'
 * hooks can record an injection within the same second; a torn read
 * returned {} and the next write kept only the injection timestamp,
 * dropping `enabled` and `threshold` and silently switching auto-inject off.
 */
export function saveConfig(updates: Record<string, unknown>): void {
  const current = loadConfig();
  const merged = { ...current, ...updates };
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = crustsConfigPath();
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  // On Windows a rename over a file another process has open for reading
  // fails with EPERM or EBUSY for a moment (seen under concurrent hooks), so
  // it is retried briefly before giving up.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, target);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt < RENAME_RETRIES) {
        sleepSync(RENAME_RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      try { unlinkSync(temp); } catch { /* best effort */ }
      throw err;
    }
  }
}

/** Rename attempts after the first, for a busy config.json on Windows. */
const RENAME_RETRIES = 8;

/** Base delay between rename attempts (grows linearly). */
const RENAME_RETRY_DELAY_MS = 15;

/**
 * Block the thread for a few milliseconds (Atomics.wait on a private buffer).
 *
 * @param ms - Milliseconds to wait
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
 * for any unset or invalid override. `thresholdExplicit` reports whether the
 * threshold was an explicit valid value in config.json (the auto-inject gate
 * honours an explicit threshold and otherwise uses the headroom-based
 * default). `lastInjectionAt` / `lastInjectionSessionId` are runtime-tracked
 * fields returned verbatim when present.
 */
export function loadAutoInjectConfig(): AutoInjectConfig {
  const cfg = loadConfig();
  const raw = cfg.autoInject as Partial<AutoInjectConfig> | undefined;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_AUTO_INJECT, thresholdExplicit: false };

  const thresholdExplicit = typeof raw.threshold === 'number' && raw.threshold > 0 && raw.threshold <= 100;
  const lastInjections: Record<string, string> = {};
  if (raw.lastInjections && typeof raw.lastInjections === 'object') {
    for (const [sid, ts] of Object.entries(raw.lastInjections)) {
      if (typeof ts === 'string') lastInjections[sid] = ts;
    }
  }
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_AUTO_INJECT.enabled,
    threshold: thresholdExplicit ? raw.threshold as number : DEFAULT_AUTO_INJECT.threshold,
    thresholdExplicit,
    minGapMs: typeof raw.minGapMs === 'number' && raw.minGapMs >= 0
      ? raw.minGapMs
      : DEFAULT_AUTO_INJECT.minGapMs,
    lastInjectionAt: typeof raw.lastInjectionAt === 'string' ? raw.lastInjectionAt : undefined,
    lastInjectionSessionId: typeof raw.lastInjectionSessionId === 'string' ? raw.lastInjectionSessionId : undefined,
    lastInjections,
  };
}

/**
 * Update the runtime-tracked injection state (timestamp + session id).
 *
 * Called by the auto-inject hook after emitting an injection payload.
 * Merges into the RAW on-disk `autoInject` object, not the defaults-expanded
 * view from `loadAutoInjectConfig` — materialising defaults (threshold 70)
 * into config.json would make them read back as explicit user choices and
 * silently disable the headroom-based default gate. Sibling config keys and
 * the user's own `enabled` / `threshold` / `minGapMs` values are preserved.
 *
 * The time is also kept per session (`lastInjections`), so the min-gap
 * holds for each session on its own: with one shared slot, two hot sessions
 * alternated and each got an advisory on every prompt.
 */
export function recordInjection(sessionId: string): void {
  const cfg = loadConfig();
  const raw = cfg.autoInject && typeof cfg.autoInject === 'object'
    ? cfg.autoInject as Record<string, unknown>
    : {};
  const now = new Date().toISOString();
  const previous = raw.lastInjections && typeof raw.lastInjections === 'object'
    ? raw.lastInjections as Record<string, unknown>
    : {};
  const entries = Object.entries(previous)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0] !== sessionId)
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, RECENT_INJECTIONS_KEPT - 1);
  saveConfig({
    autoInject: {
      ...raw,
      lastInjectionAt: now,
      lastInjectionSessionId: sessionId,
      lastInjections: Object.fromEntries([[sessionId, now], ...entries]),
    },
  });
}

/**
 * Resolve the effective auto-compaction buffer size in tokens.
 *
 * Reads the `autocompactBufferTokens` key from config.json; any missing,
 * non-numeric, or non-positive value falls through to
 * `AUTOCOMPACT_BUFFER_TOKENS` (33,000). The override exists because the
 * buffer has drifted across Claude Code versions (~21K was observed on
 * v2.1.92-2.1.96) and may drift again.
 *
 * @returns Buffer size in tokens for `autocompactTrigger`
 */
export function loadAutocompactBufferTokens(): number {
  const cfg = loadConfig();
  const v = cfg.autocompactBufferTokens;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : AUTOCOMPACT_BUFFER_TOKENS;
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
