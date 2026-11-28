import { afterEach, describe, expect, it } from 'vitest';
import {
  addMinedCard,
  bulkImportVocabEntries,
  deleteMinedCard,
  getCardMedia,
  getMinedCards,
  getVocabMap,
  hydrateMinedCard,
  updateMinedCard,
} from '../src/core/storage';

/**
 * Regression suite for the Migaku import write path: a quota-exceeded rejection used to be
 * swallowed, producing a fake "Imported 11,000 words" toast while chrome.storage kept the
 * old vocab map. bulkImportVocabEntries must now verify the write and report persisted:false.
 */

type FakeChromeOptions = {
  /** When set, chrome.storage.local.set rejects with this error for every write. */
  failSet?: () => Error;
  /** When true, set() resolves but stores nothing (simulates a silently-dropped write). */
  dropWrites?: boolean;
};

function installFakeChrome(opts: FakeChromeOptions = {}): Map<string, unknown> {
  const store = new Map<string, unknown>();
  const g = globalThis as { chrome?: unknown };
  g.chrome = {
    runtime: { id: 'test-extension' },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store.get(key) }),
        set: async (items: Record<string, unknown>) => {
          if (opts.failSet) throw opts.failSet();
          if (!opts.dropWrites) {
            for (const [k, v] of Object.entries(items)) store.set(k, v);
          }
        },
        remove: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) store.delete(k);
        },
      },
    },
  };
  return store;
}

const originalChrome = (globalThis as { chrome?: unknown }).chrome;

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = originalChrome;
});

describe('bulkImportVocabEntries — verified persistence', () => {
  it('persists entries and verifies the write landed', async () => {
    installFakeChrome();
    const res = await bulkImportVocabEntries([
      { word: '食べる', status: 'known', reading: 'たべる' },
      { word: 'うん', status: 'ignored' },
      { word: '行く', status: 'learning', reading: 'いく' },
    ]);
    expect(res.persisted).toBe(true);
    expect(res.added).toBe(3);
    expect(res.updated).toBe(0);

    const map = await getVocabMap();
    expect(map['食べる']).toMatchObject({ status: 'known', reading: 'たべる' });
    expect(map['うん']).toMatchObject({ status: 'ignored' });
    expect(map['行く']).toMatchObject({ status: 'learning', reading: 'いく' });
  });

  it('counts updates without clobbering existing metadata', async () => {
    installFakeChrome();
    await bulkImportVocabEntries([{ word: '既存', status: 'learning', reading: 'きそん' }]);
    const res = await bulkImportVocabEntries([{ word: '既存', status: 'known' }]);
    expect(res.persisted).toBe(true);
    expect(res.added).toBe(0);
    expect(res.updated).toBe(1);
    const map = await getVocabMap();
    expect(map['既存']).toMatchObject({ status: 'known', reading: 'きそん' });
  });

  it('skips unknown-status entries entirely', async () => {
    installFakeChrome();
    const res = await bulkImportVocabEntries([
      { word: '食べる', status: 'known' },
      { word: '未読', status: 'unknown' },
    ]);
    expect(res.persisted).toBe(true);
    expect(res.added).toBe(1);
    const map = await getVocabMap();
    expect(map['未読']).toBeUndefined();
  });

  it('reports failure instead of fake success when the write is rejected (quota exceeded)', async () => {
    installFakeChrome({
      failSet: () => new Error('This extension exceeded its quota for storage.local'),
    });
    const res = await bulkImportVocabEntries([{ word: '食べる', status: 'known' }]);
    expect(res.persisted).toBe(false);
    expect(res.added).toBe(0);
    expect(res.updated).toBe(0);
    expect(res.error).toContain('quota');
    expect(res.error).toContain('unlimitedStorage');
  });

  it('detects a silently-dropped write via the read-back verification', async () => {
    installFakeChrome({ dropWrites: true });
    const res = await bulkImportVocabEntries([{ word: '食べる', status: 'known' }]);
    expect(res.persisted).toBe(false);
    expect(res.added).toBe(0);
    expect(res.error).toBeTruthy();
  });
});

describe('mined card media decoupling', () => {
  it('stores heavy audio/screenshot blobs under per-card keys and hydrates on demand', async () => {
    const store = installFakeChrome();
    const created = await addMinedCard({
      word: '約束',
      surfaceWord: '約束',
      reading: 'やくそく',
      meaning: 'promise',
      sentence: '約束を守る。',
      sourceTitle: 'Prime Video',
      sourceUrl: 'https://www.primevideo.com/detail/test',
      audioBase64: 'UklGR_FULL_48KHZ_STEREO_WAV',
      audioMimeType: 'audio/wav',
      screenshotDataUrl: 'data:image/webp;base64,FULL_SHOT',
      screenshotFormat: 'webp',
    });

    // Returned card is immediately hydrated for direct Anki export
    expect(created.audioBase64).toBe('UklGR_FULL_48KHZ_STEREO_WAV');
    expect(created.screenshotDataUrl).toBe('data:image/webp;base64,FULL_SHOT');
    expect(created.hasAudio).toBe(true);
    expect(created.hasScreenshot).toBe(true);

    // Index array in kotostream_cards stays lightweight without base64 blobs
    const listed = await getMinedCards();
    expect(listed).toHaveLength(1);
    expect(listed[0].audioBase64).toBeUndefined();
    expect(listed[0].screenshotDataUrl).toBeUndefined();
    expect(listed[0].hasAudio).toBe(true);
    expect(listed[0].hasScreenshot).toBe(true);

    // Per-card media key holds exact untouched audio and screenshot
    const media = await getCardMedia(created.id);
    expect(media.audioBase64).toBe('UklGR_FULL_48KHZ_STEREO_WAV');
    expect(media.screenshotDataUrl).toBe('data:image/webp;base64,FULL_SHOT');

    // Hydration restores full blobs on demand
    const hydrated = await hydrateMinedCard(listed[0]);
    expect(hydrated.audioBase64).toBe('UklGR_FULL_48KHZ_STEREO_WAV');
    expect(hydrated.screenshotDataUrl).toBe('data:image/webp;base64,FULL_SHOT');

    // Updating ankiNoteId keeps media decoupled and intact
    await updateMinedCard({ ...listed[0], ankiNoteId: 999 });
    const afterUpdate = await getMinedCards();
    expect(afterUpdate[0].ankiNoteId).toBe(999);
    expect(afterUpdate[0].audioBase64).toBeUndefined();
    expect((await getCardMedia(created.id)).audioBase64).toBe('UklGR_FULL_48KHZ_STEREO_WAV');

    // Deleting the card cleans up both the index entry and its media key
    await deleteMinedCard(created.id);
    expect(await getMinedCards()).toHaveLength(0);
    expect(store.has(`kotostream_card_media_${created.id}`)).toBe(false);
  });
});
