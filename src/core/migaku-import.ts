import type { WordStatus } from '../types';

export type ImportableStatus = Exclude<WordStatus, 'unknown'>;

export interface MigakuImportEntry {
  word: string;
  status: ImportableStatus;
  reading?: string;
}

export type MigakuImportFormat =
  /** Migaku Word Exporter (study.migaku.com → "Export Words"): { words: [{ word, reading, language, status }] } */
  | 'exporter-json'
  /** Legacy Migaku backup: [["食べる", 2], ["飲む", 1], …] (1 = learning, 2 = known) */
  | 'legacy-json'
  /** { known: [...], learning: [...], ignored: [...] } category buckets */
  | 'category-json'
  /** CSV rows (Word,Reading,Language,Status) or per-category files like known.csv */
  | 'csv'
  /** One word per line (TXT export / hand-pasted list) — status comes from fallbackStatus */
  | 'plain-list'
  /** Could not be parsed */
  | 'invalid';

export interface MigakuParseResult {
  format: MigakuImportFormat;
  entries: MigakuImportEntry[];
  /** Rows that were present but not imported: non-Japanese language, UNKNOWN status, non-Japanese words, malformed rows */
  skipped: number;
  breakdown: { known: number; learning: number; ignored: number };
  error?: string;
}

const STATUS_RANK: Record<ImportableStatus, number> = { known: 3, learning: 2, ignored: 1 };

const KANA_ONLY_RE = /^[ぁ-ゖァ-ヺー・\s]+$/;
const JAPANESE_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;

const WORD_KEYS = ['word', 'term', 'character', 'vocab', 'expression', 'front'];
const READING_KEYS = ['reading', 'kana', 'readingkana', 'pronunciation'];
const STATUS_KEYS = ['status', 'state', 'learningstatus', 'level', 'learningstate'];
const LANGUAGE_KEYS = ['language', 'lang'];

/** Maps Migaku status names (and legacy numeric codes) onto KotoStream statuses. */
export function mapMigakuStatus(raw: unknown): ImportableStatus | null {
  if (typeof raw === 'number') {
    // Legacy Migaku backup: 1 = learning, 2 = known, 0 = untracked
    if (raw === 2) return 'known';
    if (raw === 1) return 'learning';
    return null;
  }
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (s === 'known' || s === 'wellknown' || s === 'mastered') return 'known';
  // 'seen' = has a studied flashcard; 'tracked'/'tracking' = made more prominent — both map to Learning
  if (s === 'learning' || s === 'learn' || s === 'inprogress' || s === 'seen' || s === 'tracked' || s === 'tracking') {
    return 'learning';
  }
  if (s === 'ignored' || s === 'ignore' || s === 'blacklist' || s === 'blacklisted' || s === 'suspended' || s === 'never') {
    return 'ignored';
  }
  return null; // 'unknown', 'new', '' … — untracked, not worth importing
}

/** Reads a value from a loose record by any of the given lowercase key aliases. */
function pick(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const match = Object.keys(record).find((k) => k.toLowerCase().replace(/[\s_-]+/g, '') === key);
    if (match !== undefined && record[match] !== undefined && record[match] !== null) {
      return record[match];
    }
  }
  return undefined;
}

function isKanaReading(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && KANA_ONLY_RE.test(value.trim());
}

