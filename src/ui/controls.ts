import { Menu, setIcon } from 'obsidian';
import { formatDuration } from '../library/mediaInfo';
import { t } from '../i18n';

export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

export interface ControlsOptions {
  /** A card in a note: one row, no skip buttons. */
  compact?: boolean;
  /** Items of its own for the ⋯ menu; without, there is no ⋯. */
  more?: (menu: Menu) => void;
  /** A video: a button to show it full screen. */
  video?: HTMLVideoElement;
}

/** An icon button (Obsidian's look), its label for screen readers and the tooltip. */
export function iconButton(parent: HTMLElement, icon: string, label: string, cls = '', onClick?: (evt: MouseEvent) => void): HTMLButtonElement {
  const b = parent.createEl('button', { cls: `clickable-icon mo-icon-btn ${cls}`.trim(), attr: { 'aria-label': label } });
  setIcon(b, icon);
  if (onClick) b.addEventListener('click', evt => {
    evt.stopPropagation();
    onClick(evt);
  });
  return b;
}

/**
 * Controls for a player of our own in place of the browser's: play, where it
 * is along a bar that can be dragged (or stepped with the arrow keys), the
 * time, back 15 s and ahead 30 s, the speed, and a ⋯ for the rest. The media
 * element is the one that plays; this only steers it and shows what it does.
 */
export function renderControls(parent: HTMLElement, el: HTMLMediaElement, opts: ControlsOptions = {}): { el: HTMLElement; destroy: () => void } {
  const root = parent.createDiv(`mo-ctl${opts.compact ? ' is-compact' : ''}`);
  const play = root.createEl('button', { cls: 'mo-ctl-play', attr: { 'aria-label': t('library.menuPlay') } });
  const playIcon = play.createSpan('mo-ctl-play-icon');
  play.addEventListener('click', evt => {
    evt.stopPropagation();
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  });

  const at = root.createSpan('mo-ctl-time mo-ctl-at');
  const bar = root.createDiv({ cls: 'mo-ctl-bar', attr: { role: 'slider', tabindex: '0', 'aria-label': t('core.seek') } });
  const buffered = bar.createDiv('mo-ctl-buffered');
  const played = bar.createDiv('mo-ctl-played');
  const thumb = bar.createDiv('mo-ctl-thumb');
  const end = root.createSpan('mo-ctl-time mo-ctl-end');

  if (!opts.compact) {
    const back = iconButton(root, 'rotate-ccw', t('library.playerBack'), 'mo-ctl-skip', () => { el.currentTime = Math.max(0, el.currentTime - 15); });
    back.createSpan({ cls: 'mo-ctl-skip-n', text: '15' });
    const ahead = iconButton(root, 'rotate-cw', t('library.playerAhead'), 'mo-ctl-skip', () => {
      el.currentTime = Math.min(el.duration || Infinity, el.currentTime + 30);
    });
    ahead.createSpan({ cls: 'mo-ctl-skip-n', text: '30' });
  }

  const rate = root.createEl('button', { cls: 'mo-ctl-rate', attr: { 'aria-label': t('library.playerRate') } });
  rate.addEventListener('click', evt => {
    evt.stopPropagation();
    const menu = new Menu();
    for (const r of RATES) menu.addItem(i => i.setTitle(`${r}×`).setChecked(el.playbackRate === r).onClick(() => { el.playbackRate = r; }));
    menu.showAtMouseEvent(evt);
  });

  if (opts.video) {
    const video = opts.video;
    iconButton(root, 'maximize', t('core.fullscreen'), 'mo-ctl-full', () => { void video.requestFullscreen().catch(() => {}); });
  }
  if (opts.more) {
    const more = opts.more;
    iconButton(root, 'more-horizontal', t('core.moreActions'), 'mo-ctl-more', evt => {
      const menu = new Menu();
      more(menu);
      menu.showAtMouseEvent(evt);
    });
  }

  // Dragging: where the finger is, shown at once; the media seeks when let go.
  let drag: number | null = null;
  const share = (evt: PointerEvent) => {
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (evt.clientX - r.left) / r.width));
  };
  bar.addEventListener('pointerdown', evt => {
    evt.stopPropagation();
    bar.setPointerCapture(evt.pointerId);
    drag = share(evt);
    root.addClass('is-dragging');
    paint();
  });
  bar.addEventListener('pointermove', evt => {
    if (drag === null) return;
    drag = share(evt);
    paint();
  });
  const letGo = () => {
    if (drag !== null && el.duration) el.currentTime = drag * el.duration;
    drag = null;
    root.removeClass('is-dragging');
    paint();
  };
  bar.addEventListener('pointerup', letGo);
  bar.addEventListener('pointercancel', () => {
    drag = null;
    root.removeClass('is-dragging');
    paint();
  });
  bar.addEventListener('click', evt => evt.stopPropagation());
  bar.addEventListener('keydown', evt => {
    const step = evt.key === 'ArrowLeft' ? -5 : evt.key === 'ArrowRight' ? 5 : 0;
    if (step) {
      evt.preventDefault();
      el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + step));
    } else if (evt.key === ' ') {
      evt.preventDefault();
      play.click();
    }
  });

  let icon = '';
  const paint = () => {
    const d = Number.isFinite(el.duration) ? el.duration : 0;
    const now = drag !== null ? drag * d : el.currentTime;
    const p = d ? Math.min(1, now / d) : 0;
    played.style.width = `${p * 100}%`;
    thumb.style.left = `${p * 100}%`;
    let loaded = 0;
    for (let i = 0; i < el.buffered.length; i++) {
      if (el.buffered.start(i) <= el.currentTime + 0.5) loaded = Math.max(loaded, el.buffered.end(i));
    }
    buffered.style.width = d ? `${Math.min(1, loaded / d) * 100}%` : '0';
    at.setText(formatDuration(now));
    end.setText(d ? formatDuration(d) : '--:--');
    bar.setAttr('aria-valuenow', String(Math.round(now)));
    bar.setAttr('aria-valuemax', String(Math.round(d)));
    const next = el.paused ? 'play' : 'pause';
    if (next !== icon) {
      icon = next;
      setIcon(playIcon, next);
      play.setAttr('aria-label', t(el.paused ? 'library.menuPlay' : 'library.playerPause'));
    }
    root.toggleClass('is-playing', !el.paused);
    rate.setText(`${el.playbackRate}×`);
    rate.toggleClass('is-changed', el.playbackRate !== 1);
  };
  const waiting = () => root.addClass('is-waiting');
  const going = () => root.removeClass('is-waiting');
  const failed = () => root.toggleClass('is-failed', !!el.error && !!el.getAttribute('src'));
  const events: Array<[string, () => void]> = [
    ['timeupdate', paint], ['durationchange', paint], ['loadedmetadata', paint], ['progress', paint],
    ['play', paint], ['pause', paint], ['ratechange', paint], ['emptied', paint],
    ['waiting', waiting], ['playing', going], ['canplay', going], ['pause', going],
    ['error', failed], ['loadstart', failed],
  ];
  for (const [name, fn] of events) el.addEventListener(name, fn);
  paint();
  return {
    el: root,
    destroy: () => {
      for (const [name, fn] of events) el.removeEventListener(name, fn);
      root.remove();
    },
  };
}
