import { describe, expect, it } from 'vitest';
import { appendWithoutOverlap, mergeLiveSubtitle, splitSpeakerTurns } from '../src/core/subtitle-merge';
import type { SpeakerSegment, SubtitleLine } from '../src/types';

function makeLine(
  text: string,
  timestampMs: number,
  silenceGapMs?: number,
  segments?: SpeakerSegment[]
): SubtitleLine {
  return {
    id: `sub_${timestampMs}`,
    text,
    timestampMs,
    source: 'live-stt',
    silenceGapMs,
    segments,
  };
}

describe('subtitle-merge & speaker diarization', () => {
  it('appends text cleanly and deduplicates overlapping chunk boundaries', () => {
    expect(appendWithoutOverlap('昨日の夜、友達と', '友達と一緒に映画を見た')).toBe(
      '昨日の夜、友達と一緒に映画を見た'
    );
  });

  it('splits explicit multi-speaker quotes/dashes inside a single chunk', () => {
    expect(splitSpeakerTurns('「行こう」「待ってよ」')).toEqual(['「行こう」', '「待ってよ」']);
    expect(splitSpeakerTurns('そうなの？ — うん、本当だよ')).toEqual(['そうなの？', 'うん、本当だよ']);
  });

  it('keeps non-diarized Whisper chunks on one clean sentence without false speaker splits', () => {
    const first = makeLine('昨日の夜、映画を見たんだ。', 1000, 0);
    const second = makeLine('すごく面白かったよ。', 2500, 600);

    const res = mergeLiveSubtitle(first, second, { resetPauseMs: 2200 });
    expect(res.merged).toBe(true);
    expect(res.subtitle.text).toBe('昨日の夜、映画を見たんだ。すごく面白かったよ。');
    expect(res.subtitle.text.includes('\n')).toBe(false);
  });

  it('keeps Speaker 1 as 1 sentence on Top and Speaker 2 as 1 sentence on Bottom with diarization', () => {
    const s1Part1 = makeLine('昨日の夜、', 1000, 0, [{ speaker: 0, text: '昨日の夜、' }]);
    const s1Part2 = makeLine('映画を見たんだ。', 2000, 150, [{ speaker: 0, text: '映画を見たんだ。' }]);
    const afterS1 = mergeLiveSubtitle(s1Part1, s1Part2, { resetPauseMs: 2200 });
    expect(afterS1.subtitle.text).toBe('昨日の夜、映画を見たんだ。');

    const s2Part1 = makeLine('そうなんだ、', 2600, 200, [{ speaker: 1, text: 'そうなんだ、' }]);
    const afterS2Start = mergeLiveSubtitle(afterS1.subtitle, s2Part1, { resetPauseMs: 2200 });
    expect(afterS2Start.subtitle.text).toBe('昨日の夜、映画を見たんだ。\nそうなんだ、');

    const s2Part2 = makeLine('どんな映画？', 3300, 150, [{ speaker: 1, text: 'どんな映画？' }]);
    const afterS2End = mergeLiveSubtitle(afterS2Start.subtitle, s2Part2, { resetPauseMs: 2200 });
    expect(afterS2End.subtitle.text).toBe('昨日の夜、映画を見たんだ。\nそうなんだ、どんな映画？');
  });

  it('resets cleanly to a fresh single line after a long pause', () => {
    const prev = makeLine('昨日の夜、映画を見たんだ。\nそうなんだ！', 1000, 0, [
      { speaker: 0, text: '昨日の夜、映画を見たんだ。' },
      { speaker: 1, text: 'そうなんだ！' },
    ]);
    const next = makeLine('じゃあまた明日ね。', 6000, 2600, [{ speaker: 0, text: 'じゃあまた明日ね。' }]);

    const res = mergeLiveSubtitle(prev, next, { resetPauseMs: 2200 });
    expect(res.merged).toBe(false);
    expect(res.subtitle.text).toBe('じゃあまた明日ね。');
  });
});
