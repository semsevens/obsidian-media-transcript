import { FileView, WorkspaceLeaf, TFile, Notice, Menu, Platform, setIcon } from 'obsidian';
import type MediaTranscriptPlugin from './main';
import {
  findSubtitleTracks,
  resolvePriority,
  FoundSubtitleFile,
  SUBTITLE_EXTENSIONS,
} from './utils/subtitleFinder';
import { subtitleBaseName } from './utils/mediaMatch';
import { trackMarker } from './utils/transcriptSource';
import type { ResolvedMedia } from './mediaLocator';
import type { VideoLayout } from './settings';
import { pickArrangement, SIDE_MIN_WIDTH_PORTRAIT, type Arrangement } from './ui/videoLayout';
import { parseSubtitle, SubtitleSegment, formatTime } from './utils/subtitleParser';
import { parseTimeFragment, timeFragment } from './utils/timeFragment';
import { t, type TextKey } from './i18n';
import { renderBar, renderCover } from './library/PlayerBar';
import { iconButton, renderControls } from './ui/controls';
import { whereFrom } from './ui/whereFrom';

// Transcript text size bounds (px). Defined here rather than in settings.ts to
// keep the import direction one-way: settings.ts → this file.
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 32;

// After scrolling by hand, leave auto-scroll off this long so reading ahead
// isn't yanked back to the playing line on the next segment change.
const MANUAL_SCROLL_GRACE_MS = 4000;

export const VIEW_TYPE_MEDIA_TRANSCRIPT = 'media-transcript-view';

