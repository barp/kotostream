import { describe, expect, it } from 'vitest';
import { gzipSync, strToU8, zipSync } from 'fflate';
import {
  type MigakuImportEntry,
  mapMigakuStatus,
  mergeMigakuEntries,
  parseMigakuExport,
  parseMigakuFile,
} from '../src/core/migaku-import';

describe('Migaku import — status mapping', () => {
  it('maps Migaku status names and legacy numeric codes', () => {
    expect(mapMigakuStatus('KNOWN')).toBe('known');
    expect(mapMigakuStatus('Learning')).toBe('learning');
    expect(mapMigakuStatus('IGNORED')).toBe('ignored');
    expect(mapMigakuStatus('unknown')).toBeNull();
    expect(mapMigakuStatus(2)).toBe('known');
    expect(mapMigakuStatus(1)).toBe('learning');
    expect(mapMigakuStatus(0)).toBeNull();
    // Modern Migaku statuses: seen (studied card) & tracked (prominent word) → learning
    expect(mapMigakuStatus('SEEN')).toBe('learning');
    expect(mapMigakuStatus('tracked')).toBe('learning');
  });
});

describe('Migaku import — Word Exporter JSON (study.migaku.com)', () => {
  const exporterJson = JSON.stringify({
    exported: '2026-03-15T12:00:00.000Z',
    language: 'ja',
    totalWords: 9762,
    filters: ['KNOWN'],
    count: 5,
    words: [
      { word: '食べる', reading: 'たべる', language: 'ja', status: 'KNOWN' },
      { word: '飲む', reading: 'のむ', language: 'ja', status: 'KNOWN' },
      { word: '行く', reading: 'いく', language: 'ja', status: 'LEARNING' },
      { word: 'すごい', reading: '', language: 'ja', status: 'IGNORED' },
      { word: 'hello', reading: '', language: 'ja', status: 'KNOWN' },
      { word: 'dog', reading: '', language: 'en', status: 'KNOWN' },
      { word: 'test', reading: '', language: 'ja', status: 'UNKNOWN' },
    ],
  });

  it('imports known/learning/ignored with readings and skips non-Japanese, other languages, and UNKNOWN', () => {
    const res = parseMigakuExport(exporterJson);
    expect(res.format).toBe('exporter-json');
    expect(res.entries).toHaveLength(4);
    expect(res.skipped).toBe(3);

    const byWord = new Map(res.entries.map((e) => [e.word, e]));
    expect(byWord.get('食べる')).toMatchObject({ status: 'known', reading: 'たべる' });
    expect(byWord.get('飲む')).toMatchObject({ status: 'known', reading: 'のむ' });
    expect(byWord.get('行く')).toMatchObject({ status: 'learning', reading: 'いく' });
    expect(byWord.get('すごい')).toMatchObject({ status: 'ignored', reading: undefined });

    expect(res.breakdown).toEqual({ known: 2, learning: 1, ignored: 1 });
  });

  it('resolves duplicate words with the higher-value status and keeps the first reading', () => {
    const res = parseMigakuExport(
      JSON.stringify({
        words: [
          { word: '気', reading: 'き', status: 'IGNORED' },
          { word: '気', reading: '', status: 'KNOWN' },
        ],
      })
    );
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]).toMatchObject({ word: '気', status: 'known', reading: 'き' });
  });
});

describe('Migaku import — legacy .json backups', () => {
  it('imports array-of-arrays with numeric statuses (1 = learning, 2 = known)', () => {
    const res = parseMigakuExport(JSON.stringify([['食べる', 2], ['飲む', 1], ['走る', 0]]));
    expect(res.format).toBe('legacy-json');
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0]).toMatchObject({ word: '食べる', status: 'known' });
    expect(res.entries[1]).toMatchObject({ word: '飲む', status: 'learning' });
    expect(res.skipped).toBe(1); // 走る with 0 = untracked
  });

  it('supports category buckets { known: […], learning: […], ignored: […] }', () => {
    const res = parseMigakuExport(
      JSON.stringify({
        known: ['食べる'],
        learning: [{ word: '飲む', reading: 'のむ' }],
        ignored: ['うん'],
      })
    );
    expect(res.format).toBe('category-json');
    expect(res.entries).toHaveLength(3);
    const byWord = new Map(res.entries.map((e) => [e.word, e]));
    expect(byWord.get('食べる')).toMatchObject({ status: 'known' });
    expect(byWord.get('飲む')).toMatchObject({ status: 'learning', reading: 'のむ' });
    expect(byWord.get('うん')).toMatchObject({ status: 'ignored' });
  });
});

