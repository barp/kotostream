import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type MinedCard,
  type SavedSubtitleTrack,
  type VocabEntry,
} from '../types';
import {
  getMinedCards,
  getSettings,
  getSubtitleLibrary,
  getVocabMap,
} from '../core/storage';
import { SubtitlesTab } from './components/SubtitlesTab';
import { VocabTab } from './components/VocabTab';
import { SettingsTab } from './components/SettingsTab';
import { PlaygroundTab } from './components/PlaygroundTab';
import { BookIcon, SlidersIcon, SparklesIcon, SubtitlesIcon } from '../components/Icons';

type DashboardTab = 'subtitles' | 'vocab' | 'settings' | 'playground';

function parseTabFromHash(): DashboardTab {
  const hash = window.location.hash.replace('#', '');
  if (hash === 'vocab' || hash === 'subtitles' || hash === 'settings' || hash === 'playground') {
    return hash;
  }
  return 'subtitles';
}

export const Dashboard: React.FC = () => {
  const [tab, setTabState] = useState<DashboardTab>(parseTabFromHash);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [vocabMap, setVocabMap] = useState<Record<string, VocabEntry>>({});
  const [cards, setCards] = useState<MinedCard[]>([]);
  const [subtitleLibrary, setSubtitleLibrary] = useState<SavedSubtitleTrack[]>([]);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const selectTab = useCallback((next: DashboardTab) => {
    setTabState(next);
    if (window.location.hash !== `#${next}`) {
      window.location.hash = next;
    }
  }, []);

  useEffect(() => {
    const onHashChange = () => setTabState(parseTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const showNotice = useCallback((type: 'success' | 'error', text: string) => {
    setBanner({ type, text });
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setBanner(null);
      noticeTimerRef.current = null;
    }, 4500);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
      }
    };
  }, []);

  const reloadAll = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll]);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== 'local') return;
      if (
        changes.kotostream_cards ||
        changes.kotostream_vocab ||
        changes.kotostream_subtitle_library ||
        changes.kotostream_settings
      ) {
        void reloadAll();
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [reloadAll]);

  return (
    <div className="layout">
      <header className="topbar">
        <div className="brand">
          <div className="logo">言</div>
          <div>
            <h1>KotoStream</h1>
            <p>Japanese Immersion • AI Subtitles &amp; Anki Mining for Prime Video, YouTube &amp; Netflix</p>
          </div>
        </div>

        <nav className="tabs" aria-label="Dashboard sections">
          <button
            type="button"
            className={`tab-btn ${tab === 'subtitles' ? 'active' : ''}`}
            onClick={() => selectTab('subtitles')}
          >
            <SubtitlesIcon size={14} />
            <span>Subtitles</span>
            <span className="tab-count">{subtitleLibrary.length}</span>
          </button>
          <button
            type="button"
            className={`tab-btn ${tab === 'vocab' ? 'active' : ''}`}
            onClick={() => selectTab('vocab')}
          >
            <BookIcon size={14} />
            <span>Vocab &amp; Cards</span>
            <span className="tab-count">{cards.length}</span>
          </button>
          <button
            type="button"
            className={`tab-btn ${tab === 'settings' ? 'active' : ''}`}
            onClick={() => selectTab('settings')}
          >
            <SlidersIcon size={14} />
            <span>Settings &amp; Anki</span>
          </button>
          <button
            type="button"
            className={`tab-btn ${tab === 'playground' ? 'active' : ''}`}
            onClick={() => selectTab('playground')}
          >
            <SparklesIcon size={14} />
            <span>Playground</span>
          </button>
        </nav>
      </header>

      {banner && <div className={`banner ${banner.type}`}>{banner.text}</div>}

      {tab === 'subtitles' && (
        <SubtitlesTab
          settings={settings}
          subtitleLibrary={subtitleLibrary}
          onReload={reloadAll}
          onNotice={showNotice}
          onJimakuKeySaved={(apiKey) =>
            setSettings((s) => ({ ...s, subtitles: { ...s.subtitles, jimakuApiKey: apiKey } }))
          }
        />
      )}

      {tab === 'vocab' && (
        <VocabTab
          settings={settings}
          cards={cards}
          vocabMap={vocabMap}
          onReload={reloadAll}
          onNotice={showNotice}
        />
      )}

      {tab === 'settings' && (
        <SettingsTab
          savedSettings={settings}
          onSettingsSaved={(next) => setSettings(next)}
          onNotice={showNotice}
        />
      )}

      {tab === 'playground' && (
        <PlaygroundTab
          settings={settings}
          vocabMap={vocabMap}
          onReload={reloadAll}
          onNotice={showNotice}
        />
      )}
    </div>
  );
};
