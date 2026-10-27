import { App, Menu, Notice } from 'obsidian';
import type { ModulePlugin } from '../../../module';
import { TranscriptAnchor } from '../../model';
import { Seg, describeTranscript, resolveTranscript } from '../../anchor/transcriptAnchor';
import { AnnotationStore } from '../../store/annotationStore';
import { SelectionPopover } from '../../ui/SelectionPopover';
import { CommentBubble } from '../../ui/CommentBubble';
import { CommentModal } from '../../ui/CommentModal';
import { AttentionSettings } from '../../settings';
import { paintQuote } from '../paintQuote';
import { asEl, elementOf } from '../../dom';
import { ownerOfMarks } from './owner';
import { claimMenu, onLongPress, onTouchSelection } from '../../ui/touch';
import { t } from '../../../../i18n';

/** Announced by obsidian-media-transcript whenever it rebuilds its transcript. */
const TRANSCRIPT_RENDERED = 'mt:transcript-rendered';

/**
 * Annotating the Media Transcript plugin's transcript panel.
 *
 * That plugin announces every rebuild of its DOM and stamps each line with its
 * index and start time; we listen and repaint. The dependency runs one way —
 * it doesn't know this exists, and if it isn't installed the event simply never
 * fires and this host stays dormant.
 *
 * Annotations belong to the *media* file, not the subtitle track, so
 * re-transcribing with a different engine doesn't orphan them.
 */
export class TranscriptHost {
  private popover: SelectionPopover;
  private bubble: CommentBubble;

  constructor(
    private app: App,
    private plugin: ModulePlugin,
    private store: AnnotationStore,
    private settings: AttentionSettings,
    /** Opens the list of this transcript's marks, where lost ones are shown. */
    private showLost: () => void,
  ) {
    this.popover = new SelectionPopover();
    this.bubble = new CommentBubble(settings.timeFormat);
  }

