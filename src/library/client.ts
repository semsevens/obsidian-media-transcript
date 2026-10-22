import { requestUrl, type RequestUrlResponse } from 'obsidian';
import { t } from '../i18n';

/** A media file in the library, as the server lists it. */
export interface LibraryFile {
  path: string;          // in the library: <vault folder>/<vaultPath>
  vaultPath: string;     // where it is (or was) in the vault
  sha256: string;
  size: number;
  names: string[];
  added?: string;
  renamed?: string;
  backup?: Record<string, string>;   // where a backup holds it → since when
}

/** An entry of the server's index.json: every media file it holds, in every folder. */
export interface IndexEntry {
  path: string;          // in the library: <folder>/<path in it>
  size: number;
  added?: string;
  backup?: Record<string, string>;
}

export interface Job {
  id: number;
  vault: string;
  path: string;          // in the library
  state: 'queued' | 'claimed' | 'done' | 'failed' | 'canceled';
  outputs: string[];     // transcript files written beside the media
  error?: string | null;
  note?: string;
  force?: boolean;       // asked for again: its transcripts replace the vault's
  sourceUrl?: string;    // an archived video's: the link it was archived from
  title?: string;        // an archived video's: the note it was asked from, to name its transcript
  shared?: boolean;      // a collection's (not a vault's): any vault may take its transcripts
  created: number;       // seconds since the epoch, server time
  finished?: number | null;
  changed: number;
  claimed?: number;      // when the worker took it (server time)
  heartbeat?: number;    // when the worker last said it is on it
  /** How far the worker is: seconds of audio done, of how many; running, or waiting its turn there. */
  progress?: { sec?: number; duration?: number; running: boolean };
}

/** A file in the web archive on the server. */
export interface ArchiveFile {
  name: string;          // <bucket>/<sha1>.<ext>
  size: number;
  modified: string;
  url?: string;          // where it was saved from, when the device that saved it said
}

export interface TrashItem {
  id: string;
  path: string;
  trashed: string;
  entry: LibraryFile;
}

export class LibraryError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * The Media One server's library API. Every change goes through the server,
 * which keeps the files and index.json and refuses anything unsafe (it never
 * deletes outright: deleted files wait in its trash for 30 days).
 */
export class LibraryClient {
  constructor(private readonly server: () => string, private readonly vault: () => string) {}

  get configured(): boolean {
    return this.server() !== '';
  }

  async files(): Promise<LibraryFile[]> {
    const r = await this.call('GET', `files?vault=${encodeURIComponent(this.vault())}`);
    return (r.json as { files: LibraryFile[] }).files;
  }

  async trash(): Promise<TrashItem[]> {
    const r = await this.call('GET', `trash?vault=${encodeURIComponent(this.vault())}`);
    return (r.json as { trash: TrashItem[] }).trash;
  }

  /** Transcription jobs of this vault changed since `since` (server seconds), and the server's time now. */
  async jobs(since?: number): Promise<{ jobs: Job[]; now: number }> {
    const q = new URLSearchParams({ vault: this.vault() });
    if (since !== undefined) q.set('since', String(since));
    const r = await this.call('GET', `jobs?${q.toString()}`);
    return r.json as { jobs: Job[]; now: number };
  }

  /** Ask for a transcription (again, with `force`, even if one exists). */
  async transcribe(vaultPath: string, force: boolean): Promise<Job | null> {
    const r = await this.call('POST', 'transcribe', JSON.stringify({ vault: this.vault(), path: vaultPath, force }), 'application/json');
    return (r.json as { job: Job | null }).job;
  }

  /**
   * Every media file on the server, in every folder: this vault's, and older
   * collections kept there (recorded streams, podcasts) whose transcripts are
   * in the vault but whose media never was.
   */
  async index(): Promise<IndexEntry[]> {
    if (!this.configured) throw new LibraryError(0, t('library.noServer'));
    let r: RequestUrlResponse;
    try {
      r = await requestUrl({ url: `${this.server()}/library/index.json`, headers: { 'Cache-Control': 'no-cache' }, throw: false });
    } catch {
      throw new LibraryError(0, t('library.unreachable'));
    }
    if (r.status !== 200) throw new LibraryError(r.status, `HTTP ${r.status}`);
    return ((r.json as { files?: IndexEntry[] }).files ?? []).filter(e => !e.path.startsWith('_'));
  }

  /** The folder this vault's media is kept in on the server. */
  get folder(): string {
    return this.vault();
  }

