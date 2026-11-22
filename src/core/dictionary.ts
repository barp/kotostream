import type { DictionaryEntry } from '../types';
import { deconjugate } from './deconjugator';

/**
 * Curated offline core Japanese dictionary (particles, grammar words, common
 * everyday & anime/drama words) for instant zero-latency lookups and readings.
 * Any word not found here falls back to Jisho.org API (JMdict) via the background worker.
 */
const CORE_DICTIONARY: Record<string, { reading: string; definitions: string[]; pos: string[]; jlpt?: string[] }> = {
  // Particles & Grammar
  は: { reading: 'は', definitions: ['topic marker particle'], pos: ['particle'], jlpt: ['N5'] },
  が: { reading: 'が', definitions: ['subject marker particle', 'but; however'], pos: ['particle'], jlpt: ['N5'] },
  を: { reading: 'を', definitions: ['direct object marker particle'], pos: ['particle'], jlpt: ['N5'] },
  に: { reading: 'に', definitions: ['at; in; to; for (location, time, indirect object)'], pos: ['particle'], jlpt: ['N5'] },
  で: { reading: 'で', definitions: ['at; in (place of action); by means of'], pos: ['particle'], jlpt: ['N5'] },
  の: { reading: 'の', definitions: ['possessive particle (of, \'s); nominalizer'], pos: ['particle'], jlpt: ['N5'] },
  と: { reading: 'と', definitions: ['and; with; quotation particle'], pos: ['particle'], jlpt: ['N5'] },
  も: { reading: 'も', definitions: ['also; too; as well'], pos: ['particle'], jlpt: ['N5'] },
  へ: { reading: 'へ', definitions: ['to; toward (direction)'], pos: ['particle'], jlpt: ['N5'] },
  から: { reading: 'から', definitions: ['from; because; since'], pos: ['particle'], jlpt: ['N5'] },
  まで: { reading: 'まで', definitions: ['until; up to; as far as'], pos: ['particle'], jlpt: ['N5'] },
  より: { reading: 'より', definitions: ['than; from'], pos: ['particle'], jlpt: ['N4'] },
  か: { reading: 'か', definitions: ['question marker; or'], pos: ['particle'], jlpt: ['N5'] },
  ね: { reading: 'ね', definitions: ['isn\'t it?; right? (seeking agreement)'], pos: ['particle'], jlpt: ['N5'] },
  よ: { reading: 'よ', definitions: ['emphasis / assertion particle'], pos: ['particle'], jlpt: ['N5'] },
  けど: { reading: 'けど', definitions: ['but; however; although'], pos: ['conjunction'], jlpt: ['N5'] },
  けれど: { reading: 'けれど', definitions: ['but; however; although'], pos: ['conjunction'], jlpt: ['N5'] },
  だ: { reading: 'だ', definitions: ['is; am; are (plain copula)'], pos: ['copula'], jlpt: ['N5'] },
  です: { reading: 'です', definitions: ['is; am; are (polite copula)'], pos: ['copula'], jlpt: ['N5'] },
  だった: { reading: 'だった', definitions: ['was; were (plain past copula)'], pos: ['copula'], jlpt: ['N5'] },
  でした: { reading: 'でした', definitions: ['was; were (polite past copula)'], pos: ['copula'], jlpt: ['N5'] },
  じゃない: { reading: 'じゃない', definitions: ['is not (plain negative copula)'], pos: ['expression'], jlpt: ['N5'] },

  // Pronouns & Demonstratives
  私: { reading: 'わたし', definitions: ['I; me'], pos: ['pronoun'], jlpt: ['N5'] },
  僕: { reading: 'ぼく', definitions: ['I; me (masculine)'], pos: ['pronoun'], jlpt: ['N5'] },
  俺: { reading: 'おれ', definitions: ['I; me (casual/rough masculine)'], pos: ['pronoun'], jlpt: ['N4'] },
  あなた: { reading: 'あなた', definitions: ['you'], pos: ['pronoun'], jlpt: ['N5'] },
  君: { reading: 'きみ', definitions: ['you (familiar)'], pos: ['pronoun'], jlpt: ['N4'] },
  彼: { reading: 'かれ', definitions: ['he; him; boyfriend'], pos: ['pronoun'], jlpt: ['N5'] },
  彼女: { reading: 'かのじょ', definitions: ['she; her; girlfriend'], pos: ['pronoun'], jlpt: ['N5'] },
  みんな: { reading: 'みんな', definitions: ['everyone; everybody; all'], pos: ['noun'], jlpt: ['N5'] },
  これ: { reading: 'これ', definitions: ['this (one)'], pos: ['pronoun'], jlpt: ['N5'] },
  それ: { reading: 'それ', definitions: ['that (one)'], pos: ['pronoun'], jlpt: ['N5'] },
  あれ: { reading: 'あれ', definitions: ['that (over there)'], pos: ['pronoun'], jlpt: ['N5'] },
  ここ: { reading: 'ここ', definitions: ['here; this place'], pos: ['pronoun'], jlpt: ['N5'] },
  そこ: { reading: 'そこ', definitions: ['there; that place'], pos: ['pronoun'], jlpt: ['N5'] },
  何: { reading: 'なに', definitions: ['what'], pos: ['pronoun'], jlpt: ['N5'] },
  誰: { reading: 'だれ', definitions: ['who'], pos: ['pronoun'], jlpt: ['N5'] },
  どこ: { reading: 'どこ', definitions: ['where'], pos: ['pronoun'], jlpt: ['N5'] },
  いつ: { reading: 'いつ', definitions: ['when'], pos: ['pronoun'], jlpt: ['N5'] },
  なぜ: { reading: 'なぜ', definitions: ['why; how'], pos: ['adverb'], jlpt: ['N5'] },
  どうして: { reading: 'どうして', definitions: ['why; for what reason'], pos: ['adverb'], jlpt: ['N5'] },

  // Common Verbs
  する: { reading: 'する', definitions: ['to do; to carry out; to perform'], pos: ['verb'], jlpt: ['N5'] },
  いる: { reading: 'いる', definitions: ['to be (animate); to exist'], pos: ['verb'], jlpt: ['N5'] },
  ある: { reading: 'ある', definitions: ['to be (inanimate); to exist; to have'], pos: ['verb'], jlpt: ['N5'] },
  なる: { reading: 'なる', definitions: ['to become; to turn into'], pos: ['verb'], jlpt: ['N5'] },
  行く: { reading: 'いく', definitions: ['to go; to move toward'], pos: ['verb'], jlpt: ['N5'] },
  来る: { reading: 'くる', definitions: ['to come; to arrive'], pos: ['verb'], jlpt: ['N5'] },
  見る: { reading: 'みる', definitions: ['to see; to look; to watch'], pos: ['verb'], jlpt: ['N5'] },
  食べる: { reading: 'たべる', definitions: ['to eat'], pos: ['verb'], jlpt: ['N5'] },
  飲む: { reading: 'のむ', definitions: ['to drink'], pos: ['verb'], jlpt: ['N5'] },
  言う: { reading: 'いう', definitions: ['to say; to utter'], pos: ['verb'], jlpt: ['N5'] },
  話す: { reading: 'はなす', definitions: ['to talk; to speak'], pos: ['verb'], jlpt: ['N5'] },
  聞く: { reading: 'きく', definitions: ['to hear; to listen; to ask'], pos: ['verb'], jlpt: ['N5'] },
  思う: { reading: 'おもう', definitions: ['to think; to consider; to feel'], pos: ['verb'], jlpt: ['N4'] },
  知る: { reading: 'しる', definitions: ['to know; to be aware of'], pos: ['verb'], jlpt: ['N5'] },
  分かる: { reading: 'わかる', definitions: ['to understand; to comprehend'], pos: ['verb'], jlpt: ['N5'] },
  わかる: { reading: 'わかる', definitions: ['to understand; to comprehend'], pos: ['verb'], jlpt: ['N5'] },
  出来る: { reading: 'できる', definitions: ['to be able to do; to be possible; to be made'], pos: ['verb'], jlpt: ['N5'] },
  できる: { reading: 'できる', definitions: ['to be able to do; to be possible; to be made'], pos: ['verb'], jlpt: ['N5'] },
  綺麗: { reading: 'きれい', definitions: ['pretty; clean; neat; tidy'], pos: ['na-adj'], jlpt: ['N5'] },
  きれい: { reading: 'きれい', definitions: ['pretty; clean; neat; tidy'], pos: ['na-adj'], jlpt: ['N5'] },
  凄い: { reading: 'すごい', definitions: ['amazing; incredible; terrific; awful'], pos: ['i-adj'], jlpt: ['N5'] },
  事: { reading: 'こと', definitions: ['thing; matter; fact'], pos: ['noun'], jlpt: ['N5'] },
  こと: { reading: 'こと', definitions: ['thing; matter; fact'], pos: ['noun'], jlpt: ['N5'] },
  物: { reading: 'もの', definitions: ['thing; object'], pos: ['noun'], jlpt: ['N5'] },
  もの: { reading: 'もの', definitions: ['thing; object'], pos: ['noun'], jlpt: ['N5'] },
  時: { reading: 'とき', definitions: ['time; hour; occasion'], pos: ['noun'], jlpt: ['N5'] },
  とき: { reading: 'とき', definitions: ['time; hour; occasion'], pos: ['noun'], jlpt: ['N5'] },
  所: { reading: 'ところ', definitions: ['place; spot; point'], pos: ['noun'], jlpt: ['N5'] },
  ところ: { reading: 'ところ', definitions: ['place; spot; point'], pos: ['noun'], jlpt: ['N5'] },
  訳: { reading: 'わけ', definitions: ['reason; meaning; sense'], pos: ['noun'], jlpt: ['N4'] },
  わけ: { reading: 'わけ', definitions: ['reason; meaning; sense'], pos: ['noun'], jlpt: ['N4'] },
  為: { reading: 'ため', definitions: ['for; in order to; sake'], pos: ['noun'], jlpt: ['N4'] },
  ため: { reading: 'ため', definitions: ['for; in order to; sake'], pos: ['noun'], jlpt: ['N4'] },
  待つ: { reading: 'まつ', definitions: ['to wait'], pos: ['verb'], jlpt: ['N5'] },
  帰る: { reading: 'かえる', definitions: ['to return; to go home'], pos: ['verb'], jlpt: ['N5'] },
  作る: { reading: 'つくる', definitions: ['to make; to produce; to create'], pos: ['verb'], jlpt: ['N5'] },
  使う: { reading: 'つかう', definitions: ['to use; to make use of'], pos: ['verb'], jlpt: ['N5'] },
  守る: { reading: 'まもる', definitions: ['to protect; to guard; to keep (a promise)'], pos: ['verb'], jlpt: ['N3'] },
  戦う: { reading: 'たたかう', definitions: ['to fight; to battle; to struggle'], pos: ['verb'], jlpt: ['N3'] },
  信じる: { reading: 'しんじる', definitions: ['to believe; to trust'], pos: ['verb'], jlpt: ['N3'] },
  忘れる: { reading: 'わすれる', definitions: ['to forget'], pos: ['verb'], jlpt: ['N5'] },
  覚える: { reading: 'おぼえる', definitions: ['to remember; to memorize; to learn'], pos: ['verb'], jlpt: ['N5'] },
  走る: { reading: 'はしる', definitions: ['to run'], pos: ['verb'], jlpt: ['N5'] },
  助ける: { reading: 'たすける', definitions: ['to help; to save; to rescue'], pos: ['verb'], jlpt: ['N3'] },
  探す: { reading: 'さがす', definitions: ['to search for; to look for'], pos: ['verb'], jlpt: ['N4'] },
  見つける: { reading: 'みつける', definitions: ['to find; to discover'], pos: ['verb'], jlpt: ['N4'] },
  始まる: { reading: 'はじまる', definitions: ['to begin; to start'], pos: ['verb'], jlpt: ['N5'] },
  終わる: { reading: 'おわる', definitions: ['to end; to finish'], pos: ['verb'], jlpt: ['N5'] },

  // Common Nouns & Adjectives
  今日: { reading: 'きょう', definitions: ['today; this day'], pos: ['noun'], jlpt: ['N5'] },
  明日: { reading: 'あした', definitions: ['tomorrow'], pos: ['noun'], jlpt: ['N5'] },
  昨日: { reading: 'きのう', definitions: ['yesterday'], pos: ['noun'], jlpt: ['N5'] },
  今: { reading: 'いま', definitions: ['now; the present time'], pos: ['noun'], jlpt: ['N5'] },
  時間: { reading: 'じかん', definitions: ['time; hour'], pos: ['noun'], jlpt: ['N5'] },
  人: { reading: 'ひと', definitions: ['person; human being'], pos: ['noun'], jlpt: ['N5'] },
  友達: { reading: 'ともだち', definitions: ['friend; companion'], pos: ['noun'], jlpt: ['N5'] },
  世界: { reading: 'せかい', definitions: ['the world; society; universe'], pos: ['noun'], jlpt: ['N4'] },
  名前: { reading: 'なまえ', definitions: ['name; full name'], pos: ['noun'], jlpt: ['N5'] },
  言葉: { reading: 'ことば', definitions: ['language; word; phrase; speech'], pos: ['noun'], jlpt: ['N5'] },
  気持ち: { reading: 'きもち', definitions: ['feeling; sensation; mood'], pos: ['noun'], jlpt: ['N4'] },
  約束: { reading: 'やくそく', definitions: ['promise; agreement; appointment'], pos: ['noun'], jlpt: ['N4'] },
  秘密: { reading: 'ひみつ', definitions: ['secret; secrecy'], pos: ['noun'], jlpt: ['N3'] },
  本当: { reading: 'ほんとう', definitions: ['truth; reality; really'], pos: ['noun', 'na-adj'], jlpt: ['N5'] },
  大丈夫: { reading: 'だいじょうぶ', definitions: ['safe; all right; okay'], pos: ['na-adj'], jlpt: ['N5'] },
  好き: { reading: 'すき', definitions: ['liked; favorite; in love with'], pos: ['na-adj'], jlpt: ['N5'] },
  嫌い: { reading: 'きらい', definitions: ['disliked; hated'], pos: ['na-adj'], jlpt: ['N5'] },
  嬉しい: { reading: 'うれしい', definitions: ['happy; glad; pleased'], pos: ['i-adj'], jlpt: ['N4'] },
  悲しい: { reading: 'かなしい', definitions: ['sad; sorrowful'], pos: ['i-adj'], jlpt: ['N4'] },
  楽しい: { reading: 'たのしい', definitions: ['enjoyable; fun'], pos: ['i-adj'], jlpt: ['N5'] },
  強い: { reading: 'つよい', definitions: ['strong; powerful; mighty'], pos: ['i-adj'], jlpt: ['N5'] },
  怖い: { reading: 'こわい', definitions: ['scary; frightening; afraid'], pos: ['i-adj'], jlpt: ['N4'] },
  新しい: { reading: 'あたらしい', definitions: ['new; novel; fresh'], pos: ['i-adj'], jlpt: ['N5'] },
  大きい: { reading: 'おおきい', definitions: ['big; large; great'], pos: ['i-adj'], jlpt: ['N5'] },
  小さい: { reading: 'ちいさい', definitions: ['small; little; tiny'], pos: ['i-adj'], jlpt: ['N5'] },
  良い: { reading: 'よい', definitions: ['good; excellent; fine'], pos: ['i-adj'], jlpt: ['N5'] },
  いい: { reading: 'いい', definitions: ['good; fine; okay'], pos: ['i-adj'], jlpt: ['N5'] },
  悪い: { reading: 'わるい', definitions: ['bad; poor; sorry'], pos: ['i-adj'], jlpt: ['N5'] },
  早い: { reading: 'はやい', definitions: ['fast; quick; early'], pos: ['i-adj'], jlpt: ['N5'] },
  遅い: { reading: 'おそい', definitions: ['slow; late'], pos: ['i-adj'], jlpt: ['N5'] },
  面白い: { reading: 'おもしろい', definitions: ['interesting; fascinating; funny'], pos: ['i-adj'], jlpt: ['N5'] },
  美味しい: { reading: 'おいしい', definitions: ['delicious; tasty'], pos: ['i-adj'], jlpt: ['N5'] },
  可愛い: { reading: 'かわいい', definitions: ['cute; adorable; lovely'], pos: ['i-adj'], jlpt: ['N5'] },
  映画: { reading: 'えいが', definitions: ['movie; film'], pos: ['noun'], jlpt: ['N5'] },
  日本語: { reading: 'にほんご', definitions: ['Japanese language'], pos: ['noun'], jlpt: ['N5'] },
  字幕: { reading: 'じまく', definitions: ['subtitles; captions'], pos: ['noun'], jlpt: ['N1'] },
  天気: { reading: 'てんき', definitions: ['weather'], pos: ['noun'], jlpt: ['N5'] },
  雨: { reading: 'あめ', definitions: ['rain'], pos: ['noun'], jlpt: ['N5'] },
  夜: { reading: 'よる', definitions: ['evening; night'], pos: ['noun'], jlpt: ['N5'] },
  朝: { reading: 'あさ', definitions: ['morning'], pos: ['noun'], jlpt: ['N5'] },
  学校: { reading: 'がっこう', definitions: ['school'], pos: ['noun'], jlpt: ['N5'] },
  仕事: { reading: 'しごと', definitions: ['work; job; occupation'], pos: ['noun'], jlpt: ['N5'] },
  家族: { reading: 'かぞく', definitions: ['family'], pos: ['noun'], jlpt: ['N5'] },
  先生: { reading: 'せんせい', definitions: ['teacher; master; doctor'], pos: ['noun'], jlpt: ['N5'] },
  学生: { reading: 'がくせい', definitions: ['student'], pos: ['noun'], jlpt: ['N5'] },
  ありがとう: { reading: 'ありがとう', definitions: ['thank you'], pos: ['expression'], jlpt: ['N5'] },
  すみません: { reading: 'すみません', definitions: ['excuse me; pardon me; I\'m sorry'], pos: ['expression'], jlpt: ['N5'] },
  ごめん: { reading: 'ごめん', definitions: ['I\'m sorry; excuse me (casual)'], pos: ['expression'], jlpt: ['N4'] },
  お願い: { reading: 'おねがい', definitions: ['request; favor; please'], pos: ['noun'], jlpt: ['N5'] },
  絶対: { reading: 'ぜったい', definitions: ['absolutely; definitely; unconditionally'], pos: ['noun', 'adverb'], jlpt: ['N3'] },
  一緒に: { reading: 'いっしょに', definitions: ['together; with'], pos: ['adverb'], jlpt: ['N5'] },
  一緒: { reading: 'いっしょ', definitions: ['together; the same'], pos: ['noun'], jlpt: ['N5'] },
  もう一度: { reading: 'もういちど', definitions: ['once more; again'], pos: ['expression'], jlpt: ['N5'] },
  もちろん: { reading: 'もちろん', definitions: ['of course; certainly'], pos: ['adverb'], jlpt: ['N4'] },
  やっぱり: { reading: 'やっぱり', definitions: ['as expected; after all; still'], pos: ['adverb'], jlpt: ['N4'] },
  ちょっと: { reading: 'ちょっと', definitions: ['a little; a bit; just a minute'], pos: ['adverb'], jlpt: ['N5'] },
  もう: { reading: 'もう', definitions: ['already; soon; anymore'], pos: ['adverb'], jlpt: ['N5'] },
  まだ: { reading: 'まだ', definitions: ['still; not yet'], pos: ['adverb'], jlpt: ['N5'] },
  すぐ: { reading: 'すぐ', definitions: ['immediately; right away; soon'], pos: ['adverb'], jlpt: ['N5'] },
  本当に: { reading: 'ほんとうに', definitions: ['really; truly'], pos: ['adverb'], jlpt: ['N5'] },
  どっち: { reading: 'どっち', definitions: ['which way; which direction; which one (casual)'], pos: ['pronoun'], jlpt: ['N5'] },
  こっち: { reading: 'こっち', definitions: ['this way; this direction; here; this one (casual)'], pos: ['pronoun'], jlpt: ['N5'] },
  そっち: { reading: 'そっち', definitions: ['that way; there; that one (casual)'], pos: ['pronoun'], jlpt: ['N5'] },
  あっち: { reading: 'あっち', definitions: ['that way; over there (casual)'], pos: ['pronoun'], jlpt: ['N5'] },
  すごい: { reading: 'すごい', definitions: ['amazing; incredible; terrific; awful'], pos: ['i-adj'], jlpt: ['N5'] },
  すごく: { reading: 'すごく', definitions: ['very; extremely; awfully'], pos: ['adverb'], jlpt: ['N4'] },
  めっちゃ: { reading: 'めっちゃ', definitions: ['very; super; extremely (colloquial)'], pos: ['adverb'] },
  なんか: { reading: 'なんか', definitions: ['like; sort of; somehow; something (casual)'], pos: ['adverb'] },
  ちゃんと: { reading: 'ちゃんと', definitions: ['properly; diligently; accurately'], pos: ['adverb'], jlpt: ['N4'] },
  ずっと: { reading: 'ずっと', definitions: ['continuously; all along; much (more)'], pos: ['adverb'], jlpt: ['N4'] },
  たぶん: { reading: 'たぶん', definitions: ['probably; perhaps; maybe'], pos: ['adverb'], jlpt: ['N5'] },
  もしかして: { reading: 'もしかして', definitions: ['perhaps; possibly; could it be that'], pos: ['adverb'], jlpt: ['N3'] },
  なるほど: { reading: 'なるほど', definitions: ['I see!; indeed; that makes sense'], pos: ['expression'], jlpt: ['N3'] },
  やっぱ: { reading: 'やっぱ', definitions: ['as expected; after all (casual)'], pos: ['adverb'] },
  うそ: { reading: 'うそ', definitions: ['lie; falsehood; no way!'], pos: ['noun'], jlpt: ['N4'] },
  嘘: { reading: 'うそ', definitions: ['lie; falsehood; no way!'], pos: ['noun'], jlpt: ['N4'] },
  マジ: { reading: 'まじ', definitions: ['seriously; really; for real (slang)'], pos: ['adverb', 'na-adj'] },
  ヤバい: { reading: 'やばい', definitions: ['dangerous; crazy; awesome; bad (slang)'], pos: ['i-adj'] },
  やばい: { reading: 'やばい', definitions: ['dangerous; crazy; awesome; bad (slang)'], pos: ['i-adj'] },
};

