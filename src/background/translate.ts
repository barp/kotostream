import type { AppSettings } from '../types';

export interface TranslationResult {
  translation: string;
  providerUsed: string;
}

export interface TranslationContext {
  targetWord?: string;
  contextBefore?: string[];
  contextAfter?: string[];
  showTitle?: string;
}

/**
 * Translates a mined Japanese sentence into the target language (default: English).
 * Uses OpenRouter LLM with surrounding episode dialogue context when configured,
 * falling back cleanly to free Google Translate if no API key is set or the request fails.
 */
export async function translateJapaneseSentence(
  sentence: string,
  settings: AppSettings,
  targetWordOrContext?: string | TranslationContext
): Promise<TranslationResult> {
  const cleaned = sentence.trim();
  if (!cleaned) return { translation: '', providerUsed: 'none' };

  const provider = settings.anki.translationProvider;
  const targetLang = settings.anki.translationTargetLang || 'en';
  const ctx: TranslationContext =
    typeof targetWordOrContext === 'string'
      ? { targetWord: targetWordOrContext }
      : (targetWordOrContext ?? {});

  if (provider === 'off') {
    return { translation: '', providerUsed: 'off' };
  }

  if (provider === 'openrouter' && settings.stt.apiKey.trim()) {
    try {
      const text = await translateWithOpenRouter(
        settings.stt.apiKey.trim(),
        cleaned,
        targetLang,
        settings.anki.translationModel || 'google/gemini-2.5-flash',
        ctx
      );
      if (text) return { translation: text, providerUsed: 'openrouter' };
    } catch {
      // Fall back to Google Translate free endpoint
    }
  }

  const googleText = await translateWithGoogleFree(cleaned, targetLang);
  return { translation: googleText, providerUsed: 'google_free' };
}

export function buildTranslationUserPrompt(sentence: string, ctx: TranslationContext): string {
  const parts: string[] = [];
  if (ctx.showTitle?.trim()) {
    parts.push(`Show: ${ctx.showTitle.trim()}`);
  }
  const before = (ctx.contextBefore ?? []).map((l) => l.trim()).filter(Boolean).slice(-3);
  if (before.length > 0) {
    parts.push(`Previous dialogue (context only, do not translate):\n${before.map((l) => `- ${l}`).join('\n')}`);
  }
  parts.push(`Target line to translate:\n${sentence}`);
  const after = (ctx.contextAfter ?? []).map((l) => l.trim()).filter(Boolean).slice(0, 1);
  if (after.length > 0) {
    parts.push(`Next dialogue (context only, do not translate):\n${after.map((l) => `- ${l}`).join('\n')}`);
  }
  if (ctx.targetWord?.trim()) {
    parts.push(`Target vocabulary word: ${ctx.targetWord.trim()}`);
  }
  return parts.join('\n\n');
}

export function cleanLlmTranslation(raw: string): string {
  let text = raw.trim();
  // Strip accidental label prefixes like "Translation:"
  text = text.replace(/^(?:translation|english|output)\s*:\s*/i, '').trim();
  // Strip accidental wrapping quotes
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith('“') && text.endsWith('”')) ||
    (text.startsWith('「') && text.endsWith('」'))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

export function parseGoogleTranslateResponse(data: unknown): string {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return '';
  return (data[0] as unknown[])
    .map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : ''))
    .join('')
    .trim();
}

async function translateWithGoogleFree(sentence: string, targetLang: string): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ja&tl=${encodeURIComponent(
    targetLang
  )}&dt=t&q=${encodeURIComponent(sentence)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Translation HTTP error: ${res.status}`);
  }
  const data: unknown = await res.json();
  return parseGoogleTranslateResponse(data);
}

async function translateWithOpenRouter(
  apiKey: string,
  sentence: string,
  targetLang: string,
  model: string,
  ctx: TranslationContext
): Promise<string> {
  const payload: Record<string, unknown> = {
    model: model.trim() || 'google/gemini-2.5-flash',
    temperature: 0.2,
    max_tokens: 260,
    messages: [
      {
        role: 'system',
        content: [
          `You are an expert Japanese-to-${targetLang} anime and media subtitle translator.`,
          `Translate ONLY the "Target line to translate" into natural, idiomatic ${targetLang} that matches the speaker's tone and scene.`,
          `- Use the surrounding dialogue context (if provided) to accurately infer omitted Japanese subjects, pronouns, objects, and nuance.`,
          `- Never include or translate the surrounding context lines in your output.`,
          `- Preserve colloquial speech, slang, idioms, and the exact contextual sense of any target vocabulary word rather than translating literally.`,
          `- Output ONLY the final translation text—no quotes, no explanations, no romaji, and no prefixes.`,
        ].join('\n'),
      },
      { role: 'user', content: buildTranslationUserPrompt(sentence, ctx) },
    ],
  };

  if (model.includes('gemini-2.5-flash')) {
    payload.reasoning = { effort: 'none' };
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'KotoStream',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter translation error: ${res.status}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return cleanLlmTranslation(json.choices?.[0]?.message?.content ?? '');
}