describe('Migaku import — CSV', () => {
  it('parses the exporter CSV (Word,Reading,Language,Status) with quoted fields', () => {
    const csv = [
      'Word,Reading,Language,Status',
      '"飛行機,便",ひこうき,ja,KNOWN',
      '海,うみ,ja,IGNORED',
      'hello,,ja,KNOWN',
      '山,やま,en,KNOWN',
    ].join('\n');
    const res = parseMigakuExport(csv);
    expect(res.format).toBe('csv');
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0]).toMatchObject({ word: '飛行機,便', status: 'known', reading: 'ひこうき' });
    expect(res.entries[1]).toMatchObject({ word: '海', status: 'ignored', reading: 'うみ' });
    expect(res.skipped).toBe(2); // non-Japanese word + en language
  });

  it('infers status from known.csv / learning.csv / ignored.csv file names (header-less word,reading rows)', () => {
    const res = parseMigakuExport('食べる,たべる\n飲む,のむ\n', { fileName: 'known.csv' });
    expect(res.format).toBe('csv');
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0]).toMatchObject({ word: '食べる', status: 'known', reading: 'たべる' });
    expect(res.entries[1]).toMatchObject({ word: '飲む', status: 'known', reading: 'のむ' });
  });

  it('parses header-less rows ending in a status (pasted CSV without the header line)', () => {
    const res = parseMigakuExport('食べる,たべる,ja,KNOWN\n今日,きょう,ja,IGNORED');
    expect(res.format).toBe('csv');
    const byWord = new Map(res.entries.map((e) => [e.word, e]));
    expect(byWord.get('食べる')).toMatchObject({ status: 'known', reading: 'たべる' });
    expect(byWord.get('今日')).toMatchObject({ status: 'ignored', reading: 'きょう' });
  });
});

describe('Migaku import — plain lists (TXT exports / hand-pasted words)', () => {
  it('imports one word per line with the fallback status', () => {
    const res = parseMigakuExport('これ\nそれ\n\nあれ\n', { fallbackStatus: 'ignored' });
    expect(res.format).toBe('plain-list');
    expect(res.entries).toHaveLength(3);
    expect(res.entries.every((e) => e.status === 'ignored')).toBe(true);
  });

  it('keeps the old bulk-import behavior for pasted comma/、 separated word lists', () => {
    const res = parseMigakuExport('今日、食べる, 友達', { fallbackStatus: 'known' });
    expect(res.format).toBe('plain-list');
    expect(res.entries.map((e) => e.word)).toEqual(['今日', '食べる', '友達']);
    expect(res.entries.every((e) => e.status === 'known')).toBe(true);
  });

  it('routes a per-category ignored.txt to CSV mode with the file-name status', () => {
    const res = parseMigakuExport('うん\nふむ', { fileName: 'ignored.txt' });
    expect(res.entries).toHaveLength(2);
    expect(res.entries.every((e) => e.status === 'ignored')).toBe(true);
  });
});

describe('Migaku import — merging multiple files', () => {
  it('deduplicates across files with the higher-value status winning', () => {
    const known: MigakuImportEntry[] = [
      { word: '気', status: 'known', reading: 'き' },
      { word: '海', status: 'known' },
    ];
    const ignored: MigakuImportEntry[] = [{ word: '気', status: 'ignored' }, { word: 'うん', status: 'ignored' }];
    const merged = mergeMigakuEntries([known, ignored]);
    expect(merged).toHaveLength(3);
    const byWord = new Map(merged.map((e) => [e.word, e]));
    expect(byWord.get('気')).toMatchObject({ status: 'known', reading: 'き' });
    expect(byWord.get('海')).toMatchObject({ status: 'known' });
    expect(byWord.get('うん')).toMatchObject({ status: 'ignored' });
  });
});

