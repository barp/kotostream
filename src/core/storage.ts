import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type DictionaryEntry,
  type MinedCard,
  type SavedSubtitleTrack,
  type VocabEntry,
  type WordStatus,
} from '../types';

const STORAGE_KEYS = {
  SETTINGS: 'kotostream_settings',
  VOCAB: 'kotostream_vocab',
  CARDS: 'kotostream_cards',
  DICT_CACHE: 'kotostream_dict_cache',
  SUBTITLE_LIBRARY: 'kotostream_subtitle_library',
} as const;

const CARD_MEDIA_PREFIX = 'kotostream_card_media_';

export interface CardMedia {
  audioBase64?: string;
  screenshotDataUrl?: string;
}

const MAX_DICT_CACHE_ENTRIES = 600;

function hasChromeStorage(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    Boolean(chrome.runtime?.id) &&
    Boolean(chrome.storage?.local)
  );
}

async function storageGet<T>(key: string, fallback: T): Promise<T> {
  if (!hasChromeStorage()) return fallback;
  try {
    const result = await chrome.storage.local.get(key);
    return (result[key] as T) ?? fallback;
  } catch {
    return fallback;
  }
}

async function storageSet(items: Record<string, unknown>): Promise<void> {
  if (!hasChromeStorage()) return;
  try {
    await chrome.storage.local.set(items);
  } catch {
    // Ignore when extension context has been invalidated after reload
  }
}

async function storageRemove(keys: string | string[]): Promise<void> {
  if (!hasChromeStorage() || !chrome.storage.local.remove) return;
  try {
    await chrome.storage.local.remove(keys);
  } catch {
    // Ignore when extension context has been invalidated after reload
  }
}

/**
 * Like storageSet but SURFACES write failures (quota, context invalidated, …).
 * Use for critical bulk writes where a silent failure would report fake success.
 */
async function storageSetStrict(items: Record<string, unknown>): Promise<void> {
  if (!hasChromeStorage()) return; // test/non-extension environments: nothing to persist
  await chrome.storage.local.set(items);
}

