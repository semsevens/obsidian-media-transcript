import { Menu, Notice, TFile, setIcon } from 'obsidian';
import type MediaTranscriptPlugin from '../main';
import type { IndexEntry, Job, TrashItem } from './client';
import { DeviceState } from './deviceState';
import type { QueueEntry } from './playlist';
import { durationIn, formatDuration, isDatedName, isGenericName, isTranscriptNamedFor, openingWords, recordedAt, withoutDate } from './mediaInfo';
import { formatSize } from '../utils/format';
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
  listenSize: number;
  added: number;             // ms, when the server got it (0 if it does not say)
}

export interface MediaHost {
  rerender(): void;
  rename(vaultPath: string): void;
  delete(vaultPath: string): void;
  restore(item: TrashItem): Promise<void>;
  confirm(heading: string, body: string, action: string, onConfirm: () => Promise<void>): void;
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
  /** The index the items were built from, to build them again when the vault changes. */
  private index: IndexEntry[] = [];
  /** All the server holds, audio twins too. */
  private totalSize = 0;
  private trash: TrashItem[] = [];
  private jobs = new Map<string, Job>();
  private collection: string | null = null;  // null: this vault's own
  private limit = PAGE;
  /** Only what this device can play without the server. */
  private offlineOnly = false;
  /** The offline line as last drawn, with the rows it is about: redrawn as downloads go on. */
  private offlineBar: { el: HTMLElement; inView: Item[] } | null = null;
  private error: string | null = null;
  private retried = false;
  /** Read from each shown transcript once: the media's length and opening words. */
  private details = new Map<string, { duration: number | null; words: string }>();

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
      this.prefetch();
      this.error = null;
      this.retried = false;
    } catch (e) {
      // With a list to show, a failed refresh only says so; without, it is the error.
      this.error = (e as Error).message;
    }
  }

  private show(index: IndexEntry[]): void {
    this.index = index;
    this.items = this.build(index);
    this.totalSize = index.reduce((n, e) => n + e.size, 0);
  }

  /**
   * Match the items to the vault again, without asking the server: a
   * transcript written here or brought by Sync after the list was fetched.
   * Returns whether a row now reads differently.
   */
  relink(): boolean {
    if (!this.index.length) return false;
    const before = new Map(this.items.map(i => [i.path, i.transcript]));
    this.items = this.build(this.index);
    let changed = false;
    for (const i of this.items) {
      if (before.get(i.path) === i.transcript) continue;
      this.details.delete(i.path);  // read from the transcript that was
      changed = true;
    }
    return changed;
  }

  /** Take in jobs seen since the list was fetched; returns whether a row now reads differently. */
  takeJobs(jobs: Job[]): boolean {
    let changed = false;
    for (const j of jobs) {
      const had = this.jobs.get(j.path);
      if (had && had.changed > j.changed) continue;
      if (had?.state !== j.state) changed = true;
      this.jobs.set(j.path, j);
    }
    return changed;
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
    const sizes = new Map(index.map(e => [e.path, e.size]));
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
        listenSize: sizes.get(twinOf(e.path) ?? '') ?? 0,
        added: e.added ? Date.parse(e.added) || 0 : 0,
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
    this.renderOffline(list, inView);

    const { cache } = this.plugin;
    const shown = inView
      .filter(it => !this.offlineOnly || cache.complete(this.played(it)))
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
      list.createDiv({ cls: 'mo-lib-empty', text: filter || this.offlineOnly ? t('library.nothingMatches') : t('library.empty') });
    }
    if (current === this.own && this.collection !== '*') this.renderTrash(list);
    this.paintPlaying(list);
    this.paintCache(list);
    this.paintQueued(list);
  }

  /** Each row's playlist button: in it (tap to take out) or not (tap to add). */
  paintQueued(list: HTMLElement): void {
    const { playlist } = this.plugin;
    for (const row of Array.from(list.querySelectorAll<HTMLElement>('.mo-lib-media-row'))) {
      const button = row.querySelector<HTMLElement>('.mo-lib-queue');
      if (!button) continue;
      const queued = playlist.has(row.dataset.path ?? '');
      const icon = queued ? 'list-checks' : 'list-plus';
      if (button.dataset.icon === icon) continue;
      button.dataset.icon = icon;
      setIcon(button, icon);
      button.toggleClass('is-queued', queued);
      button.setAttr('aria-label', t(queued ? 'library.playlistRemove' : 'library.menuAddToPlaylist'));
    }
  }

  /** What the row plays: a video's audio twin, or the file itself. */
  private played(it: Item): string {
    return it.listen ?? it.path;
  }

  private fetchable(it: Item) {
    const path = this.played(it);
    return { path, url: this.plugin.library.libraryUrl(path), size: it.listen ? it.listenSize : it.size, added: it.added };
  }

  /** New audio of this vault's own, and of collections listened to lately, fetched ahead to play offline. */
  private prefetch(): void {
    const { cache } = this.plugin;
    const recent = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const listened = new Set(this.items.filter(it => (cache.statsOf(this.played(it))?.last ?? 0) > recent).map(it => it.collection));
    cache.prefetch(this.items
      .filter(it => !it.vaultPath || !(this.plugin.app.vault.getAbstractFileByPath(it.vaultPath) instanceof TFile))
      .filter(it => it.collection === this.own || listened.has(it.collection))
      .filter(it => !VIDEO_EXT.test(this.played(it)))
      .map(it => this.fetchable(it)));
  }

  /** Only what plays offline; download all shown here; how much this device keeps. */
  private renderOffline(list: HTMLElement, inView: Item[]): void {
    if (!this.plugin.cache.available) return;
    this.offlineBar = { el: list.createDiv('mo-lib-offline'), inView };
    this.fillOffline();
  }

  private fillOffline(): void {
    const { cache } = this.plugin;
    if (!this.offlineBar) return;
    const { el: bar, inView } = this.offlineBar;
    bar.empty();
    const here = inView.filter(it => cache.complete(this.played(it))).length;
    const chip = bar.createEl('button', { cls: `mo-lib-chip${this.offlineOnly ? ' is-active' : ''}` });
    setIcon(chip.createSpan('mo-lib-chip-icon'), 'hard-drive-download');
    chip.createSpan({ text: t('library.offlineOnly', { count: here }) });
    chip.addEventListener('click', () => {
      this.offlineOnly = !this.offlineOnly;
      this.host.rerender();
    });
    const missing = inView.filter(it => !cache.complete(this.played(it)));
    const size = missing.reduce((n, it) => n + this.fetchable(it).size, 0);
    // Only a group that fits in what this device keeps: a larger one is downloaded a row at a time.
    if (missing.length && !this.offlineOnly && cache.usage().total + size <= cache.limit) {
      const all = bar.createEl('button', { cls: 'mo-lib-chip', text: t('library.downloadAll', { count: missing.length, size: formatSize(size) }) });
      all.addEventListener('click', () => this.host.confirm(
        t('library.downloadAllTitle', { count: missing.length }),
        t('library.downloadAllDesc', { size: formatSize(size), limit: formatSize(cache.limit) }),
        t('library.downloadAllAction'),
        () => {
          for (const it of missing) cache.keep(this.fetchable(it));
          return Promise.resolve();
        },
      ));
    }
    bar.createSpan({ cls: 'mo-lib-offline-usage', text: t('library.cacheUsage', { used: formatSize(cache.usage().total) }) });
  }

  /** Each row's state on this device: kept, cached, downloading. After a redraw, and as downloads go on. */
  paintCache(list: HTMLElement): void {
    const { cache } = this.plugin;
    if (this.offlineBar && list.contains(this.offlineBar.el)) this.fillOffline();
    const byPath = new Map(this.items.map(it => [it.path, it]));
    const offline = !!this.error;
    for (const row of Array.from(list.querySelectorAll<HTMLElement>('.mo-lib-media-row'))) {
      const it = byPath.get(row.dataset.path ?? '');
      const badge = row.querySelector<HTMLElement>('.mo-lib-cache');
      if (!it || !badge) continue;
      const path = this.played(it);
      const e = cache.entry(path);
      const p = cache.progress(path);
      const done = cache.complete(path);
      const text = done ? t(e?.kind === 'kept' ? 'library.badgeKept' : 'library.badgeCached')
        : p?.active ? t('library.badgeDownloading', { percent: p.size ? Math.floor((p.have / p.size) * 100) : 0 })
          : p && e?.kind === 'kept' ? t('library.badgeWaiting') : '';
      if (badge.getText() !== text) badge.setText(text);
      badge.toggle(!!text);
      badge.toggleClass('is-kept', done && e?.kind === 'kept');
      const local = done || !!(it.vaultPath && this.plugin.app.vault.getAbstractFileByPath(it.vaultPath) instanceof TFile);
      row.toggleClass('is-offline', offline && !local);
    }
  }

  /** Show which row is playing, and whether it is paused: after a redraw, and as the player changes. */
  paintPlaying(list: HTMLElement): void {
    const np = this.plugin.nowPlaying;
    const path = np.track?.path;
    for (const row of Array.from(list.querySelectorAll<HTMLElement>('.mo-lib-media-row'))) {
      const on = row.dataset.path === path;
      const icon = on && np.playing ? 'pause' : 'play';
      row.toggleClass('is-playing', on);
      const button = row.querySelector<HTMLElement>('.mo-lib-play');
      if (button && button.dataset.icon !== icon) {
        button.dataset.icon = icon;
        setIcon(button, icon);
      }
    }
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
      this.play(it);
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
    // A failed job is past once a transcript is there (made again, or by hand).
    if (job && (job.state === 'queued' || job.state === 'claimed' || (job.state === 'failed' && !it.transcript))) {
      const label = job.state === 'queued' ? t('library.jobQueued') : job.state === 'claimed' ? t('library.jobClaimed') : t('library.jobFailed');
      const badge = meta.createSpan({ cls: `mo-lib-badge mo-lib-job-${job.state}`, text: label });
      if (job.error) badge.setAttr('title', job.error);
    } else if (!it.transcript) {
      meta.createSpan({ cls: 'mo-lib-badge', text: t('library.badgeNoTranscript') });
    }
    meta.createSpan({ cls: 'mo-lib-badge mo-lib-cache' });
    // Backups are kept track of for this vault's own media only.
    if (!it.backedUp && it.vaultPath) meta.createSpan({ cls: 'mo-lib-badge mo-lib-nobackup', text: t('library.badgeNoBackup'), attr: { title: t('library.badgeNoBackupTip') } });
    if (it.vaultPath && this.plugin.app.vault.getAbstractFileByPath(it.vaultPath) instanceof TFile) {
      meta.createSpan({ cls: 'mo-lib-badge', text: t('library.badgeOnDevice') });
    }

    // The row opens its transcript (which plays it too); the button just plays it here.
    main.addEventListener('click', () => {
      if (it.transcript) void this.plugin.openTranscript(it.transcript);
      else this.play(it);
    });
    const queue = row.createEl('button', { cls: 'clickable-icon mo-lib-queue' });
    queue.addEventListener('click', evt => {
      evt.stopPropagation();
      const { playlist } = this.plugin;
      if (playlist.has(it.path)) playlist.remove(it.path);
      else {
        playlist.add(this.entry(it), 'end');
        new Notice(t('library.playlistAdded', { name: this.entry(it).title }));
      }
    });
    const more = row.createEl('button', { cls: 'clickable-icon mo-lib-more-actions', attr: { 'aria-label': t('library.moreActions') } });
    setIcon(more, 'more-horizontal');
    more.addEventListener('click', evt => this.menu(evt, it));
    row.addEventListener('contextmenu', evt => {
      evt.preventDefault();
      this.menu(evt, it);
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

  private menu(evt: MouseEvent, it: Item): void {
    const menu = new Menu();
    menu.addItem(i => i.setTitle(t('library.menuPlay')).setIcon('play').onClick(() => this.play(it)));
    const { playlist } = this.plugin;
    menu.addItem(i => i.setTitle(t('library.menuPlayNext')).setIcon('list-start').onClick(() => playlist.add(this.entry(it), 'next')));
    if (playlist.has(it.path)) menu.addItem(i => i.setTitle(t('library.playlistRemove')).setIcon('list-x').onClick(() => playlist.remove(it.path)));
    else menu.addItem(i => i.setTitle(t('library.menuAddToPlaylist')).setIcon('list-plus').onClick(() => playlist.add(this.entry(it), 'end')));
    if (it.transcript) {
      const tr = it.transcript;
      menu.addItem(i => i.setTitle(t('library.menuOpenTranscript')).setIcon('file-text').onClick(() => { void this.plugin.openTranscript(tr); }));
    }
    const { cache } = this.plugin;
    if (cache.available) {
      const path = this.played(it);
      const e = cache.entry(path);
      if (cache.complete(path) && e?.kind === 'kept') {
        menu.addItem(i => i.setTitle(t('library.cacheRemove')).setIcon('trash-2').onClick(() => { void cache.remove(path); }));
      } else if (cache.complete(path)) {
        menu.addItem(i => i.setTitle(t('library.cacheKeep')).setIcon('pin').onClick(() => cache.keep(this.fetchable(it))));
        menu.addItem(i => i.setTitle(t('library.cacheRemove')).setIcon('trash-2').onClick(() => { void cache.remove(path); }));
      } else if (cache.progress(path) && e?.kind === 'kept') {
        menu.addItem(i => i.setTitle(t('library.cacheCancel')).setIcon('x').onClick(() => { void cache.remove(path); }));
      } else {
        const size = this.fetchable(it).size;
        menu.addItem(i => i.setTitle(size ? t('library.cacheDownloadSized', { size: formatSize(size) }) : t('library.cacheDownload'))
          .setIcon('download').onClick(() => cache.keep(this.fetchable(it))));
      }
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

  /** Play `it` in the player, or pause and resume it if it is the one playing. */
  private play(it: Item): void {
    const f = this.fetchable(it);
    const e = this.entry(it);
    this.plugin.nowPlaying.play({ path: e.path, key: e.key, url: f.url, size: e.size, title: e.title, subtitle: e.subtitle, transcript: it.transcript });
  }

  /** What the playlist keeps of `it`. */
  private entry(it: Item): QueueEntry {
    const f = this.fetchable(it);
    const collection = it.collection === this.own ? t('library.collectionMine') : it.collection;
    return {
      path: it.path,
      key: f.path,
      size: f.size,
      title: (isGenericName(it.name) && this.details.get(it.path)?.words) || it.title,
      subtitle: [collection, it.recorded ? formatWhen(it.recorded) : ''].filter(Boolean).join(' · '),
      transcript: it.transcript?.path ?? null,
    };
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