describe('Migaku import — error handling', () => {
  it('reports invalid JSON instead of throwing', () => {
    const res = parseMigakuExport('{oops');
    expect(res.format).toBe('invalid');
    expect(res.entries).toHaveLength(0);
    expect(res.error).toBeTruthy();
  });

  it('reports empty input', () => {
    const res = parseMigakuExport('   ');
    expect(res.format).toBe('invalid');
    expect(res.error).toBeTruthy();
  });
});

describe('Migaku import — file payloads (any extension, auto-detected content)', () => {
  it('descends into .zip archives and infers statuses from member names', async () => {
    const zip = zipSync({
      'known.csv': strToU8('食べる,たべる\n飲む,のむ\n'),
      'learning.csv': strToU8('行く,いく\n'),
      'ignored.csv': strToU8('うん\n'),
      '__MACOSX/known.csv': strToU8('junk'),
      'deck.apkg': new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]),
    });
    const parsed = await parseMigakuFile({ name: 'wordlists.zip', data: zip }, 'known');

    // __MACOSX and non-word members (deck.apkg) are skipped by the whitelist
    expect(parsed.map((p) => p.name).sort()).toEqual(['ignored.csv', 'known.csv', 'learning.csv']);

    const entries = parsed.flatMap((p) => p.result.entries);
    const byWord = new Map(entries.map((e) => [e.word, e]));
    expect(byWord.get('食べる')).toMatchObject({ status: 'known', reading: 'たべる' });
    expect(byWord.get('飲む')).toMatchObject({ status: 'known', reading: 'のむ' });
    expect(byWord.get('行く')).toMatchObject({ status: 'learning', reading: 'いく' });
    expect(byWord.get('うん')).toMatchObject({ status: 'ignored' });
  });

  it('gunzips .gz exports before parsing', async () => {
    const gz = gzipSync(strToU8('食べる,たべる\n飲む,のむ\n'));
    const parsed = await parseMigakuFile({ name: 'known.csv.gz', data: gz }, 'known');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('known.csv');
    expect(parsed[0].result.entries).toHaveLength(2);
    expect(parsed[0].result.entries[0]).toMatchObject({ word: '食べる', status: 'known', reading: 'たべる' });
  });

  it('parses a plain .csv upload through the exporter header format', async () => {
    const csv = strToU8('Word,Reading,Language,Status\n食べる,たべる,ja,KNOWN\n今日,きょう,ja,IGNORED\n');
    const parsed = await parseMigakuFile({ name: 'migaku-words.csv', data: csv }, 'known');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].result.entries).toHaveLength(2);
    expect(parsed[0].result.entries[1]).toMatchObject({ word: '今日', status: 'ignored' });
  });

  it('decodes Shift-JIS exports (bytes 0x834A/0x834C = カキ)', async () => {
    // Invalid as UTF-8 → falls back to Shift-JIS
    const sjis = new Uint8Array([0x83, 0x4a, 0x83, 0x4c]);
    const parsed = await parseMigakuFile({ name: 'known.csv', data: sjis }, 'known');
    expect(parsed[0].result.entries).toHaveLength(1);
    expect(parsed[0].result.entries[0]).toMatchObject({ word: 'カキ', status: 'known' });
  });

  it('decodes UTF-16 exports via BOM detection', async () => {
    // FF FE BOM + UTF-16LE code unit 0x30AB = カ
    const utf16 = new Uint8Array([0xff, 0xfe, 0xab, 0x30]);
    const parsed = await parseMigakuFile({ name: 'known.csv', data: utf16 }, 'known');
    expect(parsed[0].result.entries).toHaveLength(1);
    expect(parsed[0].result.entries[0]).toMatchObject({ word: 'カ', status: 'known' });
  });

  it('refuses clearly-binary files instead of importing mojibake', async () => {
    const sqlite = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x00, 0x0f, 0x00, 0x01]);
    const parsed = await parseMigakuFile({ name: 'words.sqlite', data: sqlite }, 'known');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].result.entries).toHaveLength(0);
    expect(parsed[0].result.error).toContain('binary');
  });

  it('reports a .zip with no readable word members (e.g. a bare .apkg deck)', async () => {
    const apkg = zipSync({ 'collection.anki2': new Uint8Array([1, 2, 3]), media: strToU8('{}') });
    const parsed = await parseMigakuFile({ name: 'deck.apkg', data: apkg }, 'known');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].result.entries).toHaveLength(0);
    expect(parsed[0].result.error).toBeTruthy();
  });
});
