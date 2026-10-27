/**
 * Quoting a passage of a transcript into a note:
 *
 *   > [!quote] [[talk.vibevoice-4bit.json#t=83,97|talk · 1:23–1:37]]
 *   > what was said, word for word
 *
 * Plain Markdown, so it reads as a quotation anywhere — without this plugin,
 * in another app, sent to someone. The link carries the passage's time; the
 * plugin draws a way to play just that stretch, and notices when the
 * transcript has since been corrected.
 */
import { nearestRun } from '../modules/attention/anchor/transcriptAnchor';
import { formatTime } from './subtitleParser';

/** The callout a quote is written as. */
export const QUOTE_CALLOUT = 'quote';

/** The block for `text`, its title the link back to where it was said. */
export function quoteBlock(link: string, text: string): string {
  const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(l => l !== '');
  return [`> [!${QUOTE_CALLOUT}] ${link}`, ...lines.map(l => `> ${l}`)].join('\n');
}

/** The link's label: what it was, and when in it. */
export function quoteLabel(title: string, start: number, end: number): string {
  return `${title} · ${formatTime(start)}–${formatTime(end)}`;
}

/**
 * Lines of a transcript as one passage. Chinese and Japanese run on with no
 * space between sentences; anything else gets one.
 */
export function joinParts(parts: readonly string[]): string {
  let out = '';
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (out && !(isCjk(out[out.length - 1]) || isCjk(part[0]))) out += ' ';
    out += part;
  }
  return out;
}

function isCjk(ch: string): boolean {
  return /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(ch);
}

/** What a transcript says between `start` and `end`. */
export function textBetween(
  segments: readonly { startTime: number; endTime: number; text: string }[],
  start: number,
  end: number,
): string {
  // Quotes are written in whole seconds, rounded outward, so the lines on
  // either side can overlap the range by up to a second without being in it:
  // a line is in it when its middle is.
  return joinParts(segments
    .filter(s => (s.startTime + s.endTime) / 2 >= start && (s.startTime + s.endTime) / 2 <= end)
    .map(s => s.text));
}

/** Words only: the spacing and punctuation a correction or a re-quote may change. */
export function comparable(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * Has the transcript been changed under this quote? Not for a quote of part
 * of what was said, nor for spacing and punctuation. Any word changed counts:
 * a corrected transcript is what this is for, and a quote changed on purpose
 * is kept as it is with one answer.
 */
export function quoteOutdated(quoted: string, source: string): boolean {
  const q = comparable(quoted);
  const s = comparable(source);
  return q !== '' && s !== '' && !s.includes(q);
}

/**
 * What the quote should now say: the stretch of the corrected passage it most
 * resembles, or the whole passage when nothing is close enough to tell.
 */
export function updatedQuote(quoted: string, source: string): string {
  const q = quoted.trim();
  const run = nearestRun(source, q);
  if (run && run.edits <= Math.floor(q.length / 2)) {
    return source.slice(run.from, run.to).trim();
  }
  return source.trim();
}
