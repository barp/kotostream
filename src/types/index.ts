export type WordStatus = 'unknown' | 'learning' | 'known' | 'ignored';

export type SttProviderId = 'openrouter';

export type FuriganaMode = 'all' | 'unknown_and_learning' | 'off';

export type CardType = 'sentence' | 'word' | 'audio_sentence';

export type FuriganaFormat = 'ruby_html' | 'migaku_brackets' | 'none';

export type ScreenshotFormat = 'webp' | 'jpeg' | 'png';

export type TranslationProvider = 'google_free' | 'openrouter' | 'off';

export interface SttSettings {
  provider: SttProviderId;
  apiKey: string;
  model: string;
  /** Target chunk duration in milliseconds (e.g. 2200ms) */
  chunkDurationMs: number;
  /** Minimum silence duration to split a phrase early (ms) */
  silenceSplitMs: number;
  /** Minimum silence pause (ms) before replacing the previous subtitle with a new line */
  sentenceResetPauseMs: number;
  /** RMS threshold (0.001 - 0.1) below which audio is treated as silence */
  vadThreshold: number;
  /** Optional custom context prompt (e.g. character names, show title) */
  contextPrompt: string;
}

export interface OverlaySettings {
  furiganaMode: FuriganaMode;
  autoPauseOnHover: boolean;
  autoResumeOnLeave: boolean;
  fontSizePx: number;
  bottomOffsetPx: number;
  backgroundOpacity: number;
  showTranslationHint: boolean;
  highlightUnknown: boolean;
  highlightLearning: boolean;
}

/**
 * Migaku-style Anki field mapping. Leave any field empty to skip it.
 * If two items map to the same Anki field name, they are cleanly joined.
 */
export interface AnkiFieldMapping {
  targetWord: string;
  reading: string;
  sentence: string;
  translation: string;
  definitions: string;
  image: string;
  sentenceAudio: string;
  notes: string;
  source: string;
}

export interface AnkiSettings {
  enabled: boolean;
  url: string;
  deckName: string;
  modelName: string;
  cardType: CardType;
  tags: string[];
  allowDuplicate: boolean;
  openPreviewBeforeSaving: boolean;
  furiganaFormat: FuriganaFormat;
  highlightTargetInSentence: boolean;
  includeScreenshot: boolean;
  screenshotFormat: ScreenshotFormat;
  screenshotMaxHeight: number;
  screenshotQuality: number;
  includeAudio: boolean;
  autoTranslate: boolean;
  translationProvider: TranslationProvider;
  translationTargetLang: string;
  fieldMapping: AnkiFieldMapping;
}

export interface SubtitleLibrarySettings {
  jimakuApiKey: string;
}

export interface AppSettings {
  enabled: boolean;
  stt: SttSettings;
  overlay: OverlaySettings;
  anki: AnkiSettings;
  subtitles: SubtitleLibrarySettings;
}

export interface SavedSubtitleTrack {
  id: string;
  title: string;
  fileName: string;
  /** Normalized video URL (e.g. primevideo.com/detail/...) for automatic loading */
  urlKey?: string;
  /** Timing sync offset in seconds (positive delays subtitles, negative advances them) */
  offsetSec: number;
  source: 'jimaku' | 'file' | 'generated';
  cues: SubtitleLine[];
  createdAt: number;
  updatedAt: number;
}

export interface JimakuEntry {
  id: number;
  name: string;
  english_name?: string | null;
  japanese_name?: string | null;
  flags?: Record<string, boolean>;
}

export interface JimakuFile {
  name: string;
  url: string;
  size: number;
  last_modified?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  enabled: true,
  stt: {
    provider: 'openrouter',
    apiKey: '',
    model: 'openai/whisper-large-v3-turbo',
    chunkDurationMs: 2200,
    silenceSplitMs: 280,
    sentenceResetPauseMs: 2200,
    vadThreshold: 0.005,
    contextPrompt: '',
  },
  overlay: {
    furiganaMode: 'unknown_and_learning',
    autoPauseOnHover: true,
    autoResumeOnLeave: true,
    fontSizePx: 28,
    bottomOffsetPx: 68,
    backgroundOpacity: 0.78,
    showTranslationHint: true,
    highlightUnknown: true,
    highlightLearning: true,
  },
  anki: {
    enabled: false,
    url: 'http://127.0.0.1:8765',
    deckName: 'Japanese::Mining',
    modelName: 'Migaku Japanese',
    cardType: 'sentence',
    tags: ['kotostream'],
    allowDuplicate: false,
    openPreviewBeforeSaving: true,
    furiganaFormat: 'ruby_html',
    highlightTargetInSentence: true,
    includeScreenshot: true,
    screenshotFormat: 'webp',
    screenshotMaxHeight: 480,
    screenshotQuality: 0.82,
    includeAudio: true,
    autoTranslate: true,
    translationProvider: 'google_free',
    translationTargetLang: 'en',
    fieldMapping: {
      targetWord: 'Target Word',
      reading: 'Reading',
      sentence: 'Sentence',
      translation: 'Translation',
      definitions: 'Definitions',
      image: 'Image',
      sentenceAudio: 'Sentence Audio',
      notes: 'Notes',
      source: '',
    },
  },
  subtitles: {
    jimakuApiKey: '',
  },
};

export interface DictionarySense {
  definitions: string[];
  partsOfSpeech: string[];
}

export interface DictionaryEntry {
  word: string;
  reading: string;
  altForms?: string[];
  senses: DictionarySense[];
  jlpt?: string[];
  isCommon?: boolean;
  source: 'local' | 'jisho';
}

export interface Token {
  surface: string;
  baseForm: string;
  reading?: string;
  isWord: boolean;
  hasKanji: boolean;
  status: WordStatus;
}

