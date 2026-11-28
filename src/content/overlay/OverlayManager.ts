import overlayCss from './overlay.css?raw';
import type {
  AppSettings,
  CaptureState,
  DictionaryEntry,
  FuriganaMode,
  SavedSubtitleTrack,
  ScreenshotFormat,
  SubtitleLine,
  Token,
  VocabEntry,
  WordStatus,
} from '../../types';
import { findCandidateCompounds, findVocabEntry, tokenizeJapanese } from '../../core/tokenizer';
import { buildTokensFromMorphemes, type KuromojiMorpheme } from '../../core/mecab-tokenizer';
import { deconjugate } from '../../core/deconjugator';
import { lookupLocal } from '../../core/dictionary';
import { parseSubtitleFile, findActiveSubtitlesAtTime, findCueIndexNearTime } from '../../core/subtitle-parser';
import { alignFuriganaSegments } from '../../core/furigana';
import { mergeLiveSubtitle } from '../../core/subtitle-merge';
import {
  addMinedCard,
  bindSubtitleTrackToUrl,
  findSubtitleTrackForUrl,
  getSubtitleLibrary,
  saveSettings,
  saveSubtitleTrack,
  setWordStatus,
  updateMinedCard,
  updateSubtitleTrackOffset,
} from '../../core/storage';
import { exportCardToAnki } from '../../core/anki';
import { captureCleanVideoScreenshot } from '../screenshot';
import type { SiteAdapter } from '../adapters/base';
import { escapeHtml, formatSeconds, playBase64Audio, safeSendMessage } from './utils';
import { ClipCaptureController } from './ClipCaptureController';
import { CardCreatorModal, type CardDraft } from './CardCreatorModal';
import { OVERLAY_ICONS } from './icons';

/** How many transcript lines to render above/below the active line in the sidebar browser. */
const BROWSER_WINDOW_LINES = 80;

export class OverlayManager {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private adapter: SiteAdapter;
  private video: HTMLVideoElement | null = null;
  private mountedContainer: HTMLElement | null = null;
  private docListenersAttached = false;

  private settings: AppSettings;
  private vocabMap: Record<string, VocabEntry> = {};
  private readingCache: Record<string, string> = {};
  private entryCache = new Map<string, DictionaryEntry>();
  private morphemeCache = new Map<string, KuromojiMorpheme[]>();
  private pendingMorphemeRequests = new Set<string>();
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
  private sidebarMode: 'browser' | 'library' = 'browser';
  private browserActiveIds: Set<string> = new Set();
  private browserWindowRange: { start: number; end: number } | null = null;
  private browserFollowLive = true;
  private browserLinesCache: SubtitleLine[] | null = null;
  private browserLinesById = new Map<string, SubtitleLine>();
  private browserTokenObserver: IntersectionObserver | null = null;
  private browserSearchQuery = '';
  private toolbarCollapsed = false;

  private activeToken: Token | null = null;
  /** Cue id of the line the open popover's word belongs to (keeps ks-selected across re-renders) */
  private activePopoverCueId: string | null = null;
  private activeRowSentence: string | null = null;
  private activeCuesForCurrentSub: SubtitleLine[] = [];
  private activeRowRange: { startSec: number; endSec: number } | null = null;
  private lastVideoSyncSentAt = 0;
  private pausedByOverlay = false;
  private hoverCloseTimer: number | null = null;
  private toastTimer: number | null = null;

  private clipCapture: ClipCaptureController;
  private cardModal!: CardCreatorModal;

  // DOM refs inside Shadow DOM
  private toolbarEl!: HTMLDivElement;
  private toolbarToggleBtn!: HTMLButtonElement;
  private dotEl!: HTMLSpanElement;
  private toggleCaptureBtn!: HTMLButtonElement;
  private furiganaBtn!: HTMLButtonElement;
  private syncGroupEl!: HTMLSpanElement;
  private syncLabelBtn!: HTMLButtonElement;
  private statusPillEl!: HTMLSpanElement;
  private subtitleBoxEl!: HTMLDivElement;
  private popoverEl!: HTMLDivElement;
  private sidebarEl!: HTMLDivElement;
  private sidebarSearchWrapEl!: HTMLDivElement;
  private sidebarSearchInputEl!: HTMLInputElement;
  private sidebarListEl!: HTMLDivElement;
  private toastEl!: HTMLDivElement;
  private fileInputEl!: HTMLInputElement;
  private modalBackdropEl!: HTMLDivElement;

