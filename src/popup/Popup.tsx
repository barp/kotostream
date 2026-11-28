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

function formatSecClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${mins}:${rem.toString().padStart(2, '0')}`;
}

export const Popup: React.FC = () => {
  const [tabId, setTabId] = useState<number | undefined>();
  const [tabUrl, setTabUrl] = useState<string>('');
  const [siteLabel, setSiteLabel] = useState('Current Tab');
  const [captureState, setCaptureState] = useState<CaptureState>({ status: 'idle' });
  const [captureTabId, setCaptureTabId] = useState<number | null>(null);
  const [lastSubtitle, setLastSubtitle] = useState<string>('');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [stats, setStats] = useState({ known: 0, learning: 0, mined: 0 });
  const activeTabIdRef = React.useRef<number | undefined>(undefined);

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
      activeTabIdRef.current = activeTab?.id;
      setTabId(activeTab?.id);
      setTabUrl(activeTab?.url ?? '');
      setSiteLabel(detectSiteLabel(activeTab?.url));
      setSettings(loadedSettings);

      const entries = Object.values(vocab);
      setStats({
        known: entries.filter((e) => e.status === 'known').length,
        learning: entries.filter((e) => e.status === 'learning').length,
        mined: cards.length,
      });

      const capRes = (await chrome.runtime.sendMessage({
        type: 'GET_CAPTURE_STATE',
      } satisfies ExtensionMessage)) as { state?: CaptureState; activeTabId?: number | null };
      if (capRes?.state) {
        setCaptureState(capRes.state);
        setCaptureTabId(capRes.activeTabId ?? ('tabId' in capRes.state ? capRes.state.tabId : null));
      }

      let detectedShow = '';
      let detectedEp = '';
      if (loadedSettings.enabled && activeTab?.id) {
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

      const ignoredTitles = new Set(['Amazon Prime Video', 'Prime Video', 'YouTube', 'Netflix', 'New Tab', '']);
      if (loadedSettings.enabled && loadedSettings.subtitles.jimakuApiKey.trim() && !ignoredTitles.has(detectedShow)) {
        void runJimakuSearch(detectedShow, detectedEp);
      }
    };

    void load();

    const listener = (msg: ExtensionMessage) => {
      if (msg.type === 'CAPTURE_STATE_CHANGED') {
        setCaptureState(msg.state);
        setCaptureTabId(
          msg.tabId ?? ('tabId' in msg.state ? msg.state.tabId : null)
        );
      } else if (msg.type === 'SUBTITLE_RECEIVED') {
        if (msg.tabId === undefined || msg.tabId === activeTabIdRef.current) {
          setLastSubtitle(msg.subtitle.text);
        }
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
        await chrome.scripting
          .executeScript({ target: { tabId }, files: ['content.js'] })
          .catch(() => {});
        await chrome.tabs
          .sendMessage(tabId, {
            type: 'APPLY_SUBTITLE_TRACK',
            track: savedTrack,
          } satisfies ExtensionMessage)
          .catch(() => {});

        const bufState = (await chrome.runtime.sendMessage({
          type: 'START_AUDIO_BUFFER',
          tabId,
        } satisfies ExtensionMessage)) as CaptureState;
        if (bufState?.status) {
          setCaptureState(bufState);
          setCaptureTabId(bufState.status === 'idle' || bufState.status === 'error' ? null : tabId);
        }
      }

      setActiveTrackName(savedTrack.fileName);
      setSubStatus(`Loaded “${savedTrack.fileName}” (${cues.length} lines) + audio buffer active!`);
    } finally {
      setLoadingFileUrl(null);
    }
  };

  const stateBelongsToOtherTab =
    captureState.status !== 'idle' &&
    captureState.status !== 'error' &&
    captureTabId !== null &&
    tabId !== undefined &&
    captureTabId !== tabId;

  const effectiveCaptureState: CaptureState = stateBelongsToOtherTab
    ? { status: 'idle' }
    : captureState;

  const isCapturingLive =
    effectiveCaptureState.status === 'prescanning' ||
    effectiveCaptureState.status === 'listening' ||
    effectiveCaptureState.status === 'transcribing' ||
    effectiveCaptureState.status === 'starting';

  const isAudioBufferActive = effectiveCaptureState.status === 'buffering' || isCapturingLive;

  const handleToggleAudioBuffer = async () => {
    const type = isAudioBufferActive ? 'STOP_CAPTURE' : 'START_AUDIO_BUFFER';
    const next = (await chrome.runtime.sendMessage({
      type,
      tabId,
    } satisfies ExtensionMessage)) as CaptureState;
    if (next?.status) {
      setCaptureState(next);
      setCaptureTabId(next.status === 'idle' || next.status === 'error' ? null : (tabId ?? null));
    }
  };

  const handleToggleCapture = async () => {
    const type = isCapturingLive ? 'STOP_CAPTURE' : 'START_CAPTURE';
    const next = (await chrome.runtime.sendMessage({
      type,
      tabId,
    } satisfies ExtensionMessage)) as CaptureState;
    if (next?.status) {
      setCaptureState(next);
      setCaptureTabId(next.status === 'idle' || next.status === 'error' ? null : (tabId ?? null));
    }
  };

  const isEnabled = settings?.enabled ?? true;

  const handleToggleExtension = async () => {
    if (!settings) return;
    const nextEnabled = !settings.enabled;
    const updated: AppSettings = { ...settings, enabled: nextEnabled };
    await saveSettings(updated);
    setSettings(updated);

    if (!nextEnabled) {
      if (isAudioBufferActive || stateBelongsToOtherTab) {
        const stopped = (await chrome.runtime.sendMessage({
          type: 'STOP_CAPTURE',
        } satisfies ExtensionMessage)) as CaptureState;
        if (stopped?.status) {
          setCaptureState(stopped);
          setCaptureTabId(null);
        }
      }
      if (tabId) {
        await chrome.tabs
          .sendMessage(tabId, { type: 'SET_ENABLED', enabled: false } satisfies ExtensionMessage)
          .catch(() => {
            chrome.scripting
              .executeScript({
                target: { tabId },
                func: () => {
                  document.querySelectorAll('#kotostream-overlay-host').forEach((el) => el.remove());
                },
              })
              .catch(() => {});
          });
      }
    } else if (nextEnabled && tabId) {
      await chrome.scripting
        .executeScript({ target: { tabId }, files: ['content.js'] })
        .catch(() => {});
      await chrome.tabs
        .sendMessage(tabId, { type: 'SET_ENABLED', enabled: true } satisfies ExtensionMessage)
        .catch(() => {});
      if (searchQuery.trim() && jimakuEntries.length === 0 && updated.subtitles.jimakuApiKey.trim()) {
        void runJimakuSearch(searchQuery, episodeInput);
      }
    }
  };

  const openDashboard = (tab: 'vocab' | 'subtitles' | 'settings' | 'playground') => {
    chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', tab } satisfies ExtensionMessage).catch(() => {});
  };

  return (
    <div className="popup">
      <div className="header">
        <div className="brand">
          <div className={`logo ${isEnabled ? '' : 'dim'}`}>言</div>
          <div>
            <div className="brand-title">KotoStream</div>
            <div className="brand-sub">{siteLabel}</div>
          </div>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className={`power-toggle ${isEnabled ? 'on' : ''}`}
            onClick={() => void handleToggleExtension()}
            title={isEnabled ? 'Disable KotoStream on video pages' : 'Enable KotoStream on video pages'}
          >
            <span className="power-knob" />
            <span>{isEnabled ? 'ON' : 'OFF'}</span>
          </button>
        </div>
      </div>

      {!isEnabled ? (
        <div className="disabled-banner">
          <div className="disabled-banner-title">KotoStream is disabled</div>
          <div className="disabled-banner-sub">
            Subtitle overlays, word hover popups, and tab audio capture are turned off on all video pages.
          </div>
          <button
            type="button"
            className="btn btn-primary btn-inline"
            onClick={() => void handleToggleExtension()}
          >
            Enable KotoStream
          </button>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="section-title">
              <span>Matching Subtitles (Jimaku)</span>
              {activeTrackName && <span className="sync-badge">● Synced</span>}
            </div>

            {activeTrackName && (
              <div className="ok-box">
                Active: <strong>{activeTrackName}</strong>
                <div className="ok-sub">Use -0.5s / +0.5s on the video toolbar to fine-tune sync.</div>
              </div>
            )}

            {settings && !settings.subtitles.jimakuApiKey.trim() ? (
              <div>
                <div className="key-hint">
                  Paste your free API key from <strong>jimaku.cc/account</strong> to auto-find Japanese subtitles:
                </div>
                <form className="mini-search no-margin" onSubmit={handleSaveJimakuKeyInline}>
                  <input
                    className="input-grow"
                    type="password"
                    placeholder="Paste Jimaku API key…"
                    value={jimakuKeyDraft}
                    onChange={(e) => setJimakuKeyDraft(e.target.value)}
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
                    className="input-grow"
                    type="text"
                    placeholder="Show title…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  <input
                    className="input-ep"
                    type="number"
                    min={1}
                    placeholder="Ep"
                    value={episodeInput}
                    onChange={(e) => setEpisodeInput(e.target.value)}
                  />
                  <button type="submit" className="btn btn-primary btn-xs">
                    Find
                  </button>
                </form>

                {detectedRawTitle && (
                  <div className="detected-title" title={detectedRawTitle}>
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

                {subStatus && <div className="status-note">{subStatus}</div>}

                {subError && <div className="error-box tight">{subError}</div>}

                {jimakuFiles.length > 0 && (
                  <div className="sub-list">
                    {jimakuFiles.map((file) => (
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

          <div className="card">
            <div className="capture-status">
              <span
                className={`dot ${
                  effectiveCaptureState.status === 'buffering'
                    ? 'listening'
                    : effectiveCaptureState.status === 'prescanning'
                      ? 'transcribing'
                      : effectiveCaptureState.status
                }`}
              />
              <span>
                {effectiveCaptureState.status === 'idle' &&
                  (stateBelongsToOtherTab
                    ? 'Audio capture active in another tab'
                    : 'Sentence Audio Buffer: Off')}
                {effectiveCaptureState.status === 'buffering' && '🔊 Sentence Audio Buffer: Active (60s stereo)'}
                {effectiveCaptureState.status === 'starting' && 'Starting silent AI pre-scan…'}
                {effectiveCaptureState.status === 'prescanning' &&
                  (effectiveCaptureState.phase === 'finalizing'
                    ? `Finalizing AI subtitles… (${effectiveCaptureState.linesGenerated} lines)`
                    : `🔇 Silent AI Pre-Scan (${effectiveCaptureState.playbackRate}x) · ${Math.round(effectiveCaptureState.progress * 100)}%`)}
                {effectiveCaptureState.status === 'listening' && 'Live AI Subs + Audio Buffer: Active'}
                {effectiveCaptureState.status === 'transcribing' && 'Generating Japanese subtitles…'}
                {effectiveCaptureState.status === 'error' && 'Capture error'}
              </span>
            </div>

            {effectiveCaptureState.status === 'prescanning' && (
              <div className="prescan-box">
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${Math.min(100, Math.max(2, Math.round(effectiveCaptureState.progress * 100)))}%`,
                    }}
                  />
                </div>
                <div className="progress-meta">
                  <span>
                    {formatSecClock(effectiveCaptureState.currentTimeSec)} / {formatSecClock(effectiveCaptureState.durationSec)}
                  </span>
                  <span>{effectiveCaptureState.linesGenerated} lines pre-created</span>
                </div>
                <div className="progress-hint">
                  Sound is muted while scanning. You’ll get a notification as soon as subtitles are ready.
                </div>
              </div>
            )}

            <div className="btn-row">
              <button
                type="button"
                className={`btn btn-compact ${effectiveCaptureState.status === 'buffering' ? 'btn-danger' : 'btn-primary'}`}
                disabled={effectiveCaptureState.status === 'prescanning'}
                onClick={handleToggleAudioBuffer}
              >
                {effectiveCaptureState.status === 'buffering' ? 'Stop Audio Buffer' : 'Enable Sentence Audio'}
              </button>
              <button
                type="button"
                className={`btn btn-compact ${isCapturingLive ? 'btn-danger' : ''}`}
                onClick={handleToggleCapture}
              >
                {effectiveCaptureState.status === 'prescanning'
                  ? 'Cancel AI Scan'
                  : isCapturingLive
                    ? 'Stop AI Subs'
                    : 'AI Pre-Scan Subs'}
              </button>
            </div>

            {effectiveCaptureState.status === 'error' && (
              <div className="error-box">{effectiveCaptureState.message}</div>
            )}

            {lastSubtitle && isCapturingLive && (
              <div className="latest-sub">
                <div className="latest-sub-label">Latest Subtitle:</div>
                {lastSubtitle}
              </div>
            )}
          </div>
        </>
      )}

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
          <div className="stat-val mined">{stats.mined}</div>
          <div className="stat-label">Mined</div>
        </div>
      </div>

      <div className="nav-grid">
        <button type="button" className="btn" onClick={() => openDashboard('subtitles')}>
          Subtitles Library
        </button>
        <button type="button" className="btn" onClick={() => openDashboard('vocab')}>
          Vocab &amp; Cards ({stats.mined})
        </button>
        <button type="button" className="btn" onClick={() => openDashboard('playground')}>
          Playground
        </button>
        <button type="button" className="btn" onClick={() => openDashboard('settings')}>
          Settings &amp; Anki
        </button>
      </div>
    </div>
  );
};
