import React, { useMemo, useState } from 'react';
import type {
  AnkiFieldMapping,
  AppSettings,
  CardType,
  FuriganaFormat,
  ScreenshotFormat,
  TranslationProvider,
} from '../../types';
import {
  buildAnkiFieldPreview,
  getAnkiDecks,
  getAnkiModelFields,
  getAnkiModels,
  testAnkiConnection,
} from '../../core/anki';
import { saveSettings } from '../../core/storage';

const MIGAKU_FIELD_LABELS: Array<{ key: keyof AnkiFieldMapping; label: string; placeholder: string }> = [
  { key: 'targetWord', label: 'Target Word', placeholder: 'Target Word' },
  { key: 'reading', label: 'Reading (Furigana)', placeholder: 'Reading' },
  { key: 'sentence', label: 'Sentence', placeholder: 'Sentence' },
  { key: 'translation', label: 'Sentence Translation', placeholder: 'Translation' },
  { key: 'definitions', label: 'Definitions', placeholder: 'Definitions' },
  { key: 'image', label: 'Screenshot Image', placeholder: 'Image' },
  { key: 'sentenceAudio', label: 'Sentence Audio', placeholder: 'Sentence Audio' },
  { key: 'notes', label: 'Notes', placeholder: 'Notes' },
  { key: 'source', label: 'Source / Show Title', placeholder: '(optional)' },
];

const STT_MODEL_PRESETS = [
  { id: 'openai/whisper-large-v3-turbo', label: 'Whisper v3 Turbo (Groq · Fastest)' },
  { id: 'microsoft/mai-transcribe-2', label: 'MAI-Transcribe 2 (2-Speaker)' },
  { id: 'elevenlabs/scribe-v2', label: 'Scribe v2 (Diarized)' },
  { id: 'openai/whisper-large-v3', label: 'Whisper v3 (Groq)' },
];

const TRANSLATION_MODEL_PRESETS = [
  'google/gemini-2.5-flash',
  'google/gemini-2.5-pro',
  'anthropic/claude-sonnet-4',
  'openai/gpt-4.1-mini',
  'deepseek/deepseek-chat-v3-0324',
];

interface SettingsTabProps {
  savedSettings: AppSettings;
  onSettingsSaved: (next: AppSettings) => void;
  onNotice: (type: 'success' | 'error', text: string) => void;
}

function clampNumber(val: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(val)) return fallback;
  return Math.min(max, Math.max(min, val));
}

