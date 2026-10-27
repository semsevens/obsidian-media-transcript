import { App, ItemView, Menu, Notice, WorkspaceLeaf, TFile, MarkdownRenderer, setIcon } from 'obsidian';
import type AttentionPlugin from '../main';
import { IndexEntry, Bucket, BUCKET_ORDER } from '../store/review';
import { Annotation, isComment, lastMarked, pdfPage } from '../model';
import { Sort, sortLabels, sortsFor, resolveSort, sortAnnotations } from '../store/sorting';
import { inDocumentOrder } from '../store/documentOrder';
import { classify, classifyTranscript } from '../store/orphans';
import { transcludedNotes } from '../store/transclusions';
import { describe as describeAnchor } from '../anchor/textQuote';
import { MarkdownView } from 'obsidian';
import { isImageQuote } from '../anchor/imageAnchor';
import { reveal } from '../hosts/markdown/reveal';
import { formatWhen } from '../ui/time';
import { CommentModal } from '../ui/CommentModal';
import { asEl } from '../dom';
import { claimMenu, onLongPress } from '../ui/touch';
import { describeMark } from '../store/describeMark';
import { readable, readablePdf } from '../anchor/cjk';
import { preferredTrack, tracksFor } from '../hosts/transcript/trackFor';
import { segmentsFor } from '../hosts/transcript/segments';
import { captureSelection } from '../hosts/transcript/TranscriptHost';
import { t } from '../../../i18n';

export const VIEW_TYPE_REVIEW = 'attention-review';

const bucketLabels = (): Record<Bucket, string> => ({
  today: t('attention.bucketToday'),
  week: t('attention.bucketWeek'),
  month: t('attention.bucketMonth'),
  older: t('attention.bucketOlder'),
});

/**
 * Two ways of looking at the same annotations.
 *
 *   This note — what you marked here, in document order by default.
 *   All — across the vault, grouped by how long ago, for running into things
 *     again.
 *
 * They share a panel rather than taking two slots in the sidebar, because the
 * rendering is identical and only the question differs.
 */
// Named 'lens' rather than 'scope': View already has a `scope` (the keyboard
// scope), and shadowing it with a different type breaks the base class.
type Lens = 'file' | 'all';

