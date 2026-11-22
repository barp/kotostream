import type { CaptureState, DictionaryEntry, ExtensionMessage, SubtitleLine } from '../types';
import { getSettings, getDictCache, cacheDictEntry } from '../core/storage';
import { lookupLocal, lookupOnJisho } from '../core/dictionary';
import { invokeAnkiConnect } from '../core/anki';
import { transcribeAudioChunk, transcribeBatchChunkWithTimestamps } from './stt';
import { translateJapaneseSentence } from './translate';
import { downloadJimakuSubtitle, listJimakuFiles, searchJimakuEntries } from './jimaku';

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';

let activeCaptureTabId: number | null = null;
let captureState: CaptureState = { status: 'idle' };
let previousTranscript = '';
let inFlightChunks = 0;
let chunkSeq = 0;
let lastDeliveredSeq = 0;
const memoryDictCache = new Map<string, DictionaryEntry>();
const nonExistentExactWords = new Set<string>();
const pendingLookups = new Map<string, Promise<DictionaryEntry | null>>();

function broadcastCaptureState(state: CaptureState) {
  captureState = state;
  const msg: ExtensionMessage = {
    type: 'CAPTURE_STATE_CHANGED',
    state,
    tabId: activeCaptureTabId ?? undefined,
  };
  chrome.runtime.sendMessage(msg).catch(() => {});
  if (activeCaptureTabId !== null) {
    chrome.tabs.sendMessage(activeCaptureTabId, msg).catch(() => {});
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Capture tab audio from Amazon Prime Video / streaming sites for real-time Japanese subtitle generation.',
  });
}

async function startTabCapture(tabId: number): Promise<CaptureState> {
  const settings = await getSettings();
  if (!settings.stt.apiKey.trim()) {
    const errState: CaptureState = {
      status: 'error',
      message: 'No OpenRouter API key set. Open Settings to add your OpenRouter key.',
    };
    broadcastCaptureState(errState);
    return errState;
  }

  // Stop any existing capture first
  if (activeCaptureTabId !== null) {
    await stopTabCapture();
  }

  activeCaptureTabId = tabId;
  previousTranscript = '';
  chunkSeq = 0;
  lastDeliveredSeq = 0;
  broadcastCaptureState({ status: 'starting' });

  try {
    // Ensure the content script overlay is injected into the target tab (works on any Amazon TLD or video site)
    await chrome.scripting
      .executeScript({
        target: { tabId },
        files: ['content.js'],
      })
      .catch(() => {});

    await ensureOffscreenDocument();

    const streamId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError || !id) {
          const rawMsg = chrome.runtime.lastError?.message || 'Failed to get tab capture streamId';
          if (rawMsg.toLowerCase().includes('invoked') || rawMsg.toLowerCase().includes('activetab')) {
            reject(
              new Error(
                'Click the KotoStream extension icon in Chrome’s top toolbar to start audio capture on this tab.'
              )
            );
          } else {
            reject(new Error(rawMsg));
          }
        } else {
          resolve(id);
        }
      });
    });

    const response = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START_AUDIO',
      streamId,
      tabId,
      settings: settings.stt,
    } satisfies ExtensionMessage);

    if (response?.error) {
      throw new Error(response.error);
    }

    const listeningState: CaptureState = { status: 'listening', tabId, lastActivityAt: Date.now() };
    broadcastCaptureState(listeningState);
    return listeningState;
  } catch (err) {
    activeCaptureTabId = null;
    const message = err instanceof Error ? err.message : String(err);
    const errState: CaptureState = { status: 'error', message };
    broadcastCaptureState(errState);
    return errState;
  }
}