  register(): void {
    // registerDomEvent only types known event names, so this one is wired by
    // hand and handed to the plugin for teardown.
    const onRendered = (e: Event) => {
      const detail = (e as CustomEvent).detail as { mediaPath?: string } | null;
      if (!detail?.mediaPath) return;
      const host = asEl(e.target);
      const panel = asEl(host?.querySelector('.mt-transcript')) ?? host;
      if (panel) void this.repaint(panel);
    };
    document.addEventListener(TRANSCRIPT_RENDERED, onRendered);
    this.plugin.register(() => document.removeEventListener(TRANSCRIPT_RENDERED, onRendered));

    // The bar over a selection belongs to the page it was made on.
    this.plugin.registerEvent(this.app.workspace.on('active-leaf-change', () => this.popover.hide()));

    // Repaint when our own annotations change, not just when they rerender.
    this.plugin.register(this.store.onChange(path => this.repaintOpenPanels(path)));

    this.plugin.registerDomEvent(document, 'mouseup', e => {
      if (e.button !== 0 || !this.settings.popoverOnSelection) return;
      if (!this.inTranscript(e.target)) return;
      if (asEl(e.target)?.closest('.at-hl, .at-popover, .at-bubble')) return;
      window.setTimeout(() => { void this.onSelectionMade(); }, 0);
    });

    // Touch has no mouseup, and a touch selection settles after the finger
    // lifts rather than when it does.
    const touched = onTouchSelection(() => {
      if (!this.settings.popoverOnSelection) return;
      void this.onSelectionMade();
    });
    this.plugin.register(() => touched.dispose());

    // The long press stands in for the right-click below.
    const pressed = onLongPress((target, at) => {
      if (!this.inTranscript(target)) return;
      const hit = asEl(asEl(target)?.closest('.at-hl'));
      const selected = window.getSelection()?.toString().trim() ?? '';
      if (!hit && selected.length === 0) return;
      if (!claimMenu()) return;
      void this.showMenu({ x: at.clientX, y: at.clientY }, hit);
    });
    this.plugin.register(() => pressed.dispose());

    this.plugin.registerDomEvent(document, 'click', e => {
      const hit = asEl(asEl(e.target)?.closest('.at-hl'));
      if (!hit || !this.inTranscript(hit)) return;
      if ((window.getSelection()?.toString().trim().length ?? 0) > 0) return;
      void this.showBubble(hit);
    });

    // Right-click, in the capture phase: Media Transcript has its own handler
    // on the segment, and letting both run would open two menus on top of each
    // other. When there is something of ours to offer we claim the event and
    // stop it; otherwise we leave it entirely alone.
    const onContextMenu = (e: MouseEvent) => {
      if (!this.inTranscript(e.target)) return;
      const hit = asEl(asEl(e.target)?.closest('.at-hl'));
      const selected = window.getSelection()?.toString().trim() ?? '';
      if (!hit && selected.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (!claimMenu()) return;
      void this.showMenu({ x: e.clientX, y: e.clientY }, hit);
    };
    document.addEventListener('contextmenu', onContextMenu, true);
    this.plugin.register(() => document.removeEventListener('contextmenu', onContextMenu, true));
  }

  detach(): void {
    this.popover.hide();
    this.bubble.hide();
  }

  private inTranscript(target: EventTarget | null): boolean {
    return this.panelOf(target) != null;
  }

  private panelOf(target: EventTarget | null) {
    return panelOf(target);
  }

  // ── Painting ───────────────────────────────────────────────────────────────

  /** Read the transcript out of the DOM the other plugin rendered. */
  private readSegments(panel: HTMLElement): { el: HTMLElement; txt: HTMLElement; seg: Seg }[] {
    const out: { el: HTMLElement; txt: HTMLElement; seg: Seg }[] = [];
    for (const raw of Array.from(panel.querySelectorAll('.mt-segment'))) {
      const el = asEl(raw);
      if (!el) continue;
      const txt = asEl(el.querySelector('.mt-txt'));
      const seg = Number(el.dataset.mtSeg);
      const start = Number(el.dataset.mtStart);
      if (!txt || !Number.isFinite(seg)) continue;
      out.push({ el, txt, seg: { seg, start, text: txt.innerText } });
    }
    return out;
  }

  private async repaint(panel: HTMLElement): Promise<void> {
    const mediaPath = panel.dataset.mtMedia;
    if (!mediaPath) return;
    const lines = this.readSegments(panel);
    if (lines.length === 0) return;

    const track = panel.dataset.mtTrack || null;
    const owner = ownerOfMarks(mediaPath, track ?? '');
    const data = await this.store.get(owner);
    const segs = lines.map(l => l.seg);

    let lost = 0;
    for (const a of data.annotations) {
      if (a.anchor.kind !== 'transcript') continue;
      const hit = resolveTranscript(segs, a.anchor, track);
      // Orphans are deliberately not drawn — a guess in the wrong place is
      // worse than a mark that shows up in the panel as lost.
      if (!hit) { lost++; continue; }
      const line = lines.find(l => l.seg.seg === hit.seg);
      if (!line) continue;
      paintQuote(line.txt, a, line.seg.text.slice(hit.charStart, hit.charEnd), hit.charStart);
      // Found somewhere other than where it was left (the transcript was
      // corrected, or regenerated): remember where, so the next read is exact
      // and a further edit starts from here rather than from the original.
      if (hit.how !== 'exact') {
        const moved = describeTranscript(line.seg, hit.charStart, hit.charEnd, track ?? a.anchor.track);
        if (anchorMoved(a.anchor, moved)) void this.store.update(owner, a.id, { anchor: moved });
      }
    }
    this.paintLostBar(panel, lost);
  }

  /** Says, above the transcript, that some of its marks can't find their text. */
  private paintLostBar(panel: HTMLElement, lost: number): void {
    panel.querySelector(':scope > .at-lost-bar')?.remove();
    if (lost === 0) return;
    const bar = createDiv('at-lost-bar');
    bar.setText(t('attention.transcriptLost', { count: lost }));
    bar.addEventListener('click', () => this.showLost());
    panel.prepend(bar);
  }

  /** `owner` is whatever the marks are filed under — the track, normally. */
  private repaintOpenPanels(owner: string): void {
    for (const raw of Array.from(document.querySelectorAll('.mt-transcript'))) {
      const panel = asEl(raw);
      if (!panel) continue;
      const mine = ownerOfMarks(panel.dataset.mtMedia ?? '', panel.dataset.mtTrack ?? '');
      if (mine === owner) void this.repaint(panel);
    }
  }

  // ── Capture ────────────────────────────────────────────────────────────────

  private capture(): { anchor: TranscriptAnchor; owner: string } | null {
    return captureSelection();
  }

  private async onSelectionMade(): Promise<void> {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const panel = this.panelOf(elementOf(selection.anchorNode))?.panel;
    if (!panel) return;
    // A selection across lines can't be one mark, but it can be one quote.
    const captured = captureSelection(true);

    this.popover.showAt(selection.getRangeAt(0).getBoundingClientRect(), {
      onMark: captured ? () => { void this.mark(captured.owner, captured.anchor, null); } : undefined,
      onComment: captured ? () => {
        new CommentModal(this.app, captured.anchor.quote, '', body => {
          void this.mark(captured.owner, captured.anchor, body || null);
        }).open();
      } : undefined,
      onQuote: () => askForQuote(panel),
    });
  }

  private async showMenu(at: { x: number; y: number }, hit: HTMLElement | null): Promise<void> {
    const menu = new Menu();

    if (hit) {
      const owner = this.panelOf(hit)?.owner;
      const id = hit.dataset.atId;
      if (!owner || !id) return;
      menu.addItem(i => i.setTitle(t('attention.menuEditComment')).setIcon('message-square')
        .onClick(() => { void this.editComment(owner, id); }));
      menu.addItem(i => i.setTitle(t('attention.menuRemoveMark')).setIcon('trash').setWarning(true)
        .onClick(() => { void this.store.remove(owner, id); }));
    } else {
      const captured = captureSelection(true);
      if (captured) {
        menu.addItem(i => i.setTitle(t('attention.menuMark')).setIcon('highlighter')
          .onClick(() => { void this.mark(captured.owner, captured.anchor, null); }));
        menu.addItem(i => i.setTitle(t('attention.menuComment')).setIcon('message-square').onClick(() => {
          new CommentModal(this.app, captured.anchor.quote, '', body => {
            void this.mark(captured.owner, captured.anchor, body || null);
          }).open();
        }));
      }
      const panel = this.panelOf(elementOf(window.getSelection()?.anchorNode))?.panel;
      if (panel) {
        menu.addItem(i => i.setTitle(t('attention.menuQuote')).setIcon('quote')
          .onClick(() => askForQuote(panel)));
      }
    }
    menu.showAtPosition(at);
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  private async showBubble(el: HTMLElement): Promise<void> {
    const owner = this.panelOf(el)?.owner;
    const id = el.dataset.atId;
    if (!owner || !id) return;
    const data = await this.store.get(owner);
    const annotation = data.annotations.find(a => a.id === id);
    if (!annotation) return;

    this.bubble.showFor(el.getBoundingClientRect(), annotation, {
      onEdit: () => { void this.editComment(owner, id); },
      onMarkAgain: () => { void this.markAgain(owner, id); },
      onRemove: () => { void this.store.remove(owner, id); },
    });
  }

  private async markAgain(targetPath: string, id: string): Promise<void> {
    const updated = await this.store.markAgain(targetPath, id);
    if (updated) new Notice(t('attention.noticeMarkedTimes', { count: updated.hits.length }));
  }

  private async editComment(owner: string, id: string): Promise<void> {
    const data = await this.store.get(owner);
    const annotation = data.annotations.find(a => a.id === id);
    if (!annotation) return;
    new CommentModal(this.app, annotation.anchor.quote, annotation.body ?? '', body => {
      void this.store.update(owner, id, { body: body || null });
    }).open();
  }

  private async mark(owner: string, anchor: TranscriptAnchor, body: string | null): Promise<void> {
    const { repeat, annotation } = await this.store.mark(owner, anchor, body);
    if (repeat) new Notice(t('attention.noticeMarkedTimes', { count: annotation.hits.length }));
  }
}

function anchorMoved(a: TranscriptAnchor, b: TranscriptAnchor): boolean {
  return a.seg !== b.seg || a.start !== b.start || a.charStart !== b.charStart ||
    a.charEnd !== b.charEnd || a.quote !== b.quote || a.prefix !== b.prefix ||
    a.suffix !== b.suffix || a.track !== b.track;
}

/**
 * The transcript panel containing `target`, and what it is showing.
 *
 * Read from the DOM rather than remembered from the announcement: a plugin
 * enabled while a transcript is already open never sees that event, and state
 * kept only in a handler is state you can miss.
 */
function panelOf(
  target: EventTarget | null,
): { panel: HTMLElement; mediaPath: string; trackPath: string; owner: string } | null {
  const panel = asEl(asEl(target)?.closest('.mt-transcript'));
  if (!panel) return null;
  const mediaPath = panel.dataset.mtMedia ?? '';
  if (!mediaPath) return null;
  const trackPath = panel.dataset.mtTrack ?? '';
  return { panel, mediaPath, trackPath, owner: ownerOfMarks(mediaPath, trackPath) };
}

/**
 * Turn the current selection in a transcript into an anchor, if it sits
 * inside one line — for a new mark, or to re-attach a lost one.
 */
export function captureSelection(quiet = false): { anchor: TranscriptAnchor; owner: string } | null {
  const selection = window.getSelection();
  const selected = selection?.toString() ?? '';
  if (!selection || selected.trim().length === 0) return null;

  const node = selection.anchorNode;
  const el = elementOf(node);
  const where = panelOf(el);
  if (!where) return null;
  const segEl = asEl(el?.closest('.mt-segment'));
  const txt = asEl(segEl?.querySelector('.mt-txt'));
  if (!segEl || !txt) return null;

  const text = txt.innerText;
  const at = text.indexOf(selected);
  if (at < 0) {
    // The selection runs across two lines; there is no single segment to
    // anchor it to, and splitting it silently would be worse than refusing.
    if (!quiet) new Notice(t('attention.noticeSingleLine'));
    return null;
  }

  const seg: Seg = {
    seg: Number(segEl.dataset.mtSeg),
    start: Number(segEl.dataset.mtStart),
    text,
  };
  return {
    anchor: describeTranscript(seg, at, at + selected.length, where.trackPath),
    owner: where.owner,
  };
}

/**
 * Have the transcript copy what is selected in it as a quote. It knows its
 * lines' times and what the passage links to; this only asks.
 */
function askForQuote(panel: HTMLElement): void {
  panel.dispatchEvent(new CustomEvent('mt:copy-quote', { bubbles: true }));
}
