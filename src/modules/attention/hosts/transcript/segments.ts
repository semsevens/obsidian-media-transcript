import { App, TFile } from 'obsidian';
import { parseSubtitle } from '../../../../utils/subtitleParser';
import { Seg } from '../../anchor/transcriptAnchor';
import { asEl } from '../../dom';
import { ownerOfMarks } from './owner';

const TRACK_EXTENSIONS = ['srt', 'vtt', 'json'];

/**
 * The lines the marks filed under `owner` are read against, and the track
 * they come from — so a mark can be judged findable or lost without the
 * transcript being on screen.
 *
 * A transcript on screen answers first: it is exactly what the marks are
 * painted over. Otherwise the track file is read, as Media Transcript reads
 * it. A recording with no track file (a transcript made on the fly) has
 * nothing to read, and the answer is null: nothing can be judged.
 */
export async function segmentsFor(app: App, owner: string): Promise<{ segs: Seg[]; track: string | null } | null> {
  for (const raw of Array.from(document.querySelectorAll('.mt-transcript'))) {
    const panel = asEl(raw);
    if (!panel) continue;
    const track = panel.dataset.mtTrack ?? '';
    if (ownerOfMarks(panel.dataset.mtMedia ?? '', track) !== owner) continue;
    const segs = segmentsOnScreen(panel);
    if (segs.length > 0) return { segs, track: track || null };
  }

  const file = app.vault.getAbstractFileByPath(owner);
  if (!(file instanceof TFile) || !TRACK_EXTENSIONS.includes(file.extension.toLowerCase())) return null;
  try {
    const parsed = parseSubtitle(await app.vault.cachedRead(file), file.extension);
    if (parsed.length === 0) return null;
    return { segs: parsed.map(s => ({ seg: s.index, start: s.startTime, text: s.text })), track: owner };
  } catch {
    return null;
  }
}

/** The lines of a transcript panel, as the marks over it were measured. */
export function segmentsOnScreen(panel: HTMLElement): Seg[] {
  const out: Seg[] = [];
  for (const raw of Array.from(panel.querySelectorAll('.mt-segment'))) {
    const el = asEl(raw);
    const txt = asEl(el?.querySelector('.mt-txt'));
    const seg = Number(el?.dataset.mtSeg);
    if (!el || !txt || !Number.isFinite(seg)) continue;
    out.push({ seg, start: Number(el.dataset.mtStart), text: txt.innerText });
  }
  return out;
}
