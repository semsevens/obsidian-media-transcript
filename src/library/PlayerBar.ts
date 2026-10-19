import { Menu, Modal, Platform, setIcon } from 'obsidian';
import type MediaTranscriptPlugin from '../main';
import { formatDuration } from './mediaInfo';
import type { NowPlaying } from './NowPlaying';
import { formatSize } from '../utils/format';
import { t } from '../i18n';

const VIEW_TYPE_LIBRARY = 'media-one-library';

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

/**
 * The player bar, the same wherever it is (at the foot of the library,
 * floating above a phone's navigation): play or pause, what is playing and
 * the line being said, stop. Tap it to open what is playing in full.
 * Hidden while nothing plays. Returns how to take it down.
 */
export function renderBar(parent: HTMLElement, plugin: MediaTranscriptPlugin, cls: string, shown: () => boolean = () => true): { el: HTMLElement; paint: () => void; remove: () => void } {
  const np = plugin.nowPlaying;
  const bar = parent.createDiv(`mo-bar ${cls}`);
  const play = iconButton(bar, 'play', t('library.menuPlay'), 'mo-bar-play', () => np.toggle());
  const text = bar.createDiv('mo-bar-text');
  const title = text.createDiv('mo-bar-title');
  const line = text.createDiv('mo-bar-line');
  text.addEventListener('click', () => new NowPlayingModal(plugin).open());
  iconButton(bar, 'x', t('library.stop'), 'mo-bar-close', () => np.stop());
  const progress = bar.createDiv('mo-bar-progress');
  const paint = () => {
    const track = np.track;
    bar.toggleClass('is-hidden', !track || !shown());
    if (!track) return;
    paintPlay(play, np.playing);
    title.setText(track.title);
    const d = np.duration;
    const said = np.failed ? t('library.playerOffline') : np.line;
    line.setText(said || (d ? `${formatDuration(np.time)} / ${formatDuration(d)}` : formatDuration(np.time)));
    line.toggleClass('is-error', np.failed);
    progress.style.width = d ? `${(np.time / d) * 100}%` : '0';
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

/**
 * What is playing, in full: the lines being said, where it is, the controls,
 * the speed, keeping it on this device, and reading along in its transcript.
 * A modal, so a phone's back closes it.
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
    const title = root.createDiv('mo-np-title');
    const subtitle = root.createDiv('mo-np-subtitle');
    const lines = root.createDiv('mo-np-lines');
    const before = lines.createDiv('mo-np-line is-before');
    const now = lines.createDiv('mo-np-line is-now');
    const after = lines.createDiv('mo-np-line is-after');
    lines.setAttr('aria-label', t('library.playerReadAlong'));
    lines.addEventListener('click', () => {
      this.close();
      void np.openTranscript();
    });

    const seek = root.createEl('input', { type: 'range', cls: 'mo-np-seek', attr: { min: '0', max: '1000', value: '0', 'aria-label': t('library.seek') } });
    let dragging = false;
    seek.addEventListener('input', () => {
      dragging = true;
      if (np.duration) np.seek((Number(seek.value) / 1000) * np.duration);
    });
    seek.addEventListener('change', () => { dragging = false; });
    const times = root.createDiv('mo-np-times');
    const at = times.createSpan();
    const left = times.createSpan();

    const controls = root.createDiv('mo-np-controls');
    const rate = controls.createEl('button', { cls: 'mo-np-rate', attr: { 'aria-label': t('library.playerRate') } });
    rate.addEventListener('click', () => np.nextRate());
    iconButton(controls, 'rotate-ccw', t('library.playerBack'), 'mo-np-back', () => np.back());
    const play = iconButton(controls, 'play', t('library.menuPlay'), 'mo-np-play', () => np.toggle());
    iconButton(controls, 'rotate-cw', t('library.playerAhead'), 'mo-np-ahead', () => np.ahead());
    iconButton(controls, 'square', t('library.stop'), 'mo-np-stop', () => {
      np.stop();
      this.close();
    });

    const actions = root.createDiv('mo-np-actions');
    const read = actions.createEl('button', { cls: 'mo-np-action', text: t('library.playerReadAlongShort') });
    setIcon(read.createSpan({ cls: 'mo-np-action-icon', prepend: true }), 'file-text');
    read.addEventListener('click', () => {
      this.close();
      void np.openTranscript();
    });
    const keep = actions.createEl('button', { cls: 'mo-np-action mo-np-keep' });
    keep.addEventListener('click', evt => {
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
    const library = actions.createEl('button', { cls: 'mo-np-action', text: t('library.playerShowLibrary') });
    library.addEventListener('click', () => {
      this.close();
      void plugin.openLibrary();
    });

    const paint = () => {
      const track = np.track;
      if (!track) {
        this.close();
        return;
      }
      title.setText(track.title);
      subtitle.setText([track.subtitle, np.local ? t('library.playerFromDevice') : ''].filter(Boolean).join(' · '));
      const [b, n, a] = np.around;
      before.setText(b);
      now.setText(np.failed ? t('library.playerOffline') : n);
      now.toggleClass('is-error', np.failed);
      after.setText(a);
      lines.toggle(!!track.transcript || np.failed);
      read.toggle(!!track.transcript);
      paintPlay(play, np.playing);
      const d = np.duration;
      if (!dragging && d) seek.value = String(Math.round((np.time / d) * 1000));
      seek.style.setProperty('--mo-progress', `${Number(seek.value) / 10}%`);
      at.setText(formatDuration(np.time));
      left.setText(d ? `-${formatDuration(Math.max(0, d - np.time))}` : '');
      rate.setText(`${np.rate}×`);
      const e = cache.entry(track.key);
      const p = cache.progress(track.key);
      const label = !cache.available ? null
        : cache.complete(track.key) ? (e?.kind === 'kept' ? t('library.cacheKept') : t('library.cacheKeep'))
          : p && e?.kind === 'kept' ? t('library.cacheDownloading', { percent: percent(p.have, p.size) })
            : t('library.cacheDownload');
      keep.toggle(label !== null);
      keep.empty();
      setIcon(keep.createSpan('mo-np-action-icon'), cache.complete(track.key) && e?.kind === 'kept' ? 'check' : 'download');
      keep.createSpan({ text: label ?? '' });
      keep.setAttr('title', track.size ? formatSize(track.size) : '');
    };
    paint();
    const offNp = np.subscribe(paint);
    const offCache = cache.subscribe(paint);
    this.unsubscribe = () => {
      offNp();
      offCache();
    };
  }

  onClose(): void {
    document.body.removeClass('mo-np-open');
    this.unsubscribe?.();
    this.contentEl.empty();
  }
}

function percent(have: number, size: number): number {
  return size ? Math.floor((have / size) * 100) : 0;
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
    const track = np.track;
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
