import overlayCss from './overlay.css?raw';
import type {
  AppSettings,
  CaptureState,
  CardType,
  DictionaryEntry,
  ExtensionMessage,
  FuriganaMode,
  SavedSubtitleTrack,
  ScreenshotFormat,
  SubtitleLine,
  Token,
  VocabEntry,
  WordStatus,
} from '../../types';
import { findCandidateCompounds, findVocabEntry, tokenizeJapanese } from '../../core/tokenizer';
import { deconjugate } from '../../core/deconjugator';
import { lookupLocal } from '../../core/dictionary';
import { parseSubtitleFile, findActiveSubtitlesAtTime } from '../../core/subtitle-parser';
import { mergeLiveSubtitle } from '../../core/subtitle-merge';
import {
  addMinedCard,
  bindSubtitleTrackToUrl,
  findSubtitleTrackForUrl,
  getSubtitleLibrary,
  saveSubtitleTrack,
  setWordStatus,
  updateSubtitleTrackOffset,
} from '../../core/storage';
import { buildAnkiFieldPreview, exportCardToAnki } from '../../core/anki';
import { captureCleanVideoScreenshot } from '../screenshot';
import type { SiteAdapter } from '../adapters/base';

interface CardDraft {
  word: string;
  surfaceWord: string;
  reading: string;
  meaning: string;
  sentence: string;
  translation: string;
  notes: string;
  cardType: CardType;
  sourceTitle: string;
  sourceUrl: string;
  screenshotDataUrl?: string;
  screenshotFormat?: ScreenshotFormat;
  screenshotMeta?: string;
  audioBase64?: string;
  audioMimeType?: string;
  translating: boolean;
  capturingShot: boolean;
}

function safeSendMessage<T = unknown>(message: ExtensionMessage): Promise<T | undefined> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
    return Promise.resolve(undefined);
  }
  try {
    return chrome.runtime.sendMessage(message).catch(() => undefined) as Promise<T | undefined>;
  } catch {
    return Promise.resolve(undefined);
  }
}

export class OverlayManager {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private adapter: SiteAdapter;
  private video: HTMLVideoElement | null = null;
  private mountedContainer: HTMLElement | null = null;

  private settings: AppSettings;
  private vocabMap: Record<string, VocabEntry> = {};
  private readingCache: Record<string, string> = {};
  private entryCache = new Map<string, DictionaryEntry>();
  private verifiedCompounds = new Set<string>();
  private checkedCompounds = new Set<string>();
  private captureState: CaptureState = { status: 'idle' };

  private committedSubtitle: SubtitleLine | null = null;
  private currentSubtitle: SubtitleLine | null = null;
  private subtitleHistory: SubtitleLine[] = [];
  private loadedFileSubtitles: SubtitleLine[] = [];
  private activeTrackId: string | null = null;
  private activeTrackName: string | null = null;
  private subtitleOffsetSec = 0;
  private lastAutoLoadedUrl = '';
  private sidebarMode: 'history' | 'library' = 'history';

  private activeToken: Token | null = null;
  private activeRowSentence: string | null = null;
  private activeEntry: DictionaryEntry | null = null;
  private pausedByOverlay = false;
  private hoverCloseTimer: number | null = null;
  private toastTimer: number | null = null;

  // DOM refs inside Shadow DOM
  private toolbarEl!: HTMLDivElement;
  private dotEl!: HTMLSpanElement;
  private toggleCaptureBtn!: HTMLButtonElement;
  private furiganaBtn!: HTMLButtonElement;
  private syncGroupEl!: HTMLSpanElement;
  private syncLabelBtn!: HTMLButtonElement;
  private statusPillEl!: HTMLSpanElement;
  private subtitleBoxEl!: HTMLDivElement;
  private popoverEl!: HTMLDivElement;
  private sidebarEl!: HTMLDivElement;
  private sidebarListEl!: HTMLDivElement;
  private toastEl!: HTMLDivElement;
  private fileInputEl!: HTMLInputElement;
  private modalBackdropEl!: HTMLDivElement;
  private cardDraft: CardDraft | null = null;

  constructor(adapter: SiteAdapter, settings: AppSettings, vocabMap: Record<string, VocabEntry>) {
    this.adapter = adapter;
    this.settings = settings;
    this.vocabMap = vocabMap;

    this.host = document.createElement('div');
    this.host.id = 'kotostream-overlay-host';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.buildDom();
    this.applyOverlayStyles();
  }

  private buildDom() {
    const style = document.createElement('style');
    style.textContent = overlayCss;
    this.shadow.appendChild(style);

    // Toolbar
    this.toolbarEl = document.createElement('div');
    this.toolbarEl.className = 'ks-toolbar';
    this.toolbarEl.innerHTML = `
      <span class="ks-brand"><span class="ks-dot"></span>KotoStream</span>
      <button class="ks-btn ks-btn-primary" data-action="toggle-capture">Start AI Subs</button>
      <button class="ks-btn" data-action="toggle-furigana" title="Cycle Furigana mode">振り仮名</button>
      <button class="ks-btn" data-action="toggle-library" title="Saved Subtitle Library &amp; Jimaku">Library</button>
      <button class="ks-btn" data-action="load-file" title="Load .srt, .vtt, or .ass Japanese subtitles">Load Sub</button>
      <span class="ks-sync-group" style="display:none;align-items:center;gap:4px">
        <button class="ks-btn" data-action="sync-minus" title="Show subtitles 0.5s earlier">-0.5s</button>
        <button class="ks-btn" data-action="sync-reset" title="Click to reset sync offset to 0s">0.0s</button>
        <button class="ks-btn" data-action="sync-plus" title="Delay subtitles by 0.5s">+0.5s</button>
      </span>
      <button class="ks-btn" data-action="toggle-sidebar" title="Transcript history">History</button>
      <button class="ks-btn" data-action="open-settings" title="Settings &amp; Dashboard">⚙</button>
      <span class="ks-status-pill"></span>
    `;
    this.shadow.appendChild(this.toolbarEl);

    this.dotEl = this.toolbarEl.querySelector('.ks-dot')!;
    this.toggleCaptureBtn = this.toolbarEl.querySelector('[data-action="toggle-capture"]')!;
    this.furiganaBtn = this.toolbarEl.querySelector('[data-action="toggle-furigana"]')!;
    this.syncGroupEl = this.toolbarEl.querySelector('.ks-sync-group')!;
    this.syncLabelBtn = this.toolbarEl.querySelector('[data-action="sync-reset"]')!;
    this.statusPillEl = this.toolbarEl.querySelector('.ks-status-pill')!;

    this.fileInputEl = document.createElement('input');
    this.fileInputEl.type = 'file';
    this.fileInputEl.accept = '.srt,.vtt,.ass';
    this.fileInputEl.style.display = 'none';
    this.shadow.appendChild(this.fileInputEl);

    // Subtitle display
    const subWrap = document.createElement('div');
    subWrap.className = 'ks-subtitle-wrap';
    this.subtitleBoxEl = document.createElement('div');
    this.subtitleBoxEl.className = 'ks-subtitle-box ks-empty';
    subWrap.appendChild(this.subtitleBoxEl);
    this.shadow.appendChild(subWrap);

    // Dictionary Popover
    this.popoverEl = document.createElement('div');
    this.popoverEl.className = 'ks-popover';
    this.shadow.appendChild(this.popoverEl);

    // Sidebar
    this.sidebarEl = document.createElement('div');
    this.sidebarEl.className = 'ks-sidebar';
    this.sidebarEl.innerHTML = `
      <div class="ks-sidebar-header">
        <span>Transcript History</span>
        <button class="ks-btn" data-action="close-sidebar">✕</button>
      </div>
      <div class="ks-sidebar-list"></div>
    `;
    this.sidebarListEl = this.sidebarEl.querySelector('.ks-sidebar-list')!;
    this.shadow.appendChild(this.sidebarEl);

    // Toast
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'ks-toast';
    this.shadow.appendChild(this.toastEl);

    // Migaku-style Card Creator Modal
    this.modalBackdropEl = document.createElement('div');
    this.modalBackdropEl.className = 'ks-modal-backdrop';
    this.shadow.appendChild(this.modalBackdropEl);

    this.bindEvents();
    this.updateFuriganaLabel();
  }

