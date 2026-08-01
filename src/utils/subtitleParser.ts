export interface SubtitleSegment {
  index: number;
  startTime: number; // seconds
  endTime: number;   // seconds
  text: string;
  speaker?: string | number; // optional diarization label (JSON only)
}

// Converts "HH:MM:SS,mmm" or "HH:MM:SS.mmm" or "MM:SS.mmm" → seconds
function timeToSeconds(raw: string): number {
  const s = raw.replace(',', '.').trim();
  const parts = s.split(':');
  if (parts.length === 3) {
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  }
  if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(s);
}

export function parseSRT(content: string): SubtitleSegment[] {
  const segments: SubtitleSegment[] = [];
  const blocks = content.trim().split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;

    const indexLine = lines[0].trim();
    if (!/^\d+$/.test(indexLine)) continue;

    const timeLine = lines[1].trim();
    const timeMatch = timeLine.match(/(\S+)\s*-->\s*(\S+)/);
    if (!timeMatch) continue;

    const text = lines
      .slice(2)
      .join('\n')
      .trim()
      // Strip basic HTML tags that appear in some SRT files
      .replace(/<[^>]+>/g, '');

    segments.push({
      index: parseInt(indexLine),
      startTime: timeToSeconds(timeMatch[1]),
      endTime: timeToSeconds(timeMatch[2]),
      text,
    });
  }

  return segments;
}

export function parseVTT(content: string): SubtitleSegment[] {
  const segments: SubtitleSegment[] = [];
  const lines = content.split('\n');

  let index = 1;
  let i = 0;

  // Skip WEBVTT header and NOTE/STYLE blocks
  while (i < lines.length && !lines[i].includes('-->')) i++;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (line.includes('-->')) {
      const timeMatch = line.match(/(\S+)\s*-->\s*(\S+)/);
      if (!timeMatch) { i++; continue; }

      const textLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i].trim());
        i++;
      }

      const text = textLines.join('\n').replace(/<[^>]+>/g, '').trim();
      if (text) {
        segments.push({
          index: index++,
          startTime: timeToSeconds(timeMatch[1]),
          endTime: timeToSeconds(timeMatch[2]),
          text,
        });
      }
    } else {
      i++;
    }
  }

  return segments;
}

interface RawSegment {
  start?: unknown;
  end?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  text?: unknown;
  content?: unknown;
  speaker?: unknown;
  speaker_id?: unknown;
}

function toSegment(seg: RawSegment, i: number): SubtitleSegment {
  const speaker = seg.speaker ?? seg.speaker_id;
  return {
    index: i + 1,
    startTime: Number(seg.start ?? seg.startTime ?? 0),
    endTime: Number(seg.end ?? seg.endTime ?? 0),
    text: String(seg.text ?? seg.content ?? '').trim(),
    speaker: typeof speaker === 'string' || typeof speaker === 'number' ? speaker : undefined,
  };
}

export function parseJSON(content: string): SubtitleSegment[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return [];
  }

  // Whisper verbose_json / local-asr format: { segments: [...] }
  if (data && typeof data === 'object' && Array.isArray((data as { segments?: unknown }).segments)) {
    return ((data as { segments: RawSegment[] }).segments).map(toSegment);
  }

  // Plain array format: [{start, end, text}]
  if (Array.isArray(data)) {
    return (data as RawSegment[]).map(toSegment);
  }

  return [];
}

export function parseSubtitle(content: string, extension: string): SubtitleSegment[] {
  switch (extension.toLowerCase()) {
    case 'srt':  return parseSRT(content);
    case 'vtt':  return parseVTT(content);
    case 'json': return parseJSON(content);
    default:     return [];
  }
}

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}
