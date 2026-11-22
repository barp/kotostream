import type { ExtensionMessage, SttSettings } from '../types';

const TARGET_SAMPLE_RATE = 16000;
const RING_BUFFER_SECONDS = 15;
const RING_BUFFER_CAPACITY = TARGET_SAMPLE_RATE * RING_BUFFER_SECONDS;

let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let processorNode: ScriptProcessorNode | null = null;
let muteGain: GainNode | null = null;

let currentTabId: number | null = null;
let currentSettings: SttSettings | null = null;
let captureMode: 'live_stt' | 'buffer_only' = 'buffer_only';
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

  // Read up to requestedDurationMs + 2.5s extra lookback in case the video was paused on hover
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

  // Find the end of actual spoken audio (strip trailing silence after auto-pause)
  const silenceThreshold = 200;
  let speechEnd = linear.length - 1;
  while (speechEnd > 0 && Math.abs(linear[speechEnd]) < silenceThreshold) {
    speechEnd--;
  }

  if (speechEnd < TARGET_SAMPLE_RATE * 0.25) {
    return {}; // Ring buffer is all silence
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

function downsampleTo16k(buffers: Float32Array[], inputSampleRate: number): Int16Array {
  const totalLen = buffers.reduce((sum, b) => sum + b.length, 0);
  const merged = new Float32Array(totalLen);
  let offset = 0;
  for (const b of buffers) {
    merged.set(b, offset);
    offset += b.length;
  }

  if (inputSampleRate === TARGET_SAMPLE_RATE) {
    const out = new Int16Array(merged.length);
    for (let i = 0; i < merged.length; i++) {
      const s = Math.max(-1, Math.min(1, merged[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outLength = Math.max(1, Math.floor(merged.length / ratio));
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(merged.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += merged[j];
      count++;
    }
    const sample = count > 0 ? sum / count : merged[start] ?? 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  return out;
}

function trimSilencePcm(samples: Int16Array, thresholdAmp = 180): Int16Array {
  const pad = Math.floor(TARGET_SAMPLE_RATE * 0.14);
  let start = 0;
  let end = samples.length - 1;

  while (start < end && Math.abs(samples[start]) < thresholdAmp) start++;
  while (end > start && Math.abs(samples[end]) < thresholdAmp) end--;

  if (start >= end) return samples;
  const paddedStart = Math.max(0, start - pad);
  const paddedEnd = Math.min(samples.length, end + pad);
  return samples.subarray(paddedStart, paddedEnd);
}

function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (pos: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(pos + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let pos = 44;
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(pos, samples[i], true);
    pos += 2;
  }

  return new Uint8Array(buffer);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function resetChunkState() {
  pcmBuffers = [];
  chunkStartedAt = Date.now();
  speechDetectedInChunk = false;
  chunkFirstSpeechAt = 0;
  peakRmsInChunk = 0;
  silenceSince = null;
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

  const rawPcm16 = downsampleTo16k(capturedBuffers, sampleRate);
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
  mode: 'live_stt' | 'buffer_only'
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

  // Route captured audio directly back to speakers so the user hears Amazon Prime / video normally!
  source.connect(audioContext.destination);

  processorNode = audioContext.createScriptProcessor(2048, 2, 1);
  muteGain = audioContext.createGain();
  muteGain.gain.value = 0;

  resetChunkState();
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

    // Always feed the local 15-second PCM ring buffer for Migaku-style sentence audio mining
    const frame16k = downsampleTo16k([mono], audioContext.sampleRate);
    pushToRingBuffer(frame16k);

    if (captureMode !== 'live_stt') return;

    const rms = Math.sqrt(sumSq / left.length);
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
  ringWritePos = 0;
  ringFilledSamples = 0;
  lastSpeechSeenAt = 0;
  previousChunkLastSpeechAt = 0;
  currentTabId = null;
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'OFFSCREEN_START_AUDIO') {
    startCapture(message.streamId, message.tabId, message.settings, message.mode)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
    return true;
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
