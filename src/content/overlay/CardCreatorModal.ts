import type { AnkiSettings, CardType, ScreenshotFormat } from '../../types';
import { buildAnkiFieldPreview } from '../../core/anki';
import { escapeHtml, playBase64Audio } from './utils';

export interface CardDraft {
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
  audioDurationSec?: number;
  translating: boolean;
  capturingShot: boolean;
}

export interface CardCreatorCallbacks {
  getAnkiSettings: () => AnkiSettings;
  fetchTranslation: (
    sentence: string,
    targetWord?: string
  ) => Promise<{ translation: string; providerUsed: string }>;
  captureScreenshot: () => Promise<{
    dataUrl?: string;
    format?: ScreenshotFormat;
    meta?: string;
  }>;
  commitDraft: (draft: CardDraft) => Promise<void>;
  showToast: (msg: string) => void;
}

/**
 * Migaku-style Card Creator Modal inside the overlay Shadow DOM.
 * - Isolates keyboard events so typing in inputs never triggers YouTube/Prime/Netflix hotkeys.
 * - Closes cleanly on Escape or clicking outside the modal dialog.
 * - Updates screenshots in place without losing input focus or scroll position.
 */
export class CardCreatorModal {
  private backdropEl: HTMLDivElement;
  private callbacks: CardCreatorCallbacks;
  private draft: CardDraft | null = null;
  private keyGuardActive = false;

  constructor(backdropEl: HTMLDivElement, callbacks: CardCreatorCallbacks) {
    this.backdropEl = backdropEl;
    this.callbacks = callbacks;

    // Prevent key events originating inside the modal from bubbling out to the video player
    for (const evtName of ['keydown', 'keyup', 'keypress'] as const) {
      this.backdropEl.addEventListener(evtName, (e) => {
        if (!this.isOpen) return;
        e.stopPropagation();
        if (evtName === 'keydown' && (e as KeyboardEvent).key === 'Escape') {
          e.preventDefault();
          this.close();
        }
      });
    }
  }

  public get isOpen(): boolean {
    return this.backdropEl.classList.contains('ks-open');
  }

  public get currentDraft(): CardDraft | null {
    return this.draft;
  }

  private handleWindowKeyCapture = (e: KeyboardEvent) => {
    if (!this.isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.close();
      return;
    }
    // Block streaming site global window shortcuts (Space, f, m, k, j, l, arrows) while editing a card
    e.stopPropagation();
  };

  private attachKeyGuard() {
    if (this.keyGuardActive) return;
    this.keyGuardActive = true;
    window.addEventListener('keydown', this.handleWindowKeyCapture, true);
    window.addEventListener('keyup', this.handleWindowKeyCapture, true);
    window.addEventListener('keypress', this.handleWindowKeyCapture, true);
  }

  private detachKeyGuard() {
    if (!this.keyGuardActive) return;
    this.keyGuardActive = false;
    window.removeEventListener('keydown', this.handleWindowKeyCapture, true);
    window.removeEventListener('keyup', this.handleWindowKeyCapture, true);
    window.removeEventListener('keypress', this.handleWindowKeyCapture, true);
  }

