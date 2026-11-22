import type { ExtensionMessage, SttSettings } from '../types';
import {
  TARGET_SAMPLE_RATE,
  encodeWav,
  resampleTo16k,
  trimSilencePcm,
  uint8ToBase64,
} from '../core/audio-dsp';

const RING_BUFFER_SECONDS = 15;
const RING_BUFFER_CAPACITY = TARGET_SAMPLE_RATE * RING_BUFFER_SECONDS;
const PRESCAN_CHUNK_EPISODE_SEC = 30;
const PRESCAN_MIN_RMS = 0.0018;

let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let processorNode: ScriptProcessorNode | null = null;
let passthroughGain: GainNode | null = null;
let muteGain: GainNode | null = null;

let currentTabId: number | null = null;
let currentSettings: SttSettings | null = null;
let captureMode: 'live_stt' | 'buffer_only' | 'prescan' = 'buffer_only';
let isCapturing = false;

// 15-second circular 16kHz mono PCM ring buffer for Migaku-style sentence audio mining
const ringBuffer = new Int16Array(RING_BUFFER_CAPACITY);
let ringWritePos = 0;
let ringFilledSamples = 0;

// Live STT chunk state
let pcmBuffers: Float32Array[] = [];
let chunkStartedAt = 0;
let speechDetectedInChunk = false;
let chunkFirstSpeechAt = 0;
let lastSpeechSeenAt = 0;
let previousChunkLastSpeechAt = 0;
let peakRmsInChunk = 0;
let silenceSince: number | null = null;

// High-speed silent episode pre-scan state
let prescanBuffers: Float32Array[] = [];
let prescanSampleCount = 0;
let prescanPeakRms = 0;
let prescanChunkStartSec: number | null = null;
let prescanLastVideoTimeSec = 0;
let prescanPlaybackRate = 4;
let prescanPlaying = false;
let prescanChunkIndex = 0;

function pushToRingBuffer(samples: Int16Array) {
  for (let i = 0; i < samples.length; i++) {
    ringBuffer[ringWritePos] = samples[i];
    ringWritePos = (ringWritePos + 1) % RING_BUFFER_CAPACITY;
  }
  ringFilledSamples = Math.min(RING_BUFFER_CAPACITY, ringFilledSamples + samples.length);
}

/**
 * Slices the most recent `durationMs` of spoken audio from the 15-second ring buffer,
 * trimming trailing pause silence (e.g. from auto-pause on hover) and leading silence
 * so the mined Anki audio clip starts and ends cleanly on the dialogue line.
 */
function sliceRecentAudioWav(requestedDurationMs = 4500): {
  audioBase64?: string;
  mimeType?: string;
  durationSec?: number;
} {
  if (ringFilledSamples < TARGET_SAMPLE_RATE * 0.3) {
    return {};
  }

  const clampedMs = Math.min(RING_BUFFER_SECONDS * 1000, Math.max(1500, requestedDurationMs));
  const lookbackSamples = Math.min(
    ringFilledSamples,
    Math.floor(((clampedMs + 2500) / 1000) * TARGET_SAMPLE_RATE)
  );

  const linear = new Int16Array(lookbackSamples);
  const startIdx = (ringWritePos - lookbackSamples + RING_BUFFER_CAPACITY) % RING_BUFFER_CAPACITY;
  for (let i = 0; i < lookbackSamples; i++) {
    linear[i] = ringBuffer[(startIdx + i) % RING_BUFFER_CAPACITY];
  }

  const silenceThreshold = 200;
  let speechEnd = linear.length - 1;
  while (speechEnd > 0 && Math.abs(linear[speechEnd]) < silenceThreshold) {
    speechEnd--;
  }

  if (speechEnd < TARGET_SAMPLE_RATE * 0.25) {
    return {};
  }

  const tailPad = Math.floor(TARGET_SAMPLE_RATE * 0.18);
  const clipEnd = Math.min(linear.length, speechEnd + tailPad);
  const desiredSamples = Math.floor((clampedMs / 1000) * TARGET_SAMPLE_RATE);
  const clipStart = Math.max(0, clipEnd - desiredSamples);

  const sliced = trimSilencePcm(linear.subarray(clipStart, clipEnd), 160);
  if (sliced.length < TARGET_SAMPLE_RATE * 0.25) {
    return {};
  }

  const wavBytes = encodeWav(sliced, TARGET_SAMPLE_RATE);
  return {
    audioBase64: uint8ToBase64(wavBytes),
    mimeType: 'audio/wav',
    durationSec: Math.round((sliced.length / TARGET_SAMPLE_RATE) * 10) / 10,
  };
}

