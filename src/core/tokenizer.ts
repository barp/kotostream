import type { Token, VocabEntry, WordStatus } from '../types';
import { deconjugate } from './deconjugator';
import { hasLocalExact, lookupLocal, PARTICLE_SET } from './dictionary';

const KANJI_REGEX = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/;
const JAPANESE_WORD_REGEX = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBFー]/;

/**
 * Auxiliary segments that Intl.Segmenter often splits off from a conjugated verb/adjective.
 * Merging these back onto the preceding stem yields natural clickable words (e.g. 食べていた, 見なかった).
 */
const MERGEABLE_AUXILIARIES = new Set([
  'て', 'で', 'た', 'だ', 'ます', 'まし', 'ませ', 'ない', 'なかっ', 'なく', 'なかれ',
  'いる', 'い', 'いた', 'てる', 'てた', 'てい', 'でい',
  'れる', 'れ', 'られる', 'られ', 'せる', 'せ', 'させる', 'させ',
  'たら', 'だら', 'ら', 'ば', 'れば',
  'たい', 'たく', 'たかっ', 'かっ', 'く', 'けれ', 'ければ', 'よう', 'おう', 'う', 'ん', 'っ', 'ず',
  'ちゃう', 'ちゃっ', 'ちゃ', 'じゃう', 'じゃっ', 'じゃ',
  'ちまう', 'ちまっ', 'ちま', 'じまう', 'じまっ', 'じま',
  'しまっ', 'しまう', 'おく', 'おい',
]);

let segmenter: Intl.Segmenter | null = null;

function getSegmenter(): Intl.Segmenter {
  if (!segmenter) {
    segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
  }
  return segmenter;
}

export function containsKanji(text: string): boolean {
  return KANJI_REGEX.test(text);
}

export function isJapaneseWord(text: string): boolean {
  return JAPANESE_WORD_REGEX.test(text);
}

export const EXPRESSION_PARTICLES = new Set(['を', 'が', 'に', 'の', 'へ', 'と', 'で', 'も']);

/**
 * Enumerates particle-chained word sequences starting at `start`, longest first:
 * 3-4 words joined by 2+ expression particles, optionally with directly adjacent words
 * (e.g. the te-form verb + noun junction in 藪+を+つついて+蛇+を+出す). Only end indexes
 * are returned — the caller verifies the exact joined surface against JMdict before merging.
 */
export function enumerateParticleChains(
  items: Array<{ surface: string; isWord: boolean }>,
  start: number,
  isChainWord: (item: { surface: string; isWord: boolean }) => boolean
): number[] {
  if (!items[start] || !isChainWord(items[start])) return [];
  const ends = new Set<number>();

  const walk = (end: number, words: number, particles: number): void => {
    if (words >= 3 && particles >= 2) ends.add(end);
    if (words >= 4) return;
    // Extend through an expression particle: W + を/が/に/の/へ/と/で/も + W
    const p = items[end + 1];
    const wAfterParticle = items[end + 2];
    if (
      p?.isWord &&
      wAfterParticle &&
      EXPRESSION_PARTICLES.has(p.surface) &&
      isChainWord(wAfterParticle)
    ) {
      walk(end + 2, words + 1, particles + 1);
    }
    // Extend to a directly adjacent word (e.g. つついて + 蛇 in 藪をつついて蛇を出す)
    const wAdjacent = items[end + 1];
    if (wAdjacent && isChainWord(wAdjacent)) {
      walk(end + 1, words + 1, particles);
    }
  };

  walk(start, 1, 0);
  return Array.from(ends).sort((a, b) => b - a);
}

