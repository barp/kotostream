/**
 * Filters out common Whisper / ASR hallucinations in Japanese audio
 * (especially during background music, silence, or sound effects).
 */

const EXACT_HALLUCINATIONS = new Set([
  'ご視聴ありがとうございました',
  'ご視聴ありがとうございます',
  '視聴ありがとうございました',
  'チャンネル登録お願いします',
  'チャンネル登録よろしくお願いします',
  '高評価お願いします',
  '字幕作成',
  '字幕',
  'おやすみなさい',
  'ありがとうございました',
  'ありがとうございます',
  'お疲れ様でした',
  'それではまた次回お会いしましょう',
  'また次の動画でお会いしましょう',
  '最後までご視聴いただきありがとうございました',
  'MBCニュース',
  'Amara.org',
  '...',
  '…',
  '。',
  '、',
]);

const HALLUCINATION_PATTERNS: RegExp[] = [
  /ご視聴(いただき)?ありがとうございま(した|す)/,
  /チャンネル登録.*お願い/,
  /高評価.*お願い/,
  /字幕(制作|作成|提供)/,
  /翻訳.*字幕/,
  /Amara\.org/i,
  /Subtitles by/i,
  /^\s*[♪♫🎵🎶\s.,!?。、！？…・\-ー]+\s*$/,
];

/**
 * Returns true if the transcription looks like a Whisper silence/music hallucination.
 */
export function isLikelyHallucination(text: string, rms?: number): boolean {
  const normalized = text.trim().replace(/[。、！!？?\s]+$/g, '');
  if (!normalized) return true;

  if (EXACT_HALLUCINATIONS.has(normalized)) {
    // Allow "ありがとうございます" if speech energy was clearly loud (real dialogue),
    // otherwise treat common sign-offs as hallucinations.
    if (
      (normalized === 'ありがとうございます' ||
        normalized === 'ありがとうございました' ||
        normalized === 'おやすみなさい' ||
        normalized === 'お疲れ様でした') &&
      rms !== undefined &&
      rms > 0.035
    ) {
      return false;
    }
    return true;
  }

  for (const pattern of HALLUCINATION_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }

  // Detect extreme character/phrase repetition typical of Whisper loops (e.g. "あああああああ" or "そうそうそうそうそう")
  if (/(.)\1{6,}/.test(normalized)) {
    return true;
  }
  if (/(.{2,8})\1{3,}/.test(normalized)) {
    return true;
  }

  return false;
}
