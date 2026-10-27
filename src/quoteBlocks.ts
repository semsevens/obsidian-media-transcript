import { App, MarkdownPostProcessorContext, Modal, Notice, Setting, TFile, parseLinktext, setIcon } from 'obsidian';
import type MediaTranscriptPlugin from './main';
import type { ResolvedMedia } from './mediaLocator';
import { parseTimeRange } from './utils/timeFragment';
import { parseSubtitle, SubtitleSegment, formatTime } from './utils/subtitleParser';
import { QUOTE_CALLOUT, comparable, quoteOutdated, textBetween, updatedQuote } from './utils/quote';
import { SUBTITLE_EXTENSIONS } from './utils/subtitleFinder';
import { subtitleBaseName } from './utils/mediaMatch';
import { t } from './i18n';

/** How many quotes kept as written (the transcript changed, the quote not) are remembered. */
const KEPT_MAX = 500;

/**
 * Quotes of a transcript in notes (see utils/quote): a quote callout whose
 * title links to a passage, `[[talk.json#t=83,97|…]]`, gets
 *   ▶ play just that passage, here, without leaving the note
 *   ↗ open the transcript at it, the passage shown
 * and, when the transcript has since been corrected so the quote no longer
 * says what it does, a note saying so — with the corrected words to take or
 * leave. A note is never changed without being asked.
 */
export class QuoteBlocks {
  private lines = new Map<string, { mtime: number; segments: SubtitleSegment[] }>();
  private playing: { audio: HTMLAudioElement; done: () => void } | null = null;
  /** Quotes drawn, to look at again when their transcript changes. */
  private shown = new Set<{ callout: HTMLElement; transcript: TFile; check: () => Promise<void> }>();

  constructor(private readonly plugin: MediaTranscriptPlugin) {}

  start() {
    this.plugin.registerMarkdownPostProcessor((el, ctx) => {
      const callouts = el.matches('.callout') ? [el] : Array.from(el.querySelectorAll<HTMLElement>('.callout'));
      for (const callout of callouts) void this.enhance(callout, ctx);
    });
    this.plugin.register(() => this.stopPlaying());
    // A transcript corrected while its quotes are on screen: they say so now, not on reopening.
    this.plugin.registerEvent(this.plugin.app.vault.on('modify', file => {
      for (const q of this.shown) {
        if (!q.callout.isConnected) this.shown.delete(q);
        else if (q.transcript.path === file.path) void q.check();
      }
    }));
  }

