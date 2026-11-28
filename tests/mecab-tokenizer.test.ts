import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeWithMeCab, getMeCabTokenizer } from '../src/background/mecab';
import { buildTokensFromMorphemes, katakanaToHiragana } from '../src/core/mecab-tokenizer';
import { findCandidateCompounds } from '../src/core/tokenizer';
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
      { line: '金が引き落とせねえんだよ！', expectedSurface: '引き落とせねえ', expectedBase: '引き落とせる' },
      { line: '変えちまえばいいんだよ', expectedSurface: '変えちまえば', expectedBase: '変える' },
      { line: '混ざっちまったら終わりだ', expectedSurface: '混ざっちまったら', expectedBase: '混ざる' },
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

  it('merges split copulas (だった/でしょう/だろう) and ignores grammar ん/の and stray small kana', async () => {
    const m1 = await analyzeWithMeCab('そうだったんでしょう？なっ！');
    const t1 = buildTokensFromMorphemes(m1);
    expect(t1.map((t) => t.surface)).toContain('だった');
    expect(t1.map((t) => t.surface)).toContain('でしょう');
    expect(t1.find((t) => t.surface === 'ん')?.status).toBe('ignored');
    for (const tok of t1) {
      if (/^[ぁぃぅぇぉっ]+$/.test(tok.surface)) {
        expect(tok.isWord).toBe(false);
      }
    }
  });

  it('discovers and merges 3-token idiomatic expressions like 気をそらす (including conjugated forms)', async () => {
    const mPlain = await analyzeWithMeCab('敵の気をそらすんだ。');
    const initialPlain = buildTokensFromMorphemes(mPlain);
    expect(findCandidateCompounds(initialPlain)).toContain('気をそらす');

    const mergedPlain = buildTokensFromMorphemes(mPlain, {}, {}, new Set(['気をそらす']));
    const hitPlain = mergedPlain.find((t) => t.surface === '気をそらす');
    expect(hitPlain).toBeDefined();
    expect(hitPlain?.baseForm).toBe('気をそらす');
    expect(hitPlain?.reading).toBe('きをそらす');

    // Conjugated form: 気をそらした -> candidate 気をそらす -> merged surface 気をそらした, baseForm 気をそらす
    const mPast = await analyzeWithMeCab('一瞬だけ気をそらした。');
    const initialPast = buildTokensFromMorphemes(mPast);
    expect(findCandidateCompounds(initialPast)).toContain('気をそらす');

    const mergedPast = buildTokensFromMorphemes(mPast, {}, {}, new Set(['気をそらす']));
    const hitPast = mergedPast.find((t) => t.surface === '気をそらした');
    expect(hitPast).toBeDefined();
    expect(hitPast?.baseForm).toBe('気をそらす');
    expect(hitPast?.reading).toBe('きをそらした');
  });

  it('merges chained proverbs like 藪をつついて蛇を出す (incl. conjugated tail) and idioms 目に角を立てる / 蛙の面に水', async () => {
    // 藪+を+つついて+蛇+を+出す — te-form verb + noun junction inside the chain
    const m = await analyzeWithMeCab('藪をつついて蛇を出す');
    const initial = buildTokensFromMorphemes(m);
    expect(findCandidateCompounds(initial)[0]).toBe('藪をつついて蛇を出す');

    const merged = buildTokensFromMorphemes(m, {}, {}, new Set(['藪をつついて蛇を出す']));
    const hit = merged.find((t) => t.surface === '藪をつついて蛇を出す');
    expect(hit).toBeDefined();
    expect(hit?.baseForm).toBe('藪をつついて蛇を出す');
    expect(hit?.reading).toBe('やぶをつついてへびをだす');
    expect(hit?.isWord).toBe(true);

    // Conjugated tail: 藪をつついて蛇を出した -> baseForm 藪をつついて蛇を出す
    const mPast = await analyzeWithMeCab('藪をつついて蛇を出した');
    const mergedPast = buildTokensFromMorphemes(mPast, {}, {}, new Set(['藪をつついて蛇を出す']));
    const hitPast = mergedPast.find((t) => t.surface === '藪をつついて蛇を出した');
    expect(hitPast).toBeDefined();
    expect(hitPast?.baseForm).toBe('藪をつついて蛇を出す');

    // 目+に+角+を+立てる — plain 3-word chain idiom
    const mMoku = await analyzeWithMeCab('目に角を立てる');
    expect(buildTokensFromMorphemes(mMoku, {}, {}, new Set(['目に角を立てる'])).map((t) => t.surface)).toContain('目に角を立てる');

    // 蛙+の+面+に+水 merges cleanly WITHOUT swallowing the trailing copula だ
    const mKaeru = await analyzeWithMeCab('蛙の面に水だ');
    const kaeru = buildTokensFromMorphemes(mKaeru, {}, {}, new Set(['蛙の面に水']));
    expect(kaeru.map((t) => t.surface)).toContain('蛙の面に水');
    expect(kaeru.map((t) => t.surface)).not.toContain('蛙の面に水だ');
  });

  it('recognizes all-kana expressions like きをそらす and never merges unverified chains', async () => {
    // Kana-written expression (casual subtitle style): き+を+そらす -> きをそらす
    const mKana = await analyzeWithMeCab('きをそらす');
    expect(findCandidateCompounds(buildTokensFromMorphemes(mKana))).toContain('きをそらす');
    const mergedKana = buildTokensFromMorphemes(mKana, {}, {}, new Set(['きをそらす']));
    expect(mergedKana.map((t) => t.surface)).toContain('きをそらす');

    // An unverified chain (やぶをつついて蛇が出る is NOT in JMdict) stays split
    const m = await analyzeWithMeCab('やぶをつついて蛇が出るかもよ');
    const tokens = buildTokensFromMorphemes(m);
    expect(tokens.map((t) => t.surface)).not.toContain('やぶをつついて蛇が出る');
    // Its candidate is still surfaced for Jisho verification (which will reject it)
    expect(findCandidateCompounds(tokens)).toContain('やぶをつついて蛇が出る');
  });

  it('propagates popover Known/Learning status changes instantly on re-render with cached morphemes', async () => {
    const m = await analyzeWithMeCab('敵の気をそらすんだ。');
    const verified = new Set(['気をそらす']);

    // Initially the merged expression is unknown (red underline)
    const before = buildTokensFromMorphemes(m, {}, {}, verified);
    expect(before.find((t) => t.surface === '気をそらす')?.status).toBe('unknown');

    // User clicks "Learning" in the popover → setWordStatus updates the vocab map…
    const vocab: Record<string, VocabEntry> = {
      気をそらす: {
        word: '気をそらす',
        reading: 'きをそらす',
        meaning: 'to divert (someone) attention',
        status: 'learning',
        encounters: 1,
        firstSeenAt: 1,
        updatedAt: 2,
      },
    };

    // …and a re-render from the SAME cached morphemes must reflect it instantly
    const afterLearning = buildTokensFromMorphemes(m, vocab, {}, verified);
    expect(afterLearning.find((t) => t.surface === '気をそらす')?.status).toBe('learning');

    // Marking it Known updates again (underline disappears)
    vocab['気をそらす'] = { ...vocab['気をそらす'], status: 'known', updatedAt: 3 };
    const afterKnown = buildTokensFromMorphemes(m, vocab, {}, verified);
    expect(afterKnown.find((t) => t.surface === '気をそらす')?.status).toBe('known');

    // A conjugated surface of the same expression picks up the status too (readingIndex aliasing)
    const mPast = await analyzeWithMeCab('一瞬だけ気をそらした。');
    const pastKnown = buildTokensFromMorphemes(mPast, vocab, {}, verified);
    expect(pastKnown.find((t) => t.surface === '気をそらした')?.status).toBe('known');
  });
});
