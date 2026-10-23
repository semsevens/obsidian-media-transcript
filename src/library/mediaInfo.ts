/**
 * What the media library shows about a file besides its name: when it was
 * recorded and how long it is. Pure functions, no Obsidian here.
 */

/**
 * When a recording was made, read from its name: phones and recorders name
 * files after the moment ("Recording 20260902210306.m4a", "录制于 2026-08-27
 * 11.05.55.m4a", "Pasted Image 20261009164946_322.png"). Null if it doesn't say.
 */
export function recordedAt(name: string): Date | null {
  const compact = name.match(/(?:^|\D)(20\d{2})(\d{2})(\d{2})[ _-]?(\d{2})(\d{2})(\d{2})(?:\D|$)/);
  const spaced = name.match(/(20\d{2})-(\d{2})-(\d{2})[ T_](\d{2})[.:](\d{2})[.:](\d{2})/);
  const dateOnly = name.match(/(?:^|\D)(20\d{2})-(\d{1,2})-(\d{1,2})(?:\D|$)/);
  // Named by the day it was, as far as it is known ("2025-07 王斌 - …", "2025 王斌 - …"): its first day.
  const partial = name.match(/^((?:19|20)\d{2})(?:-(\d{2}))? (?!年)/);
  const m = compact ?? spaced;
  const parts = m ? m.slice(1, 7).map(Number)
    : dateOnly ? [...dateOnly.slice(1, 4).map(Number), 0, 0, 0]
    : partial ? [Number(partial[1]), Number(partial[2] ?? 1), 1, 0, 0, 0]
    : null;
  if (!parts) return null;
  const [y, mo, d, h, mi, s] = parts;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi, s);
  return date.getMonth() === mo - 1 ? date : null;
}

/**
 * A name a device gave, saying no more than when ("Recording 20260902210306",
 * "录制于 2026-08-27 11.05.55", "录音 001"), as against one someone chose.
 */
export function isGenericName(name: string): boolean {
  const base = name.replace(/\.[^.]+$/, '');
  const rest = base
    .replace(/recording|record|audio|voice|memo|video|pasted image|screen recording|录制于|录音|录屏|语音|新录音/gi, '')
    .replace(/[\d\s._:\-年月日时分秒]+/g, '');
  // A connecting word may be left ("Recording at …").
  return rest.length === 0 || /^(at|on|of|the|from)$/i.test(rest);
}

/** 4:05, 1:12:43. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The media's length a transcript records near its top ("duration": 4363.16), or null. */
export function durationIn(transcriptText: string): number | null {
  const m = transcriptText.slice(0, 4096).match(/"duration"\s*:\s*([\d.]+)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Whether `fileName` is a transcript of the media `mediaName` by name alone:
 * "talk.vibevoice-4bit.json" for "talk.m4a". For transcripts whose recorded
 * source is out of date (the media renamed by hand before Media One kept
 * them in step).
 */
export function isTranscriptNamedFor(fileName: string, mediaName: string): boolean {
  const base = mediaName.slice(0, mediaName.lastIndexOf('.'));
  if (!base || !fileName.startsWith(base + '.') || fileName.endsWith('.anno.json')) return false;
  return /^\.[^./]+\.json$/.test(fileName.slice(base.length));
}

/**
 * The opening words of a transcript, to tell a recording by what was said:
 * the first segments that are speech (not "[Silence]", "[Music]"), up to
 * about `max` characters. Read from the top of the file only.
 */
export function openingWords(transcriptText: string, max = 40): string {
  let out = '';
  for (const m of transcriptText.slice(0, 32768).matchAll(/"text"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    let text: string;
    try {
      text = String(JSON.parse(m[1])).trim();
    } catch {
      continue;
    }
    if (!text || /^[[(（【].*[\])）】]$/.test(text)) continue;
    text = text.replace(/\s+/g, ' ');
    out += (out && !/[。！？.!?，,]$/.test(out) ? ' ' : '') + text;
    if (out.length >= max) break;
  }
  return out.length > max ? out.slice(0, max).trimEnd() + '…' : out;
}

/** A note named after a day (a daily note): its name says nothing a date doesn't. */
export function isDatedName(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(\s|$)/.test(name) && name.length <= 16;
}

/**
 * A chosen name without the date and time it carries, which the row shows
 * on its own line already: "首秀滴水不漏！2016-03-12 23 12" → "首秀滴水不漏！".
 * The name as it was if nothing would be left.
 */
export function withoutDate(base: string): string {
  const out = base
    .replace(/^(?:19|20)\d{2}(?:-\d{2})? (?!年)/, ' ')
    .replace(/(?<!\d)20\d{2}-\d{1,2}-\d{1,2}(?:[ T_]*(?:[AP]M)?\s*\d{1,2}(?:[ .:]\d{2}){1,2})?/gi, ' ')
    .replace(/(?<!\d)20\d{12}(?=\D|$)/g, ' ')
    .replace(/[\s_\-·]+$/g, '')
    .replace(/^[\s_\-·]+/g, '')
    .trim();
  return out || base;
}
