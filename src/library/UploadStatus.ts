import { Notice, Platform, setIcon } from 'obsidian';
import type MediaTranscriptPlugin from '../main';
import type { UploadStatus } from './uploader';
import { formatSize } from '../utils/format';
import { t } from '../i18n';

/** No piece in for this long: the line is stuck, not just slow. */
const STALLED_MS = 20_000;

/** "3 分钟", "40 秒", "1 小时 5 分钟": how long, roughly. */
export function roughly(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return t('library.uploadSeconds', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t('library.uploadMinutes', { n: m });
  return t('library.uploadHours', { h: Math.floor(m / 60), m: m % 60 });
}

/** The short form (the status bar) and the line under the name (the library, the tooltip). */
export function describe(s: UploadStatus, now = Date.now()): { short: string; detail: string } {
  const percent = s.size ? Math.min(99, Math.floor((s.sent / s.size) * 100)) : 0;
  const amount = `${formatSize(s.sent)} / ${formatSize(s.size)}`;
  const parts: string[] = [];
  let short: string;
  if (s.state === 'checking') {
    short = t('library.uploadShortChecking');
    parts.push(t('library.uploadDetailChecking'));
  } else if (s.state === 'waiting') {
    short = t('library.uploadShortWaiting', { percent });
    parts.push(amount, t('library.uploadDetailWaiting', { when: roughly(((s.retryAt ?? now) - now) / 1000) }));
  } else {
    short = s.sent ? `${percent}%` : t('library.uploadShortStarting');
    parts.push(amount);
    // Nothing has gone in for a while: a speed and time left from before would mislead.
    if (now - s.moved > STALLED_MS) parts.push(t('library.uploadDetailStalled'));
    else if (s.rate > 0) {
      parts.push(`${formatSize(s.rate)}/s`);
      parts.push(t('library.uploadDetailLeft', { left: roughly((s.size - s.sent) / s.rate) }));
    }
  }
  if (s.queued) parts.push(t('library.uploadDetailQueued', { count: s.queued }));
  return { short, detail: parts.join(' · ') };
}

/**
 * Shows what is being uploaded without getting in the way: a small item in
 * the status bar on a computer (hover for the detail, click for the library);
 * on a phone, which has no status bar, a brief note when an upload begins.
 * The library shows it in full on either (see ActivityPanel).
 */
export class UploadIndicator {
  private readonly el: HTMLElement | null = null;
  private readonly text: HTMLElement | null = null;
  private announced: string | null = null;

  constructor(private readonly plugin: MediaTranscriptPlugin) {
    if (!Platform.isMobile) {
      this.el = plugin.addStatusBarItem();
      this.el.addClass('mo-upload-status', 'is-hidden', 'mod-clickable');
      setIcon(this.el.createSpan('mo-upload-status-icon'), 'upload');
      this.text = this.el.createSpan('mo-upload-status-text');
      this.el.addEventListener('click', () => void plugin.openLibrary());
    }
    plugin.register(plugin.uploader.subscribe(() => this.paint()));
    // The countdown to the next try moves on its own.
    plugin.registerInterval(window.setInterval(() => {
      if (plugin.uploader.status && plugin.uploader.status.state !== 'checking') this.paint();
    }, 5000));
    this.paint();
  }

  private paint(): void {
    const s = this.plugin.uploader.status;
    if (!s) {
      this.announced = null;
      this.el?.addClass('is-hidden');
      return;
    }
    if (Platform.isMobile && this.announced !== s.name) {
      this.announced = s.name;
      new Notice(t('library.uploadStarted', { name: s.name }), 4000);
    }
    if (!this.el || !this.text) return;
    const { short, detail } = describe(s);
    this.el.removeClass('is-hidden');
    this.el.toggleClass('is-waiting', s.state === 'waiting');
    this.text.setText(short);
    this.el.setAttribute('aria-label', `${t('library.uploadTitle', { name: s.name })}\n${detail}`);
    this.el.setAttribute('data-tooltip-position', 'top');
  }
}
