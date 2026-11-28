import { describe, expect, it } from 'vitest';
import { alignFuriganaSegments } from '../src/core/furigana';
import { containsKanji } from '../src/core/tokenizer';

describe('per-kanji-run furigana alignment', () => {
  it('anchors readings to kanji runs only, leaving okurigana plain', () => {
    // 食[た]べた — the reading covers only the kanji, not べた
    expect(alignFuriganaSegments('食べた', 'たべた')).toEqual([
      { surface: '食', reading: 'た', isKanji: true },
      { surface: 'べた', reading: '', isKanji: false },
    ]);

    // 引[ひ]き落[お]とす — multiple kanji runs aligned via kana anchors
    expect(alignFuriganaSegments('引き落とす', 'ひきおとす')).toEqual([
      { surface: '引', reading: 'ひ', isKanji: true },
      { surface: 'き', reading: '', isKanji: false },
      { surface: '落', reading: 'お', isKanji: true },
      { surface: 'とす', reading: '', isKanji: false },
    ]);

    // 気[き]をそらす — merged 3-token expression (incl. conjugated 気をそらした)
    expect(alignFuriganaSegments('気をそらす', 'きをそらす')).toEqual([
      { surface: '気', reading: 'き', isKanji: true },
      { surface: 'をそらす', reading: '', isKanji: false },
    ]);
    expect(alignFuriganaSegments('気をそらした', 'きをそらした')).toEqual([
      { surface: '気', reading: 'き', isKanji: true },
      { surface: 'をそらした', reading: '', isKanji: false },
    ]);
  });

  it('handles leading okurigana, single kanji, and adjacent kanji runs', () => {
    // お腹 — leading kana anchor matches, 腹[なか] gets the rest
    expect(alignFuriganaSegments('お腹', 'おなか')).toEqual([
      { surface: 'お', reading: '', isKanji: false },
      { surface: '腹', reading: 'なか', isKanji: true },
    ]);

    // 来[く]る
    expect(alignFuriganaSegments('来る', 'くる')).toEqual([
      { surface: '来', reading: 'く', isKanji: true },
      { surface: 'る', reading: '', isKanji: false },
    ]);

    // 見定[みさだ]める — adjacent kanji (no kana separator) share one ruby
    expect(alignFuriganaSegments('見定める', 'みさだめる')).toEqual([
      { surface: '見定', reading: 'みさだ', isKanji: true },
      { surface: 'める', reading: '', isKanji: false },
    ]);

    // 約束[やくそく] — kanji-only word keeps the full-width ruby (standard typography)
    expect(alignFuriganaSegments('約束', 'やくそく')).toEqual([
      { surface: '約束', reading: 'やくそく', isKanji: true },
    ]);
  });

  it('falls back to a single full-width ruby when the reading cannot be aligned', () => {
    // Irregular reading where okurigana never appears in it — never lose the reading!
    expect(alignFuriganaSegments('食べる', 'くう')).toEqual([
      { surface: '食べる', reading: 'くう', isKanji: true },
    ]);
  });

  it('returns a single plain segment when no ruby is needed', () => {
    expect(alignFuriganaSegments('できる', 'できる')).toEqual([
      { surface: 'できる', reading: '', isKanji: false },
    ]);
    expect(alignFuriganaSegments('', '')).toEqual([{ surface: '', reading: '', isKanji: false }]);
    expect(alignFuriganaSegments('ふりがな', '')).toEqual([
      { surface: 'ふりがな', reading: '', isKanji: false },
    ]);
  });

  it('treats iteration and substitute marks (々〆ヶ) as part of the kanji run', () => {
    // 一ヶ月[いっかげつ] — ヶ belongs to the kanji run
    expect(alignFuriganaSegments('一ヶ月', 'いっかげつ')).toEqual([
      { surface: '一ヶ月', reading: 'いっかげつ', isKanji: true },
    ]);
    // 人々[ひとびと] — 々 extends the kanji run instead of breaking alignment
    expect(alignFuriganaSegments('人々', 'ひとびと')).toEqual([
      { surface: '人々', reading: 'ひとびと', isKanji: true },
    ]);
  });

  it('never stretches a reading across the non-kanji part of any real subtitle word', async () => {
    // Real lines from とある暗部の少女共棲 (Ep 1-5 regression corpus): tokenize with the
    // actual MeCab pipeline, then verify every mixed-script word aligns per kanji run.
    const { analyzeWithMeCab, getMeCabTokenizer } = await import('../src/background/mecab');
    const { buildTokensFromMorphemes } = await import('../src/core/mecab-tokenizer');
    await getMeCabTokenizer();

    const lines = [
      '金が引き落とせねえんだよ！',
      '口座から引き落とせ！',
      'あとは稼いだ金を元手に',
      '相手を見定める。',
      '変えちまえばいいんだよ',
      'お姉ちゃんに任せておきなさい！',
      '逃げられると思ってるの？',
      '食べさせられたくなかったんだ',
      '一瞬だけ気をそらした。',
      '敵の気をそらすんだ。',
    ];

    let mixedWords = 0;
    for (const line of lines) {
      const morphemes = await analyzeWithMeCab(line);
      const tokens = buildTokensFromMorphemes(morphemes, {}, {}, new Set(['気をそらす']));
      for (const token of tokens) {
        if (!token.isWord || !token.reading || !token.hasKanji || token.surface === token.reading) continue;
        // Only inspect words that mix kanji with kana — the exact case that looked wrong before
        const plainChars = token.surface.replace(/[\u4e00-\u9fff\u3400-\u4dbf々〆ヶ]/g, '');
        if (!plainChars) continue;
        mixedWords++;
        const segments = alignFuriganaSegments(token.surface, token.reading);

        // Reconstruct: surfaces reassemble the word, and ruby sits only above kanji runs
        expect(segments.map((s) => s.surface).join('')).toBe(token.surface);
        for (const seg of segments) {
          expect(seg.isKanji).toBe(containsKanji(seg.surface));
        }
        // The core regression: the reading never covers the whole mixed word
        expect(segments.length).toBeGreaterThan(1);
      }
    }
    expect(mixedWords).toBeGreaterThanOrEqual(10);
  });
});
