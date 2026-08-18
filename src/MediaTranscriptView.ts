import { FileView, WorkspaceLeaf, TFile, Notice, Menu } from 'obsidian';
import type MediaTranscriptPlugin from './main';
import {
  findSubtitleFiles,
  findMediaForSubtitle,
  resolvePriority,
  FoundSubtitleFile,
  SUBTITLE_EXTENSIONS,
} from './utils/subtitleFinder';
import { parseSubtitle, SubtitleSegment, formatTime } from './utils/subtitleParser';

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
  // The media file actually being played. Usually equals `this.file`, but when
  // a subtitle file is opened directly it's the media we resolved for it.
  private mediaFile: TFile | null = null;
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

  constructor(leaf: WorkspaceLeaf, plugin: MediaTranscriptPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE_MEDIA_TRANSCRIPT; }
  getDisplayText() {
    return this.mediaFile?.basename ?? this.file?.basename ?? 'Media Transcript';
  }

  // ─── File lifecycle ───────────────────────────────────────────────────────

  async onLoadFile(file: TFile) {
    this.contentEl.empty();
    this.contentEl.addClass('mt-view');
    this.contentEl.removeClass('mt-audio-mode');
    this.preferredTrackPath = null;
    this.transcriptSideEl = null;

    // If a subtitle file was opened directly, resolve the media it belongs to
    // (prefer video, else audio) and play that instead, pre-selecting this track.
    let mediaFile = file;
    if (SUBTITLE_EXTENSIONS.includes(file.extension.toLowerCase())) {
      const resolved = findMediaForSubtitle(file, this.app.vault, this.plugin.settings);
      if (!resolved) {
        this.mediaFile = null;
        this.contentEl.createDiv('mt-empty').setText(
          `No media file found next to "${file.name}".\n` +
            'Place a same-named audio/video file (e.g. .mp4 / .m4a / .mp3) in the same folder.',
        );
        return;
      }
      mediaFile = resolved;
      this.preferredTrackPath = file.path;
    }
    this.mediaFile = mediaFile;

    this.isVideo = this.plugin.settings.supportedVideoExtensions.includes(
      mediaFile.extension.toLowerCase(),
    );

    await this.buildLayout();
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
    const mediaFile = this.mediaFile;
    if (!mediaFile) return;

    const showVideo = this.isVideo && !this.plugin.settings.videoAudioOnly;
    const reused = this.transcriptSideEl;
    if (reused) reused.detach();

    this.contentEl.empty();
    this.contentEl.removeClass('mt-audio-mode');

    let transcriptSide: HTMLElement;
    if (showVideo) {
      const root = this.contentEl.createDiv('mt-root');
      const playerSide = root.createDiv('mt-player-side');
      const pct = this.plugin.settings.playerWidthPercent ?? 75;
      playerSide.setCssProps({ '--mt-player-width': `${pct}%` });
      this.buildDivider(root, playerSide);
      transcriptSide = reused ?? root.createDiv('mt-transcript-side');
      if (reused) root.appendChild(reused);
      this.buildVideoPlayer(playerSide, mediaFile);
    } else {
      this.contentEl.addClass('mt-audio-mode');
      const bar = this.contentEl.createDiv('mt-audio-bar');
      this.buildAudioBar(bar, mediaFile);
      transcriptSide = reused ?? this.contentEl.createDiv('mt-transcript-side');
      if (reused) this.contentEl.appendChild(reused);
    }

    if (!reused) {
      this.transcriptSideEl = transcriptSide;
      await this.buildTranscriptPanel(transcriptSide, mediaFile);
    }
    this.updateAudioOnlyBtn();
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
    const state = old
      ? { time: old.currentTime, rate: old.playbackRate, playing: !old.paused }
      : null;
    const scrollTop = this.transcriptEl?.scrollTop ?? 0;

    if (old) {
      old.pause();
      old.removeAttribute('src'); // also disarms the audio-fallback error handler
      old.load();
    }

    await this.buildLayout();

    const next = this.mediaEl;
    if (state && next) {
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
    btn.setText(audioOnly ? '🎬 Video' : '🎧 Audio only');
    btn.setAttribute(
      'title',
      audioOnly ? 'Show the video picture again' : 'Hide the picture and just play the audio',
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

  async onUnloadFile(_file: TFile) {
    if (this.mediaEl) {
      this.mediaEl.pause();
      this.mediaEl.removeAttribute('src');
      this.mediaEl.load();
    }
  }

  // ─── Media player ─────────────────────────────────────────────────────────

  private buildVideoPlayer(container: HTMLElement, file: TFile) {
    const resourcePath = this.app.vault.getResourcePath(file);
    const wrapper = container.createDiv('mt-player-wrapper');
    this.mediaEl = wrapper.createEl('video', {
      cls: 'mt-media',
      attr: { src: resourcePath, controls: '' },
    });
    this.buildSpeedControl(wrapper);
    this.mediaEl.addEventListener('timeupdate', () => this.syncHighlight());
  }

  private buildAudioBar(container: HTMLElement, file: TFile) {
    const resourcePath = this.app.vault.getResourcePath(file);
    container.createSpan('mt-audio-bar-icon').setText(this.isVideo ? '🎧' : '🎵');
    container.createSpan('mt-audio-bar-title').setText(file.basename);
    const audio = container.createEl('audio', {
      cls: 'mt-media-audio',
      attr: { src: resourcePath, controls: '' },
    });
    this.mediaEl = audio;
    this.buildSpeedControl(container);
    audio.addEventListener('timeupdate', () => this.syncHighlight());

    // A video played through an <audio> element normally works (same demuxers),
    // but some containers refuse. If that happens, fall back to the video player
    // rather than leaving the user with a dead control bar.
    if (this.isVideo) {
      audio.addEventListener('error', () => {
        // Teardown clears src first, so this only fires on a real decode failure.
        if (!audio.getAttribute('src') || this.mediaEl !== audio) return;
        new Notice('This video cannot be played as audio only — showing the picture again.');
        this.plugin.settings.videoAudioOnly = false;
        void this.plugin.saveSettings();
        void this.buildLayout();
      });
    }
  }

  private buildSpeedControl(container: HTMLElement) {
    const row = container.createDiv('mt-speed-row');
    row.createSpan('mt-speed-label').setText('Speed');
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

  private async buildTranscriptPanel(container: HTMLElement, file: TFile) {
    // Toolbar row
    const toolbar = container.createDiv('mt-toolbar');
    this.buildToolbar(toolbar, file);

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
    this.subtitleTracks = findSubtitleFiles(file, this.app.vault, this.plugin.settings);
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

  private buildToolbar(toolbar: HTMLElement, file: TFile) {
    // Subtitle source selector
    const selectWrap = toolbar.createDiv('mt-select-wrap');
    selectWrap.createEl('label', { text: 'Subtitle:', cls: 'mt-label' });
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
      attr: { title: 'Smaller transcript text' },
    });
    smaller.addEventListener('click', () => this.nudgeFontSize(-1));

    const bigger = actions.createEl('button', {
      text: 'A+',
      cls: 'mt-btn mt-btn-font',
      attr: { title: 'Larger transcript text' },
    });
    bigger.addEventListener('click', () => this.nudgeFontSize(+1));

    // Export as markdown button
    const exportBtn = actions.createEl('button', {
      text: 'Export MD',
      cls: 'mt-btn',
      attr: { title: 'Export the current transcript as a Markdown note' },
    });
    exportBtn.addEventListener('click', () => { void this.exportAsMarkdown(file); });
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
      attr: { type: 'search', placeholder: 'Search transcript…', spellcheck: 'false' },
    });
    this.searchInput = input;
    this.searchCountEl = bar.createSpan('mt-search-count');

    const prev = bar.createEl('button', {
      text: '↑',
      cls: 'mt-btn mt-btn-hit',
      attr: { title: 'Previous match (Shift+Enter)' },
    });
    const next = bar.createEl('button', {
      text: '↓',
      cls: 'mt-btn mt-btn-hit',
      attr: { title: 'Next match (Enter)' },
    });
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
      const opt = this.trackSelect.createEl('option', { text: '(no subtitles)' });
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
      this.showError(`Cannot read subtitle file: ${errorMessage(e)}`);
      return;
    }

    this.segments = parseSubtitle(content, track.extension);

    if (this.segments.length === 0) {
      this.showEmpty('Subtitle file is empty or could not be parsed.');
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

      // Timestamp chip doubles as "copy timestamp" (click it) — no extra button.
      const ts = el.createDiv('mt-ts');
      ts.setText(formatTime(seg.startTime));
      ts.setAttribute('title', 'Copy timestamp');
      ts.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(formatTime(seg.startTime));
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

      // Main click → seek
      el.addEventListener('click', () => {
        // An explicit jump means the user is done reading ahead: let
        // auto-scroll take over again right away.
        this.manualScrollUntil = 0;
        if (this.mediaEl) {
          this.mediaEl.currentTime = seg.startTime;
          if (this.mediaEl.paused) void this.mediaEl.play();
        }
      });

      // Right-click → context menu
      el.addEventListener('contextmenu', (e: MouseEvent) => {
        const menu = new Menu();
        menu.addItem(item =>
          item
            .setTitle('Play from here')
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
            .setTitle('Copy timestamp')
            .setIcon('clock')
            .onClick(() => { void navigator.clipboard.writeText(formatTime(seg.startTime)); }),
        );
        menu.addItem(item =>
          item
            .setTitle('Copy text')
            .setIcon('copy')
            .onClick(() => { void navigator.clipboard.writeText(seg.text); }),
        );
        menu.showAtMouseEvent(e);
      });

      this.segmentEls.push(el);
    }
  }

  // ─── Playback sync ────────────────────────────────────────────────────────

  private syncHighlight() {
    if (!this.mediaEl || this.segments.length === 0) return;

    const t = this.mediaEl.currentTime;

    // Linear scan is fine for typical subtitle files (< a few thousand segments)
    let found = -1;
    for (let i = 0; i < this.segments.length; i++) {
      if (t >= this.segments[i].startTime && t < this.segments[i].endTime) {
        found = i;
        break;
      }
    }

    if (found === this.activeIndex) return;

    if (this.activeIndex >= 0) {
      this.segmentEls[this.activeIndex]?.removeClass('mt-active');
    }

    this.activeIndex = found;

    if (found >= 0) {
      this.segmentEls[found]?.addClass('mt-active');
      if (this.plugin.settings.autoScroll && Date.now() >= this.manualScrollUntil) {
        this.scrollActiveIntoCenter(true);
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

  // ─── Export ───────────────────────────────────────────────────────────────

  private async exportAsMarkdown(file: TFile) {
    if (this.segments.length === 0) {
      new Notice('Nothing to export.');
      return;
    }

    const lines = [`# ${file.basename}\n`];
    for (const seg of this.segments) {
      lines.push(`**${formatTime(seg.startTime)}** ${seg.text}\n`);
    }
    const mdContent = lines.join('\n');

    // Determine the marker from the currently selected track
    const selectedPath = this.trackSelect?.value ?? '';
    const selectedTrack = this.subtitleTracks.find(t => t.file.path === selectedPath);
    const marker = selectedTrack?.marker ?? '';
    const mdName = marker
      ? `${file.basename}.${marker}.md`
      : `${file.basename}.md`;
    const mdPath = (file.parent?.path ? file.parent.path + '/' : '') + mdName;

    try {
      const existing = this.app.vault.getAbstractFileByPath(mdPath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, mdContent);
      } else {
        await this.app.vault.create(mdPath, mdContent);
      }
      new Notice(`Exported to ${mdPath}`);
    } catch (e) {
      new Notice(`Export failed: ${errorMessage(e)}`);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private showEmpty(msg = 'No subtitle found.\nPlace a same-named .json / .srt / .vtt file in the same folder.') {
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
