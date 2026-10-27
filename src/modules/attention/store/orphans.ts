// Telling apart marks that still point at something from marks that don't.
//
// A mark whose passage has been edited away can't be drawn — guessing a
// location would be worse than admitting it's lost. But dropping it silently is
// worse still: the text you cared about, and the times it caught you, are
// exactly what you'd want back. So they're kept, and shown as lost.

import { Annotation } from '../model';
import { resolveMarkdown } from '../anchor/resolveAnchor';
import { Seg, resolveTranscript } from '../anchor/transcriptAnchor';

export interface Classified {
  live: Annotation[];
  /** Still stored, still meaningful, but no longer findable in the file. */
  lost: Annotation[];
}

/**
 * Split a file's annotations by whether they still resolve.
 *
 * More than one version of a file can be in play — the editor's buffer and what
 * is on disk — and they disagree constantly: the buffer leads while you type,
 * and lags while a view is switching files, briefly still holding the previous
 * note. A mark counts as lost only when *no* version has it. Getting this wrong
 * announces that everything in the file is gone, which is alarming and almost
 * always untrue.
 *
 * Only markdown anchors are judged here; transcript anchors are judged against
 * their track's lines by classifyTranscript.
 */
export function classify(annotations: readonly Annotation[], ...versions: string[]): Classified {
  const live: Annotation[] = [];
  const lost: Annotation[] = [];

  // Nothing readable means we failed to read, not that the contents vanished.
  const usable = versions.filter(v => v.length > 0);
  if (usable.length === 0) return { live: [...annotations], lost };

  for (const a of annotations) {
    if (a.anchor.kind !== 'markdown') {
      live.push(a);
      continue;
    }
    const anchor = a.anchor;
    (usable.some(v => resolveMarkdown(v, anchor)) ? live : lost).push(a);
  }

  return { live, lost };
}

/**
 * Split a track's marks by whether they can still be found in its lines.
 *
 * A transcript corrected by hand can take a marked passage with it as surely
 * as an edited note can, and a mark that quietly stops being drawn is the one
 * outcome worse than one shown as lost. Anything other than a transcript mark
 * passes through as live.
 */
export function classifyTranscript(
  annotations: readonly Annotation[],
  segs: readonly Seg[],
  track: string | null,
): Classified {
  const live: Annotation[] = [];
  const lost: Annotation[] = [];
  // No lines read means we failed to read, not that every passage vanished.
  if (segs.length === 0) return { live: [...annotations], lost };
  for (const a of annotations) {
    if (a.anchor.kind !== 'transcript') { live.push(a); continue; }
    (resolveTranscript(segs, a.anchor, track) ? live : lost).push(a);
  }
  return { live, lost };
}
