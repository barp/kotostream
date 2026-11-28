import { afterEach, describe, expect, it } from 'vitest';
import { bulkImportVocabEntries, getVocabMap } from '../src/core/storage';

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
