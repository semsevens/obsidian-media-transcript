import { Platform, TFile, normalizePath } from 'obsidian';
import { addUrl } from '../utils/transcriptSource';
import type MediaTranscriptPlugin from '../main';
import type { Job } from './client';
import { DeviceState } from './deviceState';

const EVERY_MS = 2 * 60_000;
// On a phone, leave a fresh transcript to the computer for a while: two
// devices writing the same new file at once makes Obsidian Sync keep both.
const PHONE_DELAY_S = 30 * 60;
// Clocks differ and jobs finish between polls: look back a little.
const OVERLAP_S = 120;

/**
 * Brings transcripts the server's worker wrote into the vault, beside where
 * the media is (or was), so they are searchable and sync like any note. A
 * transcript already in the vault is not overwritten (it may hold edits),
 * except by a transcription asked for again ("Transcribe again").
 */
export class TranscriptSync {
  private running = false;
  private jobs: Job[] = [];
  private listeners: (() => void)[] = [];
  private readonly device: DeviceState;

  constructor(private readonly plugin: MediaTranscriptPlugin) {
    this.device = new DeviceState(plugin.app);
  }

  start(): void {
    const { plugin } = this;
    plugin.app.workspace.onLayoutReady(() => { void this.sync(); });
    plugin.registerInterval(window.setInterval(() => void this.sync(), EVERY_MS));
  }

  /** The jobs seen last, for showing what is being transcribed. */
  get known(): Job[] {
    return this.jobs;
  }

  async sync(): Promise<number> {
    const { plugin } = this;
    if (this.running || !plugin.library.configured) return 0;
    this.running = true;
    let written = 0;
    try {
      const since = this.device.get<number>('transcriptSyncSince', 0);
      const { jobs, now } = await plugin.library.jobs(since ? since - OVERLAP_S : undefined);
      this.remember(jobs);
      let next = now;
      for (const job of jobs) {
        if (job.state !== 'done' || job.outputs.length === 0) continue;
        if (Platform.isMobile && now - (job.finished ?? now) < PHONE_DELAY_S) {
          next = Math.min(next, job.changed);  // look at it again next time
          continue;
        }
        written += await this.bring(job);
      }
      this.device.set('transcriptSyncSince', next);
    } catch (e) {
      console.warn('[media-one] transcript sync:', e);
    } finally {
      this.running = false;
    }
    return written;
  }

  /** Call `fn` whenever the known jobs change. */
  onJobs(fn: () => void): void {
    this.listeners.push(fn);
  }

  remember(jobs: Job[]): void {
    const byId = new Map(this.jobs.map(j => [j.id, j]));
    for (const j of jobs) byId.set(j.id, j);
    this.jobs = [...byId.values()];
    if (jobs.length) this.listeners.forEach(fn => fn());
  }

  /** Write the job's transcripts the vault doesn't have yet; returns how many. */
  private async bring(job: Job): Promise<number> {
    if (job.path.startsWith('_archive/')) return this.bringArchived(job);
    if (job.shared) return this.bringShared(job);
    const { vault } = this.plugin.app;
    const vaultPath = job.path.slice(job.path.indexOf('/') + 1);
    const dir = vaultPath.includes('/') ? vaultPath.slice(0, vaultPath.lastIndexOf('/')) : '';
    let n = 0;
    for (const name of job.outputs) {
      const target = normalizePath(dir ? `${dir}/${name}` : name);
      const existing = vault.getAbstractFileByPath(target);
      if (existing instanceof TFile) {
        if (!job.force) continue;
        const text = await this.plugin.library.text(target);
        if (text !== await vault.read(existing)) {
          await vault.modify(existing, text);
          n++;
        }
        continue;
      }
      const text = await this.plugin.library.text(target);
      if (dir && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
      if (vault.getAbstractFileByPath(target)) continue;  // arrived meanwhile (Sync)
      await vault.create(target, text);
      n++;
    }
    return n;
  }

  /**
   * A collection's transcripts (a recording brought in from iCloud, not
   * uploaded from this vault) go where this vault keeps that collection's
   * other transcripts: a folder named after it (raw/media/工作). A vault
   * without one doesn't keep that collection's transcripts, and gets none.
   */
  private async bringShared(job: Job): Promise<number> {
    const { vault } = this.plugin.app;
    const collection = job.path.slice(0, job.path.indexOf('/'));
    const folder = collectionFolder(vault.getAllFolders(), collection);
    if (!folder) return 0;
    const serverDir = job.path.slice(0, job.path.lastIndexOf('/'));
    let n = 0;
    for (const name of job.outputs) {
      const target = normalizePath(`${folder}/${name}`);
      const existing = vault.getAbstractFileByPath(target);
      if (existing instanceof TFile && !job.force) continue;
      const text = await this.plugin.library.libraryText(`${serverDir}/${name}`);
      if (existing instanceof TFile) {
        if (text !== await vault.read(existing)) {
          await vault.modify(existing, text);
          n++;
        }
        continue;
      }
      if (vault.getAbstractFileByPath(target)) continue;  // arrived meanwhile (Sync)
      await vault.create(target, text);
      n++;
    }
    return n;
  }

  /**
   * An archived video's transcripts go to their own folder, named after the
   * note they were asked from. Found again by their `source` (the archive
   * name), so one renamed or moved is still known.
   */
  private async bringArchived(job: Job): Promise<number> {
    const { plugin } = this;
    const { vault } = plugin.app;
    const media = job.path.slice(job.path.lastIndexOf('/') + 1);
    const hash = media.slice(0, media.lastIndexOf('.'));
    const folder = normalizePath(plugin.settings.archiveTranscriptFolder || 'Transcripts');
    const existing = plugin.transcripts.transcriptsFor(media);
    let n = 0;
    for (const name of job.outputs) {
      const rest = name.slice(hash.length);  // .<model>.json
      const have = existing.find(f => f.name.endsWith(rest)) ?? null;
      if (have && !job.force) continue;
      let text = await plugin.library.archivedText(name);
      if (rest.endsWith('.json') && job.sourceUrl) text = addUrl(text, job.sourceUrl) ?? text;
      if (have) {
        if (text !== await vault.read(have)) {
          await vault.modify(have, text);
          n++;
        }
        continue;
      }
      const target = normalizePath(`${folder}/${archivedTitle(job.title, hash)}${rest}`);
      if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
      if (vault.getAbstractFileByPath(target)) continue;  // arrived meanwhile (Sync)
      await vault.create(target, text);
      n++;
    }
    return n;
  }
}

/** "<note title> · <first 6 of the hash>": readable, and two videos of one note don't clash. */
export function archivedTitle(title: string | undefined, hash: string): string {
  const clean = (title ?? '').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return clean ? `${clean} · ${hash.slice(0, 6)}` : hash.slice(0, 12);
}

/**
 * Where a vault keeps a collection's transcripts: the folder named after it
 * that holds the most transcripts, or null if no such folder holds any.
 */
export function collectionFolder(folders: { name: string; path: string; children: { name: string }[] }[], collection: string): string | null {
  let best: string | null = null;
  let most = 0;
  for (const f of folders) {
    if (f.name !== collection) continue;
    const n = f.children.filter(c => /\.[^.]+\.json$/.test(c.name) && !c.name.endsWith('.anno.json')).length;
    if (n > most) {
      most = n;
      best = f.path;
    }
  }
  return best;
}
