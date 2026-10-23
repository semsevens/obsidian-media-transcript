import { FileSystemAdapter, Notice, Platform, TAbstractFile, TFile } from 'obsidian';
import type MediaTranscriptPlugin from '../main';
import { sha256Hex, type LibraryFile } from './client';
import { DeviceState } from './deviceState';
import { ASK_PIECE, streamSource, uploadInPieces, type PieceSource } from './pieceUpload';
import { fileSource } from './streamUpload';
import { t } from '../i18n';

// A recording still being written grows; wait until it stops.
const SETTLE_MS = 3000;
const RETRY_MS = 10 * 60_000;
// Up to this, a file is read whole and sent in one request. Larger, it is
// sent a piece at a time, read from disk (desktop) or as a stream (phone),
// and carried on after a break: over a slow line (some 50 KB/s through a
// relay) even a few minutes' recording takes long enough to want that.
const STREAM_FROM = 8 * 1024 * 1024;
/** After a failed try, the next comes sooner than the 10-minute round: a line that dropped is often back in a minute. */
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];

/** What is being uploaded, for the status bar and the library to show. */
export interface UploadStatus {
  name: string;
  size: number;
  sent: number;
  /** Bytes a second, over the last half minute or so; 0 until known. */
  rate: number;
  /** When the last piece went in (or the upload began). */
  moved: number;
  /** Sending; all sent, the server checking it; or waiting to try again at `retryAt`. */
  state: 'sending' | 'checking' | 'waiting';
  retryAt?: number;
  /** Files still waiting after this one. */
  queued: number;
}

/**
 * Uploads media added to the vault to the Media One server, so it is on the
 * server (and, from there, on every device) right away. The file stays in the
 * vault: removing it is left to the offload step, which waits for a backup.
 *
 * Files that can't be uploaded now (no server, no network) wait in a queue
 * kept on this device and are retried every 10 minutes and at startup.
 *
 * A file added while Obsidian wasn't running (copied into the vault in the
 * Finder, say) raises no event; nor does one passed over before (too large
 * for an earlier version). So at startup and with each retry, media added
 * since uploading was turned on that the server doesn't have is queued too.
 */
export class Uploader {
  private running = false;
  /** Stops a piece-by-piece upload when the plugin unloads, so none goes on behind it. */
  private readonly stopping = new AbortController();
  private readonly device: DeviceState;
  /** Vault paths this device still has to upload. */
  readonly pending: string[];
  status: UploadStatus | null = null;
  private readonly listeners = new Set<() => void>();
  private failures = 0;
  private retryTimer = 0;

  constructor(private readonly plugin: MediaTranscriptPlugin) {
    this.device = new DeviceState(plugin.app);
    this.pending = this.device.get<string[]>('pendingUploads', []);
  }