export interface SpeakerSegment {
  speaker: number;
  text: string;
}

export interface SubtitleLine {
  id: string;
  text: string;
  timestampMs: number;
  /** Video currentTime in seconds when spoken/displayed */
  videoTimeSec?: number;
  /** End time in seconds (for SRT/VTT subtitles) */
  endTimeSec?: number;
  source: 'live-stt' | 'file' | 'demo';
  latencyMs?: number;
  /** Measured silence gap (ms) before this spoken segment started */
  silenceGapMs?: number;
  /** True for live streaming interim results that refine in-place before finalizing */
  isInterim?: boolean;
  /** Real speaker-diarized segments (e.g. from Deepgram diarize=true) */
  segments?: SpeakerSegment[];
}

export interface VocabEntry {
  word: string;
  reading: string;
  meaning: string;
  status: WordStatus;
  encounters: number;
  firstSeenAt: number;
  updatedAt: number;
}

export interface SrsState {
  intervalDays: number;
  easeFactor: number;
  repetitions: number;
  dueAt: number;
  lastReviewedAt?: number;
}

export interface MinedCard {
  id: string;
  word: string;
  surfaceWord?: string;
  reading: string;
  meaning: string;
  sentence: string;
  translation?: string;
  notes?: string;
  cardType?: CardType;
  sourceTitle: string;
  sourceUrl: string;
  screenshotDataUrl?: string;
  screenshotFormat?: ScreenshotFormat;
  audioBase64?: string;
  audioMimeType?: string;
  createdAt: number;
  ankiNoteId?: number;
  srs: SrsState;
}

export type CaptureState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'buffering'; tabId: number }
  | {
      status: 'prescanning';
      tabId: number;
      phase: 'scanning' | 'finalizing';
      playbackRate: number;
      currentTimeSec: number;
      durationSec: number;
      progress: number;
      chunksCompleted: number;
      chunksTotal: number;
      linesGenerated: number;
    }
  | { status: 'listening'; tabId: number; lastActivityAt?: number; lastLatencyMs?: number }
  | { status: 'transcribing'; tabId: number; lastLatencyMs?: number }
  | { status: 'error'; message: string };

export type ExtensionMessage =
  | { type: 'START_CAPTURE'; tabId?: number }
  | { type: 'START_AUDIO_BUFFER'; tabId?: number }
  | { type: 'STOP_CAPTURE'; tabId?: number }
  | { type: 'GET_CAPTURE_STATE'; tabId?: number }
  | { type: 'CAPTURE_STATE_CHANGED'; state: CaptureState; tabId?: number }
  | { type: 'SUBTITLE_RECEIVED'; subtitle: SubtitleLine; tabId?: number }
  | { type: 'LOOKUP_WORD'; word: string; surface?: string; exactOnly?: boolean }
  | { type: 'TOKENIZE_TEXT'; text: string }
  | { type: 'TRANSLATE_SENTENCE'; sentence: string; targetWord?: string }
  | { type: 'CAPTURE_SCREENSHOT' }
  | { type: 'REQUEST_RECENT_AUDIO'; durationMs?: number }
  | {
      type: 'OFFSCREEN_START_AUDIO';
      streamId: string;
      tabId: number;
      settings: SttSettings;
      mode: 'live_stt' | 'buffer_only' | 'prescan';
      playbackRate?: number;
    }
  | { type: 'OFFSCREEN_SET_MODE'; mode: 'buffer_only' | 'prescan'; playbackRate?: number }
  | {
      type: 'OFFSCREEN_PRESCAN_SYNC';
      currentTimeSec: number;
      playbackRate: number;
      playing: boolean;
      flushNow?: boolean;
    }
  | { type: 'OFFSCREEN_STOP_AUDIO' }
  | { type: 'OFFSCREEN_UPDATE_SETTINGS'; settings: SttSettings }
  | { type: 'OFFSCREEN_AUDIO_CHUNK'; tabId: number; audioBase64: string; mimeType: string; durationMs: number; rms: number; silenceGapMs: number }
  | {
      type: 'OFFSCREEN_PRESCAN_CHUNK';
      tabId: number;
      audioBase64: string;
      mimeType: string;
      chunkStartSec: number;
      chunkEndSec: number;
      chunkIndex: number;
      rms: number;
    }
  | { type: 'OFFSCREEN_GET_RECENT_AUDIO'; durationMs?: number }
  | { type: 'PRESCAN_START_VIDEO'; targetRate: number }
  | { type: 'PRESCAN_STOP_VIDEO'; rewindToStart?: boolean }
  | {
      type: 'PRESCAN_VIDEO_STATUS';
      currentTimeSec: number;
      durationSec: number;
      playbackRate: number;
      playing: boolean;
      ended: boolean;
    }
  | { type: 'ANKI_REQUEST'; action: string; params?: Record<string, unknown>; url?: string }
  | { type: 'JIMAKU_SEARCH'; query: string }
  | { type: 'JIMAKU_LIST_FILES'; entryId: number; episode?: number }
  | { type: 'JIMAKU_DOWNLOAD'; url: string }
  | { type: 'GET_PAGE_MEDIA_INFO' }
  | { type: 'APPLY_SUBTITLE_TRACK'; track: SavedSubtitleTrack }
  | { type: 'SET_ENABLED'; enabled: boolean }
  | { type: 'BATCH_TRANSCRIBE_CHUNK'; audioBase64: string; mimeType: string; chunkOffsetSec: number }
  | { type: 'OPEN_DASHBOARD'; tab?: 'review' | 'vocab' | 'subtitles' | 'settings' | 'playground' };
