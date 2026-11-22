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
  };

  tryMount();

  // Re-mount on SPA navigation, dynamic Prime Video player creation, and fullscreen transitions
  const observer = new MutationObserver(() => {
    tryMount();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('fullscreenchange', () => {
    setTimeout(tryMount, 80);
  });

  // Sync initial capture state from background worker
  chrome.runtime
    .sendMessage({ type: 'GET_CAPTURE_STATE' } satisfies ExtensionMessage)
    .then((res) => {
      if (res?.state) overlay.updateCaptureState(res.state);
    })
    .catch(() => {});

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
