import type { ExtensionMessage } from '../types';
import { getSettings, getVocabMap } from '../core/storage';
import { parseMediaTitle } from '../core/title-parser';
import { primeVideoAdapter } from './adapters/prime';
import { youtubeAdapter } from './adapters/youtube';
import { netflixAdapter } from './adapters/netflix';
import { genericAdapter } from './adapters/generic';
import type { SiteAdapter } from './adapters/base';
import { OverlayManager } from './overlay/OverlayManager';

const ADAPTERS: SiteAdapter[] = [
  primeVideoAdapter,
  youtubeAdapter,
  netflixAdapter,
  genericAdapter,
];

function selectAdapter(): SiteAdapter {
  const url = new URL(window.location.href);
  return ADAPTERS.find((a) => a.matches(url)) ?? genericAdapter;
}

async function init() {
  // Prevent double initialization
  if ((window as unknown as { __kotostreamInit?: boolean }).__kotostreamInit) return;
  (window as unknown as { __kotostreamInit?: boolean }).__kotostreamInit = true;

  const adapter = selectAdapter();
  const [settings, vocabMap] = await Promise.all([getSettings(), getVocabMap()]);
  const overlay = new OverlayManager(adapter, settings, vocabMap);

  const tryMount = () => {
    const video = adapter.findVideo();
    if (video) {
      overlay.mount(video);
    } else {
      overlay.ensureMounted();
    }
    // Keep Prime Video's title/episode cache warm while player controls are visible in the DOM
    adapter.getMediaTitle();
  };

  tryMount();

  // Re-mount on SPA navigation, dynamic Prime Video player creation, and fullscreen transitions (throttled)
  let mountTimer: number | null = null;
  const observer = new MutationObserver(() => {
    if (!chrome.runtime?.id) {
      observer.disconnect();
      return;
    }
    if (mountTimer !== null) return;
    mountTimer = window.setTimeout(() => {
      mountTimer = null;
      if (!chrome.runtime?.id) {
        observer.disconnect();
        return;
      }
      tryMount();
    }, 250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('fullscreenchange', () => {
    if (!chrome.runtime?.id) return;
    setTimeout(tryMount, 80);
  });

  // Also capture Prime Video's episode header whenever the user hovers over the player (throttled)
  let lastMetaScan = 0;
  document.addEventListener(
    'mousemove',
    () => {
      if (!chrome.runtime?.id) return;
      const now = Date.now();
      if (now - lastMetaScan > 600) {
        lastMetaScan = now;
        adapter.getMediaTitle();
      }
    },
    { passive: true }
  );

  // Sync initial capture state from background worker
  if (chrome.runtime?.id) {
    try {
      chrome.runtime
        .sendMessage({ type: 'GET_CAPTURE_STATE' } satisfies ExtensionMessage)
        .then((res) => {
          if (res?.state) overlay.updateCaptureState(res.state);
        })
        .catch(() => {});
    } catch {
      // ignore
    }
  }

  // Listen to messages from background service worker & popup
  chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
    if (message.type === 'SUBTITLE_RECEIVED') {
      tryMount();
      overlay.setSubtitle(message.subtitle);
    } else if (message.type === 'CAPTURE_STATE_CHANGED') {
      overlay.updateCaptureState(message.state);
    } else if (message.type === 'GET_PAGE_MEDIA_INFO') {
      const rawTitle = adapter.getMediaTitle();
      const parsed = parseMediaTitle(rawTitle);
      sendResponse({
        rawTitle,
        showName: parsed.showName,
        episodeNumber: parsed.episodeNumber,
        url: window.location.href,
        activeTrackName: overlay.getActiveTrackName(),
      });
      return false;
    } else if (message.type === 'APPLY_SUBTITLE_TRACK') {
      tryMount();
      overlay.applyLoadedTrack(message.track);
      overlay.showToast(`Loaded subtitles: ${message.track.fileName} (${message.track.cues.length} lines)`);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // Live-sync settings & vocab changes from popup/dashboard
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.kotostream_settings) {
      void getSettings().then((s) => overlay.updateSettings(s));
    }
    if (changes.kotostream_vocab) {
      void getVocabMap().then((v) => overlay.updateVocabMap(v));
    }
  });
}

void init();