function cleanWord(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

/** Minimal RFC-4180 CSV parser (handles quoted fields containing commas/newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

/** Infers a status from a file name like known.csv, ignored-words.txt, learning.json … */
function statusFromFileName(fileName: string): ImportableStatus | null {
  const tokens = fileName.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (tokens.includes('known')) return 'known';
  if (tokens.includes('ignored') || tokens.includes('ignore') || tokens.includes('blacklist')) return 'ignored';
  if (tokens.includes('learning') || tokens.includes('learn')) return 'learning';
  return null;
}

interface Collector {
  entries: Map<string, MigakuImportEntry>;
  skipped: number;
}

function addEntry(
  collector: Collector,
  word: string,
  status: ImportableStatus | null,
  reading: unknown,
  options: { requireJapanese?: boolean } = {}
): void {
  const cleaned = cleanWord(word);
  if (!cleaned || cleaned.length > 64) {
    collector.skipped++;
    return;
  }
  if (options.requireJapanese && !JAPANESE_RE.test(cleaned)) {
    collector.skipped++;
    return;
  }
  // UNKNOWN/untracked rows are not stored by KotoStream (that is the default state anyway)
  if (!status) {
    collector.skipped++;
    return;
  }
  const kanaReading = isKanaReading(reading) ? (reading as string).trim() : undefined;

  const existing = collector.entries.get(cleaned);
  if (!existing) {
    collector.entries.set(cleaned, { word: cleaned, status, reading: kanaReading });
    return;
  }
  // Duplicate word across rows/files: the higher-value status wins, first reading wins
  if (STATUS_RANK[status] > STATUS_RANK[existing.status]) existing.status = status;
  if (!existing.reading && kanaReading) existing.reading = kanaReading;
}

function emptyBreakdown() {
  return { known: 0, learning: 0, ignored: 0 };
}

function finalize(
  format: MigakuImportFormat,
  collector: Collector,
  error?: string
): MigakuParseResult {
  const entries = [...collector.entries.values()];
  const breakdown = emptyBreakdown();
  for (const e of entries) breakdown[e.status]++;
  return { format, entries, skipped: collector.skipped, breakdown, error };
}

function parseJsonExport(parsed: unknown, fallbackStatus: ImportableStatus): MigakuParseResult {
  const collector: Collector = { entries: new Map(), skipped: 0 };

  // { words: [{ word, reading, language, status }] } — Migaku Word Exporter
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const words = Array.isArray(obj.words) ? (obj.words as unknown[]) : null;

    if (words) {
      for (const row of words) {
        if (row && typeof row === 'object' && !Array.isArray(row)) {
          const rec = row as Record<string, unknown>;
          const language = String(pick(rec, LANGUAGE_KEYS) ?? '').trim().toLowerCase();
          // Multi-language exports: only keep Japanese for a Japanese immersion tool
          if (language && language !== 'ja' && language !== 'jpn' && language !== 'japanese') {
            collector.skipped++;
            continue;
          }
          addEntry(
            collector,
            cleanWord(pick(rec, WORD_KEYS)),
            mapMigakuStatus(pick(rec, STATUS_KEYS)),
            pick(rec, READING_KEYS),
            { requireJapanese: true }
          );
        } else if (typeof row === 'string') {
          // Bare string rows inside the words array
          addEntry(collector, row, fallbackStatus, undefined, { requireJapanese: true });
        } else {
          collector.skipped++;
        }
      }
      return finalize('exporter-json', collector);
    }

    // { known: [...], learning: [...], ignored: [...] } category buckets
    const categoryKeys = Object.keys(obj).filter((k) => mapMigakuStatus(k) !== null);
    if (categoryKeys.length > 0) {
      for (const key of categoryKeys) {
        const status = mapMigakuStatus(key) as ImportableStatus;
        const bucket = obj[key];
        if (Array.isArray(bucket)) {
          for (const row of bucket) {
            if (row && typeof row === 'object' && !Array.isArray(row)) {
              const rec = row as Record<string, unknown>;
              addEntry(collector, cleanWord(pick(rec, WORD_KEYS)), status, pick(rec, READING_KEYS), {
                requireJapanese: true,
              });
            } else if (Array.isArray(row)) {
              addEntry(collector, row[0], status, row[1], { requireJapanese: true });
            } else if (typeof row === 'string') {
              addEntry(collector, row, status, undefined, { requireJapanese: true });
            } else {
              collector.skipped++;
            }
          }
        }
      }
      return finalize('category-json', collector);
    }
  }

  // Top-level array: legacy backup [["食べる", 2], …] or [{ word, status }]
  if (Array.isArray(parsed)) {
    for (const row of parsed) {
      if (Array.isArray(row)) {
        // [word, status, (reading…)] — status may sit in the 2nd cell (legacy) or the last cell
        const word = cleanWord(row[0]);
        const status = mapMigakuStatus(row[1]) ?? mapMigakuStatus(row[row.length - 1]);
        const reading = row.slice(1).find((cell) => isKanaReading(cell) && mapMigakuStatus(cell) === null);
        addEntry(collector, word, status, reading, { requireJapanese: true });
      } else if (row && typeof row === 'object') {
        const rec = row as Record<string, unknown>;
        addEntry(collector, cleanWord(pick(rec, WORD_KEYS)), mapMigakuStatus(pick(rec, STATUS_KEYS)), pick(rec, READING_KEYS), {
          requireJapanese: true,
        });
      } else if (typeof row === 'string') {
        addEntry(collector, row, fallbackStatus, undefined, { requireJapanese: true });
      } else {
        collector.skipped++;
      }
    }
    return finalize('legacy-json', collector);
  }

  return finalize('invalid', collector, 'Unrecognized JSON structure — expected a Migaku word export.');
}

