import { describe, expect, it } from 'vitest';
import { createInitialSrsState, formatIntervalPreview, scheduleReview } from '../src/core/srs';

describe('SM-2 SRS scheduler', () => {
  it('progresses intervals on Good ratings', () => {
    const now = 1_700_000_000_000;
    let state = createInitialSrsState(now);

    state = scheduleReview(state, 'good', now);
    expect(state.intervalDays).toBe(1);
    expect(state.repetitions).toBe(1);

    state = scheduleReview(state, 'good', now);
    expect(state.intervalDays).toBe(6);
    expect(state.repetitions).toBe(2);

    state = scheduleReview(state, 'good', now);
    expect(state.intervalDays).toBe(15);
    expect(state.repetitions).toBe(3);
  });

  it('resets repetitions and schedules short retry on Again', () => {
    const now = 1_700_000_000_000;
    const state = scheduleReview({ intervalDays: 10, easeFactor: 2.5, repetitions: 3, dueAt: now }, 'again', now);
    expect(state.repetitions).toBe(0);
    expect(state.intervalDays).toBe(0);
    expect(state.easeFactor).toBe(2.3);
    expect(state.dueAt).toBe(now + 10 * 60 * 1000);
  });

  it('formats human-readable interval previews', () => {
    const state = createInitialSrsState(0);
    expect(formatIntervalPreview(state, 'again', 0)).toBe('10m');
    expect(formatIntervalPreview(state, 'good', 0)).toBe('1d');
    expect(formatIntervalPreview(state, 'easy', 0)).toBe('4d');
  });
});
