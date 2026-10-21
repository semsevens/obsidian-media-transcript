import { FileSystemAdapter, Platform, TAbstractFile, TFile, normalizePath } from 'obsidian';
import type MediaTranscriptPlugin from './main';
import { readSource, writeSource } from './utils/transcriptSource';

interface CachedSource { mtime: number; size: number; source: string | null }
interface CacheFile { version: 1; files: Record<string, CachedSource> }

// Read this many transcripts at a time. Node reads files on a pool of four
// threads that Obsidian shares, so a few at a time keeps a slow read from
// holding up everything else (plugin manifests, notes).
const BATCH = 2;
const SAVE_DELAY_MS = 2000;

/**
 * Which media each transcript belongs to, by what the transcript says
 * (`source`, or a link picked by hand) rather than by its filename.
 *
 * It answers "which transcripts are for talk.m4a?" for notes that embed or
 * link media that has left the vault, even after a transcript was renamed.
 * Everything here is derived from the files and rebuilt whenever they
 * change, so a rename made outside Obsidian is picked up the next time the
 * file is seen. The copy kept on disk only saves re-reading unchanged files
 * at startup; deleting it loses nothing.
 */
export class TranscriptIndex {
  private sources = new Map<string, string | null>(); // transcript path → media filename
  private byMedia = new Map<string, Set<string>>();    // lower-cased media filename → transcript paths
  private cache: Record<string, CachedSource> = {};
  private building: Promise<void> | null = null;
  private saveTimer: number | null = null;
  private listeners: Array<() => void> = [];

  constructor(private plugin: MediaTranscriptPlugin) {}

  private get app() { return this.plugin.app; }

  private get cachePath(): string {
    const dir = this.plugin.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
    return normalizePath(`${dir}/transcript-sources.json`);
  }

  /** Index the vault in the background and keep it current. */
  start() {
    const { vault } = this.app;
    this.plugin.registerEvent(vault.on('create', f => this.update(f)));
    this.plugin.registerEvent(vault.on('modify', f => this.update(f)));
    this.plugin.registerEvent(vault.on('delete', f => this.forget(f.path)));
    this.plugin.registerEvent(vault.on('rename', (f, oldPath) => {
      this.forget(oldPath);
      this.update(f);
    }));
    this.building = this.build();
  }

