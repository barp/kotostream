import { describe, expect, it } from 'vitest';
import {
  findActiveSubtitlesAtTime,
  findSubtitleAtTime,
  formatSubtitlesToSrt,
  parseSubtitleFile,
} from '../src/core/subtitle-parser';
import { normalizeVideoUrlKey } from '../src/core/storage';

describe('subtitle-parser & library helpers', () => {
  it('parses SRT files and finds cues by timestamp with sync offset', () => {
    const srt = `1
00:00:01,500 --> 00:00:04,000
今日はいい天気ですね。

2
00:00:05,000 --> 00:00:08,200
<i>一緒に映画を見よう！</i>
`;
    const cues = parseSubtitleFile(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe('今日はいい天気ですね。');
    expect(cues[1].text).toBe('一緒に映画を見よう！');

    expect(findSubtitleAtTime(cues, 2.5)?.text).toBe('今日はいい天気ですね。');
    expect(findSubtitleAtTime(cues, 4.5)).toBeNull();
    // With +2.0s offset (subtitles delayed by 2s), video time 4.5s matches 2.5s cue!
    expect(findSubtitleAtTime(cues, 4.5, 2.0)?.text).toBe('今日はいい天気ですね。');
  });

  it('parses WebVTT files', () => {
    const vtt = `WEBVTT

00:01.000 --> 00:03.500
日本語の字幕テスト
`;
    const cues = parseSubtitleFile(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].videoTimeSec).toBe(1);
    expect(cues[0].endTimeSec).toBe(3.5);
  });

  it('parses ASS files and returns both overlapping speaker cues at the same timestamp', () => {
    const ass = `[Script Info]
Title: Test

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:02.00,0:00:05.00,Default,,0,0,0,,{\\i1}待ってよ！{\\i0}
Dialogue: 0,0:00:03.00,0:00:06.00,Default,,0,0,0,,もう時間がないんだ！
`;
    const cues = parseSubtitleFile(ass);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe('待ってよ！');
    expect(cues[1].text).toBe('もう時間がないんだ！');

    const overlapping = findActiveSubtitlesAtTime(cues, 3.5);
    expect(overlapping).toHaveLength(2);
    expect(overlapping[0].text).toBe('待ってよ！');
    expect(overlapping[1].text).toBe('もう時間がないんだ！');
  });

  it('formats cues back into valid SRT', () => {
    const cues = parseSubtitleFile(`1
00:00:01,500 --> 00:00:04,000
約束を守る。
`);
    const srt = formatSubtitlesToSrt(cues);
    expect(srt).toContain('00:00:01,500 --> 00:00:04,000');
    expect(srt).toContain('約束を守る。');
  });

  it('normalizes Prime Video and YouTube URLs cleanly', () => {
    expect(
      normalizeVideoUrlKey('https://www.primevideo.com/detail/0ABC123/ref=atv_dp_season?foo=bar')
    ).toBe('primevideo.com/detail/0ABC123');
    expect(normalizeVideoUrlKey('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s')).toBe(
      'youtube.com/watch?v=dQw4w9WgXcQ'
    );
  });
});
