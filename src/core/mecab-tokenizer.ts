import type { Token, VocabEntry, WordStatus } from '../types';
import { deconjugate } from './deconjugator';
import { hasLocalExact, lookupLocal, PARTICLE_SET } from './dictionary';
import { containsKanji, findVocabEntry, isJapaneseWord } from './tokenizer';

export interface KuromojiMorpheme {
  surface_form: string;
  pos: string;
  pos_detail_1: string;
  pos_detail_2?: string;
  conjugated_type?: string;
  conjugated_form?: string;
  basic_form: string;
  reading?: string;
  pronunciation?: string;
}

/**
 * Converts Katakana readings from MeCab/IPADIC into Hiragana for clean furigana display.
 */
export function katakanaToHiragana(str: string): string {
  return str.replace(/[\u30A1-\u30F6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

const TE_CONNECTORS = new Set(['て', 'で', 'ちゃ', 'じゃ', 'ば']);

/**
 * Merges raw MeCab / Kuromoji IPADIC morphemes into natural Japanese immersion tokens
 * with accurate verb/adjective conjugation chains, base forms, furigana readings,
 * and dictionary-verified compound merging.
 */
export function buildTokensFromMorphemes(
  morphemes: KuromojiMorpheme[],
  vocabMap: Record<string, VocabEntry> = {},
  readingCache: Record<string, string> = {},
  verifiedCompounds: ReadonlySet<string> = new Set()
): Token[] {
  // Fast reading -> VocabEntry index for kanji/hiragana equivalence (できる <-> 出来る)
  const readingIndex = new Map<string, VocabEntry>();
  const rank = (s: WordStatus) => (s === 'known' ? 3 : s === 'learning' ? 2 : s === 'unknown' ? 1 : 0);
  for (const entry of Object.values(vocabMap)) {
    if (!entry.reading) continue;
    const prev = readingIndex.get(entry.reading);
    if (!prev || rank(entry.status) > rank(prev.status)) {
      readingIndex.set(entry.reading, entry);
    }
  }

  const isVerifiedCompound = (word: string): boolean => {
    if (
      verifiedCompounds.has(word) ||
      hasLocalExact(word) ||
      Boolean(vocabMap[word]) ||
      Boolean(readingCache[word])
    ) {
      return true;
    }
    for (const base of deconjugate(word)) {
      if (
        base !== word &&
        (verifiedCompounds.has(base) || hasLocalExact(base) || Boolean(vocabMap[base]))
      ) {
        return true;
      }
    }
    return false;
  };

  interface MergedUnit {
    surface: string;
    baseForm: string;
    reading: string;
    pos: string;
    posDetail1: string;
    isWord: boolean;
  }

  const units: MergedUnit[] = [];

  for (let i = 0; i < morphemes.length; i++) {
    const m = morphemes[i];
    const surface = m.surface_form;
    const reading = m.reading && m.reading !== '*' ? katakanaToHiragana(m.reading) : surface;
    const basic = m.basic_form && m.basic_form !== '*' ? m.basic_form : surface;

    // 1. Verb or i-adjective head -> absorb full conjugation chain (passive, causative, progressive, negative, past, volitional, colloquial 〜ちまう/〜ちゃう)
    if (
      (m.pos === '動詞' && m.pos_detail_1 === '自立') ||
      (m.pos === '形容詞' && m.pos_detail_1 === '自立')
    ) {
      let combinedSurface = surface;
      let combinedReading = reading;
      let lastForm = m.conjugated_form ?? '';

      while (i + 1 < morphemes.length) {
        const next = morphemes[i + 1];
        const nextRead =
          next.reading && next.reading !== '*' ? katakanaToHiragana(next.reading) : next.surface_form;

        // Auxiliary verbs (た, だ, たら, ない, ます, う, よう, たい, ぬ, ん, etc.)
        // Don't attach copula だ/です onto an already-finished dictionary form (基本形)
        const isAuxiliary =
          next.pos === '助動詞' &&
          !((next.surface_form === 'だ' || next.surface_form === 'です') && lastForm === '基本形');

        // Verb suffixes & non-independent verbs (られ, れ, させ, せ, ちまお, ちゃっ, いる, てる, しまう, おく)
        const isAttachedVerb =
          next.pos === '動詞' && (next.pos_detail_1 === '接尾' || next.pos_detail_1 === '非自立');

        // Attached non-independent adjectives (ない, なかった)
        const isAttachedAdj =
          next.pos === '形容詞' && next.pos_detail_1 === '非自立';

        // Te-form / conditional connectors (て, で, ちゃ, じゃ, ば)
        const isTeConnector =
          next.pos === '助詞' &&
          next.pos_detail_1 === '接続助詞' &&
          TE_CONNECTORS.has(next.surface_form);

        if (isAuxiliary || isAttachedVerb || isAttachedAdj || isTeConnector) {
          combinedSurface += next.surface_form;
          combinedReading += nextRead;
          lastForm = next.conjugated_form ?? lastForm;
          i++;
        } else {
          break;
        }
      }

      units.push({
        surface: combinedSurface,
        baseForm: basic,
        reading: combinedReading,
        pos: m.pos,
        posDetail1: m.pos_detail_1,
        isWord: isJapaneseWord(combinedSurface),
      });
      continue;
    }

    // 2. Honorific prefix お/ご + Noun (e.g. お + 姉ちゃん -> お姉ちゃん, ご + 飯 -> ご飯)
    if (
      m.pos === '接頭詞' &&
      m.pos_detail_1 === '名詞接続' &&
      (surface === 'お' || surface === 'ご') &&
      i + 1 < morphemes.length &&
      morphemes[i + 1].pos === '名詞'
    ) {
      const next = morphemes[i + 1];
      const nextRead =
        next.reading && next.reading !== '*' ? katakanaToHiragana(next.reading) : next.surface_form;
      units.push({
        surface: surface + next.surface_form,
        baseForm: surface + (next.basic_form !== '*' ? next.basic_form : next.surface_form),
        reading: reading + nextRead,
        pos: '名詞',
        posDetail1: next.pos_detail_1,
        isWord: true,
      });
      i++;
      continue;
    }

    // 3. Everything else (nouns, adverbs, particles, punctuation, etc.)
    const isSymbol = m.pos === '記号' || !isJapaneseWord(surface);
    units.push({
      surface,
      baseForm: basic,
      reading,
      pos: m.pos,
      posDetail1: m.pos_detail_1,
      isWord: !isSymbol,
    });
  }

  // Pass 2: Dictionary-verified compound merging (e.g. 廃 + 課金 -> 廃課金)
  const finalUnits: MergedUnit[] = [];
  for (let i = 0; i < units.length; i++) {
    const cur = units[i];
    const next = units[i + 1];
    if (cur.isWord && next?.isWord && isVerifiedCompound(cur.surface + next.surface)) {
      const combined = cur.surface + next.surface;
      finalUnits.push({
        surface: combined,
        baseForm: combined,
        reading: readingCache[combined] || cur.reading + next.reading,
        pos: cur.pos,
        posDetail1: cur.posDetail1,
        isWord: true,
      });
      i++;
      continue;
    }
    finalUnits.push(cur);
  }

  return finalUnits.map((u) => {
    if (!u.isWord) {
      return {
        surface: u.surface,
        baseForm: u.surface,
        isWord: false,
        hasKanji: false,
        status: 'ignored' as WordStatus,
      };
    }

    const candidates = Array.from(new Set([u.baseForm, u.surface, ...deconjugate(u.surface)]));
    const localEntry = lookupLocal(u.baseForm) ?? lookupLocal(u.surface);

    // For baseForm reading (used to match できる <-> 出来る), prefer dictionary reading or unit reading
    const baseReading =
      readingCache[u.baseForm] ||
      localEntry?.reading ||
      (u.surface === u.baseForm ? u.reading : undefined);

    const vocabMatch = findVocabEntry(candidates, baseReading, vocabMap, readingIndex);
    const baseForm = vocabMatch?.baseForm ?? localEntry?.word ?? u.baseForm;
    const vocabHit = vocabMatch?.entry;

    const hasKanji = containsKanji(u.surface);
    const displayReading =
      (u.surface === baseForm ? vocabHit?.reading : undefined) ||
      u.reading ||
      readingCache[baseForm] ||
      localEntry?.reading;

    let status: WordStatus = 'unknown';
    if (vocabHit) {
      status = vocabHit.status;
    } else if (
      u.pos === '助詞' ||
      u.pos === '助動詞' ||
      u.pos === 'フィラー' ||
      PARTICLE_SET.has(u.surface) ||
      PARTICLE_SET.has(baseForm)
    ) {
      status = 'ignored';
    }

    return {
      surface: u.surface,
      baseForm,
      reading: hasKanji ? displayReading : undefined,
      isWord: true,
      hasKanji,
      status,
    };
  });
}
