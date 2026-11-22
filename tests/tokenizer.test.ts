import { describe, expect, it } from 'vitest';
import { findCandidateCompounds, tokenizeJapanese } from '../src/core/tokenizer';
import type { VocabEntry } from '../src/types';

describe('tokenizeJapanese', () => {
  it('tokenizes Japanese sentences and identifies kanji, readings, and particles', () => {
    const tokens = tokenizeJapanese('今日は映画を見た。');
    const surfaces = tokens.map((t) => t.surface);

    expect(surfaces).toContain('今日');
    expect(surfaces).toContain('映画');

    const kyou = tokens.find((t) => t.surface === '今日');
    expect(kyou?.hasKanji).toBe(true);
    expect(kyou?.reading).toBe('きょう');
    expect(kyou?.status).toBe('unknown');

    const wa = tokens.find((t) => t.surface === 'は');
    expect(wa?.status).toBe('ignored');
  });

  it('applies user vocab status to known and learning words', () => {
    const vocab: Record<string, VocabEntry> = {
      映画: {
        word: '映画',
        reading: 'えいが',
        meaning: 'movie',
        status: 'known',
        encounters: 5,
        firstSeenAt: 1,
        updatedAt: 2,
      },
      見る: {
        word: '見る',
        reading: 'みる',
        meaning: 'to see',
        status: 'learning',
        encounters: 2,
        firstSeenAt: 1,
        updatedAt: 2,
      },
    };

    const tokens = tokenizeJapanese('映画を見た', vocab);
    expect(tokens.find((t) => t.baseForm === '映画')?.status).toBe('known');
    expect(tokens.find((t) => t.baseForm === '見る')?.status).toBe('learning');
  });

  it('merges compounds ONLY when verified in the dictionary, never blindly', () => {
    // Before dictionary verification: 廃 and 課金 remain separate, and 廃課金 is surfaced as a candidate to verify
    const unverified = tokenizeJapanese('彼は廃課金だよ。');
    expect(unverified.map((t) => t.surface)).not.toContain('廃課金');
    expect(findCandidateCompounds(unverified)).toContain('廃課金');

    // Non-words like 大映画 are NOT blindly merged
    const nonWord = tokenizeJapanese('大映画を見る');
    expect(nonWord.map((t) => t.surface)).not.toContain('大映画');

    // Once JMdict/Jisho confirms 廃課金 is a real word, it merges cleanly (without gluing だ)
    const verified = tokenizeJapanese('彼は廃課金だよ。', {}, {}, new Set(['廃課金']));
    expect(verified.map((t) => t.surface)).toContain('廃課金');
    expect(verified.map((t) => t.surface)).not.toContain('廃課金だ');
  });

  it('recognizes known status across kanji and hiragana equivalents (できる <-> 出来る)', () => {
    const knownKana: Record<string, VocabEntry> = {
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
    const kanjiTokens = tokenizeJapanese('それは出来るよ。出来た！', knownKana);
    expect(kanjiTokens.find((t) => t.surface === '出来る')?.status).toBe('known');
    expect(kanjiTokens.find((t) => t.surface === '出来た')?.status).toBe('known');

    const knownKanji: Record<string, VocabEntry> = {
      出来る: {
        word: '出来る',
        reading: 'できる',
        meaning: 'to be able to do',
        status: 'known',
        encounters: 3,
        firstSeenAt: 1,
        updatedAt: 2,
      },
      可愛い: {
        word: '可愛い',
        reading: 'かわいい',
        meaning: 'cute',
        status: 'known',
        encounters: 2,
        firstSeenAt: 1,
        updatedAt: 2,
      },
    };
    const kanaTokens = tokenizeJapanese('できた！かわいいね', knownKanji);
    expect(kanaTokens.find((t) => t.surface === 'できた')?.status).toBe('known');
    expect(kanaTokens.find((t) => t.surface === 'かわいい')?.status).toBe('known');
  });

  it('keeps chained verb conjugations and godan -gu past/te forms as single tokens', () => {
    const tokens = tokenizeJapanese('すぐに飽きられたら困るよ。');
    expect(tokens.map((t) => t.surface)).toContain('飽きられたら');

    const kaseida = tokenizeJapanese('お金を稼いだ。海で泳いで帰った。');
    expect(kaseida.map((t) => t.surface)).toContain('稼いだ');
    expect(kaseida.map((t) => t.surface)).toContain('泳いで');
  });
});
