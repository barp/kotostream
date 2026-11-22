import kuromoji from '@sglkc/kuromoji';
import type { KuromojiMorpheme } from '../core/mecab-tokenizer';

interface KuromojiTokenizer {
  tokenize(text: string): KuromojiMorpheme[];
}

let tokenizerPromise: Promise<KuromojiTokenizer> | null = null;

/**
 * Lazily loads the MeCab IPADIC dictionary from the extension's bundled `dist/dict/`
 * inside the Chrome MV3 background service worker. Loads once (~350ms), then runs in <1ms/line.
 */
export function getMeCabTokenizer(): Promise<KuromojiTokenizer> {
  if (!tokenizerPromise) {
    // IMPORTANT: Do NOT pass chrome.runtime.getURL('dict') directly because Kuromoji's
    // DictionaryLoader runs `.replace(/\/{1,}/g, '/')`, which corrupts `chrome-extension://`
    // into `chrome-extension:/`! A root-relative `/dict` path resolves cleanly via fetch()
    // against the extension's own chrome-extension://<id> origin.
    const dicPath =
      typeof chrome !== 'undefined' && chrome.runtime?.id
        ? '/dict'
        : 'node_modules/@sglkc/kuromoji/dict';

    tokenizerPromise = new Promise<KuromojiTokenizer>((resolve, reject) => {
      kuromoji.builder({ dicPath }).build((err, tokenizer) => {
        if (err || !tokenizer) {
          tokenizerPromise = null;
          reject(err ?? new Error('Failed to initialize Kuromoji MeCab tokenizer'));
        } else {
          resolve(tokenizer as unknown as KuromojiTokenizer);
        }
      });
    });
  }
  return tokenizerPromise;
}

export async function analyzeWithMeCab(text: string): Promise<KuromojiMorpheme[]> {
  const tokenizer = await getMeCabTokenizer();
  return tokenizer.tokenize(text);
}
