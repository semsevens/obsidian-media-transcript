import { Menu, Notice, TFile, setIcon } from 'obsidian';
import type MediaTranscriptPlugin from '../main';
import type { IndexEntry, Job, TrashItem } from './client';
import { DeviceState } from './deviceState';
import { durationIn, formatDuration, isDatedName, isGenericName, isTranscriptNamedFor, openingWords, recordedAt, withoutDate } from './mediaInfo';
import { formatSize } from '../utils/format';
import { parseSubtitle, type SubtitleSegment } from '../utils/subtitleParser';
import { obsidianLanguage, t } from '../i18n';

const PAGE = 200;
const LOCALE = obsidianLanguage() === 'zh' ? 'zh-CN' : 'en';
const MONTH = new Intl.DateTimeFormat(LOCALE, { year: 'numeric', month: 'long' });
const TIME = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const TIME_YEAR = new Intl.DateTimeFormat(LOCALE, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const DAY = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric' });
const DAY_YEAR = new Intl.DateTimeFormat(LOCALE, { year: 'numeric', month: 'short', day: 'numeric' });

/** When, as the row says it: no year for this year's, no time when only the day is known. */
function formatWhen(d: Date): string {
  const thisYear = d.getFullYear() === new Date().getFullYear();
  const dayOnly = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
  return (dayOnly ? (thisYear ? DAY : DAY_YEAR) : (thisYear ? TIME : TIME_YEAR)).format(d);
}
const MEDIA_EXT = /\.(m4a|mp3|wav|aac|flac|ogg|opus|wma|mp4|mov|mkv|webm|avi|m4v)$/i;
const VIDEO_EXT = /\.(mp4|mov|mkv|webm|avi|m4v)$/i;

/** One media file on the server, with what helps to tell it apart. */
interface Item {
  path: string;              // in the library
  name: string;
  collection: string;        // the library folder it is in, or the collection its folder is named after
  vaultPath: string | null;  // this vault's own media: where it is in the vault
  size: number;
  backedUp: boolean;
  recorded: Date | null;
  title: string;             // the note it comes from (unless a daily note), or its name
  notes: TFile[];
  transcript: TFile | null;
  /** A video's audio, the same name as .m4a beside it: what the row plays, a fraction of the size. */
  listen: string | null;
}

export interface MediaHost {
  rerender(): void;
  rename(vaultPath: string): void;
  delete(vaultPath: string): void;
  restore(item: TrashItem): Promise<void>;
}

/**
 * The media on the Media One server, as the library tab lists it: this
 * vault's own recordings, and the collections kept beside them (recorded
 * streams, podcasts) whose transcripts are in the vault. Newest first, by
 * month, each row saying which note it comes from, when it was recorded and
 * how long it is.
 */
export class MediaList {
  private items: Item[] = [];
  /** All the server holds, audio twins too. */
  private totalSize = 0;
  private trash: TrashItem[] = [];
  private jobs = new Map<string, Job>();
  private collection: string | null = null;  // null: this vault's own
  private limit = PAGE;
  private error: string | null = null;
  private retried = false;
  /** Read from each shown transcript once: the media's length and opening words. */
  private details = new Map<string, { duration: number | null; words: string }>();
  /** The row playing inline: its audio, its play button, and the bar under it. */
  private playing: { path: string; row: HTMLElement; audio: HTMLAudioElement; button: HTMLElement; bar: HTMLElement; caption: HTMLElement | null } | null = null;

  private readonly device: DeviceState;

  constructor(private readonly plugin: MediaTranscriptPlugin, private readonly host: MediaHost) {
    this.device = new DeviceState(plugin.app);
  }

  private get own(): string {
    return this.plugin.library.folder;
  }

  async refresh(): Promise<void> {
    const { library } = this.plugin;
    if (!library.configured) {
      this.error = t('library.notConfigured');
      this.items = [];
      this.trash = [];
      return;
    }
    // The index as last fetched, shown at once while the server answers.
    if (this.items.length === 0) {
      const cached = this.device.get<IndexEntry[]>('mediaIndex', []);
      if (cached.length) this.show(cached);
      this.host.rerender();
    }
    try {
      const [index, trash, jobs] = await Promise.all([library.index(), library.trash(), library.jobs()]);
      this.trash = trash;
      this.jobs = new Map();
      for (const j of jobs.jobs.sort((a, b) => a.created - b.created)) this.jobs.set(j.path, j);
      this.show(index);
      this.device.set('mediaIndex', index);
      this.error = null;
      this.retried = false;
    } catch (e) {
      // With a list to show, a failed refresh only says so; without, it is the error.
      this.error = (e as Error).message;
    }
  }

  private show(index: IndexEntry[]): void {
    this.items = this.build(index);
    this.totalSize = index.reduce((n, e) => n + e.size, 0);
  }

  private build(index: IndexEntry[]): Item[] {
    const { app, transcripts } = this.plugin;
    // Transcripts by the media name their file name gives, for those whose
    // recorded source is out of date.
    const byName = new Map<string, TFile[]>();
    for (const f of app.vault.getFiles()) {
      if (f.extension !== 'json' || f.name.endsWith('.anno.json')) continue;
      const base = f.name.replace(/\.[^./]+\.json$/, '');
      const list = byName.get(base) ?? [];
      list.push(f);
      byName.set(base, list);
    }
    // Notes that embed or link a file, by its name: the media is often no
    // longer in the vault, so the links are unresolved and kept by name.
    const notesByName = new Map<string, Set<string>>();
    const note = (source: string, target: string) => {
      const name = target.slice(target.lastIndexOf('/') + 1).toLowerCase();
      if (!MEDIA_EXT.test(name)) return;
      const set = notesByName.get(name) ?? new Set();
      set.add(source);
      notesByName.set(name, set);
    };
    const { resolvedLinks, unresolvedLinks } = app.metadataCache;
    for (const [source, targets] of Object.entries(resolvedLinks)) for (const target of Object.keys(targets)) note(source, target);
    for (const [source, targets] of Object.entries(unresolvedLinks)) for (const target of Object.keys(targets)) note(source, target);

    // A video's audio twin (same name, .m4a) is listed with the video, not apart.
    const paths = new Set(index.map(e => e.path));
    const twinOf = (path: string) => {
      if (!VIDEO_EXT.test(path)) return null;
      const audio = path.replace(/\.[^.]+$/, '.m4a');
      return paths.has(audio) ? audio : null;
    };
    const twins = new Set(index.map(e => twinOf(e.path)).filter((p): p is string => p !== null));

    // This vault's media in a folder named after a collection (raw/media/南添/…, beside
    // the collection's transcripts) is shown with that collection.
    const collections = new Set(index.map(e => e.path.slice(0, e.path.indexOf('/'))).filter(c => c !== this.own));
    return index.filter(e => MEDIA_EXT.test(e.path) && !twins.has(e.path)).map(e => {
      const folder = e.path.slice(0, e.path.indexOf('/'));
      const collection = folder === this.own
        ? e.path.split('/').slice(1, -1).reverse().find(d => collections.has(d)) ?? folder
        : folder;
      const name = e.path.slice(e.path.lastIndexOf('/') + 1);
      const base = name.slice(0, name.lastIndexOf('.'));
      const notes = [...(notesByName.get(name.toLowerCase()) ?? [])]
        .map(p => app.vault.getAbstractFileByPath(p))
        .filter((f): f is TFile => f instanceof TFile);
      const transcript = transcripts.transcriptsFor(name).find(f => f.extension === 'json')
        ?? (byName.get(base) ?? []).find(f => isTranscriptNamedFor(f.name, name))
        ?? null;
      return {
        path: e.path,
        name,
        collection,
        vaultPath: folder === this.own ? e.path.slice(folder.length + 1) : null,
        size: e.size,
        backedUp: !!e.backup && Object.keys(e.backup).length > 0,
        // Its own media was uploaded as it was made; a collection was brought in all at once.
        recorded: recordedAt(name) ?? (folder === this.own && e.added ? new Date(e.added) : null),
        title: notes[0] && !isDatedName(notes[0].basename) ? notes[0].basename : isGenericName(name) ? base : withoutDate(base),
        notes,
        transcript,
        listen: twinOf(e.path),
      };
    });
  }

  render(list: HTMLElement, status: HTMLElement, filter: string): void {
    if (this.error) {
      status.createSpan({ cls: 'mo-lib-error', text: this.items.length ? t('library.staleList', { error: this.error }) : this.error });
      const retry = status.createEl('button', { cls: 'mo-lib-retry', text: t('library.retry') });
      const again = () => void this.refresh().then(() => this.host.rerender());
      retry.addEventListener('click', again);
      // A phone just woken takes a moment to get its connection (a VPN) back: try once more by itself.
      if (!this.retried && this.plugin.library.configured) {
        this.retried = true;
        window.setTimeout(again, 4000);
      }
      if (this.items.length === 0) return;
    }
    const counts = new Map<string, Item[]>();
    for (const it of this.items) counts.set(it.collection, [...(counts.get(it.collection) ?? []), it]);
    // This vault has nothing of its own on the server (yet): show everything.
    if (this.collection === null && !counts.has(this.own) && this.items.length) this.collection = '*';
    const current = this.collection ?? this.own;
    const inView = this.collection === '*' ? this.items : counts.get(current) ?? [];
    const size = (items: Item[]) => formatSize(items.reduce((n, i) => n + i.size, 0));
    const waiting = this.plugin.uploader.pending.length;
    if (!this.error) status.setText(t(waiting ? 'library.mediaStatusWaiting' : 'library.mediaStatus', {
      count: inView.length, size: size(inView), total: formatSize(this.totalSize), waiting,
    }));

    this.renderCollections(list, counts, current);

    const shown = inView
      .filter(it => !filter || [it.path, it.title, this.details.get(it.path)?.words ?? '', ...it.notes.map(n => n.path)].join('\n').toLowerCase().includes(filter))
      .sort((a, b) => (b.recorded?.getTime() ?? 0) - (a.recorded?.getTime() ?? 0) || a.name.localeCompare(b.name));
    let group: string | null = null;
    for (const it of shown.slice(0, this.limit)) {
      const g = it.recorded ? MONTH.format(it.recorded) : t('library.undated');
      if (g !== group) {
        group = g;
        list.createDiv({ cls: 'mo-lib-folder', text: g });
      }
      this.renderRow(list, it);
    }
    if (shown.length > this.limit) {
      const more = list.createEl('button', { cls: 'mo-lib-more', text: t('library.archiveShowMore', { count: Math.min(PAGE, shown.length - this.limit) }) });
      more.addEventListener('click', () => {
        this.limit += PAGE;
        this.host.rerender();
      });
    }
    if (shown.length === 0) {
      list.createDiv({ cls: 'mo-lib-empty', text: filter ? t('library.nothingMatches') : t('library.empty') });
    }
    if (current === this.own && this.collection !== '*') this.renderTrash(list);
    this.keepPlaying(list);
  }

  /** The list was redrawn (a search typed, say): carry on playing in the new row, or stop if it's gone. */
  private keepPlaying(list: HTMLElement): void {
    const playing = this.playing;
    if (!playing) return;
    const row = Array.from(list.querySelectorAll<HTMLElement>('.mo-lib-media-row')).find(r => r.dataset.path === playing.path);
    const button = row?.querySelector<HTMLElement>('.mo-lib-play');
    if (!row || !button) {
      this.stop();
      return;
    }
    playing.row = row;
    playing.button = button;
    row.addClass('is-playing');
    setIcon(button, playing.audio.paused ? 'play' : 'pause');
    if (playing.caption) row.appendChild(playing.caption);
    row.appendChild(playing.bar);
  }

  private renderCollections(list: HTMLElement, counts: Map<string, Item[]>, current: string): void {
    if (counts.size <= 1 && counts.has(this.own)) return;
    const bar = list.createDiv('mo-lib-segments mo-lib-collections');
    const others = [...counts.keys()].filter(c => c !== this.own).sort((a, b) => counts.get(b)!.length - counts.get(a)!.length);
    const add = (key: string | null, label: string, n: number) => {
      const active = key === '*' ? this.collection === '*' : this.collection !== '*' && (key ?? this.own) === current;
      const b = bar.createEl('button', { text: `${label} ${n}`, cls: active ? 'is-active' : '' });
      b.addEventListener('click', () => {
        this.collection = key;
        this.limit = PAGE;
        this.host.rerender();
      });
    };
    if (counts.has(this.own)) add(null, t('library.collectionMine'), counts.get(this.own)!.length);
    for (const c of others) add(c, c, counts.get(c)!.length);
    add('*', t('library.collectionAll'), this.items.length);
  }

  private renderRow(list: HTMLElement, it: Item): void {
    const row = list.createDiv('mo-lib-row mo-lib-media-row');
    row.dataset.path = it.path;
    const playButton = row.createEl('button', { cls: 'mo-lib-play', attr: { 'aria-label': t('library.menuPlay') } });
    setIcon(playButton, 'play');
    playButton.addEventListener('click', evt => {
      evt.stopPropagation();
      this.play(it, row, playButton);
    });
    const main = row.createDiv('mo-lib-main');
    const title = main.createDiv({ cls: 'mo-lib-name', text: it.title });
    const meta = main.createDiv('mo-lib-meta');
    const when = it.recorded ? formatWhen(it.recorded) : '';
    const facts = meta.createSpan();
    const context = main.createDiv({ cls: 'mo-lib-file' });
    const base = it.name.slice(0, it.name.lastIndexOf('.'));
    const generic = isGenericName(it.name) && !it.notes.some(n => n.basename === it.title);
    const show = (d?: { duration: number | null; words: string }) => {
      facts.setText([when, d?.duration && d.duration >= 1 ? formatDuration(d.duration) : '', formatSize(it.size)].filter(Boolean).join(' · '));
      // A name a recorder gave (a timestamp) says least: then what was said
      // names it best. A name someone chose is kept.
      const name = (generic && d?.words) || it.title;
      title.setText(name);
      // Then where it comes from: the note (a daily note's name is the date
      // already shown), and the file, unless its name is only a timestamp.
      const note = it.notes[0] && !isDatedName(it.notes[0].basename) ? it.notes[0].basename : null;
      // The file's own name always, to know it by in a folder or a link.
      const file = name === base ? null : it.name;
      const parts = [note, file].filter((x): x is string => !!x && x !== name);
      context.setText(parts.join(' · '));
      context.toggle(parts.length > 0);
    };
    show(this.details.get(it.path));
    if (it.transcript && !this.details.has(it.path)) void this.loadDetails(it).then(show);

    // Only what is out of the ordinary: a transcript is the rule.
    const job = this.jobs.get(it.path);
    if (job && (job.state === 'queued' || job.state === 'claimed' || job.state === 'failed')) {
      const label = job.state === 'queued' ? t('library.jobQueued') : job.state === 'claimed' ? t('library.jobClaimed') : t('library.jobFailed');
      const badge = meta.createSpan({ cls: `mo-lib-badge mo-lib-job-${job.state}`, text: label });
      if (job.error) badge.setAttr('title', job.error);
    } else if (!it.transcript) {
      meta.createSpan({ cls: 'mo-lib-badge', text: t('library.badgeNoTranscript') });
    }
    // Backups are kept track of for this vault's own media only.
    if (!it.backedUp && it.vaultPath) meta.createSpan({ cls: 'mo-lib-badge mo-lib-nobackup', text: t('library.badgeNoBackup'), attr: { title: t('library.badgeNoBackupTip') } });
    if (it.vaultPath && this.plugin.app.vault.getAbstractFileByPath(it.vaultPath) instanceof TFile) {
      meta.createSpan({ cls: 'mo-lib-badge', text: t('library.badgeOnDevice') });
    }

    // The row opens its transcript (which plays it too); the button just plays it here.
    main.addEventListener('click', () => {
      if (it.transcript) void this.plugin.openTranscript(it.transcript);
      else this.play(it, row, playButton);
    });
    const more = row.createEl('button', { cls: 'clickable-icon mo-lib-more-actions', attr: { 'aria-label': t('library.moreActions') } });
    setIcon(more, 'more-horizontal');
    more.addEventListener('click', evt => this.menu(evt, it, row));
    row.addEventListener('contextmenu', evt => {
      evt.preventDefault();
      this.menu(evt, it, row);
    });
  }

  private async loadDetails(it: Item): Promise<{ duration: number | null; words: string }> {
    let d = { duration: null as number | null, words: '' };
    try {
      if (it.transcript) {
        const text = await this.plugin.app.vault.cachedRead(it.transcript);
        d = { duration: durationIn(text), words: openingWords(text) };
      }
    } catch {
      // nothing more to show
    }
    this.details.set(it.path, d);
    return d;
  }

  private menu(evt: MouseEvent, it: Item, row: HTMLElement): void {
    const menu = new Menu();
    const button = row.querySelector<HTMLElement>('.mo-lib-play');
    if (button) menu.addItem(i => i.setTitle(t('library.menuPlay')).setIcon('play').onClick(() => this.play(it, row, button)));
    if (it.transcript) {
      const tr = it.transcript;
      menu.addItem(i => i.setTitle(t('library.menuOpenTranscript')).setIcon('file-text').onClick(() => { void this.plugin.openTranscript(tr); }));
    }
    for (const n of it.notes.slice(0, 5)) {
      menu.addItem(i => i.setTitle(t('library.menuOpenNote', { name: n.basename })).setIcon('sticky-note')
        .onClick(() => { void this.plugin.app.workspace.getLeaf(false).openFile(n); }));
    }
    menu.addSeparator();
    const vaultPath = it.vaultPath;
    if (vaultPath) {
      menu.addItem(i => i.setTitle(t('library.menuRename')).setIcon('pencil').onClick(() => this.host.rename(vaultPath)));
      menu.addItem(i => i.setTitle(t('library.menuTranscribe')).setIcon('captions').onClick(() => { void this.transcribe(vaultPath, it.name); }));
      menu.addItem(i => i.setTitle(t('library.menuCopyEmbed')).setIcon('copy').onClick(() => {
        void navigator.clipboard.writeText(`![[${it.name}]]`);
        new Notice(t('library.copied'));
      }));
      menu.addSeparator();
      menu.addItem(i => i.setTitle(t('library.delete')).setIcon('trash-2').setWarning(true).onClick(() => this.host.delete(vaultPath)));
    } else {
      menu.addItem(i => i.setTitle(t('library.menuCopyLink')).setIcon('link').onClick(() => {
        void navigator.clipboard.writeText(this.plugin.library.libraryUrl(it.path));
        new Notice(t('library.copied'));
      }));
    }
    menu.showAtMouseEvent(evt);
  }

  /** Play `it` in its row, or pause and resume it if it is the one playing. */
  private play(it: Item, row: HTMLElement, button: HTMLElement): void {
    if (this.playing?.row === row) {
      const { audio } = this.playing;
      if (audio.paused) void audio.play().catch(() => {});
      else audio.pause();
      return;
    }
    this.stop();
    const audio = new Audio(this.plugin.library.libraryUrl(it.listen ?? it.path));
    audio.preload = 'auto';
    const bar = row.createDiv('mo-lib-progress');
    const seek = bar.createEl('input', { type: 'range', attr: { min: '0', max: '1000', value: '0', 'aria-label': t('library.seek') } });
    const time = bar.createSpan({ cls: 'mo-lib-progress-time', text: '0:00' });
    // The line being said, following the playback; tapping it opens the transcript there.
    const caption = it.transcript ? createDiv({ cls: 'mo-lib-caption' }) : null;
    if (caption) row.insertBefore(caption, bar);
    let segments: SubtitleSegment[] = [];
    let shown = -1;
    if (it.transcript && caption) {
      const file = it.transcript;
      void this.plugin.app.vault.cachedRead(file).then(text => {
        segments = parseSubtitle(text, file.extension).filter(s => !/^[[(（【].*[\])）】]$/.test(s.text.trim()));
        paint();
      });
      caption.addEventListener('click', evt => {
        evt.stopPropagation();
        const at = audio.currentTime;
        this.stop();
        void this.plugin.openTranscript(file, at);
      });
    }
    const close = bar.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': t('library.stop') } });
    setIcon(close, 'x');
    close.addEventListener('click', () => this.stop());
    const paint = () => {
      const d = Number.isFinite(audio.duration) ? audio.duration : 0;
      if (d) seek.value = String(Math.round((audio.currentTime / d) * 1000));
      time.setText(d ? `${formatDuration(audio.currentTime)} / ${formatDuration(d)}` : formatDuration(audio.currentTime));
      seek.style.setProperty('--mo-progress', `${Number(seek.value) / 10}%`);
      if (caption && segments.length) {
        const i = lineAt(segments, audio.currentTime);
        if (i !== shown) {
          shown = i;
          caption.setText(i >= 0 ? segments[i].text : '');
        }
      }
    };
    seek.addEventListener('input', () => {
      if (Number.isFinite(audio.duration)) audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
      paint();
    });
    audio.addEventListener('timeupdate', paint);
    audio.addEventListener('loadedmetadata', paint);
    audio.addEventListener('play', () => {
      if (!this.playing) return;
      setIcon(this.playing.button, 'pause');
      this.playing.row.addClass('is-playing');
    });
    audio.addEventListener('pause', () => { if (this.playing) setIcon(this.playing.button, 'play'); });
    audio.addEventListener('ended', () => this.stop());
    this.playing = { path: it.path, row, audio, button, bar, caption };
    // It grows by a line or two: keep all of it in sight.
    window.setTimeout(() => row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
    void audio.play().catch(() => { if (this.playing) setIcon(this.playing.button, 'play'); });
  }

  stop(): void {
    if (!this.playing) return;
    const { audio, button, bar, row, caption } = this.playing;
    this.playing = null;
    audio.pause();
    audio.removeAttribute('src');
    bar.remove();
    caption?.remove();
    setIcon(button, 'play');
    row.removeClass('is-playing');
  }

  private async transcribe(vaultPath: string, name: string): Promise<void> {
    try {
      const job = await this.plugin.library.transcribe(vaultPath, true);
      new Notice(job ? t('library.transcribeQueued', { name }) : t('library.nothingToTranscribe'));
    } catch (e) {
      new Notice(t('library.transcribeFailed', { error: (e as Error).message }));
    }
    await this.refresh();
    this.host.rerender();
  }

  private renderTrash(list: HTMLElement): void {
    if (this.trash.length === 0) return;
    const details = list.createEl('details', { cls: 'mo-lib-trash' });
    details.createEl('summary', { text: t('library.trashSummary', { count: this.trash.length }) });
    for (const item of [...this.trash].sort((a, b) => b.trashed.localeCompare(a.trashed))) {
      const row = details.createDiv('mo-lib-row');
      const main = row.createDiv('mo-lib-main');
      main.createDiv({ cls: 'mo-lib-name', text: item.path.slice(item.path.indexOf('/') + 1) });
      main.createDiv({ cls: 'mo-lib-meta', text: t('library.deletedAt', { date: item.trashed.replace('T', ' ') }) });
      const restore = row.createEl('button', { text: t('library.restore'), cls: 'mo-lib-restore' });
      restore.addEventListener('click', () => { void this.host.restore(item); });
    }
  }
}

/** The last line that has started by `t` seconds, or -1 before the first. */
function lineAt(segments: SubtitleSegment[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].startTime <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
