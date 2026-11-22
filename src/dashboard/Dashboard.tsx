import React, { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  type AnkiFieldMapping,
  type AppSettings,
  type CardType,
  type DictionaryEntry,
  type ExtensionMessage,
  type FuriganaFormat,
  type JimakuEntry,
  type JimakuFile,
  type MinedCard,
  type SavedSubtitleTrack,
  type ScreenshotFormat,
  type Token,
  type TranslationProvider,
  type VocabEntry,
  type WordStatus,
} from '../types';
import {
  addMinedCard,
  bulkImportKnownWords,
  deleteMinedCard,
  deleteSubtitleTrack,
  getMinedCards,
  getSettings,
  getSubtitleLibrary,
  getVocabMap,
  saveSettings,
  saveSubtitleTrack,
  setWordStatus,
  updateMinedCard,
} from '../core/storage';
import { formatSubtitlesToSrt, parseSubtitleFile } from '../core/subtitle-parser';
import { preTranscribeMediaFile } from '../core/batch-transcribe';
import { formatIntervalPreview, scheduleReview, type ReviewRating } from '../core/srs';
import {
  buildAnkiFieldPreview,
  exportCardsToTsv,
  exportCardToAnki,
  getAnkiDecks,
  getAnkiModelFields,
  getAnkiModels,
  testAnkiConnection,
} from '../core/anki';
import { tokenizeJapanese } from '../core/tokenizer';
import { lookupLocal } from '../core/dictionary';

type DashboardTab = 'review' | 'vocab' | 'subtitles' | 'settings' | 'playground';

const SAMPLE_SENTENCES = [
  '昨日の夜、友達と一緒に面白い映画を見ていたんだ。',
  '絶対にあの約束を守ってみせるから、信じてほしい。',
  '今日は雨が降っているけど、明日はいい天気になりそうだね。',
  '日本語の字幕がなくても、このツールがあれば勉強できるよ。',
];

const MIGAKU_FIELD_LABELS: Array<{ key: keyof AnkiFieldMapping; label: string; placeholder: string }> = [
  { key: 'targetWord', label: 'Target Word', placeholder: 'Target Word' },
  { key: 'reading', label: 'Reading (Furigana)', placeholder: 'Reading' },
  { key: 'sentence', label: 'Sentence', placeholder: 'Sentence' },
  { key: 'translation', label: 'Sentence Translation', placeholder: 'Translation' },
  { key: 'definitions', label: 'Definitions', placeholder: 'Definitions' },
  { key: 'image', label: 'Screenshot Image', placeholder: 'Image' },
  { key: 'sentenceAudio', label: 'Sentence Audio', placeholder: 'Sentence Audio' },
  { key: 'notes', label: 'Notes', placeholder: 'Notes' },
  { key: 'source', label: 'Source / Show Title', placeholder: '(optional)' },
];

function getInitialTab(): DashboardTab {
  const hash = window.location.hash.replace('#', '');
  if (
    hash === 'review' ||
    hash === 'vocab' ||
    hash === 'subtitles' ||
    hash === 'settings' ||
    hash === 'playground'
  ) {
    return hash;
  }
  return 'subtitles';
}

