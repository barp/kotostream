import type { SpeakerSegment, SubtitleLine } from '../types';

export interface MergeSubtitleOptions {
  /** Minimum gap (ms) of silence/inactivity before clearing and starting a fresh subtitle */
  resetPauseMs: number;
  /** Maximum characters per row before rolling over */
  maxCharsPerRow?: number;
}

/**
 * Removes duplicated boundary overlap when an STT chunk repeats the end of the previous chunk.
 */
export function appendWithoutOverlap(prevText: string, nextText: string): string {
  const prev = prevText.trim();
  const next = nextText.trim();
  if (!prev) return next;
  if (!next) return prev;
  if (prev.endsWith(next)) return prev;

  const maxOverlap = Math.min(16, prev.length, next.length);
  for (let len = maxOverlap; len >= 2; len--) {
    if (prev.endsWith(next.slice(0, len))) {
      return prev + next.slice(len);
    }
  }

  return prev + next;
}

/**
 * Splits explicit multi-speaker markers (newlines, adjacent 「...」「...」, or dialogue dashes)
 * inside a single STT chunk. Does NOT split normal punctuation from a single speaker.
 */
export function splitSpeakerTurns(text: string): string[] {
  const cleaned = text.trim();
  if (!cleaned) return [];

  const rawLines = cleaned
    .split(/\r?\n+/)
    .map((l) => l.replace(/^[-—―・]\s*/, '').trim())
    .filter(Boolean);

  const result: string[] = [];
  for (const line of rawLines) {
    if (line.includes('」「')) {
      const parts = line
        .split('」「')
        .map((p, idx, arr) => {
          let s = p;
          if (idx > 0) s = '「' + s;
          if (idx < arr.length - 1) s = s + '」';
          return s.trim();
        })
        .filter(Boolean);
      result.push(...parts);
      continue;
    }

    if (/\s+[-—―]{1,2}\s+/.test(line)) {
      const parts = line
        .split(/\s+[-—―]{1,2}\s+/)
        .map((p) => p.trim())
        .filter(Boolean);
      result.push(...parts);
      continue;
    }

    result.push(line);
  }

  return result.slice(-2);
}

/**
 * Merges incoming diarized speaker segments into at most 2 stable rows:
 * Speaker 1 keeps their complete sentence on Top (slot 0),
 * Speaker 2 keeps their complete sentence on Bottom (slot 1).
 */
function mergeSpeakerSegments(
  existing: SpeakerSegment[],
  incoming: SpeakerSegment[],
  maxCharsPerRow: number
): SpeakerSegment[] {
  const slots: SpeakerSegment[] = existing.map((s) => ({ ...s }));

  for (const seg of incoming) {
    const text = seg.text.trim();
    if (!text) continue;

    const matchIdx = slots.findIndex((s) => s.speaker === seg.speaker);
    if (matchIdx >= 0) {
      const combined = appendWithoutOverlap(slots[matchIdx].text, text);
      slots[matchIdx] = {
        speaker: seg.speaker,
        text: combined.length > maxCharsPerRow ? text : combined,
      };
    } else if (slots.length < 2) {
      slots.push({ speaker: seg.speaker, text });
    } else {
      // 3rd speaker enters: drop oldest slot (top) and put new speaker on bottom
      slots.shift();
      slots.push({ speaker: seg.speaker, text });
    }
  }

  return slots.slice(-2);
}

/**
 * Merges a new live-STT subtitle with the currently displayed subtitle:
 * - When real speaker diarization (`segments`) is present (e.g. Deepgram `diarize=true`),
 *   each speaker's sentence accumulates cleanly on its own row (Speaker 1 Top, Speaker 2 Bottom).
 * - When no diarization is available (e.g. Whisper), text accumulates on a single clean row
 *   (unless explicit 2-speaker markers appear) until a long enough pause (`resetPauseMs`) resets it.
 */
export function mergeLiveSubtitle(
  current: SubtitleLine | null,
  incoming: SubtitleLine,
  options: MergeSubtitleOptions
): { subtitle: SubtitleLine; merged: boolean } {
  const maxCharsPerRow = options.maxCharsPerRow ?? 95;

  const hasIncomingDiarization = Boolean(incoming.segments && incoming.segments.length > 0);
  const incomingTurns = hasIncomingDiarization ? [] : splitSpeakerTurns(incoming.text);
  const normalizedIncomingText = hasIncomingDiarization
    ? incoming.segments!.map((s) => s.text.trim()).filter(Boolean).slice(-2).join('\n')
    : incomingTurns.join('\n') || incoming.text.trim();

  if (!current || current.source !== 'live-stt') {
    return {
      merged: false,
      subtitle: {
        ...incoming,
        text: normalizedIncomingText,
        segments: hasIncomingDiarization ? incoming.segments!.slice(-2) : undefined,
      },
    };
  }

  const silenceGapMs = incoming.silenceGapMs;
  const wallGapMs = Math.max(0, incoming.timestampMs - current.timestampMs);
  const effectivePauseMs = silenceGapMs !== undefined ? silenceGapMs : wallGapMs;

  // Long pause -> clear previous dialogue and start fresh
  if (effectivePauseMs >= options.resetPauseMs) {
    return {
      merged: false,
      subtitle: {
        ...incoming,
        text: normalizedIncomingText,
        segments: hasIncomingDiarization ? incoming.segments!.slice(-2) : undefined,
      },
    };
  }

  // Case 1: Real speaker diarization (Deepgram) -> keep Speaker 1 on Top, Speaker 2 on Bottom
  if (hasIncomingDiarization) {
    const baseSegments: SpeakerSegment[] =
      current.segments && current.segments.length > 0
        ? current.segments
        : [{ speaker: incoming.segments![0].speaker, text: current.text.replace(/\n/g, ' ') }];

    const mergedSegments = mergeSpeakerSegments(baseSegments, incoming.segments!, maxCharsPerRow);
    return {
      merged: true,
      subtitle: {
        ...current,
        text: mergedSegments.map((s) => s.text).join('\n'),
        segments: mergedSegments,
        timestampMs: incoming.timestampMs,
        latencyMs: incoming.latencyMs,
      },
    };
  }

  // Case 2: Explicit 2-speaker markers inside a single chunk (e.g. 「...」「...」)
  if (incomingTurns.length >= 2) {
    return {
      merged: true,
      subtitle: {
        ...current,
        text: incomingTurns.slice(-2).join('\n'),
        segments: undefined,
        timestampMs: incoming.timestampMs,
        latencyMs: incoming.latencyMs,
      },
    };
  }

  // Case 3: Single-stream STT (Whisper / OpenRouter / Groq) -> keep one clean sentence without false splits
  const nextLine = incomingTurns[0] ?? incoming.text.trim();
  const combined = appendWithoutOverlap(current.text.replace(/\n/g, ''), nextLine);

  if (combined.length > maxCharsPerRow && current.text.length >= 25) {
    return {
      merged: false,
      subtitle: { ...incoming, text: nextLine, segments: undefined },
    };
  }

  return {
    merged: true,
    subtitle: {
      ...current,
      text: combined,
      segments: undefined,
      timestampMs: incoming.timestampMs,
      latencyMs: incoming.latencyMs,
    },
  };
}
