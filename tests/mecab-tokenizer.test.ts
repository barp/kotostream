import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeWithMeCab, getMeCabTokenizer } from '../src/background/mecab';
import { buildTokensFromMorphemes, katakanaToHiragana } from '../src/core/mecab-tokenizer';
import type { VocabEntry } from '../src/types';

describe('MeCab / Kuromoji tokenizer on real anime subtitles (とある暗部の少女共棲)', () => {
  beforeAll(async () => {
    await getMeCabTokenizer();
  }, 15000);

  it('converts katakana readings to hiragana', () => {
    expect(katakanaToHiragana('ミサダメル')).toBe('みさだめる');
    expect(katakanaToHiragana('カセイダ')).toBe('かせいだ');
  });

  it('segments tricky colloquial and chained anime verbs accurately with base forms', async () => {
    const cases: Array<{ line: string; expectedSurface: string; expectedBase: string }> = [
      { line: 'その依頼人　さらっちまおう。', expectedSurface: 'さらっちまおう', expectedBase: 'さらう' },
      { line: 'そういう連中はファンから飽きられたら困る', expectedSurface: '飽きられたら', expectedBase: '飽きる' },
      { line: 'あとは稼いだ金を元手に', expectedSurface: '稼いだ', expectedBase: '稼ぐ' },
      { line: '相手を見定める。', expectedSurface: '見定める', expectedBase: '見定める' },
      { line: '口座から引き落とせ！', expectedSurface: '引き落とせ', expectedBase: '引き落とす' },
      { line: '食べさせられたくなかったんだ', expectedSurface: '食べさせられたくなかった', expectedBase: '食べる' },
      { line: 'お姉ちゃんに任せておきなさい！', expectedSurface: '任せておきなさい', expectedBase: '任せる' },
      { line: '逃げられると思ってるの？', expectedSurface: '思ってる', expectedBase: '思う' },
    ];

    for (const c of cases) {
      const morphemes = await analyzeWithMeCab(c.line);
      const tokens = buildTokensFromMorphemes(morphemes);
      const hit = tokens.find((t) => t.surface === c.expectedSurface);
      expect(hit, `Expected "${c.expectedSurface}" in "${c.line}"`).toBeDefined();
      expect(hit?.baseForm).toBe(c.expectedBase);
    }
  });

  it('provides instant hiragana furigana and merges verified compounds like 廃課金 without gluing だ', async () => {
    const morphemes = await analyzeWithMeCab('彼は廃課金だよ。相手を見定める。');
    const tokens = buildTokensFromMorphemes(morphemes, {}, {}, new Set(['廃課金']));

    expect(tokens.map((t) => t.surface)).toContain('廃課金');
    expect(tokens.map((t) => t.surface)).not.toContain('廃課金だ');

    const misadameru = tokens.find((t) => t.surface === '見定める');
    expect(misadameru?.reading).toBe('みさだめる');
    const aite = tokens.find((t) => t.surface === '相手');
    expect(aite?.reading).toBe('あいて');
  });

  it('matches known status across できる and 出来る', async () => {
    const vocab: Record<string, VocabEntry> = {
      できる: {
        word: 'できる',
        reading: 'できる',
        meaning: 'to be able to do',
        status: 'known',
        encounters: 3,
        firstSeenAt: 1,
        updatedAt: 2,
      },
    };
    const morphemes = await analyzeWithMeCab('それは出来るよ。');
    const tokens = buildTokensFromMorphemes(morphemes, vocab);
    expect(tokens.find((t) => t.surface === '出来る')?.status).toBe('known');
  });
});
