import type { CaptureState, DictionaryEntry, ExtensionMessage, SubtitleLine } from '../types';
import { getSettings, getDictCache, cacheDictEntry, saveSubtitleTrack } from '../core/storage';
import { lookupLocal, lookupOnJisho } from '../core/dictionary';
import { invokeAnkiConnect } from '../core/anki';
import { transcribeAudioChunk, transcribeBatchChunkWithTimestamps } from './stt';
import { translateJapaneseSentence } from './translate';
import { downloadJimakuSubtitle, listJimakuFiles, searchJimakuEntries } from './jimaku';
import { analyzeWithMeCab, getMeCabTokenizer } from './mecab';

// Pre-warm MeCab IPADIC dictionary in background so tokenization is instant (<1ms)
void getMeCabTokenizer().catch(() => {});

function syncActionBadge(enabled: boolean) {
  if (!chrome.action) return;
  if (enabled) {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
  } else {
    chrome.action.setBadgeBackgroundColor({ color: '#475569' }).catch(() => {});
    chrome.action.setBadgeText({ text: 'OFF' }).catch(() => {});
  }
}

async function syncEnabledAcrossTabs(enabled: boolean) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !tab.url || !/^https?:\/\//i.test(tab.url)) continue;
      const tabId = tab.id;
      chrome.tabs
        .sendMessage(tabId, { type: 'SET_ENABLED', enabled } satisfies ExtensionMessage)
        .catch(() => {
          // If no live content script responded (e.g. tab was open before an extension reload),
          // directly remove any orphaned overlay host elements when disabling!
          if (!enabled) {
            chrome.scripting
              .executeScript({
                target: { tabId },
                func: () => {
                  document.querySelectorAll('#kotostream-overlay-host').forEach((el) => el.remove());
                },
              })
              .catch(() => {});
          }
        });
    }
  } catch {
    // Ignore tab query errors
  }
}

void getSettings().then((s) => syncActionBadge(s.enabled));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.kotostream_settings) return;
  void getSettings().then((s) => {
    syncActionBadge(s.enabled);
    void syncEnabledAcrossTabs(s.enabled);
    if (!s.enabled && activeCaptureTabId !== null) {
      void stopTabCapture();
    }
  });
});

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';

interface PrescanChunkJob {
  audioBase64: string;
  mimeType: string;
  chunkStartSec: number;
  chunkEndSec: number;
  chunkIndex: number;
}

interface PrescanSession {
  tabId: number;
  title: string;
  url: string;
  durationSec: number;
  currentTimeSec: number;
  playbackRate: number;
  videoEnded: boolean;
  finalized: boolean;
  cancelled: boolean;
  chunksSubmitted: number;
  chunksCompleted: number;
  queue: PrescanChunkJob[];
  activeWorkers: number;
  cues: SubtitleLine[];
  lastError?: string;
}

let activeCaptureTabId: number | null = null;
let captureState: CaptureState = { status: 'idle' };
let prescanSession: PrescanSession | null = null;
const notificationTabMap = new Map<string, number>();
let previousTranscript = '';
let inFlightChunks = 0;
let chunkSeq = 0;
let lastDeliveredSeq = 0;
const memoryDictCache = new Map<string, DictionaryEntry>();
const nonExistentExactWords = new Set<string>();
const pendingLookups = new Map<string, Promise<DictionaryEntry | null>>();

if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener((notificationId) => {
    const tabId = notificationTabMap.get(notificationId);
    notificationTabMap.delete(notificationId);
    chrome.notifications.clear(notificationId, () => {});
    if (tabId !== undefined) {
      chrome.tabs
        .get(tabId)
        .then((tab) => {
          if (tab.windowId !== undefined) {
            void chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
          }
          void chrome.tabs.update(tabId, { active: true }).catch(() => {});
        })
        .catch(() => {});
    }
  });
}

function setPrescanBadge(progress: number, finalizing = false) {
  if (!chrome.action) return;
  chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' }).catch(() => {});
  const text = finalizing ? '...' : `${Math.min(99, Math.max(0, Math.round(progress * 100)))}%`;
  chrome.action.setBadgeText({ text }).catch(() => {});
}

function buildPrescanCaptureState(session: PrescanSession): CaptureState {
  const progress =
    session.durationSec > 0
      ? Math.min(1, Math.max(0, session.currentTimeSec / session.durationSec))
      : 0;
  return {
    status: 'prescanning',
    tabId: session.tabId,
    phase: session.videoEnded ? 'finalizing' : 'scanning',
    playbackRate: session.playbackRate,
    currentTimeSec: session.currentTimeSec,
    durationSec: session.durationSec,
    progress,
    chunksCompleted: session.chunksCompleted,
    chunksTotal: Math.max(session.chunksSubmitted, Math.ceil(session.durationSec / 30)),
    linesGenerated: session.cues.length,
  };
}

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

