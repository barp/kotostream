import { describe, expect, it } from 'vitest';
import { isDedicatedSttModel, parseDiarizedLlmResponse } from '../src/background/stt';

describe('OpenRouter audio & diarization helpers', () => {
  it('routes dedicated STT models vs multimodal audio LLMs correctly', () => {
    expect(isDedicatedSttModel('openai/whisper-large-v3')).toBe(true);
    expect(isDedicatedSttModel('openai/whisper-1')).toBe(true);
    expect(isDedicatedSttModel('elevenlabs/scribe-v2')).toBe(true);
    expect(isDedicatedSttModel('google/gemini-2.5-flash')).toBe(false);
    expect(isDedicatedSttModel('google/gemini-2.5-flash-lite')).toBe(false);
  });

  it('parses 1-speaker and 2-speaker JSON responses from Gemini on OpenRouter', () => {
    const single = parseDiarizedLlmResponse('[{"speaker":1,"text":"昨日の夜、映画を見たんだ。"}]');
    expect(single.text).toBe('昨日の夜、映画を見たんだ。');
    expect(single.segments).toEqual([{ speaker: 1, text: '昨日の夜、映画を見たんだ。' }]);

    const two = parseDiarizedLlmResponse(
      '```json\n[{"speaker":1,"text":"待ってよ！"},{"speaker":2,"text":"もう時間がないんだ！"}]\n```'
    );
    expect(two.text).toBe('待ってよ！\nもう時間がないんだ！');
    expect(two.segments).toEqual([
      { speaker: 1, text: '待ってよ！' },
      { speaker: 2, text: 'もう時間がないんだ！' },
    ]);

    expect(parseDiarizedLlmResponse('[]').text).toBe('');
  });

  it('handles plain multi-line fallback with speaker labels stripped', () => {
    const fallback = parseDiarizedLlmResponse('Speaker 1: 行くよ！\nSpeaker 2: うん、わかった！');
    expect(fallback.text).toBe('行くよ！\nうん、わかった！');
    expect(fallback.segments).toHaveLength(2);
  });
});
