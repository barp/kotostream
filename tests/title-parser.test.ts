import { describe, expect, it } from 'vitest';
import { matchesEpisodeFilename, parseMediaTitle } from '../src/core/title-parser';

describe('parseMediaTitle', () => {
  it('extracts show name and episode number from Amazon Prime Video titles', () => {
    expect(parseMediaTitle('Jujutsu Kaisen — S1 E4 - Curse Womb Must Die')).toEqual({
      showName: 'Jujutsu Kaisen',
      episodeNumber: 4,
    });
    expect(parseMediaTitle('Watch Demon Slayer - Season 1 | Prime Video')).toEqual({
      showName: 'Demon Slayer',
      episodeNumber: undefined,
    });
    expect(parseMediaTitle('呪術廻戦 — シーズン1 エピソード12')).toEqual({
      showName: '呪術廻戦',
      episodeNumber: 12,
    });
  });

  it('extracts Japanese episode numbers (第X話, X話) and Prime numbered subtitles (4. Title)', () => {
    expect(parseMediaTitle('葬送のフリーレン 第5話 - YouTube')).toEqual({
      showName: '葬送のフリーレン',
      episodeNumber: 5,
    });
    expect(parseMediaTitle('Frieren Ep. 3 - Netflix')).toEqual({
      showName: 'Frieren',
      episodeNumber: 3,
    });
    expect(parseMediaTitle('Jujutsu Kaisen — 4. Curse Womb Must Die')).toEqual({
      showName: 'Jujutsu Kaisen',
      episodeNumber: 4,
    });
    expect(parseMediaTitle('Chainsaw Man — E07 The Taste of a Kiss')).toEqual({
      showName: 'Chainsaw Man',
      episodeNumber: 7,
    });
  });

  it('matches episode numbers in Jimaku subtitle filenames', () => {
    expect(matchesEpisodeFilename('Jujutsu Kaisen S01E04.ass', 4)).toBe(true);
    expect(matchesEpisodeFilename('[SubsPlease] Show - 04.srt', 4)).toBe(true);
    expect(matchesEpisodeFilename('呪術廻戦 第4話.srt', 4)).toBe(true);
    expect(matchesEpisodeFilename('Jujutsu Kaisen S01E14.ass', 4)).toBe(false);
  });
});
