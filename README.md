# KotoStream

A **Migaku-inspired Chrome/Chromium extension** for Japanese language immersion that works on **Amazon Prime Video**, **YouTube**, **Netflix**, and other HTML5 video players — featuring **Jimaku subtitle matching**, **AI Japanese subtitle pre-scanning via OpenRouter**, and **1-click AnkiConnect sentence mining** with studio-quality 48 kHz stereo audio clips.

## Features

- **Automatic Japanese Subtitles (Jimaku.cc & Local Files)**: Auto-detects the show and episode on Prime Video, YouTube, and Netflix to fetch `.srt` / `.ass` / `.vtt` Japanese subtitles from Jimaku.cc, with per-episode timing sync (`±0.5s`) and a persistent Subtitle Library.
- **DRM-Safe AI Subtitle Pre-Scan & Sentence Audio Buffer**: Uses Chrome MV3 `tabCapture` + an Offscreen Audio Document with a 60-second native 48 kHz stereo PCM ring buffer and silent 4x episode pre-scanning via **OpenRouter** (`openai/whisper-large-v3-turbo` routed to Groq, `microsoft/mai-transcribe-2`, `elevenlabs/scribe-v2`, etc.) with Japanese hallucination filtering.
- **Interactive Japanese Subtitles (Shadow DOM Overlay)**:
  - MeCab (`@sglkc/kuromoji` IPADIC) morphological tokenization with compound expression detection and verb/adjective deconjugation.
  - Per-kanji **Furigana** (`Smart: Unknown & Learning only`, `All`, or `Off`), persisted across sessions.
  - Color-coded vocabulary status underlines (`Unknown`, `Learning`, `Known`, `Ignored`).
  - Instant hover/click **Dictionary Popover** (bundled core JP-EN dictionary + full JMdict lookup via Jisho.org with local caching and prefetching).
  - **Auto-pause on hover** and auto-resume on leave.
  - **Migaku-style Subtitle Browser Sidebar** with live playhead follow, click-to-seek, and hover lookups on every line.
- **Vocabulary Tracker & Migaku Import**:
  - Track `Known`, `Learning`, `Ignored`, and `Unknown` words across sessions, with automatic drag-and-drop import for Migaku word exports (`.json`, `.csv`, `.tsv`, `.txt`, `.gz`, `.zip`).
- **AnkiConnect Sentence Mining & Card Creator**:
  - Live Card Creator modal with side-by-side Anki field preview, context-aware sentence translation (OpenRouter AI or free Google Translate), clean DRM-safe video screenshots (WebP/JPEG/PNG), and bit-exact 48 kHz stereo WAV sentence audio clips — plus TSV export.
- **Interactive Playground**: Test tokenization, deconjugation, dictionary lookup, translation, and Anki field previews directly inside the dashboard.

## Quick Start

### 1. Install & Build

```bash
npm install
npm run build
```

This produces a ready-to-load Manifest V3 Chrome extension in `dist/`.

### 2. Load into Chrome / Brave / Edge

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select the `dist/` folder

### 3. Configure Jimaku & OpenRouter

1. Click the **KotoStream** icon in your browser toolbar → **Settings & Anki**
2. Add your free **Jimaku.cc** API key (from `jimaku.cc/account`) for instant anime/drama subtitles.
3. Add your **OpenRouter** API key for AI subtitle pre-scanning and context-aware sentence translations, then click **Save All Settings**.

### 4. Connect Anki

1. Install the [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on in Anki (code `2055492159`) and keep Anki open.
2. In KotoStream **Settings & Anki**, click **Test Connection & Load Decks**, pick your Deck, Note Type, and Field Mapping (Migaku or Basic presets included), and enable **Auto-send mined cards to AnkiConnect**.

## Development

```bash
npm run typecheck   # TypeScript strict check
npm test            # Run Vitest unit tests
npm run build       # Build extension to dist/
```