  constructor(adapter: SiteAdapter, settings: AppSettings, vocabMap: Record<string, VocabEntry>) {
    this.adapter = adapter;
    this.settings = settings;
    this.vocabMap = vocabMap;

    this.clipCapture = new ClipCaptureController({
      getVideo: () => this.video,
      getCaptureState: () => this.captureState,
      emitVideoTimeSync: (force, seeked) => this.emitVideoTimeSync(force, seeked),
      showToast: (msg) => this.showToast(msg),
    });

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
      <span class="ks-brand" data-action="brand-click" title="KotoStream (Alt+H to collapse/expand)"><span class="ks-dot"></span>KotoStream</span>
      <span class="ks-toolbar-controls">
        <span class="ks-toolbar-sep" aria-hidden="true"></span>
        <button class="ks-btn ks-btn-primary" data-action="toggle-capture" title="Silently pre-scan episode at 4x to generate Japanese subtitles">${OVERLAY_ICONS.sparkles} AI Pre-Scan</button>
        <span class="ks-toolbar-sep" aria-hidden="true"></span>
        <button class="ks-btn" data-action="toggle-furigana" title="Cycle Furigana mode (Alt+F)">振り仮名</button>
        <button class="ks-btn" data-action="toggle-library" title="Saved Subtitle Library &amp; Jimaku">Library</button>
        <button class="ks-btn" data-action="load-file" title="Load .srt, .vtt, or .ass Japanese subtitles">Load Sub</button>
        <span class="ks-sync-group">
          <button class="ks-btn" data-action="sync-minus" title="Show subtitles 0.5s earlier">-0.5s</button>
          <button class="ks-btn" data-action="sync-reset" title="Click to reset sync offset to 0s">0.0s</button>
          <button class="ks-btn" data-action="sync-plus" title="Delay subtitles by 0.5s">+0.5s</button>
        </span>
        <span class="ks-toolbar-sep" aria-hidden="true"></span>
        <button class="ks-btn" data-action="toggle-sidebar" title="Subtitle browser — browse past &amp; upcoming lines (Alt+S)">Subtitles</button>
        <button class="ks-btn ks-btn-icon" data-action="open-settings" title="Settings &amp; Anki" aria-label="Settings &amp; Anki">${OVERLAY_ICONS.settings}</button>
        <span class="ks-status-pill"></span>
      </span>
      <button class="ks-btn ks-btn-icon" data-action="toggle-toolbar" title="Collapse toolbar (Alt+H)" aria-label="Collapse toolbar">${OVERLAY_ICONS.chevronRight}</button>
    `;
    this.shadow.appendChild(this.toolbarEl);

    this.dotEl = this.toolbarEl.querySelector('.ks-dot')!;
    this.toolbarToggleBtn = this.toolbarEl.querySelector('[data-action="toggle-toolbar"]')!;
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

    // Sidebar — Migaku-style full transcript browser (past + upcoming lines) & Library
    this.sidebarEl = document.createElement('div');
    this.sidebarEl.className = 'ks-sidebar';
    this.sidebarEl.innerHTML = `
      <div class="ks-sidebar-header">
        <span>Subtitles</span>
        <div class="ks-sidebar-header-actions">
          <button class="ks-btn ks-btn-icon" data-action="follow-live" title="Jump back to the current line" aria-label="Jump to current line">${OVERLAY_ICONS.followDown}</button>
          <button class="ks-btn ks-btn-icon" data-action="close-sidebar" aria-label="Close sidebar">${OVERLAY_ICONS.close}</button>
        </div>
      </div>
      <div class="ks-sidebar-search-wrap">
        ${OVERLAY_ICONS.search}
        <input class="ks-sidebar-search" type="text" placeholder="Filter episode lines…" aria-label="Filter subtitle lines" />
      </div>
      <div class="ks-sidebar-list"></div>
      <button class="ks-follow-btn" data-action="follow-live">${OVERLAY_ICONS.followDown} Follow live</button>
    `;
    this.sidebarSearchWrapEl = this.sidebarEl.querySelector('.ks-sidebar-search-wrap')!;
    this.sidebarSearchInputEl = this.sidebarEl.querySelector('.ks-sidebar-search')!;
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

    this.cardModal = new CardCreatorModal(this.modalBackdropEl, {
      getAnkiSettings: () => this.settings.anki,
      fetchTranslation: (sentence, targetWord) => this.fetchSentenceTranslation(sentence, targetWord),
      captureScreenshot: () => this.captureVideoFrame(),
      commitDraft: (draft) => this.commitCardDraft(draft),
      showToast: (msg) => this.showToast(msg),
      onClose: () => this.handleCardModalClose(),
    });

    this.bindEvents();
    this.updateFuriganaLabel();
  }

  private handleDocumentClick = (e: MouseEvent) => {
    if (!this.host.contains(e.target as Node)) {
      this.closePopover();
    }
  };

  private handleDocumentKeyDown = (e: KeyboardEvent) => {
    if (!this.settings.enabled || this.cardModal.isOpen) return;

    if (e.key === 'Escape' && this.popoverEl.classList.contains('ks-open')) {
      this.closePopover();
      return;
    }

    if (!e.altKey || e.ctrlKey || e.metaKey) return;

    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }

    switch (e.code) {
      case 'KeyF':
        e.preventDefault();
        void this.cycleFuriganaMode();
        break;
      case 'KeyS':
        e.preventDefault();
        this.toggleSubtitleBrowser();
        break;
      case 'KeyH':
        e.preventDefault();
        this.toggleToolbarCollapsed();
        break;
      case 'KeyR':
        e.preventDefault();
        this.replayCurrentSubtitle();
        break;
      case 'BracketLeft':
        e.preventDefault();
        this.jumpRelativeCue(-1);
        break;
      case 'BracketRight':
        e.preventDefault();
        this.jumpRelativeCue(1);
        break;
    }
  };

  private toggleToolbarCollapsed(force?: boolean) {
    this.toolbarCollapsed = force ?? !this.toolbarCollapsed;
    this.toolbarEl.classList.toggle('ks-collapsed', this.toolbarCollapsed);
    this.toolbarToggleBtn.innerHTML = this.toolbarCollapsed
      ? OVERLAY_ICONS.chevronLeft
      : OVERLAY_ICONS.chevronRight;
    const label = this.toolbarCollapsed ? 'Expand toolbar (Alt+H)' : 'Collapse toolbar (Alt+H)';
    this.toolbarToggleBtn.title = label;
    this.toolbarToggleBtn.setAttribute('aria-label', label);
  }

  private toggleSubtitleBrowser() {
    if (this.sidebarEl.classList.contains('ks-open') && this.sidebarMode === 'browser') {
      this.sidebarEl.classList.remove('ks-open');
    } else {
      this.sidebarMode = 'browser';
      this.sidebarEl.classList.add('ks-open');
      this.renderSubtitleBrowser();
    }
  }

  private jumpRelativeCue(delta: -1 | 1) {
    if (!this.video || this.loadedFileSubtitles.length === 0) return;
    const lines = this.loadedFileSubtitles;
    const curIdx = this.getBrowserActiveIdx(lines);
    const nextIdx = Math.max(0, Math.min(lines.length - 1, curIdx + delta));
    const cue = lines[nextIdx];
    if (cue && cue.videoTimeSec !== undefined) {
      this.browserActiveIds = new Set([cue.id]);
      this.video.currentTime = Math.max(0, cue.videoTimeSec + this.subtitleOffsetSec);
      if (this.sidebarEl.classList.contains('ks-open') && this.sidebarMode === 'browser') {
        this.updateBrowserActive();
      }
    }
  }

  private replayCurrentSubtitle() {
    if (!this.video) return;
    const startSec = this.currentSubtitle?.videoTimeSec;
    if (startSec !== undefined && this.currentSubtitle?.source === 'file') {
      this.video.currentTime = Math.max(0, startSec + this.subtitleOffsetSec);
      if (this.video.paused) {
        void this.video.play().catch(() => {});
      }
    } else if (this.loadedFileSubtitles.length > 0) {
      const idx = this.getBrowserActiveIdx(this.loadedFileSubtitles);
      const cue = this.loadedFileSubtitles[idx];
      if (cue?.videoTimeSec !== undefined) {
        this.video.currentTime = Math.max(0, cue.videoTimeSec + this.subtitleOffsetSec);
        if (this.video.paused) {
          void this.video.play().catch(() => {});
        }
      }
    }
  }

  private attachDocumentListeners() {
    if (this.docListenersAttached) return;
    this.docListenersAttached = true;
    document.addEventListener('click', this.handleDocumentClick);
    document.addEventListener('keydown', this.handleDocumentKeyDown);
  }

  private detachDocumentListeners() {
    if (!this.docListenersAttached) return;
    this.docListenersAttached = false;
    document.removeEventListener('click', this.handleDocumentClick);
    document.removeEventListener('keydown', this.handleDocumentKeyDown);
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
          void this.cycleFuriganaMode();
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
          this.toggleSubtitleBrowser();
          break;
        case 'toggle-toolbar':
          this.toggleToolbarCollapsed();
          break;
        case 'brand-click':
          if (this.toolbarCollapsed) {
            this.toggleToolbarCollapsed(false);
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
          void safeSendMessage({ type: 'OPEN_DASHBOARD', tab: 'settings' });
          break;
      }
    });

    this.sidebarEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-action="close-sidebar"]')) {
        this.sidebarEl.classList.remove('ks-open');
        return;
      }
      if (target.closest('[data-action="follow-live"]')) {
        this.setBrowserFollow(true);
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
        this.getBrowserLines();
        const cue = this.browserLinesById.get(item.dataset.subId);
        if (cue) {
          if (cue.videoTimeSec !== undefined && this.video) {
            this.browserActiveIds = new Set([cue.id]);
            this.browserFollowLive = true;
            this.video.currentTime = Math.max(0, cue.videoTimeSec + this.subtitleOffsetSec);
          }
          if (this.sidebarMode === 'browser') {
            this.updateBrowserActive();
          }
        }
      }
    });

    const userScrollHandler = () => this.setBrowserFollow(false);
    this.sidebarListEl.addEventListener('wheel', userScrollHandler, { passive: true });
    this.sidebarListEl.addEventListener('touchmove', userScrollHandler, { passive: true });
    this.sidebarListEl.addEventListener('mousedown', userScrollHandler);

    for (const evt of ['keydown', 'keyup', 'keypress'] as const) {
      this.sidebarSearchInputEl.addEventListener(evt, (e) => e.stopPropagation());
    }
    this.sidebarSearchInputEl.addEventListener('input', () => {
      this.browserSearchQuery = this.sidebarSearchInputEl.value.trim();
      if (this.sidebarMode === 'browser') {
        this.renderSubtitleBrowser();
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
  }

  public ensureMounted() {
    if (!this.settings.enabled) return;
    this.attachDocumentListeners();
    this.host.style.display = '';
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
    if (!this.settings.enabled) return;
    this.video = video;
    this.ensureMounted();

    video.removeEventListener('timeupdate', this.handleVideoTimeUpdate);
    video.removeEventListener('play', this.handleVideoStateSync);
    video.removeEventListener('playing', this.handleVideoStateSync);
    video.removeEventListener('pause', this.handleVideoStateSync);
    video.removeEventListener('seeked', this.handleVideoSeeked);
    video.removeEventListener('ratechange', this.handleVideoStateSync);

    video.addEventListener('timeupdate', this.handleVideoTimeUpdate);
    video.addEventListener('play', this.handleVideoStateSync);
    video.addEventListener('playing', this.handleVideoStateSync);
    video.addEventListener('pause', this.handleVideoStateSync);
    video.addEventListener('seeked', this.handleVideoSeeked);
    video.addEventListener('ratechange', this.handleVideoStateSync);
    this.emitVideoTimeSync(true);

    if (this.lastAutoLoadedUrl !== window.location.href) {
      this.lastAutoLoadedUrl = window.location.href;
      void this.tryAutoLoadSavedTrack();
    }
  }

  public unmount() {
    this.detachDocumentListeners();
    if (this.hoverCloseTimer) {
      clearTimeout(this.hoverCloseTimer);
      this.hoverCloseTimer = null;
    }
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    if (this.browserTokenObserver) {
      this.browserTokenObserver.disconnect();
      this.browserTokenObserver = null;
    }
    this.closePopover();
    this.cardModal.close();
    this.sidebarEl.classList.remove('ks-open');
    this.toastEl.classList.remove('ks-visible');
    this.subtitleBoxEl.classList.add('ks-empty');
    this.subtitleBoxEl.innerHTML = '';
    if (this.video) {
      this.video.removeEventListener('timeupdate', this.handleVideoTimeUpdate);
      this.video.removeEventListener('play', this.handleVideoStateSync);
      this.video.removeEventListener('playing', this.handleVideoStateSync);
      this.video.removeEventListener('pause', this.handleVideoStateSync);
      this.video.removeEventListener('seeked', this.handleVideoSeeked);
      this.video.removeEventListener('ratechange', this.handleVideoStateSync);
    }
    this.host.style.display = 'none';
    if (this.host.isConnected) {
      this.host.remove();
    }
    document.querySelectorAll('#kotostream-overlay-host').forEach((el) => el.remove());
    this.mountedContainer = null;
  }

  private async tryAutoLoadSavedTrack() {
    if (!this.settings.enabled) return;
    const match = await findSubtitleTrackForUrl(window.location.href);
    if (!this.settings.enabled) return;
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
    this.browserActiveIds = new Set();
    this.browserLinesCache = null;
    this.browserWindowRange = null;
    this.syncGroupEl.classList.add('ks-visible');
    this.updateSyncLabel();
    this.syncFileSubtitleToVideo();
    if (this.sidebarEl.classList.contains('ks-open') && this.sidebarMode === 'browser') {
      this.renderSubtitleBrowser();
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

  private emitVideoTimeSync(force = false, seeked = false) {
    if (!this.video) return;
    const isBuffering =
      this.captureState.status === 'buffering' ||
      this.captureState.status === 'listening' ||
      this.captureState.status === 'transcribing';
    if (!isBuffering) return;

    const now = Date.now();
    const minIntervalMs = this.clipCapture.isCapturingClip ? 100 : 350;
    if (!force && now - this.lastVideoSyncSentAt < minIntervalMs) return;
    this.lastVideoSyncSentAt = now;

    void safeSendMessage({
      type: 'VIDEO_TIME_SYNC',
      currentTimeSec: this.video.currentTime,
      playing: !this.video.paused && !this.video.ended && this.video.readyState >= 2,
      playbackRate: this.video.playbackRate || 1,
      sentAtMs: now,
      seeked,
    });
  }

  private handleVideoStateSync = () => {
    this.emitVideoTimeSync(true, false);
  };

  private handleVideoSeeked = () => {
    this.emitVideoTimeSync(true, !this.clipCapture.isCapturingClip);
  };

  private handleVideoTimeUpdate = () => {
    this.syncFileSubtitleToVideo();
    this.emitVideoTimeSync(false, false);
  };

  private syncFileSubtitleToVideo() {
    if (this.clipCapture.isCapturingClip) return;
    if (!this.video || this.loadedFileSubtitles.length === 0) return;
    const activeCues = findActiveSubtitlesAtTime(
      this.loadedFileSubtitles,
      this.video.currentTime,
      this.subtitleOffsetSec
    );

    if (activeCues.length > 0) {
      const combinedId = activeCues.map((c) => c.id).join('+');
      if (combinedId !== this.currentSubtitle?.id) {
        this.activeCuesForCurrentSub = activeCues;
        const minStart = Math.min(...activeCues.map((c) => c.videoTimeSec ?? 0));
        const maxEnd = Math.max(
          ...activeCues.map((c) => c.endTimeSec ?? (c.videoTimeSec ?? 0) + 4)
        );
        const combinedLine: SubtitleLine = {
          ...activeCues[0],
          id: combinedId,
          videoTimeSec: minStart,
          endTimeSec: maxEnd,
          text: activeCues.map((c) => c.text.replace(/\n/g, ' ')).join('\n'),
        };
        this.setSubtitle(combinedLine, false);

        this.browserActiveIds = new Set(activeCues.map((c) => c.id));
        if (this.sidebarEl.classList.contains('ks-open') && this.sidebarMode === 'browser') {
          this.updateBrowserActive();
        }

        const lastActive = activeCues[activeCues.length - 1];
        const idx = this.loadedFileSubtitles.findIndex((c) => c.id === lastActive.id);
        if (idx >= 0) {
          for (let k = 1; k <= 3; k++) {
            const upcoming = this.loadedFileSubtitles[idx + k];
            if (upcoming) {
              this.requestMeCabTokenization(upcoming.text.replace(/\n/g, ' '));
            }
          }
        }
      }
    } else if (this.currentSubtitle?.source === 'file') {
      this.currentSubtitle = null;
      this.committedSubtitle = null;
      this.activeCuesForCurrentSub = [];
      this.activeRowRange = null;
      this.subtitleBoxEl.classList.add('ks-empty');
      this.subtitleBoxEl.innerHTML = '';
    }
  }

  public updateSettings(settings: AppSettings) {
    const wasEnabled = this.settings.enabled;
    const prevFurigana = this.settings.overlay.furiganaMode;
    const prevHighlightUnknown = this.settings.overlay.highlightUnknown;
    const prevHighlightLearning = this.settings.overlay.highlightLearning;

    this.settings = settings;
    if (!settings.enabled) {
      this.unmount();
      return;
    }
    this.applyOverlayStyles();
    this.updateFuriganaLabel();
    if (!wasEnabled && this.video) {
      this.mount(this.video);
    }
    this.renderCurrentSubtitle();

    if (
      this.sidebarEl.classList.contains('ks-open') &&
      this.sidebarMode === 'browser' &&
      (prevFurigana !== settings.overlay.furiganaMode ||
        prevHighlightUnknown !== settings.overlay.highlightUnknown ||
        prevHighlightLearning !== settings.overlay.highlightLearning)
    ) {
      this.renderSubtitleBrowser();
    }
  }

  public updateVocabMap(vocabMap: Record<string, VocabEntry>) {
    this.vocabMap = vocabMap;
    this.renderCurrentSubtitle();
    this.refreshBrowserLineStatuses();
  }

  private applyOverlayStyles() {
    this.host.style.setProperty('--ks-font-size', `${this.settings.overlay.fontSizePx}px`);
    this.host.style.setProperty('--ks-bottom-offset', `${this.settings.overlay.bottomOffsetPx}px`);
    this.host.style.setProperty('--ks-bg-opacity', String(this.settings.overlay.backgroundOpacity));
  }

  public updateCaptureState(state: CaptureState) {
    this.captureState = state;
    this.dotEl.className = `ks-dot ${state.status === 'prescanning' ? 'transcribing' : state.status}`;

    const isActive =
      state.status === 'prescanning' ||
      state.status === 'listening' ||
      state.status === 'transcribing' ||
      state.status === 'starting';
    this.toolbarEl.classList.toggle('ks-active', isActive);

    if (isActive) {
      this.toggleCaptureBtn.textContent =
        state.status === 'prescanning' ? 'Cancel AI Scan' : 'Stop AI Subs';
      this.toggleCaptureBtn.className = 'ks-btn ks-btn-danger';
    } else {
      this.toggleCaptureBtn.innerHTML = `${OVERLAY_ICONS.sparkles} AI Pre-Scan`;
      this.toggleCaptureBtn.className = 'ks-btn ks-btn-primary';
    }

    this.statusPillEl.className = 'ks-status-pill';
    if (state.status === 'buffering') {
      this.statusPillEl.innerHTML = `${OVERLAY_ICONS.volume}<span>Audio buffer ready</span>`;
    } else if (state.status === 'prescanning') {
      const pct = Math.round(state.progress * 100);
      const rateLabel = Number.isInteger(state.playbackRate)
        ? `${state.playbackRate}x`
        : `${state.playbackRate.toFixed(1)}x`;
      if (state.phase === 'finalizing') {
        this.statusPillEl.textContent = `Finalizing AI subs… (${state.linesGenerated} lines)`;
      } else {
        this.statusPillEl.innerHTML = `${OVERLAY_ICONS.volumeMute}<span>Scanning ${escapeHtml(rateLabel)} · ${pct}% · ${state.linesGenerated} lines</span>`;
      }
    } else if (state.status === 'listening') {
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

    if (
      state.status === 'buffering' ||
      state.status === 'listening' ||
      state.status === 'transcribing'
    ) {
      this.emitVideoTimeSync(true);
    }
  }

  public setSubtitle(subtitle: SubtitleLine, appendToHistory = true) {
    if (!this.settings.enabled) return;
    const withTime: SubtitleLine = {
      ...subtitle,
      videoTimeSec: subtitle.videoTimeSec ?? this.video?.currentTime,
    };

    if (appendToHistory && withTime.source === 'live-stt') {
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

      this.browserLinesCache = null;
      if (this.sidebarEl.classList.contains('ks-open') && this.sidebarMode === 'browser') {
        this.updateLiveBrowser();
      }
    } else {
      this.committedSubtitle = withTime;
      this.currentSubtitle = withTime;
      if (appendToHistory) {
        this.subtitleHistory.unshift(withTime);
        if (this.subtitleHistory.length > 300) {
          this.subtitleHistory.pop();
        }
        this.browserLinesCache = null;
        if (this.sidebarEl.classList.contains('ks-open') && this.sidebarMode === 'browser') {
          this.updateLiveBrowser();
        }
      }
    }

    this.renderCurrentSubtitle();
  }

  private appendTokenText(span: HTMLElement, token: Token, furiganaMode: FuriganaMode) {
    const showFurigana =
      token.hasKanji &&
      token.reading &&
      (furiganaMode === 'all' ||
        (furiganaMode === 'unknown_and_learning' &&
          (token.status === 'unknown' || token.status === 'learning')));

    if (!showFurigana || !token.reading) {
      span.textContent = token.surface;
      return;
    }

    for (const seg of alignFuriganaSegments(token.surface, token.reading)) {
      if (!seg.isKanji) {
        span.appendChild(document.createTextNode(seg.surface));
      } else {
        const ruby = document.createElement('ruby');
        ruby.textContent = seg.surface;
        const rt = document.createElement('rt');
        rt.textContent = seg.reading;
        ruby.appendChild(rt);
        span.appendChild(ruby);
      }
    }
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

      const cachedMorphemes = this.morphemeCache.get(lineText);
      const tokens = cachedMorphemes
        ? buildTokensFromMorphemes(
            cachedMorphemes,
            this.vocabMap,
            this.readingCache,
            this.verifiedCompounds
          )
        : tokenizeJapanese(
            lineText,
            this.vocabMap,
            this.readingCache,
            this.verifiedCompounds
          );

      if (!cachedMorphemes) {
        this.requestMeCabTokenization(lineText, this.currentSubtitle?.id);
      }
      allTokens.push(...tokens);

      for (const token of tokens) {
        const span = document.createElement('span');
        span.className = `ks-token ks-status-${token.status}`;
        if (token.isWord) {
          span.classList.add('ks-word');
        }
        if (
          this.popoverEl.classList.contains('ks-open') &&
          this.activeToken &&
          token.isWord &&
          token.surface === this.activeToken.surface &&
          this.activeCuesForCurrentSub[rowIdx]?.id === this.activePopoverCueId
        ) {
          span.classList.add('ks-selected');
        }
        if (
          (token.status === 'unknown' && !this.settings.overlay.highlightUnknown) ||
          (token.status === 'learning' && !this.settings.overlay.highlightLearning)
        ) {
          span.classList.add('ks-no-highlight');
        }

        this.appendTokenText(span, token, furiganaMode);

        if (token.isWord) {
          const captureRowContext = () => {
            this.activeRowSentence = lineText;
            const rowCue = this.activeCuesForCurrentSub[rowIdx];
            this.activePopoverCueId = rowCue?.id ?? null;
            if (rowCue && rowCue.videoTimeSec !== undefined) {
              this.activeRowRange = {
                startSec: Math.max(0, rowCue.videoTimeSec + this.subtitleOffsetSec),
                endSec: Math.max(
                  0,
                  (rowCue.endTimeSec ?? rowCue.videoTimeSec + 4) + this.subtitleOffsetSec
                ),
              };
            } else {
              this.activeRowRange = null;
            }
          };
          span.addEventListener('mouseenter', () => {
            if (this.hoverCloseTimer) {
              clearTimeout(this.hoverCloseTimer);
              this.hoverCloseTimer = null;
            }
            captureRowContext();
            void this.openPopoverForToken(token, span);
          });
          span.addEventListener('click', (e) => {
            e.stopPropagation();
            captureRowContext();
            void this.openPopoverForToken(token, span);
          });
        }

        rowEl.appendChild(span);
      }

      this.subtitleBoxEl.appendChild(rowEl);
    });

    this.prefetchSubtitleWords(allTokens);
  }

  private requestMeCabTokenization(
    lineText: string,
    renderedSubId?: string,
    browserPatch?: { cueId: string; container: HTMLElement }
  ) {
    if (!lineText.trim() || this.morphemeCache.has(lineText) || this.pendingMorphemeRequests.has(lineText)) {
      return;
    }
    this.pendingMorphemeRequests.add(lineText);
    void safeSendMessage<{ morphemes?: KuromojiMorpheme[] }>({
      type: 'TOKENIZE_TEXT',
      text: lineText,
    }).then((res) => {
      this.pendingMorphemeRequests.delete(lineText);
      if (res?.morphemes && res.morphemes.length > 0) {
        this.morphemeCache.set(lineText, res.morphemes);
        if (this.morphemeCache.size > 400) {
          const firstKey = this.morphemeCache.keys().next().value;
          if (firstKey) this.morphemeCache.delete(firstKey);
        }
        if (
          renderedSubId &&
          this.currentSubtitle?.id === renderedSubId &&
          !this.popoverEl.classList.contains('ks-open')
        ) {
          this.renderCurrentSubtitle();
        }
        if (browserPatch && browserPatch.container.isConnected) {
          this.getBrowserLines();
          const cue = this.browserLinesById.get(browserPatch.cueId);
          if (cue) {
            this.renderBrowserLineTokens(cue, browserPatch.container, false);
          }
        }
      }
    });
  }

  private prefetchSubtitleWords(tokens: Token[]) {
    const compoundCandidates = findCandidateCompounds(tokens)
      .filter((c) => !this.checkedCompounds.has(c) && !this.verifiedCompounds.has(c))
      .slice(0, 8);

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
          if (entry) {
            this.verifiedCompounds.add(compound);
            this.verifiedCompounds.add(entry.word);
            for (const alt of entry.altForms ?? []) {
              this.verifiedCompounds.add(alt);
            }
            this.entryCache.set(compound, entry);
            this.entryCache.set(entry.word, entry);
            if (entry.reading) {
              this.readingCache[compound] = entry.reading;
              this.readingCache[entry.word] = entry.reading;
            }
            if (
              this.currentSubtitle?.id === renderedSubId &&
              !this.popoverEl.classList.contains('ks-open')
            ) {
              this.renderCurrentSubtitle();
            }
            if (this.sidebarEl.classList.contains('ks-open') && this.sidebarMode === 'browser') {
              this.patchBrowserLines(compound);
            }
          }
        });
      }
    }

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

  private positionPopoverAboveSubtitles(anchorEl: HTMLElement, fromPanel = false) {
    const tokenRect = anchorEl.getBoundingClientRect();
    const subRect = this.subtitleBoxEl.getBoundingClientRect();
    const popWidth = 340;
    const left = Math.max(
      12,
      Math.min(window.innerWidth - popWidth - 12, tokenRect.left + tokenRect.width / 2 - popWidth / 2)
    );

    const anchorTop = fromPanel ? tokenRect.top : Math.min(tokenRect.top, subRect.top);
    const spaceAbove = anchorTop - 24;
    const spaceBelow = window.innerHeight - tokenRect.bottom - 24;

    this.popoverEl.style.left = `${left}px`;
    this.popoverEl.style.overflowY = 'auto';

    if (fromPanel && spaceAbove < 240 && spaceBelow > spaceAbove) {
      this.popoverEl.style.top = `${Math.max(12, tokenRect.bottom + 10)}px`;
      this.popoverEl.style.bottom = 'auto';
      this.popoverEl.style.maxHeight = `${Math.max(180, spaceBelow)}px`;
    } else {
      const bottomPx = Math.max(12, window.innerHeight - anchorTop + 12);
      this.popoverEl.style.top = 'auto';
      this.popoverEl.style.bottom = `${bottomPx}px`;
      this.popoverEl.style.maxHeight = `${Math.max(180, spaceAbove)}px`;
    }
  }

  private async openPopoverForToken(token: Token, anchorEl: HTMLElement, fromPanel = false) {
    this.activeToken = token;

    if (this.settings.overlay.autoPauseOnHover && this.video && !this.video.paused) {
      this.video.pause();
      this.pausedByOverlay = true;
    }

    this.shadow.querySelectorAll('.ks-selected').forEach((el) => el.classList.remove('ks-selected'));
    anchorEl.classList.add('ks-selected');

    this.positionPopoverAboveSubtitles(anchorEl, fromPanel);
    this.popoverEl.classList.add('ks-open');

    const cached =
      this.entryCache.get(token.baseForm) ??
      this.entryCache.get(token.surface) ??
      lookupLocal(token.baseForm) ??
      lookupLocal(token.surface);

    if (cached) {
      this.renderPopoverContent(token, cached, false);
      return;
    }

    this.renderPopoverContent(token, null, true);

    try {
      const response = await safeSendMessage<{ entry?: DictionaryEntry | null }>({
        type: 'LOOKUP_WORD',
        word: token.baseForm,
        surface: token.surface,
      });

      if (this.activeToken?.surface !== token.surface) return;

      const entry = response?.entry ?? null;
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
      sensesHtml = `<div class="ks-def ks-muted-msg">Looking up in JMdict…</div>`;
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
      sensesHtml = `<div class="ks-def ks-muted-msg">No dictionary entry found for “${escapeHtml(token.surface)}”.</div>`;
    }

    this.popoverEl.innerHTML = `
      <div class="ks-pop-header">
        <div>
          <div class="ks-pop-word">${escapeHtml(word)}</div>
          ${reading && reading !== word ? `<div class="ks-pop-reading">${escapeHtml(reading)}</div>` : ''}
        </div>
        <div class="ks-pop-header-right">
          <div class="ks-badges">${badgesHtml}</div>
          <button class="ks-btn ks-btn-xs" data-pop-audio="play" title="Play captured sentence audio" aria-label="Play sentence audio">${OVERLAY_ICONS.volume}</button>
        </div>
      </div>
      <div class="ks-pop-senses">${sensesHtml}</div>
      <div class="ks-status-row">
        <button class="ks-status-btn ${currentStatus === 'unknown' ? 'active-unknown' : ''}" data-set-status="unknown">Unknown</button>
        <button class="ks-status-btn ${currentStatus === 'learning' ? 'active-learning' : ''}" data-set-status="learning">Learning</button>
        <button class="ks-status-btn ${currentStatus === 'known' ? 'active-known' : ''}" data-set-status="known">Known</button>
        <button class="ks-status-btn ${currentStatus === 'ignored' ? 'active-ignored' : ''}" data-set-status="ignored">Ignored</button>
      </div>
      <div class="ks-pop-actions">
        <button class="ks-btn ks-btn-primary" data-mine="card">${this.settings.anki.enabled ? 'Mine Card + Anki' : 'Mine Card'}</button>
      </div>
    `;

    this.popoverEl.querySelectorAll<HTMLButtonElement>('[data-set-status]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const status = btn.dataset.setStatus as WordStatus;
        const meaning = entry?.senses[0]?.definitions.slice(0, 3).join('; ') ?? '';
        const updated = await setWordStatus(word, status, { reading, meaning });
        this.vocabMap[word] = updated;
        if (matchedVocab && matchedVocab.baseForm !== word) {
          const aliasUpdated = await setWordStatus(matchedVocab.baseForm, status, { reading, meaning });
          this.vocabMap[matchedVocab.baseForm] = aliasUpdated;
        }
        this.renderCurrentSubtitle();
        this.refreshBrowserLineStatuses();
        this.renderPopoverContent({ ...token, status }, entry, false);
        this.showToast(`Marked “${word}” as ${status}`);
      });
    });

    const popAudioBtn = this.popoverEl.querySelector<HTMLButtonElement>('[data-pop-audio="play"]');
    popAudioBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (popAudioBtn.disabled) return;
      popAudioBtn.disabled = true;
      try {
        const range = this.getActiveAudioRange();
        const audioRes = await this.clipCapture.fetchSentenceAudio(range, true);
        if (audioRes?.audioBase64) {
          await playBase64Audio(audioRes.audioBase64, audioRes.mimeType);
        } else {
          this.showToast('Enable Sentence Audio in the KotoStream popup to play clips.');
        }
      } finally {
        popAudioBtn.disabled = false;
      }
    });

    const mineBtn = this.popoverEl.querySelector<HTMLButtonElement>('[data-mine="card"]');
    mineBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      mineBtn.disabled = true;
      mineBtn.textContent = this.settings.anki.openPreviewBeforeSaving ? 'Preparing…' : 'Mining…';
      await this.startMineWorkflow(token.surface, word, reading, entry);
      mineBtn.disabled = false;
      mineBtn.textContent = this.settings.anki.enabled ? 'Mine Card + Anki' : 'Mine Card';
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

  private getSurroundingSubtitleContext(currentSentence: string): {
    contextBefore: string[];
    contextAfter: string[];
  } {
    const cleanLine = (t: string) => t.replace(/\n+/g, ' ').trim();
    const targetClean = cleanLine(currentSentence);

    if (this.loadedFileSubtitles.length > 0) {
      const targetCue =
        this.activeCuesForCurrentSub.find((c) => cleanLine(c.text) === targetClean) ??
        this.activeCuesForCurrentSub[0];

      const idx = targetCue
        ? this.loadedFileSubtitles.findIndex((c) => c.id === targetCue.id)
        : this.loadedFileSubtitles.findIndex((c) => cleanLine(c.text) === targetClean);

      if (idx >= 0) {
        const contextBefore = this.loadedFileSubtitles
          .slice(Math.max(0, idx - 3), idx)
          .map((c) => cleanLine(c.text))
          .filter((l) => l && l !== targetClean);
        const contextAfter = this.loadedFileSubtitles
          .slice(idx + 1, idx + 2)
          .map((c) => cleanLine(c.text))
          .filter((l) => l && l !== targetClean);
        return { contextBefore, contextAfter };
      }
    }

    // subtitleHistory is stored newest-first (unshift), so slice from index 0 and reverse to chronological order
    const historyBefore = this.subtitleHistory
      .slice(0, 4)
      .reverse()
      .map((c) => cleanLine(c.text))
      .filter((l) => l && l !== targetClean)
      .slice(-3);
    return { contextBefore: historyBefore, contextAfter: [] };
  }

  private async fetchSentenceTranslation(
    sentence: string,
    targetWord?: string
  ): Promise<{ translation: string; providerUsed: string }> {
    if (!this.settings.anki.autoTranslate || this.settings.anki.translationProvider === 'off') {
      return { translation: '', providerUsed: 'off' };
    }
    const { contextBefore, contextAfter } = this.getSurroundingSubtitleContext(sentence);
    const res = await safeSendMessage<{ translation?: string; providerUsed?: string }>({
      type: 'TRANSLATE_SENTENCE',
      sentence,
      targetWord,
      contextBefore,
      contextAfter,
      showTitle: this.adapter.getMediaTitle(),
    });
    return {
      translation: res?.translation?.trim() ?? '',
      providerUsed: res?.providerUsed ?? '',
    };
  }

  private getActiveAudioRange(): {
    startTimeSec?: number;
    endTimeSec?: number;
    durationMs: number;
  } {
    if (this.activeRowRange && this.activeRowRange.endSec > this.activeRowRange.startSec) {
      const { startSec, endSec } = this.activeRowRange;
      return {
        startTimeSec: startSec,
        endTimeSec: endSec,
        durationMs: Math.min(15000, Math.max(1800, Math.round((endSec - startSec) * 1000) + 700)),
      };
    }

    const subStart = this.currentSubtitle?.videoTimeSec;
    const subEnd = this.currentSubtitle?.endTimeSec;
    if (subStart !== undefined && subEnd !== undefined && subEnd > subStart) {
      const offset = this.currentSubtitle?.source === 'file' ? this.subtitleOffsetSec : 0;
      const startSec = Math.max(0, subStart + offset);
      const endSec = Math.max(startSec + 0.5, subEnd + offset);
      return {
        startTimeSec: startSec,
        endTimeSec: endSec,
        durationMs: Math.min(15000, Math.max(1800, Math.round((endSec - startSec) * 1000) + 700)),
      };
    }

    return { durationMs: 4500 };
  }

  private async startMineWorkflow(
    surfaceWord: string,
    word: string,
    reading: string,
    entry: DictionaryEntry | null
  ) {
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

    if (this.hoverCloseTimer) {
      clearTimeout(this.hoverCloseTimer);
      this.hoverCloseTimer = null;
    }
    this.popoverEl.classList.remove('ks-open');
    this.shadow.querySelectorAll('.ks-selected').forEach((el) => el.classList.remove('ks-selected'));
    this.activeToken = null;
    this.activePopoverCueId = null;

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

    const range = this.getActiveAudioRange();

    const translationPromise = draft.translating
      ? this.fetchSentenceTranslation(sentence, word)
      : Promise.resolve({ translation: '', providerUsed: 'off' });

    const shot = await this.captureVideoFrame();
    const audioRes = this.settings.anki.includeAudio
      ? await this.clipCapture.fetchSentenceAudio(range, true)
      : undefined;

    draft.screenshotDataUrl = shot.dataUrl;
    draft.screenshotFormat = shot.format;
    draft.screenshotMeta = shot.meta;
    draft.capturingShot = false;
    draft.audioBase64 = audioRes?.audioBase64;
    draft.audioMimeType = audioRes?.mimeType;
    draft.audioDurationSec = audioRes?.durationSec;

    if (!this.settings.anki.openPreviewBeforeSaving) {
      const transRes = await translationPromise;
      draft.translation = transRes.translation;
      draft.translating = false;
      await this.commitCardDraft(draft);
      this.resumeVideoIfPausedByOverlay();
      return;
    }

    this.cardModal.open(draft);

    if (draft.translating) {
      const transRes = await translationPromise;
      this.cardModal.applyAsyncTranslation(draft, transRes.translation, transRes.providerUsed);
    }
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
    this.refreshBrowserLineStatuses();

    if (this.settings.anki.enabled) {
      try {
        const noteId = await exportCardToAnki(card, this.settings.anki);
        await updateMinedCard({ ...card, ankiNoteId: noteId });
        this.showToast(`Created “${card.word}” → Exported to Anki!`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'AnkiConnect unavailable';
        this.showToast(`Saved locally (Anki failed: ${msg})`);
      }
    } else {
      this.showToast(`Saved “${card.word}” to Mined Cards!`);
    }
  }

  private resumeVideoIfPausedByOverlay() {
    if (this.pausedByOverlay && this.settings.overlay.autoResumeOnLeave && this.video?.paused) {
      void this.video.play().catch(() => {});
    }
    this.pausedByOverlay = false;
  }

  private handleCardModalClose() {
    this.resumeVideoIfPausedByOverlay();
  }

  private schedulePopoverClose() {
    if (this.cardModal.isOpen) return;
    if (this.hoverCloseTimer) clearTimeout(this.hoverCloseTimer);
    this.hoverCloseTimer = window.setTimeout(() => {
      this.closePopover();
    }, 240);
  }

  private closePopover() {
    if (this.cardModal.isOpen) return;
    if (this.hoverCloseTimer) {
      clearTimeout(this.hoverCloseTimer);
      this.hoverCloseTimer = null;
    }
    const wasOpen = this.popoverEl.classList.contains('ks-open');
    this.popoverEl.classList.remove('ks-open');
    this.shadow.querySelectorAll('.ks-selected').forEach((el) => el.classList.remove('ks-selected'));
    this.activeToken = null;
    this.activePopoverCueId = null;

    if (wasOpen) {
      this.resumeVideoIfPausedByOverlay();
    }
  }

  private async toggleLiveCapture() {
    const isActive =
      this.captureState.status === 'prescanning' ||
      this.captureState.status === 'listening' ||
      this.captureState.status === 'transcribing' ||
      this.captureState.status === 'starting';

    const type = isActive ? 'STOP_CAPTURE' : 'START_CAPTURE';
    const nextState = await safeSendMessage<CaptureState>({ type });
    if (nextState?.status) {
      this.updateCaptureState(nextState);
    }
  }

  private async cycleFuriganaMode() {
    const order: FuriganaMode[] = ['unknown_and_learning', 'all', 'off'];
    const idx = order.indexOf(this.settings.overlay.furiganaMode);
    const nextMode = order[(idx + 1) % order.length];
    this.settings = {
      ...this.settings,
      overlay: { ...this.settings.overlay, furiganaMode: nextMode },
    };
    this.updateFuriganaLabel();
    this.renderCurrentSubtitle();
    if (this.sidebarEl.classList.contains('ks-open') && this.sidebarMode === 'browser') {
      this.renderSubtitleBrowser();
    }
    await saveSettings(this.settings);
    this.showToast(`Furigana: ${nextMode === 'unknown_and_learning' ? 'Smart' : nextMode === 'all' ? 'All' : 'Off'}`);
  }

  private updateFuriganaLabel() {
    const mode = this.settings.overlay.furiganaMode;
    this.furiganaBtn.textContent =
      mode === 'all' ? '振り仮名: All' : mode === 'off' ? '振り仮名: Off' : '振り仮名: Smart';
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Migaku-style Subtitle Browser & Library Sidebar
  // ─────────────────────────────────────────────────────────────────────────────

  private getBrowserLines(): SubtitleLine[] {
    if (this.browserLinesCache) return this.browserLinesCache;
    this.browserLinesCache =
      this.loadedFileSubtitles.length > 0
        ? this.loadedFileSubtitles
        : [...this.subtitleHistory].reverse();
    this.browserLinesById.clear();
    for (const cue of this.browserLinesCache) {
      this.browserLinesById.set(cue.id, cue);
    }
    return this.browserLinesCache;
  }

  private getBrowserActiveIdx(lines: SubtitleLine[]): number {
    if (this.loadedFileSubtitles.length === 0) {
      return Math.max(0, lines.length - 1);
    }
    if (this.browserActiveIds.size > 0) {
      const idx = lines.findIndex((c) => this.browserActiveIds.has(c.id));
      if (idx >= 0) return idx;
    }
    if (this.video && lines.length > 0 && lines[0].videoTimeSec !== undefined) {
      const t = this.video.currentTime - this.subtitleOffsetSec;
      return findCueIndexNearTime(lines, t);
    }
    return 0;
  }

  private renderSubtitleBrowser() {
    this.sidebarSearchWrapEl.classList.remove('ks-hidden');
    const titleEl = this.sidebarEl.querySelector('.ks-sidebar-header span');
    const allLines = this.getBrowserLines();

    if (allLines.length === 0) {
      if (titleEl) titleEl.textContent = 'Subtitles';
      this.sidebarListEl.innerHTML = `<div class="ks-sidebar-empty">No subtitles yet. Load an .srt/.ass file, pick from Library, or run AI Pre-Scan.</div>`;
      this.browserWindowRange = null;
      return;
    }

    const q = this.browserSearchQuery.toLowerCase();
    const lines = q ? allLines.filter((c) => c.text.toLowerCase().includes(q)) : allLines;

    const isLive = this.loadedFileSubtitles.length === 0;
    if (titleEl) {
      const label = isLive
        ? 'Subtitles · Live AI'
        : this.activeTrackName
          ? `Subtitles · ${this.activeTrackName}`
          : 'Subtitles';
      titleEl.textContent = q
        ? `${label} (${lines.length}/${allLines.length})`
        : `${label} (${allLines.length} lines)`;
    }

    if (lines.length === 0) {
      this.sidebarListEl.innerHTML = `<div class="ks-sidebar-empty">No lines match “${escapeHtml(this.browserSearchQuery)}”.</div>`;
      this.browserWindowRange = null;
      return;
    }

    const activeIdx = this.getBrowserActiveIdx(lines);
    const start = Math.max(0, activeIdx - BROWSER_WINDOW_LINES);
    const end = Math.min(lines.length, activeIdx + BROWSER_WINDOW_LINES + 1);
    const visible = lines.slice(start, end);
    this.browserWindowRange = { start, end };

    const frag = document.createDocumentFragment();
    const allTokens: Token[] = [];
    const lineContainers: Array<{ cue: SubtitleLine; el: HTMLElement }> = [];

    for (let i = 0; i < visible.length; i++) {
      const cue = visible[i];
      const itemEl = document.createElement('div');
      itemEl.className = 'ks-history-item';
      itemEl.dataset.subId = cue.id;
      if (this.browserActiveIds.has(cue.id)) {
        itemEl.classList.add('ks-active');
      }
      if (isLive && start + i === lines.length - 1) {
        itemEl.classList.add('ks-active');
      }
      const timeStr =
        cue.videoTimeSec !== undefined
          ? `⏵ ${formatSeconds(cue.videoTimeSec)}`
          : new Date(cue.timestampMs).toLocaleTimeString();
      const badge = isLive ? (cue.latencyMs ? `${cue.latencyMs}ms` : cue.source) : `#${start + i + 1}`;
      itemEl.innerHTML = `
        <div class="ks-history-meta"><span>${escapeHtml(timeStr)}</span><span>${escapeHtml(badge)}</span></div>
        <div class="ks-history-text"></div>
      `;
      frag.appendChild(itemEl);
      lineContainers.push({ cue, el: itemEl });
    }