export const Dashboard: React.FC = () => {
  const [tab, setTab] = useState<DashboardTab>(getInitialTab);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [vocabMap, setVocabMap] = useState<Record<string, VocabEntry>>({});
  const [cards, setCards] = useState<MinedCard[]>([]);
  const [subtitleLibrary, setSubtitleLibrary] = useState<SavedSubtitleTrack[]>([]);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Subtitles / Jimaku / Pre-Transcribe state
  const [jimakuQuery, setJimakuQuery] = useState('');
  const [jimakuEpisode, setJimakuEpisode] = useState('');
  const [jimakuEntries, setJimakuEntries] = useState<JimakuEntry[]>([]);
  const [selectedJimakuEntry, setSelectedJimakuEntry] = useState<JimakuEntry | null>(null);
  const [jimakuFiles, setJimakuFiles] = useState<JimakuFile[]>([]);
  const [jimakuBusy, setJimakuBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState<string>('');
  const [batchBusy, setBatchBusy] = useState(false);

  // Review state
  const [showAnswer, setShowAnswer] = useState(false);

  // Vocab state
  const [vocabSearch, setVocabSearch] = useState('');
  const [vocabFilter, setVocabFilter] = useState<'all' | WordStatus>('all');
  const [bulkInput, setBulkInput] = useState('');

  // Anki discovery state
  const [ankiDecks, setAnkiDecks] = useState<string[]>([]);
  const [ankiModels, setAnkiModels] = useState<string[]>([]);
  const [ankiFields, setAnkiFields] = useState<string[]>([]);
  const [ankiStatus, setAnkiStatus] = useState<string>('');

  // Playground state
  const [pgText, setPgText] = useState(SAMPLE_SENTENCES[0]);
  const [pgSelectedToken, setPgSelectedToken] = useState<Token | null>(null);
  const [pgEntry, setPgEntry] = useState<DictionaryEntry | null>(null);
  const [pgTranslation, setPgTranslation] = useState('');
  const [pgTranslating, setPgTranslating] = useState(false);
  const [pgNotes, setPgNotes] = useState('');
  const [pgLoading, setPgLoading] = useState(false);

  const showNotice = (type: 'success' | 'error', text: string) => {
    setBanner({ type, text });
    window.setTimeout(() => setBanner(null), 4500);
  };

  const reloadAll = async () => {
    const [s, v, c, lib] = await Promise.all([
      getSettings(),
      getVocabMap(),
      getMinedCards(),
      getSubtitleLibrary(),
    ]);
    setSettings(s);
    setVocabMap(v);
    setCards(c);
    setSubtitleLibrary(lib);
  };

  useEffect(() => {
    void reloadAll();
  }, []);

  const dueCards = useMemo(() => {
    const now = Date.now();
    return cards.filter((c) => c.srs.dueAt <= now).sort((a, b) => a.srs.dueAt - b.srs.dueAt);
  }, [cards]);

  const currentReviewCard = dueCards[0] ?? null;

  const handleRateCard = async (rating: ReviewRating) => {
    if (!currentReviewCard) return;
    const updated: MinedCard = {
      ...currentReviewCard,
      srs: scheduleReview(currentReviewCard.srs, rating),
    };
    await updateMinedCard(updated);

    if (updated.srs.intervalDays >= 21) {
      await setWordStatus(updated.word, 'known', {
        reading: updated.reading,
        meaning: updated.meaning,
      });
    }

    setShowAnswer(false);
    await reloadAll();
  };

  const handlePlayAudio = (card: MinedCard) => {
    if (!card.audioBase64) return;
    const mime = card.audioMimeType || 'audio/webm';
    const audio = new Audio(`data:${mime};base64,${card.audioBase64}`);
    void audio.play();
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    await saveSettings(settings);
    showNotice('success', 'Settings saved! Changes apply immediately to active video tabs.');
  };

  const applyFieldPreset = (preset: 'migaku' | 'basic') => {
    if (preset === 'migaku') {
      setSettings((s) => ({
        ...s,
        anki: {
          ...s.anki,
          modelName: 'Migaku Japanese',
          fieldMapping: {
            targetWord: 'Target Word',
            reading: 'Reading',
            sentence: 'Sentence',
            translation: 'Translation',
            definitions: 'Definitions',
            image: 'Image',
            sentenceAudio: 'Sentence Audio',
            notes: 'Notes',
            source: '',
          },
        },
      }));
    } else {
      setSettings((s) => ({
        ...s,
        anki: {
          ...s.anki,
          modelName: 'Basic',
          fieldMapping: {
            targetWord: 'Front',
            reading: '',
            sentence: 'Front',
            translation: 'Back',
            definitions: 'Back',
            image: 'Back',
            sentenceAudio: 'Back',
            notes: 'Back',
            source: '',
          },
        },
      }));
    }
  };

  const handleTestAnki = async () => {
    setAnkiStatus('Connecting…');
    try {
      const version = await testAnkiConnection(settings.anki.url);
      const [decks, models] = await Promise.all([
        getAnkiDecks(settings.anki.url),
        getAnkiModels(settings.anki.url),
      ]);
      setAnkiDecks(decks);
      setAnkiModels(models);

      const activeModel = models.includes(settings.anki.modelName)
        ? settings.anki.modelName
        : models[0] ?? '';

      if (activeModel) {
        const fields = await getAnkiModelFields(activeModel, settings.anki.url);
        setAnkiFields(fields);
      }

      setAnkiStatus(`Connected (AnkiConnect v${version}) — ${decks.length} decks, ${models.length} note types.`);
      showNotice('success', `Connected to AnkiConnect v${version}!`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAnkiStatus(`Failed: ${msg}. Make sure Anki is open with AnkiConnect (code 2055492159) installed.`);
      showNotice('error', `AnkiConnect error: ${msg}`);
    }
  };

  const handleModelChange = async (modelName: string) => {
    setSettings((s) => ({ ...s, anki: { ...s.anki, modelName } }));
    try {
      const fields = await getAnkiModelFields(modelName, settings.anki.url);
      setAnkiFields(fields);
    } catch {
      // Ignore if Anki isn't currently connected
    }
  };

  const handleSyncCardToAnki = async (card: MinedCard) => {
    try {
      const noteId = await exportCardToAnki(card, settings.anki);
      await updateMinedCard({ ...card, ankiNoteId: noteId });
      await reloadAll();
      showNotice('success', `Exported “${card.word}” to Anki (Note #${noteId})`);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Anki export failed');
    }
  };

  const handleJimakuSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!jimakuQuery.trim()) return;
    setJimakuBusy(true);
    setSelectedJimakuEntry(null);
    setJimakuFiles([]);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'JIMAKU_SEARCH',
        query: jimakuQuery.trim(),
      } satisfies ExtensionMessage)) as { entries?: JimakuEntry[]; error?: string };
      if (res?.error) {
        showNotice('error', res.error);
      } else {
        setJimakuEntries(res?.entries ?? []);
        if ((res?.entries ?? []).length === 0) {
          showNotice('error', `No shows found on Jimaku for “${jimakuQuery}”.`);
        }
      }
    } finally {
      setJimakuBusy(false);
    }
  };

  const handleSelectJimakuEntry = async (entry: JimakuEntry) => {
    setSelectedJimakuEntry(entry);
    setJimakuBusy(true);
    try {
      const epNum = jimakuEpisode.trim() ? Number(jimakuEpisode.trim()) : undefined;
      const res = (await chrome.runtime.sendMessage({
        type: 'JIMAKU_LIST_FILES',
        entryId: entry.id,
        episode: epNum,
      } satisfies ExtensionMessage)) as { files?: JimakuFile[]; error?: string };
      if (res?.error) {
        showNotice('error', res.error);
      } else {
        setJimakuFiles(res?.files ?? []);
      }
    } finally {
      setJimakuBusy(false);
    }
  };

  const handleImportJimakuFile = async (file: JimakuFile) => {
    setJimakuBusy(true);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'JIMAKU_DOWNLOAD',
        url: file.url,
      } satisfies ExtensionMessage)) as { text?: string; error?: string };
      if (res?.error || !res?.text) {
        showNotice('error', res?.error || 'Could not download subtitle file');
        return;
      }
      const cues = parseSubtitleFile(res.text);
      if (cues.length === 0) {
        showNotice('error', 'No valid Japanese cues found in this file.');
        return;
      }
      await saveSubtitleTrack({
        title: selectedJimakuEntry?.name || file.name,
        fileName: file.name,
        offsetSec: 0,
        source: 'jimaku',
        cues,
      });
      await reloadAll();
      showNotice(
        'success',
        `Saved “${file.name}” (${cues.length} lines) to Library! Open Amazon Prime and click Library on the video toolbar to sync it.`
      );
    } finally {
      setJimakuBusy(false);
    }
  };

  const handleImportLocalSubtitleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    e.target.value = '';
    const cues = parseSubtitleFile(text);
    if (cues.length === 0) {
      showNotice('error', 'No valid cues found in subtitle file (.srt, .vtt, .ass).');
      return;
    }
    await saveSubtitleTrack({
      title: file.name.replace(/\.(srt|vtt|ass)$/i, ''),
      fileName: file.name,
      offsetSec: 0,
      source: 'file',
      cues,
    });
    await reloadAll();
    showNotice('success', `Imported “${file.name}” (${cues.length} lines) into your Subtitle Library.`);
  };

  const handlePreTranscribeFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setBatchBusy(true);
    setBatchProgress(`Decoding ${file.name}…`);
    try {
      const cues = await preTranscribeMediaFile(file, (done, total) => {
        setBatchProgress(`Transcribing at max quality via OpenRouter: chunk ${done} / ${total}…`);
      });
      if (cues.length === 0) {
        showNotice('error', 'No Japanese speech was detected in that file.');
        return;
      }
      const srtName = file.name.replace(/\.[^.]+$/, '') + '.srt';
      await saveSubtitleTrack({
        title: file.name.replace(/\.[^.]+$/, ''),
        fileName: srtName,
        offsetSec: 0,
        source: 'generated',
        cues,
      });
      await reloadAll();
      showNotice(
        'success',
        `Pre-generated ${cues.length} timestamped Japanese lines from “${file.name}” and saved to Library!`
      );
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : 'Batch transcription failed');
    } finally {
      setBatchBusy(false);
      setBatchProgress('');
    }
  };

  const handleDownloadTrackSrt = (track: SavedSubtitleTrack) => {
    const srt = formatSubtitlesToSrt(track.cues);
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = track.fileName.endsWith('.srt') ? track.fileName : `${track.fileName}.srt`;
    a.click();
    URL.revokeObjectURL(url);
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

  const handleBulkImport = async () => {
    const words = bulkInput
      .split(/[\n,、\t]+/)
      .map((w) => w.trim())
      .filter(Boolean);
    if (words.length === 0) return;
    const count = await bulkImportKnownWords(words);
    setBulkInput('');
    await reloadAll();
    showNotice('success', `Marked ${count} words as Known.`);
  };

  const handleVocabStatusChange = async (word: string, status: WordStatus) => {
    await setWordStatus(word, status);
    await reloadAll();
  };

  const translatePlaygroundSentence = async (sentence: string, targetWord?: string) => {
    setPgTranslating(true);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'TRANSLATE_SENTENCE',
        sentence,
        targetWord,
      } satisfies ExtensionMessage)) as { translation?: string };
      setPgTranslation(res?.translation?.trim() ?? '');
    } catch {
      setPgTranslation('');
    } finally {
      setPgTranslating(false);
    }
  };

  const handlePgTokenClick = async (token: Token) => {
    if (!token.isWord) return;
    setPgSelectedToken(token);
    const local = lookupLocal(token.baseForm) ?? lookupLocal(token.surface);
    setPgEntry(local);
    setPgLoading(true);

    const wordPromise = chrome.runtime
      .sendMessage({
        type: 'LOOKUP_WORD',
        word: token.baseForm,
        surface: token.surface,
      } satisfies ExtensionMessage)
      .catch(() => ({}));

    const transPromise = settings.anki.autoTranslate
      ? translatePlaygroundSentence(pgText, token.baseForm)
      : Promise.resolve();

    try {
      const [res] = await Promise.all([wordPromise, transPromise]);
      const typed = res as { entry?: DictionaryEntry | null };
      if (typed?.entry) setPgEntry(typed.entry);
    } finally {
      setPgLoading(false);
    }
  };

  const handlePgMine = async () => {
    if (!pgSelectedToken) return;
    const word = pgEntry?.word || pgSelectedToken.baseForm;
    const reading = pgEntry?.reading || pgSelectedToken.reading || '';
    const meaning =
      pgEntry?.senses
        .slice(0, 3)
        .map((s) => s.definitions.slice(0, 3).join('; '))
        .join('\n') || '(No definition)';

    const card = await addMinedCard({
      word,
      surfaceWord: pgSelectedToken.surface,
      reading,
      meaning,
      sentence: pgText,
      translation: pgTranslation.trim() || undefined,
      notes: pgNotes.trim() || undefined,
      cardType: settings.anki.cardType,
      sourceTitle: 'KotoStream Playground',
      sourceUrl: 'kotostream://playground',
    });

    if (settings.anki.enabled) {
      try {
        const noteId = await exportCardToAnki(card, settings.anki);
        await updateMinedCard({ ...card, ankiNoteId: noteId });
        showNotice('success', `Mined “${word}” → Saved to SRS & Anki!`);
      } catch (err) {
        showNotice(
          'error',
          `Saved to SRS (Anki export failed: ${err instanceof Error ? err.message : 'unavailable'})`
        );
      }
    } else {
      showNotice('success', `Mined “${word}” into your built-in SRS deck!`);
    }
    await reloadAll();
  };

  const filteredVocab = useMemo(() => {
    return Object.values(vocabMap)
      .filter((v) => (vocabFilter === 'all' ? true : v.status === vocabFilter))
      .filter((v) => {
        if (!vocabSearch.trim()) return true;
        const q = vocabSearch.toLowerCase();
        return v.word.includes(q) || v.reading.includes(q) || v.meaning.toLowerCase().includes(q);
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [vocabMap, vocabFilter, vocabSearch]);

  const pgTokens = useMemo(() => tokenizeJapanese(pgText, vocabMap), [pgText, vocabMap]);

  // Live preview inside Settings tab
  const settingsPreviewFields = useMemo(
    () =>
      buildAnkiFieldPreview(
        {
          word: '約束',
          surfaceWord: '約束',
          reading: 'やくそく',
          meaning: 'promise; agreement; appointment',
          sentence: '絶対にあの約束を守ってみせるから、信じてほしい。',
          translation: 'I will definitely keep that promise, so please believe me.',
          notes: '～てみせる = show that one will do something',
          sourceTitle: 'Amazon Prime Video — Episode 4',
          audioBase64: settings.anki.includeAudio ? 'demo' : undefined,
        },
        settings.anki
      ),
    [settings.anki]
  );

  // Live preview inside Playground tab
  const pgPreviewFields = useMemo(() => {
    if (!pgSelectedToken) return [];
    return buildAnkiFieldPreview(
      {
        word: pgEntry?.word || pgSelectedToken.baseForm,
        surfaceWord: pgSelectedToken.surface,
        reading: pgEntry?.reading || pgSelectedToken.reading || '',
        meaning:
          pgEntry?.senses
            .slice(0, 3)
            .map((s) => s.definitions.slice(0, 3).join('; '))
            .join('\n') || '(No definition)',
        sentence: pgText,
        translation: pgTranslation,
        notes: pgNotes,
        sourceTitle: 'KotoStream Playground',
      },
      settings.anki
    );
  }, [pgSelectedToken, pgEntry, pgText, pgTranslation, pgNotes, settings.anki]);

  return (
    <div className="layout">
      <header className="topbar">
        <div className="brand">
          <div className="logo">言</div>
          <div>
            <h1>KotoStream</h1>
            <p>Japanese Immersion • Live AI Subtitles for Amazon Prime, YouTube & Netflix</p>
          </div>
        </div>

        <nav className="tabs">
          <button className={`tab-btn ${tab === 'subtitles' ? 'active' : ''}`} onClick={() => setTab('subtitles')}>
            Subtitles ({subtitleLibrary.length})
          </button>
          <button className={`tab-btn ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')}>
            SRS Review ({dueCards.length})
          </button>
          <button className={`tab-btn ${tab === 'vocab' ? 'active' : ''}`} onClick={() => setTab('vocab')}>
            Vocab &amp; Cards ({cards.length})
          </button>
          <button className={`tab-btn ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
            Settings &amp; Anki
          </button>
          <button className={`tab-btn ${tab === 'playground' ? 'active' : ''}`} onClick={() => setTab('playground')}>
            Playground
          </button>
        </nav>
      </header>

      {banner && <div className={`banner ${banner.type}`}>{banner.text}</div>}

      {/* SUBTITLES LIBRARY & JIMAKU TAB */}
      {tab === 'subtitles' && (
        <div>
          <div className="panel">
            <h2>1. Search Human-Made Japanese Subtitles (Jimaku.cc)</h2>
            <p className="panel-desc">
              Fetch accurate Japanese .srt / .ass subtitles for anime &amp; J-dramas (zero latency, perfect kanji, 2-speaker overlap support).
              Get a free API key at <strong>jimaku.cc/account</strong>.
            </p>

            <div className="row" style={{ marginBottom: 12 }}>
              <input
                type="password"
                placeholder="Paste Jimaku.cc API key (from jimaku.cc/account)…"
                value={settings.subtitles.jimakuApiKey}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    subtitles: { ...s.subtitles, jimakuApiKey: e.target.value },
                  }))
                }
                style={{
                  flex: 1,
                  minWidth: 240,
                  background: '#0b1120',
                  border: '1px solid rgba(148,163,184,0.24)',
                  color: '#f1f5f9',
                  borderRadius: 8,
                  padding: '8px 10px',
                }}
              />
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  await saveSettings(settings);
                  showNotice('success', 'Jimaku API key saved!');
                }}
              >
                Save Jimaku Key
              </button>
            </div>

            <form className="row" onSubmit={handleJimakuSearch} style={{ marginBottom: 12 }}>
              <input
                type="text"
                placeholder="Show title (e.g. Jujutsu Kaisen or 呪術廻戦)…"
                value={jimakuQuery}
                onChange={(e) => setJimakuQuery(e.target.value)}
                style={{
                  flex: 2,
                  minWidth: 220,
                  background: '#0b1120',
                  border: '1px solid rgba(148,163,184,0.24)',
                  color: '#f1f5f9',
                  borderRadius: 8,
                  padding: '8px 10px',
                }}
              />
              <input
                type="number"
                min={1}
                placeholder="Episode # (optional)"
                value={jimakuEpisode}
                onChange={(e) => setJimakuEpisode(e.target.value)}
                style={{
                  width: 150,
                  background: '#0b1120',
                  border: '1px solid rgba(148,163,184,0.24)',
                  color: '#f1f5f9',
                  borderRadius: 8,
                  padding: '8px 10px',
                }}
              />
              <button type="submit" className="btn btn-primary" disabled={jimakuBusy}>
                {jimakuBusy ? 'Searching…' : 'Search Jimaku'}
              </button>
            </form>

            {jimakuEntries.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>
                  Matching Shows ({jimakuEntries.length}) — click a show to list its subtitle files:
                </div>
                <div className="row" style={{ gap: 8 }}>
                  {jimakuEntries.slice(0, 12).map((entry) => (
                    <button
                      key={entry.id}
                      className={`btn btn-sm ${selectedJimakuEntry?.id === entry.id ? 'btn-primary' : ''}`}
                      onClick={() => void handleSelectJimakuEntry(entry)}
                    >
                      {entry.name}
                      {entry.japanese_name && entry.japanese_name !== entry.name ? ` (${entry.japanese_name})` : ''}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {jimakuFiles.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Subtitle File</th>
                    <th>Size</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {jimakuFiles.slice(0, 40).map((f) => {
                    const isDirect = /\.(srt|ass|vtt)$/i.test(f.name);
                    return (
                      <tr key={f.url}>
                        <td>{f.name}</td>
                        <td>{Math.max(1, Math.round(f.size / 1024))} KB</td>
                        <td>
                          <button
                            className="btn btn-sm btn-primary"
                            disabled={jimakuBusy || !isDirect}
                            onClick={() => void handleImportJimakuFile(f)}
                          >
                            {isDirect ? 'Save to Library' : 'Archive (.zip)'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="grid-2" style={{ marginBottom: 18 }}>
            <div className="panel" style={{ marginBottom: 0 }}>
              <h2>2. Import Local Subtitle File</h2>
              <p className="panel-desc">
                Import any .srt, .vtt, or .ass Japanese subtitle file into your Library for auto-sync on Amazon Prime Video.
              </p>
              <label className="btn btn-primary" style={{ display: 'inline-flex', cursor: 'pointer' }}>
                Choose .SRT / .VTT / .ASS File
                <input
                  type="file"
                  accept=".srt,.vtt,.ass"
                  onChange={handleImportLocalSubtitleFile}
                  style={{ display: 'none' }}
                />
              </label>
            </div>

            <div className="panel" style={{ marginBottom: 0 }}>
              <h2>3. Pre-Generate from Audio / Video File (Fallback)</h2>
              <p className="panel-desc">
                If a show isn&apos;t on Jimaku, upload an episode audio/video file (.mp3, .wav, .m4a, .mp4, .webm) to pre-calculate high-quality timestamped Japanese subtitles via OpenRouter.
              </p>
              <label className="btn" style={{ display: 'inline-flex', cursor: batchBusy ? 'not-allowed' : 'pointer' }}>
                {batchBusy ? 'Pre-Generating…' : 'Upload Audio/Video to Pre-Generate'}
                <input
                  type="file"
                  accept="audio/*,video/*"
                  disabled={batchBusy}
                  onChange={handlePreTranscribeFile}
                  style={{ display: 'none' }}
                />
              </label>
              {batchProgress && (
                <div style={{ marginTop: 10, fontSize: 12, color: '#a5b4fc' }}>{batchProgress}</div>
              )}
            </div>
          </div>

          <div className="panel">
            <h2>Saved Subtitle Library ({subtitleLibrary.length})</h2>
            <p className="panel-desc">
              Open any episode on Amazon Prime Video and click <strong>Library</strong> on the video toolbar to attach &amp; sync a track (your ±0.5s timing offset is saved automatically per episode).
            </p>

            {subtitleLibrary.length === 0 ? (
              <p className="panel-desc">No saved subtitle tracks yet.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Title / File</th>
                    <th>Source</th>
                    <th>Lines</th>
                    <th>Sync Offset</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {subtitleLibrary.map((track) => (
                    <tr key={track.id}>
                      <td>
                        <strong>{track.title}</strong>
                        <div style={{ fontSize: 11, color: '#94a3b8' }}>{track.fileName}</div>
                        {track.urlKey && (
                          <div style={{ fontSize: 10, color: '#818cf8' }}>Bound to: {track.urlKey}</div>
                        )}
                      </td>
                      <td><span className="pill known">{track.source}</span></td>
                      <td>{track.cues.length}</td>
                      <td>{track.offsetSec >= 0 ? `+${track.offsetSec.toFixed(1)}s` : `${track.offsetSec.toFixed(1)}s`}</td>
                      <td>
                        <div className="row">
                          <button className="btn btn-sm" onClick={() => handleDownloadTrackSrt(track)}>
                            Download .SRT
                          </button>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={async () => {
                              await deleteSubtitleTrack(track.id);
                              await reloadAll();
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* REVIEW TAB */}
      {tab === 'review' && (
        <div>
          {!currentReviewCard ? (
            <div className="panel" style={{ textAlign: 'center', padding: '48px 24px' }}>
              <h2>All caught up! 🎉</h2>
              <p className="panel-desc" style={{ marginTop: 8 }}>
                You have {cards.length} mined flashcard{cards.length === 1 ? '' : 's'} total and 0 due right now.
                Watch a show on Amazon Prime Video or try the Playground tab to mine new Japanese sentences.
              </p>
              <button className="btn btn-primary" onClick={() => setTab('playground')}>
                Open Interactive Playground
              </button>
            </div>
          ) : (
            <div className="review-card">
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12 }}>
                {dueCards.length} card{dueCards.length === 1 ? '' : 's'} due • {currentReviewCard.sourceTitle}
              </div>

              <div className="review-word">{currentReviewCard.word}</div>
              <div className="review-sentence">{currentReviewCard.sentence}</div>

              {currentReviewCard.audioBase64 && (
                <button
                  className="btn btn-sm"
                  onClick={() => handlePlayAudio(currentReviewCard)}
                  style={{ marginBottom: 12 }}
                >
                  ▶ Play Sentence Audio
                </button>
              )}

              {!showAnswer ? (
                <div style={{ marginTop: 18 }}>
                  <button className="btn btn-primary" onClick={() => setShowAnswer(true)}>
                    Show Answer
                  </button>
                </div>
              ) : (
                <div>
                  {currentReviewCard.reading && (
                    <div className="review-reading">{currentReviewCard.reading}</div>
                  )}
                  {currentReviewCard.translation && (
                    <div style={{ color: '#cbd5e1', fontSize: 15, marginBottom: 10, fontStyle: 'italic' }}>
                      “{currentReviewCard.translation}”
                    </div>
                  )}
                  <div className="review-meaning">{currentReviewCard.meaning}</div>
                  {currentReviewCard.notes && (
                    <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 10 }}>
                      Note: {currentReviewCard.notes}
                    </div>
                  )}
                  {currentReviewCard.screenshotDataUrl && (
                    <img
                      className="review-screenshot"
                      src={currentReviewCard.screenshotDataUrl}
                      alt="Video context"
                    />
                  )}
                  <div className="rating-row">
                    {(['again', 'hard', 'good', 'easy'] as ReviewRating[]).map((r) => (
                      <button key={r} className={`rating-btn ${r}`} onClick={() => handleRateCard(r)}>
                        {r.charAt(0).toUpperCase() + r.slice(1)}
                        <span>{formatIntervalPreview(currentReviewCard.srs, r)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* VOCAB & CARDS TAB */}
      {tab === 'vocab' && (
        <div>
          <div className="panel">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
              <div>
                <h2>Mined Flashcards ({cards.length})</h2>
                <p className="panel-desc" style={{ marginBottom: 0 }}>
                  Sync individual cards to AnkiConnect or export as a TSV file.
                </p>
              </div>
              <button className="btn btn-sm" onClick={handleDownloadTsv} disabled={cards.length === 0}>
                Export TSV
              </button>
            </div>

            {cards.length === 0 ? (
              <p className="panel-desc">No mined cards yet. Hover over any subtitle word and click “Mine Flashcard”.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Word</th>
                    <th>Sentence & Translation</th>
                    <th>Meaning</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {cards.slice(0, 50).map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.word}</strong>
                        <div style={{ fontSize: 11, color: '#94a3b8' }}>{c.reading}</div>
                      </td>
                      <td style={{ maxWidth: 280 }}>
                        <div>{c.sentence}</div>
                        {c.translation && (
                          <div style={{ fontSize: 11, color: '#a5b4fc', marginTop: 2 }}>{c.translation}</div>
                        )}
                      </td>
                      <td>{c.meaning}</td>
                      <td>
                        <div className="row">
                          <button className="btn btn-sm" onClick={() => handleSyncCardToAnki(c)}>
                            {c.ankiNoteId ? '✓ Re-send Anki' : 'Send to Anki'}
                          </button>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={async () => {
                              await deleteMinedCard(c.id);
                              await reloadAll();
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <h2>Tracked Vocabulary ({filteredVocab.length})</h2>
            <p className="panel-desc">Words marked as Known won&apos;t be underlined in subtitles.</p>

            <div className="row" style={{ marginBottom: 12 }}>
              <input
                type="text"
                placeholder="Search Japanese word, reading, or English…"
                value={vocabSearch}
                onChange={(e) => setVocabSearch(e.target.value)}
                style={{
                  flex: 1,
                  minWidth: 200,
                  background: '#0b1120',
                  border: '1px solid rgba(148,163,184,0.24)',
                  color: '#f1f5f9',
                  borderRadius: 8,
                  padding: '7px 10px',
                }}
              />
              {(['all', 'known', 'learning', 'unknown'] as const).map((f) => (
                <button
                  key={f}
                  className={`btn btn-sm ${vocabFilter === f ? 'btn-primary' : ''}`}
                  onClick={() => setVocabFilter(f)}
                >
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>

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
                {filteredVocab.slice(0, 100).map((v) => (
                  <tr key={v.word}>
                    <td><strong>{v.word}</strong></td>
                    <td>{v.reading}</td>
                    <td>{v.meaning}</td>
                    <td><span className={`pill ${v.status}`}>{v.status}</span></td>
                    <td>
                      <div className="row">
                        {(['known', 'learning', 'unknown'] as WordStatus[]).map((st) => (
                          <button
                            key={st}
                            className="btn btn-sm"
                            onClick={() => handleVocabStatusChange(v.word, st)}
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
          </div>

          <div className="panel">
            <h2>Bulk Import Known Words</h2>
            <p className="panel-desc">Paste words you already know (one per line or comma-separated) to hide their underlines & furigana.</p>
            <div className="field">
              <textarea
                rows={4}
                placeholder="今日&#10;食べる&#10;友達"
                value={bulkInput}
                onChange={(e) => setBulkInput(e.target.value)}
              />
            </div>
            <div style={{ marginTop: 10 }}>
              <button className="btn btn-primary" onClick={handleBulkImport}>
                Import as Known
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SETTINGS TAB */}
      {tab === 'settings' && (
        <form onSubmit={handleSaveSettings}>
          <div className="panel">
            <h2>1. OpenRouter Speech-to-Text (Real-Time Japanese Subtitles)</h2>
            <p className="panel-desc">
              Transcribes Amazon Prime Video &amp; streaming audio into Japanese subtitles on the fly via OpenRouter.
              Whisper Large v3 Turbo is routed to Groq for ~250ms latency; MAI-Transcribe 2 &amp; Scribe v2 add native 2-speaker diarization.
            </p>

            <div className="grid-2">
              <div className="field">
                <label>OpenRouter API Key</label>
                <input
                  type="password"
                  placeholder="sk-or-v1-..."
                  value={settings.stt.apiKey}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, stt: { ...s.stt, apiKey: e.target.value } }))
                  }
                />
              </div>

              <div className="field">
                <label>OpenRouter Model</label>
                <input
                  type="text"
                  value={settings.stt.model}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, stt: { ...s.stt, model: e.target.value } }))
                  }
                />
                <div className="row" style={{ marginTop: 4, gap: 6 }}>
                  {[
                    { id: 'openai/whisper-large-v3-turbo', label: 'Whisper v3 Turbo (Groq · Fastest)' },
                    { id: 'microsoft/mai-transcribe-2', label: 'MAI-Transcribe 2 (2-Speaker)' },
                    { id: 'elevenlabs/scribe-v2', label: 'Scribe v2 (Diarized)' },
                    { id: 'openai/whisper-large-v3', label: 'Whisper v3 (Groq)' },
                  ].map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={`btn btn-sm ${settings.stt.model === preset.id ? 'btn-primary' : ''}`}
                      onClick={() =>
                        setSettings((s) => ({ ...s, stt: { ...s.stt, model: preset.id } }))
                      }
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label>Max Chunk Duration (ms)</label>
                <input
                  type="number"
                  min={1000}
                  max={10000}
                  step={1}
                  value={settings.stt.chunkDurationMs}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      stt: { ...s.stt, chunkDurationMs: Number(e.target.value) || 2200 },
                    }))
                  }
                />
              </div>

              <div className="field">
                <label>Silence Split Pause (ms)</label>
                <input
                  type="number"
                  min={150}
                  max={2000}
                  step={1}
                  value={settings.stt.silenceSplitMs}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      stt: { ...s.stt, silenceSplitMs: Number(e.target.value) || 280 },
                    }))
                  }
                />
              </div>

              <div className="field">
                <label>Sentence Reset Pause (ms)</label>
                <input
                  type="number"
                  min={800}
                  max={10000}
                  step={1}
                  value={settings.stt.sentenceResetPauseMs}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      stt: { ...s.stt, sentenceResetPauseMs: Number(e.target.value) || 2200 },
                    }))
                  }
                />
              </div>

              <div className="field">
                <label>Jimaku.cc API Key (for Japanese Anime/Drama Subtitles)</label>
                <input
                  type="password"
                  placeholder="Free key from jimaku.cc/account"
                  value={settings.subtitles.jimakuApiKey}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      subtitles: { ...s.subtitles, jimakuApiKey: e.target.value },
                    }))
                  }
                />
              </div>

              <div className="field">
                <label>Context Prompt (optional show/character names)</label>
                <input
                  type="text"
                  placeholder="e.g. 呪術廻戦、虎杖悠仁、五条悟"
                  value={settings.stt.contextPrompt}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, stt: { ...s.stt, contextPrompt: e.target.value } }))
                  }
                />
              </div>
            </div>
          </div>

          <div className="panel">
            <h2>2. Subtitle Overlay & Reading Preferences</h2>
            <p className="panel-desc">Customize how interactive Japanese subtitles look and behave on video players.</p>

            <div className="grid-2">
              <div className="field">
                <label>Furigana Mode</label>
                <select
                  value={settings.overlay.furiganaMode}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      overlay: {
                        ...s.overlay,
                        furiganaMode: e.target.value as AppSettings['overlay']['furiganaMode'],
                      },
                    }))
                  }
                >
                  <option value="unknown_and_learning">Smart (Unknown & Learning only)</option>
                  <option value="all">Always show Furigana</option>
                  <option value="off">Off</option>
                </select>
              </div>

              <div className="field">
                <label>Subtitle Font Size (px)</label>
                <input
                  type="number"
                  min={16}
                  max={52}
                  value={settings.overlay.fontSizePx}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      overlay: { ...s.overlay, fontSizePx: Number(e.target.value) || 28 },
                    }))
                  }
                />
              </div>

              <div className="field">
                <label>Bottom Offset (px)</label>
                <input
                  type="number"
                  min={16}
                  max={240}
                  value={settings.overlay.bottomOffsetPx}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      overlay: { ...s.overlay, bottomOffsetPx: Number(e.target.value) || 68 },
                    }))
                  }
                />
              </div>

              <div className="field">
                <label>Background Opacity ({Math.round(settings.overlay.backgroundOpacity * 100)}%)</label>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.overlay.backgroundOpacity}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      overlay: { ...s.overlay, backgroundOpacity: Number(e.target.value) },
                    }))
                  }
                />
              </div>
            </div>

            <div className="row" style={{ marginTop: 14, gap: 18 }}>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      enabled: e.target.checked,
                    }))
                  }
                />
                <strong>Extension enabled</strong> (show overlay on video pages)
              </label>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.overlay.autoPauseOnHover}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      overlay: { ...s.overlay, autoPauseOnHover: e.target.checked },
                    }))
                  }
                />
                Auto-pause video when hovering a word
              </label>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.overlay.autoResumeOnLeave}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      overlay: { ...s.overlay, autoResumeOnLeave: e.target.checked },
                    }))
                  }
                />
                Auto-resume when leaving popover
              </label>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.overlay.highlightUnknown}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      overlay: { ...s.overlay, highlightUnknown: e.target.checked },
                    }))
                  }
                />
                Underline unknown words
              </label>
            </div>
          </div>

          <div className="panel">
            <h2>3. Migaku-Style Card Creator, Screenshots & Translation</h2>
            <p className="panel-desc">
              Configure how cards are built, translated, and screenshotted (clean video-only crop, WebP/JPEG) when you mine a sentence.
            </p>

            <div className="grid-2">
              <div className="field">
                <label>Default Card Type</label>
                <select
                  value={settings.anki.cardType}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, anki: { ...s.anki, cardType: e.target.value as CardType } }))
                  }
                >
                  <option value="sentence">Sentence Card (Migaku default)</option>
                  <option value="word">Word Card</option>
                  <option value="audio_sentence">Audio Sentence Card</option>
                </select>
              </div>

              <div className="field">
                <label>Furigana Syntax in Anki</label>
                <select
                  value={settings.anki.furiganaFormat}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      anki: { ...s.anki, furiganaFormat: e.target.value as FuriganaFormat },
                    }))
                  }
                >
                  <option value="ruby_html">HTML Ruby (&lt;ruby&gt;約束&lt;rt&gt;やくそく&lt;/rt&gt;&lt;/ruby&gt;)</option>
                  <option value="migaku_brackets">Migaku Brackets (約束[やくそく])</option>
                  <option value="none">Plain Kanji Only</option>
                </select>
              </div>

              <div className="field">
                <label>Sentence Translation Engine</label>
                <select
                  value={settings.anki.translationProvider}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      anki: { ...s.anki, translationProvider: e.target.value as TranslationProvider },
                    }))
                  }
                >
                  <option value="google_free">Free Google Translate (Zero-key default)</option>
                  <option value="openrouter">OpenRouter LLM (google/gemini-2.5-flash — uses OpenRouter key)</option>
                  <option value="off">Off</option>
                </select>
              </div>

              <div className="field">
                <label>Translation Target Language</label>
                <input
                  type="text"
                  value={settings.anki.translationTargetLang}
                  placeholder="en"
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      anki: { ...s.anki, translationTargetLang: e.target.value },
                    }))
                  }
                />
              </div>

              <div className="field">
                <label>Screenshot Format (Migaku-style clean video crop)</label>
                <select
                  value={settings.anki.screenshotFormat}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      anki: { ...s.anki, screenshotFormat: e.target.value as ScreenshotFormat },
                    }))
                  }
                >
                  <option value="webp">WebP (Migaku default — crisp & tiny)</option>
                  <option value="jpeg">JPEG</option>
                  <option value="png">PNG (Lossless)</option>
                </select>
              </div>

              <div className="field">
                <label>Screenshot Max Height (px)</label>
                <select
                  value={settings.anki.screenshotMaxHeight}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      anki: { ...s.anki, screenshotMaxHeight: Number(e.target.value) },
                    }))
                  }
                >
                  <option value={360}>360p (Compact)</option>
                  <option value={480}>480p (Migaku recommended)</option>
                  <option value={720}>720p (HD)</option>
                  <option value={0}>Original Resolution</option>
                </select>
              </div>

              <div className="field">
                <label>Screenshot Quality ({Math.round(settings.anki.screenshotQuality * 100)}%)</label>
                <input
                  type="number"
                  min={0.3}
                  max={1}
                  step={0.01}
                  value={settings.anki.screenshotQuality}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      anki: { ...s.anki, screenshotQuality: Number(e.target.value) || 0.82 },
                    }))
                  }
                />
              </div>

              <div className="field">
                <label>Card Tags (comma-separated)</label>
                <input
                  type="text"
                  value={settings.anki.tags.join(', ')}
                  placeholder="kotostream, prime-video"
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      anki: {
                        ...s.anki,
                        tags: e.target.value
                          .split(',')
                          .map((t) => t.trim())
                          .filter(Boolean),
                      },
                    }))
                  }
                />
              </div>
            </div>

            <div className="row" style={{ marginTop: 14, gap: 18 }}>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.anki.openPreviewBeforeSaving}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      anki: { ...s.anki, openPreviewBeforeSaving: e.target.checked },
                    }))
                  }
                />
                Open Card Creator preview before saving (recommended)
              </label>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.anki.autoTranslate}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, anki: { ...s.anki, autoTranslate: e.target.checked } }))
                  }
                />
                Auto-translate mined sentences
              </label>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.anki.highlightTargetInSentence}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      anki: { ...s.anki, highlightTargetInSentence: e.target.checked },
                    }))
                  }
                />
                Bold/highlight target word in sentence
              </label>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.anki.includeScreenshot}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      anki: { ...s.anki, includeScreenshot: e.target.checked },
                    }))
                  }
                />
                Capture clean video screenshot
              </label>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.anki.includeAudio}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, anki: { ...s.anki, includeAudio: e.target.checked } }))
                  }
                />
                Capture sentence audio clip
              </label>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.anki.allowDuplicate}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, anki: { ...s.anki, allowDuplicate: e.target.checked } }))
                  }
                />
                Allow duplicate Anki notes
              </label>
            </div>
          </div>

          <div className="panel">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <div>
                <h2>4. AnkiConnect & Migaku Field Mapping</h2>
                <p className="panel-desc" style={{ marginBottom: 0 }}>
                  Map KotoStream fields to your Anki Note Type (supports Migaku Japanese, Lapis, Kaishi, or Basic).
                </p>
              </div>
              <div className="row">
                <button type="button" className="btn btn-sm" onClick={() => applyFieldPreset('migaku')}>
                  Migaku Preset
                </button>
                <button type="button" className="btn btn-sm" onClick={() => applyFieldPreset('basic')}>
                  Basic Preset
                </button>
              </div>
            </div>

            <div className="row" style={{ marginBottom: 14 }}>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.anki.enabled}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, anki: { ...s.anki, enabled: e.target.checked } }))
                  }
                />
                Auto-send mined cards to AnkiConnect
              </label>

              <button type="button" className="btn btn-sm" onClick={handleTestAnki}>
                Test Connection & Load Decks
              </button>
              {ankiStatus && <span style={{ fontSize: 12, color: '#a5b4fc' }}>{ankiStatus}</span>}
            </div>

            <div className="grid-2">
              <div className="field">
                <label>AnkiConnect URL</label>
                <input
                  type="text"
                  value={settings.anki.url}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, anki: { ...s.anki, url: e.target.value } }))
                  }
                />
              </div>

              <div className="field">
                <label>Target Deck</label>
                {ankiDecks.length > 0 ? (
                  <select
                    value={settings.anki.deckName}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, anki: { ...s.anki, deckName: e.target.value } }))
                    }
                  >
                    {ankiDecks.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={settings.anki.deckName}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, anki: { ...s.anki, deckName: e.target.value } }))
                    }
                  />
                )}
              </div>

              <div className="field">
                <label>Note Type (Model)</label>
                {ankiModels.length > 0 ? (
                  <select
                    value={settings.anki.modelName}
                    onChange={(e) => void handleModelChange(e.target.value)}
                  >
                    {ankiModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={settings.anki.modelName}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, anki: { ...s.anki, modelName: e.target.value } }))
                    }
                  />
                )}
              </div>

              {MIGAKU_FIELD_LABELS.map(({ key, label, placeholder }) => (
                <div className="field" key={key}>
                  <label>Anki Field for {label}</label>
                  {ankiFields.length > 0 ? (
                    <select
                      value={settings.anki.fieldMapping[key]}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          anki: {
                            ...s.anki,
                            fieldMapping: { ...s.anki.fieldMapping, [key]: e.target.value },
                          },
                        }))
                      }
                    >
                      <option value="">(Skip)</option>
                      {ankiFields.map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      placeholder={placeholder}
                      value={settings.anki.fieldMapping[key]}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          anki: {
                            ...s.anki,
                            fieldMapping: { ...s.anki.fieldMapping, [key]: e.target.value },
                          },
                        }))
                      }
                    />
                  )}
                </div>
              ))}
            </div>

            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#c7d2fe', marginBottom: 8 }}>
                Live Field Mapping Preview (Sample Card)
              </div>
              <div className="grid-2">
                {settingsPreviewFields.map((f) => (
                  <div
                    key={f.fieldName}
                    style={{
                      background: '#0b1120',
                      border: '1px solid rgba(148,163,184,0.18)',
                      borderRadius: 10,
                      padding: '10px 12px',
                    }}
                  >
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#818cf8', marginBottom: 4 }}>
                      {f.fieldName}
                    </div>
                    <div
                      style={{ fontSize: 13, color: '#f1f5f9' }}
                      dangerouslySetInnerHTML={{ __html: f.html }}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>

          <button type="submit" className="btn btn-primary">
            Save All Settings
          </button>
        </form>
      )}

      {/* PLAYGROUND TAB */}
      {tab === 'playground' && (
        <div className="panel">
          <h2>Interactive Japanese Immersion Playground</h2>
          <p className="panel-desc">
            Click any word to test deconjugation, Jisho dictionary lookup, automatic sentence translation, and live Migaku-style Anki field previews.
          </p>

          <div className="row" style={{ marginBottom: 10 }}>
            {SAMPLE_SENTENCES.map((s, i) => (
              <button
                key={i}
                className="btn btn-sm"
                onClick={() => {
                  setPgText(s);
                  setPgSelectedToken(null);
                  setPgTranslation('');
                }}
              >
                Sample {i + 1}
              </button>
            ))}
          </div>

          <div className="field">
            <input
              type="text"
              value={pgText}
              onChange={(e) => setPgText(e.target.value)}
              placeholder="Type or paste any Japanese sentence…"
            />
          </div>

          <div className="playground-sentence">
            {pgTokens.map((t, idx) => (
              <span
                key={idx}
                className={`pg-token status-${t.status}`}
                onClick={() => void handlePgTokenClick(t)}
              >
                {t.hasKanji && t.reading ? (
                  <ruby>
                    {t.surface}
                    <rt>{t.reading}</rt>
                  </ruby>
                ) : (
                  t.surface
                )}
              </span>
            ))}
          </div>

          {pgSelectedToken && (
            <div className="grid-2" style={{ marginTop: 14, alignItems: 'start' }}>
              <div className="panel" style={{ background: '#0b1120', marginBottom: 0 }}>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                  <div>
                    <strong style={{ fontSize: 22 }}>
                      {pgEntry?.word || pgSelectedToken.baseForm}
                    </strong>{' '}
                    <span style={{ color: '#a5b4fc' }}>
                      {pgEntry?.reading || pgSelectedToken.reading}
                    </span>
                  </div>
                  <div className="row">
                    {(['unknown', 'learning', 'known'] as WordStatus[]).map((st) => (
                      <button
                        key={st}
                        className="btn btn-sm"
                        onClick={async () => {
                          const word = pgEntry?.word || pgSelectedToken.baseForm;
                          await setWordStatus(word, st, {
                            reading: pgEntry?.reading || pgSelectedToken.reading,
                            meaning: pgEntry?.senses[0]?.definitions.join('; '),
                          });
                          await reloadAll();
                        }}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>

                {pgLoading && <p style={{ color: '#94a3b8' }}>Looking up in JMdict…</p>}
                {!pgLoading && pgEntry && (
                  <div style={{ marginBottom: 12 }}>
                    {pgEntry.senses.map((s, idx) => (
                      <div key={idx} style={{ marginBottom: 4 }}>
                        <span style={{ color: '#94a3b8', fontSize: 11 }}>
                          [{s.partsOfSpeech.join(', ')}]
                        </span>{' '}
                        {s.definitions.join('; ')}
                      </div>
                    ))}
                  </div>
                )}

                <div className="field" style={{ marginBottom: 10 }}>
                  <label>
                    Sentence Translation {pgTranslating ? '(Translating…)' : ''}
                  </label>
                  <textarea
                    rows={2}
                    value={pgTranslation}
                    onChange={(e) => setPgTranslation(e.target.value)}
                    placeholder="Auto-translated sentence appears here…"
                  />
                </div>

                <div className="field" style={{ marginBottom: 12 }}>
                  <label>Notes (optional)</label>
                  <input
                    type="text"
                    value={pgNotes}
                    onChange={(e) => setPgNotes(e.target.value)}
                    placeholder="Add grammar note…"
                  />
                </div>

                <div className="row">
                  <button
                    className="btn btn-sm"
                    onClick={() => void translatePlaygroundSentence(pgText, pgSelectedToken.baseForm)}
                  >
                    Re-translate
                  </button>
                  <button className="btn btn-primary" onClick={handlePgMine}>
                    {settings.anki.enabled ? 'Create Card & Send to Anki' : 'Create Card'}
                  </button>
                </div>
              </div>

              <div className="panel" style={{ background: '#0b1120', marginBottom: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#c7d2fe', marginBottom: 10 }}>
                  Live Anki Field Preview ({settings.anki.modelName})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {pgPreviewFields.map((f) => (
                    <div
                      key={f.fieldName}
                      style={{
                        background: '#131c31',
                        border: '1px solid rgba(148,163,184,0.16)',
                        borderRadius: 8,
                        padding: '8px 10px',
                      }}
                    >
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#818cf8', marginBottom: 3 }}>
                        {f.fieldName}
                      </div>
                      <div
                        style={{ fontSize: 13, color: '#f1f5f9' }}
                        dangerouslySetInnerHTML={{ __html: f.html }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
