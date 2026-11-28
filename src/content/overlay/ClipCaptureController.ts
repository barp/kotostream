import type { CaptureState } from '../../types';
import { safeSendMessage } from './utils';

export interface AudioRangeRequest {
  startTimeSec?: number;
  endTimeSec?: number;
  durationMs: number;
}

export interface SentenceAudioResult {
  audioBase64?: string;
  mimeType?: string;
  durationSec?: number;
}

interface AudioCoverage {
  hasStart: boolean;
  hasEnd: boolean;
  coveredStartSec: number | null;
  coveredEndSec: number | null;
}

interface RecentAudioResp extends SentenceAudioResult {
  coverage?: AudioCoverage;
}

export interface ClipCaptureHost {
  getVideo: () => HTMLVideoElement | null;
  getCaptureState: () => CaptureState;
  emitVideoTimeSync: (force: boolean, seeked: boolean) => void;
  showToast: (msg: string) => void;
}

/**
 * Extracts exact sentence audio clips from the offscreen 60-second 48 kHz Stereo PCM ring buffer.
 * If the user paused mid-sentence or seeked directly to a cue, silently captures the missing audio
 * at native 1x speed (bit-for-bit identical quality) while speakers are muted.
 */
export class ClipCaptureController {
  private host: ClipCaptureHost;
  public isCapturingClip = false;

  constructor(host: ClipCaptureHost) {
    this.host = host;
  }

  public async fetchSentenceAudio(
    range: AudioRangeRequest,
    showProgressToast = true
  ): Promise<SentenceAudioResult | undefined> {
    const initial = await safeSendMessage<RecentAudioResp>({
      type: 'REQUEST_RECENT_AUDIO',
      durationMs: range.durationMs,
      startTimeSec: range.startTimeSec,
      endTimeSec: range.endTimeSec,
    });

    const captureState = this.host.getCaptureState();
    const isBuffering =
      captureState.status === 'buffering' ||
      captureState.status === 'listening' ||
      captureState.status === 'transcribing';

    const rangeKnown =
      range.startTimeSec !== undefined &&
      range.endTimeSec !== undefined &&
      range.endTimeSec > range.startTimeSec;

    const initialMatchesRange =
      !rangeKnown ||
      (Boolean(initial?.audioBase64) && Boolean(initial?.coverage?.hasStart && initial?.coverage?.hasEnd));

    // Instant 0ms return if buffer already covers the full sentence (or no cue timestamps exist)
    if (!isBuffering || !this.host.getVideo() || !rangeKnown || initialMatchesRange) {
      return initialMatchesRange ? initial : undefined;
    }

    if (this.isCapturingClip) {
      return initialMatchesRange ? initial : undefined;
    }

    const captured = await this.captureMissingSentenceAudio(
      range.startTimeSec!,
      range.endTimeSec!,
      range.durationMs,
      initial?.coverage,
      showProgressToast
    );
    return captured?.audioBase64 ? captured : initialMatchesRange ? initial : undefined;
  }

