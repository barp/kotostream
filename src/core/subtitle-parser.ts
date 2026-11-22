import type { SubtitleLine } from '../types';

/**
 * Parses .srt, .vtt, or .ass (Advanced SubStation Alpha) subtitle files
 * into sorted SubtitleLine[] with start/end times in seconds.
 */
export function parseSubtitleFile(content: string): SubtitleLine[] {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (normalized.includes('[Events]') && /^Dialogue:/m.test(normalized)) {
    return parseAssFile(normalized);
  }

  return parseSrtOrVtt(normalized);
}

function parseSrtOrVtt(normalized: string): SubtitleLine[] {
  const blocks = normalized.split(/\n{2,}/);
  const lines: SubtitleLine[] = [];

  for (const block of blocks) {
    const rawLines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (rawLines.length === 0) continue;
    if (rawLines[0].startsWith('WEBVTT') || rawLines[0].startsWith('NOTE')) continue;

    const tsIdx = rawLines.findIndex((l) => l.includes('-->'));
    if (tsIdx === -1) continue;

    const tsLine = rawLines[tsIdx];
    const [startRaw, endRaw] = tsLine.split('-->').map((s) => s.trim().split(/\s+/)[0]);
    const startSec = parseTimestamp(startRaw);
    const endSec = parseTimestamp(endRaw);
    if (startSec === null || endSec === null) continue;

    const text = rawLines
      .slice(tsIdx + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]+\}/g, '')
      .trim();

    if (!text) continue;

    lines.push({
      id: `file-${lines.length}-${Math.round(startSec * 1000)}`,
      text,
      timestampMs: Math.round(startSec * 1000),
      videoTimeSec: startSec,
      endTimeSec: endSec,
      source: 'file',
    });
  }

  return lines.sort((a, b) => (a.videoTimeSec ?? 0) - (b.videoTimeSec ?? 0));
}

function parseAssFile(normalized: string): SubtitleLine[] {
  const rawLines = normalized.split('\n');
  const lines: SubtitleLine[] = [];

  for (const raw of rawLines) {
    if (!raw.startsWith('Dialogue:')) continue;
    // Format: Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
    const body = raw.slice('Dialogue:'.length).trim();
    const parts = body.split(',');
    if (parts.length < 10) continue;

    const startSec = parseTimestamp(parts[1].trim());
    const endSec = parseTimestamp(parts[2].trim());
    if (startSec === null || endSec === null) continue;

    const rawText = parts.slice(9).join(',');
    const text = rawText
      .replace(/\{[^}]+\}/g, '') // strip ASS override tags
      .replace(/\\N|\\n/g, '\n')
      .replace(/\\h/g, ' ')
      .trim();

    if (!text) continue;

    lines.push({
      id: `ass-${lines.length}-${Math.round(startSec * 1000)}`,
      text,
      timestampMs: Math.round(startSec * 1000),
      videoTimeSec: startSec,
      endTimeSec: endSec,
      source: 'file',
    });
  }

  return lines.sort((a, b) => (a.videoTimeSec ?? 0) - (b.videoTimeSec ?? 0));
}

function parseTimestamp(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(',', '.');
  const parts = cleaned.split(':');
  if (parts.length === 3) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const s = Number(parts[2]);
    if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return null;
    return h * 3600 + m * 60 + s;
  }
  if (parts.length === 2) {
    const m = Number(parts[0]);
    const s = Number(parts[1]);
    if (Number.isNaN(m) || Number.isNaN(s)) return null;
    return m * 60 + s;
  }
  return null;
}

/**
 * Finds the first active subtitle at a given video time in seconds.
 */
export function findSubtitleAtTime(
  subtitles: SubtitleLine[],
  timeSec: number,
  offsetSec = 0
): SubtitleLine | null {
  const active = findActiveSubtitlesAtTime(subtitles, timeSec, offsetSec);
  return active[0] ?? null;
}

/**
 * Finds all active subtitles at a given video time (applying sync offsetSec).
 * When 2 characters speak simultaneously in .srt/.ass, returns up to 2 overlapping cues
 * so they render cleanly as Top + Bottom rows!
 */
export function findActiveSubtitlesAtTime(
  subtitles: SubtitleLine[],
  timeSec: number,
  offsetSec = 0
): SubtitleLine[] {
  if (subtitles.length === 0) return [];
  const adjustedTime = timeSec - offsetSec;
  const active: SubtitleLine[] = [];

  for (const sub of subtitles) {
    const start = sub.videoTimeSec ?? 0;
    const end = sub.endTimeSec ?? start + 4;
    if (start > adjustedTime) break; // sorted by start time
    if (adjustedTime >= start && adjustedTime <= end) {
      active.push(sub);
    }
  }

  return active.slice(-2);
}

/**
 * Formats SubtitleLine[] into a standard .srt file string.
 */
export function formatSubtitlesToSrt(cues: SubtitleLine[]): string {
  return cues
    .map((cue, idx) => {
      const start = cue.videoTimeSec ?? cue.timestampMs / 1000;
      const end = cue.endTimeSec ?? start + 3.5;
      return `${idx + 1}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${cue.text.trim()}`;
    })
    .join('\n\n');
}

function formatSrtTimestamp(sec: number): string {
  const safe = Math.max(0, sec);
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return (
    `${String(hours).padStart(2, '0')}:` +
    `${String(mins).padStart(2, '0')}:` +
    `${String(secs).padStart(2, '0')},` +
    `${String(Math.min(999, ms)).padStart(3, '0')}`
  );
}