  /** Take over paths queued elsewhere (an older version's settings); missing files are skipped when uploading. */
  adopt(paths: string[]): void {
    const fresh = paths.filter(p => !this.pending.includes(p));
    if (fresh.length === 0) return;
    this.pending.push(...fresh);
    this.keep();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private show(status: UploadStatus | null): void {
    this.status = status;
    for (const fn of this.listeners) fn();
  }

  private keep(): void {
    this.device.set('pendingUploads', this.pending);
  }

  start(): void {
    const { plugin } = this;
    plugin.register(() => {
      this.stopping.abort();
      window.clearTimeout(this.retryTimer);
    });
    // Registered once the vault is loaded, so the existing files don't all count as new.
    plugin.app.workspace.onLayoutReady(() => {
      plugin.registerEvent(plugin.app.vault.on('create', f => this.added(f)));
      plugin.registerEvent(plugin.app.vault.on('rename', (f, old) => this.renamed(f, old)));
      plugin.registerEvent(plugin.app.vault.on('delete', f => this.forget(f.path)));
      void this.sweep().then(() => this.flush());
    });
    plugin.registerInterval(window.setInterval(() => void this.sweep().then(() => this.flush()), RETRY_MS));
    // A phone pauses the app in the background, an upload with it: carry on as soon as it is back.
    plugin.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.sweep().then(() => this.flush());
    });
  }

  /**
   * Since when this device uploads what is added: the first time it is seen
   * with uploading on. What was in the vault before is the backup's to copy.
   */
  private since(): number {
    let since = this.device.get<number>('uploadSince', 0);
    if (!since) {
      since = Date.now();
      this.device.set('uploadSince', since);
    }
    return since;
  }

  /** Uploading turned on: what is added from now on is new; what is there is not. */
  startCountingFromNow(): void {
    this.device.set('uploadSince', Date.now());
  }

  /** Queue media added since uploading was turned on that the server hasn't got. */
  async sweep(): Promise<number> {
    if (!this.enabled()) return 0;
    const since = this.since();
    const media = this.plugin.app.vault.getFiles().filter(f => this.wanted(f) && !this.pending.includes(f.path));
    if (media.length === 0) return 0;
    let files: LibraryFile[];
    try {
      files = await this.plugin.library.files();
    } catch {
      return 0;  // the server isn't there: the next round
    }
    const onServer = new Set(files.map(e => e.vaultPath));
    const missing: string[] = [];
    for (const f of media) {
      if (onServer.has(f.path)) continue;
      // Renamed on another device: whenever it came, it takes the new name.
      if (await this.followRename(f, files)) continue;
      if (f.stat.ctime >= since) missing.push(f.path);
    }
    if (missing.length) this.adopt(missing);
    return missing.length;
  }

  /** A recording or video of the vault's own, not a copy kept by the web archive. */
  private wanted(file: TFile): boolean {
    return this.plugin.isMedia(file) && !isArchiveCopy(file.path);
  }

  private enabled(): boolean {
    return this.plugin.settings.uploadNewMedia && this.plugin.library.configured;
  }

  private added(file: TAbstractFile): void {
    if (!(file instanceof TFile) || !this.wanted(file) || !this.enabled()) return;
    void this.enqueue(file.path);
  }

  private renamed(file: TAbstractFile, oldPath: string): void {
    const i = this.pending.indexOf(oldPath);
    if (i < 0) return;
    this.pending[i] = file.path;
    this.keep();
  }

  private forget(path: string): void {
    const i = this.pending.indexOf(path);
    if (i < 0) return;
    this.pending.splice(i, 1);
    this.keep();
  }

  async enqueue(path: string): Promise<void> {
    if (!this.pending.includes(path)) {
      this.pending.push(path);
      this.keep();
    }
    await this.flush();
  }

  /** Upload what is waiting, oldest first; stops at the first failure to reach the server. */
  async flush(): Promise<void> {
    if (this.running || !this.enabled() || this.pending.length === 0 || this.stopping.signal.aborted) return;
    this.running = true;
    window.clearTimeout(this.retryTimer);
    let failed = false;
    try {
      for (const path of [...this.pending]) {
        const outcome = await this.uploadOne(path);
        if (outcome === 'retry') {
          failed = true;
          break;
        }
        this.failures = 0;
        this.forget(path);
      }
    } finally {
      this.running = false;
    }
    if (!failed || this.stopping.signal.aborted) return this.show(null);
    // Not through: try again before long, then less often, up to the 10-minute round.
    const delay = BACKOFF_MS[Math.min(this.failures++, BACKOFF_MS.length - 1)];
    this.retryTimer = window.setTimeout(() => void this.flush(), delay);
    const waiting = this.status;
    this.show(waiting && { ...waiting, state: 'waiting', rate: 0, retryAt: Date.now() + delay });
  }

  /** 'done' (stored, already there, or nothing to do) or 'retry' later. */
  async uploadOne(path: string): Promise<'done' | 'retry'> {
    const { vault } = this.plugin.app;
    const file = vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return 'done';
    if (!(await this.settled(file))) return 'retry';
    // Renamed on the server since it was queued (from another device): renamed here too, not sent again.
    try {
      if (await this.followRename(file, await this.plugin.library.files())) return 'done';
    } catch {
      return 'retry';
    }
    const adapter = vault.adapter;
    const large = file.stat.size > STREAM_FROM;
    const size = file.stat.size;
    const status: UploadStatus = { name: file.name, size, sent: 0, rate: 0, moved: Date.now(), state: 'sending', queued: Math.max(0, this.pending.length - 1) };
    this.show(status);
    try {
      let stored: boolean;
      if (large) {
        // The rate over the last half minute or so: when the bar last moved, from where.
        const marks: Array<[number, number]> = [];
        let shown = -1;
        const onProgress = (sent: number) => {
          const now = Date.now();
          marks.push([now, sent]);
          while (marks.length > 2 && now - marks[1][0] > 30_000) marks.shift();
          const [t0, s0] = marks[0];
          const rate = now - t0 > 2000 && sent > s0 ? ((sent - s0) / (now - t0)) * 1000 : status.rate;
          const percent = Math.floor((sent / size) * 1000);
          if (percent === shown && rate === status.rate) return;
          shown = percent;
          // All sent: the server puts the pieces together and checks the file.
          this.show(Object.assign(status, { sent, rate, moved: now, state: sent >= size ? 'checking' : 'sending' }));
        };
        let source: PieceSource;
        if (Platform.isDesktopApp && adapter instanceof FileSystemAdapter) {
          source = await fileSource(adapter.getFullPath(file.path));
        } else {
          // The app serves vault files with ranges: read from where a piece starts, as a stream.
          const url = vault.getResourcePath(file);
          source = streamSource(async offset => {
            const r = await fetch(url, { headers: { Range: `bytes=${offset}-` } });
            if (!r.ok || !r.body) throw new Error(`can't read ${file.path} (${r.status})`);
            if (offset > 0 && r.status !== 206) throw new Error(`can't read ${file.path} from the middle`);
            return r.body;
          });
        }
        const library = this.plugin.library;
        stored = await uploadInPieces(library, () => library.uploadBegin(file.path, size, ASK_PIECE), size, source, onProgress, this.stopping.signal);
      } else {
        const data = await vault.readBinary(file);
        stored = await this.plugin.library.upload(file.path, data, await sha256Hex(data));
      }
      if (stored) new Notice(t('library.uploaded', { name: file.name }));
      this.plugin.mediaLocator.invalidate();
      return 'done';
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status === 409) {
        new Notice(t('library.uploadConflict', { name: file.name, path: file.path }), 10000);
        return 'done';
      }
      if (status === 400) {
        console.warn(`[media-one] upload of ${path} refused:`, e);
        return 'done';
      }
      return 'retry';
    }
  }

  /**
   * This device's copy of a file the server has under another name: renamed
   * on another device, where this copy isn't (media isn't synced). Given the
   * server's name here too, rather than uploaded again as a new file.
   */
  private async followRename(file: TFile, files: LibraryFile[]): Promise<boolean> {
    const was = `${this.plugin.library.folder}/${file.path}`;
    const now = files.find(e => e.original?.path === was && e.vaultPath !== file.path && e.size === file.stat.size);
    if (!now) return false;
    const { vault, fileManager } = this.plugin.app;
    if (vault.getAbstractFileByPath(now.vaultPath)) return false;
    const dir = now.vaultPath.includes('/') ? now.vaultPath.slice(0, now.vaultPath.lastIndexOf('/')) : '';
    if (dir && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
    const from = file.name;
    await fileManager.renameFile(file, now.vaultPath);
    new Notice(t('library.followedRename', { from, to: now.vaultPath }));
    return true;
  }

  /** Wait until the file stops growing (a recording being written, a copy in progress). */
  private async settled(file: TFile): Promise<boolean> {
    const adapter = this.plugin.app.vault.adapter;
    let size = (await adapter.stat(file.path))?.size ?? -1;
    for (let i = 0; i < 20; i++) {
      await sleep(SETTLE_MS);
      const now = (await adapter.stat(file.path))?.size ?? -1;
      if (now === size && now > 0) return true;
      size = now;
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

/**
 * A web archive copy (<bucket>/<sha1 of its URL>.<ext>, in the vault's archive
 * folder or another device's seen through a synced or linked folder): it lives
 * in the server's archive already, and is no recording.
 */
export function isArchiveCopy(path: string): boolean {
  return /(^|\/)([0-9a-f]{2})\/\2[0-9a-f]{38}\.[^./]+$/.test(path);
}