async function startTabCapture(
  tabId: number,
  mode: 'live_stt' | 'buffer_only' | 'prescan' = 'live_stt',
  playbackRate = 4
): Promise<CaptureState> {
  const settings = await getSettings();
  if (!settings.enabled) {
    return { status: 'idle' };
  }
  if ((mode === 'live_stt' || mode === 'prescan') && !settings.stt.apiKey.trim()) {
    const errState: CaptureState = {
      status: 'error',
      message: 'No OpenRouter API key set. Open Settings to add your OpenRouter key.',
    };
    broadcastCaptureState(errState);
    return errState;
  }

  // If already capturing on this tab in the requested mode (or higher), keep it running
  if (
    activeCaptureTabId === tabId &&
    mode === 'buffer_only' &&
    (captureState.status === 'buffering' ||
      captureState.status === 'prescanning' ||
      captureState.status === 'listening' ||
      captureState.status === 'transcribing')
  ) {
    return captureState;
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
      mode,
      playbackRate,
    } satisfies ExtensionMessage);

    if (response?.error) {
      throw new Error(response.error);
    }

    if (mode === 'prescan') {
      const startRes = (await chrome.tabs.sendMessage(tabId, {
        type: 'PRESCAN_START_VIDEO',
        targetRate: playbackRate,
      } satisfies ExtensionMessage)) as
        | { ok: true; durationSec: number; actualRate: number; title?: string; url?: string }
        | { ok: false; error?: string }
        | undefined;

      if (!startRes || !startRes.ok) {
        throw new Error(startRes?.error || 'Could not start high-speed episode scan on this tab.');
      }

      prescanSession = {
        tabId,
        title: startRes.title || 'Episode',
        url: startRes.url || '',
        durationSec: startRes.durationSec,
        currentTimeSec: 0,
        playbackRate: startRes.actualRate || playbackRate,
        videoEnded: false,
        finalized: false,
        cancelled: false,
        chunksSubmitted: 0,
        chunksCompleted: 0,
        queue: [],
        activeWorkers: 0,
        cues: [],
      };

      void chrome.runtime
        .sendMessage({
          type: 'OFFSCREEN_PRESCAN_SYNC',
          currentTimeSec: 0,
          playbackRate: prescanSession.playbackRate,
          playing: true,
        } satisfies ExtensionMessage)
        .catch(() => {});

      const nextState = buildPrescanCaptureState(prescanSession);
      setPrescanBadge(0, false);
      broadcastCaptureState(nextState);
      return nextState;
    }

    const nextState: CaptureState =
      mode === 'buffer_only'
        ? { status: 'buffering', tabId }
        : { status: 'listening', tabId, lastActivityAt: Date.now() };
    broadcastCaptureState(nextState);
    return nextState;
  } catch (err) {
    if (activeCaptureTabId === tabId) {
      await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_AUDIO' } satisfies ExtensionMessage).catch(() => {});
    }
    prescanSession = null;
    activeCaptureTabId = null;
    void getSettings().then((s) => syncActionBadge(s.enabled));
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

  if (prescanSession) {
    const cancelledSession = prescanSession;
    cancelledSession.cancelled = true;
    prescanSession = null;
    if (!cancelledSession.finalized) {
      await chrome.tabs
        .sendMessage(cancelledSession.tabId, {
          type: 'PRESCAN_STOP_VIDEO',
          rewindToStart: false,
        } satisfies ExtensionMessage)
        .catch(() => {});
    }
  }

  try {
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_AUDIO' } satisfies ExtensionMessage);
  } catch {
    // Offscreen doc might not exist
  }

  void getSettings().then((s) => syncActionBadge(s.enabled));

  const idleState: CaptureState = { status: 'idle' };
  captureState = idleState;
  const msg: ExtensionMessage = { type: 'CAPTURE_STATE_CHANGED', state: idleState, tabId: prevTabId ?? undefined };
  chrome.runtime.sendMessage(msg).catch(() => {});
  if (prevTabId !== null) {
    chrome.tabs.sendMessage(prevTabId, msg).catch(() => {});
  }
  return idleState;
}