  private async enhance(callout: HTMLElement, ctx: MarkdownPostProcessorContext) {
    if (callout.dataset.callout !== QUOTE_CALLOUT) return;
    const title = callout.querySelector<HTMLElement>(':scope > .callout-title');
    if (!title || title.querySelector('.mt-quote-actions')) return;
    const link = title.querySelector('a.internal-link');
    const { path, subpath } = parseLinktext(link?.getAttribute('data-href') ?? '');
    const range = parseTimeRange(subpath);
    if (!range || range.end === null) return;
    const transcript = this.transcriptOf(path, ctx.sourcePath);
    if (!transcript) return;
    const { start, end } = { start: range.start, end: range.end };

    callout.addClass('mt-quote');
    const actions = title.createSpan('mt-quote-actions');
    // In Live Preview a press on the callout opens its source for editing;
    // a press on these is theirs alone.
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend']) {
      actions.addEventListener(type, e => e.stopPropagation());
    }
    const button = (icon: string, label: string, fn: (el: HTMLElement) => void) => {
      const b = actions.createEl('button', { cls: 'clickable-icon mt-quote-btn', attr: { 'aria-label': label, title: label } });
      setIcon(b, icon);
      b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); fn(b); });
      return b;
    };
    const time = actions.createSpan('mt-quote-time');
    button('play', t('core.quotePlay'), b => { void this.play(callout, b, time, transcript, start, end); });
    button('arrow-up-right', t('core.quoteOpen'), () => {
      this.stopPlaying();
      void this.plugin.openTranscript(transcript, start, false, end);
    });

    const check = async () => {
      actions.querySelector('.mt-quote-outdated')?.remove();
      const segments = await this.linesOf(transcript);
      const source = textBetween(segments, start, end);
      const quoted = callout.querySelector<HTMLElement>(':scope > .callout-content')?.innerText ?? '';
      if (!source || !quoteOutdated(quoted, source)) return;
      const key = `${transcript.path}#${start},${end}#${comparable(quoted)}`;
      if (this.plugin.settings.quotesKept.includes(key)) return;
      const chip = actions.createEl('button', { cls: 'mt-quote-outdated', text: t('core.quoteOutdated') });
      chip.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        new OutdatedQuoteModal(this.plugin.app, quoted.trim(), updatedQuote(quoted, source), {
          update: text => { void this.rewrite(ctx.sourcePath, subpath, quoted, text); },
          keep: () => {
            const kept = [...this.plugin.settings.quotesKept.filter(k => k !== key), key].slice(-KEPT_MAX);
            this.plugin.settings.quotesKept = kept;
            void this.plugin.saveSettings();
            chip.remove();
          },
        }).open();
      });
    };
    this.shown.add({ callout, transcript, check });
    await check();
  }

  /** The transcript a quote's link points at, or the one now standing for its media. */
  private transcriptOf(path: string, sourcePath: string): TFile | null {
    const file = this.plugin.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
    if (file && SUBTITLE_EXTENSIONS.includes(file.extension.toLowerCase())) return file;
    const name = path.replace(/^.*[\\/]/, '');
    if (file && this.plugin.isMedia(file)) return this.plugin.cards.transcriptFor(file.name);
    if (file) return null;
    // Gone: a media file moved out of the vault, or a track since replaced
    // (transcribed again, by another model) — any transcript of the same media.
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    if (this.plugin.cards.isMediaName(name)) return this.plugin.cards.transcriptFor(name);
    if (SUBTITLE_EXTENSIONS.includes(ext)) return this.plugin.cards.transcriptFor(`${subtitleBaseName(name)}.media`);
    return null;
  }

  private async linesOf(file: TFile): Promise<SubtitleSegment[]> {
    const known = this.lines.get(file.path);
    if (known && known.mtime === file.stat.mtime) return known.segments;
    try {
      const segments = parseSubtitle(await this.plugin.app.vault.cachedRead(file), file.extension);
      this.lines.set(file.path, { mtime: file.stat.mtime, segments });
      return segments;
    } catch {
      return [];
    }
  }

  // ─── Playing ──────────────────────────────────────────────────────────────

  private async play(callout: HTMLElement, button: HTMLElement, time: HTMLElement, transcript: TFile, start: number, end: number) {
    const current = this.playing;
    if (current && current.audio.parentElement === callout) {
      if (current.audio.paused) void current.audio.play().catch(() => {});
      else current.audio.pause();
      return;
    }
    this.stopPlaying();
    setIcon(button, 'loader');
    let media: ResolvedMedia | null;
    try {
      media = (await this.plugin.mediaLocator.resolveForSubtitle(transcript)).media;
    } catch {
      media = null;
    }
    if (!media) {
      setIcon(button, 'play');
      new Notice(t('core.noMediaTranscriptOnly'));
      return;
    }
    // Only the sound is wanted: a video's audio twin starts sooner.
    const played = media.audioTwin ?? media;
    // On the page, so starting it pauses anything else playing (the library's player).
    const audio = callout.createEl('audio', { cls: 'mt-quote-audio', attr: { preload: 'auto' } });
    const show = () => {
      if (this.playing?.audio !== audio) return; // stopped: its last pause says nothing
      setIcon(button, audio.paused ? 'play' : 'pause');
      time.setText(`${formatTime(Math.max(0, audio.currentTime - start))} / ${formatTime(end - start)}`);
    };
    const done = () => {
      audio.pause();
      audio.removeAttribute('src');
      audio.remove();
      setIcon(button, 'play');
      time.setText('');
      if (this.playing?.audio === audio) this.playing = null;
    };
    this.playing = { audio, done };
    audio.addEventListener('play', show);
    audio.addEventListener('pause', show);
    audio.addEventListener('timeupdate', () => {
      if (audio.currentTime >= end) done();
      else show();
    });
    audio.addEventListener('ended', done);
    audio.addEventListener('error', () => {
      done();
      new Notice(t('core.quoteCannotPlay'));
    });
    audio.addEventListener('loadedmetadata', () => {
      audio.currentTime = start;
      void audio.play().catch(() => show());
    }, { once: true });
    audio.src = played.src;
  }

  private stopPlaying() {
    this.playing?.done();
    this.playing = null;
  }

  // ─── Updating ─────────────────────────────────────────────────────────────

  /**
   * Put `text` in place of a quote's words in the note. The quote is found by
   * its link's time and its words as they were, so only that quote changes.
   */
  private async rewrite(notePath: string, subpath: string, quoted: string, text: string) {
    const note = this.plugin.app.vault.getAbstractFileByPath(notePath);
    if (!(note instanceof TFile)) return;
    let done = false;
    await this.plugin.app.vault.process(note, source => {
      const lines = source.split('\n');
      const blocks: { from: number; to: number }[] = [];
      lines.forEach((line, i) => {
        if (!new RegExp(`^\\s*>\\s*\\[!${QUOTE_CALLOUT}\\]`, 'i').test(line) || !line.includes(subpath)) return;
        let to = i + 1;
        while (to < lines.length && /^\s*>/.test(lines[to])) to++;
        blocks.push({ from: i, to });
      });
      const words = comparable(quoted);
      const block = blocks.find(b => comparable(lines.slice(b.from + 1, b.to).join('\n').replace(/^\s*>/gm, '')) === words) ??
        (blocks.length === 1 ? blocks[0] : null);
      if (!block) return source;
      const indent = /^(\s*)>/.exec(lines[block.from])?.[1] ?? '';
      const body = text.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '').map(l => `${indent}> ${l}`);
      lines.splice(block.from + 1, block.to - block.from - 1, ...body);
      done = true;
      return lines.join('\n');
    });
    new Notice(done ? t('core.quoteUpdated') : t('core.quoteNotFound'));
  }
}

/** The quote as written beside what the transcript now says there; take it, or keep yours. */
class OutdatedQuoteModal extends Modal {
  constructor(
    app: App,
    private readonly before: string,
    private readonly after: string,
    private readonly on: { update: (text: string) => void; keep: () => void },
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle(t('core.quoteOutdatedTitle'));
    contentEl.createDiv({ cls: 'mt-quote-diff-label', text: t('core.quoteYours') });
    contentEl.createDiv({ cls: 'mt-quote-diff mt-quote-diff-old', text: this.before });
    contentEl.createDiv({ cls: 'mt-quote-diff-label', text: t('core.quoteNow') });
    contentEl.createDiv({ cls: 'mt-quote-diff mt-quote-diff-new', text: this.after });
    new Setting(contentEl)
      .addButton(b => b.setButtonText(t('core.quoteKeep')).onClick(() => { this.on.keep(); this.close(); }))
      .addButton(b => b.setButtonText(t('core.quoteTakeNew')).setCta().onClick(() => { this.on.update(this.after); this.close(); }));
  }

  onClose() {
    this.contentEl.empty();
  }
}
