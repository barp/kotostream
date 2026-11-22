import { selectPrimaryVideo, type SiteAdapter } from './base';

export const genericAdapter: SiteAdapter = {
  id: 'generic',
  displayName: 'Video Player',

  matches(): boolean {
    return true;
  },

  findVideo(): HTMLVideoElement | null {
    return selectPrimaryVideo(Array.from(document.querySelectorAll('video')));
  },

  findOverlayContainer(video: HTMLVideoElement): HTMLElement {
    if (document.fullscreenElement instanceof HTMLElement) {
      return document.fullscreenElement;
    }
    return video.parentElement ?? document.body;
  },

  getMediaTitle(): string {
    return document.title.trim() || 'Video';
  },
};
