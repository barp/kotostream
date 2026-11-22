export interface ParsedMediaTitle {
  showName: string;
  episodeNumber?: number;
}

/**
 * Extracts a clean show name and optional episode number from streaming player titles
 * (Amazon Prime Video, YouTube, Netflix) for automatic Jimaku.cc subtitle search.
 */
export function parseMediaTitle(rawTitle: string): ParsedMediaTitle {
  let text = rawTitle
    .replace(/\s*[-|]\s*(?:Amazon\s*)?Prime Video.*$/i, '')
    .replace(/^\s*Watch\s+/i, '')
    .replace(/\s*-\s*YouTube\s*$/i, '')
    .replace(/\s*-\s*Netflix\s*$/i, '')
    .trim();

  let episodeNumber: number | undefined;

  // Match common episode patterns on Prime Video, YouTube, Netflix (EN & JP)
  const epPatterns = [
    /\bS\d+\s*[,·•\s-]*E(?:p\.?)?\s*(\d{1,4})\b/i,
    /\bSeason\s*\d+\s*[,·•\s-]+E(?:p\.?|pisode)?\s*(\d{1,4})\b/i,
    /\bEpisode\s*(\d{1,4})\b/i,
    /\bEp\.?\s*(\d{1,4})\b/i,
    /\bE(\d{1,4})\b/i,
    /エピソード\s*(\d{1,4})/,
    /第\s*(\d{1,4})\s*話/,
    /(\d{1,4})\s*話/,
    /#(\d{1,4})\b/,
    // Amazon Prime Video often formats subtitle text as "Show — 4. Episode Title"
    /[—–-]\s*(\d{1,4})\.\s+/,
  ];

  for (const pat of epPatterns) {
    const m = text.match(pat);
    if (m) {
      episodeNumber = Number(m[1]);
      break;
    }
  }

  // Strip everything from the dash/em-dash before season/episode info
  text = text
    .replace(
      /\s*[—–-]\s*(?:S\d+|Season\s*\d+|Ep\.?\s*\d+|Episode\s*\d+|E\d+\b|\d+\.\s+|シーズン\s*\d+|エピソード\s*\d+|第\s*\d+\s*話|\d+\s*話).*$/i,
      ''
    )
    .replace(
      /\s*\(?(?:Season\s*\d+|シーズン\s*\d+|S\d+\s*E\d+|Episode\s*\d+|Ep\.?\s*\d+|第\s*\d+\s*話|\d+\s*話)\)?.*$/i,
      ''
    )
    .replace(/\s*[:：]\s*(?:Season\s*\d+|シーズン\s*\d+).*$/i, '')
    .trim();

  return {
    showName: text || rawTitle.trim(),
    episodeNumber,
  };
}

/**
 * Checks whether a subtitle filename (e.g. "Show S01E04.ass", "[Group] Show - 04.srt", "第4話.srt")
 * matches a specific episode number.
 */
export function matchesEpisodeFilename(fileName: string, episodeNumber: number): boolean {
  const n = String(episodeNumber);
  const padded2 = n.padStart(2, '0');
  const padded3 = n.padStart(3, '0');

  const patterns = [
    new RegExp(`(?:^|[^0-9])(?:S\\d+\\s*)?E(?:p\\.?)?0*${episodeNumber}(?:[^0-9]|$)`, 'i'),
    new RegExp(`第\\s*0*${episodeNumber}\\s*話`),
    new RegExp(`(?:^|[^0-9])0*${episodeNumber}\\s*話`),
    new RegExp(`(?:[-_\\s\\[(])(?:${padded3}|${padded2}|${n})(?:[-_\\s\\]).v])`, 'i'),
  ];

  return patterns.some((p) => p.test(fileName));
}
