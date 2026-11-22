export const manifest: chrome.runtime.ManifestV3 = {
  manifest_version: 3,
  name: 'KotoStream — Japanese Immersion & Live AI Subtitles',
  version: '1.0.0',
  description:
    'Migaku-inspired Japanese immersion toolkit with real-time AI Japanese subtitle generation for Amazon Prime Video, YouTube, Netflix, and more.',
  permissions: [
    'storage',
    'activeTab',
    'tabCapture',
    'offscreen',
    'tabs',
    'scripting',
  ],
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
