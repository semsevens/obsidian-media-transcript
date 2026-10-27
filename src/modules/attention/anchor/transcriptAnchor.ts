// Re-finding a marked passage in a transcript.
//
// Easier than markdown in one way — subtitle files are generated, not edited,
// so a mark usually sits exactly where it was left — and harder in another: the
// same media can have several tracks, produced by different ASR engines, which
// disagree about both segmentation and wording. Re-transcribing must not throw
// away everything you marked.
//
// The timeline is the one thing every track agrees on, which is why the anchor
// stores `start` and why that is what a cross-track search keys off.

import { TranscriptAnchor } from '../model';

/** A transcript line, as read from whatever track is currently loaded. */
export interface Seg {
  seg: number;
  start: number;
  text: string;
}

export interface TranscriptHit {
  seg: number;
  charStart: number;
  charEnd: number;
  /**
   * How it was found. Anything but 'exact' means the anchor should be
   * rewritten; 'fuzzy' means the marked words themselves were changed (a
   * corrected transcript) and the mark now covers what replaced them.
   */
  how: 'exact' | 'drifted' | 'retimed' | 'fuzzy' | 'unique';
}

/** How far from the remembered timestamp to look when the track has changed. */
export const TIME_TOLERANCE_S = 3;

export function describeTranscript(
  seg: Seg,
  charStart: number,
  charEnd: number,
  track: string,
  contextLen = 32,
): TranscriptAnchor {
  return {
    kind: 'transcript',
    track,
    seg: seg.seg,
    start: seg.start,
    charStart,
    charEnd,
    quote: seg.text.slice(charStart, charEnd),
    prefix: seg.text.slice(Math.max(0, charStart - contextLen), charStart),
    suffix: seg.text.slice(charEnd, charEnd + contextLen),
  };
}

function commonSuffixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Locate `anchor` among `segs`, which belong to `currentTrack`.
 *
 * On the track it was made against, the segment index is a direct hit and only
 * needs verifying. On a different track the index means nothing, so candidates
 * are drawn from a window around the remembered timestamp and scored on the
 * surrounding text.
 */
export function resolveTranscript(
  segs: readonly Seg[],
  anchor: TranscriptAnchor,
  currentTrack: string | null,
): TranscriptHit | null {
  if (!anchor.quote) return null;

  const sameTrack = currentTrack != null && currentTrack === anchor.track;

  if (sameTrack) {
    const seg = segs.find(s => s.seg === anchor.seg);
    if (seg) {
      if (seg.text.slice(anchor.charStart, anchor.charEnd) === anchor.quote) {
        return { seg: seg.seg, charStart: anchor.charStart, charEnd: anchor.charEnd, how: 'exact' };
      }
      // The words at the old place were corrected. Looked for there first: a
      // long line can say the same thing twice, and the untouched repeat
      // further on is not the passage that was marked.
      const reworded = rewordedInPlace(seg, anchor);
      if (reworded) return reworded;
      // The track was regenerated in place and this line shifted a little.
      const at = closestOccurrence(seg.text, anchor);
      if (at >= 0) {
        return { seg: seg.seg, charStart: at, charEnd: at + anchor.quote.length, how: 'drifted' };
      }
    }
  }

  // Different track, or the remembered segment no longer holds the quote: look
  // around the timestamp, which is the only thing tracks agree on.
  const near = segs.filter(s => Math.abs(s.start - anchor.start) <= TIME_TOLERANCE_S);
  const scored: { seg: Seg; at: number; score: number }[] = [];
  for (const s of near) {
    const at = s.text.indexOf(anchor.quote);
    if (at < 0) continue;
    scored.push({
      seg: s,
      at,
      score:
        commonSuffixLen(s.text.slice(0, at), anchor.prefix) +
        commonPrefixLen(s.text.slice(at + anchor.quote.length), anchor.suffix),
    });
  }
  if (scored.length > 0) {
    scored.sort((a, b) =>
      b.score - a.score ||
      Math.abs(a.seg.start - anchor.start) - Math.abs(b.seg.start - anchor.start));
    const best = scored[0];
    return {
      seg: best.seg.seg,
      charStart: best.at,
      charEnd: best.at + anchor.quote.length,
      how: 'retimed',
    };
  }

  // The words themselves were changed — a transcript corrected by hand, or
  // regenerated — so the quote is nowhere verbatim. Near the timestamp, the
  // run of text closest to it, or failing that whatever now sits between the
  // words that surrounded it, is the same passage reworded.
  const fuzzy = findReworded(segs, anchor, sameTrack);
  if (fuzzy) return fuzzy;

  // Nothing near the timestamp. Accept a match elsewhere only if it's the only
  // one in the whole track — otherwise we'd be guessing.
  const everywhere = segs.filter(s => s.text.includes(anchor.quote));
  if (everywhere.length === 1) {
    const s = everywhere[0];
    const at = s.text.indexOf(anchor.quote);
    return { seg: s.seg, charStart: at, charEnd: at + anchor.quote.length, how: 'unique' };
  }

  return null;
}

