import type { ExtensionMessage, SttSettings } from '../types';

const TARGET_SAMPLE_RATE = 16000;

let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let processorNode: ScriptProcessorNode | null = null;
let muteGain: GainNode | null = null;

let currentTabId: number | null = null;
let currentSettings: SttSettings | null = null;
let isCapturing = false;

let pcmBuffers: Float32Array[] = [];
let chunkStartedAt = 0;
let speechDetectedInChunk = false;
let chunkFirstSpeechAt = 0;
let lastSpeechSeenAt = 0;
let previousChunkLastSpeechAt = 0;
let peakRmsInChunk = 0;
let silenceSince: number | null = null;

// Rolling recent audio clip (WAV) for Anki sentence mining
let latestAudioClip: { audioBase64: string; mimeType: string; timestamp: number } | null = null;

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

/**
 * Trims leading and trailing near-silence from 16kHz PCM (keeping a 120ms safety pad)
 * so uploads are smaller and STT models transcribe noticeably faster.
 */
function trimSilencePcm(samples: Int16Array, thresholdAmp = 180): Int16Array {
  const pad = Math.floor(TARGET_SAMPLE_RATE * 0.12);
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

function flushChunkIfSpeech() {
  if (!isCapturing || currentTabId === null || !audioContext) return;

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
  const mimeType = 'audio/wav';

  latestAudioClip = {
    audioBase64,
    mimeType,
    timestamp: Date.now(),
  };

  chrome.runtime
    .sendMessage({
      type: 'OFFSCREEN_AUDIO_CHUNK',
      tabId: currentTabId,
      audioBase64,
      mimeType,
      durationMs,
      rms,
      silenceGapMs,
    } satisfies ExtensionMessage)
    .catch(() => {});
}

async function startCapture(streamId: string, tabId: number, settings: SttSettings) {
  stopCapture();

  currentTabId = tabId;
  currentSettings = settings;

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

  // Route captured audio directly back to speakers so the user hears the video normally!
  source.connect(audioContext.destination);

  // 2048-sample buffer (~42ms at 48kHz) for snappy VAD
  processorNode = audioContext.createScriptProcessor(2048, 2, 1);
  muteGain = audioContext.createGain();
  muteGain.gain.value = 0;

  resetChunkState();
  isCapturing = true;

  processorNode.onaudioprocess = (event) => {
    if (!isCapturing || !currentSettings) return;

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
      flushChunkIfSpeech();
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
  lastSpeechSeenAt = 0;
  previousChunkLastSpeechAt = 0;
  currentTabId = null;
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'OFFSCREEN_START_AUDIO') {
    startCapture(message.streamId, message.tabId, message.settings)
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
    sendResponse(latestAudioClip ?? {});
    return false;
  }

  return false;
});