  stop() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
  }

  /** Called once the first full index is ready (and again after later changes). */
  onChange(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(f => f !== fn); };
  }

  whenReady(): Promise<void> { return this.building ?? Promise.resolve(); }

  /** The media filename `file` belongs to, if it says. */
  async sourceOf(file: TFile): Promise<string | null> {
    const linked = this.plugin.settings.mediaLinks[file.path];
    if (linked) return linked;
    if (!this.isCandidate(file)) return null;
    if (this.sources.has(file.path) && this.cache[file.path]?.mtime === file.stat.mtime) {
      return this.sources.get(file.path) ?? null;
    }
    return this.read(file);
  }

  /** Transcripts that name `mediaName` (a filename, any folder) as their media. */
  transcriptsFor(mediaName: string): TFile[] {
    const name = mediaName.replace(/^.*[\\/]/, '').toLowerCase();
    const paths = new Set(this.byMedia.get(name) ?? []);
    for (const [path, linked] of Object.entries(this.plugin.settings.mediaLinks)) {
      if (linked.toLowerCase() === name) paths.add(path);
    }
    const out: TFile[] = [];
    for (const path of paths) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) out.push(f);
    }
    return out;
  }

  /**
   * Record that `file` is the transcript of `mediaName`: inside the file for
   * JSON, where it then travels with the file; in settings for .srt/.vtt,
   * which have nowhere to keep it.
   */
  async setSource(file: TFile, mediaName: string) {
    const name = mediaName.replace(/^.*[\\/]/, '');
    const settings = this.plugin.settings;
    if (file.extension.toLowerCase() === 'json') {
      let written = false;
      await this.app.vault.process(file, text => {
        const out = writeSource(text, name);
        written = out !== null;
        return out ?? text;
      });
      if (written) {
        if (settings.mediaLinks[file.path]) {
          delete settings.mediaLinks[file.path];
          await this.plugin.saveSettings();
        }
        await this.read(file);
        return;
      }
    }
    settings.mediaLinks[file.path] = name;
    await this.plugin.saveSettings();
    this.notify();
  }

  /** Keep hand-made links attached to a transcript that was renamed in Obsidian. */
  async moveLink(oldPath: string, newPath: string) {
    const links = this.plugin.settings.mediaLinks;
    if (!(oldPath in links)) return;
    links[newPath] = links[oldPath];
    delete links[oldPath];
    await this.plugin.saveSettings();
  }

  // ── Building ──────────────────────────────────────────────────────────────

  // Only JSON carries a source; .srt/.vtt are matched by name or by hand.
  private isCandidate(f: TAbstractFile): f is TFile {
    return f instanceof TFile && f.extension.toLowerCase() === 'json';
  }

  private async build() {
    await this.loadCache();
    const files = this.app.vault.getFiles().filter(f => this.isCandidate(f));
    const fresh: Record<string, CachedSource> = {};
    let pending: TFile[] = [];
    for (const f of files) {
      const hit = this.cache[f.path];
      if (hit && hit.mtime === f.stat.mtime && hit.size === f.stat.size) {
        fresh[f.path] = hit;
        this.put(f.path, hit.source);
      } else {
        pending.push(f);
      }
    }
    this.cache = fresh;
    while (pending.length > 0) {
      const batch = pending.slice(0, BATCH);
      pending = pending.slice(BATCH);
      await Promise.all(batch.map(f => this.read(f, false)));
      await new Promise(r => window.setTimeout(r, 0));
    }
    this.scheduleSave();
    this.notify();
  }

  private async read(file: TFile, announce = true): Promise<string | null> {
    if (await isOffloaded(this.app.vault.adapter, file)) {
      // Reading it would make iCloud download it. It is read once it is back
      // on disk (next start), or when it is opened; not caching it ensures that.
      return this.sources.get(file.path) ?? null;
    }
    let source: string | null = null;
    try {
      source = readSource(await this.app.vault.cachedRead(file));
    } catch {
      source = null;
    }
    const before = this.sources.get(file.path);
    this.cache[file.path] = { mtime: file.stat.mtime, size: file.stat.size, source };
    this.put(file.path, source);
    this.scheduleSave();
    if (announce && before !== source) this.notify();
    return source;
  }

  private update(f: TAbstractFile) {
    if (this.isCandidate(f)) void this.read(f);
  }

  private put(path: string, source: string | null) {
    this.unlink(path);
    this.sources.set(path, source);
    if (!source) return;
    const key = source.toLowerCase();
    let set = this.byMedia.get(key);
    if (!set) this.byMedia.set(key, set = new Set());
    set.add(path);
  }

  private forget(path: string) {
    if (!this.sources.has(path)) return;
    this.unlink(path);
    this.sources.delete(path);
    delete this.cache[path];
    this.scheduleSave();
    this.notify();
  }

  private unlink(path: string) {
    const old = this.sources.get(path);
    if (!old) return;
    const set = this.byMedia.get(old.toLowerCase());
    set?.delete(path);
    if (set?.size === 0) this.byMedia.delete(old.toLowerCase());
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  // ── The on-disk copy ──────────────────────────────────────────────────────

  private async loadCache() {
    try {
      const data = JSON.parse(await this.app.vault.adapter.read(this.cachePath)) as Partial<CacheFile>;
      if (data.version === 1 && data.files && typeof data.files === 'object') this.cache = data.files;
    } catch {
      this.cache = {}; // missing or unreadable: just read everything
    }
  }

  private scheduleSave() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      const data: CacheFile = { version: 1, files: this.cache };
      void this.app.vault.adapter.write(this.cachePath, JSON.stringify(data)).catch(() => {});
    }, SAVE_DELAY_MS);
  }
}

// The little of Node used here, typed locally (the project keeps Node types out).
interface NodeStat { size: number; blocks: number }
interface NodeFs { promises: { stat(path: string): Promise<NodeStat> } }

/**
 * Whether the file is only a placeholder of one iCloud offloaded: it has a size
 * but no data on disk. stat doesn't download it; reading would, and every read
 * waiting on a download ties up a thread Obsidian needs. Desktop only.
 */
async function isOffloaded(adapter: unknown, file: TFile): Promise<boolean> {
  if (!Platform.isDesktopApp || !(adapter instanceof FileSystemAdapter) || file.stat.size === 0) return false;
  try {
    const req = (window as unknown as { require: (id: string) => unknown }).require;
    const fs = req('fs') as NodeFs;
    const st = await fs.promises.stat(adapter.getFullPath(file.path));
    return st.size > 0 && st.blocks === 0;
  } catch {
    return false;
  }
}
