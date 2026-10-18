import { TFile, TAbstractFile, WorkspaceLeaf, Notice, MarkdownView } from 'obsidian';
import { ModulePlugin } from '../module';

import { AttentionSettings, DEFAULT_SETTINGS, AttentionSettingTab } from './settings';
import { AttentionIndex } from './store/attentionIndex';
import { IndexEntry } from './store/review';
import { ReviewView, VIEW_TYPE_REVIEW } from './views/ReviewView';
import {
  loadSidecar,
  saveSidecar,
  sidecarPathFor,
  isSidecarPath,
  targetPathFor,
} from './store/sidecar';
import { AnnotationStore } from './store/annotationStore';
import { MarkdownHost } from './hosts/markdown/MarkdownHost';
import {
  annotationDecorations,
  repaintEditors,
  setEditListener,
  setDriftListener,
} from './hosts/markdown/decorations';
import { AnchorTracker } from './anchor/AnchorTracker';
import { readingModeHighlighter, repaintReadingViews } from './hosts/markdown/readingMode';
import { TranscriptHost } from './hosts/transcript/TranscriptHost';
import { PdfHost } from './hosts/pdf/PdfHost';
import { planMove } from './store/migrateToTrack';
import { ViewModeHost } from './hosts/markdown/viewModeHost';
import type { ViewModeTarget } from './viewMode';
import { t } from '../../i18n';

export default class AttentionPlugin extends ModulePlugin {
  settings!: AttentionSettings;
  index!: AttentionIndex;
  store!: AnnotationStore;
  private markdownHost: MarkdownHost | null = null;
  private transcriptHost: TranscriptHost | null = null;
  private pdfHost: PdfHost | null = null;
  private tracker: AnchorTracker | null = null;
  private viewModes: ViewModeHost | null = null;

