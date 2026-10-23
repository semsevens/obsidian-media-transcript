import {
  App, Component, Notice, Platform, Plugin, TAbstractFile, TFile, Workspace, WorkspaceLeaf, normalizePath, parseLinktext, setIcon,
} from 'obsidian';
import { EmbedCreator, TranscriptCards, embedRegistry } from './embeds';
import { MediaTranscriptView, VIEW_TYPE_MEDIA_TRANSCRIPT } from './MediaTranscriptView';
import { MediaTranscriptSettingTab, DEFAULT_SETTINGS } from './settings';
import type { MediaTranscriptSettings } from './settings';
import { SUBTITLE_EXTENSIONS, findSubtitleFiles, findSubtitleTracks } from './utils/subtitleFinder';
import { parseTimeFragment } from './utils/timeFragment';
import { MediaLocator, type ResolvedMedia } from './mediaLocator';
import { TranscriptIndex } from './transcriptIndex';
import { LinkMediaModal } from './linkMediaModal';
import { Modules, ModuleState } from './modules';
import type ArchiveRedirectPlugin from './modules/archive/main';
import { applyServer, normalizeServer, type Source } from './utils/server';
import { LibraryClient } from './library/client';
import { Uploader } from './library/uploader';
import { UploadIndicator } from './library/UploadStatus';
import { LibraryView, VIEW_TYPE_LIBRARY } from './library/LibraryView';
import { TranscriptSync } from './library/transcriptSync';
import { NowPlaying } from './library/NowPlaying';
import { MiniPlayer } from './library/PlayerBar';
import { MediaCache } from './library/mediaCache';
import { Playlist } from './library/playlist';
import { t } from './i18n';

// Subtitle extensions we globally register for click-to-open. Clicking any of
// these opens the transcript view, which reverse-resolves the matching media
// (video first, else audio) and plays it. `.json` is included: this reliably
// routes every `.json` here (a non-subtitle one just shows a "no media" hint),
// which is the tradeoff for click-to-play working every time — a conditional
// per-file takeover isn't possible since registration is per-extension.
const CLICKABLE_SUBTITLE_EXTS = SUBTITLE_EXTENSIONS;

// Media extensions (mp3/mp4/…) are owned by Obsidian core, so `registerExtensions`
// throws for them. To open media in our transcript view we take them over via
// `viewRegistry.unregisterExtensions` — undocumented but stable, and used by
// directory plugins (Custom File Extensions, obsd.any). We register the same
// extensions and clean up on unload.
interface ViewRegistry {
  unregisterExtensions(exts: string[]): void;
}
function viewRegistry(app: App): ViewRegistry {
  return (app as unknown as { viewRegistry: ViewRegistry }).viewRegistry;
}

// `![[talk.m4a]]` doesn't go through the view registry at all — embeds have
// their own registry (see embeds.ts), so taking over the extension above never
// reached them. We wrap the core factory rather than replace it: the native
// player stays, we only add a "Transcript" button.

export default class MediaTranscriptPlugin extends Plugin {
  settings!: MediaTranscriptSettings;
  modules!: Modules;
  library!: LibraryClient;
  uploader!: Uploader;
  transcriptSync!: TranscriptSync;
  nowPlaying!: NowPlaying;
  cache!: MediaCache;
  playlist!: Playlist;
  // The modules' part of data.json, kept beside the settings above.
  private moduleState: ModuleState = { modules: {}, enabledModules: {} };
  // Uploads an earlier version queued in data.json; this device takes them over.
  private legacyPending: string[] = [];
  mediaLocator!: MediaLocator;
  transcripts!: TranscriptIndex;
  private cards!: TranscriptCards;
  // Core embed factories we wrapped, by extension, to put back on unload.
  private wrappedEmbeds = new Map<string, { original: EmbedCreator; wrapper: EmbedCreator }>();