/**
 * Finds adjacent Japanese word pairs (e.g. 廃+課金 -> 廃課金, 見+定める -> 見定める),
 * 3-token idiomatic expressions connected by a particle (e.g. 気+を+そらす -> 気をそらす,
 * 気+を+そらした -> 気をそらす, 手+に+入れる -> 手に入れる, 腹+が+立つ -> 腹が立つ),
 * AND longer particle-chained idioms/proverbs (e.g. 藪+を+つついて+蛇+を+出す -> 藪をつついて蛇を出す,
 * 目+に+角+を+立てる -> 目に角を立てる, 蛙+の+面+に+水 -> 蛙の面に水)
 * so the caller can verify them against JMdict/Jisho (`exactOnly: true`).
 */
export function findCandidateCompounds(tokens: Token[]): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (c: string) => {
    if (c.length >= 2 && c.length <= 12 && !seen.has(c)) {
      seen.add(c);
      candidates.push(c);
    }
  };
  const isChainWord = (t: { surface: string; isWord: boolean; status?: WordStatus } | undefined): boolean =>
    !!t && t.isWord && t.status !== 'ignored' && !PARTICLE_SET.has(t.surface);

  // 1. Particle-chained idioms & proverbs with 2-3 particle links (checked FIRST so they
  //    win the prefetch budget): 藪+を+つついて+蛇+を+出す -> 藪をつついて蛇を出す,
  //    目+に+角+を+立てる -> 目に角を立てる, 蛙+の+面+に+水 -> 蛙の面に水
  for (let i = 0; i < tokens.length; i++) {
    const ends = enumerateParticleChains(tokens, i, isChainWord);
    for (const end of ends) {
      const surface = tokens.slice(i, end + 1).map((t) => t.surface).join('');
      addCandidate(surface);
      const lastToken = tokens[end];
      if (lastToken.surface !== lastToken.baseForm) {
        // e.g. 藪をつついて蛇を出した -> candidate 藪をつついて蛇を出す
        addCandidate(tokens.slice(i, end).map((t) => t.surface).join('') + lastToken.baseForm);
      }
    }
  }

  // 2. 3-token idiomatic expressions: Word + Particle (を/が/に/の/へ/と/で/も) + Word
  for (let i = 0; i < tokens.length - 2; i++) {
    const a = tokens[i];
    const mid = tokens[i + 1];
    const c = tokens[i + 2];
    if (!a.isWord || !mid.isWord || !c.isWord) continue;
    if (!EXPRESSION_PARTICLES.has(mid.surface)) continue;
    if (a.status === 'ignored' || PARTICLE_SET.has(a.surface)) continue;
    if (c.status === 'ignored' || PARTICLE_SET.has(c.surface)) continue;

    // Prefer dictionary form of the trailing verb/adjective (e.g. 気+を+そらした -> 気をそらす)
    const joined = a.surface + mid.surface + c.baseForm;
    // Kana-written expressions (e.g. きをそらす, やぶをつつく) still count when long enough
    if (a.hasKanji || c.hasKanji || joined.length >= 5) {
      addCandidate(joined);
      if (c.surface !== c.baseForm) {
        addCandidate(a.surface + mid.surface + c.surface);
      }
    }
  }

  // 3. 2-token compounds: Word + Word (kanji compounds & compound verbs)
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (!a.isWord || !b.isWord) continue;
    if (a.status === 'ignored' || b.status === 'ignored') continue;
    if (PARTICLE_SET.has(a.surface) || PARTICLE_SET.has(b.surface)) continue;

    // Require at least one token to contain kanji so we catch both 廃+課金 and 見+定める / 取り+出す
    // (all-kana pairs like ぼく+たち are still tried when the result is at least 4 chars)
    const joined = a.surface + b.baseForm;
    if (a.hasKanji || b.hasKanji || joined.length >= 4) {
      addCandidate(joined);
      if (b.surface !== b.baseForm) {
        addCandidate(a.surface + b.surface);
      }
    }
  }

  return candidates;
}

/**
 * Looks up a word's VocabEntry across kanji and hiragana equivalents
 * (e.g. marking できる as Known also matches 出来る / 出来た, and vice versa).
 */
