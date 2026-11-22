import type { SpeakerSegment, SttSettings, SubtitleLine } from '../types';
import { isLikelyHallucination } from '../core/hallucination';

export interface TranscriptionResult {
  text: string;
  latencyMs: number;
  filtered?: boolean;
  segments?: SpeakerSegment[];
}

/**
 * Detects whether an OpenRouter model ID is a dedicated /audio/transcriptions STT model
 * vs. a multimodal audio LLM (e.g. google/gemini-2.5-flash) that uses /chat/completions.
 */
export function isDedicatedSttModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.includes('whisper') ||
    m.includes('scribe') ||
    m.includes('transcribe') ||
    m.includes('-stt') ||
    m.includes('/stt')
  );
}

/**
 * Parses the compact JSON speaker array returned by multimodal audio LLMs on OpenRouter.
 */
export function parseDiarizedLlmResponse(raw: string): { text: string; segments?: SpeakerSegment[] } {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!trimmed || trimmed === '[]' || trimmed === '""') {
    return { text: '' };
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const grouped: SpeakerSegment[] = [];
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as { speaker?: unknown; text?: unknown };
        const text = typeof rec.text === 'string' ? rec.text.trim() : '';
        if (!text) continue;
        const speaker = typeof rec.speaker === 'number' ? rec.speaker : Number(rec.speaker) || 1;
        const last = grouped[grouped.length - 1];
        if (last && last.speaker === speaker) {
          last.text += text;
        } else {
          grouped.push({ speaker, text });
        }
      }
      if (grouped.length > 0) {
        const sliced = grouped.slice(-2);
        return {
          text: sliced.map((s) => s.text).join('\n'),
          segments: sliced,
        };
      }
      return { text: '' };
    }
  } catch {
    // Fall back to plain line splitting if the model returned plain Japanese text
  }

  const lines = trimmed
    .split(/\r?\n+/)
    .map((l) => l.replace(/^(?:Speaker\s*\d+|話者\s*\d+)\s*[:：]\s*/i, '').trim())
    .filter(Boolean)
    .slice(-2);

  if (lines.length >= 2) {
    const segments = lines.map((line, idx) => ({ speaker: idx + 1, text: line }));
    return { text: lines.join('\n'), segments };
  }

  return { text: lines[0] ?? '' };
}

/**
 * Transcribes a base64-encoded audio chunk into Japanese text using OpenRouter.
 */
export async function transcribeAudioChunk(
  audioBase64: string,
  mimeType: string,
  settings: SttSettings,
  options?: { previousTranscript?: string; rms?: number }
): Promise<TranscriptionResult> {
  if (!settings.apiKey.trim()) {
    throw new Error('OpenRouter API key is not configured. Open KotoStream Settings to add your key.');
  }

  const startedAt = Date.now();
  const model = settings.model.trim() || 'openai/whisper-large-v3-turbo';
  const format = mimeType.includes('ogg')
    ? 'ogg'
    : mimeType.includes('wav')
      ? 'wav'
      : mimeType.includes('mp3')
        ? 'mp3'
        : mimeType.includes('mp4') || mimeType.includes('m4a')
          ? 'm4a'
          : 'webm';

  const result = isDedicatedSttModel(model)
    ? await transcribeWithOpenRouterStt(audioBase64, format, model, settings, options?.previousTranscript)
    : await transcribeWithOpenRouterAudioLlm(audioBase64, format, model, settings, options?.previousTranscript);

  const cleaned = result.text.trim();
  const latencyMs = Date.now() - startedAt;

  if (!cleaned || isLikelyHallucination(cleaned, options?.rms)) {
    return { text: '', latencyMs, filtered: true };
  }

  return { text: cleaned, latencyMs, segments: result.segments };
}

