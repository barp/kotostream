export const TARGET_SAMPLE_RATE = 16000;

/**
 * Resamples mono Float32 PCM buffers from `effectiveSampleRate` to 16 kHz Int16 PCM.
 *
 * Supports both:
 * - Downsampling (effectiveSampleRate > 16000, e.g. 48kHz @ 1x or 24kHz @ 2x) via box averaging
 * - Upsampling (effectiveSampleRate < 16000, e.g. 12kHz @ 4x or 11.025kHz @ 4x) via linear interpolation
 *
 * When a video plays at rate R with `preservesPitch = false`, passing
 * `effectiveSampleRate = audioContext.sampleRate / R` restores the audio to
 * 100% normal 1x speed and original pitch!
 */
export function resampleTo16k(buffers: Float32Array[], effectiveSampleRate: number): Int16Array {
  const totalLen = buffers.reduce((sum, b) => sum + b.length, 0);
  if (totalLen === 0 || effectiveSampleRate <= 0) {
    return new Int16Array(0);
  }

  const merged = new Float32Array(totalLen);
  let offset = 0;
  for (const b of buffers) {
    merged.set(b, offset);
    offset += b.length;
  }

  if (Math.abs(effectiveSampleRate - TARGET_SAMPLE_RATE) < 1) {
    const out = new Int16Array(merged.length);
    for (let i = 0; i < merged.length; i++) {
      const s = Math.max(-1, Math.min(1, merged[i]));
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return out;
  }

  const ratio = effectiveSampleRate / TARGET_SAMPLE_RATE;
  const outLength = Math.max(1, Math.round(merged.length / ratio));
  const out = new Int16Array(outLength);

  if (ratio > 1) {
    // Downsampling: average input samples in each output bucket
    for (let i = 0; i < outLength; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(merged.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      let count = 0;
      for (let j = start; j < end; j++) {
        sum += merged[j];
        count++;
      }
      const sample = count > 0 ? sum / count : merged[Math.min(start, merged.length - 1)] ?? 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    }
  } else {
    // Upsampling (e.g. 12kHz -> 16kHz at 4x speed): linear interpolation
    for (let i = 0; i < outLength; i++) {
      const srcPos = i * ratio;
      const idx0 = Math.min(merged.length - 1, Math.floor(srcPos));
      const idx1 = Math.min(merged.length - 1, idx0 + 1);
      const frac = srcPos - idx0;
      const sample = merged[idx0] * (1 - frac) + merged[idx1] * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    }
  }

  return out;
}

/**
 * Converts native-rate Float32 stereo (or mono) Web Audio buffers directly to interleaved Int16 PCM
 * with ZERO downsampling and ZERO mono fold-down, preserving 100% original studio audio quality.
 */
export function interleaveStereoToInt16(
  left: Float32Array,
  right: Float32Array | null
): Int16Array {
  const len = left.length;
  if (!right) {
    const out = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      const s = Math.max(-1, Math.min(1, left[i]));
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return out;
  }

  const out = new Int16Array(len * 2);
  for (let i = 0; i < len; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    out[i * 2] = l < 0 ? Math.round(l * 0x8000) : Math.round(l * 0x7fff);
    out[i * 2 + 1] = r < 0 ? Math.round(r * 0x8000) : Math.round(r * 0x7fff);
  }
  return out;
}

export function trimSilencePcm(
  samples: Int16Array,
  thresholdAmp = 180,
  sampleRate = TARGET_SAMPLE_RATE,
  numChannels = 1
): Int16Array {
  const channels = Math.max(1, numChannels);
  const totalFrames = Math.floor(samples.length / channels);
  if (totalFrames === 0) return samples;

  const padFrames = Math.floor(sampleRate * 0.14);
  let startFrame = 0;
  let endFrame = totalFrames - 1;

  const framePeak = (frameIdx: number): number => {
    const base = frameIdx * channels;
    let peak = 0;
    for (let c = 0; c < channels; c++) {
      const a = Math.abs(samples[base + c]);
      if (a > peak) peak = a;
    }
    return peak;
  };

  while (startFrame < endFrame && framePeak(startFrame) < thresholdAmp) startFrame++;
  while (endFrame > startFrame && framePeak(endFrame) < thresholdAmp) endFrame--;

  if (startFrame >= endFrame) return samples;
  const paddedStart = Math.max(0, startFrame - padFrames) * channels;
  const paddedEnd = Math.min(totalFrames, endFrame + 1 + padFrames) * channels;
  return samples.subarray(paddedStart, paddedEnd);
}

export function encodeWav(
  samples: Int16Array,
  sampleRate = TARGET_SAMPLE_RATE,
  numChannels = 1
): Uint8Array {
  const channels = Math.max(1, numChannels);
  const blockAlign = channels * 2;
  const byteRate = sampleRate * blockAlign;
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
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
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

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

interface AudioRingFrame {
  samples: Int16Array;
  startSec: number | null;
  endSec: number | null;
  segmentId: number;
}

export interface AudioRangeCoverage {
  hasStart: boolean;
  hasEnd: boolean;
  coveredStartSec: number | null;
  coveredEndSec: number | null;
}

/**
 * Timestamped rolling PCM ring buffer (16 kHz mono Int16) for Migaku-style sentence audio extraction.
 *
 * Each pushed audio frame carries its exact episode `[startSec, endSec]` so extracting audio for
 * a subtitle cue `[subStart, subEnd]` slices from the exact start of the sentence—even if the user
 * paused for 10+ seconds to read a dictionary entry or paused slightly after the line finished.
 */
export class TimestampedAudioRing {
  public readonly sampleRate: number;
  public readonly numChannels: number;
  private frames: AudioRingFrame[] = [];
  private totalSamples = 0;
  private maxSamples: number;
  private currentSegmentId = 0;
  private lastEndSec: number | null = null;

  constructor(maxDurationSec = 60, sampleRate = TARGET_SAMPLE_RATE, numChannels = 1) {
    this.sampleRate = sampleRate;
    this.numChannels = Math.max(1, numChannels);
    this.maxSamples = Math.max(
      sampleRate * this.numChannels,
      Math.floor(maxDurationSec * sampleRate) * this.numChannels
    );
  }

  public clear(): void {
    this.frames = [];
    this.totalSamples = 0;
    this.currentSegmentId = 0;
    this.lastEndSec = null;
  }

  public startNewSegment(): void {
    this.currentSegmentId++;
    this.lastEndSec = null;
  }

  public get lengthSamples(): number {
    return this.totalSamples;
  }

  public push(samples: Int16Array, startSec: number | null, endSec: number | null): void {
    if (samples.length === 0) return;

    // Detect seek/discontinuity so re-watched segments never concatenate with earlier passes
    if (startSec !== null && endSec !== null && this.lastEndSec !== null) {
      if (startSec < this.lastEndSec - 0.15 || startSec > this.lastEndSec + 1.5) {
        this.currentSegmentId++;
      }
    }

    if (endSec !== null) {
      this.lastEndSec = endSec;
    }

    this.frames.push({
      samples,
      startSec,
      endSec,
      segmentId: this.currentSegmentId,
    });
    this.totalSamples += samples.length;

    while (this.totalSamples > this.maxSamples && this.frames.length > 0) {
      const removed = this.frames.shift()!;
      this.totalSamples -= removed.samples.length;
    }
  }

  /**
   * Reports whether the most recent playback segment overlapping `[startSec, endSec]`
   * covers both the start and the end of the requested sentence.
   */
  public getCoverage(
    startSec: number,
    endSec: number,
    toleranceSec = 0.2
  ): AudioRangeCoverage {
    if (this.frames.length === 0 || !Number.isFinite(startSec) || !Number.isFinite(endSec)) {
      return { hasStart: false, hasEnd: false, coveredStartSec: null, coveredEndSec: null };
    }

    const winStart = Math.max(0, startSec - 0.25);
    const winEnd = Math.max(winStart + 0.5, endSec + 0.25);

    let targetSegmentId: number | null = null;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      if (f.startSec !== null && f.endSec !== null && f.endSec > winStart && f.startSec < winEnd) {
        targetSegmentId = f.segmentId;
        break;
      }
    }

    if (targetSegmentId === null) {
      return { hasStart: false, hasEnd: false, coveredStartSec: null, coveredEndSec: null };
    }

    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const f of this.frames) {
      if (f.segmentId !== targetSegmentId) continue;
      if (f.startSec === null || f.endSec === null) continue;
      if (f.startSec < minStart) minStart = f.startSec;
      if (f.endSec > maxEnd) maxEnd = f.endSec;
    }

    if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) {
      return { hasStart: false, hasEnd: false, coveredStartSec: null, coveredEndSec: null };
    }

    return {
      hasStart: minStart <= Math.max(0, startSec) + toleranceSec,
      hasEnd: maxEnd >= endSec - toleranceSec,
      coveredStartSec: minStart,
      coveredEndSec: maxEnd,
    };
  }

  /**
   * Slices audio covering `[startSec - padBeforeSec, endSec + padAfterSec]` from the most recent
   * playback segment that overlaps that window. Returns `null` if no overlapping timestamped audio
   * is available in the ring buffer.
   */
  public sliceByTimeRange(
    startSec: number,
    endSec: number,
    padBeforeSec = 0.25,
    padAfterSec = 0.25
  ): Int16Array | null {
    if (this.frames.length === 0 || !Number.isFinite(startSec) || !Number.isFinite(endSec)) {
      return null;
    }

    const winStart = Math.max(0, startSec - padBeforeSec);
    const winEnd = Math.max(winStart + 0.5, endSec + padAfterSec);

    // Find the most recent segmentId that overlaps [winStart, winEnd]
    let targetSegmentId: number | null = null;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      if (f.startSec !== null && f.endSec !== null && f.endSec > winStart && f.startSec < winEnd) {
        targetSegmentId = f.segmentId;
        break;
      }
    }
    if (targetSegmentId === null) return null;

    const slices: Int16Array[] = [];
    let outLen = 0;

    for (const f of this.frames) {
      if (f.segmentId !== targetSegmentId) continue;
      if (f.startSec === null || f.endSec === null) continue;
      if (f.endSec <= winStart || f.startSec >= winEnd) continue;

      const frameDur = f.endSec - f.startSec;
      if (frameDur <= 0) continue;

      const relStart = Math.max(0, (winStart - f.startSec) / frameDur);
      const relEnd = Math.min(1, (winEnd - f.startSec) / frameDur);
      const numFrames = Math.floor(f.samples.length / this.numChannels);
      const f0 = Math.max(0, Math.min(numFrames, Math.floor(relStart * numFrames)));
      const f1 = Math.max(f0, Math.min(numFrames, Math.ceil(relEnd * numFrames)));
      const s0 = f0 * this.numChannels;
      const s1 = f1 * this.numChannels;
      if (s1 > s0) {
        const sub = f.samples.subarray(s0, s1);
        slices.push(sub);
        outLen += sub.length;
      }
    }

    if (outLen < this.sampleRate * this.numChannels * 0.25) return null;

    const merged = new Int16Array(outLen);
    let offset = 0;
    for (const sub of slices) {
      merged.set(sub, offset);
      offset += sub.length;
    }

    // Only trim pure digital silence at the outer edges so we never cut off the first syllable
    return trimSilencePcm(merged, 80, this.sampleRate, this.numChannels);
  }

  /**
   * Fallback when subtitle timestamps aren't available: scans across the entire buffered history
   * to find the end of the last spoken audio and slices `requestedDurationMs` ending there.
   */
  public sliceRecent(requestedDurationMs = 4500): Int16Array | null {
    const samplesPerSec = this.sampleRate * this.numChannels;
    if (this.totalSamples < samplesPerSec * 0.3) {
      return null;
    }

    const linear = new Int16Array(this.totalSamples);
    let offset = 0;
    for (const f of this.frames) {
      linear.set(f.samples, offset);
      offset += f.samples.length;
    }

    const silenceThreshold = 200;
    const totalFrames = Math.floor(linear.length / this.numChannels);
    let speechEndFrame = totalFrames - 1;
    while (speechEndFrame > 0) {
      const base = speechEndFrame * this.numChannels;
      let peak = 0;
      for (let c = 0; c < this.numChannels; c++) {
        const a = Math.abs(linear[base + c]);
        if (a > peak) peak = a;
      }
      if (peak >= silenceThreshold) break;
      speechEndFrame--;
    }

    if (speechEndFrame < this.sampleRate * 0.25) {
      return null;
    }

    const clampedMs = Math.min(60000, Math.max(1500, requestedDurationMs));
    const tailPadFrames = Math.floor(this.sampleRate * 0.18);
    const clipEndFrame = Math.min(totalFrames, speechEndFrame + 1 + tailPadFrames);
    const desiredFrames = Math.floor((clampedMs / 1000) * this.sampleRate);
    const clipStartFrame = Math.max(0, clipEndFrame - desiredFrames);

    const sliced = trimSilencePcm(
      linear.subarray(clipStartFrame * this.numChannels, clipEndFrame * this.numChannels),
      120,
      this.sampleRate,
      this.numChannels
    );
    if (sliced.length < samplesPerSec * 0.25) {
      return null;
    }
    return sliced;
  }
}
