import type { BackupRun, IndexEntry, Job, RemoteUpload } from './client';
import type { UploadStatus } from './uploader';
import { timeLeft } from './activity';

/** Finished files shown, back this far. */
export const RECENT_S = 7 * 24 * 3600;
/** An upload in pieces not moved for this long is paused (the device is asleep, or gone). */
export const STALLED_S = 120;

export type Section = 'running' | 'queued' | 'backup' | 'failed' | 'done';

/** One file on its way: each step with when it began and ended (seconds, server time). */
export interface ProgressRow {
  key: string;
  name: string;
  /** In this vault, if it is this vault's. */
  vaultPath: string | null;
  section: Section;
  upload: {
    state: 'done' | 'active' | 'paused' | 'queued';
    began?: number;
    ended?: number;
    /** An upload in pieces: when a piece last came. */
    moved?: number;
    device?: string;
    sent?: number;
    size?: number;
    /** This device's own upload, as it goes. */
    live?: UploadStatus;
    /** Place in this device's queue (1 = next). */
    place?: number;
  } | null;
  transcribe: {
    state: 'done' | 'active' | 'queued' | 'failed' | 'none';
    queued?: number;
    began?: number;
    ended?: number;
    done?: number;
    total?: number;
    left?: number | null;
    place?: number;
    error?: string | null;
    job?: Job;
  };
  /** Transcript in the vault: null when there is none to wait for. */
  inVault: boolean | null;
  /** Backup: null for what isn't backed up here (a collection's, the archive's). */
  backup: { at?: number } | null;
  /** First moment known, and the last step's end once all are done. */
  started: number;
  ended: number | null;
  /** Last moved, for the order. */
  at: number;
}

export interface ProgressInput {
  own: string;
  index: readonly IndexEntry[];
  jobs: readonly Job[];
  uploads: readonly RemoteUpload[];
  /** This device: the upload under way, and its queue (vault paths, the one under way first). */
  upload: UploadStatus | null;
  pending: readonly string[];
  /** When a file waiting to upload came into the vault (seconds): how long it has waited. */
  queuedAt?: (vaultPath: string) => number | undefined;
  /** When the worker's word of how far a job is last changed (seconds): it says so a piece at a time. */
  progressAt?: (job: Job) => number | undefined;
  /** Server time, seconds. */
  now: number;
  hasTranscript: (name: string) => boolean;
  keepsCollection: (collection: string) => boolean;
}

