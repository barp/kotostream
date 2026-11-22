import React, { useEffect, useState } from 'react';
import type {
  AppSettings,
  CaptureState,
  ExtensionMessage,
  JimakuEntry,
  JimakuFile,
} from '../types';
import { getMinedCards, getSettings, getVocabMap, saveSettings, saveSubtitleTrack } from '../core/storage';
import { parseMediaTitle } from '../core/title-parser';
import { parseSubtitleFile } from '../core/subtitle-parser';

function detectSiteLabel(url?: string): string {
  if (!url) return 'Browser Tab';
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes('primevideo.com') || (host.includes('amazon.') && u.pathname.includes('video'))) {
      return 'Prime Video';
    }
    if (host.includes('youtube.com')) return 'YouTube';
    if (host.includes('netflix.com')) return 'Netflix';
    return host.replace(/^www\./, '');
  } catch {
    return 'Browser Tab';
  }
}

export const Popup: React.FC = () => {
  const [tabId, setTabId] = useState<number | undefined>();
  const [tabUrl, setTabUrl] = useState<string>('');
  const [siteLabel, setSiteLabel] = useState('Current Tab');
  const [captureState, setCaptureState] = useState<CaptureState>({ status: 'idle' });
  const [lastSubtitle, setLastSubtitle] = useState<string>('');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [stats, setStats] = useState({ known: 0, learning: 0, due: 0 });

  // Automatic Jimaku subtitle matching state
  const [searchQuery, setSearchQuery] = useState('');
  const [episodeInput, setEpisodeInput] = useState('');
  const [detectedRawTitle, setDetectedRawTitle] = useState('');
  const [activeTrackName, setActiveTrackName] = useState<string | null>(null);
  const [jimakuEntries, setJimakuEntries] = useState<JimakuEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<JimakuEntry | null>(null);
  const [jimakuFiles, setJimakuFiles] = useState<JimakuFile[]>([]);
  const [subStatus, setSubStatus] = useState<string>('');
  const [subError, setSubError] = useState<string>('');
  const [loadingFileUrl, setLoadingFileUrl] = useState<string | null>(null);
  const [jimakuKeyDraft, setJimakuKeyDraft] = useState<string>('');

  const handleSaveJimakuKeyInline = async (e: React.FormEvent) => {
    e.preventDefault();
    const key = jimakuKeyDraft.trim();
    if (!key || !settings) return;
    const updated: AppSettings = {
      ...settings,
      subtitles: { ...settings.subtitles, jimakuApiKey: key },
    };
    await saveSettings(updated);
    setSettings(updated);
    setJimakuKeyDraft('');
    if (searchQuery.trim()) {
      void runJimakuSearch(searchQuery, episodeInput);
    }
  };

  const loadFilesForEntry = async (entry: JimakuEntry, epStr: string) => {
    setSelectedEntry(entry);
    setSubStatus(`Loading files for ${entry.name}…`);
    setSubError('');
    try {
      const epNum = epStr.trim() ? Number(epStr.trim()) : undefined;
      const res = (await chrome.runtime.sendMessage({
        type: 'JIMAKU_LIST_FILES',
        entryId: entry.id,
        episode: epNum,
      } satisfies ExtensionMessage)) as { files?: JimakuFile[]; error?: string };

      if (res?.error) {
        setSubError(res.error);
        setJimakuFiles([]);
      } else {
        const directFiles = (res?.files ?? []).filter((f) => /\.(srt|ass|vtt)$/i.test(f.name));
        setJimakuFiles(directFiles);
        setSubStatus(
          directFiles.length > 0
            ? `${directFiles.length} matching subtitle file${directFiles.length === 1 ? '' : 's'}`
            : 'No direct .srt/.ass files for this filter — try clearing Ep #'
        );
      }
    } catch {
      setSubError('Failed to fetch Jimaku files.');
    }
  };

  const runJimakuSearch = async (query: string, epStr: string) => {
    const q = query.trim();
    if (!q) return;
    setSubStatus(`Searching Jimaku for “${q}”…`);
    setSubError('');
    setJimakuEntries([]);
    setJimakuFiles([]);
    setSelectedEntry(null);

    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'JIMAKU_SEARCH',
        query: q,
      } satisfies ExtensionMessage)) as { entries?: JimakuEntry[]; error?: string };

      if (res?.error) {
        setSubError(res.error);
        setSubStatus('');
        return;
      }

      const entries = res?.entries ?? [];
      setJimakuEntries(entries);
      if (entries.length === 0) {
        setSubStatus(`No Jimaku matches for “${q}” — try editing the title above.`);
        return;
      }

      // Auto-load files for the top matching show
      await loadFilesForEntry(entries[0], epStr);
    } catch {
      setSubError('Jimaku search failed.');
      setSubStatus('');
    }
  };

  useEffect(() => {
    const load = async () => {
      const [tabs, loadedSettings, vocab, cards] = await Promise.all([
        chrome.tabs.query({ active: true, currentWindow: true }),
        getSettings(),
        getVocabMap(),
        getMinedCards(),
      ]);

      const activeTab = tabs[0];
      setTabId(activeTab?.id);
      setTabUrl(activeTab?.url ?? '');
      setSiteLabel(detectSiteLabel(activeTab?.url));
      setSettings(loadedSettings);

      const entries = Object.values(vocab);
      const now = Date.now();
      setStats({
        known: entries.filter((e) => e.status === 'known').length,
        learning: entries.filter((e) => e.status === 'learning').length,
        due: cards.filter((c) => c.srs.dueAt <= now).length,
      });

      const capRes = (await chrome.runtime.sendMessage({
        type: 'GET_CAPTURE_STATE',
      } satisfies ExtensionMessage)) as { state?: CaptureState };
      if (capRes?.state) setCaptureState(capRes.state);

      // Detect show title & episode number automatically from the active video tab
      let detectedShow = '';
      let detectedEp = '';
      if (activeTab?.id) {
        let info:
          | {
              rawTitle?: string;
              showName?: string;
              episodeNumber?: number;
              activeTrackName?: string | null;
            }
          | undefined;

        try {
          info = (await chrome.tabs.sendMessage(activeTab.id, {
            type: 'GET_PAGE_MEDIA_INFO',
          } satisfies ExtensionMessage)) as typeof info;
        } catch {
          // Content script wasn't active on this tab yet -> inject it and retry once
          try {
            await chrome.scripting.executeScript({
              target: { tabId: activeTab.id },
              files: ['content.js'],
            });
            info = (await chrome.tabs.sendMessage(activeTab.id, {
              type: 'GET_PAGE_MEDIA_INFO',
            } satisfies ExtensionMessage)) as typeof info;
          } catch {
            // Fall back to tab title below
          }
        }

        if (info?.rawTitle) setDetectedRawTitle(info.rawTitle);
        if (info?.showName) detectedShow = info.showName;
        if (info?.episodeNumber) detectedEp = String(info.episodeNumber);
        if (info?.activeTrackName) setActiveTrackName(info.activeTrackName);

        if (!detectedShow && activeTab.title) {
          setDetectedRawTitle(activeTab.title);
          const parsed = parseMediaTitle(activeTab.title);
          detectedShow = parsed.showName;
          if (parsed.episodeNumber) detectedEp = String(parsed.episodeNumber);
        }
      }

      setSearchQuery(detectedShow);
      setEpisodeInput(detectedEp);

      // Auto-search Jimaku if API key is set and we detected a real show title
      const ignoredTitles = new Set(['Amazon Prime Video', 'Prime Video', 'YouTube', 'Netflix', 'New Tab', '']);
      if (loadedSettings.subtitles.jimakuApiKey.trim() && !ignoredTitles.has(detectedShow)) {
        void runJimakuSearch(detectedShow, detectedEp);
      }
    };

    void load();

    const listener = (msg: ExtensionMessage) => {
      if (msg.type === 'CAPTURE_STATE_CHANGED') {
        setCaptureState(msg.state);
      } else if (msg.type === 'SUBTITLE_RECEIVED') {
        setLastSubtitle(msg.subtitle.text);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const handleApplyJimakuFile = async (file: JimakuFile) => {
    setLoadingFileUrl(file.url);
    setSubError('');
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'JIMAKU_DOWNLOAD',
        url: file.url,
      } satisfies ExtensionMessage)) as { text?: string; error?: string };

      if (res?.error || !res?.text) {
        setSubError(res?.error || 'Failed to download subtitle file.');
        return;
      }

      const cues = parseSubtitleFile(res.text);
      if (cues.length === 0) {
        setSubError('Subtitle file had no readable cues.');
        return;
      }

      const savedTrack = await saveSubtitleTrack({
        title: selectedEntry?.name || searchQuery || file.name,
        fileName: file.name,
        urlKey: tabUrl || undefined,
        offsetSec: 0,
        source: 'jimaku',
        cues,
      });

      if (tabId) {
        // Ensure content script is injected on this tab, then apply the track immediately
        await chrome.scripting
          .executeScript({ target: { tabId }, files: ['content.js'] })
          .catch(() => {});
        await chrome.tabs
          .sendMessage(tabId, {
            type: 'APPLY_SUBTITLE_TRACK',
            track: savedTrack,
          } satisfies ExtensionMessage)
          .catch(() => {});
      }

      setActiveTrackName(savedTrack.fileName);
      setSubStatus(`Loaded “${savedTrack.fileName}” (${cues.length} lines) onto video!`);
    } finally {
      setLoadingFileUrl(null);
    }
  };

  const isCapturing =
    captureState.status === 'listening' ||
    captureState.status === 'transcribing' ||
    captureState.status === 'starting';

  const handleToggleCapture = async () => {
    const type = isCapturing ? 'STOP_CAPTURE' : 'START_CAPTURE';
    const next = (await chrome.runtime.sendMessage({
      type,
      tabId,
    } satisfies ExtensionMessage)) as CaptureState;
    if (next?.status) setCaptureState(next);
  };

  const openDashboard = (tab: 'review' | 'vocab' | 'subtitles' | 'settings' | 'playground') => {
    chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', tab } satisfies ExtensionMessage).catch(() => {});
  };

  return (
    <div className="popup">
      <div className="header">
        <div className="brand">
          <div className="logo">言</div>
          <div>
            <div className="brand-title">KotoStream</div>
            <div className="brand-sub">Japanese Immersion Toolkit</div>
          </div>
        </div>
        <span className="site-badge">{siteLabel}</span>
      </div>

      {/* Automatic Subtitle Matching Section */}
      <div className="card">
        <div className="section-title">
          <span>Matching Subtitles (Jimaku)</span>
          {activeTrackName && <span style={{ color: '#34d399', fontSize: 10 }}>● Synced</span>}
        </div>

        {activeTrackName && (
          <div className="ok-box" style={{ marginTop: 0, marginBottom: 8 }}>
            Active: <strong>{activeTrackName}</strong>
            <div style={{ fontSize: 10, opacity: 0.85 }}>Use -0.5s / +0.5s on the video toolbar to fine-tune sync.</div>
          </div>
        )}

        {settings && !settings.subtitles.jimakuApiKey.trim() ? (
          <div>
            <div style={{ fontSize: 11, color: '#cbd5e1', marginBottom: 6 }}>
              Paste your free API key from <strong>jimaku.cc/account</strong> to auto-find Japanese subtitles:
            </div>
            <form className="mini-search" onSubmit={handleSaveJimakuKeyInline} style={{ marginBottom: 0 }}>
              <input
                type="password"
                placeholder="Paste Jimaku API key…"
                value={jimakuKeyDraft}
                onChange={(e) => setJimakuKeyDraft(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="submit" className="btn btn-primary btn-xs">
                Save
              </button>
            </form>
          </div>
        ) : (
          <>
            <form
              className="mini-search"
              onSubmit={(e) => {
                e.preventDefault();
                void runJimakuSearch(searchQuery, episodeInput);
              }}
            >
              <input
                type="text"
                placeholder="Show title…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ flex: 1 }}
              />
              <input
                type="number"
                min={1}
                placeholder="Ep"
                value={episodeInput}
                onChange={(e) => setEpisodeInput(e.target.value)}
                style={{ width: 52 }}
              />
              <button type="submit" className="btn btn-primary btn-xs">
                Find
              </button>
            </form>

            {detectedRawTitle && (
              <div
                style={{
                  fontSize: 10,
                  color: '#64748b',
                  marginBottom: 6,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={detectedRawTitle}
              >
                Detected: {detectedRawTitle}
              </div>
            )}

            {jimakuEntries.length > 0 && (
              <div className="chip-row">
                {jimakuEntries.slice(0, 4).map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`chip ${selectedEntry?.id === entry.id ? 'active' : ''}`}
                    title={entry.name}
                    onClick={() => void loadFilesForEntry(entry, episodeInput)}
                  >
                    {entry.japanese_name || entry.name}
                  </button>
                ))}
              </div>
            )}

            {subStatus && (
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>{subStatus}</div>
            )}

            {subError && <div className="error-box" style={{ marginTop: 0, marginBottom: 6 }}>{subError}</div>}

            {jimakuFiles.length > 0 && (
              <div className="sub-list">
                {jimakuFiles.slice(0, 8).map((file) => (
                  <div className="sub-item" key={file.url}>
                    <span className="sub-name" title={file.name}>{file.name}</span>
                    <button
                      type="button"
                      className="btn btn-primary btn-xs"
                      disabled={loadingFileUrl === file.url}
                      onClick={() => void handleApplyJimakuFile(file)}
                    >
                      {loadingFileUrl === file.url ? '…' : 'Load'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Live AI Fallback Section */}
      <div className="card">
        <div className="capture-status">
          <span className={`dot ${captureState.status}`} />
          <span>
            {captureState.status === 'idle' && 'Live AI Subtitles (Fallback): Off'}
            {captureState.status === 'starting' && 'Connecting to tab audio…'}
            {captureState.status === 'listening' && 'Listening to tab audio…'}
            {captureState.status === 'transcribing' && 'Generating Japanese subtitles…'}
            {captureState.status === 'error' && 'Capture error'}
          </span>
        </div>

        <button
          className={`btn ${isCapturing ? 'btn-danger' : ''}`}
          onClick={handleToggleCapture}
        >
          {isCapturing ? 'Stop Live AI Subtitles' : 'Start Live AI Subtitles'}
        </button>

        {captureState.status === 'error' && (
          <div className="error-box">{captureState.message}</div>
        )}

        {lastSubtitle && isCapturing && (
          <div
            style={{
              marginTop: 8,
              padding: '7px 9px',
              borderRadius: 8,
              background: 'rgba(15, 23, 42, 0.85)',
              border: '1px solid rgba(129, 140, 248, 0.3)',
              fontSize: 12,
              color: '#e0e7ff',
            }}
          >
            <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2 }}>Latest Subtitle:</div>
            {lastSubtitle}
          </div>
        )}
      </div>

      <div className="stats-grid">
        <div className="stat-tile">
          <div className="stat-val known">{stats.known}</div>
          <div className="stat-label">Known</div>
        </div>
        <div className="stat-tile">
          <div className="stat-val learning">{stats.learning}</div>
          <div className="stat-label">Learning</div>
        </div>
        <div className="stat-tile">
          <div className="stat-val due">{stats.due}</div>
          <div className="stat-label">Due SRS</div>
        </div>
      </div>

      <div className="nav-grid">
        <button className="btn" onClick={() => openDashboard('subtitles')}>
          Subtitles Library
        </button>
        <button className="btn" onClick={() => openDashboard('review')}>
          Review ({stats.due})
        </button>
        <button className="btn" onClick={() => openDashboard('vocab')}>
          Vocabulary
        </button>
        <button className="btn" onClick={() => openDashboard('settings')}>
          Settings &amp; Anki
        </button>
      </div>
    </div>
  );
};
