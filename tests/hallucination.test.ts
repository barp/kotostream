import { describe, expect, it } from 'vitest';
import { isLikelyHallucination } from '../src/core/hallucination';

describe('isLikelyHallucination', () => {
  it('filters common Whisper Japanese YouTube/silence hallucinations', () => {
    expect(isLikelyHallucination('ご視聴ありがとうございました。')).toBe(true);
    expect(isLikelyHallucination('チャンネル登録よろしくお願いします')).toBe(true);
    expect(isLikelyHallucination('♪♪♪')).toBe(true);
    expect(isLikelyHallucination('あああああああああ')).toBe(true);
    expect(isLikelyHallucination('そうそうそうそうそう')).toBe(true);
  });

  it('keeps real dialogue lines', () => {
    expect(isLikelyHallucination('昨日の夜、友達と一緒に映画を見たんだ。')).toBe(false);
    expect(isLikelyHallucination('ありがとうございます', 0.06)).toBe(false);
  });
});