    this.sidebarListEl.innerHTML = '';
    this.sidebarListEl.appendChild(frag);

    if (this.browserTokenObserver) {
      this.browserTokenObserver.disconnect();
      this.browserTokenObserver = null;
    }

    const lazyTargets: Array<{ cue: SubtitleLine; el: HTMLElement; textEl: HTMLElement }> = [];
    const activeRelIdx = activeIdx - start;

    for (let i = 0; i < lineContainers.length; i++) {
      const { cue, el } = lineContainers[i];
      const textEl = el.querySelector<HTMLElement>('.ks-history-text')!;
      const nearActive = Math.abs(i - activeRelIdx) <= 10;
      const tokens = this.renderBrowserLineTokens(cue, textEl, nearActive);
      if (Math.abs(i - activeRelIdx) <= 6) {
        allTokens.push(...tokens);
      }
      if (!nearActive) {
        lazyTargets.push({ cue, el, textEl });
      }
    }

    if (lazyTargets.length > 0 && typeof IntersectionObserver !== 'undefined') {
      const targetMap = new Map<Element, { cue: SubtitleLine; textEl: HTMLElement }>();
      this.browserTokenObserver = new IntersectionObserver(
        (entries, obs) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const info = targetMap.get(entry.target);
            obs.unobserve(entry.target);
            if (!info) continue;
            const lineText = info.cue.text.replace(/\n/g, ' ').trim();
            if (lineText && !this.morphemeCache.has(lineText)) {
              this.requestMeCabTokenization(lineText, undefined, {
                cueId: info.cue.id,
                container: info.textEl,
              });
            }
          }
        },
        { root: this.sidebarListEl, rootMargin: '240px 0px' }
      );
      for (const item of lazyTargets) {
        targetMap.set(item.el, { cue: item.cue, textEl: item.textEl });
        this.browserTokenObserver.observe(item.el);
      }
    }

    this.prefetchSubtitleWords(allTokens);

    if (this.browserFollowLive) {
      this.scrollBrowserToActive();
    }
    const followBtn = this.sidebarEl.querySelector<HTMLElement>('.ks-follow-btn');
    if (followBtn) followBtn.style.display = this.browserFollowLive ? 'none' : 'flex';
  }

  private renderBrowserLineTokens(
    cue: SubtitleLine,
    textEl: HTMLElement,
    requestMeCab = true
  ): Token[] {
    const lineText = cue.text.replace(/\n/g, ' ').trim();
    textEl.innerHTML = '';
    if (!lineText) return [];

    const cachedMorphemes = this.morphemeCache.get(lineText);
    const tokens = cachedMorphemes
      ? buildTokensFromMorphemes(
          cachedMorphemes,
          this.vocabMap,
          this.readingCache,
          this.verifiedCompounds
        )
      : tokenizeJapanese(lineText, this.vocabMap, this.readingCache, this.verifiedCompounds);

    if (!cachedMorphemes && requestMeCab) {
      this.requestMeCabTokenization(lineText, undefined, { cueId: cue.id, container: textEl });
    }

    const furiganaMode = this.settings.overlay.furiganaMode;

    for (const token of tokens) {
      const span = document.createElement('span');
      span.className = `ks-token ks-status-${token.status}`;
      if (token.isWord) {
        span.classList.add('ks-word');
      }
      if (
        this.popoverEl.classList.contains('ks-open') &&
        this.activeToken &&
        token.isWord &&
        token.surface === this.activeToken.surface &&
        this.activePopoverCueId === cue.id
      ) {
        span.classList.add('ks-selected');
      }
      if (
        (token.status === 'unknown' && !this.settings.overlay.highlightUnknown) ||
        (token.status === 'learning' && !this.settings.overlay.highlightLearning)
      ) {
        span.classList.add('ks-no-highlight');
      }

      this.appendTokenText(span, token, furiganaMode);

      if (token.isWord) {
        const captureRowContext = () => {
          this.activeRowSentence = lineText;
          this.activePopoverCueId = cue.id;
          if (cue.videoTimeSec !== undefined) {
            this.activeRowRange = {
              startSec: Math.max(0, cue.videoTimeSec + this.subtitleOffsetSec),
              endSec: Math.max(
                0,
                (cue.endTimeSec ?? cue.videoTimeSec + 4) + this.subtitleOffsetSec
              ),
            };
          } else {
            this.activeRowRange = null;
          }
        };
        span.addEventListener('mouseenter', () => {
          if (this.hoverCloseTimer) {
            clearTimeout(this.hoverCloseTimer);
            this.hoverCloseTimer = null;
          }
          captureRowContext();
          void this.openPopoverForToken(token, span, true);
        });
        span.addEventListener('click', (e) => {
          e.stopPropagation();
          captureRowContext();
          void this.openPopoverForToken(token, span, true);
        });
      }

      textEl.appendChild(span);
    }

    return tokens;
  }

  private updateBrowserActive() {
    if (this.sidebarMode !== 'browser') return;
    const lines = this.getBrowserLines();
    if (lines.length === 0) return;

    const activeIdx = this.getBrowserActiveIdx(lines);
    if (this.captureState.status === 'prescanning') return;

    if (this.browserWindowRange && this.browserFollowLive && !this.browserSearchQuery) {
      const nearStart =
        activeIdx - this.browserWindowRange.start < 5 && this.browserWindowRange.start > 0;
      const nearEnd =
        this.browserWindowRange.end - 1 - activeIdx < 5 && this.browserWindowRange.end < lines.length;
      if (nearStart || nearEnd) {
        this.renderSubtitleBrowser();
        return;
      }
    }

    this.sidebarListEl
      .querySelectorAll('.ks-history-item.ks-active')
      .forEach((el) => el.classList.remove('ks-active'));
    const items = this.sidebarListEl.querySelectorAll<HTMLElement>('.ks-history-item');
    let activeEl: HTMLElement | null = null;
    for (const el of items) {
      if (el.dataset.subId && this.browserActiveIds.has(el.dataset.subId)) {
        el.classList.add('ks-active');
        activeEl = activeEl ?? el;
      }
    }
    if (this.loadedFileSubtitles.length === 0 && !activeEl && items.length > 0) {
      const last = items[items.length - 1];
      last.classList.add('ks-active');
      activeEl = last;
    }

    if (this.browserFollowLive && activeEl) {
      this.scrollBrowserToActive();
    }
  }

  private scrollBrowserToActive() {
    const activeEl = this.sidebarListEl.querySelector<HTMLElement>('.ks-history-item.ks-active');
    if (!activeEl) return;
    const listRect = this.sidebarListEl.getBoundingClientRect();
    const elRect = activeEl.getBoundingClientRect();
    const target =
      this.sidebarListEl.scrollTop +
      (elRect.top - listRect.top) -
      listRect.height / 2 +
      elRect.height / 2;
    this.sidebarListEl.scrollTop = Math.max(0, target);
  }

  private updateLiveBrowser() {
    if (this.loadedFileSubtitles.length > 0) return;
    if (!this.browserFollowLive) return;
    this.renderSubtitleBrowser();
  }

  private setBrowserFollow(follow: boolean) {
    this.browserFollowLive = follow;
    const btn = this.sidebarEl.querySelector<HTMLElement>('.ks-follow-btn');
    if (btn) btn.style.display = follow ? 'none' : 'flex';
    if (follow) {
      this.updateBrowserActive();
    }
  }

  private patchBrowserLines(compound: string) {
    if (this.sidebarMode !== 'browser') return;
    const lines = this.getBrowserLines();
    if (lines.length === 0) return;
    const items = this.sidebarListEl.querySelectorAll<HTMLElement>('.ks-history-item');
    for (const item of items) {
      const cueId = item.dataset.subId;
      if (!cueId) continue;
      const cue = this.browserLinesById.get(cueId);
      if (!cue || !cue.text.replace(/\n/g, '').includes(compound)) continue;
      const textEl = item.querySelector<HTMLElement>('.ks-history-text');
      if (textEl) {
        this.renderBrowserLineTokens(cue, textEl, false);
      }
    }
  }

  private refreshBrowserLineStatuses() {
    if (!this.sidebarEl.classList.contains('ks-open') || this.sidebarMode !== 'browser') return;
    const lines = this.getBrowserLines();
    if (lines.length === 0) return;

    const items = this.sidebarListEl.querySelectorAll<HTMLElement>('.ks-history-item');
    for (const item of items) {
      const cueId = item.dataset.subId;
      const textEl = item.querySelector<HTMLElement>('.ks-history-text');
      if (!cueId || !textEl) continue;
      const cue = this.browserLinesById.get(cueId);
      if (!cue) continue;

      const lineText = cue.text.replace(/\n/g, ' ').trim();
      const morphemes = this.morphemeCache.get(lineText);
      if (!morphemes) continue;

      const freshTokens = buildTokensFromMorphemes(
        morphemes,
        this.vocabMap,
        this.readingCache,
        this.verifiedCompounds
      );
      const renderedTokens = Array.from(textEl.querySelectorAll<HTMLElement>('.ks-token'));
      const changed =
        renderedTokens.length !== freshTokens.length ||
        freshTokens.some((t, i) => {
          const m = renderedTokens[i].className.match(/ks-status-([a-z_]+)/);
          return !m || m[1] !== t.status;
        });
      if (changed) {
        this.renderBrowserLineTokens(cue, textEl, false);
      }
    }
  }

  private async renderLibrarySidebar() {
    this.sidebarSearchWrapEl.classList.add('ks-hidden');
    const titleEl = this.sidebarEl.querySelector('.ks-sidebar-header span');
    if (titleEl) titleEl.textContent = 'Subtitle Library';

    const lib = await getSubtitleLibrary();
    const headerBtn = `
      <div class="ks-sidebar-lib-cta">
        <button class="ks-btn ks-btn-primary ks-btn-full" data-action="open-subtitles-dashboard">
          Search Jimaku / Pre-Generate Subtitles
        </button>
      </div>`;

    if (lib.length === 0) {
      this.sidebarListEl.innerHTML =
        headerBtn +
        `<div class="ks-sidebar-empty">No saved subtitle tracks yet. Search Jimaku.cc or import/pre-generate an .srt file in the Dashboard!</div>`;
      return;
    }

    this.sidebarListEl.innerHTML =
      headerBtn +
      lib
        .map((track) => {
          const isCurrent = track.id === this.activeTrackId;
          return `
            <div class="ks-history-item ${isCurrent ? 'ks-lib-current' : ''}" data-track-id="${escapeHtml(track.id)}">
              <div class="ks-history-meta">
                <span>${escapeHtml(track.source.toUpperCase())} · ${track.cues.length} lines</span>
                <span>${isCurrent ? 'Active' : this.formatOffset(track.offsetSec)}</span>
              </div>
              <div class="ks-history-text ks-lib-item-title">${escapeHtml(track.title || track.fileName)}</div>
              <div class="ks-lib-item-file">${escapeHtml(track.fileName)}</div>
            </div>`;
        })
        .join('');
  }

  public showToast(message: string) {
    if (!this.settings.enabled) return;
    this.toastEl.textContent = message;
    this.toastEl.classList.add('ks-visible');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('ks-visible');
    }, 3000);
  }
}
