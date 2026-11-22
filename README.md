# KotoStream

A **Migaku-inspired Chrome/Chromium extension** for Japanese language immersion that works on **Amazon Prime Video**, **YouTube**, **Netflix**, and other HTML5 video players — including **on-the-fly Japanese subtitle generation** for shows that don't have Japanese subtitles.

## Features

- **Real-Time Japanese AI Subtitles (DRM-safe)**: Uses Chrome MV3 `tabCapture` + an Offscreen Audio Document with Voice Activity Detection (VAD) and audio passthrough so it works on **Amazon Prime Video** even when DRM blocks normal video audio APIs.
- **Cloud STT Providers**: Pluggable support for **Groq** (`whisper-large-v3-turbo`, fastest & free tier), **OpenAI** (`whisper-1` / `gpt-4o-mini-transcribe`), **Deepgram** (`nova-2`), or any custom OpenAI-compatible transcription endpoint, with Whisper Japanese hallucination filtering and rolling context prompts.
- **Interactive Japanese Subtitles (Shadow DOM Overlay)**:
  - Word tokenization with verb/adjective deconjugation (`Intl.Segmenter` + custom auxiliary merger & deconjugator).
  - Smart **Furigana** (`All`, `Smart: Unknown & Learning only`, or `Off`).
  - Color-coded vocabulary status underlines (`Unknown`, `Learning`, `Known`).
  - Instant hover/click **Dictionary Popover** (bundled core JP-EN dictionary + full JMdict lookup via Jisho.org with local caching).
  - **Auto-pause on hover** and auto-resume on leave.
  - **Transcript History Sidebar** and local `.srt` / `.vtt` subtitle file loading.
- **Built-in Vocabulary Tracker & SM-2 SRS**:
  - Track `Known`, `Learning`, and `Unknown` words across sessions, with bulk import for words you already know.
  - Built-in spaced repetition flashcard reviewer with sentence context, captured audio playback, and video screenshots.
- **AnkiConnect Integration**:
  - 1-click sentence mining straight into Anki with ruby furigana, English definition, full sentence, video screenshot, and captured sentence audio clip — plus TSV export.
- **Interactive Playground**: Test tokenization, deconjugation, dictionary lookup, and mining directly inside the dashboard without needing a live stream.

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

### 3. Configure Cloud STT (for Live Amazon Prime Subtitles)

1. Click the **KotoStream** icon in your browser toolbar → **Settings & Anki**
2. Choose your STT provider (we recommend **Groq** with `whisper-large-v3-turbo` for ~300ms latency)
3. Paste your API key and click **Save All Settings**
4. Open any Japanese show on **Amazon Prime Video**, click **Start AI Subs** on the video toolbar (or from the extension popup), and enjoy interactive Japanese subtitles!

### 4. Optional: Connect Anki

1. Install the [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on in Anki (code `2055492159`) and keep Anki open.
2. In KotoStream **Settings & Anki**, click **Test Connection & Load Decks**, pick your Deck, Note Type, and Field Mapping, and enable **Auto-send mined cards to AnkiConnect**.

## Development

```bash
npm run typecheck   # TypeScript strict check
npm test            # Run Vitest unit tests
npm run build       # Build extension to dist/
```
