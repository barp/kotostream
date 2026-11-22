import type { JimakuEntry, JimakuFile } from '../types';
import { matchesEpisodeFilename } from '../core/title-parser';

const JIMAKU_BASE = 'https://jimaku.cc/api';

export async function searchJimakuEntries(query: string, apiKey: string): Promise<JimakuEntry[]> {
  if (!apiKey.trim()) {
    throw new Error('Jimaku API key is not set. Generate a free key at jimaku.cc/account and add it in Settings.');
  }

  const url = `${JIMAKU_BASE}/entries/search?query=${encodeURIComponent(query.trim())}`;
  const res = await fetch(url, {
    headers: {
      Authorization: apiKey.trim(),
    },
  });

  if (!res.ok) {
    if (res.status === 401) throw new Error('Invalid Jimaku API key (401). Check your key from jimaku.cc/account.');
    if (res.status === 429) throw new Error('Jimaku rate limit reached (429). Please wait a few seconds.');
    throw new Error(`Jimaku search failed (${res.status})`);
  }

  return (await res.json()) as JimakuEntry[];
}

export async function listJimakuFiles(
  entryId: number,
  apiKey: string,
  episode?: number
): Promise<JimakuFile[]> {
  if (!apiKey.trim()) {
    throw new Error('Jimaku API key is not set.');
  }

  const hasEp = episode !== undefined && !Number.isNaN(episode) && episode > 0;
  const epParam = hasEp ? `?episode=${episode}` : '';
  const url = `${JIMAKU_BASE}/entries/${entryId}/files${epParam}`;
  const res = await fetch(url, {
    headers: {
      Authorization: apiKey.trim(),
    },
  });

  if (!res.ok) {
    throw new Error(`Jimaku files error (${res.status})`);
  }

  let files = (await res.json()) as JimakuFile[];

  // If Jimaku's ?episode= filter returned no direct subtitle files (untagged episode metadata),
  // fetch all files for the show and bubble filename-matched episode files to the top!
  const hasDirectMatch = files.some((f) => /\.(srt|ass|vtt)$/i.test(f.name));
  if (hasEp && !hasDirectMatch) {
    const allRes = await fetch(`${JIMAKU_BASE}/entries/${entryId}/files`, {
      headers: { Authorization: apiKey.trim() },
    });
    if (allRes.ok) {
      files = (await allRes.json()) as JimakuFile[];
    }
  }

  return files.sort((a, b) => {
    const aOk = /\.(srt|ass|vtt)$/i.test(a.name) ? 0 : 1;
    const bOk = /\.(srt|ass|vtt)$/i.test(b.name) ? 0 : 1;
    if (aOk !== bOk) return aOk - bOk;

    if (hasEp) {
      const aMatch = matchesEpisodeFilename(a.name, episode!) ? 0 : 1;
      const bMatch = matchesEpisodeFilename(b.name, episode!) ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
    }

    return a.name.localeCompare(b.name);
  });
}

export async function downloadJimakuSubtitle(fileUrl: string): Promise<string> {
  if (/\.(zip|7z|rar)$/i.test(fileUrl)) {
    throw new Error('Archive files (.zip/.7z) cannot be opened directly — pick an individual .srt, .ass, or .vtt file.');
  }
  const res = await fetch(fileUrl);
  if (!res.ok) {
    throw new Error(`Failed to download subtitle file (${res.status})`);
  }
  return res.text();
}
