import { selectPrimaryVideo, type SiteAdapter } from './base';

export const primeVideoAdapter: SiteAdapter = {
  id: 'prime',
  displayName: 'Amazon Prime Video',

  matches(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    if (host.includes('primevideo.com')) return true;
    if (host.includes('amazon.')) {
      return (
        url.pathname.includes('/gp/video') ||
        url.pathname.includes('/video/') ||
        Boolean(document.querySelector('#dv-web-player, .webPlayerSDKContainer'))
      );
    }
    return false;
  },

  findVideo(): HTMLVideoElement | null {
    // Prefer videos inside Prime's dedicated player container
    const playerContainer = document.querySelector(
      '#dv-web-player, .webPlayerSDKContainer, .cascadesContainer, .rendererContainer'
    );
    const scopedVideos = playerContainer
      ? Array.from(playerContainer.querySelectorAll('video'))
      : [];
    const primary = selectPrimaryVideo(scopedVideos);
    if (primary) return primary;

    return selectPrimaryVideo(Array.from(document.querySelectorAll('video')));
  },

  findOverlayContainer(video: HTMLVideoElement): HTMLElement {
    if (document.fullscreenElement instanceof HTMLElement) {
      return document.fullscreenElement;
    }

    const candidates = [
      document.querySelector<HTMLElement>('.webPlayerSDKContainer'),
      document.querySelector<HTMLElement>('#dv-web-player'),
      document.querySelector<HTMLElement>('.cascadesContainer'),
      video.parentElement,
    ];

    for (const el of candidates) {
      if (el) return el;
    }
    return document.body;
  },

  getMediaTitle(): string {
    const titleEl = document.querySelector<HTMLElement>(
      '.atvwebplayersdk-title-text, [data-automation-id="title"], .dv-node-dp-title, h1[data-automation-id="title"]'
    );
    const subtitleEl = document.querySelector<HTMLElement>(
      '.atvwebplayersdk-subtitle-text, [data-automation-id="subtitle"], [data-automation-id="ep-title"], .dv-node-dp-episode-title'
    );
    const title = titleEl?.textContent?.trim();
    const ep = subtitleEl?.textContent?.trim();
    if (title && ep) return `${title} — ${ep}`;
    if (title) return title;
    return document.title.replace(/\s*[-|]\s*Prime Video.*$/i, '').trim() || 'Amazon Prime Video';
  },
};