export const PARTICLE_SET = new Set([
  'は', 'が', 'を', 'に', 'で', 'の', 'と', 'も', 'へ', 'か', 'ね', 'よ', 'わ', 'さ', 'な', 'ぞ', 'ぜ',
  'から', 'まで', 'より', 'けど', 'けれど', 'って', 'て', 'で', 'し', 'ば', 'たら', 'なら',
  'だ', 'です', 'だった', 'でした', 'ます', 'ました', 'ません', 'ない', 'た', 'る', 'ん', 'の',
]);

/**
 * Returns true if the exact word exists in the bundled local core dictionary.
 */
export function hasLocalExact(word: string): boolean {
  return Boolean(CORE_DICTIONARY[word]);
}

/**
 * Instant synchronous lookup in the local bundled core dictionary.
 */
export function lookupLocal(word: string): DictionaryEntry | null {
  const candidates = deconjugate(word);
  for (const candidate of candidates) {
    const hit = CORE_DICTIONARY[candidate];
    if (hit) {
      return {
        word: candidate,
        reading: hit.reading,
        senses: [{ definitions: hit.definitions, partsOfSpeech: hit.pos }],
        jlpt: hit.jlpt,
        isCommon: true,
        source: 'local',
      };
    }
  }
  return null;
}

interface JishoApiResponse {
  data: Array<{
    slug: string;
    is_common?: boolean;
    jlpt?: string[];
    japanese: Array<{ word?: string; reading?: string }>;
    senses: Array<{
      english_definitions: string[];
      parts_of_speech: string[];
    }>;
  }>;
}