function handlePrescanVideoStatus(
  tabId: number,
  status: {
    currentTimeSec: number;
    durationSec: number;
    playbackRate: number;
    playing: boolean;
    ended: boolean;
  }
) {
  const session = prescanSession;
  if (!session || session.tabId !== tabId || session.cancelled || session.finalized) return;

  session.currentTimeSec = status.currentTimeSec;
  if (status.durationSec > 0) session.durationSec = status.durationSec;
  if (status.playbackRate > 0) session.playbackRate = status.playbackRate;

  void chrome.runtime
    .sendMessage({
      type: 'OFFSCREEN_PRESCAN_SYNC',
      currentTimeSec: status.currentTimeSec,
      playbackRate: session.playbackRate,
      playing: status.playing,
      flushNow: status.ended,
    } satisfies ExtensionMessage)
    .catch(() => {});

  if (status.ended && !session.videoEnded) {
    session.videoEnded = true;
    // Restore video to 1x speed, pitch=true, paused at 0:00 immediately while last chunk(s) finish
    void chrome.tabs
      .sendMessage(tabId, {
        type: 'PRESCAN_STOP_VIDEO',
        rewindToStart: true,
      } satisfies ExtensionMessage)
      .catch(() => {});

    // Give offscreen a brief moment to emit its flushed final chunk before finalizing
    setTimeout(() => {
      void maybeFinalizePrescanSession();
    }, 450);
  }

  const state = buildPrescanCaptureState(session);
  if (state.status === 'prescanning') {
    setPrescanBadge(state.progress, state.phase === 'finalizing');
  }
  broadcastCaptureState(state);
}

function enqueuePrescanChunk(tabId: number, job: PrescanChunkJob) {
  const session = prescanSession;
  if (!session || session.tabId !== tabId || session.cancelled || session.finalized) return;
  session.chunksSubmitted++;
  session.queue.push(job);
  broadcastCaptureState(buildPrescanCaptureState(session));
  pumpPrescanQueue();
}

function pumpPrescanQueue() {
  const session = prescanSession;
  if (!session || session.cancelled || session.finalized) return;

  while (session.activeWorkers < 3 && session.queue.length > 0) {
    const job = session.queue.shift()!;
    session.activeWorkers++;
    void (async () => {
      try {
        const settings = await getSettings();
        const chunkCues = await transcribeBatchChunkWithTimestamps(
          job.audioBase64,
          job.mimeType,
          job.chunkStartSec,
          settings.stt,
          { showTitle: session.title }
        );
        if (!session.cancelled && !session.finalized && chunkCues.length > 0) {
          session.cues.push(...chunkCues);
        }
      } catch (err) {
        session.lastError = err instanceof Error ? err.message : String(err);
      } finally {
        session.activeWorkers = Math.max(0, session.activeWorkers - 1);
        session.chunksCompleted++;
        if (!session.cancelled && !session.finalized) {
          broadcastCaptureState(buildPrescanCaptureState(session));
          pumpPrescanQueue();
          void maybeFinalizePrescanSession();
        }
      }
    })();
  }
}