export class ReviewView extends ItemView {
  private lens: Lens = 'file';
  private sort: Sort = 'document';
  /**
   * Bumped on every render. Rendering empties the panel, then awaits a file
   * read before appending; two overlapping calls would each empty and then each
   * append, listing everything twice. A render whose generation has been
   * superseded stops instead of drawing.
   */
  private generation = 0;
  private resurfaced: IndexEntry[] | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: AttentionPlugin) {
    super(leaf);
  }

  getViewType() { return VIEW_TYPE_REVIEW; }
  getDisplayText() { return t('attention.viewTitle'); }
  getIcon() { return 'highlighter'; }

  async onOpen() {
    this.registerEvent(this.app.workspace.on('file-open', () => { void this.render(); }));
    await this.render();
  }

  /** Switch to a lens — to this note's marks, say, to see which are lost. */
  showLens(lens: Lens): void {
    if (this.lens === lens && !this.resurfaced) return;
    this.lens = lens;
    this.sort = resolveSort(this.sort, lens);
    this.resurfaced = null;
    void this.render();
  }

  async render(): Promise<void> {
    // Painting a view Obsidian hasn't finished mounting is wasted work; onOpen
    // renders once we're attached.
    const seq = ++this.generation;
    const root = this.contentEl;
    root.empty();
    root.addClass('at-review');

    this.renderHeader(root);

    if (this.resurfaced) {
      for (const e of this.resurfaced) this.renderEntry(root, e.annotation, e.targetPath);
      return;
    }

    if (this.lens === 'file') await this.renderFile(root, seq);
    else this.renderAll(root);
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv('at-review-header');
    const top = header.createDiv('at-review-top');
    top.createDiv({ cls: 'at-review-title', text: t('attention.viewTitle') });

    const tabs = header.createDiv('at-tabs');
    const tab = (label: string, lens: Lens) => {
      const el = tabs.createEl('button', { text: label, cls: 'at-tab' });
      if (this.lens === lens && !this.resurfaced) el.addClass('is-active');
      el.addEventListener('click', () => {
        this.lens = lens;
        // Document order means nothing across files; fall back rather than
        // showing an arbitrary order under a label that promises one.
        this.sort = resolveSort(this.sort, lens);
        this.resurfaced = null;
        void this.render();
      });
    };
    tab(t('attention.tabThisNote'), 'file');
    tab(t('attention.tabAll'), 'all');

    const resurface = top.createEl('button', { cls: 'at-btn at-resurface' });
    setIcon(resurface.createSpan('at-btn-icon'), 'shuffle');
    resurface.createSpan({ text: t('attention.buttonResurface') });
    if (this.resurfaced) resurface.addClass('is-active');
    resurface.addEventListener('click', () => {
      this.resurfaced = this.resurfaced
        ? null
        : this.plugin.index.resurface(this.plugin.settings.resurfaceCount, () => Math.random());
      void this.render();
    });

    if (!this.resurfaced) this.renderSortControl(header);
  }

  private renderSortControl(root: HTMLElement): void {
    const bar = root.createDiv('at-sortbar');
    const labels = sortLabels();
    const chip = bar.createEl('button', { cls: 'at-sort-chip', attr: { 'aria-label': t('attention.sortLabel') } });
    setIcon(chip.createSpan('at-btn-icon'), 'arrow-up-down');
    chip.createSpan({ text: labels[this.sort] });
    chip.addEventListener('click', e => {
      const menu = new Menu();
      for (const s of sortsFor(this.lens)) {
        menu.addItem(i => i.setTitle(labels[s]).setChecked(s === this.sort).onClick(() => {
          this.sort = s;
          void this.render();
        }));
      }
      menu.showAtMouseEvent(e);
    });
  }

  // ── This note ──────────────────────────────────────────────────────────────

  private async renderFile(root: HTMLElement, seq: number): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.empty(root, t('attention.emptyNoNote'));
      return;
    }

    // No early return on an empty file: a note with nothing of its own can
    // still be showing marks from something it transcludes.
    //
    // A recording keeps its marks on the subtitle track they were read from,
    // so opening the recording has to follow that link — otherwise the marks
    // are filed correctly and visible nowhere.
    const owner = trackForMedia(this.app, file.path) ?? file.path;
    const data = await this.plugin.store.get(owner);
    if (seq !== this.generation) return;

    // Read once, and use it for both ordering and deciding what's still
    // findable. Prefer the open editor's buffer: cachedRead lags behind
    // unsaved typing, and judging a mark lost against stale text is a lie.
    const text = await this.currentText(file);
    const onDisk = await this.diskText(file);
    if (seq !== this.generation) return;
    // Both: the buffer leads while typing and lags while a view switches files.
    const notes = classify(data.annotations, text, onDisk);
    // A transcript's marks are judged against its lines, the way a note's are
    // against its text: a corrected transcript can lose a passage too.
    const lines = data.annotations.some(a => a.anchor.kind === 'transcript')
      ? await segmentsFor(this.app, owner) : null;
    if (seq !== this.generation) return;
    const byLine = lines ? classifyTranscript(notes.live, lines.segs, lines.track) : null;
    const live = byLine?.live ?? notes.live;
    const lost = [...notes.lost, ...(byLine?.lost ?? [])];

    const ordered = this.sort === 'document'
      ? await inDocumentOrder(this.app, file, live, text)
      : sortAnnotations(live.map(annotation => ({ annotation })), this.sort).map(x => x.annotation);
    if (seq !== this.generation) return;

    if (ordered.length > 0) {
      root.createDiv('at-bucket-title').setText(t('attention.countInNote', { count: ordered.length }));
      for (const a of ordered) this.renderEntry(root, a, owner);
    }

    // Marks whose passage was edited away. Kept, and said out loud — silently
    // dropping the words you cared about is the one thing worse than not
    // being able to draw them.
    if (lost.length > 0) {
      root.createDiv('at-bucket-title at-lost-title')
        .setText(t('attention.countLost', { count: lost.length }));
      for (const a of lost) this.renderEntry(root, a, owner, true);
    }

    // Notes transcluded into this one are on screen too, so their marks are
    // part of what you're reading. Shown separately, with their source, since
    // acting on them edits another file.
    let embedded = 0;
    for (const note of transcludedNotes(this.app, file)) {
      const theirs = (await this.plugin.store.get(note.path)).annotations;
      if (seq !== this.generation) return;
      if (theirs.length === 0) continue;
      if (embedded === 0) root.createDiv('at-bucket-title').setText(t('attention.fromEmbedded'));
      embedded += theirs.length;
      for (const a of theirs) this.renderEntry(root, a, note.path, false, true);
    }

    if (ordered.length === 0 && lost.length === 0 && embedded === 0) {
      this.empty(root, t('attention.emptyNothingInNote', { name: file.basename }));
    }
  }

  // ── All ────────────────────────────────────────────────────────────────────

  private renderAll(root: HTMLElement): void {
    const all = this.plugin.index.all();
    if (all.length === 0) {
      this.empty(root, t('attention.emptyNothingYet'));
      return;
    }

    // Only the default ordering is grouped by age; asking for another order
    // and still getting time headings would be answering a different question.
    if (this.sort !== 'recent') {
      const sorted = sortAnnotations(all, this.sort);
      root.createDiv('at-bucket-title').setText(t('attention.countMarked', { count: sorted.length }));
      for (const e of sorted) this.renderEntry(root, e.annotation, e.targetPath);
      return;
    }

    const buckets = this.plugin.index.buckets();
    const labels = bucketLabels();
    for (const key of BUCKET_ORDER) {
      const entries = buckets[key];
      if (entries.length === 0) continue;
      root.createDiv('at-bucket-title').setText(`${labels[key]} · ${entries.length}`);
      for (const e of entries) this.renderEntry(root, e.annotation, e.targetPath);
    }
  }

  // ── Shared ─────────────────────────────────────────────────────────────────

  /**
   * What the file says right now — from the editor if it's open, else disk.
   *
   * An editor that has just been opened can hand back an empty buffer for a
   * moment. Judging marks against that says every one of them is lost, which
   * is both alarming and wrong, so an empty answer falls through to the file.
   */
  private async currentText(file: TFile): Promise<string> {
    // Only a note's marks are judged against its text. A recording or a PDF
    // read as text is megabytes of nothing, and an empty answer leaves its
    // marks as they are.
    if (file.extension !== 'md') return '';
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === file.path) {
        const buffer = view.editor?.getValue() ?? '';
        if (buffer.length > 0) return buffer;
        break;
      }
    }
    try { return await this.app.vault.cachedRead(file); } catch { return ''; }
  }

  private async diskText(file: TFile): Promise<string> {
    if (file.extension !== 'md') return '';
    try { return await this.app.vault.cachedRead(file); } catch { return ''; }
  }

  private empty(root: HTMLElement, message: string): void {
    root.createDiv('at-empty').setText(message);
  }

  private renderEntry(
    root: HTMLElement,
    annotation: Annotation,
    targetPath: string,
    lost = false,
    fromEmbed = false,
  ): void {
    const el = root.createDiv('at-entry');
    if (lost) el.addClass('at-entry-lost');

    const anchor = annotation.anchor;
    if (anchor.kind === 'pdf' && anchor.region) {
      // The region itself, cut from its page by PDF++'s own embed — the same
      // `![[x.pdf#page=…&rect=…]]` its rectangle tool copies. Built here, not
      // stored: the file may have been renamed since.
      const { page, rect } = anchor.region;
      const thumb = el.createDiv('at-thumb at-thumb-pdf');
      const embed = `![[${targetPath}#page=${page}&rect=${rect.map(v => Math.round(v)).join(',')}]]`;
      void MarkdownRenderer.render(this.app, embed, thumb, targetPath, this);
      if (anchor.quote) el.createDiv('at-quote at-quote-region').setText(readablePdf(anchor.quote));
    } else if (isImageQuote(annotation.anchor.quote)) {
      // Render the embed through Obsidian rather than resolving a URL here.
      // Whatever the note shows, this shows: a plugin that swaps remote
      // pictures for locally cached ones runs in that pipeline too, so the
      // thumbnail resolves exactly as the picture in the note does.
      const thumb = el.createDiv('at-thumb');
      void MarkdownRenderer.render(this.app, annotation.anchor.quote, thumb, targetPath, this);
    } else {
      el.createDiv('at-quote').setText(
        anchor.kind === 'pdf' ? readablePdf(anchor.quote) : readable(anchor.quote),
      );
    }
    if (isComment(annotation)) {
      el.createDiv('at-body').setText(annotation.body ?? '');
    }

    // Where on the left, when on the right. Filenames vary in length and times
    // don't, so letting the name take the slack keeps the timestamps in a
    // column you can read straight down.
    const meta = el.createDiv('at-meta');

    const left = meta.createDiv('at-meta-left');
    // In the per-note outline the filename is noise — it's the same every time.
    if (this.lens === 'all' || this.resurfaced || fromEmbed) {
      const name = targetPath.split('/').pop() ?? targetPath;
      const source = left.createSpan({ text: name.replace(/\.md$/, ''), cls: 'at-source' });
      // The name is the only thing saying this mark is not from the note on
      // screen, and it is the first thing the column truncates. Across the
      // whole vault that reads as a picture that does not match the note it is
      // sitting beside, so the full path stays available on hover.
      source.setAttribute('title', targetPath);
    }
    if (annotation.anchor.kind === 'transcript') {
      left.createSpan({ text: fmtTime(annotation.anchor.start), cls: 'at-time' });
    }
    if (annotation.anchor.kind === 'pdf') {
      left.createSpan({ text: t('attention.pageShort', { page: pdfPage(annotation.anchor) }), cls: 'at-time' });
    }

    const right = meta.createDiv('at-meta-right');
    // A passage that caught you more than once is the point; say so.
    if (annotation.hits.length > 1) {
      right.createSpan({ text: `${annotation.hits.length}×`, cls: 'at-hits' });
    }
    right.createSpan({
      text: formatWhen(lastMarked(annotation), this.plugin.settings.timeFormat),
      cls: 'at-when',
    });

    // Acting on a mark from the list, rather than having to find it in the note
    // first. Revealed on hover so a long list stays quiet.
    const actions = el.createDiv('at-entry-actions');
    const act = (icon: string, title: string, fn: () => void, warn = false) => {
      const b = actions.createEl('button', { cls: 'clickable-icon at-icon-btn' });
      setIcon(b, icon);
      b.setAttribute('aria-label', title);
      b.setAttribute('title', title);
      if (warn) b.addClass('mod-warning');
      b.addEventListener('click', e => {
        e.stopPropagation();   // the entry itself jumps to the passage
        fn();
      });
    };
    // Re-marking from the list: the passage came back to mind, which is worth
    // recording even when you aren't looking at it in the note.
    if (lost) {
      act('link', anchor.kind === 'transcript' ? t('attention.tooltipReattachTranscript') : t('attention.tooltipReattach'),
          () => { void this.reattach(targetPath, annotation); });
    } else {
      act('plus', t('attention.tooltipMarkAgain'),
          () => { void this.markAgain(targetPath, annotation); });
    }
    act('message-square', isComment(annotation) ? t('attention.tooltipEditComment') : t('attention.tooltipAddComment'),
        () => this.editComment(targetPath, annotation));
    act('x', t('attention.tooltipRemoveThisMark'),
        () => { void this.plugin.store.remove(targetPath, annotation.id); }, true);

    // A lost mark has nowhere to jump to; clicking it would do nothing.
    if (!lost) el.addEventListener('click', () => { void this.jumpTo(annotation, targetPath); });
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (!claimMenu()) return;
      this.entryMenu({ x: e.clientX, y: e.clientY }, annotation, targetPath);
    });
    // A phone cannot right-click; the row's buttons are always visible there,
    // and a press still brings the full menu.
    const pressed = onLongPress((target, at) => {
      if (!(target instanceof Node) || !el.contains(target)) return;
      if (!claimMenu()) return;
      this.entryMenu({ x: at.clientX, y: at.clientY }, annotation, targetPath);
    });
    this.register(() => pressed.dispose());
  }

  private entryMenu(at: { x: number; y: number }, annotation: Annotation, targetPath: string): void {
    const menu = new Menu();
    menu.addItem(i => i.setTitle(t('attention.menuGoTo')).setIcon('arrow-right')
      .onClick(() => { void this.jumpTo(annotation, targetPath); }));
    menu.addItem(i => i.setTitle(t('attention.menuMarkAgain')).setIcon('plus')
      .onClick(() => { void this.markAgain(targetPath, annotation); }));
    menu.addItem(i => i.setTitle(isComment(annotation) ? t('attention.menuEditComment') : t('attention.menuAddComment'))
      .setIcon('message-square').onClick(() => this.editComment(targetPath, annotation)));
    menu.addItem(i => i.setTitle(t('attention.menuCopyDetails')).setIcon('copy')
      .onClick(() => { void this.copyDetails(annotation, targetPath); }));
    menu.addItem(i => i.setTitle(t('attention.menuReattach')).setIcon('link')
      .onClick(() => { void this.reattach(targetPath, annotation); }));
    menu.addItem(i => i.setTitle(t('attention.menuCopyText')).setIcon('copy')
      .onClick(() => { void navigator.clipboard.writeText(annotation.anchor.kind === 'pdf' ? readablePdf(annotation.anchor.quote) : readable(annotation.anchor.quote)); }));
    menu.addItem(i => i.setTitle(t('attention.menuRemoveMark')).setIcon('trash').setWarning(true)
      .onClick(() => { void this.plugin.store.remove(targetPath, annotation.id); }));
    menu.showAtPosition(at);
  }

  /**
   * Point a lost mark at whatever is selected in the note now.
   *
   * The mark keeps its identity — its comment, and every time it caught you —
   * and only learns where it lives. Re-marking the passage by hand would give
   * you a new mark and quietly lose that history.
   */
  /**
   * Put the mark on the clipboard, in a shape that survives leaving here.
   *
   * The panel can leave the file implicit because it is right there; pasted
   * anywhere else, a passage with no note named is an unattributed quotation.
   */
  private async copyDetails(annotation: Annotation, targetPath: string): Promise<void> {
    const { text } = describeMark(annotation, {
      targetPath,
      when: iso => formatWhen(iso, this.plugin.settings.timeFormat),
      clock: fmtTime,
    });
    await navigator.clipboard.writeText(text);
    new Notice(t('attention.noticeCopied'));
  }

  private async reattach(targetPath: string, annotation: Annotation): Promise<void> {
    if (annotation.anchor.kind === 'transcript') {
      await this.reattachInTranscript(targetPath, annotation);
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== targetPath || view.getMode() !== 'source') {
      new Notice(t('attention.noticeReattachOpenEditor'));
      return;
    }
    const editor = view.editor;
    const from = editor.posToOffset(editor.getCursor('from'));
    const to = editor.posToOffset(editor.getCursor('to'));
    if (from === to) {
      new Notice(t('attention.noticeReattachSelect'));
      return;
    }

    await this.plugin.store.update(targetPath, annotation.id, {
      anchor: { kind: 'markdown', ...describeAnchor(editor.getValue(), from, to) },
    });
    new Notice(t('attention.noticeReattached', { text: editor.getValue().slice(from, to).slice(0, 20) }));
  }

  /** The same, for a mark in a transcript: whatever is selected in its panel. */
  private async reattachInTranscript(targetPath: string, annotation: Annotation): Promise<void> {
    const captured = captureSelection();
    if (!captured || captured.owner !== targetPath) {
      new Notice(t('attention.noticeReattachTranscript'));
      return;
    }
    await this.plugin.store.update(targetPath, annotation.id, { anchor: captured.anchor });
    new Notice(t('attention.noticeReattached', { text: captured.anchor.quote.slice(0, 20) }));
  }

  private async markAgain(targetPath: string, annotation: Annotation): Promise<void> {
    const updated = await this.plugin.store.markAgain(targetPath, annotation.id);
    if (updated) new Notice(t('attention.noticeMarkedTimes', { count: updated.hits.length }));
  }

  private editComment(targetPath: string, annotation: Annotation): void {
    new CommentModal(this.app, readable(annotation.anchor.quote), annotation.body ?? '', body => {
      void this.plugin.store.update(targetPath, annotation.id, { body: body || null });
    }).open();
  }

  private async jumpTo(annotation: Annotation, targetPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(targetPath);
    if (!(file instanceof TFile)) return;

    await reveal(this.app, file, annotation, this.plugin.openModeFor(file));
    // Marking it seen is what makes "prefer things you haven't revisited" work.
    await this.plugin.markReviewed({ targetPath, annotation });
  }
}

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The track a recording's marks are filed under.
 *
 * A transcript on screen answers first: it is Media Transcript's own decision,
 * and it survives the reader switching tracks by hand, which no rule can
 * predict. With nothing on screen the same rule that plugin uses is applied —
 * its naming convention, ordered by the priority list read from its settings —
 * so both arrive at the same track and marks are not filed where nobody looks.
 */