/**
 * Looks up a Japanese word via Jisho.org's public JMdict API.
 * When `exactOnly` is true, returns a match ONLY if the exact word appears in JMdict's japanese[] forms.
 */
export async function lookupOnJisho(word: string, exactOnly = false): Promise<DictionaryEntry | null> {
  const candidates = exactOnly ? [word.trim()] : deconjugate(word);
  const query = candidates[0] || word;

  const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(query)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Jisho API error: ${response.status}`);
  }
  const json = (await response.json()) as JishoApiResponse;
  if (!json.data || json.data.length === 0) {
    if (!exactOnly && candidates.length > 1) {
      const retryUrl = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(candidates[1])}`;
      const retryRes = await fetch(retryUrl);
      if (retryRes.ok) {
        const retryJson = (await retryRes.json()) as JishoApiResponse;
        if (retryJson.data && retryJson.data.length > 0) {
          return parseJishoItem(retryJson.data[0], candidates[1], candidates);
        }
      }
    }
    return null;
  }

  // Prefer an exact match on the original word first, then any deconjugated candidate
  const exactOriginal = json.data.find((item) =>
    item.japanese.some((j) => j.word === query || j.reading === query)
  );
  if (exactOnly) {
    return exactOriginal ? parseJishoItem(exactOriginal, query, [query]) : null;
  }

  const candidateSet = new Set(candidates);
  const exactCandidate =
    exactOriginal ??
    json.data.find((item) =>
      item.japanese.some(
        (j) => (j.word && candidateSet.has(j.word)) || (j.reading && candidateSet.has(j.reading))
      )
    );

  return parseJishoItem(exactCandidate ?? json.data[0], query, candidates);
}

