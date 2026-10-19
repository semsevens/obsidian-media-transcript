import { App, Platform, TFile, normalizePath, requestUrl } from 'obsidian';
import type { MediaTranscriptSettings } from './settings';
import { findMediaForSubtitle } from './utils/subtitleFinder';
import { t } from './i18n';
import { RemoteIndex, isArchiveName, nameKey, parseRemoteIndex, readUrl, remotePathUrl } from './utils/transcriptSource';
import {
  MediaEntry,
  audioTwin,
  icloudPlaceholderName,
  isAbsoluteFolder,
  pickMedia,
  remoteCandidates,
  remoteFileUrl,
  subtitleBaseCandidates,
  subtitleBaseName,
} from './utils/mediaMatch';

/** Media ready to hand to an <audio>/<video> element, wherever it lives. */
export interface ResolvedMedia {
  src: string;          // URL the player loads
  basename: string;
  extension: string;    // lowercase
  file: TFile | null;   // set when the media is a vault file
  location: string;     // vault path or absolute path — for display and data attributes
  // For a video: an audio file of the same name beside it (an .m4a made for
  // listening), played instead when the picture is hidden — it is a fraction
  // of the size, so it starts sooner, above all from a server.
  audioTwin?: ResolvedMedia | null;
  // An archived web video: shown by its transcript's name (the media's is a
  // hash), with the address it came from, to find the notes that show it.
  title?: string;
  origin?: string;
}

export interface MediaLookup {
  media: ResolvedMedia | null;
  // Where we looked, in order, for the "no media" hint — so an unplugged
  // drive or a typo in settings is visible instead of a silent miss.
  searched: string[];
}

export function vaultMedia(app: App, file: TFile): ResolvedMedia {
  return {
    src: app.vault.getResourcePath(file),
    basename: file.basename,
    extension: file.extension.toLowerCase(),
    file,
    location: file.path,
  };
}

// An external folder is listed once and remembered; a miss rescans it, but not
// more often than this, so a transcript that genuinely has no media doesn't
// walk a 2 TB drive on every open.
const RESCAN_AFTER_MS = 30_000;
// Guards against pointing the setting at `/` or a home folder by accident.
const MAX_DEPTH = 12;
const MAX_ENTRIES = 200_000;
// A remote server that hasn't answered by now is treated as unreachable, so a
// sleeping machine costs a short wait rather than a hung transcript.
const REMOTE_TIMEOUT_MS = 5000;
// …and remembered as such for a while, so opening several transcripts while
// it's down doesn't cost the wait each time.
const REMOTE_RETRY_AFTER_MS = 60_000;
// A server's index.json is fetched once and reused; a name it doesn't list
// refetches it, but not more often than this.
const REMOTE_INDEX_REFRESH_MS = 30_000;

// The little of Node this file uses, typed locally: the project keeps Node
// types out of tsconfig so nothing else picks up a dependency mobile lacks.
interface NodeDirent { name: string; isDirectory(): boolean; isFile(): boolean }
interface NodeModules {
  fs: { promises: { readdir(dir: string, opts: { withFileTypes: true }): Promise<NodeDirent[]> } };
  path: { join(...parts: string[]): string };
  os: { homedir(): string };
}
function nodeModules(): NodeModules {
  const req = (window as unknown as { require: (id: string) => unknown }).require;
  return {
    fs: req('fs') as NodeModules['fs'],
    path: req('path') as NodeModules['path'],
    os: req('os') as NodeModules['os'],
  };
}

/** Something a transcript could be linked to by hand, for the picker. */
export interface MediaChoice { name: string; where: string }

interface ServerIndex {
  fetchedAt: number;
  index: RemoteIndex | null; // null = the server has no index.json: files are flat, by name
}

interface FolderIndex {
  scannedAt: number;
  entries: MediaEntry<string>[] | null; // null = folder unavailable (unplugged, typo)
}

/**
 * Finds the media for a subtitle, in order:
 *   1. the subtitle's own folder
 *   2. each configured media folder, recursively — a vault folder, or (desktop
 *      only) an absolute folder outside the vault such as an external drive or
 *      an iCloud Drive folder
 *   3. each remote media URL — a home server reached over Tailscale, say —
 *      streamed rather than downloaded
 *
 * Matching is by filename alone (see mediaMatch.ts), so the media can be
 * filed however you like as long as its name is kept.
 */
