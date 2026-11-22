export interface PrescanVideoStatus {
  currentTimeSec: number;
  durationSec: number;
  playbackRate: number;
  playing: boolean;
  ended: boolean;
}

interface SavedVideoState {
  video: HTMLVideoElement;
  originalTime: number;
  originalRate: number;
  originalPreservesPitch: boolean;
  originalMuted: boolean;
  originalVolume: number;
  targetRate: number;
  rateResetRetries: number;
  finished: boolean;
  timerId: number | null;
  cleanup: () => void;
}

let activePrescan: SavedVideoState | null = null;

function setPreservesPitch(video: HTMLVideoElement, value: boolean) {
  const v = video as HTMLVideoElement & {
    preservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
    mozPreservesPitch?: boolean;
  };
  try {
    v.preservesPitch = value;
  } catch {
    // ignore
  }
  try {
    v.webkitPreservesPitch = value;
  } catch {
    // ignore
  }
  try {
    v.mozPreservesPitch = value;
  } catch {
    // ignore
  }
}

function getPreservesPitch(video: HTMLVideoElement): boolean {
  const v = video as HTMLVideoElement & {
    preservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  return v.preservesPitch ?? v.webkitPreservesPitch ?? true;
}

/**
 * Sets the highest audio-preserving playbackRate supported by Chromium and the site player.
 * Note: Chromium's AudioRendererAlgorithm mutes audio above 4.0x, so 4.0x is the max
 * speed at which tabCapture receives full audio!
 */
function applyMaxSupportedRate(video: HTMLVideoElement, preferredMax = 4): number {
  const candidates = [Math.min(4, preferredMax), 3, 2, 1.5, 1];
  for (const rate of candidates) {
    try {
      video.playbackRate = rate;
      if (Math.abs(video.playbackRate - rate) < 0.05) {
        return video.playbackRate;
      }
    } catch {
      // Try next lower rate
    }
  }
  return Math.max(1, video.playbackRate || 1);
}

export async function startVideoPrescan(
  video: HTMLVideoElement,
  targetRate: number,
  onStatus: (status: PrescanVideoStatus) => void
): Promise<{ ok: true; durationSec: number; actualRate: number } | { ok: false; error: string }> {
  stopVideoPrescan(false);

  const durationSec = video.duration;
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return {
      ok: false,
      error: 'Video duration is not ready yet (or this is a live stream). Start playing the episode briefly and try again.',
    };
  }

  const originalTime = video.currentTime;
  const originalRate = video.playbackRate || 1;
  const originalPreservesPitch = getPreservesPitch(video);
  const originalMuted = video.muted;
  const originalVolume = video.volume;

  // Keep video unmuted at full volume so tabCapture receives crisp audio
  // (offscreen.ts mutes speaker passthrough to 0 so the user hears complete silence!)
  video.muted = false;
  video.volume = 1;
  // Disable pitch preservation so Chrome plays raw samples N-times faster without WSOLA artifacts;
  // offscreen.ts resamples from (sampleRate / playbackRate) back to 16kHz to restore 100% normal 1x speech!
  setPreservesPitch(video, false);

  const actualRate = applyMaxSupportedRate(video, targetRate);

  try {
    video.currentTime = 0;
  } catch {
    // ignore seek error
  }

  const emitStatus = (endedOverride = false) => {
    if (!activePrescan || activePrescan.finished) return;
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : durationSec;
    const cur = Math.min(dur, Math.max(0, video.currentTime));
    const ended = endedOverride || video.ended || (dur > 5 && cur >= dur - 0.35);
    const playing = !ended && !video.paused && video.readyState >= 3;

    if (ended) {
      activePrescan.finished = true;
      try {
        video.pause();
      } catch {
        // ignore
      }
    }

    onStatus({
      currentTimeSec: cur,
      durationSec: dur,
      playbackRate: Math.max(1, video.playbackRate || actualRate),
      playing,
      ended,
    });
  };

  const onTimeUpdate = () => emitStatus(false);
  const onPlaying = () => {
    setPreservesPitch(video, false);
    emitStatus(false);
  };
  const onWaiting = () => emitStatus(false);
  const onPause = () => emitStatus(false);
  const onEnded = () => emitStatus(true);
  const onRateChange = () => {
    if (!activePrescan || activePrescan.finished) return;
    // Some streaming players briefly reset playbackRate back to 1 on seek/play; re-apply our target speed
    if (video.playbackRate < activePrescan.targetRate - 0.1 && activePrescan.rateResetRetries < 5) {
      activePrescan.rateResetRetries++;
      setPreservesPitch(video, false);
      const reapplied = applyMaxSupportedRate(video, activePrescan.targetRate);
      activePrescan.targetRate = reapplied;
    }
    emitStatus(false);
  };

  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('playing', onPlaying);
  video.addEventListener('waiting', onWaiting);
  video.addEventListener('pause', onPause);
  video.addEventListener('ended', onEnded);
  video.addEventListener('ratechange', onRateChange);

  const timerId = window.setInterval(() => emitStatus(false), 500);

  activePrescan = {
    video,
    originalTime,
    originalRate,
    originalPreservesPitch,
    originalMuted,
    originalVolume,
    targetRate: actualRate,
    rateResetRetries: 0,
    finished: false,
    timerId,
    cleanup: () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('ratechange', onRateChange);
      if (timerId !== null) clearInterval(timerId);
    },
  };

  try {
    await video.play();
  } catch (err) {
    stopVideoPrescan(false);
    return {
      ok: false,
      error: `Could not auto-play video for pre-scan: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  emitStatus(false);
  return { ok: true, durationSec, actualRate: Math.max(1, video.playbackRate || actualRate) };
}

export function stopVideoPrescan(rewindToStart: boolean): void {
  if (!activePrescan) return;
  const state = activePrescan;
  activePrescan = null;

  state.cleanup();

  try {
    state.video.pause();
  } catch {
    // ignore
  }
  setPreservesPitch(state.video, state.originalPreservesPitch);
  try {
    state.video.playbackRate = state.originalRate || 1;
  } catch {
    // ignore
  }
  try {
    state.video.muted = state.originalMuted;
    state.video.volume = state.originalVolume;
  } catch {
    // ignore
  }
  try {
    state.video.currentTime = rewindToStart ? 0 : state.originalTime;
  } catch {
    // ignore
  }
}