export const SettingsTab: React.FC<SettingsTabProps> = ({
  savedSettings,
  onSettingsSaved,
  onNotice,
}) => {
  const [draft, setDraft] = useState<AppSettings>(savedSettings);
  const [tagsInput, setTagsInput] = useState<string>(savedSettings.anki.tags.join(', '));
  const [customTranslationModel, setCustomTranslationModel] = useState<boolean>(
    !TRANSLATION_MODEL_PRESETS.includes(savedSettings.anki.translationModel)
  );
  const customModelInputRef = React.useRef<HTMLInputElement | null>(null);
  const [ankiDecks, setAnkiDecks] = useState<string[]>([]);
  const [ankiModels, setAnkiModels] = useState<string[]>([]);
  const [ankiFields, setAnkiFields] = useState<string[]>([]);
  const [ankiStatus, setAnkiStatus] = useState<string>('');

  const isDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(savedSettings),
    [draft, savedSettings]
  );
  const isDirtyRef = React.useRef(isDirty);
  isDirtyRef.current = isDirty;

  // Keep draft synced when savedSettings reloads from storage, without clobbering unsaved edits
  React.useEffect(() => {
    if (isDirtyRef.current) return;
    setDraft(savedSettings);
    setTagsInput(savedSettings.anki.tags.join(', '));
    setCustomTranslationModel(
      !TRANSLATION_MODEL_PRESETS.includes(savedSettings.anki.translationModel)
    );
  }, [savedSettings]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsedTags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const cleaned: AppSettings = {
      ...draft,
      overlay: {
        ...draft.overlay,
        fontSizePx: clampNumber(draft.overlay.fontSizePx, 16, 52, 28),
        bottomOffsetPx: clampNumber(draft.overlay.bottomOffsetPx, 16, 240, 68),
        backgroundOpacity: clampNumber(draft.overlay.backgroundOpacity, 0, 1, 0.78),
      },
      anki: {
        ...draft.anki,
        tags: parsedTags,
        screenshotQuality: clampNumber(draft.anki.screenshotQuality, 0.3, 1, 0.82),
      },
    };
    await saveSettings(cleaned);
    setDraft(cleaned);
    setTagsInput(parsedTags.join(', '));
    onSettingsSaved(cleaned);
    onNotice('success', 'Settings saved! Changes apply immediately to active video tabs.');
  };

  const applyFieldPreset = (preset: 'migaku' | 'basic') => {
    if (preset === 'migaku') {
      setDraft((s) => ({
        ...s,
        anki: {
          ...s.anki,
          modelName: 'Migaku Japanese',
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
      }));
    } else {
      setDraft((s) => ({
        ...s,
        anki: {
          ...s.anki,
          modelName: 'Basic',
          fieldMapping: {
            targetWord: 'Front',
            reading: '',
            sentence: 'Front',
            translation: 'Back',
            definitions: 'Back',
            image: 'Back',
            sentenceAudio: 'Back',
            notes: 'Back',
            source: '',
          },
        },
      }));
    }
  };

  const handleTestAnki = async () => {
    setAnkiStatus('Connecting…');
    try {
      const version = await testAnkiConnection(draft.anki.url);
      const [decks, models] = await Promise.all([
        getAnkiDecks(draft.anki.url),
        getAnkiModels(draft.anki.url),
      ]);
      setAnkiDecks(decks);
      setAnkiModels(models);

      const activeModel = models.includes(draft.anki.modelName)
        ? draft.anki.modelName
        : models[0] ?? '';

      if (activeModel) {
        const fields = await getAnkiModelFields(activeModel, draft.anki.url);
        setAnkiFields(fields);
      }

      setAnkiStatus(`Connected (AnkiConnect v${version}) — ${decks.length} decks, ${models.length} note types.`);
      onNotice('success', `Connected to AnkiConnect v${version}!`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAnkiStatus(`Failed: ${msg}. Make sure Anki is open with AnkiConnect (code 2055492159) installed.`);
      onNotice('error', `AnkiConnect error: ${msg}`);
    }
  };

  const handleModelChange = async (modelName: string) => {
    setDraft((s) => ({ ...s, anki: { ...s.anki, modelName } }));
    try {
      const fields = await getAnkiModelFields(modelName, draft.anki.url);
      setAnkiFields(fields);
    } catch {
      // Ignore if Anki isn't currently connected
    }
  };

  const settingsPreviewFields = useMemo(
    () =>
      buildAnkiFieldPreview(
        {
          word: '約束',
          surfaceWord: '約束',
          reading: 'やくそく',
          meaning: 'promise; agreement; appointment',
          sentence: '絶対にあの約束を守ってみせるから、信じてほしい。',
          translation: 'I will definitely keep that promise, so please believe me.',
          notes: '～てみせる = show that one will do something',
          sourceTitle: 'Amazon Prime Video — Episode 4',
          audioBase64: draft.anki.includeAudio ? 'demo' : undefined,
        },
        draft.anki
      ),
    [draft.anki]
  );

  return (
    <form onSubmit={handleSave}>
      {/* 1. OpenRouter STT */}
      <div className="panel">
        <h2>1. OpenRouter Speech-to-Text (AI Japanese Subtitles)</h2>
        <p className="panel-desc">
          Transcribes streaming audio into Japanese subtitles via OpenRouter.
          Whisper Large v3 Turbo is routed to Groq for ~250ms latency; MAI-Transcribe 2 &amp; Scribe v2 add native 2-speaker diarization.
        </p>

        <div className="grid-2">
          <div className="field">
            <label>OpenRouter API Key</label>
            <input
              type="password"
              placeholder="sk-or-v1-..."
              value={draft.stt.apiKey}
              onChange={(e) => setDraft((s) => ({ ...s, stt: { ...s.stt, apiKey: e.target.value } }))}
            />
          </div>

          <div className="field">
            <label>OpenRouter Model</label>
            <input
              type="text"
              value={draft.stt.model}
              onChange={(e) => setDraft((s) => ({ ...s, stt: { ...s.stt, model: e.target.value } }))}
            />
            <div className="row tight mt-sm">
              {STT_MODEL_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`btn btn-sm ${draft.stt.model === preset.id ? 'btn-primary' : ''}`}
                  onClick={() => setDraft((s) => ({ ...s, stt: { ...s.stt, model: preset.id } }))}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Jimaku.cc API Key (for Anime/Drama Subtitles)</label>
            <input
              type="password"
              placeholder="Free key from jimaku.cc/account"
              value={draft.subtitles.jimakuApiKey}
              onChange={(e) =>
                setDraft((s) => ({ ...s, subtitles: { ...s.subtitles, jimakuApiKey: e.target.value } }))
              }
            />
          </div>

          <div className="field">
            <label>Context Prompt (optional show/character names)</label>
            <input
              type="text"
              placeholder="e.g. 呪術廻戦、虎杖悠仁、五条悟"
              value={draft.stt.contextPrompt}
              onChange={(e) =>
                setDraft((s) => ({ ...s, stt: { ...s.stt, contextPrompt: e.target.value } }))
              }
            />
          </div>
        </div>
      </div>

      {/* 2. Overlay Preferences */}
      <div className="panel">
        <h2>2. Subtitle Overlay &amp; Reading Preferences</h2>
        <p className="panel-desc">Customize how interactive Japanese subtitles look and behave on video players.</p>

        <div className="grid-2">
          <div className="field">
            <label>Furigana Mode</label>
            <select
              value={draft.overlay.furiganaMode}
              onChange={(e) =>
                setDraft((s) => ({
                  ...s,
                  overlay: {
                    ...s.overlay,
                    furiganaMode: e.target.value as AppSettings['overlay']['furiganaMode'],
                  },
                }))
              }
            >
              <option value="unknown_and_learning">Smart (Unknown &amp; Learning only)</option>
              <option value="all">Always show Furigana</option>
              <option value="off">Off</option>
            </select>
          </div>

          <div className="field">
            <label>
              <span>Subtitle Font Size</span>
              <span className="range-val">{draft.overlay.fontSizePx}px</span>
            </label>
            <div className="range-row">
              <input
                type="range"
                className="range-slider"
                min={16}
                max={52}
                step={1}
                value={draft.overlay.fontSizePx}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    overlay: { ...s.overlay, fontSizePx: Number(e.target.value) },
                  }))
                }
              />
            </div>
          </div>

          <div className="field">
            <label>
              <span>Bottom Offset</span>
              <span className="range-val">{draft.overlay.bottomOffsetPx}px</span>
            </label>
            <div className="range-row">
              <input
                type="range"
                className="range-slider"
                min={16}
                max={240}
                step={2}
                value={draft.overlay.bottomOffsetPx}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    overlay: { ...s.overlay, bottomOffsetPx: Number(e.target.value) },
                  }))
                }
              />
            </div>
          </div>

          <div className="field">
            <label>
              <span>Background Opacity</span>
              <span className="range-val">{Math.round(draft.overlay.backgroundOpacity * 100)}%</span>
            </label>
            <div className="range-row">
              <input
                type="range"
                className="range-slider"
                min={0}
                max={1}
                step={0.02}
                value={draft.overlay.backgroundOpacity}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    overlay: { ...s.overlay, backgroundOpacity: Number(e.target.value) },
                  }))
                }
              />
            </div>
          </div>
        </div>

        <div className="row spaced">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft((s) => ({ ...s, enabled: e.target.checked }))}
            />
            <strong>Extension enabled</strong> (show overlay on video pages)
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.overlay.autoPauseOnHover}
              onChange={(e) =>
                setDraft((s) => ({
                  ...s,
                  overlay: { ...s.overlay, autoPauseOnHover: e.target.checked },
                }))
              }
            />
            Auto-pause video when hovering a word
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.overlay.autoResumeOnLeave}
              onChange={(e) =>
                setDraft((s) => ({
                  ...s,
                  overlay: { ...s.overlay, autoResumeOnLeave: e.target.checked },
                }))
              }
            />
            Auto-resume when leaving popover
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.overlay.highlightUnknown}
              onChange={(e) =>
                setDraft((s) => ({
                  ...s,
                  overlay: { ...s.overlay, highlightUnknown: e.target.checked },
                }))
              }
            />
            Underline unknown words
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.overlay.highlightLearning}
              onChange={(e) =>
                setDraft((s) => ({
                  ...s,
                  overlay: { ...s.overlay, highlightLearning: e.target.checked },
                }))
              }
            />
            Underline learning words
          </label>
        </div>
      </div>

      {/* 3. Card Creator, Screenshots & Translation */}
      <div className="panel">
        <h2>3. Migaku-Style Card Creator, Screenshots &amp; Translation</h2>
        <p className="panel-desc">
          Configure how cards are built, translated, and screenshotted (clean video-only crop, WebP/JPEG) when you mine a sentence.
        </p>

        <div className="grid-2">
          <div className="field">
            <label>Default Card Type</label>
            <select
              value={draft.anki.cardType}
              onChange={(e) =>
                setDraft((s) => ({ ...s, anki: { ...s.anki, cardType: e.target.value as CardType } }))
              }
            >
              <option value="sentence">Sentence Card (Migaku default)</option>
              <option value="word">Word Card</option>
              <option value="audio_sentence">Audio Sentence Card</option>
            </select>
          </div>

          <div className="field">
            <label>Furigana Syntax in Anki</label>
            <select
              value={draft.anki.furiganaFormat}
              onChange={(e) =>
                setDraft((s) => ({
                  ...s,
                  anki: { ...s.anki, furiganaFormat: e.target.value as FuriganaFormat },
                }))
              }
            >
              <option value="ruby_html">HTML Ruby (&lt;ruby&gt;約束&lt;rt&gt;やくそく&lt;/rt&gt;&lt;/ruby&gt;)</option>
              <option value="migaku_brackets">Migaku Brackets (約束[やくそく])</option>
              <option value="none">Plain Kanji Only</option>
            </select>
          </div>

          <div className="field">
            <label>Sentence Translation Engine</label>
            <select
              value={draft.anki.translationProvider}
              onChange={(e) =>
                setDraft((s) => ({
                  ...s,
                  anki: { ...s.anki, translationProvider: e.target.value as TranslationProvider },
                }))
              }
            >
              <option value="openrouter">OpenRouter AI (Context-aware — falls back to Google if no key)</option>
              <option value="google_free">Free Google Translate (No API key needed)</option>
              <option value="off">Off</option>
            </select>
          </div>

          {draft.anki.translationProvider === 'openrouter' && (
            <div className="field">
              <label>OpenRouter Translation Model</label>
              <select
                value={
                  !customTranslationModel && TRANSLATION_MODEL_PRESETS.includes(draft.anki.translationModel)
                    ? draft.anki.translationModel
                    : '__custom__'
                }
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '__custom__') {
                    setCustomTranslationModel(true);
                    window.requestAnimationFrame(() => customModelInputRef.current?.focus());
                  } else {
                    setCustomTranslationModel(false);
                    setDraft((s) => ({
                      ...s,
                      anki: { ...s.anki, translationModel: val },
                    }));
                  }
                }}
              >
                <option value="google/gemini-2.5-flash">Google Gemini 2.5 Flash (Fast &amp; natural — Recommended)</option>
                <option value="google/gemini-2.5-pro">Google Gemini 2.5 Pro (Top Japanese nuance)</option>
                <option value="anthropic/claude-sonnet-4">Anthropic Claude Sonnet 4 (Best English localization)</option>
                <option value="openai/gpt-4.1-mini">OpenAI GPT-4.1 Mini (Fast &amp; accurate)</option>
                <option value="deepseek/deepseek-chat-v3-0324">DeepSeek V3 (Budget CJK)</option>
                <option value="__custom__">Custom OpenRouter Model ID…</option>
              </select>
              <input
                ref={customModelInputRef}
                type="text"
                className="mt-sm"
                value={draft.anki.translationModel}
                placeholder="google/gemini-2.5-flash"
                onChange={(e) => {
                  const next = e.target.value;
                  setCustomTranslationModel(!TRANSLATION_MODEL_PRESETS.includes(next));
                  setDraft((s) => ({
                    ...s,
                    anki: { ...s.anki, translationModel: next },
                  }));
                }}
              />
            </div>
          )}

          <div className="field">
            <label>Translation Target Language</label>
            <input
              type="text"
              value={draft.anki.translationTargetLang}
              placeholder="en"
              onChange={(e) =>
                setDraft((s) => ({
                  ...s,
                  anki: { ...s.anki, translationTargetLang: e.target.value },
                }))
              }
            />
          </div>

          <div className="field">
            <label>Screenshot Format (Migaku-style clean video crop)</label>
            <select
              value={draft.anki.screenshotFormat}
              onChange={(e) =>
                setDraft((s) => ({
                  ...s,
                  anki: { ...s.anki, screenshotFormat: e.target.value as ScreenshotFormat },
                }))
              }
            >
              <option value="webp">WebP (Migaku default — crisp &amp; tiny)</option>
              <option value="jpeg">JPEG</option>
              <option value="png">PNG (Lossless)</option>
            </select>
          </div>

          <div className="field">
            <label>Screenshot Max Height (px)</label>
            <select
              value={draft.anki.screenshotMaxHeight}
              onChange={(e) =>
                setDraft((s) => ({
                  ...s,
                  anki: { ...s.anki, screenshotMaxHeight: Number(e.target.value) },
                }))
              }
            >
              <option value={360}>360p (Compact)</option>
              <option value={480}>480p (Migaku recommended)</option>
              <option value={720}>720p (HD)</option>
              <option value={0}>Original Resolution</option>
            </select>
          </div>

          <div className="field">
            <label>
              <span>Screenshot Quality</span>
              <span className="range-val">{Math.round(draft.anki.screenshotQuality * 100)}%</span>
            </label>
            <div className="range-row">
              <input
                type="range"
                className="range-slider"
                min={0.3}
                max={1}
                step={0.02}
                value={draft.anki.screenshotQuality}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    anki: { ...s.anki, screenshotQuality: Number(e.target.value) },
                  }))
                }
              />
            </div>
          </div>

          <div className="field">
            <label>Card Tags (comma-separated)</label>
            <input
              type="text"
              value={tagsInput}
              placeholder="kotostream, prime-video"
              onChange={(e) => {
                const raw = e.target.value;
                setTagsInput(raw);
                setDraft((s) => ({
                  ...s,
                  anki: {
                    ...s.anki,
                    tags: raw
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  },
                }));
              }}
            />
          </div>
        </div>

        <div className="row spaced">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.anki.openPreviewBeforeSaving}
              onChange={(e) =>
                setDraft((s) => ({
                  ...s,
                  anki: { ...s.anki, openPreviewBeforeSaving: e.target.checked },
                }))
              }
            />
            Open Card Creator preview before saving (recommended)
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.anki.autoTranslate}
              onChange={(e) =>
                setDraft((s) => ({ ...s, anki: { ...s.anki, autoTranslate: e.target.checked } }))
              }
            />
            Auto-translate mined sentences
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.anki.highlightTargetInSentence}
              onChange={(e) =>
                setDraft((s) => ({
                  ...s,
                  anki: { ...s.anki, highlightTargetInSentence: e.target.checked },
                }))
              }
            />
            Bold/highlight target word in sentence
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.anki.includeScreenshot}
              onChange={(e) =>
                setDraft((s) => ({
                  ...s,
                  anki: { ...s.anki, includeScreenshot: e.target.checked },
                }))
              }
            />
            Capture clean video screenshot
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.anki.includeAudio}
              onChange={(e) =>
                setDraft((s) => ({ ...s, anki: { ...s.anki, includeAudio: e.target.checked } }))
              }
            />
            Capture sentence audio clip (48 kHz stereo WAV)
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.anki.allowDuplicate}
              onChange={(e) =>
                setDraft((s) => ({ ...s, anki: { ...s.anki, allowDuplicate: e.target.checked } }))
              }
            />
            Allow duplicate Anki notes
          </label>
        </div>
      </div>

      {/* 4. AnkiConnect & Field Mapping */}
      <div className="panel">
        <div className="row between mb-sm">
          <div>
            <h2>4. AnkiConnect &amp; Migaku Field Mapping</h2>
            <p className="panel-desc no-margin">
              Map KotoStream fields to your Anki Note Type (supports Migaku Japanese, Lapis, Kaishi, or Basic).
            </p>
          </div>
          <div className="row tight">
            <button type="button" className="btn btn-sm" onClick={() => applyFieldPreset('migaku')}>
              Migaku Preset
            </button>
            <button type="button" className="btn btn-sm" onClick={() => applyFieldPreset('basic')}>
              Basic Preset
            </button>
          </div>
        </div>

        <div className="row mb-md">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.anki.enabled}
              onChange={(e) =>
                setDraft((s) => ({ ...s, anki: { ...s.anki, enabled: e.target.checked } }))
              }
            />
            Auto-send mined cards to AnkiConnect
          </label>

          <button type="button" className="btn btn-sm" onClick={() => void handleTestAnki()}>
            Test Connection &amp; Load Decks
          </button>
          {ankiStatus && <span className="status-note">{ankiStatus}</span>}
        </div>

        <div className="grid-2">
          <div className="field">
            <label>AnkiConnect URL</label>
            <input
              type="text"
              value={draft.anki.url}
              onChange={(e) => setDraft((s) => ({ ...s, anki: { ...s.anki, url: e.target.value } }))}
            />
          </div>

          <div className="field">
            <label>Target Deck</label>
            {ankiDecks.length > 0 ? (
              <select
                value={draft.anki.deckName}
                onChange={(e) =>
                  setDraft((s) => ({ ...s, anki: { ...s.anki, deckName: e.target.value } }))
                }
              >
                {ankiDecks.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={draft.anki.deckName}
                onChange={(e) =>
                  setDraft((s) => ({ ...s, anki: { ...s.anki, deckName: e.target.value } }))
                }
              />
            )}
          </div>

          <div className="field">
            <label>Note Type (Model)</label>
            {ankiModels.length > 0 ? (
              <select
                value={draft.anki.modelName}
                onChange={(e) => void handleModelChange(e.target.value)}
              >
                {ankiModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={draft.anki.modelName}
                onChange={(e) =>
                  setDraft((s) => ({ ...s, anki: { ...s.anki, modelName: e.target.value } }))
                }
              />
            )}
          </div>

          {MIGAKU_FIELD_LABELS.map(({ key, label, placeholder }) => (
            <div className="field" key={key}>
              <label>Anki Field for {label}</label>
              {ankiFields.length > 0 ? (
                <select
                  value={draft.anki.fieldMapping[key]}
                  onChange={(e) =>
                    setDraft((s) => ({
                      ...s,
                      anki: {
                        ...s.anki,
                        fieldMapping: { ...s.anki.fieldMapping, [key]: e.target.value },
                      },
                    }))
                  }
                >
                  <option value="">(Skip)</option>
                  {ankiFields.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  placeholder={placeholder}
                  value={draft.anki.fieldMapping[key]}
                  onChange={(e) =>
                    setDraft((s) => ({
                      ...s,
                      anki: {
                        ...s.anki,
                        fieldMapping: { ...s.anki.fieldMapping, [key]: e.target.value },
                      },
                    }))
                  }
                />
              )}
            </div>
          ))}
        </div>

        <div className="mt-lg">
          <div className="preview-heading">Live Field Mapping Preview (Sample Card)</div>
          <div className="grid-2">
            {settingsPreviewFields.map((f) => (
              <div key={f.fieldName} className="preview-card">
                <div className="preview-field-label">{f.fieldName}</div>
                <div className="preview-field-val" dangerouslySetInnerHTML={{ __html: f.html }} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Sticky Save Bar */}
      <div className="sticky-save-bar">
        {isDirty ? (
          <span className="dirty-pill">● You have unsaved changes</span>
        ) : (
          <span className="saved-pill">All settings saved</span>
        )}
        <div className="row tight">
          {isDirty && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setDraft(savedSettings);
                setTagsInput(savedSettings.anki.tags.join(', '));
                setCustomTranslationModel(
                  !TRANSLATION_MODEL_PRESETS.includes(savedSettings.anki.translationModel)
                );
              }}
            >
              Discard Changes
            </button>
          )}
          <button type="submit" className="btn btn-primary">
            Save All Settings
          </button>
        </div>
      </div>
    </form>
  );
};