  private async captureMissingSentenceAudio(
    startTimeSec: number,
    endTimeSec: number,
    durationMs: number,
    coverage?: AudioCoverage,
    showProgressToast = true
  ): Promise<SentenceAudioResult | undefined> {
    const video = this.host.getVideo();
    if (!video) return undefined;

    const wasPaused = video.paused;
    const savedTime = video.currentTime;
    const savedRate = video.playbackRate || 1;
    const savedPreservesPitch = video.preservesPitch ?? true;

    const maxDuration =
      Number.isFinite(video.duration) && video.duration > 0 ? video.duration : endTimeSec + 0.35;
    const targetEndSec = Math.min(maxDuration, endTimeSec + 0.3);

    const canContinueWithoutSeek =
      Boolean(coverage?.hasStart) &&
      coverage?.coveredEndSec !== null &&
      coverage?.coveredEndSec !== undefined &&
      savedTime >= startTimeSec - 0.15 &&
      savedTime <= targetEndSec &&
      coverage.coveredEndSec >= savedTime - 0.65;

    const needSeek = !canContinueWithoutSeek;
    const captureStartSec = needSeek ? Math.max(0, startTimeSec - 0.25) : savedTime;
    const spanSec = Math.max(0.25, targetEndSec - captureStartSec);

    // Always capture at native 1x speed so the 48 kHz Stereo PCM matches the original audio bit-for-bit!
    const desiredRate = 1;

    this.isCapturingClip = true;
    if (showProgressToast) {
      this.host.showToast('Capturing full sentence audio…');
    }

    let result: SentenceAudioResult | undefined;

    try {
      await safeSendMessage({
        type: 'SET_CLIP_CAPTURE_MODE',
        active: true,
        playbackRate: desiredRate,
        unpitched: false,
        startNewSegment: needSeek,
      });

      if (needSeek) {
        const landed = await new Promise<boolean>((resolve) => {
          let settled = false;
          const nearTarget = () => Math.abs(video.currentTime - captureStartSec) < 0.9;
          const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            video.removeEventListener('seeked', onSeeked);
            window.clearInterval(pollId);
            window.clearTimeout(timeoutId);
            resolve(ok);
          };
          const onSeeked = () => finish(nearTarget());
          const pollId = window.setInterval(() => {
            if (nearTarget()) finish(true);
          }, 120);
          const timeoutId = window.setTimeout(() => finish(false), 3000);
          video.addEventListener('seeked', onSeeked);
          try {
            video.currentTime = captureStartSec;
          } catch {
            finish(false);
          }
        });

        if (!landed) {
          if (showProgressToast) {
            this.host.showToast('Could not jump back to the sentence start — audio skipped.');
          }
          return undefined;
        }
      }

      if (video.playbackRate !== 1) {
        try {
          video.playbackRate = 1;
        } catch {
          // ignore
        }
      }

      const actualRate = video.playbackRate || 1;
      const unpitched = actualRate > 1.05 && video.preservesPitch === false;

      if (Math.abs(actualRate - desiredRate) > 0.05 || unpitched) {
        await safeSendMessage({
          type: 'SET_CLIP_CAPTURE_MODE',
          active: true,
          playbackRate: actualRate,
          unpitched,
          startNewSegment: false,
        });
      }

      this.host.emitVideoTimeSync(true, needSeek);

      try {
        await video.play();
      } catch {
        return undefined;
      }

      this.host.emitVideoTimeSync(true, false);

      const timeoutMs = Math.min(12000, Math.max(3500, (spanSec / actualRate) * 1000 + 2500));

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearInterval(pollId);
          clearTimeout(timeoutId);
          video.removeEventListener('timeupdate', check);
          video.removeEventListener('ended', finish);
          resolve();
        };
        const check = () => {
          this.host.emitVideoTimeSync(false, false);
          if (video.currentTime >= targetEndSec || video.ended) {
            finish();
          }
        };
        video.addEventListener('timeupdate', check);
        video.addEventListener('ended', finish, { once: true });
        const pollId = window.setInterval(check, 40);
        const timeoutId = window.setTimeout(finish, timeoutMs);
      });

      // Pause at targetEndSec and wait ~180ms so Chrome's audio pipeline tail flushes into audioRing
      video.pause();
      this.host.emitVideoTimeSync(true, false);
      await new Promise<void>((r) => setTimeout(r, 180));

      const post = await safeSendMessage<RecentAudioResp>({
        type: 'REQUEST_RECENT_AUDIO',
        durationMs,
        startTimeSec,
        endTimeSec,
      });

      if (post?.audioBase64 && post.coverage?.hasStart && post.coverage?.hasEnd) {
        result = post;
      }
    } finally {
      try {
        video.playbackRate = savedRate;
        video.preservesPitch = savedPreservesPitch;
      } catch {
        // ignore
      }

      if (Math.abs(video.currentTime - savedTime) > 0.05) {
        try {
          video.currentTime = savedTime;
        } catch {
          // ignore
        }
      }

      await safeSendMessage({
        type: 'SET_CLIP_CAPTURE_MODE',
        active: false,
      });

      if (!wasPaused) {
        void video.play().catch(() => {});
      }

      this.isCapturingClip = false;
      this.host.emitVideoTimeSync(true, true);
    }

    return result;
  }
}