function resetChunkState() {
  pcmBuffers = [];
  chunkStartedAt = Date.now();
  speechDetectedInChunk = false;
  chunkFirstSpeechAt = 0;
  peakRmsInChunk = 0;
  silenceSince = null;
}

function resetPrescanState(playbackRate = 4) {
  prescanBuffers = [];
  prescanSampleCount = 0;
  prescanPeakRms = 0;
  prescanChunkStartSec = null;
  prescanLastVideoTimeSec = 0;
  prescanPlaybackRate = Math.max(1, playbackRate);
  prescanPlaying = false;
  prescanChunkIndex = 0;
}

function flushPrescanChunk(overrideEndSec?: number) {
  if (!isCapturing || captureMode !== 'prescan' || currentTabId === null || !audioContext) return;
  if (prescanBuffers.length === 0 || prescanSampleCount === 0) return;

  const rate = Math.max(1, prescanPlaybackRate);
  const nominalEffectiveRate = audioContext.sampleRate / rate;
  const nominalDurationSec = prescanSampleCount / nominalEffectiveRate;
  const startSec = prescanChunkStartSec ?? Math.max(0, prescanLastVideoTimeSec - nominalDurationSec);
  const endSec =
    overrideEndSec !== undefined && overrideEndSec > startSec
      ? overrideEndSec
      : startSec + nominalDurationSec;

  const capturedBuffers = prescanBuffers;
  const peakRms = prescanPeakRms;
  const idx = prescanChunkIndex++;

  prescanBuffers = [];
  prescanSampleCount = 0;
  prescanPeakRms = 0;
  prescanChunkStartSec = endSec;

  // Skip near-silent chunks (< 0.4s or pure silence) to save API cost & prevent Whisper hallucinations
  if (nominalDurationSec < 0.4 || peakRms < PRESCAN_MIN_RMS) {
    return;
  }

  // Restore 1x speed & original pitch by resampling from (sampleRate / playbackRate) -> 16 kHz!
  const pcm16 = resampleTo16k(capturedBuffers, nominalEffectiveRate);
  if (pcm16.length < TARGET_SAMPLE_RATE * 0.3) return;

  const wavBytes = encodeWav(pcm16, TARGET_SAMPLE_RATE);
  const audioBase64 = uint8ToBase64(wavBytes);

  chrome.runtime
    .sendMessage({
      type: 'OFFSCREEN_PRESCAN_CHUNK',
      tabId: currentTabId,
      audioBase64,
      mimeType: 'audio/wav',
      chunkStartSec: startSec,
      chunkEndSec: endSec,
      chunkIndex: idx,
      rms: peakRms,
    } satisfies ExtensionMessage)
    .catch(() => {});
}

