import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

/**
 * Pure-Node minimal PNG encoder to generate crisp extension icons (16, 48, 128px)
 * with an indigo-to-violet gradient badge and a clean inner geometric waveform/accent.
 */
function createPngBuffer(size) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) {
        c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = size * 0.22;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter type 0
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4;

      // Rounded rectangle alpha mask
      const dx = Math.max(radius - x, 0, x - (size - 1 - radius));
      const dy = Math.max(radius - y, 0, y - (size - 1 - radius));
      const dist = Math.sqrt(dx * dx + dy * dy);
      const alpha = dist <= radius ? 255 : dist < radius + 1 ? Math.round((1 - (dist - radius)) * 255) : 0;

      // Gradient from #4f46e5 to #7c3aed
      const t = (x + y) / (2 * size);
      let r = Math.round(79 + (124 - 79) * t);
      let g = Math.round(70 + (58 - 70) * t);
      let b = Math.round(229 + (237 - 229) * t);

      // Draw crisp white stylized "言" / subtitle bars motif in the center
      const nx = x / size;
      const ny = y / size;
      const inTopBar = ny >= 0.24 && ny <= 0.32 && nx >= 0.26 && nx <= 0.74;
      const inMidBar1 = ny >= 0.40 && ny <= 0.47 && nx >= 0.30 && nx <= 0.70;
      const inMidBar2 = ny >= 0.54 && ny <= 0.61 && nx >= 0.30 && nx <= 0.70;
      const inBoxOuter = ny >= 0.68 && ny <= 0.82 && nx >= 0.30 && nx <= 0.70;
      const inBoxInner = ny >= 0.72 && ny <= 0.78 && nx >= 0.37 && nx <= 0.63;

      if (inTopBar || inMidBar1 || inMidBar2 || (inBoxOuter && !inBoxInner)) {
        r = 255;
        g = 255;
        b = 255;
      }

      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = alpha;
    }
  }

  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function runBuild() {
  fs.rmSync(distDir, { recursive: true, force: true });

  // 1. Build HTML pages (popup, dashboard, offscreen) + background service worker
  await build({
    root: rootDir,
    plugins: [react()],
    base: './',
    build: {
      outDir: distDir,
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        input: {
          popup: path.join(rootDir, 'src/popup/index.html'),
          dashboard: path.join(rootDir, 'src/dashboard/index.html'),
          offscreen: path.join(rootDir, 'src/offscreen/offscreen.html'),
          background: path.join(rootDir, 'src/background/index.ts'),
        },
        output: {
          entryFileNames: (chunkInfo) => {
            if (chunkInfo.name === 'background') return 'background.js';
            return 'assets/[name]-[hash].js';
          },
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  });

  // 2. Build content script as a single self-contained IIFE bundle
  await build({
    root: rootDir,
    configFile: false,
    build: {
      outDir: distDir,
      emptyOutDir: false,
      sourcemap: false,
      lib: {
        entry: path.join(rootDir, 'src/content/index.ts'),
        name: 'KotoStreamContent',
        formats: ['iife'],
        fileName: () => 'content.js',
      },
      rollupOptions: {
        output: {
          extend: true,
        },
      },
    },
  });

  // 3. Generate PNG icons
  const iconsDir = path.join(distDir, 'icons');
  fs.mkdirSync(iconsDir, { recursive: true });
  for (const size of [16, 48, 128]) {
    fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), createPngBuffer(size));
  }

  // 3b. Copy Kuromoji MeCab IPADIC dictionary files into dist/dict/
  const srcDictDir = path.join(rootDir, 'node_modules/@sglkc/kuromoji/dict');
  const distDictDir = path.join(distDir, 'dict');
  fs.mkdirSync(distDictDir, { recursive: true });
  for (const file of fs.readdirSync(srcDictDir)) {
    fs.copyFileSync(path.join(srcDictDir, file), path.join(distDictDir, file));
  }

  // 4. Write manifest.json
  const manifestJson = {
    manifest_version: 3,
    name: 'KotoStream — Japanese Immersion & Live AI Subtitles',
    version: '1.0.0',
    description:
      'Migaku-inspired Japanese immersion toolkit with real-time AI Japanese subtitle generation for Amazon Prime Video, YouTube, Netflix, and more.',
    permissions: ['storage', 'unlimitedStorage', 'activeTab', 'tabCapture', 'offscreen', 'tabs', 'scripting', 'notifications'],
    host_permissions: [
      'https://*.primevideo.com/*',
      'https://*.amazon.com/*',
      'https://*.amazon.co.jp/*',
      'https://*.amazon.co.uk/*',
      'https://*.amazon.de/*',
      'https://*.youtube.com/*',
      'https://*.netflix.com/*',
      'https://jisho.org/*',
      'https://translate.googleapis.com/*',
      'https://jimaku.cc/*',
      'https://openrouter.ai/*',
      'http://127.0.0.1:8765/*',
      'http://localhost:8765/*',
      '<all_urls>',
    ],
    icons: {
      16: 'icons/icon16.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
    action: {
      default_popup: 'src/popup/index.html',
      default_title: 'KotoStream',
      default_icon: {
        16: 'icons/icon16.png',
        48: 'icons/icon48.png',
        128: 'icons/icon128.png',
      },
    },
    background: {
      service_worker: 'background.js',
      type: 'module',
    },
    content_scripts: [
      {
        matches: [
          'https://*.primevideo.com/*',
          'https://*.amazon.com/gp/video/*',
          'https://*.amazon.com/dp/*',
          'https://*.amazon.co.jp/gp/video/*',
          'https://*.amazon.co.jp/dp/*',
          'https://*.amazon.co.uk/gp/video/*',
          'https://*.amazon.de/gp/video/*',
          'https://*.youtube.com/*',
          'https://*.netflix.com/*',
        ],
        js: ['content.js'],
        run_at: 'document_idle',
      },
    ],
    web_accessible_resources: [
      {
        resources: ['icons/*'],
        matches: ['<all_urls>'],
      },
    ],
  };

  const manifestPath = path.join(distDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifestJson, null, 2));

  // Guard against permission drift between this script and src/manifest.ts: the extension
  // silently breaks (chrome.storage.local capped at 10 MB) if a required permission goes
  // missing from the shipped manifest.
  const REQUIRED_PERMISSIONS = ['storage', 'unlimitedStorage', 'notifications', 'tabCapture', 'offscreen', 'tabs', 'scripting'];
  const written = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const missing = REQUIRED_PERMISSIONS.filter((p) => !written.permissions?.includes(p));
  if (missing.length > 0) {
    throw new Error(`Built manifest.json is missing required permissions: ${missing.join(', ')}`);
  }

  console.log('✓ KotoStream extension built successfully into dist/');
}

runBuild().catch((err) => {
  console.error(err);
  process.exit(1);
});
