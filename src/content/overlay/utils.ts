import type { ExtensionMessage } from '../../types';
import { escapeHtml } from '../../core/html';

export { escapeHtml };

export function safeSendMessage<T = unknown>(message: ExtensionMessage): Promise<T | undefined> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
    return Promise.resolve(undefined);
  }
  try {
    return chrome.runtime.sendMessage(message).catch(() => undefined) as Promise<T | undefined>;
  } catch {
    return Promise.resolve(undefined);
  }
}

export function formatSeconds(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

let activeAudioStopper: (() => void) | null = null;

/**
 * Plays a base64 audio clip using Web Audio API (immune to Amazon Prime / Netflix media-src CSP!).
 * Stops any previously playing preview clip so rapid clicks never stack audio.
 */
export async function playBase64Audio(base64: string, mimeType = 'audio/wav'): Promise<void> {
  if (activeAudioStopper) {
    activeAudioStopper();
    activeAudioStopper = null;
  }

  try {
    const ctx = new AudioContext();
    const arrayBuffer = base64ToArrayBuffer(base64);
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        source.stop();
      } catch {
        // ignore if already stopped
      }
      void ctx.close().catch(() => {});
    };

    activeAudioStopper = stop;
    source.onended = () => {
      if (activeAudioStopper === stop) activeAudioStopper = null;
      stopped = true;
      void ctx.close().catch(() => {});
    };
    source.start(0);
  } catch {
    // Fallback to Blob URL Audio element
    const blob = new Blob([base64ToArrayBuffer(base64)], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const stop = () => {
      audio.pause();
      URL.revokeObjectURL(url);
    };
    activeAudioStopper = stop;
    audio.onended = () => {
      if (activeAudioStopper === stop) activeAudioStopper = null;
      URL.revokeObjectURL(url);
    };
    await audio.play().catch(() => {
      URL.revokeObjectURL(url);
    });
  }
}