async function stopTabCapture(): Promise<CaptureState> {
  const prevTabId = activeCaptureTabId;
  activeCaptureTabId = null;
  previousTranscript = '';
  inFlightChunks = 0;

  try {
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_AUDIO' } satisfies ExtensionMessage);
  } catch {
    // Offscreen doc might not exist
  }

  const idleState: CaptureState = { status: 'idle' };
  captureState = idleState;
  const msg: ExtensionMessage = { type: 'CAPTURE_STATE_CHANGED', state: idleState, tabId: prevTabId ?? undefined };
  chrome.runtime.sendMessage(msg).catch(() => {});
  if (prevTabId !== null) {
    chrome.tabs.sendMessage(prevTabId, msg).catch(() => {});
  }
  return idleState;
}

async function handleAudioChunk(
  tabId: number,
  audioBase64: string,
  mimeType: string,
  rms: number,
  silenceGapMs: number
): Promise<void> {
  if (activeCaptureTabId !== tabId) return;

  // Allow up to 3 parallel requests so rapid speech is never dropped
  if (inFlightChunks >= 3) return;

  const mySeq = ++chunkSeq;
  const settings = await getSettings();
  inFlightChunks++;
  broadcastCaptureState({ status: 'transcribing', tabId });

  try {
    const result = await transcribeAudioChunk(audioBase64, mimeType, settings.stt, {
      previousTranscript,
      rms,
    });

    if (activeCaptureTabId !== tabId) return;

    // Drop stale out-of-order responses if a newer chunk already arrived
    if (result.text && mySeq > lastDeliveredSeq) {
      lastDeliveredSeq = mySeq;
      previousTranscript = result.text;
      const subtitle: SubtitleLine = {
        id: `stt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text: result.text,
        timestampMs: Date.now(),
        source: 'live-stt',
        latencyMs: result.latencyMs,
        silenceGapMs,
        segments: result.segments,
      };
      const subMsg: ExtensionMessage = {
        type: 'SUBTITLE_RECEIVED',
        subtitle,
        tabId,
      };
      chrome.runtime.sendMessage(subMsg).catch(() => {});
      chrome.tabs.sendMessage(tabId, subMsg).catch(() => {});
    }

    broadcastCaptureState({
      status: 'listening',
      tabId,
      lastActivityAt: Date.now(),
      lastLatencyMs: result.latencyMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    broadcastCaptureState({ status: 'error', message });
  } finally {
    inFlightChunks = Math.max(0, inFlightChunks - 1);
  }
}

async function handleWordLookup(
  word: string,
  surface?: string,
  exactOnly = false
): Promise<DictionaryEntry | null> {
  const key = word.trim();
  if (!key) return null;

  if (exactOnly && nonExistentExactWords.has(key)) return null;

  // 0. Instant in-memory cache (0ms)
  const memHit =
    memoryDictCache.get(key) ?? (!exactOnly && surface ? memoryDictCache.get(surface) : undefined);
  if (memHit && (!exactOnly || memHit.word === key || memHit.reading === key)) {
    return memHit;
  }

  // 1. Instant local dictionary check (return immediately if exact hit!)
  const local = lookupLocal(key) ?? (!exactOnly && surface ? lookupLocal(surface) : null);
  if (local && (local.word === key || (!exactOnly && local.word === surface))) {
    memoryDictCache.set(key, local);
    return local;
  }

  // Deduplicate concurrent requests for the same word (e.g. prefetch + hover)
  const cacheKey = exactOnly ? `exact:${key}` : key;
  const existingPromise = pendingLookups.get(cacheKey);
  if (existingPromise) return existingPromise;

  const task = (async (): Promise<DictionaryEntry | null> => {
    // 2. Persistent Jisho cache check
    const cache = await getDictCache();
    if (cache[key]) {
      const hit = cache[key];
      if (!exactOnly || hit.word === key || hit.reading === key) {
        memoryDictCache.set(key, hit);
        return hit;
      }
    }
    if (!exactOnly && surface && cache[surface]) {
      memoryDictCache.set(key, cache[surface]);
      return cache[surface];
    }

    // 3. Query Jisho.org API (richer definitions & full JMdict coverage)
    try {
      const jisho = await lookupOnJisho(key, exactOnly);
      if (jisho) {
        memoryDictCache.set(key, jisho);
        await cacheDictEntry(key, jisho);
        return jisho;
      }
      if (exactOnly) {
        nonExistentExactWords.add(key);
        return null;
      }
    } catch {
      if (exactOnly) return null;
    }

    if (local) memoryDictCache.set(key, local);
    return local;
  })();

  pendingLookups.set(cacheKey, task);
  try {
    return await task;
  } finally {
    pendingLookups.delete(cacheKey);
  }
}

// Stop capture if the captured tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeCaptureTabId) {
    void stopTabCapture();
  }
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  const handle = async () => {
    switch (message.type) {
      case 'START_CAPTURE': {
        const targetTabId = message.tabId ?? sender.tab?.id;
        if (!targetTabId) {
          return { status: 'error', message: 'No active tab found to capture.' } satisfies CaptureState;
        }
        return startTabCapture(targetTabId);
      }

      case 'STOP_CAPTURE': {
        return stopTabCapture();
      }

      case 'GET_CAPTURE_STATE': {
        return { state: captureState, activeTabId: activeCaptureTabId };
      }

      case 'OFFSCREEN_AUDIO_CHUNK': {
        void handleAudioChunk(
          message.tabId,
          message.audioBase64,
          message.mimeType,
          message.rms,
          message.silenceGapMs
        );
        return { ok: true };
      }

      case 'LOOKUP_WORD': {
        const entry = await handleWordLookup(message.word, message.surface, message.exactOnly);
        return { entry };
      }

      case 'TRANSLATE_SENTENCE': {
        try {
          const settings = await getSettings();
          const result = await translateJapaneseSentence(message.sentence, settings, message.targetWord);
          return result;
        } catch (err) {
          return {
            translation: '',
            providerUsed: 'error',
            error: err instanceof Error ? err.message : 'Translation failed',
          };
        }
      }

      case 'CAPTURE_SCREENSHOT': {
        try {
          const windowId = sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
          const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
            format: 'png',
          });
          return { dataUrl };
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Screenshot failed' };
        }
      }

      case 'REQUEST_RECENT_AUDIO': {
        try {
          const res = await chrome.runtime.sendMessage({
            type: 'OFFSCREEN_GET_RECENT_AUDIO',
          } satisfies ExtensionMessage);
          return res ?? { audioBase64: undefined };
        } catch {
          return { audioBase64: undefined };
        }
      }

      case 'ANKI_REQUEST': {
        try {
          const result = await invokeAnkiConnect(message.action, message.params, message.url);
          return { result };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'JIMAKU_SEARCH': {
        try {
          const settings = await getSettings();
          const entries = await searchJimakuEntries(message.query, settings.subtitles.jimakuApiKey);
          return { entries };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'JIMAKU_LIST_FILES': {
        try {
          const settings = await getSettings();
          const files = await listJimakuFiles(
            message.entryId,
            settings.subtitles.jimakuApiKey,
            message.episode
          );
          return { files };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'JIMAKU_DOWNLOAD': {
        try {
          const text = await downloadJimakuSubtitle(message.url);
          return { text };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'BATCH_TRANSCRIBE_CHUNK': {
        try {
          const settings = await getSettings();
          const cues = await transcribeBatchChunkWithTimestamps(
            message.audioBase64,
            message.mimeType,
            message.chunkOffsetSec,
            settings.stt
          );
          return { cues };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'OPEN_DASHBOARD': {
        const hash = message.tab ? `#${message.tab}` : '';
        const url = chrome.runtime.getURL(`src/dashboard/index.html${hash}`);
        await chrome.tabs.create({ url });
        return { ok: true };
      }

      default:
        return { ok: false };
    }
  };

  void handle().then(sendResponse);
  return true; // keep message channel open for async response
});
