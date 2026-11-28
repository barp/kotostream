import { describe, expect, it } from 'vitest';
import {
  buildTranslationUserPrompt,
  cleanLlmTranslation,
  parseGoogleTranslateResponse,
} from '../src/background/translate';

describe('parseGoogleTranslateResponse', () => {
  it('concatenates multi-segment Google Translate responses', () => {
    const mockPayload = [
      [
        ['Yesterday night, ', '昨日の夜、', null, null, 1],
        ['I was watching an interesting movie with a friend.', '友達と一緒に面白い映画を見ていたんだ。', null, null, 1],
      ],
      null,
      'ja',
    ];
    expect(parseGoogleTranslateResponse(mockPayload)).toBe(
      'Yesterday night, I was watching an interesting movie with a friend.'
    );
  });

  it('returns empty string for malformed payloads', () => {
    expect(parseGoogleTranslateResponse(null)).toBe('');
    expect(parseGoogleTranslateResponse({})).toBe('');
  });
});

describe('context-aware OpenRouter translation helpers', () => {
  it('builds a structured prompt with show title, surrounding dialogue, and target word', () => {
    const prompt = buildTranslationUserPrompt('そんなわけないじゃん。', {
      showTitle: 'とある暗部の少女共棲',
      contextBefore: ['本当にあいつがやったのか？', '証拠ならある。'],
      contextAfter: ['じゃあ説明してみろよ。'],
      targetWord: 'わけない',
    });
    expect(prompt).toContain('Show: とある暗部の少女共棲');
    expect(prompt).toContain('- 本当にあいつがやったのか？');
    expect(prompt).toContain('Target line to translate:\nそんなわけないじゃん。');
    expect(prompt).toContain('- じゃあ説明してみろよ。');
    expect(prompt).toContain('Target vocabulary word: わけない');
  });

  it('strips accidental labels and wrapping quotes from LLM output', () => {
    expect(cleanLlmTranslation('Translation: "There\'s no way that\'s true."')).toBe(
      "There's no way that's true."
    );
    expect(cleanLlmTranslation('「No way!」')).toBe('No way!');
  });
});
