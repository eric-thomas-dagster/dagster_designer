import type { MediaProbeResult } from '@/services/api';

// Sensible, human-friendly interval steps -- never suggests an oddball
// number like "every 7.3 seconds", same "round to something a person
// would actually type" reasoning as the tabular transform suggestions.
const INTERVAL_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

/**
 * Given a video's real duration, suggest an `every_seconds` frame-sampling
 * interval that lands near `targetFrameCount` frames total -- rounded to
 * one of INTERVAL_STEPS rather than an arbitrary decimal. Returns null
 * when duration is missing/non-positive (nothing to suggest).
 */
export function suggestFrameInterval(durationSeconds: number | null | undefined, targetFrameCount = 80): number | null {
  if (!durationSeconds || durationSeconds <= 0) return null;
  const raw = durationSeconds / targetFrameCount;
  let best = INTERVAL_STEPS[0];
  let bestDiff = Math.abs(Math.log(raw / best));
  for (const step of INTERVAL_STEPS) {
    const diff = Math.abs(Math.log(raw / step));
    if (diff < bestDiff) { best = step; bestDiff = diff; }
  }
  return best;
}

/** How many frames a given `every_seconds` interval would actually
 *  produce for this video -- used to warn when the CURRENT setting (not
 *  the suggested one) would produce an excessive or vanishing count. */
export function estimateFrameCount(durationSeconds: number | null | undefined, everySeconds: number): number | null {
  if (!durationSeconds || durationSeconds <= 0 || everySeconds <= 0) return null;
  return Math.max(1, Math.round(durationSeconds / everySeconds));
}

export type WhisperModelSize = 'tiny' | 'base' | 'small' | 'medium' | 'large';

/**
 * Suggests a Whisper model size based on real clip duration -- purely a
 * turnaround-time heuristic (larger models are meaningfully slower per
 * minute of audio), not a hard rule, so callers should present this as a
 * dismissible suggestion, never silently override what the user picked.
 */
export function suggestWhisperModelSize(durationSeconds: number | null | undefined): WhisperModelSize | null {
  if (!durationSeconds || durationSeconds <= 0) return null;
  const minutes = durationSeconds / 60;
  if (minutes > 60) return 'tiny';
  if (minutes > 20) return 'base';
  if (minutes > 5) return 'small';
  return null; // short clips: whatever's already picked is fine, no suggestion
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function probeUnavailable(probe: MediaProbeResult | null | undefined): boolean {
  return !probe || !probe.available;
}
