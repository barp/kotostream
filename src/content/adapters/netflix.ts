import { selectPrimaryVideo, type SiteAdapter } from './base';

export const netflixAdapter: SiteAdapter = {
  id: 'netflix',
  displayName: 'Netflix',

  matches(url: URL): boolean {
    return url.hostname.toLowerCase().includes('netflix.com');
  },

  findVideo(): HTMLVideoElement | null {
    return selectPrimaryVideo(Array.from(document.querySelectorAll('video')));
  },

  findOverlayContainer(video: HTMLVideoElement): HTMLElement {
    if (document.fullscreenElement instanceof HTMLElement) {
      return document.fullscreenElement;
    }
    return (
      document.querySelector<HTMLElement>('.watch-video, .NFPlayer') ??
      video.parentElement ??
      document.body
    );
  },

  getMediaTitle(): string {
    const title = document.querySelector<HTMLElement>('[data-uia="video-title"]');
    return title?.textContent?.trim() || document.title.replace(/\s*-\s*Netflix$/, '').trim() || 'Netflix';
  },
};
