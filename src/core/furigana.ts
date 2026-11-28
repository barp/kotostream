import { katakanaToHiragana } from './mecab-tokenizer';

/**
 * Per-kanji-run ruby alignment — proper Japanese furigana typography.
 *
 * Instead of stretching one reading across an entire word (e.g. たべた over 食べた),
 * the word is split into kanji runs and plain kana runs, and each kanji run gets only
 * ITS portion of the reading (食[た]べた). The kana parts of the surface act as
 * alignment anchors inside the full reading, since okurigana appears verbatim in it.
 */
export interface FuriganaSegment {
  /** Base text shown inline */
  surface: string;
  /** Reading rendered ABOVE this segment (empty for plain segments) */
  reading: string;
  /** True when the segment should render as <ruby> */
  isKanji: boolean;
}

/** Iteration/substitute marks that belong to a kanji run for ruby purposes. */
const KANJI_MARKS = new Set(['々', '〆', 'ヶ']);

function isKanjiChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0xf900 && code <= 0xfaff) // CJK Compatibility Ideographs
  ) {
    return true;
  }
  return KANJI_MARKS.has(ch);
}

/**
 * Splits a word into ruby segments so furigana sits only above its KANJI runs:
 *   食べた / たべた     -> 食[た] + べた
 *   引き落とす / ひきおとす -> 引[ひ] + き + 落[お] + とす
 *   見定める / みさだめる  -> 見定[みさだ] + める   (adjacent kanji share one ruby)
 *   気をそらす / きをそらす -> 気[き] + をそらす
 *   来る / くる        -> 来[くる]
 *
 * Kana runs in the surface must appear (script-normalized) in the reading at the
 * matching position; when alignment fails the whole word falls back to a single
 * full-width ruby so no reading is ever lost.
 */
export function alignFuriganaSegments(surface: string, reading: string): FuriganaSegment[] {
  if (!surface || !reading || surface === reading) {
    return [{ surface, reading: '', isKanji: false }];
  }

  interface Run {
    text: string;
    kanji: boolean;
  }
  const runs: Run[] = [];
  for (const ch of surface) {
    const kanji = isKanjiChar(ch);
    const last = runs[runs.length - 1];
    if (last && last.kanji === kanji) last.text += ch;
    else runs.push({ text: ch, kanji });
  }

  if (!runs.some((r) => r.kanji)) {
    return [{ surface, reading: '', isKanji: false }];
  }

  const fallback: FuriganaSegment[] = [{ surface, reading, isKanji: true }];

  const normReading = katakanaToHiragana(reading);
  const segments: FuriganaSegment[] = [];
  let ri = 0;

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];

    if (!run.kanji) {
      // Kana anchor: must match the reading at the current pointer (script-normalized)
      const len = run.text.length;
      if (normReading.slice(ri, ri + len) !== katakanaToHiragana(run.text)) {
        return fallback;
      }
      segments.push({ surface: run.text, reading: '', isKanji: false });
      ri += len;
      continue;
    }

    // Kanji run: its reading spans from the pointer up to the next kana anchor
    // (or to the end of the reading when no anchor follows).
    let end: number;
    const next = runs[i + 1];
    if (next && !next.kanji) {
      const anchorIdx = normReading.indexOf(katakanaToHiragana(next.text), ri + 1);
      if (anchorIdx === -1) return fallback;
      end = anchorIdx;
    } else {
      end = reading.length;
    }

    const runReading = reading.slice(ri, end);
    if (!runReading) return fallback;
    segments.push({ surface: run.text, reading: runReading, isKanji: true });
    ri = end;
  }

  // The entire reading must have been consumed by the segments
  if (ri !== reading.length) return fallback;

  return segments;
}
