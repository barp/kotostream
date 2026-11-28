import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, MinedCard, VocabEntry, WordStatus } from '../../types';
import {
  bulkImportVocabEntries,
  deleteMinedCard,
  getVocabMap,
  hydrateMinedCard,
  setWordStatus,
  updateMinedCard,
} from '../../core/storage';
import { exportCardsToTsv, exportCardToAnki } from '../../core/anki';
import {
  type ImportableStatus,
  type MigakuImportEntry,
  mergeMigakuEntries,
  parseMigakuExport,
  parseMigakuFile,
} from '../../core/migaku-import';

const CARDS_PER_PAGE = 25;
const VOCAB_PER_PAGE = 50;
const ALL_STATUSES: WordStatus[] = ['known', 'learning', 'ignored', 'unknown'];

interface VocabTabProps {
  settings: AppSettings;
  cards: MinedCard[];
  vocabMap: Record<string, VocabEntry>;
  onReload: () => Promise<void>;
  onNotice: (type: 'success' | 'error', text: string) => void;
}

export const VocabTab: React.FC<VocabTabProps> = ({
  settings,
  cards,
  vocabMap,
  onReload,
  onNotice,
}) => {
  // Mined cards filter & pagination
  const [cardSearch, setCardSearch] = useState('');
  const [cardPage, setCardPage] = useState(1);
  const [syncingCardId, setSyncingCardId] = useState<string | null>(null);
  const [playingCardId, setPlayingCardId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Tracked vocab filter & pagination
  const [vocabSearch, setVocabSearch] = useState('');
  const [vocabFilter, setVocabFilter] = useState<'all' | WordStatus>('all');
  const [vocabPage, setVocabPage] = useState(1);

  // Migaku import state
  const [migakuPaste, setMigakuPaste] = useState('');
  const [migakuFallback, setMigakuFallback] = useState<ImportableStatus>('known');
  const [migakuDragOver, setMigakuDragOver] = useState(false);
  const [migakuPending, setMigakuPending] = useState<{
    entries: MigakuImportEntry[];
    skipped: number;
    sourceLabel: string;
  } | null>(null);
  const [migakuNotice, setMigakuNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const migakuNoticeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const setMigakuFeedback = (type: 'success' | 'error', text: string) => {
    setMigakuNotice({ type, text });
    window.setTimeout(() => {
      migakuNoticeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 60);
  };

  const filteredCards = useMemo(() => {
    const q = cardSearch.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter(
      (c) =>
        c.word.toLowerCase().includes(q) ||
        c.reading.toLowerCase().includes(q) ||
        c.sentence.toLowerCase().includes(q) ||
        c.meaning.toLowerCase().includes(q) ||
        (c.translation ?? '').toLowerCase().includes(q)
    );
  }, [cards, cardSearch]);

  const totalCardPages = Math.max(1, Math.ceil(filteredCards.length / CARDS_PER_PAGE));
  const safeCardPage = Math.min(cardPage, totalCardPages);
  const pagedCards = filteredCards.slice(
    (safeCardPage - 1) * CARDS_PER_PAGE,
    safeCardPage * CARDS_PER_PAGE
  );

  const vocabEntries = useMemo(() => Object.values(vocabMap), [vocabMap]);

  const statusCounts = useMemo(() => {
    const counts = { all: vocabEntries.length, known: 0, learning: 0, ignored: 0, unknown: 0 };
    for (const v of vocabEntries) {
      counts[v.status]++;
    }
    return counts;
  }, [vocabEntries]);

  const filteredVocab = useMemo(() => {
    const q = vocabSearch.trim().toLowerCase();
    return vocabEntries
      .filter((v) => (vocabFilter === 'all' ? true : v.status === vocabFilter))
      .filter((v) => {
        if (!q) return true;
        return (
          v.word.toLowerCase().includes(q) ||
          v.reading.toLowerCase().includes(q) ||
          v.meaning.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [vocabEntries, vocabFilter, vocabSearch]);

  const totalVocabPages = Math.max(1, Math.ceil(filteredVocab.length / VOCAB_PER_PAGE));
  const safeVocabPage = Math.min(vocabPage, totalVocabPages);
  const pagedVocab = filteredVocab.slice(
    (safeVocabPage - 1) * VOCAB_PER_PAGE,
    safeVocabPage * VOCAB_PER_PAGE
  );

  const handleSyncCardToAnki = async (card: MinedCard) => {
    setSyncingCardId(card.id);
    try {
      const hydrated = await hydrateMinedCard(card);
      const noteId = await exportCardToAnki(hydrated, settings.anki);
      await updateMinedCard({ ...card, ankiNoteId: noteId });
      await onReload();
      onNotice('success', `Exported “${card.word}” to Anki (Note #${noteId})`);
    } catch (err) {
      onNotice('error', err instanceof Error ? err.message : 'Anki export failed');
    } finally {
      setSyncingCardId(null);
    }
  };

  const handlePlayCardAudio = async (card: MinedCard) => {
    const wasPlayingThis = playingCardId === card.id;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (wasPlayingThis) {
      setPlayingCardId(null);
      return;
    }
    const hydrated = await hydrateMinedCard(card);
    if (!hydrated.audioBase64) {
      onNotice('error', 'No audio clip saved for this card.');
      return;
    }
    const mime = hydrated.audioMimeType || 'audio/wav';
    const audio = new Audio(`data:${mime};base64,${hydrated.audioBase64}`);
    audioRef.current = audio;
    setPlayingCardId(card.id);
    audio.onended = () => {
      if (audioRef.current === audio) audioRef.current = null;
      setPlayingCardId((id) => (id === card.id ? null : id));
    };
    audio.onerror = () => {
      if (audioRef.current === audio) audioRef.current = null;
      setPlayingCardId((id) => (id === card.id ? null : id));
    };
    try {
      await audio.play();
    } catch {
      setPlayingCardId(null);
    }
  };

  const handleDeleteCard = async (card: MinedCard) => {
    if (!window.confirm(`Delete mined card “${card.word}”? This cannot be undone.`)) return;
    await deleteMinedCard(card.id);
    await onReload();
    onNotice('success', `Deleted mined card “${card.word}”.`);
  };

  const handleDownloadTsv = () => {
    const tsv = exportCardsToTsv(cards);
    const blob = new Blob([tsv], { type: 'text/tab-separated-values;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kotostream-cards-${new Date().toISOString().slice(0, 10)}.tsv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleVocabStatusChange = async (word: string, status: WordStatus) => {
    await setWordStatus(word, status);
    await onReload();
  };

  const handleMigakuFileList = async (files: File[]) => {
    if (files.length === 0) return;
    const entryLists: MigakuImportEntry[][] = [];
    let skipped = 0;
    const labels: string[] = [];
    const errors: string[] = [];
    for (const file of files) {
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        const parsed = await parseMigakuFile({ name: file.name, data }, migakuFallback);
        for (const { name, result } of parsed) {
          if (result.entries.length === 0) {
            errors.push(`“${name}”: ${result.error ?? 'No importable Japanese words found.'}`);
            continue;
          }
          entryLists.push(result.entries);
          skipped += result.skipped;
          labels.push(name);
        }
      } catch {
        errors.push(`Could not read “${file.name}”.`);
      }
    }
    if (entryLists.length === 0) {
      setMigakuFeedback('error', errors.join('\n') || 'No importable Japanese words found.');
      return;
    }
    if (errors.length > 0) {
      setMigakuFeedback('error', `Some files could not be read:\n${errors.join('\n')}`);
    } else {
      setMigakuNotice(null);
    }
    setMigakuPending({
      entries: mergeMigakuEntries(entryLists),
      skipped,
      sourceLabel: labels.join(', '),
    });
  };

  const handleMigakuFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handleMigakuFileList(Array.from(e.target.files ?? []));
    e.target.value = '';
  };

  const handleMigakuDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setMigakuDragOver(false);
    await handleMigakuFileList(Array.from(e.dataTransfer.files ?? []));
  };

  const handleMigakuImport = async () => {
    let pending = migakuPending;
    if (!pending && migakuPaste.trim()) {
      const res = parseMigakuExport(migakuPaste, { fallbackStatus: migakuFallback });
      if (res.entries.length === 0) {
        setMigakuFeedback('error', res.error ?? 'No importable Japanese words found in the pasted text.');
        return;
      }
      pending = { entries: res.entries, skipped: res.skipped, sourceLabel: 'pasted text' };
    }
    if (!pending || pending.entries.length === 0) {
      setMigakuFeedback('error', 'Pick a Migaku export file (or paste one) first.');
      return;
    }
    const res = await bulkImportVocabEntries(pending.entries);
    if (!res.persisted) {
      setMigakuFeedback('error', `Could not save the import: ${res.error ?? 'storage write failed.'}`);
      return;
    }
    const { added, updated } = res;
    setMigakuPending(null);
    setMigakuPaste('');
    await onReload();
    const b = { known: 0, learning: 0, ignored: 0 };
    for (const entry of pending.entries) b[entry.status]++;
    const parts = [
      b.known ? `${b.known} known` : '',
      b.learning ? `${b.learning} learning` : '',
      b.ignored ? `${b.ignored} ignored` : '',
    ].filter(Boolean);
    const finalMap = await getVocabMap();
    const total = Object.keys(finalMap).length;
    setMigakuFeedback(
      'success',
      `Imported ${added + updated} words (${added} new, ${updated} updated): ${parts.join(
        ' · '
      )}. Vocabulary now tracks ${total} words in total — subtitles update live.`
    );
  };

  const cardStart = filteredCards.length === 0 ? 0 : (safeCardPage - 1) * CARDS_PER_PAGE + 1;
  const cardEnd = Math.min(filteredCards.length, safeCardPage * CARDS_PER_PAGE);
  const vocabStart = filteredVocab.length === 0 ? 0 : (safeVocabPage - 1) * VOCAB_PER_PAGE + 1;
  const vocabEnd = Math.min(filteredVocab.length, safeVocabPage * VOCAB_PER_PAGE);

  return (
    <div>
      {/* Mined Cards Panel */}
      <div className="panel">
        <div className="row between mb-md">
          <div>
            <h2>Mined Cards ({cards.length})</h2>
            <p className="panel-desc no-margin">
              Review your mined cards, replay full-quality sentence audio, sync to AnkiConnect, or export as TSV.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleDownloadTsv}
            disabled={cards.length === 0}
          >
            Export TSV
          </button>
        </div>

        {cards.length > 0 && (
          <div className="row mb-md">
            <input
              type="text"
              className="input-base input-grow"
              placeholder="Search mined cards by word, sentence, or translation…"
              value={cardSearch}
              onChange={(e) => {
                setCardSearch(e.target.value);
                setCardPage(1);
              }}
            />
          </div>
        )}

        {cards.length === 0 ? (
          <p className="panel-desc no-margin">No mined cards yet. Hover over any subtitle word and click “Mine Card”.</p>
        ) : filteredCards.length === 0 ? (
          <p className="panel-desc no-margin">No mined cards match “{cardSearch}”.</p>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>Word</th>
                  <th>Sentence &amp; Translation</th>
                  <th>Meaning</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagedCards.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.word}</strong>
                      <div className="sub-meta">{c.reading}</div>
                    </td>
                    <td className="card-sentence-cell">
                      <div>{c.sentence}</div>
                      {c.translation && <div className="card-trans">{c.translation}</div>}
                    </td>
                    <td>{c.meaning}</td>
                    <td>
                      <div className="row tight">
                        {(c.hasAudio || c.audioBase64) && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => void handlePlayCardAudio(c)}
                            title="Play sentence audio"
                          >
                            {playingCardId === c.id ? '🔊 Playing' : '▶ Audio'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={syncingCardId === c.id}
                          onClick={() => void handleSyncCardToAnki(c)}
                        >
                          {syncingCardId === c.id
                            ? 'Sending…'
                            : c.ankiNoteId
                              ? '✓ Re-send Anki'
                              : 'Send to Anki'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => void handleDeleteCard(c)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="pagination-bar">
              <span className="pagination-info">
                Showing {cardStart}–{cardEnd} of {filteredCards.length} card{filteredCards.length === 1 ? '' : 's'}
              </span>
              {totalCardPages > 1 && (
                <div className="row tight">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={safeCardPage <= 1}
                    onClick={() => setCardPage((p) => Math.max(1, p - 1))}
                  >
                    Prev
                  </button>
                  <span className="pagination-info">
                    Page {safeCardPage} / {totalCardPages}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={safeCardPage >= totalCardPages}
                    onClick={() => setCardPage((p) => Math.min(totalCardPages, p + 1))}
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Tracked Vocabulary Panel */}
      <div className="panel">
        <h2>Tracked Vocabulary ({filteredVocab.length})</h2>
        <p className="panel-desc">Words marked as Known or Ignored won&apos;t be underlined in subtitles.</p>

        <div className="row mb-md">
          <input
            type="text"
            className="input-base input-grow"
            placeholder="Search Japanese word, reading, or English…"
            value={vocabSearch}
            onChange={(e) => {
              setVocabSearch(e.target.value);
              setVocabPage(1);
            }}
          />
          {(['all', ...ALL_STATUSES] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`btn btn-sm ${vocabFilter === f ? 'btn-primary' : ''}`}
              onClick={() => {
                setVocabFilter(f);
                setVocabPage(1);
              }}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)} ({statusCounts[f]})
            </button>
          ))}
        </div>

        {filteredVocab.length === 0 ? (
          <p className="panel-desc no-margin">No tracked vocabulary entries match this filter.</p>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>Word</th>
                  <th>Reading</th>
                  <th>Meaning</th>
                  <th>Status</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {pagedVocab.map((v) => (
                  <tr key={v.word}>
                    <td><strong>{v.word}</strong></td>
                    <td>{v.reading}</td>
                    <td>{v.meaning}</td>
                    <td><span className={`pill ${v.status}`}>{v.status}</span></td>
                    <td>
                      <div className="status-btn-group">
                        {ALL_STATUSES.map((st) => (
                          <button
                            key={st}
                            type="button"
                            className={`status-choice ${v.status === st ? `active-${st}` : ''}`}
                            onClick={() => void handleVocabStatusChange(v.word, st)}
                          >
                            {st}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="pagination-bar">
              <span className="pagination-info">
                Showing {vocabStart}–{vocabEnd} of {filteredVocab.length} word{filteredVocab.length === 1 ? '' : 's'}
              </span>
              {totalVocabPages > 1 && (
                <div className="row tight">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={safeVocabPage <= 1}
                    onClick={() => setVocabPage((p) => Math.max(1, p - 1))}
                  >
                    Prev
                  </button>
                  <span className="pagination-info">
                    Page {safeVocabPage} / {totalVocabPages}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={safeVocabPage >= totalVocabPages}
                    onClick={() => setVocabPage((p) => Math.min(totalVocabPages, p + 1))}
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Migaku Import Panel */}
      <div className="panel">
        <h2>Import from Migaku</h2>
        <p className="panel-desc">
          Drop or upload <strong>any</strong> Migaku word export — .json, .csv, .txt, .tsv, .gz, or the .zip from
          “Export wordlists”. The format and statuses (<strong>Known</strong> / <strong>Learning</strong> /{' '}
          <strong>Ignored</strong>) are detected automatically from the file contents, and imported words apply
          live to subtitle underlines and the browser panel.
        </p>
        <div
          className={`dropzone ${migakuDragOver ? 'drag-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setMigakuDragOver(true);
          }}
          onDragLeave={() => setMigakuDragOver(false)}
          onDrop={(e) => void handleMigakuDrop(e)}
        >
          <div className="dropzone-title">
            {migakuDragOver
              ? 'Drop the files to load them…'
              : 'Drag & drop your Migaku export here — multiple files OK, .zip / .gz included'}
          </div>
          <label className="btn btn-primary file-btn">
            Choose Migaku Export File(s)
            <input
              type="file"
              multiple
              onChange={(e) => void handleMigakuFiles(e)}
              style={{ display: 'none' }}
            />
          </label>
          <div className="row center mt-md">
            <span className="muted-note">Word lists with no statuses import as</span>
            <select
              className="input-base"
              value={migakuFallback}
              onChange={(e) => setMigakuFallback(e.target.value as ImportableStatus)}
            >
              <option value="known">Known</option>
              <option value="learning">Learning</option>
              <option value="ignored">Ignored</option>
            </select>
          </div>
        </div>
        <div className="field mt-md">
          <label>…or paste words / CSV / JSON directly</label>
          <textarea
            rows={5}
            placeholder={'食べる,たべる,ja,KNOWN\n今日,きょう,ja,IGNORED\n\n…or one word per line (they get the status chosen above)'}
            value={migakuPaste}
            onChange={(e) => setMigakuPaste(e.target.value)}
          />
        </div>
        {migakuPending && (
          <div className="row between pending-import-bar">
            <span>
              Ready: <strong>{migakuPending.entries.length}</strong> words from {migakuPending.sourceLabel}
              {migakuPending.skipped > 0 ? ` · ${migakuPending.skipped} skipped` : ''}
            </span>
            <button type="button" className="btn btn-sm" onClick={() => setMigakuPending(null)}>
              Clear
            </button>
          </div>
        )}
        <div className="mt-md">
          <button type="button" className="btn btn-primary" onClick={() => void handleMigakuImport()}>
            {migakuPending ? `Import ${migakuPending.entries.length} words` : 'Import to Vocab'}
          </button>
        </div>
        {migakuNotice && (
          <div ref={migakuNoticeRef} className={`inline-notice ${migakuNotice.type}`}>
            {migakuNotice.text}
          </div>
        )}
      </div>
    </div>
  );
};
