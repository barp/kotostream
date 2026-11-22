import { describe, expect, it } from 'vitest';
import { lookupLocal, parseJishoItem } from '../src/core/dictionary';

describe('dictionary exact variant matching', () => {
  it('matches どっち directly in local dictionary', () => {
    const entry = lookupLocal('どっち');
    expect(entry?.word).toBe('どっち');
    expect(entry?.reading).toBe('どっち');
  });

  it('picks the matching variant (どっち) instead of the first form (何方 / どちら) from Jisho items', () => {
    const mockJishoItem = {
      slug: '何方',
      is_common: true,
      jlpt: ['jlpt-n5'],
      japanese: [
        { word: '何方', reading: 'どちら' },
        { reading: 'どっち' },
      ],
      senses: [
        {
          english_definitions: ['which way', 'which direction', 'which one'],
          parts_of_speech: ['Pronoun'],
        },
      ],
    };

    const parsed = parseJishoItem(mockJishoItem, 'どっち', ['どっち']);
    expect(parsed.word).toBe('どっち');
    expect(parsed.reading).toBe('どっち');
  });
});
