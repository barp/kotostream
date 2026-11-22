import { selectPrimaryVideo, type SiteAdapter } from './base';

const EPISODE_HINT_REGEX =
  /(?:\bS\d+\s*[,·•.\s-]*E(?:p\.?)?\s*\d+|\bSeason\s*\d+.*?\bE(?:p\.?|pisode)?\s*\d+|\b\d+x\d{1,4}\b|\bEpisode\s*\d+|\bEp\.?\s*\d+|\bE\d{1,4}\b|エピソード\s*\d+|第\s*\d+\s*話|\d+\s*話|^\d{1,4}\.\s+\S)/i;

// Cache the last observed player title + episode text per URL, because Prime Video
// hides/unmounts its player header overlay as soon as the mouse leaves the video to click the popup!
let cachedUrl = '';
let cachedTitle = '';
let cachedEpisodeText = '';

function findEpisodeTextViaTreeWalker(root: Node): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let inspected = 0;

  while ((node = walker.nextNode()) && inspected < 1500) {
    inspected++;
    const parent = node.parentElement;
    if (!parent) continue;
    const tag = parent.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
    if (parent.closest('#kotostream-overlay-host')) continue;

    const text = node.nodeValue?.trim() || '';
    if (text.length < 2 || text.length > 120) continue;

    if (EPISODE_HINT_REGEX.test(text)) {
      return text;
    }
  }
  return '';
}

function scanPrimePlayerMetadata(): { title: string; episodeText: string } {
  if (window.location.href !== cachedUrl) {
    cachedUrl = window.location.href;
    cachedTitle = '';
    cachedEpisodeText = '';
  }

  // 1. Check browser MediaSession metadata (Prime populates this for OS media controls!)
  const msMeta = typeof navigator !== 'undefined' ? navigator.mediaSession?.metadata : null;
  if (msMeta) {
    const msParts = [msMeta.title, msMeta.album, msMeta.artist].filter(Boolean) as string[];
    for (const part of msParts) {
      if (EPISODE_HINT_REGEX.test(part)) {
        cachedEpisodeText = part.trim();
      } else if (!cachedTitle && part.trim() && !/prime video/i.test(part)) {
        cachedTitle = part.trim();
      }
    }
  }

  // 2. Direct Prime Video selectors
  const titleEl = document.querySelector<HTMLElement>(
    '.atvwebplayersdk-title-text, [class*="atvwebplayersdk-title-text"], [data-automation-id="title"], .dv-node-dp-title, h1[data-automation-id="title"]'
  );
  const directTitle = titleEl?.textContent?.trim();
  if (directTitle) {
    cachedTitle = directTitle;
  }

  const subtitleEl = document.querySelector<HTMLElement>(
    '.atvwebplayersdk-subtitle-text, [class*="atvwebplayersdk-subtitle-text"], [data-automation-id="subtitle"], [data-automation-id="ep-title"], .dv-node-dp-episode-title'
  );
  const directEp = subtitleEl?.textContent?.trim();
  if (directEp) {
    cachedEpisodeText = directEp;
  }

  // 3. Class-agnostic TreeWalker scan inside Prime's player container (works even with hashed CSS classes!)
  if (!cachedEpisodeText || !EPISODE_HINT_REGEX.test(cachedEpisodeText)) {
    const playerRoot =
      document.querySelector('#dv-web-player, .webPlayerSDKContainer, .cascadesContainer, [class*="webPlayer"]') ??
      document.body;
    if (playerRoot) {
      const found = findEpisodeTextViaTreeWalker(playerRoot);
      if (found) {
        cachedEpisodeText = found;
      }
    }
  }

  return {
    title:
      cachedTitle ||
      document.title.replace(/\s*[-|]\s*(?:Amazon\s*)?Prime Video.*$/i, '').trim() ||
      'Amazon Prime Video',
    episodeText: cachedEpisodeText,
  };
}

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
    const { title, episodeText } = scanPrimePlayerMetadata();
    if (title && episodeText && !title.includes(episodeText)) {
      return `${title} — ${episodeText}`;
    }
    return title;
  },
};
