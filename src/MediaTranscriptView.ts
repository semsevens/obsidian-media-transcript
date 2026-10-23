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
import { parseSubtitle, SubtitleSegment, formatTime } from './utils/subtitleParser';
import { parseTimeFragment, timeFragment } from './utils/timeFragment';
import { t } from './i18n';
import { renderBar } from './library/PlayerBar';

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

export class MediaTranscriptView extends FileView {
  plugin: MediaTranscriptPlugin;

  private mediaEl: HTMLVideoElement | HTMLAudioElement | null = null;
  private transcriptEl: HTMLElement | null = null;
  private segmentEls: HTMLElement[] = [];
  private segments: SubtitleSegment[] = [];
  private activeIndex = -1;
  private subtitleTracks: FoundSubtitleFile[] = [];
  private trackSelect: HTMLSelectElement | null = null;
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
  private audioOnlyBtn: HTMLElement | null = null;

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
    this.updateAudioOnlyBtn();

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

  private updateAudioOnlyBtn() {
    const btn = this.audioOnlyBtn;
    if (!btn) return;
    const audioOnly = this.plugin.settings.videoAudioOnly;
    btn.setText(audioOnly ? t('core.modeVideo') : t('core.modeAudioOnly'));
    btn.setAttribute(
      'title',
      audioOnly ? t('core.modeVideoTitle') : t('core.modeAudioOnlyTitle'),
    );
  }

  /** Apply a new player-pane width (%) to this open view, if it's in video mode. */
  applyPlayerWidth(pct: number) {
    const playerSide = this.contentEl.querySelector('.mt-player-side');
    if (playerSide instanceof HTMLElement) {
      playerSide.setCssProps({ '--mt-player-width': `${pct}%` });
    }
  }

  /** Apply the transcript font size (px) to this open view. */
  applyFontSize(px: number) {
    this.transcriptEl?.setCssProps({ '--mt-font-size': `${px}px` });
  }

  /** Put the cursor in the transcript search box (see the command in main.ts). */
  focusSearch() {
    this.searchInput?.focus();
    this.searchInput?.select();
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
    this.mediaEl = wrapper.createEl('video', {
      cls: 'mt-media',
      attr: { src: resourcePath, controls: '' },
    });
    this.buildSpeedControl(wrapper);
    this.buildOrigin(container, media);
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
    container.createSpan('mt-audio-bar-icon').setText(this.isVideo ? '🎧' : '🎵');
    container.createSpan('mt-audio-bar-title').setText(video.title ?? media.basename);
    const audio = container.createEl('audio', {
      cls: 'mt-media-audio',
      attr: { src: resourcePath, controls: '' },
    });
    this.mediaEl = audio;
    this.buildSpeedControl(container);
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
    container.createSpan('mt-audio-bar-icon').setText('📄');
    container.createSpan('mt-audio-bar-title').setText(this.file?.basename ?? '');
    const note = container.createSpan('mt-nomedia-note');
    note.setText(t('core.noMediaReadingOnly'));
    note.setAttribute(
      'title',
      t('core.lookedIn', { places: this.searched.map(s => '• ' + s).join('\n') }),
    );
    const file = this.file;
    if (!file) return;
    const link = container.createEl('button', {
      cls: 'mt-btn mt-link-media-btn',
      text: t('core.linkMediaButton'),
      attr: { 'aria-label': t('core.linkMediaAria') },
    });
    link.addEventListener('click', () => { void this.plugin.linkMedia(file); });
    // A server that didn't answer (asleep, a phone's VPN still coming back)
    // may well answer now.
    const retry = container.createEl('button', { cls: 'mt-btn', text: t('core.retryFindMedia') });
    retry.addEventListener('click', () => {
      this.plugin.mediaLocator.invalidate();
      void this.reload();
    });
  }

  private buildSpeedControl(container: HTMLElement) {
    if (Platform.isMobile) return;  // in the ⋯ menu
    const row = container.createDiv('mt-speed-row');
    row.createSpan('mt-speed-label').setText(t('core.speed'));
    const sel = row.createEl('select', { cls: 'mt-speed' });
    for (const r of [0.75, 1, 1.25, 1.5, 2]) {
      const opt = sel.createEl('option', { text: `${r}x`, attr: { value: String(r) } });
      if (r === 1) opt.selected = true;
    }
    sel.addEventListener('change', () => {
      if (this.mediaEl) this.mediaEl.playbackRate = parseFloat(sel.value);
    });
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
    this.buildSearchBar(container.createDiv('mt-searchbar'));

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
    this.populateTrackSelect(sorted);

    // If we arrived here from a clicked subtitle, load that exact track;
    // otherwise fall back to the priority-sorted default.
    const preferred = this.preferredTrackPath
      ? sorted.find(t => t.file.path === this.preferredTrackPath)
      : undefined;
    const initial = preferred ?? sorted[0];

    if (initial) {
      if (this.trackSelect) this.trackSelect.value = initial.file.path;
      await this.loadTrack(initial);
    } else {
      this.showEmpty();
    }
  }