export class MediaLocator {
  private external = new Map<string, FolderIndex>();
  private scanning = new Map<string, Promise<FolderIndex>>();
  private unreachableSince = new Map<string, number>(); // remote base → when it last timed out
  private serverIndexes = new Map<string, ServerIndex>();
  private fetchingIndexes = new Map<string, Promise<ServerIndex | null>>();

  constructor(
    private app: App,
    private settings: () => MediaTranscriptSettings,
    // What the transcript itself says its media is called (see TranscriptIndex).
    private sourceOf: (subtitle: TFile) => Promise<string | null>,
    // A copy kept on this device, by name (see MediaCache): played before asking a server.
    private cached: (names: string[]) => Promise<ResolvedMedia | null> = () => Promise.resolve(null),
  ) {}

  /** Forget external listings and server indexes (settings changed, or a retry). */
  invalidate() {
    this.external.clear();
    this.unreachableSince.clear();
    this.serverIndexes.clear();
  }

  /** List external folders in the background so the first open is instant. */
  warm() {
    for (const folder of this.settings().mediaFolders) {
      if (isAbsoluteFolder(folder) && Platform.isDesktopApp) void this.indexOf(folder);
    }
  }

  async resolveForSubtitle(subtitle: TFile): Promise<MediaLookup> {
    const settings = this.settings();
    const searched: string[] = [];

    // The name the transcript gives is trusted first; its own filename is
    // only a guess, and the only clue for transcripts that don't say.
    const source = await this.sourceOf(subtitle);
    if (source && isArchiveName(source)) {
      const archived = await this.archivedMedia(subtitle, source, searched);
      if (archived) return { media: archived, searched };
    }
    const candidates = subtitleBaseCandidates(subtitle.name);
    const isMedia = (ext: string) =>
      [...settings.supportedVideoExtensions, ...settings.supportedAudioExtensions].includes(ext.toLowerCase());
    const pick = <T>(entries: Iterable<MediaEntry<T>>): T | null => {
      const list = Array.from(entries);
      if (source) {
        const wanted = source.toLowerCase();
        const exact = list.find(e => `${e.basename}.${e.extension}`.toLowerCase() === wanted);
        if (exact) return exact.ref;
      }
      return pickMedia(candidates, list, settings.supportedVideoExtensions, settings.supportedAudioExtensions);
    };

    const fromServers = async (): Promise<MediaLookup | null> => {
      const kept = await this.cached(source ? [source, ...candidates] : candidates);
      if (kept) {
        searched.push(t('core.searchedDevice'));
        return { media: kept, searched };
      }
      for (const base of settings.mediaUrls) {
        const { url, twin, reachable } = await this.findRemote(base, candidates, source);
        searched.push(reachable ? base : t('core.searchedUnreachable', { place: base }));
        if (url) return { media: { ...this.remoteMedia(url), audioTwin: twin ? this.remoteMedia(twin) : null }, searched };
      }
      return null;
    };
    // A server copy is preferred over one on disk that may first have to be
    // downloaded (iCloud keeps only placeholders of files it offloaded).
    if (settings.preferRemote) {
      const remote = await fromServers();
      if (remote) return remote;
    }

    const dir = subtitle.parent?.path ?? '';
    searched.push(t('core.searchedSameFolder', { dir: dir || '/' }));
    const siblings = this.app.vault.getFiles().filter(f => (f.parent?.path ?? '') === dir)
      .map(f => ({ basename: f.basename, extension: f.extension, ref: f }));
    const sibling = source ? pick(siblings) : findMediaForSubtitle(subtitle, this.app.vault, settings);
    if (sibling) return { media: this.vaultMediaWithTwin(sibling), searched };

    // Named media elsewhere in the vault — the transcript was moved, not its media.
    if (source) {
      searched.push(t('core.searchedVault', { name: source }));
      const elsewhere = this.app.metadataCache.getFirstLinkpathDest(source, subtitle.path);
      if (elsewhere && isMedia(elsewhere.extension)) return { media: this.vaultMediaWithTwin(elsewhere), searched };
    }

    for (const folder of settings.mediaFolders) {
      if (!isAbsoluteFolder(folder)) {
        searched.push(folder);
        const file = pick(this.vaultEntries(folder));
        if (file) return { media: this.vaultMediaWithTwin(file), searched };
        continue;
      }

      if (!Platform.isDesktopApp) {
        searched.push(t('core.searchedDesktopOnly', { place: folder }));
        continue;
      }
      let index = await this.indexOf(folder);
      let path = index.entries ? pick(index.entries) : null;
      if (!path && Date.now() - index.scannedAt > RESCAN_AFTER_MS) {
        index = await this.indexOf(folder, true);
        path = index.entries ? pick(index.entries) : null;
      }
      searched.push(index.entries ? folder : t('core.searchedUnavailable', { place: folder }));
      if (path) {
        const twin = this.twinName(path, (_, sibling) => index.entries?.find(e => e.ref === sibling)?.ref ?? null);
        return { media: { ...this.externalMedia(path), audioTwin: twin ? this.externalMedia(twin) : null }, searched };
      }
    }

    if (!settings.preferRemote) {
      const remote = await fromServers();
      if (remote) return remote;
    }

    return { media: null, searched };
  }

