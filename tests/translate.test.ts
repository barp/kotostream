import { describe, expect, it } from 'vitest';
import { parseGoogleTranslateResponse } from '../src/background/translate';

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
