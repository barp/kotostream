import type { AppSettings } from '../types';

export interface TranslationResult {
  translation: string;
  providerUsed: string;
}

/**
 * Translates a mined Japanese sentence into the target language (default: English).
 * Supports free Google Translate (zero-key default) and OpenRouter LLM.
 */
export async function translateJapaneseSentence(
  sentence: string,
  settings: AppSettings,
  targetWord?: string
): Promise<TranslationResult> {
  const cleaned = sentence.trim();
  if (!cleaned) return { translation: '', providerUsed: 'none' };

  const provider = settings.anki.translationProvider;
  const targetLang = settings.anki.translationTargetLang || 'en';

  if (provider === 'off') {
    return { translation: '', providerUsed: 'off' };
  }

  if (provider === 'openrouter' && settings.stt.apiKey.trim()) {
    try {
      const text = await translateWithOpenRouter(
        settings.stt.apiKey.trim(),
        cleaned,
        targetLang,
        targetWord
      );
      if (text) return { translation: text, providerUsed: 'openrouter' };
    } catch {
      // Fall back to Google Translate free endpoint
    }
  }

  const googleText = await translateWithGoogleFree(cleaned, targetLang);
  return { translation: googleText, providerUsed: 'google_free' };
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
  targetWord?: string
): Promise<string> {
  const focusHint = targetWord ? ` Pay special attention to accurately rendering the nuance of "${targetWord}".` : '';
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'KotoStream',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      temperature: 0.2,
      max_tokens: 180,
      reasoning: { effort: 'none' },
      messages: [
        {
          role: 'system',
          content: `You are a natural Japanese-to-${targetLang} subtitle translator. Translate the Japanese dialogue line naturally and concisely. Return ONLY the translation with no quotes, notes, or romaji.${focusHint}`,
        },
        { role: 'user', content: sentence },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter translation error: ${res.status}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content?.trim() ?? '';
}
