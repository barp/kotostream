import type { ExtensionMessage, ScreenshotFormat } from '../types';

export interface ScreenshotOptions {
  format: ScreenshotFormat;
  maxHeight: number;
  quality: number;
}

export interface CapturedScreenshot {
  dataUrl: string;
  width: number;
  height: number;
  format: ScreenshotFormat;
  method: 'canvas' | 'tab-crop';
}

function formatToMime(format: ScreenshotFormat): string {
  if (format === 'png') return 'image/png';
  if (format === 'jpeg') return 'image/jpeg';
  return 'image/webp';
}

function computeScaledDimensions(srcW: number, srcH: number, maxHeight: number): { width: number; height: number } {
  if (srcW <= 0 || srcH <= 0) return { width: 640, height: 360 };
  if (maxHeight <= 0 || srcH <= maxHeight) {
    return { width: Math.round(srcW), height: Math.round(srcH) };
  }
  const scale = maxHeight / srcH;
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

/**
 * Checks whether a canvas frame is completely black/transparent (typical of DRM-protected video).
 */
function isBlankOrBlackCanvas(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  try {
    const sampleCoords = [
      [0.2, 0.2],
      [0.5, 0.5],
      [0.8, 0.8],
      [0.2, 0.8],
      [0.8, 0.2],
      [0.5, 0.3],
    ];
    for (const [nx, ny] of sampleCoords) {
      const x = Math.min(width - 1, Math.max(0, Math.floor(width * nx)));
      const y = Math.min(height - 1, Math.max(0, Math.floor(height * ny)));
      const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
      if (a > 0 && (r > 6 || g > 6 || b > 6)) {
        return false;
      }
    }
    return true;
  } catch {
    // Tainted canvas (CORS/DRM)
    return true;
  }
}

function waitTwoFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode tab screenshot'));
    img.src = src;
  });
}

/**
 * Captures a clean Migaku-style video-only screenshot:
 * 1. Tries direct HTML5 <video> canvas draw (instant, zero UI, exact video resolution).
 * 2. If DRM (Amazon Prime / Netflix) produces a black/tainted canvas, temporarily hides the
 *    KotoStream overlay, captures the visible tab via chrome.tabs.captureVisibleTab, crops
 *    precisely to the <video> element's bounding rectangle, and scales/encodes to WebP/JPEG/PNG.
 */
export async function captureCleanVideoScreenshot(
  video: HTMLVideoElement | null,
  options: ScreenshotOptions,
  hideOverlay: () => void,
  showOverlay: () => void
): Promise<CapturedScreenshot | null> {
  const mime = formatToMime(options.format);
  const quality = Math.min(1, Math.max(0.1, options.quality));

  // Step 1: Direct <video> canvas capture (non-DRM sites like YouTube / local videos)
  if (video && video.videoWidth > 0 && video.videoHeight > 0) {
    try {
      const { width, height } = computeScaledDimensions(
        video.videoWidth,
        video.videoHeight,
        options.maxHeight
      );
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, width, height);
        if (!isBlankOrBlackCanvas(ctx, width, height)) {
          const dataUrl = canvas.toDataURL(mime, quality);
          return { dataUrl, width, height, format: options.format, method: 'canvas' };
        }
      }
    } catch {
      // Fall through to DRM-safe tab capture + video crop
    }
  }

  // Step 2: DRM-safe visible tab capture with overlay hidden + precise video bounding-box crop
  hideOverlay();
  await waitTwoFrames();

  let rawTabDataUrl: string | undefined;
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'CAPTURE_SCREENSHOT',
    } satisfies ExtensionMessage)) as { dataUrl?: string; error?: string };
    rawTabDataUrl = res?.dataUrl;
  } finally {
    showOverlay();
  }

  if (!rawTabDataUrl) return null;

  try {
    const img = await loadImage(rawTabDataUrl);
    const dpr = window.devicePixelRatio || 1;

    let sx = 0;
    let sy = 0;
    let sw = img.naturalWidth;
    let sh = img.naturalHeight;

    if (video) {
      const rect = video.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 40) {
        // Account for actual image-to-viewport scale (handles browser zoom cleanly)
        const scaleX = img.naturalWidth / Math.max(1, window.innerWidth);
        const scaleY = img.naturalHeight / Math.max(1, window.innerHeight);
        const effectiveScaleX = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : dpr;
        const effectiveScaleY = Number.isFinite(scaleY) && scaleY > 0 ? scaleY : dpr;

        sx = Math.max(0, Math.round(rect.left * effectiveScaleX));
        sy = Math.max(0, Math.round(rect.top * effectiveScaleY));
        sw = Math.min(img.naturalWidth - sx, Math.round(rect.width * effectiveScaleX));
        sh = Math.min(img.naturalHeight - sy, Math.round(rect.height * effectiveScaleY));
      }
    }

    if (sw <= 10 || sh <= 10) {
      sx = 0;
      sy = 0;
      sw = img.naturalWidth;
      sh = img.naturalHeight;
    }

    const { width, height } = computeScaledDimensions(sw, sh, options.maxHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, width, height);
    const dataUrl = canvas.toDataURL(mime, quality);
    return { dataUrl, width, height, format: options.format, method: 'tab-crop' };
  } catch {
    return null;
  }
}
