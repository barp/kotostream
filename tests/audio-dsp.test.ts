import { describe, expect, it } from 'vitest';
import {
  TARGET_SAMPLE_RATE,
  TimestampedAudioRing,
  encodeWav,
  interleaveStereoToInt16,
  resampleTo16k,
} from '../src/core/audio-dsp';

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

describe('TimestampedAudioRing exact sentence extraction', () => {
  function pushTaggedAudio(
    ring: TimestampedAudioRing,
    startSec: number,
    endSec: number,
    amplitude: number,
    stepSec = 0.05
  ) {
    const samplesPerStep = Math.round(TARGET_SAMPLE_RATE * stepSec);
    for (let t = startSec; t < endSec - 1e-6; t += stepSec) {
      const nextT = Math.min(endSec, t + stepSec);
      const count = Math.max(1, Math.round((nextT - t) * TARGET_SAMPLE_RATE));
      const frame = new Int16Array(count).fill(amplitude);
      ring.push(frame, t, nextT);
    }
    void samplesPerStep;
  }

  it('extracts from the exact start of the sentence even when video kept playing past endTimeSec', () => {
    const ring = new TimestampedAudioRing(60);
    // Previous line [6.0, 9.5]: amplitude 1000
    pushTaggedAudio(ring, 6.0, 9.5, 1000);
    // Gap [9.5, 10.0]: silence
    pushTaggedAudio(ring, 9.5, 10.0, 0);
    // Target sentence [10.0, 13.0]: start marker 4000 for first 0.5s, body 5000
    pushTaggedAudio(ring, 10.0, 10.5, 4000);
    pushTaggedAudio(ring, 10.5, 13.0, 5000);
    // User didn't pause until 15.5s (next line/BGM playing at amplitude 9000)
    pushTaggedAudio(ring, 13.0, 15.5, 9000);

    const extracted = ring.sliceByTimeRange(10.0, 13.0, 0.2, 0.2);
    expect(extracted).not.toBeNull();
    // Should cover ~[9.8, 13.2] -> ~3.4s (with leading silence trimmed up to ~10.0 - 0.14s pad)
    // Crucially: must contain the start marker (4000) at the beginning, NOT skip to 12.0s!
    expect(extracted!.some((s) => s === 4000)).toBe(true);
    expect(extracted!.some((s) => s === 5000)).toBe(true);
    // Duration should be around 3.0-3.5s, not shifted into [12.0, 15.5]
    const durSec = extracted!.length / TARGET_SAMPLE_RATE;
    expect(durSec).toBeGreaterThanOrEqual(3.0);
    expect(durSec).toBeLessThanOrEqual(3.6);
  });

  it('extracts from the exact start of the sentence even when paused mid-sentence', () => {
    const ring = new TimestampedAudioRing(60);
    pushTaggedAudio(ring, 5.0, 9.8, 1000);
    // Target sentence starts at 10.0, user pauses at 11.4 (before 13.5 end)
    pushTaggedAudio(ring, 10.0, 10.4, 4000);
    pushTaggedAudio(ring, 10.4, 11.4, 5000);

    const extracted = ring.sliceByTimeRange(10.0, 13.5, 0.15, 0.15);
    expect(extracted).not.toBeNull();
    expect(extracted![Math.floor(TARGET_SAMPLE_RATE * 0.25)]).toBe(4000);
    const durSec = extracted!.length / TARGET_SAMPLE_RATE;
    expect(durSec).toBeGreaterThanOrEqual(1.3);
    expect(durSec).toBeLessThanOrEqual(1.7);
  });

  it('uses only the latest playback pass after a rewind/seek', () => {
    const ring = new TimestampedAudioRing(60);
    // First pass: [10.0, 12.0] with amplitude 3000
    pushTaggedAudio(ring, 10.0, 12.0, 3000);
    // User rewinds to 9.8s and plays again with amplitude 7000
    pushTaggedAudio(ring, 9.8, 12.2, 7000);

    const extracted = ring.sliceByTimeRange(10.0, 12.0, 0.1, 0.1);
    expect(extracted).not.toBeNull();
    expect(extracted!.every((s) => s === 7000)).toBe(true);
    const durSec = extracted!.length / TARGET_SAMPLE_RATE;
    expect(durSec).toBeGreaterThanOrEqual(2.0);
    expect(durSec).toBeLessThanOrEqual(2.3);
  });

  it('reports incomplete coverage when paused mid-sentence and stitches seamlessly once finished', () => {
    const ring = new TimestampedAudioRing(60);
    // User watched up to 11.4s of a [10.0, 13.5] sentence and paused
    pushTaggedAudio(ring, 10.0, 11.4, 4000);

    const before = ring.getCoverage(10.0, 13.5);
    expect(before.hasStart).toBe(true);
    expect(before.hasEnd).toBe(false);
    expect(before.coveredEndSec).toBeCloseTo(11.4, 1);

    // Silent on-demand capture continues from 11.4s to 13.8s
    pushTaggedAudio(ring, 11.4, 13.8, 5000);

    const after = ring.getCoverage(10.0, 13.5);
    expect(after.hasStart).toBe(true);
    expect(after.hasEnd).toBe(true);

    const extracted = ring.sliceByTimeRange(10.0, 13.5, 0.2, 0.2);
    expect(extracted).not.toBeNull();
    expect(extracted!.some((s) => s === 4000)).toBe(true);
    expect(extracted!.some((s) => s === 5000)).toBe(true);
    const durSec = extracted!.length / TARGET_SAMPLE_RATE;
    expect(durSec).toBeGreaterThanOrEqual(3.5);
    expect(durSec).toBeLessThanOrEqual(3.9);
  });

  it('startNewSegment isolates a fresh backward seek even for small (<0.5s) rewinds', () => {
    const ring = new TimestampedAudioRing(60);
    pushTaggedAudio(ring, 10.0, 10.3, 2000);
    ring.startNewSegment();
    pushTaggedAudio(ring, 9.8, 12.2, 8000);

    const extracted = ring.sliceByTimeRange(10.0, 12.0, 0.1, 0.1);
    expect(extracted).not.toBeNull();
    expect(extracted!.every((s) => s === 8000)).toBe(true);
  });

  it('preserves native 48 kHz stereo L/R channel alignment through TimestampedAudioRing and encodeWav', () => {
    const sampleRate = 48000;
    const ring = new TimestampedAudioRing(10, sampleRate, 2);
    const stepSec = 0.05;
    const framesPerStep = Math.round(sampleRate * stepSec);

    // Push 2 seconds of 48 kHz stereo where Left = +0.5 (~16384) and Right = -0.25 (~-8192)
    for (let t = 5.0; t < 7.0 - 1e-6; t += stepSec) {
      const left = new Float32Array(framesPerStep).fill(0.5);
      const right = new Float32Array(framesPerStep).fill(-0.25);
      const interleaved = interleaveStereoToInt16(left, right);
      ring.push(interleaved, t, t + stepSec);
    }

    const sliced = ring.sliceByTimeRange(5.3, 6.4, 0.1, 0.1);
    expect(sliced).not.toBeNull();
    // Must be even length (stereo L/R pairs) and preserve L > 0, R < 0 on every frame!
    expect(sliced!.length % 2).toBe(0);
    for (let i = 0; i < sliced!.length; i += 2) {
      expect(sliced![i]).toBeGreaterThan(15000);
      expect(sliced![i + 1]).toBeLessThan(-7000);
    }

    const wav = encodeWav(sliced!, sampleRate, 2);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint16(22, true)).toBe(2); // 2 channels (stereo)
    expect(view.getUint32(24, true)).toBe(48000); // 48 kHz
    expect(view.getUint32(28, true)).toBe(48000 * 4); // byteRate = 192000
    expect(view.getUint16(32, true)).toBe(4); // blockAlign = 4 bytes/frame
  });

  it('fallback sliceRecent scans past long pause silence without cutting off the sentence start', () => {
    const ring = new TimestampedAudioRing(60);
    // 3-second sentence (amplitude 6000) followed by 8 seconds of silence
    pushTaggedAudio(ring, 0, 3.0, 6000);
    pushTaggedAudio(ring, 3.0, 11.0, 0);

    const extracted = ring.sliceRecent(3000);
    expect(extracted).not.toBeNull();
    const durSec = extracted!.length / TARGET_SAMPLE_RATE;
    expect(durSec).toBeGreaterThanOrEqual(2.8);
    expect(durSec).toBeLessThanOrEqual(3.3);
  });

  it('never substitutes recent speech for a cue window the ring does not cover (backward seek mining)', () => {
    const ring = new TimestampedAudioRing(60);
    // The user watched 300.0-304.0 (amplitude 7000), then seeked BACK via the subtitle
    // panel to an older line at 120.0-124.0 that has NOT re-played yet.
    pushTaggedAudio(ring, 300.0, 304.0, 7000);

    // Coverage for the old line must be reported as missing…
    const coverage = ring.getCoverage(120.0, 124.0, 0.2);
    expect(coverage.hasStart).toBe(false);
    expect(coverage.hasEnd).toBe(false);

    // …and the exact-range slice must return NOTHING (the caller re-captures the sentence)
    // rather than audio of whatever was playing near the playhead (amplitude 7000)!
    const extracted = ring.sliceByTimeRange(120.0, 124.0, 0.25, 0.25);
    expect(extracted).toBeNull();

    // Once the old line re-plays (after the silent re-capture), coverage completes and the
    // slice returns the fresh pass — never stale audio from the other position.
    ring.startNewSegment();
    pushTaggedAudio(ring, 119.75, 124.3, 3000);
    const recovered = ring.sliceByTimeRange(120.0, 124.0, 0.25, 0.25);
    expect(recovered).not.toBeNull();
    expect(recovered!.some((s) => Math.abs(s) === 3000)).toBe(true);
    expect(recovered!.some((s) => Math.abs(s) === 7000)).toBe(false);
    const recoveredCoverage = ring.getCoverage(120.0, 124.0, 0.2);
    expect(recoveredCoverage.hasStart).toBe(true);
    expect(recoveredCoverage.hasEnd).toBe(true);
  });
});
