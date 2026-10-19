import { Platform, setIcon } from 'obsidian';
import type MediaTranscriptPlugin from '../main';
import { formatDuration } from './mediaInfo';
import type { NowPlaying } from './NowPlaying';
import { t } from '../i18n';

const VIEW_TYPE_LIBRARY = 'media-one-library';

function iconButton(parent: HTMLElement, icon: string, label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = parent.createEl('button', { cls: `clickable-icon ${cls}`, attr: { 'aria-label': label } });
  setIcon(b, icon);
  b.addEventListener('click', evt => {
    evt.stopPropagation();
    onClick();
  });
  return b;
}

function rateLabel(rate: number): string {
  return `${rate}×`;
}

/**
 * The player at the foot of the media library: what is playing, the line
 * being said (tap it to read along in the transcript), where it is, and the
 * controls. Hidden while nothing plays. Returns how to take it down.
 */
export function renderDock(parent: HTMLElement, np: NowPlaying): () => void {
  const dock = parent.createDiv('mo-player');
  const info = dock.createDiv('mo-player-info');
  const text = info.createDiv('mo-player-text');
  const title = text.createDiv('mo-player-title');
  const caption = text.createDiv('mo-player-caption');
  caption.setAttr('aria-label', t('library.playerReadAlong'));
  caption.addEventListener('click', () => { void np.openTranscript(); });
  iconButton(info, 'x', t('library.stop'), 'mo-player-close', () => np.stop());

  const controls = dock.createDiv('mo-player-controls');
  iconButton(controls, 'rotate-ccw', t('library.playerBack'), 'mo-player-back', () => np.back());
  const play = iconButton(controls, 'play', t('library.menuPlay'), 'mo-player-play', () => np.toggle());
  iconButton(controls, 'rotate-cw', t('library.playerAhead'), 'mo-player-ahead', () => np.ahead());
  const seek = controls.createEl('input', { type: 'range', cls: 'mo-player-seek', attr: { min: '0', max: '1000', value: '0', 'aria-label': t('library.seek') } });
  let dragging = false;
  seek.addEventListener('input', () => {
    dragging = true;
    if (np.duration) np.seek((Number(seek.value) / 1000) * np.duration);
  });
  seek.addEventListener('change', () => { dragging = false; });
  const time = controls.createSpan('mo-player-time');
  const rate = controls.createEl('button', { cls: 'mo-player-rate', attr: { 'aria-label': t('library.playerRate') } });
  rate.addEventListener('click', () => np.nextRate());

  let wasPlaying: boolean | null = null;
  const paint = () => {
    const track = np.track;
    dock.toggleClass('is-hidden', !track);
    if (!track) return;
    title.setText(track.title);
    const line = np.line;
    caption.setText(line);
    caption.toggle(!!track.transcript);
    caption.toggleClass('is-empty', !line);
    if (np.playing !== wasPlaying) {
      wasPlaying = np.playing;
      setIcon(play, np.playing ? 'pause' : 'play');
      play.setAttr('aria-label', t(np.playing ? 'library.playerPause' : 'library.menuPlay'));
    }
    const d = np.duration;
    if (!dragging && d) seek.value = String(Math.round((np.time / d) * 1000));
    seek.style.setProperty('--mo-progress', `${Number(seek.value) / 10}%`);
    time.setText(d ? `${formatDuration(np.time)} / ${formatDuration(d)}` : formatDuration(np.time));
    rate.setText(rateLabel(np.rate));
  };
  paint();
  const unsubscribe = np.subscribe(paint);
  return () => {
    unsubscribe();
    dock.remove();
  };
}

/**
 * The player away from the library, so what plays can always be paused or
 * stopped: in the status bar on a computer, floating above the navigation bar
 * on a phone (hidden while the library, with its own player, is in view).
 * Tapping what plays opens the library.
 */
export class MiniPlayer {
  private readonly el: HTMLElement;
  private readonly play: HTMLButtonElement;
  private readonly label: HTMLElement;
  private readonly progress: HTMLElement | null = null;
  private wasPlaying: boolean | null = null;

  constructor(private readonly plugin: MediaTranscriptPlugin, private readonly np: NowPlaying) {
    if (Platform.isMobile) {
      this.el = document.body.createDiv('mo-mini-player');
      plugin.register(() => this.el.remove());
    } else {
      this.el = plugin.addStatusBarItem();
      this.el.addClass('mo-mini-player-status');
    }
    this.play = iconButton(this.el, 'play', t('library.menuPlay'), 'mo-mini-play', () => np.toggle());
    this.label = this.el.createDiv('mo-mini-label');
    this.label.addEventListener('click', () => { void plugin.openLibrary(); });
    iconButton(this.el, 'x', t('library.stop'), 'mo-mini-close', () => np.stop());
    if (Platform.isMobile) this.progress = this.el.createDiv('mo-mini-progress');
    plugin.register(np.subscribe(() => this.paint()));
    plugin.registerEvent(plugin.app.workspace.on('layout-change', () => this.paint()));
    plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', () => this.paint()));
    this.paint();
  }

  private paint(): void {
    const { np, el } = this;
    const track = np.track;
    const shown = !!track && !(Platform.isMobile && this.libraryInView());
    el.toggleClass('is-hidden', !shown);
    if (!track || !shown) return;
    if (np.playing !== this.wasPlaying) {
      this.wasPlaying = np.playing;
      setIcon(this.play, np.playing ? 'pause' : 'play');
      this.play.setAttr('aria-label', t(np.playing ? 'library.playerPause' : 'library.menuPlay'));
    }
    const d = np.duration;
    if (this.progress) {
      this.progress.style.width = d ? `${(np.time / d) * 100}%` : '0';
      this.label.setText(track.title);
    } else {
      this.label.setText(`${track.title} · ${formatDuration(np.time)}${d ? ` / ${formatDuration(d)}` : ''}`);
    }
  }

  /** The library on screen: its own player is there. */
  private libraryInView(): boolean {
    const leaf = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_LIBRARY)[0];
    if (!leaf) return false;
    const root = leaf.getRoot() as { collapsed?: boolean };
    return leaf.view.containerEl.isShown() && !root.collapsed;
  }
}
