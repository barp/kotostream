import type { AnkiSettings, FuriganaFormat, MinedCard } from '../types';

export interface AnkiInvokeResponse<T = unknown> {
  result: T;
  error: string | null;
}

export interface AnkiFieldPreviewItem {
  fieldName: string;
  html: string;
  hasImage?: boolean;
  hasAudio?: boolean;
}

/**
 * Low-level AnkiConnect HTTP RPC call.
 * Automatically proxies through the background service worker when invoked from
 * an HTTPS content script (like Amazon Prime Video) to avoid Mixed Content / PNA blocks.
 */
export async function invokeAnkiConnect<T = unknown>(
  action: string,
  params: Record<string, unknown> = {},
  url = 'http://127.0.0.1:8765'
): Promise<T> {
  const isWebContentScript =
    typeof window !== 'undefined' &&
    (window.location?.protocol === 'https:' || window.location?.protocol === 'http:') &&
    typeof chrome !== 'undefined' &&
    Boolean(chrome.runtime?.sendMessage);

  if (isWebContentScript) {
    const res = (await chrome.runtime.sendMessage({
      type: 'ANKI_REQUEST',
      action,
      params,
      url,
    })) as { result?: T; error?: string };
    if (res?.error) {
      throw new Error(res.error);
    }
    return res.result as T;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params }),
  });

  if (!response.ok) {
    throw new Error(`AnkiConnect HTTP ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as AnkiInvokeResponse<T>;
  if (data.error) {
    throw new Error(`AnkiConnect error: ${data.error}`);
  }
  return data.result;
}

export async function testAnkiConnection(url: string): Promise<number> {
  return invokeAnkiConnect<number>('version', {}, url);
}

export async function getAnkiDecks(url: string): Promise<string[]> {
  return invokeAnkiConnect<string[]>('deckNames', {}, url);
}

export async function getAnkiModels(url: string): Promise<string[]> {
  return invokeAnkiConnect<string[]>('modelNames', {}, url);
}

export async function getAnkiModelFields(modelName: string, url: string): Promise<string[]> {
  return invokeAnkiConnect<string[]>('modelFieldNames', { modelName }, url);
}

/**
 * Formats a Japanese word with furigana according to Migaku-style settings.
 */
export function formatWordWithFurigana(word: string, reading: string, format: FuriganaFormat): string {
  const safeWord = escapeHtml(word);
  const safeReading = escapeHtml(reading);

  if (!reading || reading === word || format === 'none') {
    return safeWord;
  }
  if (format === 'migaku_brackets') {
    return `${safeWord}[${safeReading}]`;
  }
  return `<ruby>${safeWord}<rt>${safeReading}</rt></ruby>`;
}

/**
 * Highlights the target word (or its conjugated surface form) inside the sentence.
 */
export function formatSentenceHtml(
  sentence: string,
  targetWord: string,
  surfaceWord: string | undefined,
  highlight: boolean
): string {
  const safeSentence = escapeHtml(sentence);
  if (!highlight) return safeSentence;

  const needle = surfaceWord && sentence.includes(surfaceWord)
    ? surfaceWord
    : targetWord && sentence.includes(targetWord)
      ? targetWord
      : '';

  if (!needle) return safeSentence;

  const safeNeedle = escapeHtml(needle);
  const idx = safeSentence.indexOf(safeNeedle);
  if (idx === -1) return safeSentence;

  return (
    safeSentence.slice(0, idx) +
    `<b class="ks-target-word">${safeNeedle}</b>` +
    safeSentence.slice(idx + safeNeedle.length)
  );
}

/**
 * Builds the AnkiConnect `addNote` payload from a MinedCard and Migaku-style AnkiSettings.
 */
export function buildAnkiNotePayload(
  card: MinedCard,
  settings: AnkiSettings,
  mediaFilenames: { image?: string; audio?: string } = {}
): {
  deckName: string;
  modelName: string;
  fields: Record<string, string>;
  options: { allowDuplicate: boolean };
  tags: string[];
} {
  const fields: Record<string, string> = {};
  const map = settings.fieldMapping;

  const appendField = (fieldName: string | undefined, value: string) => {
    const trimmed = fieldName?.trim();
    if (!trimmed || !value) return;
    if (fields[trimmed]) {
      fields[trimmed] += `<br><br>${value}`;
    } else {
      fields[trimmed] = value;
    }
  };

  const wordHtml = formatWordWithFurigana(card.word, card.reading, settings.furiganaFormat);
  const sentenceHtml = formatSentenceHtml(
    card.sentence,
    card.word,
    card.surfaceWord,
    settings.highlightTargetInSentence
  );

  appendField(map.targetWord, wordHtml);
  appendField(map.reading, escapeHtml(card.reading));
  appendField(map.sentence, sentenceHtml);
  appendField(map.translation, card.translation ? escapeHtml(card.translation) : '');
  appendField(map.definitions, escapeHtml(card.meaning).replace(/\n/g, '<br>'));
  appendField(map.notes, card.notes ? escapeHtml(card.notes).replace(/\n/g, '<br>') : '');
  appendField(map.source, card.sourceTitle ? escapeHtml(card.sourceTitle) : '');

  if (mediaFilenames.image) {
    const imgTag = `<img src="${mediaFilenames.image}">`;
    if (map.image?.trim()) {
      appendField(map.image, imgTag);
    } else if (map.definitions?.trim()) {
      appendField(map.definitions, imgTag);
    }
  }

  if (mediaFilenames.audio) {
    const soundTag = `[sound:${mediaFilenames.audio}]`;
    if (map.sentenceAudio?.trim()) {
      appendField(map.sentenceAudio, soundTag);
    } else if (map.definitions?.trim()) {
      appendField(map.definitions, soundTag);
    }
  }

  const baseTags = settings.tags.length > 0 ? [...settings.tags] : ['kotostream'];
  const cardTypeTag = `kotostream::${card.cardType ?? settings.cardType}`;
  if (!baseTags.includes(cardTypeTag)) {
    baseTags.push(cardTypeTag);
  }

  return {
    deckName: settings.deckName,
    modelName: settings.modelName,
    fields,
    options: { allowDuplicate: settings.allowDuplicate },
    tags: baseTags,
  };
}

/**
 * Generates a live preview list of every mapped Anki field for the Card Creator modal.
 */
export function buildAnkiFieldPreview(
  card: Partial<MinedCard> & { word: string; reading: string; meaning: string; sentence: string },
  settings: AnkiSettings
): AnkiFieldPreviewItem[] {
  const hasImage = Boolean(settings.includeScreenshot && card.screenshotDataUrl);
  const hasAudio = Boolean(settings.includeAudio && card.audioBase64);

  const payload = buildAnkiNotePayload(
    {
      id: card.id ?? 'preview',
      word: card.word,
      surfaceWord: card.surfaceWord,
      reading: card.reading,
      meaning: card.meaning,
      sentence: card.sentence,
      translation: card.translation,
      notes: card.notes,
      cardType: card.cardType ?? settings.cardType,
      sourceTitle: card.sourceTitle ?? '',
      sourceUrl: card.sourceUrl ?? '',
      screenshotDataUrl: card.screenshotDataUrl,
      audioBase64: card.audioBase64,
      createdAt: Date.now(),
      srs: { intervalDays: 0, easeFactor: 2.5, repetitions: 0, dueAt: Date.now() },
    },
    settings,
    {
      image: hasImage ? '__PREVIEW_IMAGE__' : undefined,
      audio: hasAudio ? '__PREVIEW_AUDIO__' : undefined,
    }
  );

  return Object.entries(payload.fields).map(([fieldName, rawHtml]) => {
    let html = rawHtml;
    const fieldHasImage = html.includes('__PREVIEW_IMAGE__');
    const fieldHasAudio = html.includes('__PREVIEW_AUDIO__');

    if (fieldHasImage && card.screenshotDataUrl) {
      html = html.replace(
        '<img src="__PREVIEW_IMAGE__">',
        `<img class="ks-preview-img" src="${card.screenshotDataUrl}" alt="Video screenshot">`
      );
    }
    if (fieldHasAudio) {
      html = html.replace(
        '[sound:__PREVIEW_AUDIO__]',
        `<span class="ks-preview-audio-badge">🔊 Sentence Audio Clip</span>`
      );
    }

    return {
      fieldName,
      html,
      hasImage: fieldHasImage,
      hasAudio: fieldHasAudio,
    };
  });
}

/**
 * Uploads screenshot/audio media (if enabled) and adds a note to Anki via AnkiConnect.
 */
export async function exportCardToAnki(card: MinedCard, settings: AnkiSettings): Promise<number> {
  const mediaFilenames: { image?: string; audio?: string } = {};
  const safeId = card.id.replace(/[^a-zA-Z0-9_-]/g, '');

  if (settings.includeScreenshot && card.screenshotDataUrl) {
    const base64 = stripDataUrlPrefix(card.screenshotDataUrl);
    if (base64) {
      const ext = card.screenshotFormat ?? settings.screenshotFormat ?? 'webp';
      const filename = `kotostream_${safeId}.${ext}`;
      await invokeAnkiConnect('storeMediaFile', { filename, data: base64 }, settings.url);
      mediaFilenames.image = filename;
    }
  }

  if (settings.includeAudio && card.audioBase64) {
    const ext = card.audioMimeType?.includes('ogg') ? 'ogg' : 'webm';
    const filename = `kotostream_${safeId}.${ext}`;
    await invokeAnkiConnect('storeMediaFile', { filename, data: card.audioBase64 }, settings.url);
    mediaFilenames.audio = filename;
  }

  const note = buildAnkiNotePayload(card, settings, mediaFilenames);
  return invokeAnkiConnect<number>('addNote', { note }, settings.url);
}

/**
 * Exports mined cards as an Anki-importable TSV string (Tab-Separated Values).
 */
export function exportCardsToTsv(cards: MinedCard[]): string {
  const sanitize = (s: string) => s.replace(/\t/g, ' ').replace(/\r?\n/g, '<br>');
  const rows = cards.map((c) =>
    [c.word, c.reading, c.meaning, c.sentence, c.translation ?? '', c.sourceTitle].map(sanitize).join('\t')
  );
  return rows.join('\n');
}

function stripDataUrlPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf('base64,');
  return idx >= 0 ? dataUrl.slice(idx + 7) : dataUrl;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