function trackForMedia(app: App, path: string): string | null {
  for (const raw of Array.from(document.querySelectorAll('.mt-transcript'))) {
    const panel = asEl(raw);
    if (panel?.dataset.mtMedia !== path) continue;
    const track = panel.dataset.mtTrack?.trim();
    if (track) return track;
  }

  const settings = mediaTranscriptSettings(app);
  const tracks = tracksFor(
    app.vault.getFiles().map((f: TFile) => f.path),
    path,
    settings?.subtitleDirectory ?? '',
  );
  return preferredTrack(tracks, (settings?.priorities ?? []).map(p => p.marker));
}

interface MediaTranscriptSettings {
  subtitleDirectory?: string;
  priorities?: { marker: string }[];
}

/**
 * Media Transcript's settings, if it is installed and running.
 *
 * `app.plugins` is not in the public typings — this is the only way to ask
 * another plugin what the reader configured, and asking beats keeping a second
 * copy of the answer that can drift from theirs. Absent or shaped differently,
 * the answer is simply nothing, and the convention's own defaults apply.
 */
function mediaTranscriptSettings(app: App): MediaTranscriptSettings | null {
  const plugins = (app as unknown as {
    plugins?: { plugins?: Record<string, { settings?: MediaTranscriptSettings }> };
  }).plugins;
  return plugins?.plugins?.['media-transcript']?.settings ?? null;
}
