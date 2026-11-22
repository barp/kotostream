import type { SrsState } from '../types';

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

const DAY_MS = 24 * 60 * 60 * 1000;

export function createInitialSrsState(now = Date.now()): SrsState {
  return {
    intervalDays: 0,
    easeFactor: 2.5,
    repetitions: 0,
    dueAt: now,
  };
}

/**
 * SM-2 Spaced Repetition scheduler.
 */
export function scheduleReview(state: SrsState, rating: ReviewRating, now = Date.now()): SrsState {
  let { intervalDays, easeFactor, repetitions } = state;

  if (rating === 'again') {
    repetitions = 0;
    intervalDays = 0;
    easeFactor = Math.max(1.3, easeFactor - 0.2);
    // Re-show in 10 minutes
    return {
      intervalDays,
      easeFactor: round2(easeFactor),
      repetitions,
      dueAt: now + 10 * 60 * 1000,
      lastReviewedAt: now,
    };
  }

  if (rating === 'hard') {
    if (repetitions === 0) {
      intervalDays = 0.5; // 12 hours
    } else {
      intervalDays = Math.max(1, Math.round(intervalDays * 1.2));
    }
    easeFactor = Math.max(1.3, easeFactor - 0.15);
    repetitions += 1;
  } else if (rating === 'good') {
    if (repetitions === 0) {
      intervalDays = 1;
    } else if (repetitions === 1) {
      intervalDays = 6;
    } else {
      intervalDays = Math.round(intervalDays * easeFactor);
    }
    repetitions += 1;
  } else if (rating === 'easy') {
    if (repetitions === 0) {
      intervalDays = 4;
    } else if (repetitions === 1) {
      intervalDays = 10;
    } else {
      intervalDays = Math.round(intervalDays * easeFactor * 1.3);
    }
    easeFactor = Math.min(3.5, easeFactor + 0.15);
    repetitions += 1;
  }

  return {
    intervalDays,
    easeFactor: round2(easeFactor),
    repetitions,
    dueAt: now + Math.round(intervalDays * DAY_MS),
    lastReviewedAt: now,
  };
}

export function formatIntervalPreview(state: SrsState, rating: ReviewRating, now = Date.now()): string {
  const next = scheduleReview(state, rating, now);
  const diffMs = Math.max(0, next.dueAt - now);
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = (days / 30).toFixed(1).replace(/\.0$/, '');
  return `${months}mo`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
