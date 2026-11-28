import React, { useMemo, useState } from 'react';
import type {
  AppSettings,
  DictionaryEntry,
  ExtensionMessage,
  Token,
  VocabEntry,
  WordStatus,
} from '../../types';
import { addMinedCard, setWordStatus, updateMinedCard } from '../../core/storage';
import { buildAnkiFieldPreview, exportCardToAnki } from '../../core/anki';
import { tokenizeJapanese } from '../../core/tokenizer';
import { lookupLocal } from '../../core/dictionary';
import { alignFuriganaSegments } from '../../core/furigana';

const SAMPLE_SENTENCES = [
  '昨日の夜、友達と一緒に面白い映画を見ていたんだ。',
  '絶対にあの約束を守ってみせるから、信じてほしい。',
  '今日は雨が降っているけど、明日はいい天気になりそうだね。',
  '日本語の字幕がなくても、このツールがあれば勉強できるよ。',
];

const ALL_STATUSES: WordStatus[] = ['unknown', 'learning', 'known', 'ignored'];

interface PlaygroundTabProps {
  settings: AppSettings;
  vocabMap: Record<string, VocabEntry>;
  onReload: () => Promise<void>;
  onNotice: (type: 'success' | 'error', text: string) => void;
}

export const PlaygroundTab: React.FC<PlaygroundTabProps> = ({
  settings,
  vocabMap,
  onReload,
  onNotice,
}) => {
  const [pgText, setPgText] = useState(SAMPLE_SENTENCES[0]);
  const [pgSelectedToken, setPgSelectedToken] = useState<Token | null>(null);
  const [pgEntry, setPgEntry] = useState<DictionaryEntry | null>(null);
  const [pgTranslation, setPgTranslation] = useState('');
  const [pgTranslating, setPgTranslating] = useState(false);
  const [pgNotes, setPgNotes] = useState('');
  const [pgLoading, setPgLoading] = useState(false);

  const pgTokens = useMemo(() => tokenizeJapanese(pgText, vocabMap), [pgText, vocabMap]);

  const selectedWordKey = pgEntry?.word || pgSelectedToken?.baseForm || '';
  const selectedStatus: WordStatus =
    (selectedWordKey && vocabMap[selectedWordKey]?.status) || pgSelectedToken?.status || 'unknown';

  const translatePlaygroundSentence = async (sentence: string, targetWord?: string) => {
    setPgTranslating(true);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'TRANSLATE_SENTENCE',
        sentence,
        targetWord,
      } satisfies ExtensionMessage)) as { translation?: string };
      setPgTranslation(res?.translation?.trim() ?? '');
    } catch {
      setPgTranslation('');
    } finally {
      setPgTranslating(false);
    }
  };

  const handlePgTokenClick = async (token: Token) => {
    if (!token.isWord) return;
    setPgSelectedToken(token);
    const local = lookupLocal(token.baseForm) ?? lookupLocal(token.surface);
    setPgEntry(local);
    setPgLoading(true);

    const wordPromise = chrome.runtime
      .sendMessage({
        type: 'LOOKUP_WORD',
        word: token.baseForm,
        surface: token.surface,
      } satisfies ExtensionMessage)
      .catch(() => ({}));

    const transPromise = settings.anki.autoTranslate
      ? translatePlaygroundSentence(pgText, token.baseForm)
      : Promise.resolve();

    try {
      const [res] = await Promise.all([wordPromise, transPromise]);
      const typed = res as { entry?: DictionaryEntry | null };
      if (typed?.entry) setPgEntry(typed.entry);
    } finally {
      setPgLoading(false);
    }
  };

  const handlePgMine = async () => {
    if (!pgSelectedToken) return;
    const word = pgEntry?.word || pgSelectedToken.baseForm;
    const reading = pgEntry?.reading || pgSelectedToken.reading || '';
    const meaning =
      pgEntry?.senses
        .slice(0, 3)
        .map((s) => s.definitions.slice(0, 3).join('; '))
        .join('\n') || '(No definition)';

    const card = await addMinedCard({
      word,
      surfaceWord: pgSelectedToken.surface,
      reading,
      meaning,
      sentence: pgText,
      translation: pgTranslation.trim() || undefined,
      notes: pgNotes.trim() || undefined,
      cardType: settings.anki.cardType,
      sourceTitle: 'KotoStream Playground',
      sourceUrl: 'kotostream://playground',
    });

    if (settings.anki.enabled) {
      try {
        const noteId = await exportCardToAnki(card, settings.anki);
        await updateMinedCard({ ...card, ankiNoteId: noteId });
        onNotice('success', `Mined “${word}” → Exported to Anki!`);
      } catch (err) {
        onNotice(
          'error',
          `Saved locally (Anki export failed: ${err instanceof Error ? err.message : 'unavailable'})`
        );
      }
    } else {
      onNotice('success', `Saved “${word}” to Mined Cards!`);
    }
    await onReload();
  };

  const pgPreviewFields = useMemo(() => {
    if (!pgSelectedToken) return [];
    return buildAnkiFieldPreview(
      {
        word: pgEntry?.word || pgSelectedToken.baseForm,
        surfaceWord: pgSelectedToken.surface,
        reading: pgEntry?.reading || pgSelectedToken.reading || '',
        meaning:
          pgEntry?.senses
            .slice(0, 3)
            .map((s) => s.definitions.slice(0, 3).join('; '))
            .join('\n') || '(No definition)',
        sentence: pgText,
        translation: pgTranslation,
        notes: pgNotes,
        sourceTitle: 'KotoStream Playground',
      },
      settings.anki
    );
  }, [pgSelectedToken, pgEntry, pgText, pgTranslation, pgNotes, settings.anki]);

  return (
    <div className="panel">
      <h2>Interactive Japanese Immersion Playground</h2>
      <p className="panel-desc">
        Click any word to test deconjugation, Jisho dictionary lookup, automatic sentence translation, and live Migaku-style Anki field previews.
      </p>

      <div className="row tight mb-md">
        {SAMPLE_SENTENCES.map((s, i) => (
          <button
            key={i}
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setPgText(s);
              setPgSelectedToken(null);
              setPgTranslation('');
            }}
          >
            Sample {i + 1}
          </button>
        ))}
      </div>

      <div className="field">
        <input
          type="text"
          value={pgText}
          onChange={(e) => {
            setPgText(e.target.value);
            setPgSelectedToken(null);
            setPgEntry(null);
            setPgTranslation('');
          }}
          placeholder="Type or paste any Japanese sentence…"
        />
      </div>

      <div className="playground-sentence">
        {pgTokens.map((t, idx) => (
          <span
            key={idx}
            className={`pg-token status-${t.status}`}
            onClick={() => void handlePgTokenClick(t)}
          >
            {t.hasKanji && t.reading
              ? alignFuriganaSegments(t.surface, t.reading).map((seg, i) =>
                  seg.isKanji ? (
                    <ruby key={i}>
                      {seg.surface}
                      <rt>{seg.reading}</rt>
                    </ruby>
                  ) : (
                    seg.surface
                  )
                )
              : t.surface}
          </span>
        ))}
      </div>

      {pgSelectedToken && (
        <div className="grid-2 align-start mt-md">
          <div className="panel nested">
            <div className="row between mb-md">
              <div>
                <strong className="pg-word-title">{selectedWordKey}</strong>{' '}
                <span className="pg-word-reading">
                  {pgEntry?.reading || pgSelectedToken.reading}
                </span>
              </div>
              <div className="status-btn-group">
                {ALL_STATUSES.map((st) => (
                  <button
                    key={st}
                    type="button"
                    className={`status-choice ${selectedStatus === st ? `active-${st}` : ''}`}
                    onClick={async () => {
                      await setWordStatus(selectedWordKey, st, {
                        reading: pgEntry?.reading || pgSelectedToken.reading,
                        meaning: pgEntry?.senses[0]?.definitions.join('; '),
                      });
                      await onReload();
                    }}
                  >
                    {st}
                  </button>
                ))}
              </div>
            </div>

            {pgLoading && <p className="muted-note mb-md">Looking up in JMdict…</p>}
            {!pgLoading && pgEntry && (
              <div className="mb-md">
                {pgEntry.senses.map((s, idx) => (
                  <div key={idx} className="pg-sense-item">
                    <span className="pg-sense-pos">
                      [{s.partsOfSpeech.join(', ')}]
                    </span>{' '}
                    {s.definitions.join('; ')}
                  </div>
                ))}
              </div>
            )}

            <div className="field mb-md">
              <label>Sentence Translation {pgTranslating ? '(Translating…)' : ''}</label>
              <textarea
                rows={2}
                value={pgTranslation}
                onChange={(e) => setPgTranslation(e.target.value)}
                placeholder="Auto-translated sentence appears here…"
              />
            </div>

            <div className="field mb-md">
              <label>Notes (optional)</label>
              <input
                type="text"
                value={pgNotes}
                onChange={(e) => setPgNotes(e.target.value)}
                placeholder="Add grammar note…"
              />
            </div>

            <div className="row tight">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void translatePlaygroundSentence(pgText, pgSelectedToken.baseForm)}
              >
                Re-translate
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void handlePgMine()}>
                {settings.anki.enabled ? 'Create Card & Send to Anki' : 'Create Card'}
              </button>
            </div>
          </div>

          <div className="panel nested">
            <div className="preview-heading">
              Live Anki Field Preview ({settings.anki.modelName})
            </div>
            <div className="preview-stack">
              {pgPreviewFields.map((f) => (
                <div key={f.fieldName} className="preview-card on-dark">
                  <div className="preview-field-label">{f.fieldName}</div>
                  <div className="preview-field-val" dangerouslySetInnerHTML={{ __html: f.html }} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
