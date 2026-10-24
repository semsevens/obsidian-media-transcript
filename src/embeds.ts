import { App, Component, TFile, parseLinktext, setIcon } from 'obsidian';
import type MediaTranscriptPlugin from './main';
import { FoundSubtitleFile, SUBTITLE_EXTENSIONS, findSubtitlesByBaseName, resolvePriority } from './utils/subtitleFinder';
import { trackMarker } from './utils/transcriptSource';
import { parseSubtitle } from './utils/subtitleParser';
import { parseTimeFragment } from './utils/timeFragment';
import { subtitleBaseName } from './utils/mediaMatch';
import { t } from './i18n';

// Embeds have their own registry (extension → component factory), separate
// from the view registry. Undocumented; every access is guarded so a change
// degrades to "no card" rather than an error.
export interface EmbedContext { containerEl: HTMLElement }
export type EmbedCreator = (ctx: EmbedContext, file: TFile, subpath?: string) => Component;
export interface EmbedRegistry {
  embedByExtension: Record<string, EmbedCreator | undefined>;
  registerExtension(ext: string, creator: EmbedCreator): void;
  unregisterExtension(ext: string): void;
}
export function embedRegistry(app: App): EmbedRegistry | null {
  return (app as unknown as { embedRegistry?: EmbedRegistry }).embedRegistry ?? null;
}

// What Obsidian renders for `![[x.m4a]]` once x.m4a isn't in the vault — the
// same element in reading view and Live Preview. No factory is called for it
// (there's no file to hand one), so we find these in the DOM instead.
const MISSING_EMBED = '.internal-embed.mod-empty-attachment[src]';

/**
 * A small player card for a transcript, rendered in a note:
 *   - for `![[talk.vibevoice-4bit.json]]` (a factory for subtitle extensions)
 *   - in place of `![[talk.m4a]]` after talk.m4a has left the vault, when a
 *     transcript named after it is still here — so notes written before the
 *     media moved keep working without being rewritten.
 * The media is found the same way the transcript view finds it (its folder,
 * media folders, remote URLs), and the Transcript button opens the full view
 * beside the note, carrying the playback position over.
 */
export class TranscriptCards {
  private players = new Set<HTMLMediaElement>();
  /** Each card's player: how to look for its media again. */
  private reloads = new WeakMap<HTMLMediaElement, () => Promise<void>>();
  private observers: MutationObserver[] = [];
  private docs: Document[] = [];
  private registered: string[] = [];

  constructor(readonly plugin: MediaTranscriptPlugin) {}