/** Extract a readable message from an unknown thrown value. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const CLEAR_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export class MediaTranscriptView extends FileView {
  plugin: MediaTranscriptPlugin;

  private mediaEl: HTMLVideoElement | HTMLAudioElement | null = null;
  private transcriptEl: HTMLElement | null = null;
  private segmentEls: HTMLElement[] = [];
  private segments: SubtitleSegment[] = [];
  private activeIndex = -1;
  private subtitleTracks: FoundSubtitleFile[] = [];
  // The track shown, and the chip in the toolbar that names it (a menu of the others).
  private track: FoundSubtitleFile | null = null;
  private trackChip: HTMLElement | null = null;
  private controls: { destroy: () => void } | null = null;
  private searchBarEl: HTMLElement | null = null;
  // The media being played: `this.file` itself, or — when a subtitle was
  // opened — whatever MediaLocator found for it, possibly outside the vault.
  // Null means reading-only: the transcript without a player.
  private media: ResolvedMedia | null = null;
  // Where the subtitle tracks live and the base name they share.
  private trackBase = '';
  private trackDir = '';
  // Where we looked for media, shown when none was found.
  private searched: string[] = [];
  // When opened via a subtitle file, the track to auto-select instead of the
  // priority-sorted default (null otherwise).
  private preferredTrackPath: string | null = null;
  // Timestamp (ms) until which auto-scroll stays out of the way because the
  // user scrolled the transcript by hand.
  private manualScrollUntil = 0;
  // True when the media being played is a video file. Independent of whether
  // we're currently showing the picture (see settings.videoAudioOnly).
  private isVideo = false;
  // The transcript column, kept across player rebuilds so switching between
  // video and audio-only doesn't re-parse or re-render the subtitle.
  private transcriptSideEl: HTMLElement | null = null;

  // ── Search state ──────────────────────────────────────────────────────────
  private txtEls: HTMLElement[] = [];        // the .mt-txt of each segment
  private searchInput: HTMLInputElement | null = null;
  private searchCountEl: HTMLElement | null = null;
  private hitEls: HTMLElement[] = [];        // every highlighted occurrence, in order
  private hitIndex = -1;                     // which occurrence is the current one
  private highlightedSegs: number[] = [];    // segments whose text we rewrote
  // A seek asked for before the player exists (a `#t=` link can arrive while
  // the file is still loading); applied as soon as the media element is built.
  private pendingSeek: { time: number; play: boolean } | null = null;
  // Following the library's player (it plays this media): `mediaEl` is its
  // audio, which this view reads along with and steers but never stops.
  private followed: { el: HTMLAudioElement; bar: { remove: () => void } | null; tick: () => void; time: number } | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: MediaTranscriptPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  onload() {
    super.onload();
    // The library's player starting (or stopping, or moving on from) this media: follow it, or play it here again.
    this.register(this.plugin.nowPlaying.subscribe(() => {
      if (!this.media || !this.transcriptSideEl) return;
      const el = this.plugin.nowPlaying.elementFor(this.media, this.file);
      if (el !== (this.followed?.el ?? null)) void this.rebuildPlayer();
    }));
    // A video followed while out of sight: in sight now, it is shown.
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      if (this.followed && this.showsVideo() && this.contentEl.isShown()) void this.rebuildPlayer();
    }));
    this.register(() => this.unfollow());
    // "Auto": beside or above, again whenever the pane changes shape.
    const resized = new ResizeObserver(() => {
      if (this.contentEl.querySelector('.mt-root.is-auto')) this.applyVideoLayout();
    });
    resized.observe(this.contentEl);
    this.register(() => resized.disconnect());
  }

  private showsVideo(): boolean {
    return this.isVideo && !this.plugin.settings.videoAudioOnly;
  }

  /**
   * A video the library's player plays (its sound only): this view takes it
   * over, to be seen, from where it is and playing if it was.
   */
  private takeOver(el: HTMLAudioElement) {
    const np = this.plugin.nowPlaying;
    const starting = el.readyState === 0;
    const go = () => {
      if (np.elementFor(this.media, this.file) !== el) return;
      const time = el.currentTime;
      const play = starting || !el.paused;
      const rate = el.playbackRate;
      np.stop();
      if (this.mediaEl) this.mediaEl.playbackRate = rate;
      this.seekTo(time, play);
    };
    // Just started: where it was left last time is set once it has loaded.
    if (starting) el.addEventListener('loadedmetadata', () => window.setTimeout(go, 0), { once: true });
    else go();
  }

  /** Stop reading along with the library's player, leaving it playing. */
  private unfollow() {
    const f = this.followed;
    if (!f) return;
    f.el.removeEventListener('timeupdate', f.tick);
    f.bar?.remove();
    this.followed = null;
    if (this.mediaEl === f.el) this.mediaEl = null;
  }

  /** Read along with the library's player: its bar here (a phone has it floating already), and its time for the highlight. */
  private follow(container: HTMLElement, el: HTMLAudioElement) {
    this.contentEl.addClass('mt-audio-mode');
    const bar = Platform.isMobile ? null : renderBar(container, this.plugin, 'mt-follow-bar');
    const tick = () => {
      if (this.followed) this.followed.time = el.currentTime;
      this.syncHighlight();
    };
    el.addEventListener('timeupdate', tick);
    this.followed = { el, bar, tick, time: el.currentTime };
    this.mediaEl = el;
    // Where it is now, shown at once (the line may be the one shown before, still far off screen).
    this.segmentEls[this.activeIndex]?.removeClass('mt-active');
    this.activeIndex = -1;
    this.manualScrollUntil = 0;
    this.syncHighlight();
  }

  getViewType() { return VIEW_TYPE_MEDIA_TRANSCRIPT; }
  getDisplayText() {
    return this.media?.title ?? this.media?.basename ?? this.file?.basename ?? t('core.mediaOne');
  }

  /** The media being played (for a subtitle file opened directly, its media). */
  getMediaFile(): TFile | null { return this.media?.file ?? null; }

  /** Current playback position in seconds, or null when nothing is loaded. */
  getCurrentTime(): number | null { return this.mediaEl?.currentTime ?? null; }

  /** Jump to `seconds`, optionally starting playback; queued if not built yet. */
  seekTo(seconds: number, play = true) {
    const el = this.mediaEl;
    if (!el) {
      // Reading-only: nothing to play, so show where that moment is instead.
      if (!this.media && this.segmentEls.length > 0) {
        this.pendingSeek = null;
        this.revealTime(seconds);
      } else {
        this.pendingSeek = { time: seconds, play };
      }
      return;
    }
    this.pendingSeek = null;
    this.manualScrollUntil = 0;
    const go = () => {
      el.currentTime = seconds;
      if (play && el.paused) void el.play();
    };
    if (el.readyState > 0) go();
    else el.addEventListener('loadedmetadata', go, { once: true });
  }

  // Obsidian hands a link's subpath here, e.g. `[[talk.m4a#t=83]]` → '#t=83'.
  setEphemeralState(state: unknown) {
    const subpath = (state as { subpath?: unknown } | null)?.subpath;
    const at = parseTimeFragment(typeof subpath === 'string' ? subpath : null);
    if (at !== null) this.seekTo(at);
  }

  /**
   * A link to this media at `seconds`, in the vault's link format, labelled
   * with the readable time: `[[talk.m4a#t=83|1:23]]`. `sourcePath` is the note
   * it will be pasted into (it decides how short the path can be).
   */
  timestampLink(seconds: number, sourcePath = ''): string {
    // Media outside the vault can't be linked to, so link the transcript —
    // opening it with `#t=` seeks just the same.
    const file = this.media?.file ?? this.file;
    if (!file) return formatTime(seconds);
    return this.app.fileManager.generateMarkdownLink(
      file, sourcePath, timeFragment(seconds), formatTime(seconds),
    );
  }

  // ─── File lifecycle ───────────────────────────────────────────────────────

  async onLoadFile(file: TFile) {
    this.contentEl.empty();
    this.contentEl.addClass('mt-view');
    // A phone's screen goes to the picture and the transcript; the controls fold into one row.
    this.contentEl.toggleClass('mt-phone', Platform.isMobile);
    this.contentEl.removeClass('mt-audio-mode');
    this.contentEl.removeClass('mt-reading-mode');
    this.preferredTrackPath = null;
    this.transcriptSideEl = null;
    this.searched = [];

    if (SUBTITLE_EXTENSIONS.includes(file.extension.toLowerCase())) {
      // Opened from a subtitle: it's the anchor. Find its media wherever it
      // lives; without any, still open the transcript for reading.
      // Asking a remote server can take a few seconds — don't sit blank.
      const looking = this.contentEl.createDiv('mt-empty');
      looking.setText(t('core.lookingForMedia'));
      const { media, searched } = await this.plugin.mediaLocator.resolveForSubtitle(file);
      if (this.file !== file) return; // switched files while we were looking
      looking.remove();
      if (!media && !(await this.parsesAsSubtitle(file))) {
        // `.json` is registered wholesale, so plenty of files land here that
        // were never subtitles. Say so rather than offer an empty transcript.
        this.media = null;
        this.contentEl.createDiv('mt-empty').setText(t('core.notASubtitle', { name: file.name }));
        return;
      }
      this.media = media;
      this.searched = searched;
      this.preferredTrackPath = file.path;
      this.trackDir = file.parent?.path ?? '';
      // Sibling tracks share the transcript's own name, which is the media's
      // only while nobody has renamed it.
      this.trackBase = media && file.name.startsWith(media.basename + '.')
        ? media.basename
        : subtitleBaseName(file.name);
    } else {
      this.media = this.plugin.mediaLocator.vaultMediaWithTwin(file);
      this.trackDir = this.plugin.settings.subtitleDirectory.trim() || (file.parent?.path ?? '');
      this.trackBase = file.basename;
    }

    this.isVideo = !!this.media && this.plugin.settings.supportedVideoExtensions.includes(
      this.media.extension,
    );

    await this.buildLayout();
  }

  /**
   * Does this file actually contain subtitles?
   *
   * `.json` is registered wholesale, so all sorts of files land here that were
   * never subtitles. The two cases need opposite advice — "add media next to
   * it" versus "this was never a subtitle" — and only the content can tell
   * them apart, since plenty of real subtitle tracks are also called .json.
   */
  private async parsesAsSubtitle(file: TFile): Promise<boolean> {
    if (file.extension.toLowerCase() !== 'json') return true;
    try {
      return parseSubtitle(await this.app.vault.read(file), 'json').length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Build the player + transcript layout for the current mode.
   *
   * Two shapes: video (big player left, transcript right, draggable divider) and
   * audio-only (slim control bar on top, transcript full-width) — the latter is
   * used both for real audio files and for videos the user chose to just listen
   * to. When `this.transcriptSideEl` already exists we move that column into the
   * new layout instead of rebuilding it, so toggling modes keeps the parsed
   * subtitle, the rendered segments and any active search intact.
   */
  private async buildLayout() {
    const media = this.media;
    const showVideo = this.showsVideo();
    const reused = this.transcriptSideEl;
    if (reused) reused.detach();

    this.unfollow();
    this.controls?.destroy();
    this.controls = null;
    this.contentEl.empty();
    this.contentEl.removeClass('mt-audio-mode');
    this.contentEl.removeClass('mt-reading-mode');
    this.mediaEl = null;

    const playing = this.plugin.nowPlaying.elementFor(media, this.file);
    // A video in sight is shown, not only heard; out of sight, followed for now.
    const takeOver = !!playing && showVideo && this.contentEl.isShown();
    let transcriptSide: HTMLElement;
    if (media && playing && !takeOver) {
      this.follow(this.contentEl.createDiv('mt-audio-bar mt-follow'), playing);
      transcriptSide = reused ?? this.contentEl.createDiv('mt-transcript-side');
      if (reused) this.contentEl.appendChild(reused);
    } else if (!media) {
      this.contentEl.addClass('mt-reading-mode');
      this.buildNoMediaBar(this.contentEl.createDiv('mt-audio-bar mt-nomedia-bar'));
      transcriptSide = reused ?? this.contentEl.createDiv('mt-transcript-side');
      if (reused) this.contentEl.appendChild(reused);
    } else if (showVideo) {
      const root = this.contentEl.createDiv('mt-root');
      const playerSide = root.createDiv('mt-player-side');
      const pct = this.plugin.settings.playerWidthPercent ?? 75;
      playerSide.setCssProps({ '--mt-player-width': `${pct}%` });
      this.buildDivider(root, playerSide);
      transcriptSide = reused ?? root.createDiv('mt-transcript-side');
      if (reused) root.appendChild(reused);
      this.buildVideoPlayer(playerSide, media);
      this.applyVideoLayout();
      if (takeOver && playing) this.takeOver(playing);
    } else {
      this.contentEl.addClass('mt-audio-mode');
      const bar = this.contentEl.createDiv('mt-audio-bar');
      this.buildAudioBar(bar, media);
      transcriptSide = reused ?? this.contentEl.createDiv('mt-transcript-side');
      if (reused) this.contentEl.appendChild(reused);
    }

    if (!reused) {
      this.transcriptSideEl = transcriptSide;
      await this.buildTranscriptPanel(transcriptSide);
    }
    if (this.pendingSeek) this.seekTo(this.pendingSeek.time, this.pendingSeek.play);
  }

  /**
   * Video ⇄ audio-only toggle: rebuild just the player, carrying playback
   * position, speed and play/pause across, and leave the transcript column
   * (including its scroll position) exactly where it was.
   */
  private async toggleAudioOnly() {
    this.plugin.settings.videoAudioOnly = !this.plugin.settings.videoAudioOnly;
    await this.plugin.saveSettings();
    await this.rebuildPlayer();
  }

  /** Re-sync this view with settings.videoAudioOnly (used by the settings tab). */
  async applyAudioOnly() {
    if (this.isVideo) await this.rebuildPlayer();
  }

  private async rebuildPlayer() {
    const old = this.mediaEl;
    // The library's player is not ours to stop; where it was, this view's own takes up (paused).
    const wasFollowing = this.followed;
    const state = wasFollowing
      ? { time: wasFollowing.time, rate: wasFollowing.el.playbackRate, playing: false }
      : old ? { time: old.currentTime, rate: old.playbackRate, playing: !old.paused } : null;
    const scrollTop = this.transcriptEl?.scrollTop ?? 0;

    if (old && !wasFollowing) {
      old.pause();
      old.removeAttribute('src'); // also disarms the audio-fallback error handler
      old.load();
    }

    await this.buildLayout();

    const next = this.mediaEl;
    if (state && next && !this.followed) {
      next.playbackRate = state.rate;
      const seek = () => { next.currentTime = state.time; };
      if (next.readyState > 0) seek();
      else next.addEventListener('loadedmetadata', seek, { once: true });
      if (state.playing) void next.play();
    }
    if (this.transcriptEl) this.transcriptEl.scrollTop = scrollTop;
  }

  /** Apply a new player-pane width (%) to this open view, if it's in video mode. */
  applyPlayerWidth(pct: number) {
    const playerSide = this.contentEl.querySelector('.mt-player-side');
    if (playerSide instanceof HTMLElement) {
      playerSide.setCssProps({ '--mt-player-width': `${pct}%` });
    }
  }

  /** Lay the open video out again: beside, above, or by the pane's width. */
  applyVideoLayout() {
    const root = this.contentEl.querySelector('.mt-root');
    if (!(root instanceof HTMLElement)) return;
    const chosen = this.plugin.settings.videoLayout ?? 'auto';
    let next: Arrangement;
    // Beside, chosen on a computer and synced, would leave a phone no room to read.
    if (chosen === 'side' && this.contentEl.clientWidth < SIDE_MIN_WIDTH_PORTRAIT) next = 'stack';
    else if (chosen !== 'auto') next = chosen;
    else {
      const video = this.mediaEl instanceof HTMLVideoElement ? this.mediaEl : null;
      const aspect = video && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
      const current = root.hasClass('is-side') ? 'side' : root.hasClass('is-stack') ? 'stack' : undefined;
      next = pickArrangement(this.contentEl.clientWidth, this.contentEl.clientHeight, aspect, current);
    }
    root.toggleClass('is-auto', chosen === 'auto');
    root.toggleClass('is-side', next === 'side');
    root.toggleClass('is-stack', next === 'stack');
  }

  /** Apply the transcript font size (px) to this open view. */
  applyFontSize(px: number) {
    this.transcriptEl?.setCssProps({ '--mt-font-size': `${px}px` });
  }

  /** Put the cursor in the transcript search box (see the command in main.ts). */
  focusSearch() {
    this.toggleSearch(true);
  }

  /** Look for the media again and rebuild (after linking it by hand, say). */
  async reload() {
    const file = this.file;
    if (!file) return;
    await this.onUnloadFile(file);
    await this.onLoadFile(file);
  }

  async onUnloadFile(_file: TFile) {
    if (this.followed) this.unfollow();
    else if (this.mediaEl) {
      this.mediaEl.pause();
      this.mediaEl.removeAttribute('src');
      this.mediaEl.load();
    }
  }

  // ─── Media player ─────────────────────────────────────────────────────────

  private buildVideoPlayer(container: HTMLElement, media: ResolvedMedia) {
    const resourcePath = media.src;
    const wrapper = container.createDiv('mt-player-wrapper');
    const video = wrapper.createEl('video', {
      cls: 'mt-media',
      // A clear poster: a phone's WebView draws its own grey play sign over a picture not yet shown.
      attr: { src: resourcePath, playsinline: '', preload: 'metadata', poster: CLEAR_PIXEL },
    });
    this.mediaEl = video;
    // The first picture shown before it plays (a phone shows none until asked to seek).
    video.addEventListener('loadedmetadata', () => {
      window.setTimeout(() => { if (video.paused && video.currentTime === 0) video.currentTime = 0.01; }, 0);
    }, { once: true });
    // Its shape known, a portrait video may fit beside the transcript after all.
    video.addEventListener('loadedmetadata', () => this.applyVideoLayout());
    video.addEventListener('click', () => { if (video.paused) void video.play().catch(() => {}); else video.pause(); });
    this.controls = renderControls(wrapper.createDiv('mt-video-controls'), video, { video });
    const head = container.createDiv('mt-video-head');
    this.buildHead(head, media.title ?? media.basename, whereFrom(media));
    this.buildOrigin(head, media);
    this.mediaEl.addEventListener('timeupdate', () => this.syncHighlight());
    this.reportLoadErrors(this.mediaEl, media);
  }

  /** An archived web video: the notes that show it, found by its address. */
  private buildOrigin(container: HTMLElement, media: ResolvedMedia) {
    const origin = media.origin;
    if (!origin) return;
    const row = container.createDiv('mt-origin');
    row.createSpan({ cls: 'mt-origin-label', text: t('core.originNotes') });
    const list = row.createSpan('mt-origin-notes');
    void (async () => {
      const notes: TFile[] = [];
      for (const f of this.app.vault.getMarkdownFiles()) {
        if ((await this.app.vault.cachedRead(f)).includes(origin)) notes.push(f);
        if (!row.isConnected) return;
      }
      if (notes.length === 0) list.setText(t('core.originNone'));
      for (const f of notes) {
        const a = list.createEl('a', { cls: 'internal-link', text: f.basename, attr: { href: f.path } });
        a.addEventListener('click', e => {
          e.preventDefault();
          void this.app.workspace.getLeaf(false).openFile(f);
        });
      }
    })();
  }

  // Media outside the vault can vanish under us — a drive unplugged, a home
  // server asleep. Say so; the transcript itself stays readable.
  private reportLoadErrors(el: HTMLMediaElement, media: ResolvedMedia) {
    if (media.file) return;
    el.addEventListener('error', () => {
      if (!el.getAttribute('src') || this.mediaEl !== el) return; // our own teardown
      new Notice(t('core.mediaLoadFailed', { location: media.location }));
    });
  }

  private buildAudioBar(container: HTMLElement, video: ResolvedMedia) {
    // A video listened to plays its audio twin when it has one: same
    // recording, a fraction of the bytes to fetch before it starts.
    const media = this.isVideo ? (video.audioTwin ?? video) : video;
    const resourcePath = media.src;
    this.buildHead(container, video.title ?? media.basename, whereFrom(video));
    const audio = container.createEl('audio', {
      cls: 'mt-media-audio',
      attr: { src: resourcePath, preload: 'metadata' },
    });
    this.mediaEl = audio;
    this.controls = renderControls(container, audio);
    audio.addEventListener('timeupdate', () => this.syncHighlight());
    this.reportLoadErrors(audio, media);

    // A video played through an <audio> element normally works (same demuxers),
    // but some containers refuse. If that happens, fall back to the video player
    // rather than leaving the user with a dead control bar.
    if (this.isVideo) {
      audio.addEventListener('error', () => {
        // Teardown clears src first, so this only fires on a real decode failure.
        if (!audio.getAttribute('src') || this.mediaEl !== audio) return;
        new Notice(t('core.audioOnlyFailed'));
        this.plugin.settings.videoAudioOnly = false;
        void this.plugin.saveSettings();
        void this.buildLayout();
      });
    }
  }

  // Reading-only header: say plainly there's nothing to play, and where we
  // looked, so a missing drive or a settings typo explains itself.
  private buildNoMediaBar(container: HTMLElement) {
    const head = container.createDiv('mt-head');
    setIcon(head.createDiv('mt-head-doc'), 'file-text');
    const names = head.createDiv('mt-head-names');
    names.createDiv({ cls: 'mt-head-title', text: this.file ? subtitleBaseName(this.file.name) : '' });
    const note = names.createDiv('mt-head-sub mt-nomedia-note');
    note.setText(t('core.noMediaReadingOnly'));
    note.setAttribute(
      'title',
      t('core.lookedIn', { places: this.searched.map(s => '• ' + s).join('\n') }),
    );
    const file = this.file;
    if (!file) return;
    const row = container.createDiv('mt-nomedia-actions');
    const link = row.createEl('button', {
      cls: 'mod-cta mt-link-media-btn',
      text: t('core.linkMediaButton'),
      attr: { 'aria-label': t('core.linkMediaAria') },
    });
    link.addEventListener('click', () => { void this.plugin.linkMedia(file); });
    // A server that didn't answer (asleep, a phone's VPN still coming back)
    // may well answer now.
    const retry = row.createEl('button', { text: t('core.retryFindMedia') });
    retry.addEventListener('click', () => {
      this.plugin.mediaLocator.invalidate();
      void this.reload();
    });
  }

  /** What plays: a cover (the colour of where it is from), its name, and where it is from. */
  private buildHead(container: HTMLElement, title: string, from: string) {
    const head = container.createDiv('mt-head');
    renderCover(head, from, 'is-small mt-head-cover');
    const names = head.createDiv('mt-head-names');
    names.createDiv({ cls: 'mt-head-title', text: title });
    names.createDiv({ cls: 'mt-head-sub', text: from });
  }

  // Draggable divider between the video player and the transcript.
  private buildDivider(root: HTMLElement, playerSide: HTMLElement) {
    const divider = root.createDiv('mt-divider');
    let dragging = false;
    let pending = -1;

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const rect = root.getBoundingClientRect();
      let pct = ((e.clientX - rect.left) / rect.width) * 100;
      pct = Math.max(20, Math.min(75, pct));
      pending = pct;
      playerSide.setCssProps({ '--mt-player-width': `${pct}%` });
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.removeClass('mt-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (pending >= 0) {
        this.plugin.settings.playerWidthPercent = Math.round(pending);
        void this.plugin.saveSettings();
      }
    };
    divider.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      dragging = true;
      document.body.addClass('mt-resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ─── Transcript panel ─────────────────────────────────────────────────────

  private async buildTranscriptPanel(container: HTMLElement) {
    // Toolbar row
    const toolbar = container.createDiv('mt-toolbar');
    this.buildToolbar(toolbar);

    // Search row
    this.searchBarEl = container.createDiv('mt-searchbar');
    this.buildSearchBar(this.searchBarEl);

    // Scrollable transcript
    this.transcriptEl = container.createDiv('mt-transcript');
    this.applyFontSize(this.plugin.settings.transcriptFontSize);

    // Hand-scrolling wins over auto-scroll for a few seconds (see syncHighlight).
    for (const ev of ['wheel', 'touchmove'] as const) {
      this.registerDomEvent(this.transcriptEl, ev, () => {
        this.manualScrollUntil = Date.now() + MANUAL_SCROLL_GRACE_MS;
      });
    }

    // Find & load subtitle files
    // Tracks named alongside, plus any that name this media as their source
    // under another name or in another folder — and always the one opened.
    const tracks = findSubtitleTracks(this.trackBase, this.trackDir, this.app.vault);
    const add = (file: TFile) => {
      if (!tracks.some(t => t.file === file)) {
        tracks.push({ file, marker: trackMarker(file.name), extension: file.extension.toLowerCase() });
      }
    };
    if (this.media) {
      for (const f of this.plugin.transcripts.transcriptsFor(`${this.media.basename}.${this.media.extension}`)) add(f);
    }
    if (this.preferredTrackPath && this.file?.path === this.preferredTrackPath) add(this.file);
    this.subtitleTracks = tracks;
    const sorted = resolvePriority(this.subtitleTracks, this.plugin.settings.priorities);

    // If we arrived here from a clicked subtitle, load that exact track;
    // otherwise fall back to the priority-sorted default.
    const preferred = this.preferredTrackPath
      ? sorted.find(t => t.file.path === this.preferredTrackPath)
      : undefined;
    const initial = preferred ?? sorted[0];

    if (initial) {
      await this.loadTrack(initial);
    } else {
      this.track = null;
      this.paintTrackChip();
      this.showEmpty();
    }
  }

  private buildToolbar(toolbar: HTMLElement) {
    // Which transcript: a chip naming it; with others, a menu of them.
    this.trackChip = toolbar.createEl('button', { cls: 'mt-track-chip', attr: { 'aria-label': t('core.subtitleLabel') } });
    this.trackChip.addEventListener('click', e => this.showTrackMenu(e));
    toolbar.createDiv('mt-toolbar-gap');
    iconButton(toolbar, 'search', t('core.cmdSearchTranscript'), 'mt-tool-search', () => this.toggleSearch());
    iconButton(toolbar, 'a-large-small', t('core.textSize'), 'mt-tool-size', e => {
      const menu = new Menu();
      menu.addItem(i => i.setTitle(t('core.fontLarger')).setIcon('plus').onClick(() => this.nudgeFontSize(+1)));
      menu.addItem(i => i.setTitle(t('core.fontSmaller')).setIcon('minus').onClick(() => this.nudgeFontSize(-1)));
      menu.addItem(i => i.setTitle(t('core.textSizeNow', { px: this.plugin.settings.transcriptFontSize })).setDisabled(true));
      menu.showAtMouseEvent(e);
    });
    iconButton(toolbar, 'more-horizontal', t('core.moreActions'), 'mt-tool-more', e => {
      const menu = new Menu();
      this.fillMoreMenu(menu);
      menu.showAtMouseEvent(e);
    });
  }

  private showTrackMenu(e: MouseEvent) {
    if (this.subtitleTracks.length < 2) return;
    const menu = new Menu();
    for (const track of resolvePriority(this.subtitleTracks, this.plugin.settings.priorities)) {
      menu.addItem(i => i.setTitle(trackLabel(track)).setChecked(track.file === this.track?.file)
        .onClick(() => { void this.loadTrack(track); }));
    }
    menu.showAtMouseEvent(e);
  }

  private paintTrackChip() {
    const chip = this.trackChip;
    if (!chip) return;
    chip.empty();
    setIcon(chip.createSpan('mt-track-chip-icon'), 'captions');
    chip.createSpan({ cls: 'mt-track-chip-label', text: this.track ? trackLabel(this.track) : t('core.noSubtitlesOption') });
    if (this.subtitleTracks.length > 1) setIcon(chip.createSpan('mt-track-chip-more'), 'chevron-down');
    chip.toggleClass('is-single', this.subtitleTracks.length < 2);
  }

  /** The rest: audio only, a link to this moment, following what is said, export. */
  private fillMoreMenu(menu: Menu) {
    if (this.isVideo) {
      const audioOnly = this.plugin.settings.videoAudioOnly;
      menu.addItem(i => i.setTitle(audioOnly ? t('core.showVideo') : t('core.listenOnly')).setIcon(audioOnly ? 'film' : 'headphones')
        .onClick(() => { void this.toggleAudioOnly(); }));
      if (!audioOnly) {
        const layouts: Array<[VideoLayout, TextKey, string]> = [
          ['auto', 'core.videoLayoutAuto', 'layout-template'],
          ['side', 'core.videoLayoutSide', 'columns-2'],
          ['stack', 'core.videoLayoutStack', 'rows-2'],
        ];
        menu.addSeparator();
        for (const [layout, label, icon] of layouts) {
          menu.addItem(i => i.setTitle(t(label)).setIcon(icon).setChecked((this.plugin.settings.videoLayout ?? 'auto') === layout)
            .onClick(() => {
              this.plugin.settings.videoLayout = layout;
              void this.plugin.saveSettings();
              this.applyVideoLayout();
            }));
        }
      }
      menu.addSeparator();
    }
    const el = this.mediaEl;
    if (el) {
      menu.addItem(i => i.setTitle(t('core.copyLinkHere')).setIcon('link').onClick(() => {
        void navigator.clipboard.writeText(this.timestampLink(el.currentTime));
        new Notice(t('core.copied'));
      }));
    }
    menu.addItem(i => i.setTitle(t('core.autoScroll')).setIcon('arrow-down-to-line').setChecked(this.plugin.settings.autoScroll)
      .onClick(() => {
        this.plugin.settings.autoScroll = !this.plugin.settings.autoScroll;
        void this.plugin.saveSettings();
        if (this.plugin.settings.autoScroll) this.scrollActiveIntoCenter(true);
      }));
    menu.addSeparator();
    menu.addItem(i => i.setTitle(t('core.exportMd')).setIcon('download').onClick(() => { void this.exportAsMarkdown(); }));
  }

  private toggleSearch(open = !this.searchBarEl?.hasClass('is-open')) {
    const bar = this.searchBarEl;
    if (!bar) return;
    bar.toggleClass('is-open', open);
    this.contentEl.querySelector('.mt-tool-search')?.toggleClass('is-active', open);
    if (open) {
      this.searchInput?.focus();
      this.searchInput?.select();
    } else if (this.searchInput) {
      this.searchInput.value = '';
      this.applySearch('');
    }
  }

  /** Step the transcript font size by `delta` px, clamped, then persist + apply. */
  private nudgeFontSize(delta: number) {
    const next = Math.max(
      MIN_FONT_SIZE,
      Math.min(MAX_FONT_SIZE, this.plugin.settings.transcriptFontSize + delta),
    );
    if (next === this.plugin.settings.transcriptFontSize) return;
    this.plugin.settings.transcriptFontSize = next;
    void this.plugin.saveSettings();
    this.plugin.applyFontSizeToOpenViews();
    // Keep the playing line where it was after the reflow.
    if (this.activeIndex >= 0) this.scrollActiveIntoCenter(false);
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  private buildSearchBar(bar: HTMLElement) {
    const input = bar.createEl('input', {
      cls: 'mt-search-input',
      attr: { type: 'search', placeholder: t('core.searchPlaceholder'), spellcheck: 'false' },
    });
    this.searchInput = input;
    this.searchCountEl = bar.createSpan('mt-search-count');

    const prev = iconButton(bar, 'chevron-up', t('core.prevMatch'), 'mt-btn-hit');
    const next = iconButton(bar, 'chevron-down', t('core.nextMatch'), 'mt-btn-hit');
    iconButton(bar, 'x', t('core.closeSearch'), 'mt-search-close', () => this.toggleSearch(false));
    prev.addEventListener('click', () => this.stepHit(-1));
    next.addEventListener('click', () => this.stepHit(+1));

    input.addEventListener('input', () => this.applySearch(input.value));
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.stepHit(e.shiftKey ? -1 : +1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.toggleSearch(false);
      }
    });

    this.updateSearchCount();
  }

  /**
   * Highlight every occurrence of `query` in the transcript and jump to the
   * first one at or after the line currently playing. Case-insensitive plain
   * substring match — no word boundaries, so it works for CJK too.
   */
  private applySearch(query: string) {
    const q = query.trim();
    this.clearHighlights();
    this.hitEls = [];
    this.hitIndex = -1;

    if (q.length === 0) {
      this.updateSearchCount();
      return;
    }

    const needle = q.toLowerCase();
    for (let i = 0; i < this.segments.length; i++) {
      const text = this.segments[i].text;
      if (!text.toLowerCase().includes(needle)) continue;
      const txtEl = this.txtEls[i];
      if (!txtEl) continue;

      // Rebuild the line as alternating plain text / <span class="mt-hit"> runs.
      txtEl.empty();
      const lower = text.toLowerCase();
      let from = 0;
      for (;;) {
        const at = lower.indexOf(needle, from);
        if (at < 0) break;
        if (at > from) txtEl.appendText(text.slice(from, at));
        const hit = txtEl.createSpan('mt-hit');
        hit.setText(text.slice(at, at + needle.length));
        this.hitEls.push(hit);
        from = at + needle.length;
      }
      if (from < text.length) txtEl.appendText(text.slice(from));
      this.highlightedSegs.push(i);
    }

    // Start from what's playing rather than from the top of the file.
    if (this.hitEls.length > 0) {
      const fromSeg = Math.max(0, this.activeIndex);
      let start = this.highlightedSegs.findIndex(i => i >= fromSeg);
      if (start < 0) start = 0;
      const firstSeg = this.highlightedSegs[start];
      const hitAt = this.hitEls.findIndex(h => h.closest('.mt-segment') === this.segmentEls[firstSeg]);
      this.gotoHit(hitAt < 0 ? 0 : hitAt);
    } else {
      this.updateSearchCount();
    }

    this.notifyTranscriptRendered();
  }

  /** Undo the text rewriting done by applySearch(). */
  private clearHighlights() {
    for (const i of this.highlightedSegs) {
      const txtEl = this.txtEls[i];
      if (txtEl) {
        txtEl.empty();
        txtEl.setText(this.segments[i].text);
      }
    }
    this.highlightedSegs = [];
  }

  private stepHit(delta: number) {
    if (this.hitEls.length === 0) return;
    const n = this.hitEls.length;
    this.gotoHit(((this.hitIndex + delta) % n + n) % n);
  }

  /** Make occurrence `idx` the current one: mark it and scroll it to the middle. */
  private gotoHit(idx: number) {
    this.hitEls[this.hitIndex]?.removeClass('mt-hit-current');
    this.hitIndex = idx;
    const hit = this.hitEls[idx];
    if (hit) {
      hit.addClass('mt-hit-current');
      // Browsing results counts as reading ahead: don't let playback yank us away.
      this.manualScrollUntil = Date.now() + MANUAL_SCROLL_GRACE_MS;
      const seg = hit.closest('.mt-segment');
      if (seg instanceof HTMLElement) this.scrollElIntoCenter(seg, true);
    }
    this.updateSearchCount();
  }

  private updateSearchCount() {
    const el = this.searchCountEl;
    if (!el) return;
    const q = this.searchInput?.value.trim() ?? '';
    if (q.length === 0) el.setText('');
    else if (this.hitEls.length === 0) el.setText('0');
    else el.setText(`${this.hitIndex + 1}/${this.hitEls.length}`);
    el.toggleClass('mt-search-none', q.length > 0 && this.hitEls.length === 0);
  }

  // ─── Track loading ────────────────────────────────────────────────────────

  private async loadTrack(track: FoundSubtitleFile) {
    if (!this.transcriptEl) return;
    this.track = track;
    this.paintTrackChip();
    this.transcriptEl.empty();
    this.segmentEls = [];
    this.txtEls = [];
    this.segments = [];
    this.activeIndex = -1;
    // Old hits point at DOM we're about to throw away.
    this.hitEls = [];
    this.hitIndex = -1;
    this.highlightedSegs = [];

    let content: string;
    try {
      content = await this.app.vault.read(track.file);
    } catch (e) {
      this.showError(t('core.cannotReadSubtitle', { error: errorMessage(e) }));
      return;
    }

    this.segments = parseSubtitle(content, track.extension);

    if (this.segments.length === 0) {
      this.showEmpty(t('core.subtitleEmpty'));
      return;
    }

    this.renderSegments();

    // Re-run the active search against the freshly rendered segments.
    if (this.searchInput?.value.trim()) this.applySearch(this.searchInput.value);

    // Sync to current playback position immediately
    this.syncHighlight();
  }

  private renderSegments() {
    if (!this.transcriptEl) return;

    // Only label speakers when there are actually 2+ of them (skip monologues).
    const speakers = new Set(
      this.segments
        .filter(s => s.speaker !== undefined && s.speaker !== null && s.speaker !== '')
        .map(s => s.speaker),
    );
    const showSpeaker = speakers.size >= 2;

    for (const seg of this.segments) {
      const el = this.transcriptEl.createDiv('mt-segment');
      el.dataset.start = String(seg.startTime);
      el.dataset.end = String(seg.endTime);
      // Stable identity for other plugins painting over the transcript: the
      // segment's index in the track, and where it sits on the timeline.
      el.dataset.mtSeg = String(seg.index);
      el.dataset.mtStart = String(seg.startTime);

      // Timestamp chip doubles as "copy timestamp" (click it) — no extra button.
      // The timestamp is the play control. Seeking used to be bound to the
      // whole line, which fought with selecting the words: every attempt to
      // highlight or copy a phrase also jumped playback. Separating the two
      // by target beats guessing from whether a selection exists.
      const ts = el.createDiv('mt-ts');
      ts.setText(formatTime(seg.startTime));
      ts.setAttribute('title', this.media ? t('core.playFromHere') : t('core.noMediaToPlay'));
      ts.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        this.manualScrollUntil = 0;
        if (this.mediaEl) {
          this.mediaEl.currentTime = seg.startTime;
          if (this.mediaEl.paused) void this.mediaEl.play();
        }
      });

      // Speaker prefix chip — only when multiple speakers, distinct color each.
      if (showSpeaker && seg.speaker !== undefined && seg.speaker !== null && seg.speaker !== '') {
        const n = Number(seg.speaker);
        const isNum = Number.isFinite(n);
        const spk = el.createDiv('mt-spk');
        spk.setText(isNum ? `S${n}` : String(seg.speaker));
        const hue = ((isNum ? n : 0) * 70) % 360;
        spk.setCssStyles({
          color: `hsl(${hue}, 55%, 50%)`,
          backgroundColor: `hsla(${hue}, 55%, 50%, 0.14)`,
        });
      }

      const txt = el.createDiv('mt-txt');
      txt.setText(seg.text);
      this.txtEls.push(txt);

      // Right-click → context menu
      el.addEventListener('contextmenu', (e: MouseEvent) => {
        const menu = new Menu();
        if (this.media) menu.addItem(item =>
          item
            .setTitle(t('core.playFromHere'))
            .setIcon('play')
            .onClick(() => {
              this.manualScrollUntil = 0;
              if (this.mediaEl) {
                this.mediaEl.currentTime = seg.startTime;
                void this.mediaEl.play();
              }
            }),
        );
        menu.addItem(item =>
          item
            .setTitle(t('core.copyTimestamp'))
            .setIcon('clock')
            .onClick(() => { void navigator.clipboard.writeText(formatTime(seg.startTime)); }),
        );
        menu.addItem(item =>
          item
            .setTitle(t('core.copyTimestampLink'))
            .setIcon('link')
            .onClick(() => { void navigator.clipboard.writeText(this.timestampLink(seg.startTime)); }),
        );
        menu.addItem(item =>
          item
            .setTitle(t('core.copyText'))
            .setIcon('copy')
            .onClick(() => { void navigator.clipboard.writeText(seg.text); }),
        );
        menu.showAtMouseEvent(e);
      });

      this.segmentEls.push(el);
    }

    this.notifyTranscriptRendered();
  }

  /**
   * Tell anyone painting over the transcript that its DOM was rebuilt.
   *
   * Fired after every rebuild — a fresh track, and each time search highlighting
   * rewrites the segment text — so a listener can reapply its own decorations
   * idempotently rather than tracking which of our operations invalidated them.
   * We don't know or care who listens; this is a one-way announcement.
   */
  private notifyTranscriptRendered() {
    // Stamp the panel as well as announcing it. An event only reaches whoever
    // was listening at the time; a plugin loaded while a transcript is already
    // on screen would otherwise have no way to learn what it is looking at.
    if (this.transcriptEl) {
      this.transcriptEl.dataset.mtMedia = this.media?.location ?? '';
      this.transcriptEl.dataset.mtTrack = this.track?.file.path ?? '';
    }

    this.contentEl.dispatchEvent(
      new CustomEvent('mt:transcript-rendered', {
        bubbles: true,
        detail: {
          mediaPath: this.media?.location ?? null,
          trackPath: this.track?.file.path ?? null,
        },
      }),
    );
  }

  // ─── Playback sync ────────────────────────────────────────────────────────

  private syncHighlight() {
    if (!this.mediaEl || this.segments.length === 0) return;

    const now = this.mediaEl.currentTime;

    // Linear scan is fine for typical subtitle files (< a few thousand segments)
    let found = -1;
    for (let i = 0; i < this.segments.length; i++) {
      if (now >= this.segments[i].startTime && now < this.segments[i].endTime) {
        found = i;
        break;
      }
    }

    if (found === this.activeIndex) return;

    const before = this.activeIndex;
    if (before >= 0) {
      this.segmentEls[before]?.removeClass('mt-active');
    }

    this.activeIndex = found;

    if (found >= 0) {
      this.segmentEls[found]?.addClass('mt-active');
      if (this.plugin.settings.autoScroll && Date.now() >= this.manualScrollUntil) {
        // From one line to the next, smoothly; to the first shown (just opened, a seek), at once.
        this.scrollActiveIntoCenter(before >= 0 && Math.abs(found - before) <= 2);
      }
    }
  }

  /**
   * Scroll the transcript so the active segment sits vertically centered
   * (instead of only scrolling once it reaches the bottom edge). Positions are
   * taken from `offsetTop`, which is relative to `.mt-transcript` because that
   * element is `position: relative` in styles.css.
   */
  private scrollActiveIntoCenter(smooth: boolean) {
    const el = this.segmentEls[this.activeIndex];
    if (el) this.scrollElIntoCenter(el, smooth);
  }

  private scrollElIntoCenter(el: HTMLElement, smooth: boolean) {
    const container = this.transcriptEl;
    if (!container) return;

    const target = el.offsetTop - (container.clientHeight - el.offsetHeight) / 2;
    const max = container.scrollHeight - container.clientHeight;
    container.scrollTo({
      top: Math.max(0, Math.min(max, target)),
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  /** Reading-only stand-in for a seek: mark and center the line at `seconds`. */
  private revealTime(seconds: number) {
    let idx = -1;
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segments[i].startTime <= seconds) idx = i;
      else break;
    }
    if (idx < 0) return;
    if (this.activeIndex >= 0) this.segmentEls[this.activeIndex]?.removeClass('mt-active');
    this.activeIndex = idx;
    this.segmentEls[idx]?.addClass('mt-active');
    this.scrollActiveIntoCenter(false);
  }

  // ─── Export ───────────────────────────────────────────────────────────────

  private async exportAsMarkdown() {
    const base = this.trackBase;
    if (this.segments.length === 0) {
      new Notice(t('core.nothingToExport'));
      return;
    }

    const lines = [`# ${base}\n`];
    for (const seg of this.segments) {
      lines.push(`**${formatTime(seg.startTime)}** ${seg.text}\n`);
    }
    const mdContent = lines.join('\n');

    // Determine the marker from the currently selected track
    const marker = this.track?.marker ?? '';
    const mdName = marker ? `${base}.${marker}.md` : `${base}.md`;
    const mdPath = (this.trackDir ? this.trackDir + '/' : '') + mdName;

    try {
      const existing = this.app.vault.getAbstractFileByPath(mdPath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, mdContent);
      } else {
        await this.app.vault.create(mdPath, mdContent);
      }
      new Notice(t('core.exportedTo', { path: mdPath }));
    } catch (e) {
      new Notice(t('core.exportFailed', { error: errorMessage(e) }));
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private showEmpty(msg = t('core.noSubtitleFound')) {
    if (!this.transcriptEl) return;
    this.transcriptEl.empty();
    const el = this.transcriptEl.createDiv('mt-empty');
    el.setText(msg);
  }

  private showError(msg: string) {
    if (!this.transcriptEl) return;
    this.transcriptEl.empty();
    this.transcriptEl.createDiv('mt-error').setText(msg);
  }
}

/** A transcript's name in the chip and menu: what made it (`vibevoice-4bit`), or its format. */
function trackLabel(track: FoundSubtitleFile): string {
  return track.marker || track.extension.toUpperCase();
}
