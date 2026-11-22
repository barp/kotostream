export interface SiteAdapter {
  readonly id: 'prime' | 'youtube' | 'netflix' | 'generic';
  readonly displayName: string;
  matches(url: URL): boolean;
  findVideo(): HTMLVideoElement | null;
  findOverlayContainer(video: HTMLVideoElement): HTMLElement;
  getMediaTitle(): string;
}

/**
 * Picks the most likely primary playback <video> element from a list of candidates.
 */
export function selectPrimaryVideo(videos: HTMLVideoElement[]): HTMLVideoElement | null {
  if (videos.length === 0) return null;

  const scored = videos
    .map((v) => {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      let score = area;
      if (!v.paused && !v.ended) score += 10_000_000;
      if (v.readyState >= 2) score += 2_000_000;
      if (v.src || v.currentSrc) score += 500_000;
      if (rect.width < 160 || rect.height < 90) score -= 5_000_000;
      return { v, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.v ?? null;
}
