import type { Token, VocabEntry, WordStatus } from '../types';
import { deconjugate } from './deconjugator';
import { hasLocalExact, lookupLocal, PARTICLE_SET } from './dictionary';
import { containsKanji, enumerateParticleChains, EXPRESSION_PARTICLES, findVocabEntry, isJapaneseWord } from './tokenizer';

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
const SEPARATE_COPULA_SURFACES = new Set(['だ', 'です', 'だろ', 'だろう', 'でしょ', 'でしょう', 'なら']);
const NON_WORD_KANA_REGEX = /^[ぁぃぅぇぉっゃゅょァィゥェォッャュョー〜～]+$/;

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

  /**
   * Longest-first particle chains (3-4 words, 2+ particle links): full JMdict
   * proverbs/idioms such as 藪+を+つついて+蛇+を+出す -> 藪をつついて蛇を出す,
   * 目+に+角+を+立てる -> 目に角を立てる, 蛙+の+面+に+水 -> 蛙の面に水.
   * Only merges when the exact expression is verified.
   */
  const tryChainMerge = (
    start: number
  ): {
    end: number;
    surface: string;
    baseForm: string;
    reading: string;
    pos: string;
    posDetail1: string;
  } | null => {
    const first = units[start];
    if (!first?.isWord || PARTICLE_SET.has(first.surface)) return null;

    const isUnitChainWord = (u: { surface: string; isWord: boolean }): boolean =>
      u.isWord && !PARTICLE_SET.has(u.surface);

    for (const end of enumerateParticleChains(units, start, isUnitChainWord)) {
      const parts = units.slice(start, end + 1);
      const surface = parts.map((u) => u.surface).join('');
      if (surface.length < 4 || surface.length > 12) continue;
      const lastUnit = units[end];
      const withLastBase = units.slice(start, end).map((u) => u.surface).join('') + lastUnit.baseForm;
      const matchedBase = isVerifiedCompound(withLastBase);
      const matchedSurface = matchedBase || isVerifiedCompound(surface);
      if (!matchedSurface) continue;
      const resolvedBase = matchedBase ? withLastBase : surface;
      return {
        end,
        surface,
        baseForm: resolvedBase,
        reading:
          readingCache[surface] ||
          (surface === resolvedBase ? readingCache[resolvedBase] : undefined) ||
          parts.map((u) => u.reading).join(''),
        pos: lastUnit.pos,
        posDetail1: lastUnit.posDetail1,
      };
    }
    return null;
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

    // 1. Verb or i-adjective head -> absorb conjugation chain
    if (
      (m.pos === '動詞' && m.pos_detail_1 === '自立') ||
      (m.pos === '形容詞' && m.pos_detail_1 === '自立')
    ) {
      let combinedSurface = surface;
      let combinedReading = reading;
      let lastForm = m.conjugated_form ?? '';
      let lastSurface = surface;

      while (i + 1 < morphemes.length) {
        const next = morphemes[i + 1];
        const nextRead =
          next.reading && next.reading !== '*' ? katakanaToHiragana(next.reading) : next.surface_form;
        const nextBasic = next.basic_form && next.basic_form !== '*' ? next.basic_form : next.surface_form;

        // Auxiliary verbs (た, だ, たら, ない, ねえ, ます, う, よう, たい, ぬ, ん)
        // Do NOT attach sentence-final copulas (だろ/でしょ/です/だ after 基本形) onto a finished verb
        const isSentenceCopula =
          SEPARATE_COPULA_SURFACES.has(next.surface_form) &&
          !(next.surface_form === 'だ' && lastForm !== '基本形' && !lastSurface.endsWith('ば'));
        const isAuxiliary = next.pos === '助動詞' && !isSentenceCopula;

        // Verb suffixes & non-independent verbs (られ, れ, させ, せ, ちまお, ちゃっ, いる, てる, しまう, おく)
        const isAttachedVerb =
          next.pos === '動詞' &&
          (next.pos_detail_1 === '接尾' || next.pos_detail_1 === '非自立') &&
          !lastSurface.endsWith('ば');

        // Only attach negative non-independent adjectives (ない / ねえ), NOT いい / ほしい!
        const isAttachedNegAdj =
          next.pos === '形容詞' &&
          next.pos_detail_1 === '非自立' &&
          (nextBasic === 'ない' || next.surface_form === 'ねえ' || next.surface_form === 'ねぇ') &&
          !lastSurface.endsWith('ば');

        // Te-form / conditional connectors (て, で, ちゃ, じゃ, ば)
        const isTeConnector =
          next.pos === '助詞' &&
          next.pos_detail_1 === '接続助詞' &&
          TE_CONNECTORS.has(next.surface_form);

        if (isAuxiliary || isAttachedVerb || isAttachedNegAdj || isTeConnector) {
          combinedSurface += next.surface_form;
          combinedReading += nextRead;
          lastForm = next.conjugated_form ?? lastForm;
          lastSurface = next.surface_form;
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
        isWord: isJapaneseWord(combinedSurface) && !NON_WORD_KANA_REGEX.test(combinedSurface),
      });
      continue;
    }

    // 2. Standalone copula/auxiliary chains (だっ+た -> だった, でし+た -> でした, でしょ+う -> でしょう, だろ+う -> だろう)
    if (m.pos === '助動詞' && i + 1 < morphemes.length && morphemes[i + 1].pos === '助動詞') {
      let combinedSurface = surface;
      let combinedReading = reading;
      while (i + 1 < morphemes.length && morphemes[i + 1].pos === '助動詞') {
        const next = morphemes[i + 1];
        const nextRead =
          next.reading && next.reading !== '*' ? katakanaToHiragana(next.reading) : next.surface_form;
        combinedSurface += next.surface_form;
        combinedReading += nextRead;
        i++;
      }
      units.push({
        surface: combinedSurface,
        baseForm: combinedSurface,
        reading: combinedReading,
        pos: '助動詞',
        posDetail1: '*',
        isWord: true,
      });
      continue;
    }

    // 3. Honorific prefix お/ご + Noun (e.g. お + 姉ちゃん -> お姉ちゃん, ご + 飯 -> ご飯)
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

    // 4. Everything else (nouns, adverbs, particles, punctuation, stray small kana)
    const isSymbol =
      m.pos === '記号' || !isJapaneseWord(surface) || NON_WORD_KANA_REGEX.test(surface);
    units.push({
      surface,
      baseForm: basic,
      reading,
      pos: m.pos,
      posDetail1: m.pos_detail_1,
      isWord: !isSymbol,
    });
  }

  // Pass 2: Dictionary-verified expression & compound merging
  // - Particle-chained idioms/proverbs, longest first (藪+を+つついて+蛇+を+出す -> 藪をつついて蛇を出す,
  //   蛙+の+面+に+水, 目+に+角+を+立てる)
  // - 3-unit idiomatic expressions (e.g. 気 + を + そらす -> 気をそらす, 気 + を + そらした -> surface 気をそらした / baseForm 気をそらす)
  // - 2-unit compounds (e.g. 廃 + 課金 -> 廃課金, 依頼 + 人 -> 依頼人, 見 + 定めた -> baseForm 見定める)
  const finalUnits: MergedUnit[] = [];
  for (let i = 0; i < units.length; i++) {
    const cur = units[i];
    const mid = units[i + 1];
    const third = units[i + 2];

    // 0. Longest-first particle chains (2-3 links) verified against JMdict
    const chain = tryChainMerge(i);
    if (chain) {
      finalUnits.push({
        surface: chain.surface,
        baseForm: chain.baseForm,
        reading: chain.reading,
        pos: chain.pos,
        posDetail1: chain.posDetail1,
        isWord: true,
      });
      i = chain.end;
      continue;
    }

    if (
      cur.isWord &&
      mid?.isWord &&
      third?.isWord &&
      EXPRESSION_PARTICLES.has(mid.surface)
    ) {
      const tripleBase = cur.surface + mid.surface + third.baseForm;
      const tripleSurface = cur.surface + mid.surface + third.surface;
      const matchedBase = isVerifiedCompound(tripleBase);
      const matchedSurface = matchedBase || isVerifiedCompound(tripleSurface);
      if (matchedSurface) {
        const resolvedBase = matchedBase ? tripleBase : tripleSurface;
        finalUnits.push({
          surface: tripleSurface,
          baseForm: resolvedBase,
          reading:
            readingCache[tripleSurface] ||
            (tripleSurface === resolvedBase ? readingCache[resolvedBase] : undefined) ||
            cur.reading + mid.reading + third.reading,
          pos: third.pos,
          posDetail1: third.posDetail1,
          isWord: true,
        });
        i += 2;
        continue;
      }
    }

    if (cur.isWord && mid?.isWord) {
      const pairBase = cur.surface + mid.baseForm;
      const pairSurface = cur.surface + mid.surface;
      const matchedBase = isVerifiedCompound(pairBase);
      const matchedSurface = matchedBase || isVerifiedCompound(pairSurface);
      if (matchedSurface) {
        const resolvedBase = matchedBase ? pairBase : pairSurface;
        finalUnits.push({
          surface: pairSurface,
          baseForm: resolvedBase,
          reading:
            readingCache[pairSurface] ||
            (pairSurface === resolvedBase ? readingCache[resolvedBase] : undefined) ||
            cur.reading + mid.reading,
          pos: cur.pos,
          posDetail1: cur.posDetail1,
          isWord: true,
        });
        i += 1;
        continue;
      }
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

    const candidates = Array.from(new Set([u.baseForm, u.surface, ...deconjugate(u.baseForm), ...deconjugate(u.surface)]));
    const localEntry = lookupLocal(u.baseForm) ?? lookupLocal(u.surface);

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

    const isGrammarNominalizer =
      u.pos === '名詞' && u.posDetail1 === '非自立' && (u.surface === 'ん' || u.surface === 'の');

    let status: WordStatus = 'unknown';
    if (vocabHit) {
      status = vocabHit.status;
    } else if (
      u.pos === '助詞' ||
      u.pos === '助動詞' ||
      u.pos === 'フィラー' ||
      isGrammarNominalizer ||
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