/**
 * The run around the mark's old offsets that its quote most resembles, when
 * close enough to be the same words corrected.
 */
function rewordedInPlace(seg: Seg, anchor: TranscriptAnchor): TranscriptHit | null {
  const L = anchor.quote.length;
  if (L < FUZZY_MIN_LEN) return null;
  const from = Math.max(0, anchor.charStart - L);
  const run = nearestRun(seg.text.slice(from, anchor.charEnd + L), anchor.quote);
  if (!run || run.edits > Math.floor(L / 3)) {
    // Reworded past resemblance: whatever stands between its old neighbours,
    // there and nowhere else.
    const there = betweenContext(seg.text, anchor)
      .filter(e => e.from >= from && e.from <= anchor.charStart + L);
    if (there.length !== 1) return null;
    return { seg: seg.seg, charStart: there[0].from, charEnd: there[0].to, how: 'fuzzy' };
  }
  if (run.edits === 0) return { seg: seg.seg, charStart: from + run.from, charEnd: from + run.to, how: 'drifted' };
  const edges = snapToContext(seg.text, anchor, { from: from + run.from, to: from + run.to });
  return { seg: seg.seg, charStart: edges.from, charEnd: edges.to, how: 'fuzzy' };
}

/**
 * The fewest edits favour the shortest run — 很好 corrected to 真不错 is
 * nearest to 今天天气 alone. Where the words that surrounded the mark still
 * stand on either side of the run, they say where it really begins and ends.
 */
function snapToContext(text: string, anchor: TranscriptAnchor, run: { from: number; to: number }): { from: number; to: number } {
  const overlapping = betweenContext(text, anchor).filter(e => e.from < run.to && run.from < e.to);
  return overlapping.length === 1 ? overlapping[0] : run;
}

/** Of the quote's occurrences in a line, the one whose context fits best, then the nearest the old place. */
function closestOccurrence(text: string, anchor: TranscriptAnchor): number {
  let best = -1;
  let bestScore = -1;
  for (const at of positions(text, anchor.quote)) {
    const score =
      commonSuffixLen(text.slice(0, at), anchor.prefix) +
      commonPrefixLen(text.slice(at + anchor.quote.length), anchor.suffix);
    if (score > bestScore ||
        (score === bestScore && Math.abs(at - anchor.charStart) < Math.abs(best - anchor.charStart))) {
      best = at;
      bestScore = score;
    }
  }
  return best;
}

/** A quote shorter than this is too generic to find by resemblance. */
const FUZZY_MIN_LEN = 4;
/** How much of the context to look for on each side of a reworded passage. */
const CONTEXT_PROBE = 8;
/** Fewer characters of context than this match too much to locate anything. */
const CONTEXT_MIN = 3;

