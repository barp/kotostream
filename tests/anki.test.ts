import { describe, expect, it } from 'vitest';
import {
  buildAnkiFieldPreview,
  buildAnkiNotePayload,
  exportCardsToTsv,
  formatSentenceHtml,
  formatWordWithFurigana,
} from '../src/core/anki';
import { DEFAULT_SETTINGS, type MinedCard } from '../src/types';
import { createInitialSrsState } from '../src/core/srs';

const sampleCard: MinedCard = {
  id: 'card_123',
  word: '約束',
  surfaceWord: '約束',
  reading: 'やくそく',
  meaning: 'promise; agreement',
  sentence: '絶対にあの約束を守る。',
  translation: 'I will definitely keep that promise.',
  notes: 'Common anime phrase',
  cardType: 'sentence',
  sourceTitle: 'Prime Video Anime',
  sourceUrl: 'https://www.primevideo.com/detail/xyz',
  createdAt: 1000,
  srs: createInitialSrsState(1000),
};

describe('Migaku-style anki helpers', () => {
  it('formats furigana in HTML ruby, Migaku brackets, and plain modes', () => {
    expect(formatWordWithFurigana('約束', 'やくそく', 'ruby_html')).toBe('<ruby>約束<rt>やくそく</rt></ruby>');
    expect(formatWordWithFurigana('約束', 'やくそく', 'migaku_brackets')).toBe('約束[やくそく]');
    expect(formatWordWithFurigana('約束', 'やくそく', 'none')).toBe('約束');
  });

  it('highlights target word (or conjugated surface form) in sentence', () => {
    expect(formatSentenceHtml('昨日映画を見ていた。', '見る', '見ていた', true)).toBe(
      '昨日映画を<b class="ks-target-word">見ていた</b>。'
    );
    expect(formatSentenceHtml('昨日映画を見ていた。', '見る', '見ていた', false)).toBe('昨日映画を見ていた。');
  });

  it('builds a complete Migaku-style AnkiConnect note payload with translation, notes, and media', () => {
    const payload = buildAnkiNotePayload(
      sampleCard,
      {
        ...DEFAULT_SETTINGS.anki,
        deckName: 'Japanese::Prime',
        modelName: 'Migaku Japanese',
        furiganaFormat: 'migaku_brackets',
        highlightTargetInSentence: true,
      },
      { image: 'kotostream_card_123.webp', audio: 'kotostream_card_123.webm' }
    );

    expect(payload.deckName).toBe('Japanese::Prime');
    expect(payload.fields['Target Word']).toBe('約束[やくそく]');
    expect(payload.fields.Reading).toBe('やくそく');
    expect(payload.fields.Sentence).toBe('絶対にあの<b class="ks-target-word">約束</b>を守る。');
    expect(payload.fields.Translation).toBe('I will definitely keep that promise.');
    expect(payload.fields.Definitions).toBe('promise; agreement');
    expect(payload.fields.Notes).toBe('Common anime phrase');
    expect(payload.fields.Image).toBe('<img src="kotostream_card_123.webp">');
    expect(payload.fields['Sentence Audio']).toBe('[sound:kotostream_card_123.webm]');
    expect(payload.tags).toContain('kotostream::sentence');
  });

  it('builds live field previews including inline screenshot and audio badge', () => {
    const preview = buildAnkiFieldPreview(
      {
        ...sampleCard,
        screenshotDataUrl: 'data:image/webp;base64,AAAA',
        audioBase64: 'BBBB',
      },
      DEFAULT_SETTINGS.anki
    );

    const imageField = preview.find((f) => f.fieldName === 'Image');
    const audioField = preview.find((f) => f.fieldName === 'Sentence Audio');
    const transField = preview.find((f) => f.fieldName === 'Translation');

    expect(imageField?.hasImage).toBe(true);
    expect(imageField?.html).toContain('data:image/webp;base64,AAAA');
    expect(audioField?.hasAudio).toBe(true);
    expect(transField?.html).toBe('I will definitely keep that promise.');
  });

  it('exports cards to TSV including translation', () => {
    const tsv = exportCardsToTsv([sampleCard]);
    expect(tsv).toBe(
      '約束\tやくそく\tpromise; agreement\t絶対にあの約束を守る。\tI will definitely keep that promise.\tPrime Video Anime'
    );
  });
});