export interface Progress {
  rows: ProgressRow[];
  counts: Record<Section, number>;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
/** The server's times are its local time, ISO without a zone: this device's local time, near enough. */
export const secondsOf = (iso?: string | null): number | undefined => {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms / 1000;
};

export function buildProgress(input: ProgressInput): Progress {
  const { own, now } = input;
  const rows = new Map<string, ProgressRow>();
  const byPath = new Map(input.index.map(e => [e.path, e]));
  const backedUpHere = backsUp(input.index, own);
  const backupStep = (at?: number): ProgressRow['backup'] => (backedUpHere ? { at } : null);

  // The latest job of each file (a rename moves its jobs with it).
  const latest = new Map<string, Job>();
  for (const j of input.jobs) {
    if (j.state === 'canceled') continue;
    const had = latest.get(j.path);
    if (!had || j.created >= had.created) latest.set(j.path, j);
  }
  const waiting = [...latest.values()].filter(j => j.state === 'queued').sort((a, b) => a.created - b.created);

  const transcribeOf = (job: Job | undefined, name: string): ProgressRow['transcribe'] => {
    if (!job) return { state: input.hasTranscript(name) ? 'done' : 'none' };
    const base = { job, queued: job.created, began: job.claimed, error: job.error };
    if (job.state === 'queued') return { ...base, state: 'queued', place: waiting.indexOf(job) + 1 };
    if (job.state === 'claimed') {
      const p = job.progress;
      const at = input.progressAt?.(job);
      return { ...base, state: 'active', done: p?.sec, total: p?.duration, left: p?.running ? (at !== undefined ? leftFrom(job, at, now) : timeLeft(job, now)) : null };
    }
    if (job.state === 'failed') return { ...base, state: 'failed', ended: job.finished ?? job.changed };
    return { ...base, state: 'done', ended: job.finished ?? job.changed };
  };

  const finish = (row: ProgressRow): ProgressRow => {
    const { upload, transcribe, backup, inVault } = row;
    if (transcribe.state === 'failed') row.section = 'failed';
    else if (upload?.state === 'active' || transcribe.state === 'active') row.section = 'running';
    else if (upload && upload.state !== 'done') row.section = 'queued';
    else if (transcribe.state === 'queued') row.section = 'queued';
    else if (backup && backup.at === undefined) row.section = 'backup';
    else if (inVault === false) row.section = 'running';  // on its way into the vault
    else row.section = 'done';
    const ends = [upload?.ended, transcribe.ended, backup?.at].filter((x): x is number => x !== undefined);
    row.ended = row.section === 'done' && ends.length ? Math.max(...ends) : null;
    row.at = Math.max(row.started, ...ends, transcribe.began ?? 0, upload?.began ?? 0);
    return row;
  };

  // This vault's files on the server.
  for (const e of input.index) {
    if (!e.path.startsWith(own + '/')) continue;
    const job = latest.get(e.path);
    const added = secondsOf(e.added);
    const backedUp = e.backup ? Math.min(...Object.values(e.backup).map(v => secondsOf(v) ?? Infinity)) : undefined;
    const moving = job && (job.state === 'queued' || job.state === 'claimed' || (job.state === 'failed' && now - (job.finished ?? job.changed) < RECENT_S));
    const recent = added !== undefined && now - added < RECENT_S;
    const unbacked = backedUpHere && backedUp === undefined && added !== undefined && now - added < 4 * RECENT_S;
    if (!moving && !recent && !unbacked) continue;
    const name = nameOf(e.path);
    const transcribe = transcribeOf(job, name);
    if (transcribe.state === 'failed' && input.hasTranscript(name)) transcribe.state = 'done';
    const began = secondsOf(e.began);
    rows.set(e.path, finish({
      key: e.path,
      name,
      vaultPath: e.path.slice(own.length + 1),
      section: 'done',
      upload: added !== undefined ? { state: 'done', began, ended: added, device: e.device, size: e.size } : null,
      transcribe,
      inVault: transcribe.state === 'done' ? input.hasTranscript(name) || (job?.outputs.length === 0) : null,
      backup: backupStep(backedUp === Infinity ? undefined : backedUp),
      started: began ?? added ?? job?.created ?? now,
      ended: null,
      at: 0,
    }));
  }

  // Uploads in pieces under way, from every device.
  for (const u of input.uploads) {
    if (byPath.has(u.path)) continue;
    const began = secondsOf(u.created) ?? now;
    const moved = secondsOf(u.moved) ?? began;
    // Left long ago (the device gave up on it, or the file is gone): not on its way any more.
    if (now - moved > RECENT_S) continue;
    rows.set(u.path, finish({
      key: u.path,
      name: nameOf(u.path),
      vaultPath: u.path.startsWith(own + '/') ? u.path.slice(own.length + 1) : null,
      section: 'queued',
      upload: { state: now - moved > STALLED_S ? 'paused' : 'active', began, moved, device: u.device ?? undefined, sent: u.received, size: u.size },
      transcribe: { state: 'none' },
      inVault: null,
      backup: backupStep(),
      started: began,
      ended: null,
      at: moved,
    }));
  }

  // This device's queue: what it is sending (live), and what waits its turn.
  input.pending.forEach((vaultPath, i) => {
    const key = `${own}/${vaultPath}`;
    if (byPath.has(key)) return;
    const live = i === 0 && input.upload && input.upload.name === nameOf(vaultPath) ? input.upload : null;
    const had = rows.get(key);
    const upload: NonNullable<ProgressRow['upload']> = live
      ? { ...(had?.upload ?? {}), state: live.state === 'waiting' ? 'paused' : 'active', live, sent: live.sent, size: live.size }
      : had?.upload ?? { state: 'queued', place: i + (input.upload ? 0 : 1) };
    rows.set(key, finish({
      key,
      name: nameOf(vaultPath),
      vaultPath,
      section: 'queued',
      upload,
      transcribe: { state: 'none' },
      inVault: null,
      backup: backupStep(),
      started: had?.started ?? input.queuedAt?.(vaultPath) ?? now,
      ended: null,
      at: now,
    }));
  });

  // Jobs of what isn't this vault's: the web archive, and collections this vault keeps transcripts of.
  for (const job of latest.values()) {
    if (rows.has(job.path) || job.path.startsWith(own + '/')) continue;
    const archived = job.path.startsWith('_archive/');
    if (!archived && !(job.shared && input.keepsCollection(job.path.slice(0, job.path.indexOf('/'))))) continue;
    const ended = job.finished ?? job.changed;
    if ((job.state === 'done' || job.state === 'failed') && now - ended > RECENT_S) continue;
    const name = archived ? job.title || nameOf(job.path) : nameOf(job.path);
    const transcribe = transcribeOf(job, nameOf(job.path));
    if (transcribe.state === 'failed' && input.hasTranscript(nameOf(job.path))) continue;
    rows.set(job.path, finish({
      key: job.path,
      name,
      vaultPath: null,
      section: 'done',
      upload: null,
      transcribe,
      inVault: transcribe.state === 'done' ? input.hasTranscript(nameOf(job.path)) || job.outputs.length === 0 : null,
      backup: null,
      started: job.created,
      ended: null,
      at: 0,
    }));
  }

  const order: Section[] = ['running', 'queued', 'failed', 'backup', 'done'];
  const list = [...rows.values()].sort((a, b) => {
    const s = order.indexOf(a.section) - order.indexOf(b.section);
    if (s) return s;
    // The waiting in their turn; everything else newest first.
    if (a.section === 'queued') return queuePlace(a) - queuePlace(b) || a.started - b.started;
    return b.at - a.at;
  });
  const counts = { running: 0, queued: 0, backup: 0, failed: 0, done: 0 } as Record<Section, number>;
  for (const r of list) counts[r.section]++;
  return { rows: list, counts };
}

/**
 * Seconds left, at the pace the worker went until it last said how far it is
 * (`at`), counted down since: between its words the estimate doesn't grow.
 */
export function leftFrom(job: Job, at: number, now: number): number | null {
  const p = job.progress;
  if (!p?.running || !p.duration || !p.sec || p.sec < 30 || !job.claimed || at <= job.claimed) return null;
  const pace = (at - job.claimed) / p.sec;
  return Math.max(0, (p.duration - p.sec) * pace - (now - at));
}

/** Has a backup ever taken this vault's files? One no backup takes (a test vault, say) has no backup step to wait for. */
export function backsUp(index: readonly IndexEntry[], own: string): boolean {
  return index.some(e => e.path.startsWith(own + '/') && !!e.backup && Object.keys(e.backup).length > 0);
}

function queuePlace(r: ProgressRow): number {
  if (r.upload && r.upload.state !== 'done') return r.upload.place ?? 0;
  return 1000 + (r.transcribe.place ?? 0);
}

/** The latest run of the nightly backup, and the latest that went through. */
export function lastRuns(runs: readonly BackupRun[]): { last: BackupRun | null; lastOk: BackupRun | null } {
  const sorted = [...runs].sort((a, b) => a.started.localeCompare(b.started));
  return { last: sorted[sorted.length - 1] ?? null, lastOk: [...sorted].reverse().find(r => r.ok) ?? null };
}