function parseCsvExport(text: string, fileName: string | undefined, fallbackStatus: ImportableStatus): MigakuParseResult {
  const collector: Collector = { entries: new Map(), skipped: 0 };
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return finalize('csv', collector, 'Empty CSV.');
  }

  // Header row detection (Word,Reading,Language,Status — the exporter's column set)
  const first = rows[0];
  const lowerFirst = first.map((c) => c.trim().toLowerCase().replace(/[\s_-]+/g, ''));
  const hasHeader =
    lowerFirst.some((c) => WORD_KEYS.includes(c)) &&
    (lowerFirst.some((c) => STATUS_KEYS.includes(c)) || lowerFirst.some((c) => READING_KEYS.includes(c)));

  // Per-category files (known.csv / learning.csv / ignored.csv) carry the status in the name
  const fileStatus = fileName ? statusFromFileName(fileName) : null;

  if (hasHeader) {
    const col = (aliases: string[]) => lowerFirst.findIndex((c) => aliases.includes(c));
    const wordIdx = col(WORD_KEYS);
    const readingIdx = col(READING_KEYS);
    const statusIdx = col(STATUS_KEYS);
    const languageIdx = col(LANGUAGE_KEYS);

    for (const row of rows.slice(1)) {
      if (languageIdx >= 0) {
        const language = String(row[languageIdx] ?? '').trim().toLowerCase();
        if (language && language !== 'ja' && language !== 'jpn' && language !== 'japanese') {
          collector.skipped++;
          continue;
        }
      }
      const status = statusIdx >= 0 ? mapMigakuStatus(row[statusIdx]) : fileStatus ?? fallbackStatus;
      addEntry(collector, row[wordIdx] ?? '', status, readingIdx >= 0 ? row[readingIdx] : undefined, {
        requireJapanese: true,
      });
    }
    return finalize('csv', collector);
  }

  // Header-less rows: [word], [word, reading], [word, status], [word, reading, …, status]
  for (const row of rows) {
    const cells = row.map((c) => c.trim());
    const word = cells[0] ?? '';
    const last = cells[cells.length - 1] ?? '';
    const lastStatus = mapMigakuStatus(last);
    if (lastStatus && cells.length >= 2) {
      // Reading = the first kana-only cell between the word and the status
      const reading = cells.slice(1, -1).find((cell) => isKanaReading(cell));
      addEntry(collector, word, lastStatus, reading, { requireJapanese: true });
    } else {
      const status = fileStatus ?? fallbackStatus;
      const reading = cells.length >= 2 ? cells[1] : undefined;
      addEntry(collector, word, status, reading, { requireJapanese: true });
    }
  }
  return finalize('csv', collector);
}

function parsePlainList(text: string, fallbackStatus: ImportableStatus): MigakuParseResult {
  const collector: Collector = { entries: new Map(), skipped: 0 };
  const tokens = text.split(/[\n,、\t;；]+/);
  for (const raw of tokens) {
    const word = cleanWord(raw);
    if (!word) continue;
    addEntry(collector, word, fallbackStatus, undefined);
  }
  return finalize('plain-list', collector);
}