  private buildToolbar(toolbar: HTMLElement) {
    // Subtitle source selector
    const selectWrap = toolbar.createDiv('mt-select-wrap');
    selectWrap.createEl('label', { text: t('core.subtitleLabel'), cls: 'mt-label' });
    this.trackSelect = selectWrap.createEl('select', { cls: 'mt-select' });
    this.trackSelect.addEventListener('change', () => {
      const track = this.subtitleTracks.find(
        t => t.file.path === this.trackSelect?.value,
      );
      if (track) void this.loadTrack(track);
    });

    const actions = toolbar.createDiv('mt-actions');

    // Video ⇄ audio-only. Only meaningful for video files; audio has no picture.
    if (this.isVideo) {
      this.audioOnlyBtn = actions.createEl('button', { cls: 'mt-btn mt-btn-mode' });
      this.audioOnlyBtn.addEventListener('click', () => { void this.toggleAudioOnly(); });
      this.updateAudioOnlyBtn();
    } else {
      this.audioOnlyBtn = null;
    }

    // Font size: A− / A+ (persisted, applied to every open transcript view)
    const smaller = actions.createEl('button', {
      text: 'A−',
      cls: 'mt-btn mt-btn-font',
      attr: { title: t('core.fontSmaller') },
    });
    smaller.addEventListener('click', () => this.nudgeFontSize(-1));

    const bigger = actions.createEl('button', {
      text: 'A+',
      cls: 'mt-btn mt-btn-font',
      attr: { title: t('core.fontLarger') },
    });
    bigger.addEventListener('click', () => this.nudgeFontSize(+1));

    // Export as markdown button
    const exportBtn = actions.createEl('button', {
      text: t('core.exportMd'),
      cls: 'mt-btn',
      attr: { title: t('core.exportMdTitle') },
    });
    exportBtn.addEventListener('click', () => { void this.exportAsMarkdown(); });
  }

  /** On a phone, what the toolbar holds elsewhere: the subtitle, speed, audio only, text size, export. */
  private showMoreMenu(e: MouseEvent) {
    const menu = new Menu();
    const select = this.trackSelect;
    if (select && this.subtitleTracks.length > 1) {
      for (const opt of Array.from(select.options)) {
        menu.addItem(i => i.setTitle(opt.text).setChecked(opt.value === select.value).onClick(() => {
          select.value = opt.value;
          select.dispatchEvent(new Event('change'));
        }));
      }
      menu.addSeparator();
    }
    const el = this.mediaEl;
    if (el) {
      for (const r of [0.75, 1, 1.25, 1.5, 2]) {
        menu.addItem(i => i.setTitle(t('core.speedAt', { rate: r })).setChecked(el.playbackRate === r).onClick(() => { el.playbackRate = r; }));
      }
      menu.addSeparator();
    }
    if (this.isVideo) {
      menu.addItem(i => i.setTitle(this.plugin.settings.videoAudioOnly ? t('core.modeVideo') : t('core.modeAudioOnly'))
        .onClick(() => { void this.toggleAudioOnly(); }));
    }
    menu.addItem(i => i.setTitle(`A−  ${t('core.fontSmaller')}`).onClick(() => this.nudgeFontSize(-1)));
    menu.addItem(i => i.setTitle(`A+  ${t('core.fontLarger')}`).onClick(() => this.nudgeFontSize(+1)));
    menu.addItem(i => i.setTitle(t('core.exportMd')).setIcon('download').onClick(() => { void this.exportAsMarkdown(); }));
    menu.showAtMouseEvent(e);
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

    const prev = bar.createEl('button', {
      text: '↑',
      cls: 'mt-btn mt-btn-hit',
      attr: { title: t('core.prevMatch') },
    });
    const next = bar.createEl('button', {
      text: '↓',
      cls: 'mt-btn mt-btn-hit',
      attr: { title: t('core.nextMatch') },
    });
    if (Platform.isMobile) {
      const more = bar.createEl('button', { cls: 'mt-btn mt-btn-more clickable-icon', attr: { 'aria-label': t('core.moreActions') } });
      setIcon(more, 'more-horizontal');
      more.addEventListener('click', e => this.showMoreMenu(e));
    }
    prev.addEventListener('click', () => this.stepHit(-1));
    next.addEventListener('click', () => this.stepHit(+1));

    input.addEventListener('input', () => this.applySearch(input.value));
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.stepHit(e.shiftKey ? -1 : +1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.value = '';
        this.applySearch('');
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

  private populateTrackSelect(tracks: FoundSubtitleFile[]) {
    if (!this.trackSelect) return;
    this.trackSelect.empty();

    if (tracks.length === 0) {
      const opt = this.trackSelect.createEl('option', { text: t('core.noSubtitlesOption') });
      opt.disabled = true;
      return;
    }

    for (const track of tracks) {
      const label = track.marker
        ? `${track.marker}.${track.extension}`
        : track.extension.toUpperCase();
      this.trackSelect.createEl('option', {
        text: label,
        attr: { value: track.file.path },
      });
    }
  }

  // ─── Track loading ────────────────────────────────────────────────────────

  private async loadTrack(track: FoundSubtitleFile) {
    if (!this.transcriptEl) return;
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
      this.transcriptEl.dataset.mtTrack = this.trackSelect?.value ?? '';
    }

    this.contentEl.dispatchEvent(
      new CustomEvent('mt:transcript-rendered', {
        bubbles: true,
        detail: {
          mediaPath: this.media?.location ?? null,
          trackPath: this.trackSelect?.value ?? null,
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
    const selectedPath = this.trackSelect?.value ?? '';
    const selectedTrack = this.subtitleTracks.find(t => t.file.path === selectedPath);
    const marker = selectedTrack?.marker ?? '';
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