export async function getSettings(): Promise<AppSettings> {
  const saved = await storageGet<Partial<AppSettings>>(STORAGE_KEYS.SETTINGS, {});
  const hasApiKey = Boolean(saved.stt?.apiKey?.trim());
  const legacyGoogleDefault =
    saved.anki?.translationModel === undefined &&
    saved.anki?.translationProvider === 'google_free' &&
    hasApiKey;

  return {
    enabled: saved.enabled ?? DEFAULT_SETTINGS.enabled,
    stt: {
      ...DEFAULT_SETTINGS.stt,
      ...(saved.stt ?? {}),
      provider: 'openrouter',
    },
    overlay: { ...DEFAULT_SETTINGS.overlay, ...(saved.overlay ?? {}) },
    anki: {
      ...DEFAULT_SETTINGS.anki,
      ...(saved.anki ?? {}),
      ...(legacyGoogleDefault ? { translationProvider: 'openrouter' as const } : {}),
      fieldMapping: {
        ...DEFAULT_SETTINGS.anki.fieldMapping,
        ...(saved.anki?.fieldMapping ?? {}),
      },
    },
    subtitles: {
      ...DEFAULT_SETTINGS.subtitles,
      ...(saved.subtitles ?? {}),
    },
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await storageSet({ [STORAGE_KEYS.SETTINGS]: settings });
}

export async function getVocabMap(): Promise<Record<string, VocabEntry>> {
  return storageGet<Record<string, VocabEntry>>(STORAGE_KEYS.VOCAB, {});
}

export async function setWordStatus(
  word: string,
  status: WordStatus,
  meta?: { reading?: string; meaning?: string }
): Promise<VocabEntry> {
  const vocab = await getVocabMap();
  const now = Date.now();
  const existing = vocab[word];
  const entry: VocabEntry = {
    word,
    reading: meta?.reading ?? existing?.reading ?? '',
    meaning: meta?.meaning ?? existing?.meaning ?? '',
    status,
    encounters: (existing?.encounters ?? 0) + 1,
    firstSeenAt: existing?.firstSeenAt ?? now,
    updatedAt: now,
  };
  vocab[word] = entry;
  await storageSet({ [STORAGE_KEYS.VOCAB]: vocab });
  return entry;
}

export async function bulkImportKnownWords(words: string[]): Promise<number> {
  const { added, updated } = await bulkImportVocabEntries(
    words.map((word) => ({ word, status: 'known' as WordStatus }))
  );
  return added + updated;
}

export interface BulkVocabEntry {
  word: string;
  status: WordStatus;
  reading?: string;
}

/**
 * Merges a Migaku export (known / learning / ignored words) into the vocab tracker.
 * Existing entries keep their reading, meaning, encounters, and firstSeenAt — only the status
 * changes (the import wins, since the exported list is the source of truth).
 *
 * The write is VERIFIED: `persisted: true` only when chrome.storage.local actually holds the
 * merged map afterwards (a quota-exceeded rejection previously caused a fake "Imported 11k"
 * toast while nothing was saved!). Callers MUST check `persisted` before reporting success.
 */
export async function bulkImportVocabEntries(entries: BulkVocabEntry[]): Promise<{
  added: number;
  updated: number;
  persisted: boolean;
  error?: string;
}> {
  const vocab = await getVocabMap();
  const now = Date.now();
  let added = 0;
  let updated = 0;

  for (const { word: rawWord, status, reading } of entries) {
    const word = rawWord.trim();
    if (!word || status === 'unknown') continue; // 'unknown' is KotoStream's default state
    const existing = vocab[word];
    const readingChanged =
      !existing?.reading && typeof reading === 'string' && reading.trim().length > 0;
    const statusChanged = !existing || existing.status !== status;
    if (!existing) {
      added++;
    } else if (statusChanged || readingChanged) {
      updated++;
    }
    if (!statusChanged && !readingChanged) continue;

    vocab[word] = {
      word,
      reading: existing?.reading || (reading ?? '').trim(),
      meaning: existing?.meaning ?? '',
      status,
      encounters: existing?.encounters ?? 1,
      firstSeenAt: existing?.firstSeenAt ?? now,
      updatedAt: now,
    };
  }

  if (!hasChromeStorage()) {
    // Non-extension environment (tests): report the merge result, nothing to persist
    return { added, updated, persisted: true };
  }

  try {
    await storageSetStrict({ [STORAGE_KEYS.VOCAB]: vocab });
    // Read back and verify the write actually landed (quota / context failures can otherwise
    // go unnoticed because callers compute counts from the in-memory merge)
    const readBack = await storageGet<Record<string, VocabEntry>>(STORAGE_KEYS.VOCAB, {});
    if (Object.keys(readBack).length < Object.keys(vocab).length) {
      return {
        added: 0,
        updated: 0,
        persisted: false,
        error:
          'storage write did not persist (quota). Reload the extension in chrome://extensions to activate the unlimitedStorage permission, refresh this page, and import again.',
      };
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return {
      added: 0,
      updated: 0,
      persisted: false,
      error: `${raw}. If this mentions a quota, reload the extension in chrome://extensions (activates unlimitedStorage), refresh this page, and import again.`,
    };
  }

  return { added, updated, persisted: true };
}

function cardMediaKey(cardId: string): string {
  return `${CARD_MEDIA_PREFIX}${cardId}`;
}

function stripCardMedia(card: MinedCard): MinedCard {
  const { audioBase64, screenshotDataUrl, ...meta } = card;
  return {
    ...meta,
    hasAudio: Boolean(meta.hasAudio || audioBase64),
    hasScreenshot: Boolean(meta.hasScreenshot || screenshotDataUrl),
  };
}

export async function getCardMedia(cardId: string): Promise<CardMedia> {
  return storageGet<CardMedia>(cardMediaKey(cardId), {});
}

export async function hydrateMinedCard(card: MinedCard): Promise<MinedCard> {
  if (
    (!card.hasAudio || card.audioBase64) &&
    (!card.hasScreenshot || card.screenshotDataUrl)
  ) {
    return card;
  }
  const media = await getCardMedia(card.id);
  return {
    ...card,
    audioBase64: card.audioBase64 ?? media.audioBase64,
    screenshotDataUrl: card.screenshotDataUrl ?? media.screenshotDataUrl,
  };
}

export async function getMinedCards(): Promise<MinedCard[]> {
  const cards = await storageGet<MinedCard[]>(STORAGE_KEYS.CARDS, []);
  return cards.map((card) => ({
    ...card,
    hasAudio: Boolean(card.hasAudio || card.audioBase64),
    hasScreenshot: Boolean(card.hasScreenshot || card.screenshotDataUrl),
  }));
}

export async function addMinedCard(
  cardInput: Omit<MinedCard, 'id' | 'createdAt'>
): Promise<MinedCard> {
  const cards = await storageGet<MinedCard[]>(STORAGE_KEYS.CARDS, []);
  const now = Date.now();
  const card: MinedCard = {
    ...cardInput,
    hasAudio: Boolean(cardInput.hasAudio || cardInput.audioBase64),
    hasScreenshot: Boolean(cardInput.hasScreenshot || cardInput.screenshotDataUrl),
    id: `card_${now}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: now,
  };

  // Store full-quality media (48kHz stereo WAV / WebP screenshot) under a dedicated per-card key
  // so listing/counting/updating kotostream_cards stays fast and lightweight.
  if (card.audioBase64 || card.screenshotDataUrl) {
    const media: CardMedia = {};
    if (card.audioBase64) media.audioBase64 = card.audioBase64;
    if (card.screenshotDataUrl) media.screenshotDataUrl = card.screenshotDataUrl;
    await storageSet({ [cardMediaKey(card.id)]: media });
  }

  // Strip heavy media blobs from the index array (also migrates any legacy inline media entries on write)
  cards.unshift(stripCardMedia(card));
  await storageSet({ [STORAGE_KEYS.CARDS]: cards });

  // Also ensure the word is marked as learning in vocab tracker
  await setWordStatus(card.word, 'learning', {
    reading: card.reading,
    meaning: card.meaning,
  });

  return card;
}

export async function updateMinedCard(updated: MinedCard): Promise<void> {
  const cards = await storageGet<MinedCard[]>(STORAGE_KEYS.CARDS, []);
  const idx = cards.findIndex((c) => c.id === updated.id);
  if (idx >= 0) {
    if (updated.audioBase64 || updated.screenshotDataUrl) {
      const existingMedia = await getCardMedia(updated.id);
      const nextMedia: CardMedia = {
        audioBase64: updated.audioBase64 ?? existingMedia.audioBase64,
        screenshotDataUrl: updated.screenshotDataUrl ?? existingMedia.screenshotDataUrl,
      };
      await storageSet({ [cardMediaKey(updated.id)]: nextMedia });
    }
    cards[idx] = stripCardMedia(updated);
    await storageSet({ [STORAGE_KEYS.CARDS]: cards });
  }
}

export async function deleteMinedCard(cardId: string): Promise<void> {
  const cards = await storageGet<MinedCard[]>(STORAGE_KEYS.CARDS, []);
  const filtered = cards.filter((c) => c.id !== cardId);
  await Promise.all([
    storageSet({ [STORAGE_KEYS.CARDS]: filtered }),
    storageRemove(cardMediaKey(cardId)),
  ]);
}

export async function getDictCache(): Promise<Record<string, DictionaryEntry>> {
  return storageGet<Record<string, DictionaryEntry>>(STORAGE_KEYS.DICT_CACHE, {});
}

export async function cacheDictEntry(key: string, entry: DictionaryEntry): Promise<void> {
  const cache = await getDictCache();
  cache[key] = entry;
  const keys = Object.keys(cache);
  if (keys.length > MAX_DICT_CACHE_ENTRIES) {
    const excess = keys.length - MAX_DICT_CACHE_ENTRIES;
    for (let i = 0; i < excess; i++) {
      delete cache[keys[i]];
    }
  }
  await storageSet({ [STORAGE_KEYS.DICT_CACHE]: cache });
}

/**
 * Normalizes a streaming page URL (Prime Video, YouTube, Netflix) into a stable key
 * so saved episode subtitles auto-load reliably on future visits.
 */
export function normalizeVideoUrlKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      return v ? `youtube.com/watch?v=${v}` : `${host}${u.pathname}`;
    }
    // Prime Video / Netflix: keep clean path without tracking query params
    const cleanPath = u.pathname.replace(/\/ref=[^/]*.*$/, '').replace(/\/+$/, '');
    return `${host}${cleanPath}`;
  } catch {
    return rawUrl.trim();
  }
}

export async function getSubtitleLibrary(): Promise<SavedSubtitleTrack[]> {
  return storageGet<SavedSubtitleTrack[]>(STORAGE_KEYS.SUBTITLE_LIBRARY, []);
}

export async function saveSubtitleTrack(
  input: Omit<SavedSubtitleTrack, 'id' | 'createdAt' | 'updatedAt'>
): Promise<SavedSubtitleTrack> {
  const lib = await getSubtitleLibrary();
  const now = Date.now();
  const urlKey = input.urlKey ? normalizeVideoUrlKey(input.urlKey) : undefined;

  // If another track was bound to the same URL, unbind it so this one becomes the active match
  if (urlKey) {
    for (const t of lib) {
      if (t.urlKey === urlKey) t.urlKey = undefined;
    }
  }

  const track: SavedSubtitleTrack = {
    ...input,
    urlKey,
    id: `subtrack_${now}_${Math.random().toString(36).slice(2, 6)}`,
    createdAt: now,
    updatedAt: now,
  };

  lib.unshift(track);
  // Cap library to 40 tracks to keep chrome.storage.local fast
  if (lib.length > 40) lib.length = 40;

  await storageSet({ [STORAGE_KEYS.SUBTITLE_LIBRARY]: lib });
  return track;
}

export async function findSubtitleTrackForUrl(rawUrl: string): Promise<SavedSubtitleTrack | null> {
  const key = normalizeVideoUrlKey(rawUrl);
  const lib = await getSubtitleLibrary();
  return lib.find((t) => t.urlKey === key) ?? null;
}

export async function updateSubtitleTrackOffset(trackId: string, offsetSec: number): Promise<void> {
  const lib = await getSubtitleLibrary();
  const track = lib.find((t) => t.id === trackId);
  if (track) {
    track.offsetSec = Math.round(offsetSec * 100) / 100;
    track.updatedAt = Date.now();
    await storageSet({ [STORAGE_KEYS.SUBTITLE_LIBRARY]: lib });
  }
}

export async function bindSubtitleTrackToUrl(trackId: string, rawUrl: string): Promise<void> {
  const lib = await getSubtitleLibrary();
  const key = normalizeVideoUrlKey(rawUrl);
  for (const t of lib) {
    if (t.urlKey === key && t.id !== trackId) t.urlKey = undefined;
  }
  const target = lib.find((t) => t.id === trackId);
  if (target) {
    target.urlKey = key;
    target.updatedAt = Date.now();
    await storageSet({ [STORAGE_KEYS.SUBTITLE_LIBRARY]: lib });
  }
}

export async function deleteSubtitleTrack(trackId: string): Promise<void> {
  const lib = await getSubtitleLibrary();
  await storageSet({
    [STORAGE_KEYS.SUBTITLE_LIBRARY]: lib.filter((t) => t.id !== trackId),
  });
}