  public open(draft: CardDraft) {
    this.draft = draft;
    const anki = this.callbacks.getAnkiSettings();

    this.backdropEl.innerHTML = `
      <div class="ks-modal" role="dialog" aria-modal="true" aria-label="KotoStream Card Creator">
        <div class="ks-modal-header">
          <div class="ks-modal-title">
            <span>Card Creator</span>
            <span class="ks-badge">${escapeHtml(anki.deckName)}</span>
            <span class="ks-badge common">${escapeHtml(anki.modelName)}</span>
          </div>
          <button type="button" class="ks-btn" data-modal-action="close" aria-label="Close">✕</button>
        </div>

        <div class="ks-modal-body">
          <div class="ks-modal-editor">
            <div class="ks-field-row">
              <div class="ks-field">
                <label>Target Word</label>
                <input type="text" data-draft-field="word" value="${escapeHtml(draft.word)}" />
              </div>
              <div class="ks-field">
                <label>Reading (Furigana)</label>
                <input type="text" data-draft-field="reading" value="${escapeHtml(draft.reading)}" />
              </div>
            </div>

            <div class="ks-field-row">
              <div class="ks-field">
                <label>Card Type</label>
                <select data-draft-field="cardType">
                  <option value="sentence" ${draft.cardType === 'sentence' ? 'selected' : ''}>Sentence Card</option>
                  <option value="word" ${draft.cardType === 'word' ? 'selected' : ''}>Word Card</option>
                  <option value="audio_sentence" ${draft.cardType === 'audio_sentence' ? 'selected' : ''}>Audio Sentence Card</option>
                </select>
              </div>
              <div class="ks-field">
                <label>Source</label>
                <input type="text" data-draft-field="sourceTitle" value="${escapeHtml(draft.sourceTitle)}" />
              </div>
            </div>

            <div class="ks-field">
              <label>Sentence</label>
              <textarea rows="2" data-draft-field="sentence">${escapeHtml(draft.sentence)}</textarea>
            </div>

            <div class="ks-field">
              <label>
                <span>Sentence Translation <span data-trans-status style="color:#a5b4fc;font-weight:500;margin-left:6px">${draft.translating ? 'Translating…' : ''}</span></span>
                <button type="button" class="ks-btn" style="padding:2px 8px;font-size:11px" data-modal-action="retranslate">Re-translate</button>
              </label>
              <textarea rows="2" data-draft-field="translation" placeholder="English translation of the sentence…">${escapeHtml(draft.translation)}</textarea>
            </div>

            <div class="ks-field">
              <label>Definitions</label>
              <textarea rows="3" data-draft-field="meaning">${escapeHtml(draft.meaning)}</textarea>
            </div>

            <div class="ks-field">
              <label>Notes (optional)</label>
              <input type="text" data-draft-field="notes" value="${escapeHtml(draft.notes)}" placeholder="Grammar nuance, context, etc." />
            </div>

            <div class="ks-shot-box" data-shot-box></div>

            ${
              draft.audioBase64
                ? `<div class="ks-shot-box" style="flex-direction:row;align-items:center;justify-content:space-between;padding:8px 10px">
                    <span class="ks-preview-audio-badge">🔊 Sentence Audio${draft.audioDurationSec ? ` (${draft.audioDurationSec}s WAV)` : ' (WAV)'}</span>
                    <button type="button" class="ks-btn ks-btn-primary" data-modal-action="play-audio">▶ Play Audio</button>
                   </div>`
                : `<div style="font-size:11px;color:#94a3b8">Audio clip: Open the KotoStream popup and load subtitles (or click “Enable Sentence Audio”) to buffer tab audio for mining.</div>`
            }
          </div>

          <div class="ks-modal-preview">
            <div class="ks-preview-heading">
              <span>Live Anki Field Preview</span>
              <span style="font-size:11px;color:#94a3b8;font-weight:500">${escapeHtml(anki.furiganaFormat.replace('_', ' '))}</span>
            </div>
            <div data-preview-fields style="display:flex;flex-direction:column;gap:8px"></div>
          </div>
        </div>

        <div class="ks-modal-footer">
          <span style="font-size:11px;color:#94a3b8">
            ${anki.enabled ? 'Will save to Mined Cards and export to AnkiConnect' : 'Will save to Mined Cards (enable AnkiConnect in Settings to auto-export)'}
          </span>
          <div style="display:flex;gap:8px">
            <button type="button" class="ks-btn" data-modal-action="close">Cancel</button>
            <button type="button" class="ks-btn ks-btn-primary" data-modal-action="save">
              ${anki.enabled ? 'Create Card & Send to Anki' : 'Create Card'}
            </button>
          </div>
        </div>
      </div>
    `;

    this.renderScreenshotBox();
    this.backdropEl.classList.add('ks-open');
    this.attachKeyGuard();
    this.refreshPreview();
    this.bindEvents();
  }