  start() {
    const registry = embedRegistry(this.plugin.app);
    for (const ext of SUBTITLE_EXTENSIONS) {
      // Only where nobody else renders this extension.
      if (!registry || registry.embedByExtension[ext]) continue;
      registry.registerExtension(ext, (ctx, file, subpath) =>
        new TranscriptEmbed(ctx.containerEl, file, subpath ?? '', this));
      this.registered.push(ext);
    }

    this.observe(document);
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('window-open', win => this.observe(win.doc)),
    );
  }

  stop() {
    const registry = embedRegistry(this.plugin.app);
    for (const ext of this.registered) registry?.unregisterExtension(ext);
    this.registered = [];
    for (const o of this.observers) o.disconnect();
    this.observers = [];
    this.docs = [];
    for (const p of this.players) this.release(p);
    this.players.clear();
  }

  /**
   * The preferred transcript for media called `mediaName`, anywhere in the
   * vault: those that name it as their source (whatever they're called now),
   * then those named after it.
   */
  transcriptFor(mediaName: string): TFile | null {
    const name = mediaName.replace(/^.*[\\/]/, '');
    const found: FoundSubtitleFile[] = this.plugin.transcripts.transcriptsFor(name).map(file => ({
      file, marker: trackMarker(file.name), extension: file.extension.toLowerCase(),
    }));
    for (const f of findSubtitlesByBaseName(name.replace(/\.[^.]+$/, ''), this.plugin.app.vault)) {
      if (!found.some(g => g.file === f.file)) found.push(f);
    }
    return resolvePriority(found, this.plugin.settings.priorities)[0]?.file ?? null;
  }

  /** Look again at "not found" embeds — the transcript index learned something. */
  refresh() {
    for (const doc of this.docs) this.scan(doc.body);
  }

  isMediaName(name: string): boolean {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    const s = this.plugin.settings;
    return [...s.supportedVideoExtensions, ...s.supportedAudioExtensions].includes(ext);
  }

  // ── Missing media embeds ──────────────────────────────────────────────────

  private observe(doc: Document) {
    const observer = new MutationObserver(records => {
      for (const r of records) {
        // The class or text can arrive after the element itself, so look at
        // the mutated element too, not only what was added.
        if (r.target.nodeType === Node.ELEMENT_NODE) this.scan(r.target as HTMLElement);
        r.addedNodes.forEach(n => {
          if (n.nodeType !== Node.ELEMENT_NODE) return;
          this.scan(n as HTMLElement);
          this.revive(n as HTMLElement);
        });
      }
      this.reap();
    });
    observer.observe(doc.body, { childList: true, subtree: true });
    this.observers.push(observer);
    this.docs.push(doc);
    this.scan(doc.body);
  }

  private scan(root: HTMLElement) {
    const hosts = root.matches(MISSING_EMBED) ? [root] : [];
    hosts.push(...Array.from(root.querySelectorAll<HTMLElement>(MISSING_EMBED)));
    for (const host of hosts) {
      if (host.querySelector(':scope > .mt-card')) continue;
      const { path, subpath } = parseLinktext(host.getAttribute('src') ?? '');
      if (!this.isMediaName(path)) continue;
      const transcript = this.transcriptFor(path);
      if (!transcript) continue; // nothing to offer: leave Obsidian's "not found"
      host.empty();
      host.addClass('mt-card-host');
      void this.render(host, transcript, parseTimeFragment(subpath));
    }
  }

  // A card removed from the page must not keep playing where no one can stop it.
  private reap() {
    for (const p of this.players) {
      if (!p.isConnected) {
        this.release(p);
        this.players.delete(p);
      }
    }
  }

  release(p: HTMLMediaElement) {
    p.pause();
    p.dataset.mtReleased = '1';
    p.removeAttribute('src');
    p.load();
  }

  // Live Preview takes an embed off the page and puts the same one back (a
  // redraw, a scroll): a card let go meanwhile looks for its media again,
  // rather than stay an empty player at 0:00.
  private revive(root: HTMLElement) {
    const released = root.matches('[data-mt-released]') ? [root] : [];
    released.push(...Array.from(root.querySelectorAll<HTMLElement>('[data-mt-released]')));
    for (const p of released) {
      const reload = this.reloads.get(p as HTMLMediaElement);
      delete p.dataset.mtReleased;
      if (reload && p.isConnected) void reload();
    }
  }

  // ── The card ──────────────────────────────────────────────────────────────

  async render(host: HTMLElement, transcript: TFile, startAt: number | null) {
    const card = host.createDiv('mt-card');
    // Live Preview treats a press inside an embed as "edit the source", and
    // a missing-file embed would offer to create the file. Keep both out.
    card.addEventListener('mousedown', e => e.stopPropagation());
    card.addEventListener('click', e => e.stopPropagation());

    const head = card.createDiv('mt-card-head');
    setIcon(head.createSpan('mt-card-icon'), 'captions');
    head.createSpan({ cls: 'mt-card-title', text: subtitleBaseName(transcript.name) });
    const btn = head.createEl('button', {
      cls: 'mt-embed-btn',
      attr: { 'aria-label': t('core.openTranscriptBeside') },
    });
    setIcon(btn.createSpan('mt-embed-btn-icon'), 'captions');
    btn.createSpan({ text: t('core.transcriptButton') });

    const body = card.createDiv('mt-card-body');

    let player: HTMLMediaElement | null = null;
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      // Hand over where the card was, so two players never talk at once.
      let at = startAt;
      let playing = false;
      if (player) {
        playing = !player.paused;
        if (player.currentTime > 0) at = player.currentTime;
        player.pause();
      }
      void this.plugin.openTranscript(transcript, at, playing);
    });

    // Obsidian keeps a rendered embed when the note is reopened, so a card
    // that found nothing (a server asleep, a drive unplugged) would stay that
    // way. Retry looks again on demand.
    const load = async () => {
      body.empty();
      const status = body.createSpan({ cls: 'mt-card-status', text: t('core.lookingForMedia') });
      const { media } = await this.plugin.mediaLocator.resolveForSubtitle(transcript);
      if (!card.isConnected) return;
      if (!media) {
        status.setText(t('core.noMediaTranscriptOnly'));
        const retry = status.createEl('a', { cls: 'mt-card-retry', text: t('core.retry'), attr: { href: '#' } });
        retry.addEventListener('click', e => {
          e.preventDefault();
          e.stopPropagation();
          this.plugin.mediaLocator.invalidate(); // forget "unreachable" too
          void load();
        });
        return;
      }
      status.remove();
      // Listening to videos: their audio twin, when there is one, starts sooner.
      const played = this.plugin.settings.videoAudioOnly ? (media.audioTwin ?? media) : media;
      const isVideo = this.plugin.settings.supportedVideoExtensions.includes(played.extension);
      // `#t=` on the source is the media-fragment start, same as a native embed.
      const src = played.src + (startAt !== null ? `#t=${startAt}` : '');
      player = body.createEl(isVideo ? 'video' : 'audio', {
        cls: isVideo ? 'mt-card-video' : 'mt-card-audio',
        attr: { src, controls: '', preload: 'metadata' },
      });
      this.players.add(player);
      this.reloads.set(player, load);
    };
    await load();
  }
}

/** `![[talk.vibevoice-4bit.json]]` — the card, or a plain title for JSON that isn't a transcript. */
class TranscriptEmbed extends Component {
  private rendered = false;

  constructor(
    private containerEl: HTMLElement,
    private file: TFile,
    private subpath: string,
    private cards: TranscriptCards,
  ) {
    super();
  }

  onload() { void this.loadFile(); }

  // Obsidian may call this as well as load(); render once either way.
  async loadFile() {
    if (this.rendered) return;
    this.rendered = true;
    const el = this.containerEl;
    if (this.file.extension.toLowerCase() === 'json') {
      const isTranscript = await this.cards.plugin.app.vault.cachedRead(this.file)
        .then(text => parseSubtitle(text, 'json').length > 0, () => false);
      if (!isTranscript) {
        el.createDiv({ cls: 'file-embed-title', text: this.file.name });
        return;
      }
    }
    el.addClass('mt-card-host');
    await this.cards.render(el, this.file, parseTimeFragment(this.subpath));
  }

  onunload() {
    this.containerEl.querySelectorAll('audio, video').forEach(p => this.cards.release(p as HTMLMediaElement));
  }
}
