import type { ExtensionMessage, SubtitleLine } from '../types';
import { TARGET_SAMPLE_RATE, encodeWav, uint8ToBase64 } from './audio-dsp';

const CHUNK_DURATION_SEC = 25;

/**
 * Decodes an uploaded audio/video file in the browser, slices it into 25-second 16kHz mono WAV
 * chunks, and batch-transcribes them at highest quality via OpenRouter with exact video timestamps.
 */
export async function preTranscribeMediaFile(
  file: File,
  onProgress?: (done: number, total: number) => void
): Promise<SubtitleLine[]> {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    await audioCtx.close().catch(() => {});
  }

  const pcm16 = audioBufferTo16kMono(decoded);
  const samplesPerChunk = TARGET_SAMPLE_RATE * CHUNK_DURATION_SEC;
  const totalChunks = Math.max(1, Math.ceil(pcm16.length / samplesPerChunk));

  const allCues: SubtitleLine[] = [];

  for (let i = 0; i < totalChunks; i++) {
    onProgress?.(i, totalChunks);
    const startSample = i * samplesPerChunk;
    const endSample = Math.min(pcm16.length, startSample + samplesPerChunk);
    const slice = pcm16.subarray(startSample, endSample);
    const chunkOffsetSec = startSample / TARGET_SAMPLE_RATE;

    // Skip completely silent chunks
    if (isSilentPcm(slice)) continue;

    const wavBytes = encodeWav(slice, TARGET_SAMPLE_RATE);
    const audioBase64 = uint8ToBase64(wavBytes);

    const res = (await chrome.runtime.sendMessage({
      type: 'BATCH_TRANSCRIBE_CHUNK',
      audioBase64,
      mimeType: 'audio/wav',
      chunkOffsetSec,
    } satisfies ExtensionMessage)) as { cues?: SubtitleLine[]; error?: string };

    if (res?.error) {
      throw new Error(res.error);
    }

    if (res?.cues && res.cues.length > 0) {
      allCues.push(...res.cues);
    }
  }

  onProgress?.(totalChunks, totalChunks);
  return allCues.sort((a, b) => (a.videoTimeSec ?? 0) - (b.videoTimeSec ?? 0));
}

function audioBufferTo16kMono(buffer: AudioBuffer): Int16Array {
  const numChannels = buffer.numberOfChannels;
  const length = buffer.length;
  const mono = new Float32Array(length);

  for (let ch = 0; ch < numChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += data[i] / numChannels;
    }
  }

  const ratio = buffer.sampleRate / TARGET_SAMPLE_RATE;
  const outLength = Math.max(1, Math.floor(length / ratio));
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += mono[j];
      count++;
    }
    const sample = count > 0 ? sum / count : mono[start] ?? 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  return out;
}

function isSilentPcm(samples: Int16Array): boolean {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 16) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
    if (peak > 220) return false;
  }
  return true;
}
