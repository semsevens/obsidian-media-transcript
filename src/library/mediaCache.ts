import { Notice, Platform, requestUrl } from 'obsidian';
import { DAY_MS, toEvict, type CacheEntry, type PlayStats } from './cachePolicy';
import { formatSize } from '../utils/format';
import { t } from '../i18n';

const STORE = 'media-one-media';
const PIECE = 8 * 1024 * 1024;
const GB = 1000 * 1000 * 1000;
/** Room left free on the device, beyond what a download needs. */
const SPARE = 512 * 1024 * 1024;
const PREFIX = 'media-one:cache:';
/** Prefetched by itself: added this recently, audio, no larger than this. */
const PREFETCH_DAYS = 3;
const PREFETCH_MAX = 300 * 1024 * 1024;
const MIME: Record<string, string> = {
  m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
};

export interface CachePrefs {
  auto: boolean;        // keep what is played, and fetch new audio ahead
  wifiOnly: boolean;    // only fetch by itself on Wi-Fi
  limitGB: number;
}

/** Something that may be fetched: its library path, where to get it, its size if known. */
export interface Fetchable {
  path: string;
  url: string;
  size: number;
}

export interface Prefetchable extends Fetchable {
  added: number;        // ms
}

interface Job extends Fetchable {
  kind: CacheEntry['kind'];
}

/**
 * Media kept on this device to play without the server: what was played
 * (kept by itself, let go again when space is short) and what was downloaded
 * on purpose (kept until removed). In the app's own storage, not the vault,
 * so Obsidian Sync and iCloud never see it; for the device, not for one vault
 * (the files are the server's, whichever vault plays them).
 *
 * Fetched a piece at a time, so a download broken off (the phone put away)
 * goes on from where it was.
 */
export class MediaCache {
  private entries: Record<string, CacheEntry>;
  private stats: Record<string, PlayStats>;
  private queue: Job[] = [];
  private active: Job | null = null;
  private cancelled = new Set<string>();
  private urls = new Map<string, string>();
  private listeners = new Set<() => void>();
  private prefetched = 0;
  /** What is playing, never let go. */
  playing: string | null = null;

  constructor(private readonly server: () => string) {
    this.entries = read('entries', {});
    this.stats = read('stats', {});
  }

  /** Whether this device can keep media at all. */
  get available(): boolean {
    return typeof caches !== 'undefined';
  }

  get prefs(): CachePrefs {
    return { auto: true, wifiOnly: true, limitGB: Platform.isMobile ? 2 : 5, ...read<Partial<CachePrefs>>('prefs', {}) };
  }

  setPrefs(change: Partial<CachePrefs>): void {
    write('prefs', { ...read<Partial<CachePrefs>>('prefs', {}), ...change });
    this.changed();
    void this.trim();
    if (change.auto || change.wifiOnly === false) this.resume();
  }