/**
 * Parses any Migaku word export into KotoStream-importable entries.
 *
 * Supported inputs:
 * - Migaku Word Exporter JSON/CSV/TXT (study.migaku.com → "Export Words")
 * - Legacy Migaku .json backups ([["食べる", 2], …], 1 = learning, 2 = known)
 * - Per-category CSV/TXT files (known.csv, learning.csv, ignored.csv) — status from the file name
 * - Hand-pasted plain lists (one word per line, comma, 、 separated)
 *
 * `fallbackStatus` applies to rows with no status information (TXT exports, plain lists).
 */
export function parseMigakuExport(
  input: string,
  options: { fileName?: string; fallbackStatus?: ImportableStatus } = {}
): MigakuParseResult {
  const fallbackStatus = options.fallbackStatus ?? 'known';
  const text = input.trim();

  if (!text) {
    return { format: 'invalid', entries: [], skipped: 0, breakdown: emptyBreakdown(), error: 'Nothing to import.' };
  }

  const fileName = options.fileName?.toLowerCase() ?? '';
  const looksJson = text.startsWith('{') || text.startsWith('[');

  if (looksJson) {
    try {
      const parsed: unknown = JSON.parse(text);
      return parseJsonExport(parsed, fallbackStatus);
    } catch {
      return {
        format: 'invalid',
        entries: [],
        skipped: 0,
        breakdown: emptyBreakdown(),
        error: 'Invalid JSON — could not parse the export.',
      };
    }
  }

  const lines = text.split(/\r?\n/);
  const firstLine = lines[0] ?? '';
  const rowsHaveStatuses = lines
    .slice(0, 60)
    .some((line) => line.includes(',') && mapMigakuStatus(line.slice(line.lastIndexOf(',') + 1)) !== null);
  const fileNameStatus = fileName ? statusFromFileName(fileName) : null;
  const isCsvFile = fileName.endsWith('.csv');

  const firstLineCells = firstLine
    .split(',')
    .map((c) => c.trim().toLowerCase().replace(/[\s_-]+/g, ''));
  const firstLineLooksHeader =
    firstLine.includes(',') &&
    firstLineCells.some((c) => WORD_KEYS.includes(c)) &&
    (firstLineCells.some((c) => STATUS_KEYS.includes(c)) || firstLineCells.some((c) => READING_KEYS.includes(c)));

  // CSV only when there is real CSV evidence: the .csv extension, a Word/Reading/Status header,
  // per-category file names, or rows ending in a status. Everything else (including pasted
  // comma-separated word lists) goes through the plain-list parser which also handles 、 and tabs.
  if (isCsvFile || fileNameStatus || rowsHaveStatuses || firstLineLooksHeader) {
    return parseCsvExport(text, options.fileName, fallbackStatus);
  }

  return parsePlainList(text, fallbackStatus);
}

/** Merges parsed entries from multiple files/pastes into one de-duplicated list (higher status rank wins). */
export function mergeMigakuEntries(entryLists: MigakuImportEntry[][]): MigakuImportEntry[] {
  const collector: Collector = { entries: new Map(), skipped: 0 };
  for (const list of entryLists) {
    for (const entry of list) {
      addEntry(collector, entry.word, entry.status, entry.reading);
    }
  }
  return [...collector.entries.values()];
}

/** A single uploaded/dropped file: its name and raw bytes. */
export interface MigakuFileInput {
  name: string;
  data: Uint8Array;
}

export interface MigakuParsedFile {
  /** Best-effort source label (e.g. the .csv inside an uploaded .zip) */
  name: string;
  result: MigakuParseResult;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** True when the bytes clearly are not a text export (NUL bytes / control-character runs). */
function looksLikeBinary(data: Uint8Array): boolean {
  const checkLen = Math.min(data.length, 4096);
  if (checkLen === 0) return false;
  let control = 0;
  for (let i = 0; i < checkLen; i++) {
    const b = data[i];
    if (b === 0) return true;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) control++;
  }
  return control / checkLen > 0.05;
}