export function findVocabEntry(
  candidates: string[],
  reading: string | undefined,
  vocabMap: Record<string, VocabEntry>,
  readingIndex?: Map<string, VocabEntry>
): { baseForm: string; entry: VocabEntry } | null {
  // 1. Exact key match on any candidate (surface or deconjugated dictionary form)
  for (const c of candidates) {
    if (vocabMap[c]) {
      return { baseForm: c, entry: vocabMap[c] };
    }
  }

  // 2. Match via reading (e.g. 出来る has reading できる -> matches vocabMap['できる'])
  if (reading && vocabMap[reading]) {
    return { baseForm: reading, entry: vocabMap[reading] };
  }

  // 3. Reverse reading match (e.g. できる matches vocabMap['出来る'] whose reading is 'できる')
  if (readingIndex) {
    for (const c of candidates) {
      const hit = readingIndex.get(c);
      if (hit) return { baseForm: hit.word, entry: hit };
    }
    if (reading) {
      const hit = readingIndex.get(reading);
      if (hit) return { baseForm: hit.word, entry: hit };
    }
  } else {
    const candidateSet = new Set(candidates);
    if (reading) candidateSet.add(reading);
    for (const entry of Object.values(vocabMap)) {
      if (entry.reading && candidateSet.has(entry.reading)) {
        return { baseForm: entry.word, entry };
      }
    }
  }

  return null;
}

/**
 * Tokenizes a Japanese sentence into interactive tokens with base forms,
 * optional readings, and word status.
 * Adjacent kanji segments are merged ONLY when the combined compound is verified
 * to exist in a dictionary (verifiedCompounds, local dictionary, vocabMap, or readingCache).
 */