  public applyAsyncTranslation(draft: CardDraft, translation: string, providerUsed: string) {
    if (this.draft !== draft || !this.isOpen) return;
    draft.translation = translation;
    draft.translating = false;
    const transInput = this.backdropEl.querySelector<HTMLTextAreaElement>('[data-draft-field="translation"]');
    if (transInput && !transInput.value.trim()) {
      transInput.value = translation;
    }
    const transStatus = this.backdropEl.querySelector<HTMLElement>('[data-trans-status]');
    if (transStatus) {
      const label =
        providerUsed === 'openrouter'
          ? 'Auto-translated (OpenRouter AI)'
          : providerUsed === 'google_free'
            ? 'Auto-translated (Google Translate)'
            : 'Auto-translated';
      transStatus.textContent = translation ? label : '';
    }
    this.refreshPreview();
  }

  public close() {
    this.detachKeyGuard();
    this.backdropEl.classList.remove('ks-open');
    this.backdropEl.innerHTML = '';
    this.draft = null;
  }

  private renderScreenshotBox() {
    const d = this.draft;
    const box = this.backdropEl.querySelector<HTMLElement>('[data-shot-box]');
    if (!d || !box) return;

    box.innerHTML = `
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
    `;
  }

  private bindEvents() {
    const d = this.draft;
    if (!d) return;

    this.backdropEl
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
          this.refreshPreview();
        });
      });

    this.backdropEl.onclick = async (e) => {
      e.stopPropagation();

      // Clicking the dim backdrop outside .ks-modal closes the modal
      if (e.target === this.backdropEl) {
        this.close();
        return;
      }

      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-modal-action]');
      if (!target) return;

      const action = target.dataset.modalAction;
      if (action === 'close') {
        this.close();
      } else if (action === 'play-audio' && d.audioBase64) {
        const playBtn = target as HTMLButtonElement;
        playBtn.textContent = 'Playing…';
        await playBase64Audio(d.audioBase64, d.audioMimeType);
        window.setTimeout(() => {
          if (playBtn.isConnected) playBtn.textContent = '▶ Play Audio';
        }, Math.max(800, Math.round((d.audioDurationSec ?? 2) * 1000)));
      } else if (action === 'retranslate') {
        const statusEl = this.backdropEl.querySelector<HTMLElement>('[data-trans-status]');
        if (statusEl) statusEl.textContent = 'Translating…';
        const transRes = await this.callbacks.fetchTranslation(d.sentence, d.word);
        d.translation = transRes.translation;
        const transInput = this.backdropEl.querySelector<HTMLTextAreaElement>('[data-draft-field="translation"]');
        if (transInput) transInput.value = transRes.translation;
        if (statusEl) {
          const label =
            transRes.providerUsed === 'openrouter'
              ? 'Updated (OpenRouter AI)'
              : transRes.providerUsed === 'google_free'
                ? 'Updated (Google Translate)'
                : 'Updated';
          statusEl.textContent = transRes.translation ? label : 'Unavailable';
        }
        this.refreshPreview();
      } else if (action === 'retake-shot') {
        const btn = target as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Capturing…';
        const shot = await this.callbacks.captureScreenshot();
        if (shot.dataUrl) {
          d.screenshotDataUrl = shot.dataUrl;
          d.screenshotFormat = shot.format;
          d.screenshotMeta = shot.meta;
          this.renderScreenshotBox();
          this.refreshPreview();
        } else {
          btn.disabled = false;
          btn.textContent = 'Retake Screenshot';
          this.callbacks.showToast('Could not capture video frame — keeping previous screenshot.');
        }
      } else if (action === 'remove-shot') {
        d.screenshotDataUrl = undefined;
        d.screenshotMeta = 'Screenshot removed';
        this.renderScreenshotBox();
        this.refreshPreview();
      } else if (action === 'save') {
        const saveBtn = target as HTMLButtonElement;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        await this.callbacks.commitDraft(d);
        this.close();
      }
    };
  }

  public refreshPreview() {
    const d = this.draft;
    if (!d) return;
    const container = this.backdropEl.querySelector<HTMLElement>('[data-preview-fields]');
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
      this.callbacks.getAnkiSettings()
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
}
