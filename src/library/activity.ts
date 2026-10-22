import type { Job } from './client';
import type { UploadStatus } from './uploader';

/** A finished file stays in view this long, ticked off, so its end is seen too. */
export const KEEP_DONE_S = 24 * 3600;
/** A failure stays longer, to be seen; after that the badge in its row still says so. */
export const KEEP_FAILED_S = 3 * 24 * 3600;

export type StageKind = 'upload' | 'transcribe' | 'note' | 'backup';
export type StageState = 'done' | 'active' | 'waiting' | 'failed';

export interface Stage {
  kind: StageKind;
  state: StageState;
  /** Upload: the status. */
  upload?: UploadStatus;
  /** Upload waiting: its place in this device's queue (1 = next). */
  place?: number;
  /** Transcribe: the job, its place among the jobs waiting (1 = next), and how far the worker is. */
  job?: Job;
  /** Seconds done of how many, and seconds left, when the worker said. */
  done?: number;
  total?: number;
  left?: number | null;
  /** Transcribe active, but not started on the worker yet: waiting behind its own queue. */
  onWorker?: boolean;
  /** Note waiting: a phone leaves a fresh transcript to the computer a while. */
  phone?: boolean;
}

export interface Activity {
  /** The library path when known, else `vault:<vault path>`. */
  key: string;
  name: string;
  /** In this vault (not a collection's, not the archive's). */
  vaultPath: string | null;
  stages: Stage[];
  /** Every stage done. */
  finished: boolean;
  /** When last moved (seconds), for the order and how long a finished one stays. */
  at: number;
}

export interface ActivityInput {
  /** This vault's folder in the library. */
  own: string;
  upload: UploadStatus | null;
  /** Vault paths waiting to upload, the one under way first. */
  pending: readonly string[];
  jobs: readonly Job[];
  /** Server time, seconds. */
  now: number;
  /** Is a transcript of this media (by its file name) in the vault? */
  hasTranscript: (name: string) => boolean;
  /** Does this vault keep this collection's transcripts (a folder named after it)? */
  keepsCollection: (collection: string) => boolean;
  /** Is this library file backed up? null: not known (not in the index yet). */
  backedUp: (path: string) => boolean | null;
  mobile: boolean;
  /** How long a phone leaves a fresh transcript to the computer, seconds. */
  phoneDelay: number;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * What is under way, file by file: each with the steps it goes through
 * (upload, transcribe, into the vault, backup) and where it is. Uploads come
 * from this device; jobs from the server, this vault's and the collections'.
 */
export function buildActivity(input: ActivityInput): Activity[] {
  const { own, now } = input;
  const out = new Map<string, Activity>();

  // Uploads: the one under way, then those waiting their turn.
  input.pending.forEach((vaultPath, i) => {
    const sending = i === 0 && input.upload && input.upload.name === nameOf(vaultPath) ? input.upload : null;
    const key = `${own}/${vaultPath}`;
    out.set(key, {
      key,
      name: nameOf(vaultPath),
      vaultPath,
      stages: [
        sending ? { kind: 'upload', state: 'active', upload: sending } : { kind: 'upload', state: 'waiting', place: i + (input.upload ? 0 : 1) },
        { kind: 'transcribe', state: 'waiting' },
        { kind: 'note', state: 'waiting' },
        { kind: 'backup', state: 'waiting' },
      ],
      finished: false,
      at: now,
    });
  });

  // The latest job of each file.
  const latest = new Map<string, Job>();
  for (const j of input.jobs) {
    if (j.state === 'canceled') continue;
    const had = latest.get(j.path);
    if (!had || j.created >= had.created) latest.set(j.path, j);
  }
  const waiting = [...latest.values()].filter(j => j.state === 'queued').sort((a, b) => a.created - b.created);

  for (const job of latest.values()) {
    if (out.has(job.path)) continue;  // being uploaded again
    const ended = job.finished ?? job.changed;
    const archived = job.path.startsWith('_archive/');
    const mine = !archived && job.path.startsWith(own + '/');
    const vaultPath = mine ? job.path.slice(own.length + 1) : null;
    // Another vault's, or a collection this vault doesn't keep: not this vault's business.
    if (!mine && !archived && !(job.shared && input.keepsCollection(job.path.slice(0, job.path.indexOf('/'))))) continue;
    // Done a while ago: whatever is left (a backup) is the row's to say.
    if (job.state === 'done' && now - ended > KEEP_DONE_S) continue;
    const name = archived ? job.title || nameOf(job.path) : nameOf(job.path);
    const stages: Stage[] = [];
    if (mine) stages.push({ kind: 'upload', state: 'done' });
    if (job.state === 'queued') {
      stages.push({ kind: 'transcribe', state: 'waiting', job, place: waiting.indexOf(job) + 1 });
    } else if (job.state === 'claimed') {
      const p = job.progress;
      const total = p?.duration ?? undefined;
      const done = p?.sec ?? undefined;
      stages.push({
        kind: 'transcribe', state: 'active', job,
        onWorker: p ? !p.running : false,
        done, total,
        left: p?.running ? timeLeft(job, now) : null,
      });
    } else if (job.state === 'failed') {
      stages.push({ kind: 'transcribe', state: 'failed', job });
    } else {
      stages.push({ kind: 'transcribe', state: 'done', job });
    }
    const transcribed = job.state === 'done';
    const inVault = transcribed && (input.hasTranscript(nameOf(job.path)) || job.outputs.length === 0);
    stages.push({
      kind: 'note',
      state: inVault ? 'done' : 'waiting',
      phone: transcribed && !inVault && input.mobile && now - ended < input.phoneDelay,
    });
    if (mine) stages.push({ kind: 'backup', state: input.backedUp(job.path) ? 'done' : 'waiting' });
    const finished = stages.every(s => s.state === 'done');
    if (job.state === 'failed' && now - ended > KEEP_FAILED_S) continue;
    if (job.state === 'failed' && input.hasTranscript(nameOf(job.path))) continue;  // a transcript came since
    out.set(job.path, { key: job.path, name, vaultPath, stages, finished, at: Math.max(ended, job.changed) });
  }

  // Under way first (uploads, then what is being transcribed, then the waiting), then the finished, newest first.
  const rank = (a: Activity) => {
    if (a.finished) return 4;
    const s = a.stages.find(x => x.state !== 'done');
    if (!s) return 4;
    if (s.kind === 'upload') return s.state === 'active' ? 0 : 1;
    if (s.state === 'active') return 2;
    return 3;
  };
  return [...out.values()].sort((a, b) => rank(a) - rank(b) || (rank(a) === 3 ? placeOf(a) - placeOf(b) : b.at - a.at));
}

function placeOf(a: Activity): number {
  return a.stages.find(s => s.kind === 'transcribe')?.place ?? Infinity;
}

/**
 * Seconds left, from how fast the worker has gone through this file so far;
 * null until it has gone far enough to tell.
 */
export function timeLeft(job: Job, now: number): number | null {
  const p = job.progress;
  if (!p?.running || !p.duration || !p.sec || p.sec < 30 || !job.claimed) return null;
  const spent = (job.heartbeat ?? now) - job.claimed;
  if (spent <= 0) return null;
  return Math.max(0, (p.duration - p.sec) * (spent / p.sec));
}

/** The steps not yet done, counted: what the panel's heading says. */
export function underWay(items: Activity[]): number {
  return items.filter(a => !a.finished).length;
}
