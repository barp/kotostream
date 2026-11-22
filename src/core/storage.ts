import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type DictionaryEntry,
  type MinedCard,
  type SavedSubtitleTrack,
  type VocabEntry,
  type WordStatus,
} from '../types';
import { createInitialSrsState } from './srs';

const STORAGE_KEYS = {
  SETTINGS: 'kotostream_settings',
  VOCAB: 'kotostream_vocab',
  CARDS: 'kotostream_cards',
  DICT_CACHE: 'kotostream_dict_cache',
  SUBTITLE_LIBRARY: 'kotostream_subtitle_library',
} as const;

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

export async function getSettings(): Promise<AppSettings> {
  const saved = await storageGet<Partial<AppSettings>>(STORAGE_KEYS.SETTINGS, {});
  return {
    stt: {
      ...DEFAULT_SETTINGS.stt,
      ...(saved.stt ?? {}),
      provider: 'openrouter',
    },
    overlay: { ...DEFAULT_SETTINGS.overlay, ...(saved.overlay ?? {}) },
    anki: {
      ...DEFAULT_SETTINGS.anki,
      ...(saved.anki ?? {}),
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
  const vocab = await getVocabMap();
  const now = Date.now();
  let added = 0;
  for (const raw of words) {
    const word = raw.trim();
    if (!word) continue;
    if (!vocab[word] || vocab[word].status !== 'known') {
      vocab[word] = {
        word,
        reading: vocab[word]?.reading ?? '',
        meaning: vocab[word]?.meaning ?? '',
        status: 'known',
        encounters: vocab[word]?.encounters ?? 1,
        firstSeenAt: vocab[word]?.firstSeenAt ?? now,
        updatedAt: now,
      };
      added++;
    }
  }
  await storageSet({ [STORAGE_KEYS.VOCAB]: vocab });
  return added;
}

export async function getMinedCards(): Promise<MinedCard[]> {
  return storageGet<MinedCard[]>(STORAGE_KEYS.CARDS, []);
}

export async function addMinedCard(
  cardInput: Omit<MinedCard, 'id' | 'createdAt' | 'srs'>
): Promise<MinedCard> {
  const cards = await getMinedCards();
  const now = Date.now();
  const card: MinedCard = {
    ...cardInput,
    id: `card_${now}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: now,
    srs: createInitialSrsState(now),
  };
  cards.unshift(card);
  await storageSet({ [STORAGE_KEYS.CARDS]: cards });

  // Also ensure the word is marked as learning in vocab tracker
  await setWordStatus(card.word, 'learning', {
    reading: card.reading,
    meaning: card.meaning,
  });

  return card;
}

export async function updateMinedCard(updated: MinedCard): Promise<void> {
  const cards = await getMinedCards();
  const idx = cards.findIndex((c) => c.id === updated.id);
  if (idx >= 0) {
    cards[idx] = updated;
    await storageSet({ [STORAGE_KEYS.CARDS]: cards });
  }
}

export async function deleteMinedCard(cardId: string): Promise<void> {
  const cards = await getMinedCards();
  const filtered = cards.filter((c) => c.id !== cardId);
  await storageSet({ [STORAGE_KEYS.CARDS]: filtered });
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