export function tokenizeJapanese(
  text: string,
  vocabMap: Record<string, VocabEntry> = {},
  readingCache: Record<string, string> = {},
  verifiedCompounds: ReadonlySet<string> = new Set()
): Token[] {
  // Build a fast reading -> VocabEntry index once per sentence (preferring 'known' > 'learning' > 'unknown')
  const readingIndex = new Map<string, VocabEntry>();
  const rank = (s: WordStatus) => (s === 'known' ? 3 : s === 'learning' ? 2 : s === 'unknown' ? 1 : 0);
  for (const entry of Object.values(vocabMap)) {
    if (!entry.reading) continue;
    const prev = readingIndex.get(entry.reading);
    if (!prev || rank(entry.status) > rank(prev.status)) {
      readingIndex.set(entry.reading, entry);
    }
  }
  const seg = getSegmenter();
  const rawSegments: Array<{ text: string; isWordLike: boolean }> = [];

  for (const part of seg.segment(text)) {
    rawSegments.push({
      text: part.segment,
      isWordLike: Boolean(part.isWordLike) && isJapaneseWord(part.segment),
    });
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
    // Also match conjugated forms of verified compound verbs (e.g. 見定めた -> 見定める)
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

  // Pass 1: Dictionary-verified compound merging (checks 3-segment then 2-segment compounds)
  const compoundMerged: Array<{ text: string; isWordLike: boolean }> = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const cur = rawSegments[i];
    const next = rawSegments[i + 1];
    const next2 = rawSegments[i + 2];

    if (
      cur.isWordLike &&
      next?.isWordLike &&
      next2?.isWordLike &&
      isVerifiedCompound(cur.text + next.text + next2.text)
    ) {
      compoundMerged.push({ text: cur.text + next.text + next2.text, isWordLike: true });
      i += 2;
      continue;
    }

    if (cur.isWordLike && next?.isWordLike && isVerifiedCompound(cur.text + next.text)) {
      compoundMerged.push({ text: cur.text + next.text, isWordLike: true });
      i += 1;
      continue;
    }

    compoundMerged.push({ ...cur });
  }

  // Pass 2: Merge verb/adjective stems with trailing auxiliary chains
  // First normalize split colloquial 〜ちまう / 〜じまう (e.g. 'ち' + 'ま' / 'まっ', 'じ' + 'ま' / 'まっ')
  const normalizedAux: Array<{ text: string; isWordLike: boolean }> = [];
  for (let i = 0; i < compoundMerged.length; i++) {
    const cur = compoundMerged[i];
    const next = compoundMerged[i + 1];
    if (
      cur.isWordLike &&
      next?.isWordLike &&
      (cur.text === 'ち' || cur.text === 'じ') &&
      (next.text === 'ま' || next.text === 'まっ' || next.text === 'まう' || next.text === 'まえ')
    ) {
      normalizedAux.push({ text: cur.text + next.text, isWordLike: true });
      i += 1;
      continue;
    }
    normalizedAux.push(cur);
  }

  const auxMerged: Array<{ text: string; isWordLike: boolean }> = [];
  for (const segItem of normalizedAux) {
    const prev = auxMerged[auxMerged.length - 1];
    const isCopulaOnNoun =
      (segItem.text === 'だ' || segItem.text === 'で') &&
      prev &&
      !prev.text.endsWith('ん') &&
      !prev.text.endsWith('い');

    if (
      prev &&
      prev.isWordLike &&
      segItem.isWordLike &&
      MERGEABLE_AUXILIARIES.has(segItem.text) &&
      !PARTICLE_SET.has(prev.text) &&
      !isCopulaOnNoun
    ) {
      prev.text += segItem.text;
    } else {
      auxMerged.push({ ...segItem });
    }
  }

  // Pass 3: Merge verified 3-token expressions (e.g. 気+を+そらす -> 気をそらす) and 2-token compounds (e.g. 見+定めた -> 見定めた)
  const merged: Array<{ text: string; isWordLike: boolean }> = [];
  for (let i = 0; i < auxMerged.length; i++) {
    const cur = auxMerged[i];
    const mid = auxMerged[i + 1];
    const third = auxMerged[i + 2];
    if (
      cur.isWordLike &&
      mid?.isWordLike &&
      third?.isWordLike &&
      EXPRESSION_PARTICLES.has(mid.text) &&
      isVerifiedCompound(cur.text + mid.text + third.text)
    ) {
      merged.push({ text: cur.text + mid.text + third.text, isWordLike: true });
      i += 2;
      continue;
    }
    if (cur.isWordLike && mid?.isWordLike && isVerifiedCompound(cur.text + mid.text)) {
      merged.push({ text: cur.text + mid.text, isWordLike: true });
      i += 1;
      continue;
    }
    merged.push(cur);
  }

  return merged.map((item) => {
    if (!item.isWordLike) {
      return {
        surface: item.text,
        baseForm: item.text,
        isWord: false,
        hasKanji: false,
        status: 'ignored' as WordStatus,
      };
    }

    const candidates = deconjugate(item.text);
    const localEntry = lookupLocal(item.text);

    const resolvedReading =
      readingCache[item.text] ||
      candidates.map((c) => readingCache[c]).find(Boolean) ||
      localEntry?.reading;

    const vocabMatch = findVocabEntry(candidates, resolvedReading, vocabMap, readingIndex);

    let baseForm = vocabMatch?.baseForm ?? localEntry?.word ?? item.text;
    const vocabHit = vocabMatch?.entry;

    const hasKanji = containsKanji(item.text);
    const reading = vocabHit?.reading || resolvedReading;

    let status: WordStatus = 'unknown';
    if (vocabHit) {
      status = vocabHit.status;
    } else if (PARTICLE_SET.has(item.text) || PARTICLE_SET.has(baseForm)) {
      status = 'ignored';
    }

    return {
      surface: item.text,
      baseForm,
      reading: hasKanji ? reading : undefined,
      isWord: true,
      hasKanji,
      status,
    };
  });
}