  /** Where the server serves a file, by its library path. */
  libraryUrl(path: string): string {
    return `${this.server()}/library/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** Every file in the web archive. */
  async archive(): Promise<ArchiveFile[]> {
    const r = await this.call('GET', 'archive');
    return (r.json as { files: ArchiveFile[] }).files;
  }

  /** Move archive files to the server's archive trash; returns the ones moved. */
  async archiveDelete(names: string[]): Promise<string[]> {
    const r = await this.call('POST', 'archive/delete', JSON.stringify({ names }), 'application/json');
    return (r.json as { deleted: string[] }).deleted;
  }

  /** Where the server serves an archive file. */
  archiveUrl(name: string): string {
    return `${this.server()}/archive/${name}`;
  }

  /** Transcribe a video in the web archive (`name`: <bucket>/<sha1>.<ext>); its transcripts come to this vault. */
  async transcribeArchived(name: string, url: string, title: string, force = false): Promise<Job | null> {
    const body = JSON.stringify({ vault: this.vault(), archive: name, url, title, force });
    const r = await this.call('POST', 'transcribe', body, 'application/json');
    return (r.json as { job: Job | null }).job;
  }

  /** A text file of this vault from the server (a transcript). */
  text(vaultPath: string): Promise<string> {
    return this.fetchText(this.url(vaultPath));
  }

  /** A text file anywhere in the library, by its library path (a collection's transcript). */
  libraryText(path: string): Promise<string> {
    return this.fetchText(this.libraryUrl(path));
  }

  /** A transcript of an archived video, by its file name (<sha1>.<model>.json). */
  archivedText(name: string): Promise<string> {
    return this.fetchText(`${this.server()}/library/_archive-transcripts/${name.slice(0, 2)}/${encodeURIComponent(name)}`);
  }

  private async fetchText(url: string): Promise<string> {
    let r: RequestUrlResponse;
    try {
      r = await requestUrl({ url, throw: false });
    } catch {
      throw new LibraryError(0, t('library.unreachable'));
    }
    if (r.status !== 200) throw new LibraryError(r.status, `HTTP ${r.status}`);
    return r.text;
  }

  /** Store `data` at `vaultPath`. True if stored now, false if the server already had this file. */
  /**
   * Begin (or take up again) an upload in pieces: its id, the piece size and
   * the pieces already there (by offset), or the file if the server has it.
   */
  async uploadBegin(vaultPath: string, size: number, piece?: number): Promise<{ id: string; piece: number; have: number[] } | { entry: unknown }> {
    const r = await this.call('POST', 'upload/begin', JSON.stringify({ vault: this.vault(), path: vaultPath, size, piece }), 'application/json');
    return r.json as { id: string; piece: number; have: number[] } | { entry: unknown };
  }

  /** Begin an upload in pieces into the web archive (`name`: <bucket>/<sha1>.<ext>), saved from `source`. */
  async uploadBeginArchive(name: string, source: string, size: number, piece?: number): Promise<{ id: string; piece: number; have: number[] } | { entry: unknown }> {
    const r = await this.call('POST', 'upload/begin', JSON.stringify({ archive: name, source, size, piece }), 'application/json');
    return r.json as { id: string; piece: number; have: number[] } | { entry: unknown };
  }

  /** Send one piece (any order, several at once). */
  async uploadPiece(id: string, offset: number, data: ArrayBuffer, sha256: string): Promise<void> {
    const q = new URLSearchParams({ offset: String(offset), sha256 });
    await this.call('PUT', `upload/${id}?${q.toString()}`, data, 'application/octet-stream');
  }

  async uploadFinish(id: string): Promise<void> {
    await this.call('POST', `upload/${id}/finish`);
  }

  async upload(vaultPath: string, data: ArrayBuffer, sha256: string): Promise<boolean> {
    const q = new URLSearchParams({ vault: this.vault(), path: vaultPath, sha256 });
    const r = await this.call('PUT', `upload?${q.toString()}`, data, 'application/octet-stream');
    return r.status === 201;
  }

  async rename(from: string, to: string): Promise<void> {
    await this.call('POST', 'rename', JSON.stringify({ vault: this.vault(), from, to }), 'application/json');
  }

  async delete(vaultPath: string): Promise<void> {
    await this.call('POST', 'delete', JSON.stringify({ vault: this.vault(), path: vaultPath }), 'application/json');
  }

  /** Put a trashed file back; returns where it went (a number is added if the name was taken). */
  async restore(id: string): Promise<string> {
    const r = await this.call('POST', 'restore', JSON.stringify({ vault: this.vault(), id }), 'application/json');
    return (r.json as { vaultPath: string }).vaultPath;
  }

  /** Where the server serves a file of this vault. */
  url(vaultPath: string): string {
    const parts = [this.vault(), ...vaultPath.split('/')].map(encodeURIComponent);
    return `${this.server()}/library/${parts.join('/')}`;
  }

  private async call(method: string, api: string, body?: string | ArrayBuffer, contentType?: string): Promise<RequestUrlResponse> {
    if (!this.configured) throw new LibraryError(0, t('library.noServer'));
    let r: RequestUrlResponse;
    try {
      r = await requestUrl({ url: `${this.server()}/api/${api}`, method, body, contentType, throw: false });
    } catch {
      throw new LibraryError(0, t('library.unreachable'));
    }
    if (r.status >= 400) {
      let message = `HTTP ${r.status}`;
      try {
        message = (r.json as { error?: string }).error ?? message;
      } catch {
        // not JSON: keep the status
      }
      throw new LibraryError(r.status, message);
    }
    return r;
  }
}

/** SHA-256 of `data`, as lowercase hex. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