function flushChunkForLiveStt() {
  if (!isCapturing || captureMode !== 'live_stt' || currentTabId === null || !audioContext) return;

  const hadSpeech = speechDetectedInChunk;
  const rms = peakRmsInChunk;
  const durationMs = Date.now() - chunkStartedAt;
  const capturedBuffers = pcmBuffers;
  const sampleRate = audioContext.sampleRate;
  const silenceGapMs =
    hadSpeech && previousChunkLastSpeechAt > 0 && chunkFirstSpeechAt > 0
      ? Math.max(0, chunkFirstSpeechAt - previousChunkLastSpeechAt)
      : 0;

  if (hadSpeech && lastSpeechSeenAt > 0) {
    previousChunkLastSpeechAt = lastSpeechSeenAt;
  }

  resetChunkState();

  if (!hadSpeech || capturedBuffers.length === 0) return;

  const rawPcm16 = resampleTo16k(capturedBuffers, sampleRate);
  const pcm16 = trimSilencePcm(rawPcm16);
  if (pcm16.length < TARGET_SAMPLE_RATE * 0.25) return;

  const wavBytes = encodeWav(pcm16, TARGET_SAMPLE_RATE);
  const audioBase64 = uint8ToBase64(wavBytes);

  chrome.runtime
    .sendMessage({
      type: 'OFFSCREEN_AUDIO_CHUNK',
      tabId: currentTabId,
      audioBase64,
      mimeType: 'audio/wav',
      durationMs,
      rms,
      silenceGapMs,
    } satisfies ExtensionMessage)
    .catch(() => {});
}

async function startCapture(
  streamId: string,
  tabId: number,
  settings: SttSettings,
  mode: 'live_stt' | 'buffer_only' | 'prescan',
  playbackRate = 4
) {
  stopCapture();

  currentTabId = tabId;
  currentSettings = settings;
  captureMode = mode;

  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  } as unknown as MediaStreamConstraints;

  mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

  audioContext = new AudioContext();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(mediaStream);

  // Speaker passthrough gain:
  // - 0 during silent high-speed episode pre-scan (user hears NOTHING while it scans!)
  // - 1 during normal watching / buffer_only mode (user hears video normally)
  passthroughGain = audioContext.createGain();
  passthroughGain.gain.value = mode === 'prescan' ? 0 : 1;
  source.connect(passthroughGain);
  passthroughGain.connect(audioContext.destination);

  processorNode = audioContext.createScriptProcessor(2048, 2, 1);
  muteGain = audioContext.createGain();
  muteGain.gain.value = 0;

  resetChunkState();
  resetPrescanState(playbackRate);
  ringWritePos = 0;
  ringFilledSamples = 0;
  isCapturing = true;

  processorNode.onaudioprocess = (event) => {
    if (!isCapturing || !currentSettings || !audioContext) return;

    const left = event.inputBuffer.getChannelData(0);
    const right = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : null;

    const mono = new Float32Array(left.length);
    let sumSq = 0;
    for (let i = 0; i < left.length; i++) {
      const sample = right ? (left[i] + right[i]) * 0.5 : left[i];
      mono[i] = sample;
      sumSq += sample * sample;
    }

    const rms = Math.sqrt(sumSq / left.length);

    // High-speed silent episode pre-scan mode
    if (captureMode === 'prescan') {
      if (!prescanPlaying) return;

      if (prescanChunkStartSec === null) {
        prescanChunkStartSec = prescanLastVideoTimeSec;
      }

      prescanBuffers.push(mono);
      prescanSampleCount += mono.length;
      if (rms > prescanPeakRms) prescanPeakRms = rms;

      const effectiveRate = audioContext.sampleRate / Math.max(1, prescanPlaybackRate);
      const accumulatedEpisodeSec = prescanSampleCount / effectiveRate;

      if (accumulatedEpisodeSec >= PRESCAN_CHUNK_EPISODE_SEC) {
        flushPrescanChunk();
      }
      return;
    }

    // Normal mode: always feed the local 15-second PCM ring buffer for Migaku-style sentence audio mining
    const frame16k = resampleTo16k([mono], audioContext.sampleRate);
    pushToRingBuffer(frame16k);

    if (captureMode !== 'live_stt') return;

    pcmBuffers.push(mono);

    const now = Date.now();
    const elapsed = now - chunkStartedAt;
    const threshold = Math.min(0.02, Math.max(0.001, currentSettings.vadThreshold));

    if (rms >= threshold) {
      if (!speechDetectedInChunk) {
        chunkFirstSpeechAt = now;
      }
      speechDetectedInChunk = true;
      lastSpeechSeenAt = now;
      if (rms > peakRmsInChunk) peakRmsInChunk = rms;
      silenceSince = null;
    } else if (silenceSince === null) {
      silenceSince = now;
    }

    const silenceDuration = silenceSince ? now - silenceSince : 0;

    const shouldSplitOnPause =
      speechDetectedInChunk &&
      elapsed >= 650 &&
      silenceDuration >= currentSettings.silenceSplitMs;

    const shouldSplitOnMaxDuration = elapsed >= currentSettings.chunkDurationMs;

    if (shouldSplitOnPause || shouldSplitOnMaxDuration) {
      flushChunkForLiveStt();
    }
  };

  source.connect(processorNode);
  processorNode.connect(muteGain);
  muteGain.connect(audioContext.destination);
}