  async onload() {
    await this.loadSettings();
    this.modules = new Modules(this, this.moduleState, () => this.saveSettings());
    this.library = new LibraryClient(() => this.settings.serverUrl, () => this.settings.serverVault || this.app.vault.getName());
    this.uploader = new Uploader(this);
    this.uploader.adopt(this.legacyPending);
    this.uploader.start();
    new UploadIndicator(this);
    this.transcriptSync = new TranscriptSync(this);
    this.transcriptSync.start();
    this.cache = new MediaCache(() => this.settings.serverUrl);
    this.register(() => this.cache.close());
    this.playlist = new Playlist(this);
    this.nowPlaying = new NowPlaying(this);
    new MiniPlayer(this, this.nowPlaying);
    this.registerView(VIEW_TYPE_LIBRARY, leaf => new LibraryView(leaf, this));
    this.addRibbonIcon('library', t('core.ribbonLibrary'), () => { void this.openLibrary(); });
    this.addCommand({
      id: 'open-media-library',
      name: t('core.cmdOpenLibrary'),
      callback: () => { void this.openLibrary(); },
    });
    this.addCommand({
      id: 'upload-current-media',
      name: t('core.cmdUploadCurrent'),
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || !this.isMedia(file) || !this.library.configured) return false;
        if (!checking) void this.uploadNow(file);
        return true;
      },
    });
    this.transcripts = new TranscriptIndex(this);
    this.mediaLocator = new MediaLocator(this.app, () => this.settings, f => this.transcripts.sourceOf(f), names => this.cachedMedia(names));
    this.app.workspace.onLayoutReady(() => {
      this.transcripts.start();
      this.mediaLocator.warm();
      // Let go what has waited too long, and go on with downloads broken off.
      window.setTimeout(() => {
        void this.cache.trim().then(() => this.cache.resume());
      }, 10000);
    });
    this.registerEvent(this.app.vault.on('rename', (f, oldPath) => { void this.followRename(f, oldPath); }));

    this.registerView(
      VIEW_TYPE_MEDIA_TRANSCRIPT,
      leaf => new MediaTranscriptView(leaf, this),
    );

    // Media extensions, plus subtitle extensions (.srt / .vtt / .json) so
    // clicking a subtitle opens here and reverse-resolves its media.
    for (const ext of [...this.mediaExts(), ...CLICKABLE_SUBTITLE_EXTS]) {
      try {
        this.registerExtensions([ext], VIEW_TYPE_MEDIA_TRANSCRIPT);
      } catch {
        // Owned by core/another plugin — take it over so it opens here.
        try {
          viewRegistry(this.app).unregisterExtensions([ext]);
          this.registerExtensions([ext], VIEW_TYPE_MEDIA_TRANSCRIPT);
        } catch {
          // Give up on this one; the command / file-menu below still works.
        }
      }
    }

    // Explicit "open in this view" — fallback for any extension we couldn't
    // take (and the only entry point for .json subtitles). Works for both
    // media files and subtitle files (which resolve to their media).
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && (this.isMedia(file) || this.isSubtitle(file))) {
          menu.addItem(item =>
            item
              .setTitle(t('core.menuOpenInMediaOne'))
              .setIcon('play-circle')
              .onClick(() => { void this.openInView(file); }),
          );
        }
        if (file instanceof TFile && this.isMedia(file) && this.library.configured) {
          menu.addItem(item =>
            item
              .setTitle(t('core.menuUploadToServer'))
              .setIcon('upload-cloud')
              .onClick(() => { void this.uploadNow(file); }),
          );
        }
      }),
    );

    this.addCommand({
      id: 'open-current-media-file',
      name: t('core.cmdOpenCurrentMedia'),
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || (!this.isMedia(file) && !this.isSubtitle(file))) {
          return false;
        }
        if (!checking) void this.openInView(file);
        return true;
      },
    });

    // Focus the transcript search box (bind a hotkey to it if you like).
    this.addCommand({
      id: 'search-transcript',
      name: t('core.cmdSearchTranscript'),
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(MediaTranscriptView);
        if (!view) return false;
        if (!checking) view.focusSearch();
        return true;
      },
    });

    // Paste a link to the playing moment into the note you're writing:
    // `[[talk.m4a#t=83|1:23]]`. Clicking it later jumps back there.
    this.addCommand({
      id: 'insert-timestamp-link',
      name: t('core.cmdInsertTimestampLink'),
      editorCheckCallback: (checking, editor, ctx) => {
        const view = this.transcriptViews().find(v => v.getCurrentTime() !== null);
        if (!view) return false;
        if (!checking) {
          editor.replaceSelection(view.timestampLink(view.getCurrentTime() ?? 0, ctx.file?.path ?? ''));
        }
        return true;
      },
    });

    // When a transcript can't find its media — renamed outside Obsidian, or
    // a format with no room to say — point it at the right file by hand.
    this.addCommand({
      id: 'link-transcript-media',
      name: t('core.cmdLinkTranscriptMedia'),
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || !this.isSubtitle(file)) return false;
        if (!checking) void this.linkMedia(file);
        return true;
      },
    });

    this.wrapMediaEmbeds();
    this.cards = new TranscriptCards(this);
    this.app.workspace.onLayoutReady(() => {
      this.cards.start();
      // Embeds of moved-out media whose transcript was renamed can only be
      // matched once the transcripts have been read.
      this.transcripts.onChange(() => this.cards.refresh());
    });
    this.routeMediaLinks();

    this.addSettingTab(new MediaTranscriptSettingTab(this.app, this));

    await this.modules.start();
  }

  /**
   * Open `file`'s transcript beside the current note, never in place of it —
   * the note is what you're working on, the recording is the source.
   * Reuses a transcript pane that already shows this media (else any open
   * transcript pane) so repeated clicks don't pile up splits.
   */
  async openTranscript(file: TFile, seconds: number | null = null, play = true) {
    const ws = this.app.workspace;
    const leaves = ws.getLeavesOfType(VIEW_TYPE_MEDIA_TRANSCRIPT);
    let leaf = leaves.find(
      l => l.view instanceof MediaTranscriptView &&
        (l.view.file === file || l.view.getMediaFile() === file),
    );
    if (!leaf && Platform.isMobile) {
      // In place of the page shown, as a link would: back returns to it.
      leaf = ws.getLeaf(false);
      await leaf.openFile(file);
      if (!(leaf.view instanceof MediaTranscriptView)) await leaf.setViewState({ type: VIEW_TYPE_MEDIA_TRANSCRIPT, state: { file: file.path } });
    } else if (!leaf) {
      leaf = leaves[0] ?? ws.getLeaf('split', 'vertical');
      await leaf.setViewState({ type: VIEW_TYPE_MEDIA_TRANSCRIPT, state: { file: file.path } });
    }
    ws.setActiveLeaf(leaf, { focus: true });
    if (seconds !== null && leaf.view instanceof MediaTranscriptView) {
      leaf.view.seekTo(seconds, play);
    }
  }

  /** Ask which media `transcript` belongs to, record it, and reopen it. */
  async linkMedia(transcript: TFile) {
    const choices = await this.mediaLocator.listAll();
    if (choices.length === 0) {
      new Notice(t('core.noMediaAnywhere'));
      return;
    }
    choices.sort((a, b) => a.name.localeCompare(b.name));
    new LinkMediaModal(this.app, choices, choice => {
      void (async () => {
        await this.transcripts.setSource(transcript, choice.name);
        for (const view of this.transcriptViews()) {
          if (view.file === transcript) await view.reload();
        }
      })();
    }).open();
  }

  /**
   * A media file renamed in Obsidian takes its transcripts along: they're
   * renamed to match (Obsidian updates links to them), and a transcript that
   * names the media as its source is told the new name. Without this, the
   * pair would only be held together by the name until the media moves out.
   * A move that keeps the name needs nothing — lookups are by name.
   */
  private async followRename(file: TAbstractFile, oldPath: string) {
    if (!(file instanceof TFile)) return;
    if (this.isSubtitle(file)) {
      await this.transcripts.moveLink(oldPath, file.path);
      return;
    }
    if (!this.isMedia(file)) return;
    const oldName = oldPath.slice(oldPath.lastIndexOf('/') + 1);
    if (oldName === file.name) return;
    const oldDir = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
    await this.renameTranscripts(oldName, file.name, oldDir);
  }

  /**
   * Point the transcripts of media `oldName` at `newName`: a transcript that
   * names its source is told the new name, and one named after the media is
   * renamed to match (in its own folder; Obsidian updates links to it).
   * `dir` is where the media was, for transcripts found by name beside it.
   */
  async renameTranscripts(oldName: string, newName: string, dir: string) {
    const oldBase = oldName.replace(/\.[^.]+$/, '');
    const newBase = newName.replace(/\.[^.]+$/, '');
    const tracks = await this.transcriptFilesFor(oldName, dir);

    let renamed = 0;
    const blocked: string[] = [];
    for (const tr of tracks) {
      if ((await this.transcripts.sourceOf(tr))?.toLowerCase() === oldName.toLowerCase()) {
        await this.transcripts.setSource(tr, newName);
      }
      if (!tr.name.startsWith(oldBase + '.')) continue; // named its own way: leave the name
      const target = normalizePath(`${tr.parent?.path ?? ''}/${newBase}${tr.name.slice(oldBase.length)}`);
      if (this.app.vault.getAbstractFileByPath(target)) {
        blocked.push(tr.name);
        continue;
      }
      await this.app.fileManager.renameFile(tr, target);
      renamed++;
    }
    // Beside them, what is named after the media but doesn't say so inside (a .txt transcript): renamed along.
    const media = new Set([...this.settings.supportedAudioExtensions, ...this.settings.supportedVideoExtensions]);
    const folders = new Set([...tracks].map(tr => tr.parent));
    for (const folder of folders) {
      for (const f of [...(folder?.children ?? [])]) {
        if (!(f instanceof TFile) || !f.name.startsWith(oldBase + '.') || media.has(f.extension.toLowerCase())) continue;
        if (f.name.endsWith('.anno.json')) continue;  // the annotations' own, moved with what they mark
        const target = normalizePath(`${folder?.path ?? ''}/${newBase}${f.name.slice(oldBase.length)}`);
        if (this.app.vault.getAbstractFileByPath(target)) continue;
        await this.app.fileManager.renameFile(f, target);
        renamed++;
      }
    }
    if (renamed > 0) {
      new Notice(t(renamed > 1 ? 'core.renamedTranscriptsMany' : 'core.renamedTranscriptsOne', { n: renamed, name: newName }));
    }
    if (blocked.length > 0) {
      new Notice(t('core.keptTranscripts', { names: blocked.join(', ') }));
    }
  }

  /** The transcripts of media `name`: those that name it as their source, and those named after it beside `dir`. */
  private async transcriptFilesFor(name: string, dir: string): Promise<Set<TFile>> {
    await this.transcripts.whenReady();
    const tracks = new Set<TFile>(this.transcripts.transcriptsFor(name));
    const searchDir = this.settings.subtitleDirectory.trim() || dir;
    for (const track of findSubtitleTracks(name.replace(/\.[^.]+$/, ''), searchDir, this.app.vault)) tracks.add(track.file);
    return tracks;
  }

  /**
   * Move the transcripts of deleted media `name` to Obsidian's trash. One found
   * only by its name is kept when `stillThere` (another file of that name, say
   * the video beside the audio, which shares it) says so. Returns how many went.
   */
  async trashTranscripts(name: string, dir: string, stillThere: (base: string) => boolean): Promise<number> {
    const base = name.replace(/\.[^.]+$/, '');
    const keepByName = stillThere(base);
    let trashed = 0;
    for (const tr of await this.transcriptFilesFor(name, dir)) {
      const ownSource = (await this.transcripts.sourceOf(tr))?.toLowerCase() === name.toLowerCase();
      if (!ownSource && keepByName) continue;
      await this.app.fileManager.trashFile(tr);
      trashed++;
    }
    return trashed;
  }

  private hasSubtitles(file: TFile): boolean {
    return findSubtitleFiles(file, this.app.vault, this.settings).length > 0 ||
      this.transcripts.transcriptsFor(file.name).length > 0;
  }

  private transcriptViews(): MediaTranscriptView[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE_MEDIA_TRANSCRIPT)
      .map(l => l.view)
      .filter((v): v is MediaTranscriptView => v instanceof MediaTranscriptView);
  }

  private wrapMediaEmbeds() {
    const registry = embedRegistry(this.app);
    if (!registry?.embedByExtension) return;

    for (const ext of this.mediaExts()) {
      const original = registry.embedByExtension[ext];
      if (!original) continue;
      const wrapper: EmbedCreator = (ctx, file, subpath) => {
        const component = original(ctx, file, subpath);
        // The core component fills containerEl when it loads the file, and
        // may clear it first — so decorate after that too, not only now.
        const c = component as Component & { loadFile?: () => Promise<unknown> };
        const loadFile = c.loadFile?.bind(c);
        if (loadFile) {
          c.loadFile = async () => {
            const r = await loadFile();
            this.decorateEmbed(ctx.containerEl, file);
            return r;
          };
        }
        this.decorateEmbed(ctx.containerEl, file);
        return component;
      };
      // Through the registry's own API, not by assigning into the map —
      // assignment alone doesn't reach embeds (the same swap pdf-plus does).
      registry.unregisterExtension(ext);
      registry.registerExtension(ext, wrapper);
      this.wrappedEmbeds.set(ext, { original, wrapper });
    }
  }

  private unwrapMediaEmbeds() {
    const registry = embedRegistry(this.app);
    for (const [ext, { original, wrapper }] of this.wrappedEmbeds) {
      // Only undo our own wrap — if someone wrapped on top, leave theirs alone.
      if (registry?.embedByExtension[ext] === wrapper) {
        registry.unregisterExtension(ext);
        registry.registerExtension(ext, original);
      }
    }
    this.wrappedEmbeds.clear();
  }

  // Only when a transcript exists: an embed with nothing to show stays native.
  private decorateEmbed(containerEl: HTMLElement, file: TFile) {
    if (!containerEl || containerEl.querySelector(':scope > .mt-embed-btn')) return;
    if (!this.hasSubtitles(file)) return;

    containerEl.addClass('mt-embed');
    const btn = containerEl.createEl('button', {
      cls: 'mt-embed-btn',
      attr: { 'aria-label': t('core.openTranscriptBeside') },
    });
    setIcon(btn.createSpan('mt-embed-btn-icon'), 'captions');
    btn.createSpan({ text: t('core.transcriptButton') });

    // Live Preview treats a press inside an embed as "edit the source".
    btn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      // Hand over to the transcript where the inline player was, so two
      // players never talk over each other.
      const media = containerEl.querySelector('audio, video');
      let at: number | null = null;
      let playing = false;
      if (media instanceof HTMLMediaElement) {
        playing = !media.paused;
        if (media.currentTime > 0) at = media.currentTime;
        media.pause();
      }
      void this.openTranscript(file, at, playing);
    });
  }

  /**
   * Plain clicks on `[[talk.m4a]]` / `[[talk.m4a#t=83]]` in a note open the
   * transcript beside the note (and seek), instead of replacing the note.
   * Subtitle links too — they're what a timestamp link points at once the
   * media has moved out of the vault.
   * Modifier clicks (new tab / split / window) keep Obsidian's behaviour; the
   * view still honours `#t=` there via setEphemeralState.
   */
  private routeMediaLinks() {
    const ws = this.app.workspace;
    // Usually inherited from the prototype; unwrapping then means deleting our
    // own property, so the workspace ends up exactly as it was.
    const saved = Object.getOwnPropertyDescriptor(ws, 'openLinkText');
    const original = ws.openLinkText.bind(ws);
    let active = true;
    const wrapper: typeof ws.openLinkText = async (linktext, sourcePath, newLeaf, openViewState) => {
      if (active && !newLeaf) {
        const { path, subpath } = parseLinktext(linktext);
        const file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
        if (file && ((this.isMedia(file) && this.hasSubtitles(file)) || this.isSubtitle(file))) {
          await this.openTranscript(file, parseTimeFragment(subpath));
          return;
        }
        // Media that has left the vault: its transcript is what's still here.
        // Falling through would have Obsidian offer to create the missing file.
        const transcript = !file && this.cards.isMediaName(path) ? this.cards.transcriptFor(path) : null;
        if (transcript) {
          await this.openTranscript(transcript, parseTimeFragment(subpath));
          return;
        }
      }
      return original(linktext, sourcePath, newLeaf, openViewState);
    };
    ws.openLinkText = wrapper;
    this.register(() => {
      active = false;
      if (ws.openLinkText !== wrapper) return;
      if (saved) Object.defineProperty(ws, 'openLinkText', saved);
      else delete (ws as Partial<Workspace>).openLinkText;
    });
  }

  onunload() {
    this.unwrapMediaEmbeds();
    this.cards?.stop();
    this.transcripts?.stop();
    // Release the extensions we took over (they stay registered otherwise).
    try {
      viewRegistry(this.app).unregisterExtensions([
        ...this.mediaExts(),
        ...CLICKABLE_SUBTITLE_EXTS,
      ]);
    } catch {
      // ignore
    }
  }

  /** Push the current transcript font size into every open transcript view. */
  applyFontSizeToOpenViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MEDIA_TRANSCRIPT)) {
      if (leaf.view instanceof MediaTranscriptView) {
        leaf.view.applyFontSize(this.settings.transcriptFontSize);
      }
    }
  }

  mediaExts(): string[] {
    return [
      ...this.settings.supportedVideoExtensions,
      ...this.settings.supportedAudioExtensions,
    ];
  }

  isMedia(file: TFile): boolean {
    const ext = file.extension.toLowerCase();
    return this.mediaExts().includes(ext);
  }

  private isSubtitle(file: TFile): boolean {
    return SUBTITLE_EXTENSIONS.includes(file.extension.toLowerCase());
  }

  private async openInView(file: TFile) {
    const leaf = this.app.workspace.getLeaf(false);
    await this.swapLeafToView(leaf, file);
  }

  // Point an existing leaf at our transcript view for the given file.
  private async swapLeafToView(leaf: WorkspaceLeaf, file: TFile) {
    await leaf.setViewState({
      type: VIEW_TYPE_MEDIA_TRANSCRIPT,
      state: { file: file.path },
      active: true,
    });
  }

  /** Media of one of these names kept on this device (see MediaCache), to play offline. */
  async cachedMedia(names: string[]): Promise<ResolvedMedia | null> {
    const path = this.cache.findByName(names);
    const src = path ? await this.cache.url(path) : null;
    if (!path || !src) return null;
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return { src, basename: name.slice(0, dot), extension: name.slice(dot + 1).toLowerCase(), file: null, location: this.library.libraryUrl(path) };
  }

  async openLibrary() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_TYPE_LIBRARY)[0];
    if (!leaf) {
      leaf = ws.getRightLeaf(false) ?? ws.getLeaf('split', 'vertical');
      await leaf.setViewState({ type: VIEW_TYPE_LIBRARY, active: true });
    }
    await ws.revealLeaf(leaf);
  }

  async uploadNow(file: TFile) {
    const outcome = await this.uploader.uploadOne(file.path);
    if (outcome === 'retry') new Notice(t('core.uploadUnreachable', { name: file.name }));
    else new Notice(t('core.uploadDone', { name: file.name }));
  }

  /** Point Media One at a server (or at none, with ''), replacing the previous one everywhere. */
  async setServer(url: string) {
    const next = normalizeServer(url);
    const previous = this.settings.serverUrl;
    const archive = this.modules.settingsOf('archive');
    // The archive's queue is kept on this device (see ArchiveServers).
    const servers = (this.modules.loaded.get('archive') as ArchiveRedirectPlugin | undefined)?.servers;
    const result = applyServer({
      mediaUrls: this.settings.mediaUrls,
      sources: (archive.settings?.sources as Source[] | undefined) ?? null,
      pendingUploads: servers?.queued() ?? null,
    }, previous, next);
    this.settings.mediaUrls = result.mediaUrls;
    this.settings.serverUrl = next;
    if (archive.settings && result.sources) {
      archive.settings.sources = result.sources;
      await archive.save();
    }
    if (servers && result.pendingUploads) servers.replaceQueue(result.pendingUploads);
    await this.saveSettings();
    this.mediaLocator.invalidate();
  }

  async loadSettings() {
    // loadData() is typed `any`; narrow it so the merge stays type-checked.
    const saved = (await this.loadData()) as (Partial<MediaTranscriptSettings> & Partial<ModuleState>) | null;
    // Earlier versions kept this device's queue and progress in data.json, shared by Sync.
    const { modules, enabledModules, pendingUploads, transcriptSyncSince: _t, ...settings } =
      (saved ?? {}) as Partial<MediaTranscriptSettings> & Partial<ModuleState> & { pendingUploads?: string[]; transcriptSyncSince?: number };
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
    this.moduleState.modules = modules ?? {};
    this.moduleState.enabledModules = enabledModules ?? {};
    this.legacyPending = pendingUploads ?? [];
  }

  /** data.json changed on disk (synced from another device): the playlist with it. */
  async onExternalSettingsChange() {
    const saved = (await this.loadData()) as Partial<MediaTranscriptSettings> | null;
    if (saved?.playlist) {
      this.settings.playlist = saved.playlist;
      this.playlist?.reloaded();
    }
  }

  async saveSettings() {
    await this.saveData({ ...this.settings, ...this.moduleState });
  }
}