async function transcribeWithOpenRouterStt(
  audioBase64: string,
  format: string,
  model: string,
  settings: SttSettings,
  previousTranscript?: string
): Promise<{ text: string; segments?: SpeakerSegment[] }> {
  const promptParts = [settings.contextPrompt.trim(), previousTranscript?.slice(-80)].filter(Boolean);
  const body: Record<string, unknown> = {
    model,
    input_audio: {
      data: audioBase64,
      format,
    },
    language: 'ja',
  };
  if (promptParts.length > 0) {
    body.prompt = promptParts.join(' ');
  }

  const lowerModel = model.toLowerCase();
  if (lowerModel.includes('whisper-large-v3')) {
    // Route Whisper Large v3 / Turbo to Groq's ultra-fast LPU hardware via OpenRouter
    body.provider = {
      order: ['groq'],
      allow_fallbacks: true,
    };
  } else if (lowerModel.includes('mai-transcribe')) {
    // Enable native speaker diarization on Microsoft MAI-Transcribe 2
    body.response_format = 'verbose_json';
    body.timestamp_granularities = ['segment'];
    body.provider = {
      options: {
        azure: {
          diarization: { enabled: true },
        },
      },
    };
  }

  const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey.trim()}`,
      'Content-Type': 'application/json',
      'X-Title': 'KotoStream',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenRouter STT error (${res.status}): ${errBody.slice(0, 200) || res.statusText}`);
  }

  const json = (await res.json()) as {
    text?: string;
    segments?: Array<{ text?: string; speaker?: string | number }>;
    words?: Array<{ text?: string; word?: string; speaker_id?: string | number; speaker?: string | number }>;
  };

  // Segment-level speaker diarization (e.g. microsoft/mai-transcribe-2)
  if (json.segments && json.segments.some((s) => s.speaker !== undefined)) {
    const speakerIndex = new Map<string, number>();
    const grouped: SpeakerSegment[] = [];
    for (const seg of json.segments) {
      const segText = (seg.text ?? '').trim();
      if (!segText) continue;
      const rawSpk = String(seg.speaker ?? '0');
      if (!speakerIndex.has(rawSpk)) speakerIndex.set(rawSpk, speakerIndex.size + 1);
      const spkNum = speakerIndex.get(rawSpk)!;
      const last = grouped[grouped.length - 1];
      if (last && last.speaker === spkNum) {
        last.text += segText;
      } else {
        grouped.push({ speaker: spkNum, text: segText });
      }
    }
    if (grouped.length > 0) {
      const sliced = grouped.slice(-2);
      return { text: sliced.map((s) => s.text).join('\n'), segments: sliced };
    }
  }

  // Word-level speaker diarization (e.g. elevenlabs/scribe-v2)
  if (json.words && json.words.some((w) => w.speaker_id !== undefined || w.speaker !== undefined)) {
    const speakerIndex = new Map<string, number>();
    const grouped: SpeakerSegment[] = [];
    for (const w of json.words) {
      const tok = w.text ?? w.word ?? '';
      if (!tok) continue;
      const rawSpk = String(w.speaker_id ?? w.speaker ?? '0');
      if (!speakerIndex.has(rawSpk)) speakerIndex.set(rawSpk, speakerIndex.size + 1);
      const spkNum = speakerIndex.get(rawSpk)!;
      const last = grouped[grouped.length - 1];
      if (last && last.speaker === spkNum) {
        last.text += tok;
      } else {
        grouped.push({ speaker: spkNum, text: tok });
      }
    }
    const cleaned = grouped.map((g) => ({ speaker: g.speaker, text: g.text.trim() })).filter((g) => g.text);
    if (cleaned.length > 0) {
      const sliced = cleaned.slice(-2);
      return { text: sliced.map((s) => s.text).join('\n'), segments: sliced };
    }
  }

  return { text: json.text ?? '' };
}

