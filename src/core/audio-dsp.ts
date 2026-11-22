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

export function trimSilencePcm(samples: Int16Array, thresholdAmp = 180): Int16Array {
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

export function encodeWav(samples: Int16Array, sampleRate = TARGET_SAMPLE_RATE): Uint8Array {
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

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