function findReworded(
  segs: readonly Seg[],
  anchor: TranscriptAnchor,
  sameTrack: boolean,
): TranscriptHit | null {
  if (anchor.quote.length < FUZZY_MIN_LEN) return null;

  // Its own line first (on its own track), then the lines around its time.
  const own = sameTrack ? segs.find(s => s.seg === anchor.seg) : undefined;
  const near = segs
    .filter(s => s !== own && Math.abs(s.start - anchor.start) <= TIME_TOLERANCE_S)
    .sort((a, b) => Math.abs(a.start - anchor.start) - Math.abs(b.start - anchor.start));
  const candidates = own ? [own, ...near] : near;

  const allowed = Math.floor(anchor.quote.length / 3);
  let best: { seg: Seg; from: number; to: number; edits: number } | null = null;
  for (const s of candidates) {
    const run = nearestRun(s.text, anchor.quote);
    if (run && run.edits <= allowed && (!best || run.edits < best.edits)) best = { seg: s, ...run };
  }
  if (best) {
    const edges = snapToContext(best.seg.text, anchor, best);
    return { seg: best.seg.seg, charStart: edges.from, charEnd: edges.to, how: 'fuzzy' };
  }

  for (const s of candidates) {
    const fits = betweenContext(s.text, anchor);
    if (fits.length === 1) return { seg: s.seg, charStart: fits[0].from, charEnd: fits[0].to, how: 'fuzzy' };
  }
  return null;
}

/**
 * The run of `text` that `quote` takes fewest single-character edits to turn
 * into, and how many: an approximate substring search (Sellers' algorithm).
 */
export function nearestRun(text: string, quote: string): { from: number; to: number; edits: number } | null {
  const m = quote.length;
  if (m === 0 || text.length === 0) return null;
  // cost[i]: edits matching quote[0, i) to a run of text ending here;
  // from[i]: where that run starts.
  let cost = Array.from({ length: m + 1 }, (_, i) => i);
  let from = new Array<number>(m + 1).fill(0);
  let best: { from: number; to: number; edits: number } | null = null;
  for (let j = 1; j <= text.length; j++) {
    const nextCost = [0];
    const nextFrom = [j];
    for (let i = 1; i <= m; i++) {
      const sub = cost[i - 1] + (quote[i - 1] === text[j - 1] ? 0 : 1);
      const skipText = cost[i] + 1;
      const skipQuote = nextCost[i - 1] + 1;
      if (sub <= skipText && sub <= skipQuote) {
        nextCost.push(sub); nextFrom.push(from[i - 1]);
      } else if (skipText <= skipQuote) {
        nextCost.push(skipText); nextFrom.push(from[i]);
      } else {
        nextCost.push(skipQuote); nextFrom.push(nextFrom[i - 1]);
      }
    }
    cost = nextCost;
    from = nextFrom;
    if (!best || cost[m] < best.edits) best = { from: from[m], to: j, edits: cost[m] };
  }
  return best && best.to > best.from ? best : null;
}

/**
 * Whatever now sits where the words around the mark leave room for it: the
 * end of its prefix to the start of its suffix. A side with no context marks
 * the edge of the line; a side whose context is gone leaves it unplaced.
 * Every such run about the size of what it replaces; a line that repeats
 * itself has more than one.
 */
function betweenContext(text: string, anchor: TranscriptAnchor): { from: number; to: number }[] {
  const starts = anchor.prefix === ''
    ? [0]
    : longestFound(text, anchor.prefix, 'tail').map(([at, len]) => at + len);
  const ends = anchor.suffix === ''
    ? [text.length]
    : longestFound(text, anchor.suffix, 'head').map(([at]) => at);
  const L = anchor.quote.length;
  const fits: { from: number; to: number }[] = [];
  for (const a of starts) {
    for (const b of ends) {
      if (b - a >= Math.ceil(L / 2) && b - a <= L * 2) fits.push({ from: a, to: b });
    }
  }
  return fits;
}

/**
 * Where the longest still-present end of `context` (its tail for a prefix,
 * its head for a suffix) occurs in `text`, as [position, length] pairs. The
 * part furthest from the mark is the likeliest to have been edited too, so
 * the probe is shortened from that side — but never below a few characters,
 * which would match anywhere.
 */
function longestFound(text: string, context: string, side: 'head' | 'tail'): [number, number][] {
  for (let len = Math.min(CONTEXT_PROBE, context.length); len >= CONTEXT_MIN; len--) {
    const probe = side === 'tail' ? context.slice(-len) : context.slice(0, len);
    const found = positions(text, probe);
    if (found.length > 0) return found.map(at => [at, len]);
  }
  return [];
}

function positions(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) out.push(at);
  return out;
}
