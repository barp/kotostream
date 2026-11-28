import React, { useState } from 'react';
import type {
  AppSettings,
  ExtensionMessage,
  JimakuEntry,
  JimakuFile,
  SavedSubtitleTrack,
} from '../../types';
import {
  deleteSubtitleTrack,
  getSettings,
  saveSettings,
  saveSubtitleTrack,
} from '../../core/storage';
import { formatSubtitlesToSrt, parseSubtitleFile } from '../../core/subtitle-parser';
import { preTranscribeMediaFile } from '../../core/batch-transcribe';

interface SubtitlesTabProps {
  settings: AppSettings;
  subtitleLibrary: SavedSubtitleTrack[];
  onReload: () => Promise<void>;
  onNotice: (type: 'success' | 'error', text: string) => void;
  onJimakuKeySaved: (apiKey: string) => void;
}

export const SubtitlesTab: React.FC<SubtitlesTabProps> = ({
  settings,
  subtitleLibrary,
  onReload,
  onNotice,
  onJimakuKeySaved,
}) => {
  const [jimakuKeyDraft, setJimakuKeyDraft] = useState(settings.subtitles.jimakuApiKey);
  const [jimakuQuery, setJimakuQuery] = useState('');
  const [jimakuEpisode, setJimakuEpisode] = useState('');
  const [jimakuEntries, setJimakuEntries] = useState<JimakuEntry[]>([]);
  const [selectedJimakuEntry, setSelectedJimakuEntry] = useState<JimakuEntry | null>(null);
  const [jimakuFiles, setJimakuFiles] = useState<JimakuFile[]>([]);
  const [jimakuBusy, setJimakuBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState<string>('');
  const [batchBusy, setBatchBusy] = useState(false);

  // Sync draft when settings finishes initial load
  React.useEffect(() => {
    setJimakuKeyDraft(settings.subtitles.jimakuApiKey);
  }, [settings.subtitles.jimakuApiKey]);

  const handleSaveJimakuKey = async () => {
    const trimmed = jimakuKeyDraft.trim();
    // Merge into persisted settings so we never accidentally save half-edited fields from the Settings tab
    const persisted = await getSettings();
    await saveSettings({
      ...persisted,
      subtitles: { ...persisted.subtitles, jimakuApiKey: trimmed },
    });
    onJimakuKeySaved(trimmed);
    onNotice('success', 'Jimaku API key saved!');
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
        onNotice('error', res.error);
      } else {
        setJimakuEntries(res?.entries ?? []);
        if ((res?.entries ?? []).length === 0) {
          onNotice('error', `No shows found on Jimaku for “${jimakuQuery}”.`);
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
        onNotice('error', res.error);
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
        onNotice('error', res?.error || 'Could not download subtitle file');
        return;
      }
      const cues = parseSubtitleFile(res.text);
      if (cues.length === 0) {
        onNotice('error', 'No valid Japanese cues found in this file.');
        return;
      }
      await saveSubtitleTrack({
        title: selectedJimakuEntry?.name || file.name,
        fileName: file.name,
        offsetSec: 0,
        source: 'jimaku',
        cues,
      });
      await onReload();
      onNotice(
        'success',
        `Saved “${file.name}” (${cues.length} lines) to Library! Open your video and click Library on the toolbar to sync it.`
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
      onNotice('error', 'No valid cues found in subtitle file (.srt, .vtt, .ass).');
      return;
    }
    await saveSubtitleTrack({
      title: file.name.replace(/\.(srt|vtt|ass)$/i, ''),
      fileName: file.name,
      offsetSec: 0,
      source: 'file',
      cues,
    });
    await onReload();
    onNotice('success', `Imported “${file.name}” (${cues.length} lines) into your Subtitle Library.`);
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
        onNotice('error', 'No Japanese speech was detected in that file.');
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
      await onReload();
      onNotice(
        'success',
        `Pre-generated ${cues.length} timestamped Japanese lines from “${file.name}” and saved to Library!`
      );
    } catch (err) {
      onNotice('error', err instanceof Error ? err.message : 'Batch transcription failed');
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

  const handleDeleteTrack = async (track: SavedSubtitleTrack) => {
    if (!window.confirm(`Delete saved subtitle track “${track.fileName}”?`)) return;
    await deleteSubtitleTrack(track.id);
    await onReload();
    onNotice('success', `Deleted “${track.fileName}”.`);
  };

  return (
    <div>
      <div className="panel">
        <h2>1. Search Human-Made Japanese Subtitles (Jimaku.cc)</h2>
        <p className="panel-desc">
          Fetch accurate Japanese .srt / .ass subtitles for anime &amp; J-dramas (zero latency, perfect kanji, 2-speaker overlap support).
          Get a free API key at <strong>jimaku.cc/account</strong>.
        </p>

        <div className="row mb-md">
          <input
            type="password"
            className="input-base input-grow"
            placeholder="Paste Jimaku.cc API key (from jimaku.cc/account)…"
            value={jimakuKeyDraft}
            onChange={(e) => setJimakuKeyDraft(e.target.value)}
          />
          <button type="button" className="btn btn-sm" onClick={() => void handleSaveJimakuKey()}>
            Save Jimaku Key
          </button>
        </div>

        <form className="row mb-md" onSubmit={handleJimakuSearch}>
          <input
            type="text"
            className="input-base input-grow-2"
            placeholder="Show title (e.g. Jujutsu Kaisen or 呪術廻戦)…"
            value={jimakuQuery}
            onChange={(e) => setJimakuQuery(e.target.value)}
          />
          <input
            type="number"
            className="input-base input-ep"
            min={1}
            placeholder="Episode # (optional)"
            value={jimakuEpisode}
            onChange={(e) => setJimakuEpisode(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={jimakuBusy}>
            {jimakuBusy ? 'Searching…' : 'Search Jimaku'}
          </button>
        </form>

        {jimakuEntries.length > 0 && (
          <div className="mb-md">
            <div className="muted-note mb-sm">
              Matching Shows ({jimakuEntries.length}) — click a show to list its subtitle files:
            </div>
            <div className="row tight">
              {jimakuEntries.slice(0, 12).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
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
                        type="button"
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

      <div className="grid-2 mb-lg">
        <div className="panel no-margin">
          <h2>2. Import Local Subtitle File</h2>
          <p className="panel-desc">
            Import any .srt, .vtt, or .ass Japanese subtitle file into your Library for auto-sync on Amazon Prime Video, YouTube, or Netflix.
          </p>
          <label className="btn btn-primary file-btn">
            Choose .SRT / .VTT / .ASS File
            <input
              type="file"
              accept=".srt,.vtt,.ass"
              onChange={handleImportLocalSubtitleFile}
              style={{ display: 'none' }}
            />
          </label>
        </div>

        <div className="panel no-margin">
          <h2>3. Pre-Generate from Audio / Video File (Fallback)</h2>
          <p className="panel-desc">
            If a show isn&apos;t on Jimaku, upload an episode audio/video file (.mp3, .wav, .m4a, .mp4, .webm) to pre-calculate high-quality timestamped Japanese subtitles via OpenRouter.
          </p>
          <label className={`btn file-btn ${batchBusy ? 'disabled' : ''}`}>
            {batchBusy ? 'Pre-Generating…' : 'Upload Audio/Video to Pre-Generate'}
            <input
              type="file"
              accept="audio/*,video/*"
              disabled={batchBusy}
              onChange={handlePreTranscribeFile}
              style={{ display: 'none' }}
            />
          </label>
          {batchProgress && <div className="status-note mt-md">{batchProgress}</div>}
        </div>
      </div>

      <div className="panel">
        <h2>Saved Subtitle Library ({subtitleLibrary.length})</h2>
        <p className="panel-desc">
          Open any episode and click <strong>Library</strong> on the video toolbar to attach &amp; sync a track (your ±0.5s timing offset is saved automatically per episode).
        </p>

        {subtitleLibrary.length === 0 ? (
          <p className="panel-desc no-margin">No saved subtitle tracks yet.</p>
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
                    <div className="sub-meta">{track.fileName}</div>
                    {track.urlKey && <div className="sub-bound">Bound to: {track.urlKey}</div>}
                  </td>
                  <td><span className="pill known">{track.source}</span></td>
                  <td>{track.cues.length}</td>
                  <td>{track.offsetSec >= 0 ? `+${track.offsetSec.toFixed(1)}s` : `${track.offsetSec.toFixed(1)}s`}</td>
                  <td>
                    <div className="row tight">
                      <button type="button" className="btn btn-sm" onClick={() => handleDownloadTrackSrt(track)}>
                        Download .SRT
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => void handleDeleteTrack(track)}
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
  );
};