  /** Every media file we can see, for linking a transcript to one by hand. */
  async listAll(): Promise<MediaChoice[]> {
    const settings = this.settings();
    const exts = [...settings.supportedVideoExtensions, ...settings.supportedAudioExtensions];
    const out: MediaChoice[] = [];
    const seen = new Set<string>();
    const add = (name: string, where: string) => {
      const key = `${name}\u0000${where}`;
      if (!seen.has(key)) { seen.add(key); out.push({ name, where }); }
    };
    for (const f of this.app.vault.getFiles()) {
      if (exts.includes(f.extension.toLowerCase())) add(f.name, f.parent?.path || '/');
    }
    for (const folder of settings.mediaFolders) {
      if (!isAbsoluteFolder(folder) || !Platform.isDesktopApp) continue;
      const index = await this.indexOf(folder);
      for (const e of index.entries ?? []) add(`${e.basename}.${e.extension}`, folder);
    }
    for (const base of settings.mediaUrls) {
      const server = await this.serverIndex(base);
      for (const name of server?.index?.names ?? []) add(name, base);
    }
    return out;
  }

  /**
   * Find the media on a server. With an index.json, by name in the index —
   * the server may keep files in any folders, under any name they've had.
   * Without one, ask for each candidate file directly under `base`.
   */
  private async findRemote(
    base: string, candidates: string[], source: string | null,
  ): Promise<{ url: string | null; twin: string | null; reachable: boolean }> {
    let server = await this.serverIndex(base);
    if (!server) return { url: null, twin: null, reachable: false };
    if (!server.index) return this.probeRemote(base, candidates, source);

    let path = this.lookUp(server.index, candidates, source);
    if (!path && Date.now() - server.fetchedAt > REMOTE_INDEX_REFRESH_MS) {
      this.serverIndexes.delete(base);
      server = await this.serverIndex(base);
      path = server?.index ? this.lookUp(server.index, candidates, source) : null;
    }
    if (!path || !server?.index) return { url: null, twin: null, reachable: true };
    const index = server.index;
    const twin = this.twinName(path, name => index.byName.get(nameKey(name)) ?? null);
    return { url: remotePathUrl(base, path), twin: twin ? remotePathUrl(base, twin) : null, reachable: true };
  }

  private twinName(path: string, find: (name: string, sibling: string) => string | null): string | null {
    const settings = this.settings();
    return audioTwin(path, settings.supportedVideoExtensions, settings.supportedAudioExtensions, find);
  }

  /** A vault file as media, with its audio twin beside it (see ResolvedMedia). */
  vaultMediaWithTwin(file: TFile): ResolvedMedia {
    const twin = this.twinName(file.path, (_, sibling) =>
      this.app.vault.getAbstractFileByPath(sibling) instanceof TFile ? sibling : null);
    const twinFile = twin ? this.app.vault.getAbstractFileByPath(twin) : null;
    return { ...vaultMedia(this.app, file), audioTwin: twinFile instanceof TFile ? vaultMedia(this.app, twinFile) : null };
  }

  private lookUp(index: RemoteIndex, candidates: string[], source: string | null): string | null {
    if (source) {
      const hit = index.byName.get(nameKey(source));
      if (hit) return hit;
    }
    const settings = this.settings();
    const entries = remoteCandidates(
      candidates, [...settings.supportedVideoExtensions, ...settings.supportedAudioExtensions],
    )
      .map(e => ({ ...e, ref: index.byName.get(nameKey(e.ref)) ?? '' }))
      .filter(e => e.ref !== '');
    return pickMedia(candidates, entries, settings.supportedVideoExtensions, settings.supportedAudioExtensions);
  }