async function transcribeWithOpenRouterAudioLlm(
  audioBase64: string,
  format: string,
  model: string,
  settings: SttSettings,
  previousTranscript?: string
): Promise<{ text: string; segments?: SpeakerSegment[] }> {
  const contextHint = [
    settings.contextPrompt.trim() ? `Show context: ${settings.contextPrompt.trim()}.` : '',
    previousTranscript ? `Previous line: ${previousTranscript.slice(-60)}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const instruction =
    `Transcribe ONLY the spoken Japanese dialogue in this audio verbatim. ` +
    `Return ONLY a compact JSON array of objects like [{"speaker":1,"text":"..."}]. ` +
    `Rules: If ONE person speaks, return 1 object with speaker 1. ` +
    `If TWO different voices speak or overlap, separate them by voice into speaker 1 and speaker 2 (1 sentence per speaker). ` +
    `No romaji, no English translation, no commentary. If there is only silence, music, or sound effects, return []. ` +
    contextHint;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey.trim()}`,
      'Content-Type': 'application/json',
      'X-Title': 'KotoStream',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 180,
      reasoning: { effort: 'none' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            {
              type: 'input_audio',
              input_audio: {
                data: audioBase64,
                format,
              },
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenRouter Audio error (${res.status}): ${errBody.slice(0, 200) || res.statusText}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };

  const content = json.choices?.[0]?.message?.content;
  const rawText = Array.isArray(content)
    ? content.map((c) => c.text ?? '').join('')
    : typeof content === 'string'
      ? content
      : '';

  return parseDiarizedLlmResponse(rawText);
}

/**
 * High-quality batch transcription for pre-calculating timestamped Japanese subtitles
 * from a local audio/video file via OpenRouter (verbose_json segment timestamps).
 */
export async function transcribeBatchChunkWithTimestamps(
  audioBase64: string,
  mimeType: string,
  chunkOffsetSec: number,
  settings: SttSettings
): Promise<SubtitleLine[]> {
  if (!settings.apiKey.trim()) {
    throw new Error('OpenRouter API key is required for pre-generating subtitles.');
  }

  // Use highest-quality dedicated STT model for offline batch pre-generation
  const configured = settings.model.trim();
  const model = isDedicatedSttModel(configured) ? configured : 'openai/whisper-large-v3';
  const format = mimeType.includes('wav') ? 'wav' : 'webm';

  const body: Record<string, unknown> = {
    model,
    input_audio: { data: audioBase64, format },
    language: 'ja',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  };

  if (model.toLowerCase().includes('mai-transcribe')) {
    body.provider = { options: { azure: { diarization: { enabled: true } } } };
  }

  const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey.trim()}`,
      'Content-Type': 'application/json',
      'X-Title': 'KotoStream',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenRouter batch STT error (${res.status}): ${errBody.slice(0, 200) || res.statusText}`);
  }

  const json = (await res.json()) as {
    text?: string;
    segments?: Array<{ start?: number; end?: number; text?: string }>;
  };

  const cues: SubtitleLine[] = [];
  if (json.segments && json.segments.length > 0) {
    for (let i = 0; i < json.segments.length; i++) {
      const seg = json.segments[i];
      const text = (seg.text ?? '').trim();
      if (!text || isLikelyHallucination(text)) continue;
      const startSec = chunkOffsetSec + (seg.start ?? 0);
      const endSec = chunkOffsetSec + (seg.end ?? (seg.start ?? 0) + 3);
      cues.push({
        id: `gen_${Math.round(startSec * 1000)}_${i}`,
        text,
        timestampMs: Math.round(startSec * 1000),
        videoTimeSec: startSec,
        endTimeSec: Math.max(startSec + 0.5, endSec),
        source: 'file',
      });
    }
  } else if (json.text?.trim() && !isLikelyHallucination(json.text)) {
    cues.push({
      id: `gen_${Math.round(chunkOffsetSec * 1000)}`,
      text: json.text.trim(),
      timestampMs: Math.round(chunkOffsetSec * 1000),
      videoTimeSec: chunkOffsetSec,
      endTimeSec: chunkOffsetSec + 6,
      source: 'file',
    });
  }

  return cues;
}
