import { describe, expect, it } from 'vitest';
import { TARGET_SAMPLE_RATE, encodeWav, resampleTo16k } from '../src/core/audio-dsp';

describe('audio-dsp high-speed playback restoration', () => {
  it('restores 48kHz audio played at 4x (preservesPitch=false) to exact 1x 16kHz duration and pitch', () => {
    // 1 second of 440 Hz tone in episode time, played at 4x speed => 0.25s wall clock at 48kHz (12,000 samples)
    // At 4x with preservesPitch=false, a 440 Hz original tone appears at 1760 Hz in the 48kHz capture stream.
    const captureSampleRate = 48000;
    const playbackRate = 4;
    const wallClockSamples = captureSampleRate / playbackRate; // 12,000 samples = 1.0s of episode time
    const input = new Float32Array(wallClockSamples);
    for (let i = 0; i < wallClockSamples; i++) {
      // 440 cycles over the 1.0s episode segment
      input[i] = Math.sin((2 * Math.PI * 440 * i) / wallClockSamples) * 0.5;
    }

    const effectiveSampleRate = captureSampleRate / playbackRate; // 12,000 Hz
    const restored = resampleTo16k([input], effectiveSampleRate);

    // Restored 16kHz PCM should be exactly 1.0 second = 16,000 samples
    expect(restored.length).toBe(TARGET_SAMPLE_RATE);

    // Count positive-going zero crossings: a 440 Hz sine wave over 1.0s has ~440 crossings!
    let crossings = 0;
    for (let i = 1; i < restored.length; i++) {
      if (restored[i - 1] <= 0 && restored[i] > 0) crossings++;
    }
    expect(crossings).toBeGreaterThanOrEqual(438);
    expect(crossings).toBeLessThanOrEqual(442);
  });

  it('restores 44.1kHz audio played at 4x speed to exact 1x 16kHz duration', () => {
    const captureSampleRate = 44100;
    const playbackRate = 4;
    const episodeSec = 2;
    const wallClockSamples = Math.round((captureSampleRate / playbackRate) * episodeSec);
    const input = new Float32Array(wallClockSamples).fill(0.25);

    const restored = resampleTo16k([input], captureSampleRate / playbackRate);
    expect(Math.abs(restored.length - TARGET_SAMPLE_RATE * episodeSec)).toBeLessThanOrEqual(2);
    expect(restored[1000]).toBeGreaterThan(7000);
  });

  it('downsamples 48kHz audio at 2x speed (24kHz effective) to 16kHz', () => {
    const effectiveSampleRate = 24000;
    const input = new Float32Array(effectiveSampleRate).fill(-0.5); // 1.0s episode audio
    const restored = resampleTo16k([input], effectiveSampleRate);
    expect(restored.length).toBe(TARGET_SAMPLE_RATE);
    expect(restored[500]).toBeLessThan(-15000);
  });

  it('encodes a valid 16kHz mono PCM WAV header', () => {
    const samples = new Int16Array(1600);
    const wav = encodeWav(samples, TARGET_SAMPLE_RATE);
    expect(wav.byteLength).toBe(44 + samples.length * 2);
    const header = String.fromCharCode(...wav.slice(0, 4), ...wav.slice(8, 12));
    expect(header).toBe('RIFFWAVE');
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
  });
});