  /** The server's index (or that it has none), or null when it can't be reached. */
  private async serverIndex(base: string): Promise<ServerIndex | null> {
    const cached = this.serverIndexes.get(base);
    if (cached) return cached;
    let job = this.fetchingIndexes.get(base);
    if (!job) {
      const since = this.unreachableSince.get(base);
      if (since !== undefined && Date.now() - since < REMOTE_RETRY_AFTER_MS) return null;
      job = this.fetchIndex(base);
      this.fetchingIndexes.set(base, job);
      void job.finally(() => this.fetchingIndexes.delete(base));
    }
    // Everything looking at once shares one download. Waiting is capped, but
    // the download carries on: if it arrives late it is kept and the server
    // counts as reachable again, instead of being skipped for a minute.
    const timeout = new Promise<'timeout'>(r => window.setTimeout(() => r('timeout'), REMOTE_TIMEOUT_MS));
    const res = await Promise.race([job, timeout]);
    if (res === 'timeout') {
      if (!this.serverIndexes.has(base)) this.unreachableSince.set(base, Date.now());
      return this.serverIndexes.get(base) ?? null;
    }
    return res;
  }

  private async fetchIndex(base: string): Promise<ServerIndex | null> {
    // A plain file server sends no caching rules, so without no-cache the
    // index can be answered from a stale copy and point at moved files.
    const res = await requestUrl({ url: remotePathUrl(base, 'index.json'), headers: { 'Cache-Control': 'no-cache' }, throw: false })
      .then(r => ({ status: r.status, text: r.status === 200 ? r.text : '' }), () => null);
    if (!res) {
      this.unreachableSince.set(base, Date.now());
      return null;
    }
    this.unreachableSince.delete(base);
    const server = { fetchedAt: Date.now(), index: res.status === 200 ? parseRemoteIndex(res.text) : null };
    this.serverIndexes.set(base, server);
    return server;
  }

  /**
   * A server without an index.json: ask `base` for every candidate file at
   * once and keep the best that exists. It can't be listed, so the remote
   * folder is taken to be flat.
   * requestUrl rather than fetch: it isn't subject to CORS, which a plain file
   * server doesn't speak, and it works on mobile.
   */
  private async probeRemote(
    base: string, candidates: string[], source: string | null,
  ): Promise<{ url: string | null; twin: string | null; reachable: boolean }> {
    const settings = this.settings();
    const wanted = remoteCandidates(
      candidates,
      [...settings.supportedVideoExtensions, ...settings.supportedAudioExtensions],
    );
    if (source) {
      const dot = source.lastIndexOf('.');
      wanted.unshift({ basename: source.slice(0, dot), extension: source.slice(dot + 1).toLowerCase(), ref: source });
    }
    let reachable = false;
    const timeout = new Promise<null>(r => window.setTimeout(() => r(null), REMOTE_TIMEOUT_MS));
    const results = await Promise.all(wanted.map(async entry => {
      const url = remoteFileUrl(base, entry.ref);
      const status = await Promise.race([
        requestUrl({ url, method: 'HEAD', throw: false }).then(r => r.status, () => null),
        timeout,
      ]);
      if (status !== null) reachable = true; // any answer, even a 404, means it's up
      return status !== null && status < 400 ? { ...entry, ref: url } : null;
    }));
    if (reachable) this.unreachableSince.delete(base);
    else this.unreachableSince.set(base, Date.now());
    const found = results.filter((e): e is MediaEntry<string> => e !== null);
    // The transcript's own word first (it leads `wanted`), then the name rule.
    const exact = source ? found.find(e => decodeURIComponent(e.ref.slice(e.ref.lastIndexOf('/') + 1)) === source) : undefined;
    const url = exact?.ref ??
      pickMedia(candidates, found, settings.supportedVideoExtensions, settings.supportedAudioExtensions);
    const twin = url ? this.twinName(url, (_, sibling) => found.find(e => e.ref === sibling)?.ref ?? null) : null;
    return { url, twin, reachable };
  }

