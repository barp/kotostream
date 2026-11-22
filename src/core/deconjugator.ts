/**
 * Lightweight Japanese deconjugator that derives candidate dictionary forms
 * from inflected verbs and adjectives.
 */

interface DeconjugationRule {
  suffix: string;
  replacements: string[];
  reason: string;
}

const RULES: DeconjugationRule[] = [
  // Polite forms
  { suffix: 'ませんでした', replacements: ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む'], reason: 'polite past negative' },
  { suffix: 'ました', replacements: ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む'], reason: 'polite past' },
  { suffix: 'ません', replacements: ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む'], reason: 'polite negative' },
  { suffix: 'ます', replacements: ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む'], reason: 'polite' },
  { suffix: 'ましょう', replacements: ['る', 'う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む'], reason: 'polite volitional' },

  // Progressive / resultant state (ている / てる / でいる / でる)
  { suffix: 'ていました', replacements: ['る', 'く', 'す', 'つ', 'う', 'る'], reason: 'progressive polite past' },
  { suffix: 'ています', replacements: ['る', 'く', 'す', 'つ', 'う'], reason: 'progressive polite' },
  { suffix: 'ていた', replacements: ['る', 'く', 'す', 'つ', 'う'], reason: 'progressive past' },
  { suffix: 'ている', replacements: ['る', 'く', 'す', 'つ', 'う'], reason: 'progressive' },
  { suffix: 'てた', replacements: ['る', 'く', 'す', 'つ', 'う'], reason: 'colloquial progressive past' },
  { suffix: 'てる', replacements: ['る', 'く', 'す', 'つ', 'う'], reason: 'colloquial progressive' },
  { suffix: 'でいた', replacements: ['ぐ', 'ぬ', 'ぶ', 'む'], reason: 'progressive past' },
  { suffix: 'でいる', replacements: ['ぐ', 'ぬ', 'ぶ', 'む'], reason: 'progressive' },
  { suffix: 'でた', replacements: ['ぐ', 'ぬ', 'ぶ', 'む'], reason: 'colloquial progressive past' },
  { suffix: 'でる', replacements: ['ぐ', 'ぬ', 'ぶ', 'む'], reason: 'colloquial progressive' },

  // Godan i-row / a-row stem shifts
  { suffix: 'いなかった', replacements: ['いる'], reason: 'negative past' },
  { suffix: 'なかった', replacements: ['る', 'い'], reason: 'negative past' },
  { suffix: 'くない', replacements: ['い'], reason: 'i-adj negative' },
  { suffix: 'くなかった', replacements: ['い'], reason: 'i-adj negative past' },
  { suffix: 'かった', replacements: ['い'], reason: 'i-adj past' },
  { suffix: 'くて', replacements: ['い'], reason: 'i-adj te-form' },
  { suffix: 'ければ', replacements: ['い'], reason: 'i-adj conditional' },

  // Verb negative / passive / causative / potential
  { suffix: 'られない', replacements: ['る'], reason: 'ichidan passive/potential negative' },
  { suffix: 'られる', replacements: ['る'], reason: 'ichidan passive/potential' },
  { suffix: 'させる', replacements: ['る'], reason: 'ichidan causative' },
  { suffix: 'ない', replacements: ['る'], reason: 'ichidan negative' },
  { suffix: 'かない', replacements: ['く'], reason: 'godan negative' },
  { suffix: 'がない', replacements: ['ぐ'], reason: 'godan negative' },
  { suffix: 'さない', replacements: ['す'], reason: 'godan negative' },
  { suffix: 'たない', replacements: ['つ'], reason: 'godan negative' },
  { suffix: 'なない', replacements: ['ぬ'], reason: 'godan negative' },
  { suffix: 'ばない', replacements: ['ぶ'], reason: 'godan negative' },
  { suffix: 'まない', replacements: ['む'], reason: 'godan negative' },
  { suffix: 'らない', replacements: ['る'], reason: 'godan negative' },
  { suffix: 'わない', replacements: ['う'], reason: 'godan negative' },

  { suffix: 'かなかった', replacements: ['く'], reason: 'godan negative past' },
  { suffix: 'がなかった', replacements: ['ぐ'], reason: 'godan negative past' },
  { suffix: 'さなかった', replacements: ['す'], reason: 'godan negative past' },
  { suffix: 'たなかった', replacements: ['つ'], reason: 'godan negative past' },
  { suffix: 'ばなかった', replacements: ['ぶ'], reason: 'godan negative past' },
  { suffix: 'まなかった', replacements: ['む'], reason: 'godan negative past' },
  { suffix: 'らなかった', replacements: ['る'], reason: 'godan negative past' },
  { suffix: 'わなかった', replacements: ['う'], reason: 'godan negative past' },

  // Past / te-form (ta / te / da / de / tta / tte / ita / ite / nda / nde)
  { suffix: 'っていた', replacements: ['う', 'つ', 'る'], reason: 'godan progressive past' },
  { suffix: 'っている', replacements: ['う', 'つ', 'る'], reason: 'godan progressive' },
  { suffix: 'ってる', replacements: ['う', 'つ', 'る'], reason: 'godan colloquial progressive' },
  { suffix: 'った', replacements: ['う', 'つ', 'る', 'く'], reason: 'godan past' },
  { suffix: 'って', replacements: ['う', 'つ', 'る', 'く'], reason: 'godan te-form' },
  { suffix: 'いた', replacements: ['く', 'いる'], reason: 'godan/ichidan past' },
  { suffix: 'いて', replacements: ['く', 'いる'], reason: 'godan/ichidan te-form' },
  { suffix: 'いだ', replacements: ['ぐ'], reason: 'godan past' },
  { suffix: 'いで', replacements: ['ぐ'], reason: 'godan te-form' },
  { suffix: 'した', replacements: ['す', 'する'], reason: 'godan/suru past' },
  { suffix: 'して', replacements: ['す', 'する'], reason: 'godan/suru te-form' },
  { suffix: 'んだ', replacements: ['ぬ', 'ぶ', 'む'], reason: 'godan past' },
  { suffix: 'んで', replacements: ['ぬ', 'ぶ', 'む'], reason: 'godan te-form' },
  { suffix: 'た', replacements: ['る'], reason: 'ichidan past' },
  { suffix: 'て', replacements: ['る'], reason: 'ichidan te-form' },

  // Desire (-tai)
  { suffix: 'たい', replacements: ['る'], reason: 'desire' },
  { suffix: 'たくない', replacements: ['る'], reason: 'desire negative' },
  { suffix: 'たかった', replacements: ['る'], reason: 'desire past' },

  // Colloquial 〜てしまう / 〜でしまう contractions (〜ちゃう / 〜じゃう / 〜ちまう / 〜じまう)
  { suffix: 'っちまおう', replacements: ['う', 'つ', 'る'], reason: 'colloquial shimau volitional' },
  { suffix: 'っちまった', replacements: ['う', 'つ', 'る'], reason: 'colloquial shimau past' },
  { suffix: 'っちまう', replacements: ['う', 'つ', 'る'], reason: 'colloquial shimau' },
  { suffix: 'っちまえ', replacements: ['う', 'つ', 'る'], reason: 'colloquial shimau imperative' },
  { suffix: 'ちまおう', replacements: ['る'], reason: 'ichidan colloquial shimau volitional' },
  { suffix: 'ちまった', replacements: ['る'], reason: 'ichidan colloquial shimau past' },
  { suffix: 'ちまう', replacements: ['る'], reason: 'ichidan colloquial shimau' },
  { suffix: 'んじまおう', replacements: ['ぬ', 'ぶ', 'む'], reason: 'godan colloquial shimau volitional' },
  { suffix: 'んじまった', replacements: ['ぬ', 'ぶ', 'む'], reason: 'godan colloquial shimau past' },
  { suffix: 'んじまう', replacements: ['ぬ', 'ぶ', 'む'], reason: 'godan colloquial shimau' },
  { suffix: 'っちゃおう', replacements: ['う', 'つ', 'る', 'く'], reason: 'colloquial chau volitional' },
  { suffix: 'っちゃった', replacements: ['う', 'つ', 'る', 'く'], reason: 'colloquial chau past' },
  { suffix: 'っちゃう', replacements: ['う', 'つ', 'る', 'く'], reason: 'colloquial chau' },
  { suffix: 'ちゃおう', replacements: ['る'], reason: 'ichidan colloquial chau volitional' },
  { suffix: 'ちゃった', replacements: ['る'], reason: 'ichidan colloquial chau past' },
  { suffix: 'ちゃう', replacements: ['る'], reason: 'ichidan colloquial chau' },
  { suffix: 'んじゃおう', replacements: ['ぬ', 'ぶ', 'む'], reason: 'godan colloquial jau volitional' },
  { suffix: 'んじゃった', replacements: ['ぬ', 'ぶ', 'む'], reason: 'godan colloquial jau past' },
  { suffix: 'んじゃう', replacements: ['ぬ', 'ぶ', 'む'], reason: 'godan colloquial jau' },

  // Conditional & volitional
  { suffix: 'れば', replacements: ['る'], reason: 'conditional' },
  { suffix: 'たら', replacements: ['る'], reason: 'conditional tara' },
  { suffix: 'だら', replacements: ['ぬ', 'ぶ', 'む', 'ぐ'], reason: 'godan conditional dara' },
  { suffix: 'ったら', replacements: ['う', 'つ', 'る'], reason: 'godan conditional tara' },
  { suffix: 'いた', replacements: ['く', 'いる'], reason: 'godan/ichidan past' },
  { suffix: 'いたら', replacements: ['く'], reason: 'godan conditional itara' },
  { suffix: 'したら', replacements: ['す', 'する'], reason: 'godan/suru conditional shitara' },
  { suffix: 'よう', replacements: ['る'], reason: 'ichidan volitional' },
];

// Map godan o-row volitional stem ending kana to dictionary u-row kana (行こう -> 行く, 飲もう -> 飲む)
const O_ROW_TO_U_ROW: Record<string, string> = {
  お: 'う',
  こ: 'く',
  ご: 'ぐ',
  そ: 'す',
  と: 'つ',
  の: 'ぬ',
  ぼ: 'ぶ',
  も: 'む',
  ろ: 'る',
};

// Map godan a-row stem ending kana to dictionary u-row kana (for passive -れる, causative -せる, negative -ない)
const A_ROW_TO_U_ROW: Record<string, string> = {
  わ: 'う',
  か: 'く',
  が: 'ぐ',
  さ: 'す',
  た: 'つ',
  な: 'ぬ',
  ば: 'ぶ',
  ま: 'む',
  ら: 'る',
};

// Map godan masu-stem ending kana (i-row) to dictionary u-row kana
const I_ROW_TO_U_ROW: Record<string, string> = {
  い: 'う',
  き: 'く',
  ぎ: 'ぐ',
  し: 'す',
  ち: 'つ',
  に: 'ぬ',
  び: 'ぶ',
  み: 'む',
  り: 'る',
};

const IRREGULAR_MAP: Record<string, string[]> = {
  する: ['する'],
  して: ['する'],
  した: ['する'],
  しない: ['する'],
  しなかった: ['する'],
  します: ['する'],
  しました: ['する'],
  しません: ['する'],
  できる: ['できる', '出来る'],
  できない: ['できる', '出来る'],
  できた: ['できる', '出来る'],
  できます: ['できる', '出来る'],
  できました: ['できる', '出来る'],
  できなかった: ['できる', '出来る'],
  出来る: ['出来る', 'できる'],
  出来ない: ['出来る', 'できる'],
  出来た: ['出来る', 'できる'],
  出来ます: ['出来る', 'できる'],
  出来ました: ['出来る', 'できる'],
  出来なかった: ['出来る', 'できる'],
  来る: ['来る'],
  来て: ['来る'],
  来た: ['来る'],
  来ない: ['来る'],
  来ます: ['来る'],
  きて: ['来る', '着る'],
  きた: ['来る', '着る'],
  こない: ['来る'],
  行っ: ['行く'],
  行って: ['行く'],
  行った: ['行く'],
  行っている: ['行く'],
  行ってる: ['行く'],
  いって: ['行く', '言う'],
  いった: ['行く', '言う'],
  良い: ['良い'],
  よかった: ['良い'],
  よくない: ['良い'],
  いい: ['いい', '良い'],
};

function deconjugateStep(word: string): string[] {
  const next = new Set<string>();

  if (IRREGULAR_MAP[word]) {
    for (const candidate of IRREGULAR_MAP[word]) {
      next.add(candidate);
    }
  }

  // Handle する-verb compounds like 勉強している -> 勉強する, 勉強
  for (const suruSuffix of [
    'しています', 'していた', 'している', 'してる', 'しました', 'します', 'しません',
    'しない', 'しなかった', 'して', 'した', 'したら', 'される', 'させる', 'する',
  ]) {
    if (word.length > suruSuffix.length && word.endsWith(suruSuffix)) {
      const stem = word.slice(0, -suruSuffix.length);
      next.add(stem + 'する');
      next.add(stem);
    }
  }

  // Handle godan polite/desire stems (i-row -> u-row): 食べます -> 食べる, 飲みます -> 飲む
  for (const masuSuffix of ['ませんでした', 'ました', 'ません', 'ましょう', 'ます', 'たい', 'たくない', 'たかった']) {
    if (word.length > masuSuffix.length && word.endsWith(masuSuffix)) {
      const stem = word.slice(0, -masuSuffix.length);
      next.add(stem + 'る');
      const lastChar = stem.slice(-1);
      if (I_ROW_TO_U_ROW[lastChar]) {
        next.add(stem.slice(0, -1) + I_ROW_TO_U_ROW[lastChar]);
      }
    }
  }

  // Handle godan passive / causative / negative (a-row -> u-row): 言われる -> 言う, 飲ませる -> 飲む
  for (const aSuffix of ['れる', 'せる', 'ない', 'なかった', 'ず', 'ぬ']) {
    if (word.length > aSuffix.length + 1 && word.endsWith(aSuffix)) {
      const stem = word.slice(0, -aSuffix.length);
      const lastChar = stem.slice(-1);
      if (A_ROW_TO_U_ROW[lastChar]) {
        next.add(stem.slice(0, -1) + A_ROW_TO_U_ROW[lastChar]);
      }
    }
  }

  // Handle godan volitional (o-row + う -> u-row): 行こう -> 行く, 飲もう -> 飲む
  if (word.length > 2 && word.endsWith('う')) {
    const prevChar = word.slice(-2, -1);
    if (O_ROW_TO_U_ROW[prevChar]) {
      next.add(word.slice(0, -2) + O_ROW_TO_U_ROW[prevChar]);
    }
  }

  // Handle general suffix rules (including ichidan passive -られる, causative -させる, conditional -たら, etc.)
  for (const rule of RULES) {
    if (word.length > rule.suffix.length && word.endsWith(rule.suffix)) {
      const stem = word.slice(0, -rule.suffix.length);
      for (const rep of rule.replacements) {
        next.add(stem + rep);
      }
    }
  }

  next.delete(word);
  return Array.from(next);
}

/**
 * Returns candidate dictionary forms for a Japanese word using multi-step BFS deconjugation
 * (handles chained conjugations like 飽きられたら -> 飽きられる -> 飽きる, 食べさせられた -> 食べる).
 */
export function deconjugate(word: string): string[] {
  const cleaned = word.trim();
  if (!cleaned) return [];

  const visited = new Set<string>([cleaned]);
  const queue: Array<{ form: string; depth: number }> = [{ form: cleaned, depth: 0 }];
  const MAX_DEPTH = 4;
  const MAX_CANDIDATES = 32;

  while (queue.length > 0 && visited.size < MAX_CANDIDATES) {
    const current = queue.shift()!;
    if (current.depth >= MAX_DEPTH) continue;

    for (const candidate of deconjugateStep(current.form)) {
      if (!visited.has(candidate) && candidate.length >= 1) {
        visited.add(candidate);
        queue.push({ form: candidate, depth: current.depth + 1 });
        if (visited.size >= MAX_CANDIDATES) break;
      }
    }
  }

  return Array.from(visited);
}