  async start() {
    await this.loadSettings();
    this.index = new AttentionIndex(this.app);
    this.store = new AnnotationStore(this.app, this.index);

    this.registerView(VIEW_TYPE_REVIEW, leaf => new ReviewView(leaf, this));


    this.applyMarkStyle();
    this.applyMarkColor();

    if (this.settings.enableMarkdownHost) this.setupMarkdownHost();

    // Registered whether or not the feature is on, so flipping the setting
    // takes effect without a reload; the setting is read per note.
    this.viewModes = new ViewModeHost(this.app, this, this.settings);
    this.viewModes.register();

    if (this.settings.enablePdfHost) {
      // Dormant unless PDF++ is installed: it does the selecting and drawing.
      this.pdfHost = new PdfHost(this.app, this, this.store, this.settings);
      this.pdfHost.register();
    }

    if (this.settings.enableTranscriptHost) {
      // Dormant unless obsidian-media-transcript is installed and announcing.
      this.transcriptHost = new TranscriptHost(this.app, this, this.store, this.settings);
      this.transcriptHost.register();
    }

    // A change to any annotation has to reach both rendering paths and the
    // review panel; nothing repaints itself.
    this.register(this.store.onChange(() => {
      repaintEditors(this.app, path => this.store.peek(path));
      this.rerenderReadingViews();
      this.repaintReadingSoon();
      this.refreshReviewViews();
    }));

    // Painting reads from the cache synchronously, so a file's annotations must
    // be loaded before its view asks for them.
    this.registerEvent(this.app.workspace.on('file-open', file => {
      if (file) void this.onFileOpen(file);
    }));

    // Scanning every sidecar touches the whole file list, so wait until the
    // vault has finished indexing rather than fighting it during startup.
    this.app.workspace.onLayoutReady(() => { void this.onLayoutReady(); });

    this.addRibbonIcon('highlighter', t('attention.ribbon'), () => { void this.openReview(); });

    this.addCommand({
      id: 'open-review',
      name: t('attention.commandOpenReview'),
      callback: () => { void this.openReview(); },
    });

    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      void this.handleRename(file, oldPath);
    }));

    this.registerEvent(this.app.vault.on('delete', file => {
      void this.handleDelete(file);
    }));

    // Marks made on another device arrive as an edited sidecar (Sync): show
    // them. After the vault is loaded, so its first listing isn't each "new".
    this.app.workspace.onLayoutReady(() => {
      const changed = (file: TAbstractFile) => {
        if (file instanceof TFile && isSidecarPath(file.path)) void this.store.reload(file.path);
      };
      this.registerEvent(this.app.vault.on('create', changed));
      this.registerEvent(this.app.vault.on('modify', changed));
      this.registerEvent(this.app.vault.on('delete', changed));
    });

    this.addSettingTab(new AttentionSettingTab(this.app, this));
  }

  /** Mark style is a body class, so switching it needs no repaint. */
  applyMarkStyle(): void {
    document.body.toggleClass('at-style-background', this.settings.markStyle === 'background');
  }

  /** One colour for every mark, published as a variable so nothing repaints. */
  applyMarkColor(): void {
    document.body.setCssProps({ '--at-color': this.settings.markColor });
  }

  /** Re-open every visible note in the mode the current rules ask for. */
  applyViewModes(): void {
    this.viewModes?.applyToOpenNotes();
  }

  /**
   * Opening a sidecar opens what it annotates instead.
   *
   * `<note>.anno.json` is plumbing — nobody clicks it wanting to read JSON, and
   * `.json` is claimed by whichever plugin registered the extension, which then
   * has to explain a file it knows nothing about. Redirecting keeps that
   * knowledge here, where the naming convention lives.
   */
  private async redirectSidecar(file: TFile): Promise<boolean> {
    if (!isSidecarPath(file.path)) return false;
    const targetPath = targetPathFor(file.path);
    const target = targetPath && this.app.vault.getAbstractFileByPath(targetPath);

    if (!(target instanceof TFile)) {
      // The annotated file is gone; the sidecar is all that's left of it.
      new Notice(t('attention.noticeSidecarOrphan', { name: targetPath ?? file.name }));
      return false;
    }

    this.replaceOpenFile(file.path, target);
    return true;
  }

  /**
   * Swap what a leaf is showing, once Obsidian has finished putting it there.
   *
   * This runs from inside `file-open`, and Obsidian completes its own open
   * *after* the handler returns — an openFile issued here is quietly undone a
   * moment later, which looks exactly like the redirect never firing. Deferring
   * by a fixed delay works but bets on a number; retrying until the leaf
   * actually moved is the same idea without the guess, and stops on its own if
   * the reader navigates somewhere else first.
   */
  private replaceOpenFile(from: string, target: TFile): void {
    let attempts = 0;
    const attempt = () => {
      if (this.app.workspace.getActiveFile()?.path !== from) return; // moved on
      void this.app.workspace.getLeaf(false).openFile(target);
      if (++attempts < 8) window.setTimeout(attempt, 40);
    };
    window.setTimeout(attempt, 0);
  }

  private async onLayoutReady(): Promise<void> {
    await this.migrateTranscriptMarks();
    await this.rebuildIndex();
    // Notes open at load time never fire `file-open`, so without this their
    // highlights stay unpainted until you switch away and back — which is
    // exactly what happens on every hot reload. The same gap applies to the
    // mode they opened in.
    await this.warmOpenFiles();
    this.applyViewModes();
  }

  private async warmOpenFiles(): Promise<void> {
    const paths = new Set<string>();
    this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
      const file = leaf.view instanceof MarkdownView ? leaf.view.file : null;
      if (file) paths.add(file.path);
    });
    await Promise.all([...paths].map(p => this.store.warm(p)));
  }

  private async onFileOpen(file: TFile): Promise<void> {
    if (await this.redirectSidecar(file)) return;
    await this.store.warm(file.path);
    if (!this.settings.autoRevealPanel) return;
    if (this.store.peek(file.path).length === 0) return;
    await this.openReview({ focus: false });
  }

  private setupMarkdownHost(): void {
    // Both renderers read straight from the cache — resolving an anchor is a
    // string search, cheap enough to redo on every repaint, and keeping no
    // second copy means there is no stale state to invalidate.
    const provider = (path: string) => this.store.peek(path);

    // Anchors follow edits made in the editor, where the changes are known
    // exactly, rather than being searched for again afterwards.
    this.tracker = new AnchorTracker(this.store);
    setEditListener((path, changes, text) => this.tracker?.onEdit(path, changes, text));
    setDriftListener((path, id, anchor, text, at) =>
      this.tracker?.noteResolved(path, id, anchor, text, at));
    this.register(() => { setEditListener(null); setDriftListener(null); });

    this.registerEditorExtension(annotationDecorations(provider));
    this.registerMarkdownPostProcessor(readingModeHighlighter(provider));

    // Switching into reading mode can reuse a render made before a mark
    // existed, so paint over whatever is on screen when the layout settles.
    this.registerEvent(this.app.workspace.on('layout-change', () => {
      repaintReadingViews(this.app, provider);
    }));

    // Reading mode keeps rendered sections and re-attaches them as they come
    // back into view, which does not re-run the post-processor — so a mark
    // scrolled off and back again would return unpainted. Scroll does not
    // bubble, hence the capture phase; painting is idempotent and debounced, so
    // reacting to all of them is cheap.
    let scrolled: number | null = null;
    this.registerDomEvent(document, 'scroll', () => {
      if (scrolled !== null) window.clearTimeout(scrolled);
      scrolled = window.setTimeout(() => {
        scrolled = null;
        repaintReadingViews(this.app, provider);
      }, 80);
    }, true);

    this.markdownHost = new MarkdownHost(this.app, this, this.store, this.settings);
    this.markdownHost.register();
  }

  /**
   * Paint the reading views, and again once the re-render above has landed.
   *
   * `rerender` returns before the new HTML exists, so painting only once puts
   * the marks on a DOM that is about to be thrown away — and a block Obsidian
   * decides it can reuse never runs the post-processor that would have painted
   * it. Marking then looked like nothing had happened until the note was
   * closed and opened again. Painting is idempotent, so trying a few times
   * costs nothing and covers however long the render takes.
   */
  private repaintReadingSoon(): void {
    const provider = (path: string) => this.store.peek(path);
    repaintReadingViews(this.app, provider);
    for (const delay of [0, 60, 200]) {
      window.setTimeout(() => repaintReadingViews(this.app, provider), delay);
    }
  }

  /** Reading mode caches its HTML, so post-processors only re-run on request. */
  private rerenderReadingViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.getMode() === 'preview') {
        const scroll = view.previewMode.getScroll();
        view.previewMode.rerender(true);
        // Full rerenders discard section heights. Let Obsidian restore its
        // source-line position once the replacement sections are rendered.
        if (Number.isFinite(scroll)) view.setEphemeralState({ scroll });
      }
    }
  }

  /** The mode a note is put in when it opens, if a rule says so. */
  openModeFor(file: TFile): ViewModeTarget | null {
    return this.viewModes?.modeFor(file) ?? null;
  }

  /** Redraw after a setting that only affects how things are shown. */
  refreshPanels(): void {
    this.refreshReviewViews();
  }

  /**
   * Re-file transcript marks that were made when they lived on the recording.
   *
   * Once, and remembered, because it walks every sidecar in the vault. Each
   * such anchor already names its track, so nothing is guessed; a mark with no
   * track named — a transcript made on the fly — stays where it is.
   */
  private async migrateTranscriptMarks(): Promise<void> {
    if (this.settings.transcriptMarksOnTrack) return;

    let moved = 0;
    for (const file of this.app.vault.getFiles()) {
      if (!isSidecarPath(file.path)) continue;
      const target = targetPathFor(file.path);
      if (!target) continue;

      const data = await loadSidecar(this.app, target);
      const { moves, keep } = planMove(target, data.annotations);
      if (moves.length === 0) continue;

      for (const move of moves) {
        const into = await loadSidecar(this.app, move.to);
        into.annotations.push(...move.annotations);
        await saveSidecar(this.app, into);
        moved += move.annotations.length;
      }
      await saveSidecar(this.app, { ...data, annotations: keep });
    }

    this.settings.transcriptMarksOnTrack = true;
    await this.saveSettings();
    if (moved > 0) {
      new Notice(t(moved === 1 ? 'attention.noticeTranscriptMovedOne' : 'attention.noticeTranscriptMovedMany', { count: moved }));
    }
  }

  async rebuildIndex(): Promise<void> {
    await this.index.rebuild();
    this.refreshReviewViews();
  }

  /** Record that an annotation resurfaced, so future picks can prefer others. */
  async markReviewed(entry: IndexEntry): Promise<void> {
    const data = await loadSidecar(this.app, entry.targetPath);
    const target = data.annotations.find(a => a.id === entry.annotation.id);
    if (!target) return;
    target.reviewed.push(new Date().toISOString());
    await saveSidecar(this.app, data);
    this.index.replaceFile(entry.targetPath, data.annotations);
  }

  /**
   * Show the panel. `focus: false` is used when opening it on the user's behalf
   * — revealing a sidebar is helpful, stealing the cursor mid-sentence is not.
   */
  private opening: Promise<void> | null = null;

  private async openReview(opts: { focus?: boolean } = {}): Promise<void> {
    // Opening twice concurrently would race two mounts of the same view type.
    this.opening = (this.opening ?? Promise.resolve()).then(() => this.doOpenReview(opts));
    return this.opening;
  }

  private async doOpenReview({ focus = true }: { focus?: boolean } = {}): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW);
    const leaf: WorkspaceLeaf | null =
      existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;

    // Check what the leaf actually holds, not merely that one exists. A leaf
    // whose plugin has been unloaded and reloaded — every hot reload, and any
    // sidebar tab Obsidian has deferred — is still returned by
    // getLeavesOfType() while holding a placeholder rather than our view, and
    // revealing that shows an empty pane.
    if (!(leaf.view instanceof ReviewView)) {
      await leaf.setViewState({ type: VIEW_TYPE_REVIEW, active: focus });
    }

    // A sidebar leaf restored from the last session is *deferred*: its view is
    // constructed, so `instanceof` passes, but onOpen hasn't run and contentEl
    // is not in the document. Rendering into it succeeds and shows nothing.
    await leaf.loadIfDeferred();
    await this.app.workspace.revealLeaf(leaf);

    if (!focus) {
      const editor = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (editor) this.app.workspace.setActiveLeaf(editor.leaf, { focus: true });
    }
  }

  private refreshReviewViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW)) {
      // Deferred leaves aren't in the document yet; they render on open.
      if (leaf.isDeferred) continue;
      if (!leaf.view.containerEl.isConnected) continue;
      if (leaf.view instanceof ReviewView) void leaf.view.render();
    }
  }

  /**
   * Keep the sidecar beside its target. Folder moves need no work — the sidecar
   * is a sibling, so it travels with the folder — only a file's own rename does.
   */
  private async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!(file instanceof TFile) || isSidecarPath(file.path)) return;

    const old = this.app.vault.getAbstractFileByPath(sidecarPathFor(oldPath));
    if (!(old instanceof TFile)) return;

    const nextPath = sidecarPathFor(file.path);
    if (old.path === nextPath) return;

    try {
      await this.app.fileManager.renameFile(old, nextPath);
      // Re-stamp `target` inside the file so it doesn't disagree with its name.
      const data = await loadSidecar(this.app, file.path);
      await saveSidecar(this.app, data);
      this.store.forget(oldPath);
      this.index.renameFile(oldPath, file.path);
      this.refreshReviewViews();
    } catch (e) {
      new Notice(t('attention.noticeMoveFailed', { name: file.name }));
      console.error(e);
    }
  }

  private async handleDelete(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile) || isSidecarPath(file.path)) return;
    if (this.settings.keepOrphanedSidecars) return;

    const sidecar = this.app.vault.getAbstractFileByPath(sidecarPathFor(file.path));
    if (sidecar instanceof TFile) await this.app.fileManager.trashFile(sidecar);
    this.store.forget(file.path);
    this.index.replaceFile(file.path, []);
    this.refreshReviewViews();
  }

  onunload() {
    this.markdownHost?.detach();
    this.tracker?.dispose();
    this.transcriptHost?.detach();
    this.pdfHost?.detach();
    document.body.removeClass('at-style-background');
    document.body.setCssProps({ '--at-color': '' });
  }

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<AttentionSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