  /**
   * A video kept in the web archive (its transcript's source is the archive
   * name): the server's copy, or else the address it was archived from.
   */
  private async archivedMedia(subtitle: TFile, name: string, searched: string[]): Promise<ResolvedMedia | null> {
    const original = readUrl(await this.app.vault.cachedRead(subtitle)) ?? undefined;
    const named = (media: ResolvedMedia): ResolvedMedia =>
      ({ ...media, title: subtitleBaseName(subtitle.name), origin: original });
    const server = this.settings().serverUrl;
    if (server) {
      const url = `${server}/archive/${name.slice(0, 2)}/${name}`;
      searched.push(`${server}/archive`);
      const r = await Promise.race([
        requestUrl({ url, method: 'HEAD', throw: false }).catch(() => null),
        new Promise<null>(resolve => window.setTimeout(() => resolve(null), REMOTE_TIMEOUT_MS)),
      ]);
      if (r?.status === 200) return named(this.remoteMedia(url));
    }
    if (!original) return null;
    searched.push(original);
    // Played from the original address, but known by the archive name its transcripts give.
    return named({ ...this.remoteMedia(original), basename: name.slice(0, name.lastIndexOf('.')), extension: name.slice(name.lastIndexOf('.') + 1) });
  }

  private remoteMedia(url: string): ResolvedMedia {
    const name = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    const dot = name.lastIndexOf('.');
    return {
      src: url,
      basename: name.slice(0, dot),
      extension: name.slice(dot + 1).toLowerCase(),
      file: null,
      location: url,
    };
  }

  private vaultEntries(folder: string): MediaEntry<TFile>[] {
    const prefix = normalizePath(folder) + '/';
    return this.app.vault.getFiles()
      .filter(f => f.path.startsWith(prefix))
      .map(f => ({ basename: f.basename, extension: f.extension, ref: f }));
  }

  private externalMedia(absPath: string): ResolvedMedia {
    const name = absPath.split(/[\\/]/).pop() ?? absPath;
    const dot = name.lastIndexOf('.');
    // Obsidian serves local files under its own resource scheme; the vault's
    // getResourcePath builds the same kind of URL for files inside the vault.
    const urlPath = absPath.replace(/\\/g, '/').replace(/^\//, '')
      .split('/').map(encodeURIComponent).join('/');
    return {
      src: Platform.resourcePathPrefix + urlPath,
      basename: name.slice(0, dot),
      extension: name.slice(dot + 1).toLowerCase(),
      file: null,
      location: absPath,
    };
  }

  private indexOf(folder: string, force = false): Promise<FolderIndex> {
    const cached = this.external.get(folder);
    if (cached && !force) return Promise.resolve(cached);
    const running = this.scanning.get(folder);
    if (running) return running;

    const job = this.scan(folder)
      .then(entries => ({ scannedAt: Date.now(), entries }))
      .catch(() => ({ scannedAt: Date.now(), entries: null }))
      .then(index => {
        this.external.set(folder, index);
        this.scanning.delete(folder);
        return index;
      });
    this.scanning.set(folder, job);
    return job;
  }

  // Desktop only: Node's fs is required lazily so mobile never loads it.
  private async scan(folder: string): Promise<MediaEntry<string>[]> {
    const { fs, path, os } = nodeModules();

    const root = folder.startsWith('~') ? path.join(os.homedir(), folder.slice(1)) : folder;
    const settings = this.settings();
    const exts = new Set(
      [...settings.supportedVideoExtensions, ...settings.supportedAudioExtensions].map(e => e.toLowerCase()),
    );
    const out: MediaEntry<string>[] = [];

    const walk = async (dir: string, depth: number) => {
      if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return;
      // A missing root throws (→ "unavailable"); an unreadable subfolder is skipped.
      const items = depth === 0
        ? await fs.promises.readdir(dir, { withFileTypes: true })
        : await fs.promises.readdir(dir, { withFileTypes: true }).catch((): NodeDirent[] => []);
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (!item.name.startsWith('.')) await walk(full, depth + 1);
          continue;
        }
        if (!item.isFile()) continue;
        // An evicted iCloud file is listed as its placeholder; reading the real
        // path makes macOS download it, so index it under its real name.
        const placeholder = icloudPlaceholderName(item.name);
        const name = placeholder ?? item.name;
        if (!placeholder && name.startsWith('.')) continue;
        const dot = name.lastIndexOf('.');
        if (dot <= 0) continue;
        const extension = name.slice(dot + 1).toLowerCase();
        if (!exts.has(extension)) continue;
        out.push({ basename: name.slice(0, dot), extension, ref: path.join(dir, name) });
      }
    };

    await walk(root, 0);
    return out;
  }
}