  private bindEvents() {
    this.toolbarEl.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!target) return;
      e.stopPropagation();

      switch (target.dataset.action) {
        case 'toggle-capture':
          void this.toggleLiveCapture();
          break;
        case 'toggle-furigana':
          this.cycleFuriganaMode();
          break;
        case 'toggle-library':
          if (this.sidebarEl.classList.contains('ks-open') && this.sidebarMode === 'library') {
            this.sidebarEl.classList.remove('ks-open');
          } else {
            this.sidebarMode = 'library';
            this.sidebarEl.classList.add('ks-open');
            void this.renderLibrarySidebar();
          }
          break;
        case 'toggle-sidebar':
          if (this.sidebarEl.classList.contains('ks-open') && this.sidebarMode === 'history') {
            this.sidebarEl.classList.remove('ks-open');
          } else {
            this.sidebarMode = 'history';
            this.sidebarEl.classList.add('ks-open');
            this.renderSidebar();
          }
          break;
        case 'sync-minus':
          void this.adjustSubtitleOffset(-0.5);
          break;
        case 'sync-plus':
          void this.adjustSubtitleOffset(0.5);
          break;
        case 'sync-reset':
          void this.adjustSubtitleOffset(-this.subtitleOffsetSec);
          break;
        case 'load-file':
          this.fileInputEl.click();
          break;
        case 'open-settings':
          void safeSendMessage({ type: 'OPEN_DASHBOARD', tab: 'subtitles' });
          break;
      }
    });

    this.sidebarEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-action="close-sidebar"]')) {
        this.sidebarEl.classList.remove('ks-open');
        return;
      }
      if (target.closest('[data-action="open-subtitles-dashboard"]')) {
        void safeSendMessage({ type: 'OPEN_DASHBOARD', tab: 'subtitles' });
        return;
      }
      const trackItem = target.closest<HTMLElement>('[data-track-id]');
      if (trackItem?.dataset.trackId) {
        void this.loadSavedTrackById(trackItem.dataset.trackId);
        return;
      }
      const item = target.closest<HTMLElement>('.ks-history-item');
      if (item?.dataset.subId) {
        const sub = this.subtitleHistory.find((s) => s.id === item.dataset.subId);
        if (sub) {
          this.setSubtitle(sub, false);
          if (sub.videoTimeSec !== undefined && this.video) {
            this.video.currentTime = Math.max(0, sub.videoTimeSec + this.subtitleOffsetSec);
          }
        }
      }
    });

    this.fileInputEl.addEventListener('change', async () => {
      const file = this.fileInputEl.files?.[0];
      if (!file) return;
      const text = await file.text();
      const parsed = parseSubtitleFile(text);
      this.fileInputEl.value = '';
      if (parsed.length > 0) {
        const saved = await saveSubtitleTrack({
          title: this.adapter.getMediaTitle(),
          fileName: file.name,
          urlKey: window.location.href,
          offsetSec: 0,
          source: 'file',
          cues: parsed,
        });
        this.applyLoadedTrack(saved);
        this.showToast(`Loaded & saved ${parsed.length} lines from ${file.name}`);
      } else {
        this.showToast('No valid cues found in subtitle file');
      }
    });

    // Keep popover alive while mouse is over it
    this.popoverEl.addEventListener('mouseenter', () => {
      if (this.hoverCloseTimer) {
        clearTimeout(this.hoverCloseTimer);
        this.hoverCloseTimer = null;
      }
    });

    this.popoverEl.addEventListener('mouseleave', () => {
      this.schedulePopoverClose();
    });

    this.subtitleBoxEl.addEventListener('mouseleave', () => {
      this.schedulePopoverClose();
    });

    // Close popover on outside click
    document.addEventListener('click', (e) => {
      if (!this.host.contains(e.target as Node)) {
        this.closePopover();
      }
    });
  }

  public ensureMounted() {
    const container =
      document.fullscreenElement instanceof HTMLElement
        ? document.fullscreenElement
        : document.body || document.documentElement;

    if (container && (this.mountedContainer !== container || !this.host.isConnected)) {
      container.appendChild(this.host);
      this.mountedContainer = container;
    }
  }

  public mount(video: HTMLVideoElement) {
    this.video = video;
    this.ensureMounted();

    // Bind video timeupdate for .srt/.vtt/.ass playback sync
    video.removeEventListener('timeupdate', this.handleVideoTimeUpdate);
    video.addEventListener('timeupdate', this.handleVideoTimeUpdate);

    // Auto-load any saved subtitle track bound to this episode URL
    if (this.lastAutoLoadedUrl !== window.location.href) {
      this.lastAutoLoadedUrl = window.location.href;
      void this.tryAutoLoadSavedTrack();
    }
  }

  private async tryAutoLoadSavedTrack() {
    const match = await findSubtitleTrackForUrl(window.location.href);
    if (match && match.cues.length > 0) {
      this.applyLoadedTrack(match);
      this.showToast(`Auto-loaded subtitles: ${match.fileName} (${match.cues.length} lines)`);
    }
  }

  public getActiveTrackName(): string | null {
    return this.activeTrackName;
  }

  public applyLoadedTrack(track: SavedSubtitleTrack) {
    this.activeTrackId = track.id;
    this.activeTrackName = track.fileName;
    this.subtitleOffsetSec = track.offsetSec || 0;
    this.loadedFileSubtitles = track.cues;
    this.subtitleHistory = [...track.cues];
    this.syncGroupEl.style.display = 'inline-flex';
    this.updateSyncLabel();
    this.syncFileSubtitleToVideo();
    if (this.sidebarEl.classList.contains('ks-open') && this.sidebarMode === 'history') {
      this.renderSidebar();
    }
  }

  private async loadSavedTrackById(trackId: string) {
    const lib = await getSubtitleLibrary();
    const track = lib.find((t) => t.id === trackId);
    if (!track) return;
    await bindSubtitleTrackToUrl(track.id, window.location.href);
    this.applyLoadedTrack(track);
    this.sidebarEl.classList.remove('ks-open');
    this.showToast(`Synced “${track.fileName}” to this episode!`);
  }

  private async adjustSubtitleOffset(deltaSec: number) {
    this.subtitleOffsetSec = Math.round((this.subtitleOffsetSec + deltaSec) * 10) / 10;
    this.updateSyncLabel();
    this.syncFileSubtitleToVideo();
    if (this.activeTrackId) {
      await updateSubtitleTrackOffset(this.activeTrackId, this.subtitleOffsetSec);
    }
    this.showToast(`Subtitle sync: ${this.formatOffset(this.subtitleOffsetSec)}`);
  }

  private updateSyncLabel() {
    this.syncLabelBtn.textContent = this.formatOffset(this.subtitleOffsetSec);
  }

  private formatOffset(sec: number): string {
    const sign = sec > 0 ? '+' : '';
    return `${sign}${sec.toFixed(1)}s`;
  }

  private handleVideoTimeUpdate = () => {
    this.syncFileSubtitleToVideo();
  };

  private syncFileSubtitleToVideo() {
    if (!this.video || this.loadedFileSubtitles.length === 0) return;
    const activeCues = findActiveSubtitlesAtTime(
      this.loadedFileSubtitles,
      this.video.currentTime,
      this.subtitleOffsetSec
    );

    if (activeCues.length > 0) {
      const combinedId = activeCues.map((c) => c.id).join('+');
      if (combinedId !== this.currentSubtitle?.id) {
        const combinedLine: SubtitleLine = {
          ...activeCues[0],
          id: combinedId,
          text: activeCues.map((c) => c.text.replace(/\n/g, ' ')).join('\n'),
        };
        this.setSubtitle(combinedLine, false);
      }
    } else if (this.currentSubtitle?.source === 'file') {
      this.currentSubtitle = null;
      this.committedSubtitle = null;
      this.subtitleBoxEl.classList.add('ks-empty');
      this.subtitleBoxEl.innerHTML = '';
    }
  }

  public updateSettings(settings: AppSettings) {
    this.settings = settings;
    this.applyOverlayStyles();
    this.updateFuriganaLabel();
    this.renderCurrentSubtitle();
  }

  public updateVocabMap(vocabMap: Record<string, VocabEntry>) {
    this.vocabMap = vocabMap;
    this.renderCurrentSubtitle();
  }

  private applyOverlayStyles() {
    this.host.style.setProperty('--ks-font-size', `${this.settings.overlay.fontSizePx}px`);
    this.host.style.setProperty('--ks-bottom-offset', `${this.settings.overlay.bottomOffsetPx}px`);
    this.host.style.setProperty('--ks-bg-opacity', String(this.settings.overlay.backgroundOpacity));
  }

  public updateCaptureState(state: CaptureState) {
    this.captureState = state;
    this.dotEl.className = `ks-dot ${state.status}`;

    const isActive = state.status === 'listening' || state.status === 'transcribing' || state.status === 'starting';
    this.toolbarEl.classList.toggle('ks-active', isActive);

    if (isActive) {
      this.toggleCaptureBtn.textContent = 'Stop AI Subs';
      this.toggleCaptureBtn.className = 'ks-btn ks-btn-danger';
    } else {
      this.toggleCaptureBtn.textContent = 'Start AI Subs';
      this.toggleCaptureBtn.className = 'ks-btn ks-btn-primary';
    }

    this.statusPillEl.className = 'ks-status-pill';
    if (state.status === 'listening') {
      this.statusPillEl.textContent = state.lastLatencyMs
        ? `Listening · ${state.lastLatencyMs}ms`
        : 'Listening…';
    } else if (state.status === 'transcribing') {
      this.statusPillEl.textContent = 'Transcribing…';
    } else if (state.status === 'starting') {
      this.statusPillEl.textContent = 'Starting…';
    } else if (state.status === 'error') {
      this.statusPillEl.textContent = state.message;
      this.statusPillEl.classList.add('error');
      this.showToast(state.message);
    } else {
      this.statusPillEl.textContent = '';
    }
  }

  public setSubtitle(subtitle: SubtitleLine, appendToHistory = true) {
    const withTime: SubtitleLine = {
      ...subtitle,
      videoTimeSec: subtitle.videoTimeSec ?? this.video?.currentTime,
    };

    if (appendToHistory && withTime.source === 'live-stt') {
      // Interim streaming results (Deepgram WebSocket) preview smoothly against the last committed line
      if (withTime.isInterim) {
        const { subtitle: previewSub } = mergeLiveSubtitle(this.committedSubtitle, withTime, {
          resetPauseMs: this.settings.stt.sentenceResetPauseMs ?? 2200,
        });
        this.currentSubtitle = previewSub;
        this.renderCurrentSubtitle();
        return;
      }

      const { subtitle: nextSub, merged } = mergeLiveSubtitle(this.committedSubtitle, withTime, {
        resetPauseMs: this.settings.stt.sentenceResetPauseMs ?? 2200,
      });
      this.committedSubtitle = nextSub;
      this.currentSubtitle = nextSub;

      if (merged && this.subtitleHistory.length > 0 && this.subtitleHistory[0].id === nextSub.id) {
        this.subtitleHistory[0] = nextSub;
      } else {
        this.subtitleHistory.unshift(nextSub);
        if (this.subtitleHistory.length > 300) {
          this.subtitleHistory.pop();
        }
      }

      if (this.sidebarEl.classList.contains('ks-open')) {
        this.renderSidebar();
      }
    } else {
      this.committedSubtitle = withTime;
      this.currentSubtitle = withTime;
      if (appendToHistory) {
        this.subtitleHistory.unshift(withTime);
        if (this.subtitleHistory.length > 300) {
          this.subtitleHistory.pop();
        }
        if (this.sidebarEl.classList.contains('ks-open')) {
          this.renderSidebar();
        }
      }
    }

    this.renderCurrentSubtitle();
  }

  private renderCurrentSubtitle() {
    if (!this.currentSubtitle || !this.currentSubtitle.text.trim()) {
      this.subtitleBoxEl.classList.add('ks-empty');
      this.subtitleBoxEl.innerHTML = '';
      return;
    }

    const lines = this.currentSubtitle.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-2);

    this.subtitleBoxEl.classList.remove('ks-empty');
    this.subtitleBoxEl.innerHTML = '';

    const furiganaMode = this.settings.overlay.furiganaMode;
    const isTwoSpeakers = lines.length >= 2;
    const allTokens: Token[] = [];

    lines.forEach((lineText, rowIdx) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'ks-sub-row';
      if (isTwoSpeakers) {
        rowEl.classList.add(rowIdx === 0 ? 'ks-speaker-top' : 'ks-speaker-bottom');
      }

      const tokens = tokenizeJapanese(
        lineText,
        this.vocabMap,
        this.readingCache,
        this.verifiedCompounds
      );
      allTokens.push(...tokens);

      for (const token of tokens) {
        const span = document.createElement('span');
        span.className = `ks-token ks-status-${token.status}`;
        if (token.isWord) {
          span.classList.add('ks-word');
        }
        if (
          (token.status === 'unknown' && !this.settings.overlay.highlightUnknown) ||
          (token.status === 'learning' && !this.settings.overlay.highlightLearning)
        ) {
          span.classList.add('ks-no-highlight');
        }

        const showFurigana =
          token.hasKanji &&
          token.reading &&
          (furiganaMode === 'all' ||
            (furiganaMode === 'unknown_and_learning' && (token.status === 'unknown' || token.status === 'learning')));

        if (showFurigana && token.reading) {
          const ruby = document.createElement('ruby');
          ruby.textContent = token.surface;
          const rt = document.createElement('rt');
          rt.textContent = token.reading;
          ruby.appendChild(rt);
          span.appendChild(ruby);
        } else {
          span.textContent = token.surface;
        }

        if (token.isWord) {
          span.addEventListener('mouseenter', () => {
            if (this.hoverCloseTimer) {
              clearTimeout(this.hoverCloseTimer);
              this.hoverCloseTimer = null;
            }
            this.activeRowSentence = lineText;
            void this.openPopoverForToken(token, span);
          });
          span.addEventListener('click', (e) => {
            e.stopPropagation();
            this.activeRowSentence = lineText;
            void this.openPopoverForToken(token, span);
          });
        }

        rowEl.appendChild(span);
      }

      this.subtitleBoxEl.appendChild(rowEl);
    });

    // Silently prefetch dictionary entries for words in this subtitle so hovering is instant (0ms)
    this.prefetchSubtitleWords(allTokens);
  }

  private prefetchSubtitleWords(tokens: Token[]) {
    // 1. Verify adjacent kanji pairs against JMdict/Jisho (exactOnly: true) — only merge if it's a REAL dictionary word!
    const compoundCandidates = findCandidateCompounds(tokens)
      .filter((c) => !this.checkedCompounds.has(c) && !this.verifiedCompounds.has(c))
      .slice(0, 4);

    if (compoundCandidates.length > 0) {
      const renderedSubId = this.currentSubtitle?.id;
      for (const compound of compoundCandidates) {
        this.checkedCompounds.add(compound);
        void safeSendMessage<{ entry?: DictionaryEntry | null }>({
          type: 'LOOKUP_WORD',
          word: compound,
          exactOnly: true,
        }).then((res) => {
          const entry = res?.entry;
          if (entry && (entry.word === compound || entry.reading === compound)) {
            this.verifiedCompounds.add(compound);
            this.entryCache.set(compound, entry);
            if (entry.reading) {
              this.readingCache[compound] = entry.reading;
            }
            if (
              this.currentSubtitle?.id === renderedSubId &&
              !this.popoverEl.classList.contains('ks-open')
            ) {
              this.renderCurrentSubtitle();
            }
          }
        });
      }
    }

    // 2. Prefetch regular content words so hovering is instant (0ms)
    const toFetch = tokens
      .filter((t) => t.isWord && t.status !== 'ignored')
      .filter((t) => !this.entryCache.has(t.baseForm) && !lookupLocal(t.baseForm))
      .slice(0, 8);

    for (const token of toFetch) {
      void safeSendMessage<{ entry?: DictionaryEntry | null }>({
        type: 'LOOKUP_WORD',
        word: token.baseForm,
        surface: token.surface,
      }).then((res) => {
        const entry = res?.entry;
        if (entry) {
          this.entryCache.set(token.baseForm, entry);
          if (entry.reading) {
            this.readingCache[token.baseForm] = entry.reading;
            this.readingCache[token.surface] = entry.reading;
          }
        }
      });
    }
  }

  private positionPopoverAboveSubtitles(anchorEl: HTMLElement) {
    const tokenRect = anchorEl.getBoundingClientRect();
    const subRect = this.subtitleBoxEl.getBoundingClientRect();
    const popWidth = 340;
    const left = Math.max(
      12,
      Math.min(window.innerWidth - popWidth - 12, tokenRect.left + tokenRect.width / 2 - popWidth / 2)
    );

    // Anchor the popover's BOTTOM edge cleanly above the entire subtitle box so growing height
    // expands upward and NEVER covers the subtitles!
    const anchorTop = Math.min(tokenRect.top, subRect.top);
    const bottomPx = Math.max(12, window.innerHeight - anchorTop + 12);
    const maxHeightPx = Math.max(180, anchorTop - 24);

    this.popoverEl.style.left = `${left}px`;
    this.popoverEl.style.top = 'auto';
    this.popoverEl.style.bottom = `${bottomPx}px`;
    this.popoverEl.style.maxHeight = `${maxHeightPx}px`;
    this.popoverEl.style.overflowY = 'auto';
  }

  private async openPopoverForToken(token: Token, anchorEl: HTMLElement) {
    this.activeToken = token;

    if (this.settings.overlay.autoPauseOnHover && this.video && !this.video.paused) {
      this.video.pause();
      this.pausedByOverlay = true;
    }

    // Highlight selected token
    this.subtitleBoxEl.querySelectorAll('.ks-selected').forEach((el) => el.classList.remove('ks-selected'));
    anchorEl.classList.add('ks-selected');

    this.positionPopoverAboveSubtitles(anchorEl);
    this.popoverEl.classList.add('ks-open');

    // 1. Instant 0ms check: in-memory prefetched cache or local core dictionary
    const cached =
      this.entryCache.get(token.baseForm) ??
      this.entryCache.get(token.surface) ??
      lookupLocal(token.baseForm) ??
      lookupLocal(token.surface);

    if (cached) {
      this.activeEntry = cached;
      this.renderPopoverContent(token, cached, false);
      return;
    }

    // 2. Not cached yet -> show compact loading state and fetch via background worker
    this.activeEntry = null;
    this.renderPopoverContent(token, null, true);

    try {
      const response = await safeSendMessage<{ entry?: DictionaryEntry | null }>({
        type: 'LOOKUP_WORD',
        word: token.baseForm,
        surface: token.surface,
      });

      if (this.activeToken?.surface !== token.surface) return;

      const entry = response?.entry ?? null;
      this.activeEntry = entry;
      if (entry) {
        this.entryCache.set(token.baseForm, entry);
        if (entry.reading) {
          this.readingCache[token.baseForm] = entry.reading;
          this.readingCache[token.surface] = entry.reading;
        }
      }
      this.renderPopoverContent(token, entry, false);
    } catch {
      if (this.activeToken?.surface === token.surface) {
        this.renderPopoverContent(token, null, false);
      }
    }
  }

  private renderPopoverContent(token: Token, entry: DictionaryEntry | null, loading: boolean) {
    const word = entry?.word || token.baseForm;
    const reading = entry?.reading || token.reading || '';
    const lookupCandidates = Array.from(
      new Set([word, token.baseForm, token.surface, ...(entry?.altForms ?? []), ...deconjugate(token.surface)])
    );
    const matchedVocab = findVocabEntry(lookupCandidates, reading || undefined, this.vocabMap);
    const currentStatus = matchedVocab?.entry.status ?? token.status;

    const badgesHtml = [
      ...(entry?.jlpt ?? []).map((j) => `<span class="ks-badge">${escapeHtml(j)}</span>`),
      entry?.isCommon ? `<span class="ks-badge common">Common</span>` : '',
    ].join('');

    let sensesHtml = '';
    if (loading) {
      sensesHtml = `<div class="ks-def" style="color:#94a3b8">Looking up in JMdict…</div>`;
    } else if (entry && entry.senses.length > 0) {
      sensesHtml = entry.senses
        .map(
          (s, idx) => `
          <div class="ks-sense">
            ${s.partsOfSpeech.length ? `<span class="ks-pos">${escapeHtml(s.partsOfSpeech.join(', '))}</span>` : ''}
            <div class="ks-def">${idx + 1}. ${escapeHtml(s.definitions.join('; '))}</div>
          </div>`
        )
        .join('');
    } else {
      sensesHtml = `<div class="ks-def" style="color:#94a3b8">No dictionary entry found for “${escapeHtml(token.surface)}”.</div>`;
    }

    this.popoverEl.innerHTML = `
      <div class="ks-pop-header">
        <div>
          <div class="ks-pop-word">${escapeHtml(word)}</div>
          ${reading && reading !== word ? `<div class="ks-pop-reading">${escapeHtml(reading)}</div>` : ''}
        </div>
        <div class="ks-badges">${badgesHtml}</div>
      </div>
      <div class="ks-pop-senses">${sensesHtml}</div>
      <div class="ks-status-row">
        <button class="ks-status-btn ${currentStatus === 'unknown' ? 'active-unknown' : ''}" data-set-status="unknown">Unknown</button>
        <button class="ks-status-btn ${currentStatus === 'learning' ? 'active-learning' : ''}" data-set-status="learning">Learning</button>
        <button class="ks-status-btn ${currentStatus === 'known' ? 'active-known' : ''}" data-set-status="known">Known</button>
      </div>
      <div class="ks-pop-actions">
        <button class="ks-btn ks-btn-primary" data-mine="srs">${this.settings.anki.enabled ? 'Mine Card + Anki' : 'Mine Flashcard'}</button>
      </div>
    `;

    this.popoverEl.querySelectorAll<HTMLButtonElement>('[data-set-status]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const status = btn.dataset.setStatus as WordStatus;
        const meaning = entry?.senses[0]?.definitions.slice(0, 3).join('; ') ?? '';
        const updated = await setWordStatus(word, status, { reading, meaning });
        this.vocabMap[word] = updated;
        // Also sync an existing kanji/kana alias (e.g. できる <-> 出来る) if already tracked
        if (matchedVocab && matchedVocab.baseForm !== word) {
          const aliasUpdated = await setWordStatus(matchedVocab.baseForm, status, { reading, meaning });
          this.vocabMap[matchedVocab.baseForm] = aliasUpdated;
        }
        this.renderCurrentSubtitle();
        this.renderPopoverContent({ ...token, status }, entry, false);
        this.showToast(`Marked “${word}” as ${status}`);
      });
    });

    const mineBtn = this.popoverEl.querySelector<HTMLButtonElement>('[data-mine="srs"]');
    mineBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      mineBtn.disabled = true;
      mineBtn.textContent = this.settings.anki.openPreviewBeforeSaving ? 'Preparing…' : 'Mining…';
      await this.startMineWorkflow(token.surface, word, reading, entry);
      mineBtn.disabled = false;
      mineBtn.textContent = this.settings.anki.enabled ? 'Mine Card + Anki' : 'Mine Flashcard';
    });
  }

  private async captureVideoFrame(): Promise<{
    dataUrl?: string;
    format?: ScreenshotFormat;
    meta?: string;
  }> {
    if (!this.settings.anki.includeScreenshot) return {};
    const shot = await captureCleanVideoScreenshot(
      this.video,
      {
        format: this.settings.anki.screenshotFormat,
        maxHeight: this.settings.anki.screenshotMaxHeight,
        quality: this.settings.anki.screenshotQuality,
      },
      () => {
        this.host.style.visibility = 'hidden';
      },
      () => {
        this.host.style.visibility = 'visible';
      }
    );
    if (!shot) return {};
    return {
      dataUrl: shot.dataUrl,
      format: shot.format,
      meta: `${shot.width}×${shot.height} ${shot.format.toUpperCase()} (${shot.method === 'canvas' ? 'clean frame' : 'DRM video crop'})`,
    };
  }

  private async fetchSentenceTranslation(sentence: string, targetWord?: string): Promise<string> {
    if (!this.settings.anki.autoTranslate || this.settings.anki.translationProvider === 'off') {
      return '';
    }
    const res = await safeSendMessage<{ translation?: string }>({
      type: 'TRANSLATE_SENTENCE',
      sentence,
      targetWord,
    });
    return res?.translation?.trim() ?? '';
  }

  private async startMineWorkflow(
    surfaceWord: string,
    word: string,
    reading: string,
    entry: DictionaryEntry | null
  ) {
    // Pause video cleanly while capturing / previewing
    if (this.video && !this.video.paused) {
      this.video.pause();
      this.pausedByOverlay = true;
    }

    const sentence = this.activeRowSentence ?? this.currentSubtitle?.text ?? word;
    const meaning =
      entry?.senses
        .slice(0, 3)
        .map((s) => s.definitions.slice(0, 3).join('; '))
        .join('\n') || '(No definition)';

    // Hide dictionary popover before capturing DRM-safe screenshot so the frame is 100% clean
    this.popoverEl.classList.remove('ks-open');

    const draft: CardDraft = {
      word,
      surfaceWord,
      reading,
      meaning,
      sentence,
      translation: '',
      notes: '',
      cardType: this.settings.anki.cardType,
      sourceTitle: this.adapter.getMediaTitle(),
      sourceUrl: window.location.href,
      translating: this.settings.anki.autoTranslate && this.settings.anki.translationProvider !== 'off',
      capturingShot: this.settings.anki.includeScreenshot,
    };

    // Capture clean video screenshot & audio clip first (before opening modal so modal isn't in the frame!)
    const [shot, audioRes] = await Promise.all([
      this.captureVideoFrame(),
      this.settings.anki.includeAudio
        ? safeSendMessage<{ audioBase64?: string; mimeType?: string }>({ type: 'REQUEST_RECENT_AUDIO' })
        : Promise.resolve(undefined),
    ]);

    draft.screenshotDataUrl = shot.dataUrl;
    draft.screenshotFormat = shot.format;
    draft.screenshotMeta = shot.meta;
    draft.capturingShot = false;
    draft.audioBase64 = (audioRes as { audioBase64?: string })?.audioBase64;
    draft.audioMimeType = (audioRes as { mimeType?: string })?.mimeType;

    if (!this.settings.anki.openPreviewBeforeSaving) {
      draft.translation = await this.fetchSentenceTranslation(sentence, word);
      draft.translating = false;
      await this.commitCardDraft(draft);
      return;
    }

    // Open Migaku-style Card Creator Modal immediately while translation resolves asynchronously
    this.cardDraft = draft;
    this.openCardCreatorModal();

    if (draft.translating) {
      const translated = await this.fetchSentenceTranslation(sentence, word);
      if (this.cardDraft === draft) {
        draft.translation = translated;
        draft.translating = false;
        const transInput = this.modalBackdropEl.querySelector<HTMLTextAreaElement>('[data-draft-field="translation"]');
        if (transInput && !transInput.value.trim()) {
          transInput.value = translated;
        }
        const transStatus = this.modalBackdropEl.querySelector<HTMLElement>('[data-trans-status]');
        if (transStatus) transStatus.textContent = translated ? 'Auto-translated' : '';
        this.refreshModalPreview();
      }
    }
  }

  private openCardCreatorModal() {
    const d = this.cardDraft;
    if (!d) return;

    this.modalBackdropEl.innerHTML = `
      <div class="ks-modal" role="dialog" aria-label="KotoStream Card Creator">
        <div class="ks-modal-header">
          <div class="ks-modal-title">
            <span>Card Creator</span>
            <span class="ks-badge">${escapeHtml(this.settings.anki.deckName)}</span>
            <span class="ks-badge common">${escapeHtml(this.settings.anki.modelName)}</span>
          </div>
          <button class="ks-btn" data-modal-action="close">✕</button>
        </div>

        <div class="ks-modal-body">
          <div class="ks-modal-editor">
            <div class="ks-field-row">
              <div class="ks-field">
                <label>Target Word</label>
                <input type="text" data-draft-field="word" value="${escapeHtml(d.word)}" />
              </div>
              <div class="ks-field">
                <label>Reading (Furigana)</label>
                <input type="text" data-draft-field="reading" value="${escapeHtml(d.reading)}" />
              </div>
            </div>

            <div class="ks-field-row">
              <div class="ks-field">
                <label>Card Type</label>
                <select data-draft-field="cardType">
                  <option value="sentence" ${d.cardType === 'sentence' ? 'selected' : ''}>Sentence Card</option>
                  <option value="word" ${d.cardType === 'word' ? 'selected' : ''}>Word Card</option>
                  <option value="audio_sentence" ${d.cardType === 'audio_sentence' ? 'selected' : ''}>Audio Sentence Card</option>
                </select>
              </div>
              <div class="ks-field">
                <label>Source</label>
                <input type="text" data-draft-field="sourceTitle" value="${escapeHtml(d.sourceTitle)}" />
              </div>
            </div>

            <div class="ks-field">
              <label>Sentence</label>
              <textarea rows="2" data-draft-field="sentence">${escapeHtml(d.sentence)}</textarea>
            </div>

            <div class="ks-field">
              <label>
                <span>Sentence Translation <span data-trans-status style="color:#a5b4fc;font-weight:500;margin-left:6px">${d.translating ? 'Translating…' : ''}</span></span>
                <button type="button" class="ks-btn" style="padding:2px 8px;font-size:11px" data-modal-action="retranslate">Re-translate</button>
              </label>
              <textarea rows="2" data-draft-field="translation" placeholder="English translation of the sentence…">${escapeHtml(d.translation)}</textarea>
            </div>

            <div class="ks-field">
              <label>Definitions</label>
              <textarea rows="3" data-draft-field="meaning">${escapeHtml(d.meaning)}</textarea>
            </div>

            <div class="ks-field">
              <label>Notes (optional)</label>
              <input type="text" data-draft-field="notes" value="${escapeHtml(d.notes)}" placeholder="Grammar nuance, context, etc." />
            </div>

            <div class="ks-shot-box">
              ${
                d.screenshotDataUrl
                  ? `<img class="ks-shot-img" data-shot-img src="${d.screenshotDataUrl}" alt="Video screenshot" />`
                  : `<div style="color:#94a3b8;font-size:12px;text-align:center;padding:18px" data-shot-empty>No screenshot captured</div>`
              }
              <div class="ks-shot-bar">
                <span data-shot-meta>${escapeHtml(d.screenshotMeta || 'Clean video frame')}</span>
                <div style="display:flex;gap:6px">
                  <button type="button" class="ks-btn" style="padding:3px 9px;font-size:11px" data-modal-action="retake-shot">Retake Screenshot</button>
                  ${d.screenshotDataUrl ? `<button type="button" class="ks-btn" style="padding:3px 9px;font-size:11px" data-modal-action="remove-shot">Remove</button>` : ''}
                </div>
              </div>
            </div>

            ${
              d.audioBase64
                ? `<div style="display:flex;align-items:center;justify-content:space-between">
                    <span class="ks-preview-audio-badge">🔊 Sentence audio captured</span>
                    <button type="button" class="ks-btn" data-modal-action="play-audio">▶ Play Clip</button>
                   </div>`
                : `<div style="font-size:11px;color:#94a3b8">Audio clip: Start Live AI Subs to capture sentence audio automatically.</div>`
            }
          </div>

          <div class="ks-modal-preview">
            <div class="ks-preview-heading">
              <span>Live Anki Field Preview</span>
              <span style="font-size:11px;color:#94a3b8;font-weight:500">${escapeHtml(this.settings.anki.furiganaFormat.replace('_', ' '))}</span>
            </div>
            <div data-preview-fields style="display:flex;flex-direction:column;gap:8px"></div>
          </div>
        </div>

        <div class="ks-modal-footer">
          <span style="font-size:11px;color:#94a3b8">
            ${this.settings.anki.enabled ? 'Will save to built-in SRS and export to AnkiConnect' : 'Will save to built-in SRS (enable AnkiConnect in Settings to auto-export)'}
          </span>
          <div style="display:flex;gap:8px">
            <button type="button" class="ks-btn" data-modal-action="close">Cancel</button>
            <button type="button" class="ks-btn ks-btn-primary" data-modal-action="save">
              ${this.settings.anki.enabled ? 'Create Card & Send to Anki' : 'Create Card'}
            </button>
          </div>
        </div>
      </div>
    `;

    this.modalBackdropEl.classList.add('ks-open');
    this.refreshModalPreview();
    this.bindModalEvents();
  }

  private bindModalEvents() {
    const d = this.cardDraft;
    if (!d) return;

    // Live-bind every editable input to update draft & preview
    this.modalBackdropEl
      .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-draft-field]')
      .forEach((el) => {
        el.addEventListener('input', () => {
          const field = el.dataset.draftField as keyof CardDraft;
          if (field === 'word') d.word = el.value;
          else if (field === 'reading') d.reading = el.value;
          else if (field === 'sentence') d.sentence = el.value;
          else if (field === 'translation') d.translation = el.value;
          else if (field === 'meaning') d.meaning = el.value;
          else if (field === 'notes') d.notes = el.value;
          else if (field === 'sourceTitle') d.sourceTitle = el.value;
          else if (field === 'cardType') d.cardType = el.value as CardType;
          this.refreshModalPreview();
        });
      });

    this.modalBackdropEl.onclick = async (e) => {
      e.stopPropagation();
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-modal-action]');
      if (!target) return;

      const action = target.dataset.modalAction;
      if (action === 'close') {
        this.closeCardCreatorModal();
      } else if (action === 'play-audio' && d.audioBase64) {
        const mime = d.audioMimeType || 'audio/webm';
        const audio = new Audio(`data:${mime};base64,${d.audioBase64}`);
        void audio.play();
      } else if (action === 'retranslate') {
        const statusEl = this.modalBackdropEl.querySelector<HTMLElement>('[data-trans-status]');
        if (statusEl) statusEl.textContent = 'Translating…';
        const translated = await this.fetchSentenceTranslation(d.sentence, d.word);
        d.translation = translated;
        const transInput = this.modalBackdropEl.querySelector<HTMLTextAreaElement>('[data-draft-field="translation"]');
        if (transInput) transInput.value = translated;
        if (statusEl) statusEl.textContent = translated ? 'Updated' : 'Unavailable';
        this.refreshModalPreview();
      } else if (action === 'retake-shot') {
        const shot = await this.captureVideoFrame();
        d.screenshotDataUrl = shot.dataUrl;
        d.screenshotFormat = shot.format;
        d.screenshotMeta = shot.meta;
        this.openCardCreatorModal();
      } else if (action === 'remove-shot') {
        d.screenshotDataUrl = undefined;
        d.screenshotMeta = 'Screenshot removed';
        this.openCardCreatorModal();
      } else if (action === 'save') {
        const saveBtn = target as HTMLButtonElement;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        await this.commitCardDraft(d);
        this.closeCardCreatorModal();
      }
    };
  }

  private refreshModalPreview() {
    const d = this.cardDraft;
    if (!d) return;
    const container = this.modalBackdropEl.querySelector<HTMLElement>('[data-preview-fields]');
    if (!container) return;

    const previewFields = buildAnkiFieldPreview(
      {
        word: d.word,
        surfaceWord: d.surfaceWord,
        reading: d.reading,
        meaning: d.meaning,
        sentence: d.sentence,
        translation: d.translation,
        notes: d.notes,
        cardType: d.cardType,
        sourceTitle: d.sourceTitle,
        sourceUrl: d.sourceUrl,
        screenshotDataUrl: d.screenshotDataUrl,
        audioBase64: d.audioBase64,
      },
      this.settings.anki
    );

    if (previewFields.length === 0) {
      container.innerHTML = `<div style="color:#94a3b8;font-size:12px">No Anki fields mapped yet. Configure Field Mapping in Settings.</div>`;
      return;
    }

    container.innerHTML = previewFields
      .map(
        (f) => `
        <div class="ks-preview-field">
          <div class="ks-preview-label">${escapeHtml(f.fieldName)}</div>
          <div class="ks-preview-val">${f.html}</div>
        </div>`
      )
      .join('');
  }

  private closeCardCreatorModal() {
    this.modalBackdropEl.classList.remove('ks-open');
    this.modalBackdropEl.innerHTML = '';
    this.cardDraft = null;
  }

  private async commitCardDraft(d: CardDraft) {
    const card = await addMinedCard({
      word: d.word.trim() || d.surfaceWord,
      surfaceWord: d.surfaceWord,
      reading: d.reading.trim(),
      meaning: d.meaning.trim() || '(No definition)',
      sentence: d.sentence.trim(),
      translation: d.translation.trim() || undefined,
      notes: d.notes.trim() || undefined,
      cardType: d.cardType,
      sourceTitle: d.sourceTitle.trim() || this.adapter.getMediaTitle(),
      sourceUrl: d.sourceUrl,
      screenshotDataUrl: d.screenshotDataUrl,
      screenshotFormat: d.screenshotFormat,
      audioBase64: d.audioBase64,
      audioMimeType: d.audioMimeType,
    });

    this.vocabMap[card.word] = {
      word: card.word,
      reading: card.reading,
      meaning: card.meaning,
      status: 'learning',
      encounters: (this.vocabMap[card.word]?.encounters ?? 0) + 1,
      firstSeenAt: this.vocabMap[card.word]?.firstSeenAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this.renderCurrentSubtitle();

    if (this.settings.anki.enabled) {
      try {
        await exportCardToAnki(card, this.settings.anki);
        this.showToast(`Created “${card.word}” → Saved to SRS & Anki!`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'AnkiConnect unavailable';
        this.showToast(`Saved to SRS (Anki failed: ${msg})`);
      }
    } else {
      this.showToast(`Created “${card.word}” in built-in SRS!`);
    }
  }

  private schedulePopoverClose() {
    if (this.hoverCloseTimer) clearTimeout(this.hoverCloseTimer);
    this.hoverCloseTimer = window.setTimeout(() => {
      this.closePopover();
    }, 240);
  }

  private closePopover() {
    this.popoverEl.classList.remove('ks-open');
    this.subtitleBoxEl.querySelectorAll('.ks-selected').forEach((el) => el.classList.remove('ks-selected'));
    this.activeToken = null;

    if (this.pausedByOverlay && this.settings.overlay.autoResumeOnLeave && this.video?.paused) {
      void this.video.play().catch(() => {});
    }
    this.pausedByOverlay = false;
  }

  private async toggleLiveCapture() {
    const isActive =
      this.captureState.status === 'listening' ||
      this.captureState.status === 'transcribing' ||
      this.captureState.status === 'starting';

    const type = isActive ? 'STOP_CAPTURE' : 'START_CAPTURE';
    const nextState = await safeSendMessage<CaptureState>({ type });
    if (nextState?.status) {
      this.updateCaptureState(nextState);
    }
  }

  private cycleFuriganaMode() {
    const order: FuriganaMode[] = ['unknown_and_learning', 'all', 'off'];
    const idx = order.indexOf(this.settings.overlay.furiganaMode);
    this.settings.overlay.furiganaMode = order[(idx + 1) % order.length];
    this.updateFuriganaLabel();
    this.renderCurrentSubtitle();
    this.showToast(`Furigana: ${this.settings.overlay.furiganaMode.replace(/_/g, ' ')}`);
  }

  private updateFuriganaLabel() {
    const mode = this.settings.overlay.furiganaMode;
    this.furiganaBtn.textContent =
      mode === 'all' ? '振り仮名: All' : mode === 'off' ? '振り仮名: Off' : '振り仮名: Smart';
  }

  private renderSidebar() {
    const titleEl = this.sidebarEl.querySelector('.ks-sidebar-header span');
    if (titleEl) titleEl.textContent = 'Transcript History';

    if (this.subtitleHistory.length === 0) {
      this.sidebarListEl.innerHTML = `<div style="color:#94a3b8;font-size:12px;padding:12px;text-align:center">No subtitles yet. Load an .srt/.ass file, pick from Library, or start AI Subs.</div>`;
      return;
    }

    this.sidebarListEl.innerHTML = this.subtitleHistory
      .slice(0, 120)
      .map((line) => {
        const timeStr =
          line.videoTimeSec !== undefined
            ? formatSeconds(line.videoTimeSec)
            : new Date(line.timestampMs).toLocaleTimeString();
        const badge = line.latencyMs ? `${line.latencyMs}ms` : line.source;
        return `
          <div class="ks-history-item" data-sub-id="${escapeHtml(line.id)}">
            <div class="ks-history-meta"><span>${escapeHtml(timeStr)}</span><span>${escapeHtml(badge)}</span></div>
            <div class="ks-history-text">${escapeHtml(line.text)}</div>
          </div>`;
      })
      .join('');
  }

  private async renderLibrarySidebar() {
    const titleEl = this.sidebarEl.querySelector('.ks-sidebar-header span');
    if (titleEl) titleEl.textContent = 'Subtitle Library';

    const lib = await getSubtitleLibrary();
    const headerBtn = `
      <div style="margin-bottom:8px">
        <button class="ks-btn ks-btn-primary" style="width:100%;justify-content:center" data-action="open-subtitles-dashboard">
          Search Jimaku / Pre-Generate Subtitles
        </button>
      </div>`;

    if (lib.length === 0) {
      this.sidebarListEl.innerHTML =
        headerBtn +
        `<div style="color:#94a3b8;font-size:12px;padding:12px;text-align:center">No saved subtitle tracks yet. Search Jimaku.cc or import/pre-generate an .srt file in the Dashboard!</div>`;
      return;
    }

    this.sidebarListEl.innerHTML =
      headerBtn +
      lib
        .map((track) => {
          const isCurrent = track.id === this.activeTrackId;
          return `
            <div class="ks-history-item" data-track-id="${escapeHtml(track.id)}" style="${isCurrent ? 'border-color:#818cf8;background:rgba(99,102,241,0.22)' : ''}">
              <div class="ks-history-meta">
                <span>${escapeHtml(track.source.toUpperCase())} · ${track.cues.length} lines</span>
                <span>${isCurrent ? 'Active' : this.formatOffset(track.offsetSec)}</span>
              </div>
              <div class="ks-history-text" style="font-weight:600">${escapeHtml(track.title || track.fileName)}</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:2px">${escapeHtml(track.fileName)}</div>
            </div>`;
        })
        .join('');
  }

  public showToast(message: string) {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('ks-visible');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('ks-visible');
    }, 3000);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSeconds(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}