async function maybeFinalizePrescanSession() {
  const session = prescanSession;
  if (
    !session ||
    !session.videoEnded ||
    session.finalized ||
    session.cancelled ||
    session.queue.length > 0 ||
    session.activeWorkers > 0
  ) {
    return;
  }

  session.finalized = true;
  prescanSession = null;

  // Sort cues chronologically & remove exact duplicate timestamps/lines
  const sorted = [...session.cues].sort((a, b) => (a.videoTimeSec ?? 0) - (b.videoTimeSec ?? 0));
  const deduped: SubtitleLine[] = [];
  for (const cue of sorted) {
    const prev = deduped[deduped.length - 1];
    if (
      prev &&
      prev.text === cue.text &&
      Math.abs((prev.videoTimeSec ?? 0) - (cue.videoTimeSec ?? 0)) < 1.0
    ) {
      continue;
    }
    deduped.push(cue);
  }

  // Restore speaker passthrough + 15s sentence audio buffer so user can press Play immediately
  await chrome.runtime
    .sendMessage({
      type: 'OFFSCREEN_SET_MODE',
      mode: 'buffer_only',
    } satisfies ExtensionMessage)
    .catch(() => {});

  const settings = await getSettings();
  syncActionBadge(settings.enabled);

  if (deduped.length > 0) {
    const savedTrack = await saveSubtitleTrack({
      title: session.title,
      fileName: `${session.title} [AI].srt`,
      urlKey: session.url || undefined,
      offsetSec: 0,
      source: 'generated',
      cues: deduped,
    });

    await chrome.tabs
      .sendMessage(session.tabId, {
        type: 'APPLY_SUBTITLE_TRACK',
        track: savedTrack,
      } satisfies ExtensionMessage)
      .catch(() => {});

    // Send Chrome desktop notification so the user knows subtitles are ready even from another tab!
    if (chrome.notifications?.create) {
      const notifId = `kotostream_ready_${Date.now()}`;
      notificationTabMap.set(notifId, session.tabId);
      chrome.notifications.create(notifId, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'KotoStream — Subtitles Ready!',
        message: `${session.title}: ${deduped.length} Japanese lines pre-created. Click to jump back and watch!`,
        priority: 2,
      });
    }

    broadcastCaptureState({ status: 'buffering', tabId: session.tabId });
  } else {
    const errMsg =
      session.lastError ||
      'No Japanese speech was detected during the episode pre-scan. Check your OpenRouter API key and try again.';
    if (chrome.notifications?.create) {
      chrome.notifications.create(`kotostream_err_${Date.now()}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'KotoStream — Pre-Scan Finished',
        message: errMsg,
      });
    }
    broadcastCaptureState({ status: 'error', message: errMsg });
  }
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
        return startTabCapture(targetTabId, 'prescan', 4);
      }

      case 'START_AUDIO_BUFFER': {
        const targetTabId = message.tabId ?? sender.tab?.id;
        if (!targetTabId) {
          return { status: 'error', message: 'No active tab found to capture.' } satisfies CaptureState;
        }
        return startTabCapture(targetTabId, 'buffer_only');
      }

      case 'STOP_CAPTURE': {
        return stopTabCapture();
      }

      case 'GET_CAPTURE_STATE': {
        return { state: captureState, activeTabId: activeCaptureTabId };
      }

      case 'PRESCAN_VIDEO_STATUS': {
        const tabId = sender.tab?.id;
        if (tabId !== undefined) {
          handlePrescanVideoStatus(tabId, {
            currentTimeSec: message.currentTimeSec,
            durationSec: message.durationSec,
            playbackRate: message.playbackRate,
            playing: message.playing,
            ended: message.ended,
          });
        }
        return { ok: true };
      }

      case 'OFFSCREEN_PRESCAN_CHUNK': {
        enqueuePrescanChunk(message.tabId, {
          audioBase64: message.audioBase64,
          mimeType: message.mimeType,
          chunkStartSec: message.chunkStartSec,
          chunkEndSec: message.chunkEndSec,
          chunkIndex: message.chunkIndex,
        });
        return { ok: true };
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

      case 'TOKENIZE_TEXT': {
        try {
          const morphemes = await analyzeWithMeCab(message.text);
          return { morphemes };
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'MeCab tokenization failed' };
        }
      }

      case 'TRANSLATE_SENTENCE': {
        try {
          const settings = await getSettings();
          const result = await translateJapaneseSentence(message.sentence, settings, {
            targetWord: message.targetWord,
            contextBefore: message.contextBefore,
            contextAfter: message.contextAfter,
            showTitle: message.showTitle,
          });
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

      case 'VIDEO_TIME_SYNC': {
        const tabId = sender.tab?.id;
        if (tabId !== undefined && activeCaptureTabId === tabId) {
          void chrome.runtime
            .sendMessage({
              type: 'OFFSCREEN_VIDEO_SYNC',
              tabId,
              currentTimeSec: message.currentTimeSec,
              playing: message.playing,
              playbackRate: message.playbackRate,
              sentAtMs: message.sentAtMs,
              seeked: message.seeked,
            } satisfies ExtensionMessage)
            .catch(() => {});
        }
        return { ok: true };
      }

      case 'SET_CLIP_CAPTURE_MODE': {
        const tabId = sender.tab?.id;
        if (tabId !== undefined && activeCaptureTabId === tabId) {
          try {
            await chrome.runtime.sendMessage({
              type: 'OFFSCREEN_SET_CLIP_CAPTURE_MODE',
              tabId,
              active: message.active,
              playbackRate: message.playbackRate,
              unpitched: message.unpitched,
              startNewSegment: message.startNewSegment,
            } satisfies ExtensionMessage);
          } catch {
            // ignore
          }
        }
        return { ok: true };
      }

      case 'REQUEST_RECENT_AUDIO': {
        try {
          const res = await chrome.runtime.sendMessage({
            type: 'OFFSCREEN_GET_RECENT_AUDIO',
            durationMs: message.durationMs,
            startTimeSec: message.startTimeSec,
            endTimeSec: message.endTimeSec,
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
