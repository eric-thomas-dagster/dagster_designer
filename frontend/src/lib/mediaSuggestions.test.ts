import { describe, it, expect } from 'vitest';
import {
  suggestFrameInterval,
  estimateFrameCount,
  suggestWhisperModelSize,
  formatDuration,
  probeUnavailable,
} from './mediaSuggestions';

describe('suggestFrameInterval', () => {
  it('suggests a larger interval for a longer video to land near the target frame count', () => {
    // 1 hour video, target ~80 frames -> ~45s/frame -> nearest step is 30 or 60
    const suggestion = suggestFrameInterval(3600, 80);
    expect(suggestion).not.toBeNull();
    expect([30, 60]).toContain(suggestion);
  });

  it('suggests a small interval for a short video', () => {
    // 10 second video, target 80 frames -> way under 1s/frame -> smallest step
    expect(suggestFrameInterval(10, 80)).toBe(0.5);
  });

  it('returns null for missing or non-positive duration', () => {
    expect(suggestFrameInterval(null)).toBeNull();
    expect(suggestFrameInterval(undefined)).toBeNull();
    expect(suggestFrameInterval(0)).toBeNull();
    expect(suggestFrameInterval(-5)).toBeNull();
  });

  it('only ever returns one of the known human-friendly steps', () => {
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    for (const duration of [1, 5, 30, 120, 600, 3600, 7200, 36000]) {
      expect(steps).toContain(suggestFrameInterval(duration));
    }
  });
});

describe('estimateFrameCount', () => {
  it('computes how many frames a given interval yields for a real duration', () => {
    expect(estimateFrameCount(600, 10)).toBe(60);
    expect(estimateFrameCount(45, 1)).toBe(45);
  });

  it('floors at 1 frame rather than 0 for a very sparse interval', () => {
    expect(estimateFrameCount(5, 30)).toBe(1);
  });

  it('returns null for missing duration or a non-positive interval', () => {
    expect(estimateFrameCount(null, 1)).toBeNull();
    expect(estimateFrameCount(60, 0)).toBeNull();
    expect(estimateFrameCount(60, -1)).toBeNull();
  });
});

describe('suggestWhisperModelSize', () => {
  it('suggests smaller models as clip duration grows', () => {
    expect(suggestWhisperModelSize(3 * 60)).toBeNull(); // short clip -- no suggestion needed
    expect(suggestWhisperModelSize(10 * 60)).toBe('small');
    expect(suggestWhisperModelSize(30 * 60)).toBe('base');
    expect(suggestWhisperModelSize(90 * 60)).toBe('tiny');
  });

  it('returns null for missing/zero duration', () => {
    expect(suggestWhisperModelSize(null)).toBeNull();
    expect(suggestWhisperModelSize(0)).toBeNull();
  });
});

describe('formatDuration', () => {
  it('formats seconds/minutes/hours in a human-readable way', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(125)).toBe('2m 5s');
    expect(formatDuration(3725)).toBe('1h 2m 5s');
  });

  it('falls back to an em-dash for missing or invalid duration', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});

describe('probeUnavailable', () => {
  it('is true for null/undefined or an unavailable probe result', () => {
    expect(probeUnavailable(null)).toBe(true);
    expect(probeUnavailable(undefined)).toBe(true);
    expect(probeUnavailable({ available: false } as any)).toBe(true);
  });

  it('is false for a real available probe result', () => {
    expect(probeUnavailable({ available: true, duration_seconds: 10 } as any)).toBe(false);
  });
});
