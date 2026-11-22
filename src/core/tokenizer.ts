import type { Token, VocabEntry, WordStatus } from '../types';
import { deconjugate } from './deconjugator';
import { hasLocalExact, lookupLocal, PARTICLE_SET } from './dictionary';

const KANJI_REGEX = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/;
const PURE_KANJI_REGEX = /^[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF々]+$/;
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
  'たい', 'たく', 'たかっ', 'かっ', 'く', 'けれ', 'ければ', 'よう', 'う', 'ん', 'ず',
  'ちゃう', 'ちゃっ', 'ちゃ', 'じゃう', 'じゃっ', 'じゃ', 'しまっ', 'しまう', 'おく', 'おい',
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

/**
 * Finds adjacent kanji word pairs (e.g. 廃 + 課金 -> 廃課金) that could be a real
 * dictionary compound word, so the caller can verify them against JMdict/Jisho.
 */
export function findCandidateCompounds(tokens: Token[]): string[] {
  const candidates: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (!a.isWord || !b.isWord) continue;
    if (a.status === 'ignored' || b.status === 'ignored') continue;
    if (!PURE_KANJI_REGEX.test(a.surface) || !PURE_KANJI_REGEX.test(b.surface)) continue;

    const combined = a.surface + b.surface;
    if (combined.length >= 2 && combined.length <= 6) {
      candidates.push(combined);
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

  const isVerifiedCompound = (word: string): boolean =>
    verifiedCompounds.has(word) ||
    hasLocalExact(word) ||
    Boolean(vocabMap[word]) ||
    Boolean(readingCache[word]);

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
  const merged: Array<{ text: string; isWordLike: boolean }> = [];
  for (const segItem of compoundMerged) {
    const prev = merged[merged.length - 1];
    const isCopulaOnNoun =
      (segItem.text === 'だ' || segItem.text === 'で') &&
      prev &&
      !prev.text.endsWith('ん');

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
      merged.push({ ...segItem });
    }
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
