import { selectPrimaryVideo, type SiteAdapter } from './base';

export const youtubeAdapter: SiteAdapter = {
  id: 'youtube',
  displayName: 'YouTube',

  matches(url: URL): boolean {
    return url.hostname.toLowerCase().includes('youtube.com');
  },

  findVideo(): HTMLVideoElement | null {
    const main = document.querySelector<HTMLVideoElement>('video.html5-main-video');
    if (main) return main;
    return selectPrimaryVideo(Array.from(document.querySelectorAll('video')));
  },

  findOverlayContainer(video: HTMLVideoElement): HTMLElement {
    if (document.fullscreenElement instanceof HTMLElement) {
      return document.fullscreenElement;
    }
    return (
      document.querySelector<HTMLElement>('.html5-video-player') ??
      video.parentElement ??
      document.body
    );
  },

  getMediaTitle(): string {
    const h1 = document.querySelector<HTMLElement>('h1.ytd-watch-metadata yt-formatted-string');
    return h1?.textContent?.trim() || document.title.replace(/\s*-\s*YouTube$/, '').trim() || 'YouTube';
  },
};