export function parseJishoItem(
  item: JishoApiResponse['data'][number],
  fallbackWord: string,
  candidates: string[] = [fallbackWord]
): DictionaryEntry {
  const candidateSet = new Set(candidates);

  // Pick the specific japanese[] variant that actually matched the subtitle word (e.g. どっち instead of どちら)
  const matchedVariant =
    item.japanese.find((j) => j.word === fallbackWord || j.reading === fallbackWord) ??
    item.japanese.find(
      (j) => (j.word && candidateSet.has(j.word)) || (j.reading && candidateSet.has(j.reading))
    ) ??
    item.japanese[0] ??
    {};

  // If the matched variant is kana-only (e.g. { reading: 'どっち' } with no kanji word),
  // display 'どっち' as both word and reading rather than showing an unrelated kanji form!
  const word = matchedVariant.word || matchedVariant.reading || fallbackWord;
  const reading = matchedVariant.reading || matchedVariant.word || fallbackWord;

  const altSet = new Set<string>();
  for (const j of item.japanese) {
    if (j.word) altSet.add(j.word);
    if (j.reading) altSet.add(j.reading);
  }

  return {
    word,
    reading,
    altForms: Array.from(altSet),
    senses: item.senses.slice(0, 4).map((s) => ({
      definitions: s.english_definitions.slice(0, 5),
      partsOfSpeech: s.parts_of_speech.slice(0, 2),
    })),
    jlpt: item.jlpt?.map((j) => j.replace('jlpt-', '').toUpperCase()),
    isCommon: item.is_common,
    source: 'jisho',
  };
}