  get limit(): number {
    return this.prefs.limitGB * GB;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** What this device has of it, or null. */
  entry(path: string): CacheEntry | null {
    return this.entries[path] ?? null;
  }

  complete(path: string): boolean {
    const e = this.entries[path];
    return !!e && e.size > 0 && e.have >= e.size;
  }

  /** Being fetched now (with how far), waiting to be, or neither. */
  progress(path: string): { have: number; size: number; active: boolean } | null {
    const e = this.entries[path];
    if (this.active?.path === path) return { have: e?.have ?? 0, size: e?.size || this.active.size, active: true };
    const queued = this.queue.find(j => j.path === path);
    if (queued) return { have: e?.have ?? 0, size: e?.size || queued.size, active: false };
    return null;
  }

  usage(): { auto: number; kept: number; total: number; files: number } {
    let auto = 0;
    let kept = 0;
    let files = 0;
    for (const e of Object.values(this.entries)) {
      if (e.kind === 'kept') kept += e.have;
      else auto += e.have;
      if (e.have > 0) files++;
    }
    return { auto, kept, total: auto + kept, files };
  }

  /** How it was listened to, kept for every file played. */
  statsOf(path: string): PlayStats | undefined {
    return this.stats[path];
  }

  /** It was listened to, up to `position` of `duration` seconds; `started` once each time it is played. */
  played(path: string, position: number, duration: number, started = false): void {
    const s = this.stats[path] ?? { position: 0, duration: 0, plays: 0, last: 0 };
    s.position = position;
    if (duration > 0) s.duration = duration;
    if (started) s.plays++;
    s.last = Date.now();
    this.stats[path] = s;
    const e = this.entries[path];
    if (e) e.used = s.last;
    this.saveSoon();
  }

  /** An address for the player: the copy on this device, if it has all of it. */
  async url(path: string): Promise<string | null> {
    if (!this.available || !this.complete(path)) return null;
    const known = this.urls.get(path);
    if (known) return known;
    const e = this.entries[path];
    try {
      const store = await caches.open(STORE);
      const pieces: Blob[] = [];
      for (let i = 0; i * PIECE < e.size; i++) {
        const r = await store.match(pieceKey(path, i));
        if (!r) throw new Error('missing piece');
        pieces.push(await r.blob());
      }
      const url = URL.createObjectURL(new Blob(pieces, { type: mimeOf(path) }));
      this.urls.set(path, url);
      e.used = Date.now();
      this.saveSoon();
      return url;
    } catch {
      // Gone from under us (the system cleared the app's storage): fetch it again when asked.
      e.have = 0;
      this.save();
      return null;
    }
  }

  /** Of these names (with or without extension), a complete copy here: its library path. */
  findByName(bases: string[]): string | null {
    const wanted = new Set(bases.map(b => b.toLowerCase()));
    for (const e of Object.values(this.entries)) {
      if (!this.complete(e.path)) continue;
      const name = e.path.slice(e.path.lastIndexOf('/') + 1).toLowerCase();
      if (wanted.has(name) || wanted.has(name.slice(0, name.lastIndexOf('.')))) return e.path;
    }
    return null;
  }

  /** Download on purpose: kept until removed. */
  keep(f: Fetchable): void {
    const e = this.entries[f.path];
    if (e) {
      e.kind = 'kept';
      this.save();
    }
    if (this.complete(f.path)) {
      this.changed();
      return;
    }
    this.queue = this.queue.filter(j => j.path !== f.path);
    if (this.active?.path === f.path) this.active.kind = 'kept';
    else this.queue.unshift({ ...f, kind: 'kept' });
    this.changed();
    void this.run();
  }

  /** Played: keep it too, by itself, where allowed. */
  auto(f: Fetchable): void {
    if (!this.mayFetchByItself() || this.entries[f.path] && this.complete(f.path)) return;
    if (this.active?.path === f.path || this.queue.some(j => j.path === f.path)) return;
    this.queue.push({ ...f, kind: 'auto' });
    void this.run();
  }

  /** New audio, fetched ahead on Wi-Fi so it plays offline: the latest first, while there is room. */
  prefetch(items: Prefetchable[]): void {
    if (!this.mayFetchByItself()) return;
    const since = Date.now() - PREFETCH_DAYS * DAY_MS;
    const room = this.limit * 0.3;
    for (const it of [...items].sort((a, b) => b.added - a.added)) {
      if (it.added < since) break;
      if (it.size > PREFETCH_MAX || this.entries[it.path] || this.stats[it.path]) continue;
      if (this.prefetched + it.size > room || this.usage().total + it.size > this.limit * 0.8) break;
      this.prefetched += it.size;
      this.auto(it);
    }
  }

  /** Go on with downloads broken off. */
  resume(): void {
    for (const e of Object.values(this.entries)) {
      if (this.complete(e.path) || e.size === 0) continue;
      if (e.kind === 'auto' && !this.mayFetchByItself()) continue;
      const f = { path: e.path, url: this.urlOf(e.path), size: e.size };
      if (e.kind === 'kept') this.keep(f);
      else this.auto(f);
    }
  }

  cancel(path: string): void {
    this.queue = this.queue.filter(j => j.path !== path);
    if (this.active?.path === path) this.cancelled.add(path);
    this.changed();
  }

  async remove(path: string): Promise<void> {
    this.cancel(path);
    const e = this.entries[path];
    delete this.entries[path];
    this.save();
    const url = this.urls.get(path);
    if (url && path !== this.playing) URL.revokeObjectURL(url);
    this.urls.delete(path);
    if (e && this.available) {
      const store = await caches.open(STORE);
      for (let i = 0; i * PIECE < Math.max(e.size, e.have, 1); i++) await store.delete(pieceKey(path, i));
    }
    this.changed();
  }

  /** Remove what was kept by itself, or everything. */
  async clear(which: 'auto' | 'all'): Promise<void> {
    for (const e of Object.values(this.entries)) {
      if (which === 'all' || e.kind === 'auto') await this.remove(e.path);
    }
  }

  /** Let go what policy says (see toEvict); say so when what was kept on purpose fills it. */
  async trim(): Promise<void> {
    const entries = Object.values(this.entries).filter(e => e.path !== this.active?.path);
    for (const path of toEvict(entries, this.stats, this.limit, Date.now(), this.playing)) await this.remove(path);
    const { kept, total } = this.usage();
    if (total > this.limit) {
      this.warnOnce('overLimit', t('library.cacheOverLimit', { used: formatSize(kept), limit: formatSize(this.limit) }));
    }
  }

  private mayFetchByItself(): boolean {
    const { auto, wifiOnly } = this.prefs;
    if (!auto || !this.available || !navigator.onLine) return false;
    if (this.usage().total >= this.limit) return false;
    const c = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection;
    if (wifiOnly && (c?.type === 'cellular' || c?.saveData)) return false;
    return true;
  }

  private urlOf(path: string): string {
    return `${this.server()}/library/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async run(): Promise<void> {
    if (this.active) return;
    while (this.queue.length) {
      const job = (this.active = this.queue.shift()!);
      this.changed();
      try {
        await this.fetch(job);
      } catch (e) {
        console.warn('[media-one] cache: could not fetch', job.path, e);
        // Taken up again with the next play or refresh.
        if (job.kind === 'kept') new Notice(t('library.cacheFailed', { name: nameOf(job.path), error: (e as Error).message }));
      }
      this.active = null;
      this.cancelled.delete(job.path);
      this.changed();
      await this.trim();
    }
  }

  private async fetch(job: Job): Promise<void> {
    const store = await caches.open(STORE);
    const now = Date.now();
    const e = (this.entries[job.path] ??= { path: job.path, size: job.size, have: 0, kind: job.kind, added: now, used: now });
    if (job.kind === 'kept') e.kind = 'kept';
    if (!e.size) e.size = job.size;
    // Room on the device for it.
    const free = await freeSpace();
    if (free !== null && free < (e.size || PIECE) - e.have + SPARE) {
      if (e.have === 0) delete this.entries[job.path];
      this.save();
      if (job.kind === 'kept') new Notice(t('library.cacheNoRoom', { name: nameOf(job.path), free: formatSize(free) }));
      else this.warnOnce('lowSpace', t('library.cacheLowSpace', { free: formatSize(free) }));
      return;
    }
    void navigator.storage?.persist?.().catch(() => false);
    // Pieces are whole PIECE-sized ranges: what is there already is kept.
    e.have = Math.floor(e.have / PIECE) * PIECE;
    while (!e.size || e.have < e.size) {
      if (this.cancelled.has(job.path)) return;
      if (e.kind === 'auto' && !this.mayFetchByItself()) return;
      const end = e.have + PIECE - 1;
      const r = await requestUrl({ url: job.url || this.urlOf(job.path), headers: { Range: `bytes=${e.have}-${end}` }, throw: false });
      if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const total = r.status === 206 ? Number(/\/(\d+)$/.exec(header(r.headers, 'content-range') ?? '')?.[1]) : r.arrayBuffer.byteLength;
      if (total) e.size = total;
      const body = r.status === 200 ? r.arrayBuffer.slice(e.have, e.have + PIECE) : r.arrayBuffer;
      await store.put(pieceKey(job.path, e.have / PIECE), new Response(body));
      e.have = Math.min(e.size, e.have + body.byteLength);
      if (body.byteLength === 0) throw new Error('empty piece');
      this.save();
      this.changed();
    }
    e.used = Date.now();
    this.save();
  }

  private warnOnce(reason: string, message: string): void {
    const last = read<number>(`warned:${reason}`, 0);
    if (Date.now() - last < DAY_MS) return;
    write(`warned:${reason}`, Date.now());
    new Notice(message, 15000);
  }

  private timer: number | null = null;

  private saveSoon(): void {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.save();
    }, 3000);
  }

  private save(): void {
    write('entries', this.entries);
    write('stats', this.stats);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** Before the plugin goes: keep what is known, and stop fetching. */
  close(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.save();
    this.queue = [];
    if (this.active) this.cancelled.add(this.active.path);
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}

function pieceKey(path: string, i: number): string {
  return `https://media-one.cache/${encodeURIComponent(path)}/${i}`;
}

function mimeOf(path: string): string {
  return MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function header(headers: Record<string, string>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

/** Bytes the app may still store, as the system says, or null if it won't say. */
async function freeSpace(): Promise<number | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e?.quota !== undefined ? e.quota - (e.usage ?? 0) : null;
  } catch {
    return null;
  }
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (e) {
    console.warn('[media-one] cache: could not keep', key, e);
  }
}
