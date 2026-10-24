import { Menu, Modal, Platform, setIcon } from 'obsidian';
import type MediaTranscriptPlugin from '../main';
import { formatDuration } from './mediaInfo';
import type { NowPlaying, Track } from './NowPlaying';
import type { QueueEntry } from './playlist';
import { formatSize } from '../utils/format';
import { t } from '../i18n';

const VIEW_TYPE_LIBRARY = 'media-one-library';
const BARS = 48;

function iconButton(parent: HTMLElement, icon: string, label: string, cls: string, onClick: (evt: MouseEvent) => void): HTMLButtonElement {
  const b = parent.createEl('button', { cls: `clickable-icon ${cls}`, attr: { 'aria-label': label } });
  setIcon(b, icon);
  b.addEventListener('click', evt => {
    evt.stopPropagation();
    onClick(evt);
  });
  return b;
}

/** Set a button's icon and label to playing or paused, only when it changes. */
function paintPlay(button: HTMLElement, playing: boolean): void {
  const icon = playing ? 'pause' : 'play';
  if (button.dataset.icon === icon) return;
  button.dataset.icon = icon;
  setIcon(button, icon);
  button.setAttr('aria-label', t(playing ? 'library.playerPause' : 'library.menuPlay'));
}

function hash(text: string): number {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * A cover for what has none: a colour of its own (by where it is from) and
 * the name of where it is from.
 */
export function renderCover(parent: HTMLElement, subtitle: string, cls: string): HTMLElement {
  const from = subtitle.split(' · ')[0] || '♪';
  // This vault's own recordings: a microphone, in the accent colour (as in the library's list).
  if (from === t('library.collectionMine')) {
    const own = parent.createDiv(`mo-cover mo-lib-own-cover ${cls}`);
    setIcon(own, 'mic');
    return own;
  }
  const hue = hash(from) % 360;
  const cover = parent.createDiv(`mo-cover ${cls}`);
  cover.style.setProperty('--mo-cover-a', `hsl(${hue} 55% 52%)`);
  cover.style.setProperty('--mo-cover-b', `hsl(${(hue + 50) % 360} 60% 30%)`);
  // A small one has room for two characters (or a short word) only.
  const short = /[\u3400-\u9fff]/.test(from) ? Array.from(from).slice(0, 2).join('') : initials(from);
  cover.createSpan({ cls: 'mo-cover-text', text: cls.includes('is-small') ? short : from });
  return cover;
}

/** A latin name, small: its initials (`mo-test` → MT, `source` → S, `me` → ME). */
function initials(name: string): string {
  const words = name.split(/[\s\-_./]+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return (name.length <= 3 ? name : name[0]).toUpperCase();
}

/** The ring round the play button: how far it has played. */
function ringButton(parent: HTMLElement, np: NowPlaying, cls: string): { button: HTMLButtonElement; paint: () => void } {
  const button = parent.createEl('button', { cls: `clickable-icon mo-ring ${cls}`, attr: { 'aria-label': t('library.menuPlay') } });
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.classList.add('mo-ring-svg');
  const track = document.createElementNS(ns, 'circle');
  const done = document.createElementNS(ns, 'circle');
  for (const c of [track, done]) {
    c.setAttribute('cx', '18');
    c.setAttribute('cy', '18');
    c.setAttribute('r', '16');
    c.setAttribute('pathLength', '100');
    svg.appendChild(c);
  }
  track.classList.add('mo-ring-track');
  done.classList.add('mo-ring-done');
  const icon = button.createSpan('mo-ring-icon');
  button.appendChild(svg);
  button.addEventListener('click', evt => {
    evt.stopPropagation();
    np.toggle();
  });
  return {
    button,
    paint: () => {
      paintPlay(icon, np.playing);
      const d = np.duration;
      done.setAttribute('stroke-dasharray', `${d ? (np.time / d) * 100 : 0} 100`);
    },
  };
}

/**
 * The player bar, the same wherever it is (at the foot of the library,
 * floating above a phone's navigation): what is playing, where it is, play
 * or pause, the playlist. Tap it to open what is playing in full. Hidden
 * while nothing plays.
 */
export function renderBar(parent: HTMLElement, plugin: MediaTranscriptPlugin, cls: string, shown: () => boolean = () => true): { el: HTMLElement; paint: () => void; remove: () => void } {
  const np = plugin.nowPlaying;
  const bar = parent.createDiv(`mo-bar ${cls}`);
  let cover: HTMLElement | null = null;
  let coverFor = '';
  const coverSlot = bar.createDiv('mo-bar-cover');
  const text = bar.createDiv('mo-bar-text');
  const title = text.createDiv('mo-bar-title');
  const line = text.createDiv('mo-bar-line');
  bar.addEventListener('click', () => new NowPlayingModal(plugin).open());
  const ring = ringButton(bar, np, 'mo-bar-play');
  iconButton(bar, 'list-music', t('library.tabPlaylist'), 'mo-bar-list', () => new PlaylistModal(plugin).open());
  const paint = () => {
    const track = np.track;
    bar.toggleClass('is-hidden', !track || !shown());
    if (!track) return;
    if (coverFor !== track.subtitle) {
      coverFor = track.subtitle;
      cover?.remove();
      cover = renderCover(coverSlot, track.subtitle, 'is-small');
    }
    ring.paint();
    title.setText(track.title);
    const d = np.duration;
    line.setText(np.failed ? t('library.playerOffline') : np.gap ? t('library.playerGap') : d ? `${formatDuration(np.time)} / ${formatDuration(d)}` : formatDuration(np.time));
    line.toggleClass('is-error', np.failed || np.gap);
  };
  paint();
  const unsubscribe = np.subscribe(paint);
  return { el: bar, paint, remove: () => { unsubscribe(); bar.remove(); } };
}

/**
 * The player at the foot of the library. On a phone the library's foot is
 * padded (for the navigation bar); the bar sits above that.
 */
export function renderDock(parent: HTMLElement, plugin: MediaTranscriptPlugin): () => void {
  const bar = renderBar(parent, plugin, 'mo-dock');
  const unsubscribe = plugin.nowPlaying.subscribe(() => {
    // Read once the library is on the page (a phone pads its foot more).
    const pad = getComputedStyle(parent).paddingBottom;
    if (pad && pad !== bar.el.style.getPropertyValue('--mo-dock-pad')) bar.el.style.setProperty('--mo-dock-pad', pad);
  });
  return () => {
    unsubscribe();
    bar.remove();
  };
}

/** The seek bar: how much is said along it (from the transcript), what has played, dragged to seek. */
function renderWave(parent: HTMLElement, np: NowPlaying): { paint: () => void } {
  const wave = parent.createDiv('mo-wave');
  const bars: HTMLElement[] = [];
  for (let i = 0; i < BARS; i++) bars.push(wave.createDiv('mo-wave-bar'));
  const head = wave.createDiv('mo-wave-head');
  let drag: number | null = null;
  let heights = '';
  const at = (evt: PointerEvent) => {
    const r = wave.getBoundingClientRect();
    return Math.max(0, Math.min(1, (evt.clientX - r.left) / r.width));
  };
  wave.addEventListener('pointerdown', evt => {
    wave.setPointerCapture(evt.pointerId);
    drag = at(evt);
    paint();
  });
  wave.addEventListener('pointermove', evt => {
    if (drag === null) return;
    drag = at(evt);
    paint();
  });
  const end = () => {
    if (drag !== null && np.duration) np.seek(drag * np.duration);
    drag = null;
  };
  wave.addEventListener('pointerup', end);
  wave.addEventListener('pointercancel', () => { drag = null; });
  const paint = () => {
    const d = np.duration;
    const share = drag ?? (d ? np.time / d : 0);
    const density = np.density(BARS);
    const key = density.map(v => v.toFixed(2)).join();
    if (key !== heights) {
      heights = key;
      bars.forEach((b, i) => b.style.setProperty('--h', `${18 + density[i] * 82}%`));
    }
    const played = Math.round(share * BARS);
    bars.forEach((b, i) => b.toggleClass('is-played', i < played));
    head.style.setProperty('--mo-at', `${share * 100}%`);
  };
  return { paint };
}

const SLEEP = [15, 30, 60, 90];
/** After the reader scrolls, leave the lines where they put them this long. */
const HOLD_MS = 4000;

/**
 * The transcript in the player: every line, the one being said lit and kept
 * in the middle (unless the reader has just scrolled), selectable, and a tap
 * on a line plays from it.
 */
function renderLyrics(parent: HTMLElement, np: NowPlaying): { paint: () => void } {
  const box = parent.createDiv('mo-np-lyrics');
  const note = box.createDiv('mo-np-lyrics-note');
  let shownFor: unknown = null;
  let rows: HTMLElement[] = [];
  let lit = -2;
  let heldUntil = 0;
  // Our own (smooth) scrolling fires scroll events for a while: not the reader's.
  let ownUntil = 0;
  const hold = () => {
    heldUntil = Date.now() + HOLD_MS;
  };
  box.addEventListener('wheel', hold, { passive: true });
  box.addEventListener('touchmove', hold, { passive: true });
  box.addEventListener('scroll', () => {
    if (Date.now() > ownUntil) hold();
  }, { passive: true });
  box.addEventListener('click', evt => {
    // A selection made, not a tap.
    if (window.getSelection()?.toString()) return;
    const row = (evt.target as HTMLElement).closest<HTMLElement>('.mo-np-lyric');
    if (!row?.dataset.start) return;
    np.seek(Number(row.dataset.start));
    heldUntil = 0;
    if (!np.playing) np.toggle();
  });
  const center = (row: HTMLElement, smooth: boolean) => {
    ownUntil = Date.now() + (smooth ? 800 : 100);
    box.scrollTo({ top: row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2, behavior: smooth ? 'smooth' : 'auto' });
  };
  const paint = () => {
    const { lines, now } = np.transcriptLines;
    if (lines !== shownFor) {
      shownFor = lines;
      rows.forEach(r => r.remove());
      rows = lines.map(l => {
        const row = box.createDiv('mo-np-lyric');
        row.dataset.start = String(l.startTime);
        row.setText(l.text);
        return row;
      });
      lit = -2;
    }
    note.setText(np.failed ? t('library.playerOffline') : np.gap ? t('library.playerGap') : lines.length ? '' : np.track?.transcript ? '' : t('library.playerNoTranscript'));
    note.toggle(!!note.getText());
    note.toggleClass('is-error', np.failed || np.gap);
    if (now === lit) return;
    rows[lit]?.removeClass('is-now');
    rows[now]?.addClass('is-now');
    const first = lit === -2;
    lit = now;
    if (rows[now] && Date.now() > heldUntil) center(rows[now], !first);
  };
  return { paint };
}

/**
 * What is playing, in full (a phone: the whole screen): its cover, the line
 * being said over the seek bar, the controls, the speed, a sleep timer, and
 * the transcript, the playlist and the library. A modal, so a phone's back
 * closes it.
 */
export class NowPlayingModal extends Modal {
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly plugin: MediaTranscriptPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    const { plugin } = this;
    const np = plugin.nowPlaying;
    const { cache } = plugin;
    this.modalEl.addClass('mo-np-modal');
    // The floating bar is this, small: not both at once.
    document.body.addClass('mo-np-open');
    const root = this.contentEl.createDiv('mo-np');

    const top = root.createDiv('mo-np-top');
    iconButton(top, 'chevron-down', t('library.playerClose'), 'mo-np-down', () => this.close());
    top.createDiv('mo-np-top-gap');
    const keep = iconButton(top, 'download', t('library.cacheDownload'), 'mo-np-keep', evt => {
      const track = np.track;
      if (!track) return;
      const e = cache.entry(track.key);
      if (e?.kind === 'kept' && cache.complete(track.key)) {
        const menu = new Menu();
        menu.addItem(i => i.setTitle(t('library.cacheRemove')).setIcon('trash-2').onClick(() => { void cache.remove(track.key); }));
        menu.showAtMouseEvent(evt);
      } else if (cache.progress(track.key)?.active && e?.kind === 'kept') {
        cache.cancel(track.key);
      } else {
        cache.keep({ path: track.key, url: track.url, size: track.size });
      }
    });
    const keepLabel = keep.createSpan('mo-np-keep-label');

    // What it is: a small cover, the title, where it is from.
    const head = root.createDiv('mo-np-head');
    const coverSlot = head.createDiv('mo-np-cover');
    let coverFor = '';
    const names = head.createDiv('mo-np-names');
    const title = names.createDiv('mo-np-title');
    const subtitle = names.createDiv('mo-np-subtitle');

    // Most of the room: the transcript, following what is said, as the
    // transcript view does: scroll it, select from it, tap a line to play from there.
    const lyrics = renderLyrics(root, np);

    const seekRow = root.createDiv('mo-np-seekrow');
    const at = seekRow.createSpan('mo-np-at');
    seekRow.createDiv('mo-np-top-gap');
    const left = seekRow.createSpan('mo-np-left');
    const wave = renderWave(root, np);

    const controls = root.createDiv('mo-np-controls');
    const rate = controls.createEl('button', { cls: 'mo-np-rate', attr: { 'aria-label': t('library.playerRate') } });
    rate.addEventListener('click', () => np.nextRate());
    const back = iconButton(controls, 'rotate-ccw', t('library.playerBack'), 'mo-np-skip', () => np.back());
    back.createSpan({ cls: 'mo-np-skip-n', text: '15' });
    const play = iconButton(controls, 'play', t('library.menuPlay'), 'mo-np-play', () => np.toggle());
    const ahead = iconButton(controls, 'rotate-cw', t('library.playerAhead'), 'mo-np-skip', () => np.ahead());
    ahead.createSpan({ cls: 'mo-np-skip-n', text: '30' });
    const sleep = iconButton(controls, 'timer', t('library.playerSleep'), 'mo-np-sleep', evt => {
      const menu = new Menu();
      for (const m of SLEEP) menu.addItem(i => i.setTitle(t('library.playerSleepMinutes', { minutes: m })).onClick(() => np.setSleep(m)));
      menu.addItem(i => i.setTitle(t('library.playerSleepEnd')).onClick(() => np.setSleep('end')));
      if (np.sleep !== null) menu.addItem(i => i.setTitle(t('library.playerSleepOff')).setIcon('x').onClick(() => np.setSleep(null)));
      menu.showAtMouseEvent(evt);
    });
    const sleepLabel = sleep.createSpan('mo-np-sleep-label');

    const actions = root.createDiv('mo-np-actions');
    const read = iconButton(actions, 'file-text', t('library.playerReadAlongShort'), 'mo-np-action', () => {
      this.close();
      void np.openTranscript();
    });
    const list = actions.createEl('button', { cls: 'mo-np-action mo-np-list' });
    setIcon(list.createSpan('mo-np-action-icon'), 'list-music');
    const listLabel = list.createSpan();
    list.addEventListener('click', () => new PlaylistModal(plugin).open());
    iconButton(actions, 'square', t('library.stop'), 'mo-np-action', () => {
      np.stop();
      this.close();
    });

    const paint = () => {
      const track = np.track;
      if (!track) {
        this.close();
        return;
      }
      if (coverFor !== track.subtitle) {
        coverFor = track.subtitle;
        coverSlot.empty();
        renderCover(coverSlot, track.subtitle, 'is-medium');
      }
      title.setText(track.title);
      subtitle.setText([track.subtitle, np.local ? t('library.playerFromDevice') : ''].filter(Boolean).join(' · '));
      lyrics.paint();
      read.toggle(!!track.transcript);
      paintPlay(play, np.playing);
      const d = np.duration;
      at.setText(formatDuration(np.time));
      left.setText(d ? `-${formatDuration(Math.max(0, d - np.time))}` : '');
      wave.paint();
      rate.setText(`${np.rate}×`);
      const s = np.sleep;
      sleepLabel.setText(s === 'end' ? t('library.playerSleepEndShort') : typeof s === 'number' ? `${Math.max(1, Math.ceil((s - Date.now()) / 60000))}′` : '');
      sleep.toggleClass('is-on', s !== null);
      const count = plugin.playlist.entries.length;
      listLabel.setText(count ? t('library.playlistCount', { count }) : t('library.tabPlaylist'));
      const e = cache.entry(track.key);
      const p = cache.progress(track.key);
      const kept = cache.complete(track.key) && e?.kind === 'kept';
      keep.toggle(cache.available);
      if (keep.dataset.icon !== (kept ? 'check' : 'download')) {
        keep.dataset.icon = kept ? 'check' : 'download';
        setIcon(keep, kept ? 'check' : 'download');
        keep.appendChild(keepLabel);
      }
      keepLabel.setText(p?.active && e?.kind === 'kept' ? `${p.size ? Math.floor((p.have / p.size) * 100) : 0}%` : '');
      keep.setAttr('aria-label', kept ? t('library.cacheKept') : track.size ? t('library.cacheDownloadSized', { size: formatSize(track.size) }) : t('library.cacheDownload'));
    };
    paint();
    const offNp = np.subscribe(paint);
    const offCache = cache.subscribe(paint);
    const offList = plugin.playlist.subscribe(paint);
    this.unsubscribe = () => {
      offNp();
      offCache();
      offList();
    };
  }

  onClose(): void {
    document.body.removeClass('mo-np-open');
    this.unsubscribe?.();
    this.contentEl.empty();
  }
}

/**
 * The playlist: what plays next, in order. Tap one to play it; drag the
 * handle to move it; remove one, or clear them all. In the library's own
 * tab, and over the player.
 */
export function renderPlaylist(parent: HTMLElement, plugin: MediaTranscriptPlugin): () => void {
  const { playlist, nowPlaying: np } = plugin;
  const root = parent.createDiv('mo-pl');
  const paint = () => {
    root.empty();
    const entries = playlist.entries;
    const head = root.createDiv('mo-pl-head');
    head.createSpan({ cls: 'mo-pl-count', text: t('library.playlistItems', { count: entries.length }) });
    if (entries.length) {
      const clear = head.createEl('button', { cls: 'mo-pl-clear', text: t('library.playlistClear') });
      clear.addEventListener('click', () => playlist.clear());
    }
    if (entries.length === 0) {
      root.createDiv({ cls: 'mo-pl-empty', text: t('library.playlistEmpty') });
      return;
    }
    const list = root.createDiv('mo-pl-list');
    entries.forEach((e, i) => renderEntry(list, e, i));
  };
  const renderEntry = (list: HTMLElement, e: QueueEntry, index: number) => {
    const row = list.createDiv('mo-pl-row');
    const playing = np.track?.path === e.path;
    row.toggleClass('is-playing', playing);
    const grip = row.createDiv({ cls: 'mo-pl-grip', attr: { 'aria-label': t('library.playlistMove') } });
    setIcon(grip, 'grip-vertical');
    // Entries saved by an older version have the path for a title and no subtitle.
    const named = e.title.includes('/') && e.title === e.path;
    const title = named ? e.path.slice(e.path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '') : e.title;
    const subtitle = e.subtitle || (named ? e.path.slice(0, e.path.indexOf('/')) : '');
    renderCover(row, subtitle, 'is-small');
    const main = row.createDiv('mo-pl-main');
    main.createDiv({ cls: 'mo-pl-title', text: title });
    const stats = plugin.cache.statsOf(e.key);
    const meta = [subtitle];
    if (stats?.duration) meta.push(stats.position > 10 ? t('library.playlistLeft', { time: formatDuration(Math.max(0, stats.duration - stats.position)) }) : formatDuration(stats.duration));
    main.createDiv({ cls: 'mo-pl-meta', text: meta.filter(Boolean).join(' · ') });
    if (playing) {
      const eq = row.createDiv('mo-pl-now');
      setIcon(eq, np.playing ? 'volume-2' : 'pause');
    }
    iconButton(row, 'x', t('library.playlistRemove'), 'mo-pl-remove', () => playlist.remove(e.path));
    main.addEventListener('click', () => {
      if (playing) np.toggle();
      else np.playEntry(e);
    });
    dragToMove(grip, row, list, index, to => playlist.move(index, to));
  };
  paint();
  const offList = playlist.subscribe(paint);
  let playingNow: string | null = np.track?.path ?? null;
  let wasPlaying = np.playing;
  const offNp = np.subscribe(() => {
    // Only when what plays (or whether it plays) changes, not as it plays.
    if ((np.track?.path ?? null) === playingNow && np.playing === wasPlaying) return;
    playingNow = np.track?.path ?? null;
    wasPlaying = np.playing;
    paint();
  });
  return () => {
    offList();
    offNp();
    root.remove();
  };
}

/** Drag a row by its handle (mouse or finger) to another place in the list. */
function dragToMove(grip: HTMLElement, row: HTMLElement, list: HTMLElement, from: number, done: (to: number) => void): void {
  grip.addEventListener('pointerdown', evt => {
    evt.preventDefault();
    evt.stopPropagation();
    grip.setPointerCapture(evt.pointerId);
    const rows = Array.from(list.children) as HTMLElement[];
    const startY = evt.clientY;
    let to = from;
    row.addClass('is-dragging');
    const move = (e: PointerEvent) => {
      const dy = e.clientY - startY;
      row.style.setProperty('--mo-drag', `${dy}px`);
      const mid = row.getBoundingClientRect().top + row.offsetHeight / 2;
      to = rows.filter((r, i) => i !== from && r.getBoundingClientRect().top + r.offsetHeight / 2 < mid).length;
      rows.forEach((r, i) => {
        if (i === from) return;
        const shift = i > from && i <= to ? -row.offsetHeight : i < from && i >= to ? row.offsetHeight : 0;
        r.style.setProperty('--mo-drag', `${shift}px`);
      });
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      rows.forEach(r => r.style.removeProperty('--mo-drag'));
      row.removeClass('is-dragging');
      if (to !== from) done(to);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
}

/** The playlist over whatever is on screen (from the player bar, or the player). */
export class PlaylistModal extends Modal {
  private remove: (() => void) | null = null;

  constructor(private readonly plugin: MediaTranscriptPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass('mo-pl-modal');
    this.setTitle(t('library.tabPlaylist'));
    this.remove = renderPlaylist(this.contentEl, this.plugin);
  }

  onClose(): void {
    this.remove?.();
    this.contentEl.empty();
  }
}

/**
 * The player away from the library, so what plays can always be paused or
 * stopped: in the status bar on a computer, floating above the navigation bar
 * on a phone (hidden while the library, with its own bar, is in view). Tap
 * what plays to open it in full.
 */
export class MiniPlayer {
  private readonly el: HTMLElement;
  private readonly bar: { paint: () => void } | null = null;
  private readonly play: HTMLButtonElement | null = null;
  private readonly label: HTMLElement | null = null;

  constructor(private readonly plugin: MediaTranscriptPlugin, private readonly np: NowPlaying) {
    if (Platform.isMobile) {
      const bar = renderBar(document.body, plugin, 'mo-mini-player', () => !this.libraryInView());
      this.el = bar.el;
      this.bar = bar;
      plugin.register(bar.remove);
      plugin.register(() => this.liftButton(0));
    } else {
      this.el = plugin.addStatusBarItem();
      this.el.addClass('mo-mini-player-status');
      this.play = iconButton(this.el, 'play', t('library.menuPlay'), 'mo-mini-play', () => np.toggle());
      this.label = this.el.createDiv('mo-mini-label');
      this.label.addEventListener('click', () => new NowPlayingModal(plugin).open());
      iconButton(this.el, 'x', t('library.stop'), 'mo-mini-close', () => np.stop());
    }
    plugin.register(np.subscribe(() => this.paint()));
    plugin.registerEvent(plugin.app.workspace.on('layout-change', () => this.paint()));
    plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', () => this.paint()));
    this.paint();
  }

  private paint(): void {
    const { np, el } = this;
    const track: Track | null = np.track;
    if (this.bar) {
      this.bar.paint();
      if (track && !el.hasClass('is-hidden')) this.place();
      else this.liftButton(0);
      return;
    }
    el.toggleClass('is-hidden', !track);
    if (!track) return;
    if (this.play) paintPlay(this.play, np.playing);
    const d = np.duration;
    this.label?.setText(`${track.title} · ${formatDuration(np.time)}${d ? ` / ${formatDuration(d)}` : ''}`);
  }

  /**
   * On a phone: just above the navigation bar and as wide (a tablet has
   * none: the foot of the screen). The page's floating button, where the bar
   * would cover it, moves up above the bar, as a music app's would.
   */
  private place(): void {
    const nav = document.querySelector('.mobile-navbar')?.getBoundingClientRect();
    const gap = 8;
    const hasNav = !!nav && nav.height > 0;
    const floor = hasNav ? nav.top : window.innerHeight - 12;
    this.el.style.setProperty('--mo-mini-bottom', `${window.innerHeight - floor + (hasNav ? gap : 0)}px`);
    this.el.style.setProperty('--mo-mini-left', `${hasNav ? nav.left : 12}px`);
    this.el.style.setProperty('--mo-mini-right', `${hasNav ? window.innerWidth - nav.right : 12}px`);
    const top = floor - (hasNav ? gap : 0) - this.el.offsetHeight;
    let lift = 0;
    for (const button of Array.from(document.querySelectorAll<HTMLElement>('.view-actions.mod-raised .view-action'))) {
      const fab = button.getBoundingClientRect();
      if (fab.width === 0) continue;
      // Where it is when not moved: less how far it is moved now (midway, as it moves).
      const moved = getComputedStyle(button).translate;
      const bottom = fab.bottom - (moved && moved !== 'none' ? parseFloat(moved.split(' ')[1] ?? '0') || 0 : 0);
      if (bottom > top) lift = Math.max(lift, Math.ceil(bottom - top + gap));
    }
    this.liftButton(lift);
  }

  private lift = 0;

  private liftButton(px: number): void {
    if (px === this.lift) return;
    this.lift = px;
    document.body.toggleClass('mo-fab-lifted', px > 0);
    document.body.style.setProperty('--mo-fab-lift', `${px}px`);
  }

  /** The library on screen: its own bar is there. */
  private libraryInView(): boolean {
    const leaf = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_LIBRARY)[0];
    if (!leaf) return false;
    const root = leaf.getRoot() as { collapsed?: boolean };
    return leaf.view.containerEl.isShown() && !root.collapsed;
  }
}