/** Decodes export bytes as UTF-8 (BOM-stripped), falling back to UTF-16 and Shift-JIS for Excel exports. */
export function decodeTextBytes(data: Uint8Array): string {
  // UTF-16 BOM → Excel "Unicode Text" exports
  if (
    data.length >= 2 &&
    ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff))
  ) {
    return new TextDecoder(data[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(data);
  }
  const bomStripped =
    data.length >= 3 && data[0] === UTF8_BOM[0] && data[1] === UTF8_BOM[1] && data[2] === UTF8_BOM[2]
      ? data.subarray(3)
      : data;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bomStripped);
  } catch {
    // Not valid UTF-8 — try Shift-JIS before giving up and decoding leniently
    try {
      return new TextDecoder('shift-jis').decode(bomStripped);
    } catch {
      return new TextDecoder('utf-8').decode(bomStripped);
    }
  }
}

async function gunzipBytes(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([data as unknown as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

function looksLikeZip(data: Uint8Array): boolean {
  // Local file header "PK\x03\x04" / empty archive "PK\x05\x06"
  return (
    data.length > 4 &&
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    ((data[2] === 0x03 && data[3] === 0x04) || (data[2] === 0x05 && data[3] === 0x06))
  );
}

function looksLikeGzip(data: Uint8Array): boolean {
  return data.length > 2 && data[0] === 0x1f && data[1] === 0x8b;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Only descend into archive members that can actually be word exports (json/csv/txt + nested archives). */
const WORD_MEMBER_RE = /\.(json|jsonl|csv|txt|tsv|zip|gz)$/i;

/**
 * Parses any uploaded/dropped Migaku export file — the format is detected from the CONTENT,
 * so any extension works:
 * - .json / .csv / .txt / .tsv parsed directly (UTF-8 or Shift-JIS, BOM-tolerant)
 * - .zip archives (e.g. the "Export wordlists" bundle) are descended into transparently,
 *   preserving member names like known.csv / learning.csv / ignored.csv for status inference
 * - .gz files are gunzipped first
 * Returns one result per file that ends up being parsed.
 */
export async function parseMigakuFile(
  file: MigakuFileInput,
  fallbackStatus: ImportableStatus = 'known'
): Promise<MigakuParsedFile[]> {
  const lowerName = file.name.toLowerCase();

  // gzip → decompress, strip the extension, and parse what's inside
  if (lowerName.endsWith('.gz') || looksLikeGzip(file.data)) {
    const decompressed = await gunzipBytes(file.data);
    if (decompressed) {
      return parseMigakuFile(
        { name: baseName(lowerName.replace(/\.gz$/, '')) || 'words', data: decompressed },
        fallbackStatus
      );
    }
    // Decompression failed — fall through and try reading it as text
  }

  // zip → recurse into every archive member (skip macOS cruft & directories)
  if (lowerName.endsWith('.zip') || looksLikeZip(file.data)) {
    try {
      const { unzipSync } = await import('fflate');
      const members = unzipSync(file.data);
      const results: MigakuParsedFile[] = [];
      for (const [path, bytes] of Object.entries(members)) {
        if (bytes.length === 0) continue; // directory entries
        if (/(^|\/)(__MACOSX|\.DS_Store)/i.test(path)) continue;
        const name = baseName(path);
        if (!name || !WORD_MEMBER_RE.test(name)) continue; // .anki2, media, xlsx internals, …
        results.push(...(await parseMigakuFile({ name, data: bytes }, fallbackStatus)));
      }
      if (results.length > 0) return results;
      return [
        {
          name: baseName(file.name),
          result: {
            format: 'invalid',
            entries: [],
            skipped: 0,
            breakdown: emptyBreakdown(),
            error: 'The .zip archive contained no readable word files.',
          },
        },
      ];
    } catch {
      // Not a readable zip (or a text file that happens to start with "PK") — fall through to text
    }
  }

  // Refuse clearly-binary payloads (sqlite, images, .anki2 …) instead of importing mojibake junk
  if (looksLikeBinary(file.data)) {
    return [
      {
        name: baseName(file.name) || 'file',
        result: {
          format: 'invalid',
          entries: [],
          skipped: 0,
          breakdown: emptyBreakdown(),
          error: 'Not a word export — this file is binary (expected a .json / .csv / .txt word list).',
        },
      },
    ];
  }

  const text = decodeTextBytes(file.data);
  const result = parseMigakuExport(text, { fileName: file.name || undefined, fallbackStatus });
  return [{ name: baseName(file.name) || 'pasted text', result }];
}