function setCaptureMode(mode: 'buffer_only' | 'prescan', playbackRate?: number) {
  if (!isCapturing) return;
  if (captureMode === 'prescan' && mode !== 'prescan') {
    flushPrescanChunk();
  }
  captureMode = mode;
  if (passthroughGain) {
    passthroughGain.gain.value = mode === 'prescan' ? 0 : 1;
  }
  if (mode === 'prescan') {
    resetPrescanState(playbackRate ?? 4);
  } else {
    // Clear ring buffer so high-speed audio never leaks into sentence audio mining
    ringWritePos = 0;
    ringFilledSamples = 0;
  }
}

function stopCapture() {
  isCapturing = false;

  if (processorNode) {
    processorNode.onaudioprocess = null;
    try {
      processorNode.disconnect();
    } catch {
      // ignore
    }
    processorNode = null;
  }

  if (passthroughGain) {
    try {
      passthroughGain.disconnect();
    } catch {
      // ignore
    }
    passthroughGain = null;
  }

  if (muteGain) {
    try {
      muteGain.disconnect();
    } catch {
      // ignore
    }
    muteGain = null;
  }

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
    mediaStream = null;
  }

  if (audioContext) {
    void audioContext.close().catch(() => {});
    audioContext = null;
  }

  resetChunkState();
  resetPrescanState();
  ringWritePos = 0;
  ringFilledSamples = 0;
  lastSpeechSeenAt = 0;
  previousChunkLastSpeechAt = 0;
  currentTabId = null;
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'OFFSCREEN_START_AUDIO') {
    startCapture(message.streamId, message.tabId, message.settings, message.mode, message.playbackRate)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (message.type === 'OFFSCREEN_SET_MODE') {
    setCaptureMode(message.mode, message.playbackRate);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'OFFSCREEN_PRESCAN_SYNC') {
    if (captureMode === 'prescan' && audioContext) {
      const nextRate = Math.max(1, message.playbackRate);
      const rateChanged = Math.abs(nextRate - prescanPlaybackRate) > 0.05;
      const effectiveRate = audioContext.sampleRate / Math.max(1, prescanPlaybackRate);
      const bufferedEpisodeSec = prescanSampleCount / effectiveRate;

      // Flush cleanly before a playbackRate change or buffering stall (if >= 3s buffered)
      if ((rateChanged && bufferedEpisodeSec >= 1) || (!message.playing && bufferedEpisodeSec >= 3)) {
        flushPrescanChunk(message.currentTimeSec);
      }

      prescanPlaybackRate = nextRate;
      prescanLastVideoTimeSec = message.currentTimeSec;
      prescanPlaying = message.playing;

      // If starting a fresh chunk after a pause/stall, lock its start time to the exact video.currentTime
      if (prescanSampleCount === 0) {
        prescanChunkStartSec = message.currentTimeSec;
      }

      if (message.flushNow) {
        flushPrescanChunk(message.currentTimeSec);
        prescanPlaying = false;
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'OFFSCREEN_STOP_AUDIO') {
    stopCapture();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'OFFSCREEN_UPDATE_SETTINGS') {
    currentSettings = message.settings;
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'OFFSCREEN_GET_RECENT_AUDIO') {
    sendResponse(sliceRecentAudioWav(message.durationMs));
    return false;
  }

  return false;
});
