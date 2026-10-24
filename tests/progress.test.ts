import { describe, expect, it } from 'vitest';
import { buildProgress, lastRuns, leftFrom, secondsOf, RECENT_S, STALLED_S, type ProgressInput } from '../src/library/progress';
import type { IndexEntry, Job } from '../src/library/client';
import type { UploadStatus } from '../src/library/uploader';

const iso = (s: number) => {
  const d = new Date(s * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const now = Math.floor(Date.parse('2026-10-24T12:00:00') / 1000);
let id = 0;
const job = (path: string, state: Job['state'], extra: Partial<Job> = {}): Job =>
  ({ id: ++id, vault: 'me', path, state, outputs: state === 'done' ? ['x.json'] : [], created: now - 600, changed: now - 60, ...extra });
const entry = (path: string, extra: Partial<IndexEntry> = {}): IndexEntry => ({ path, size: 100, added: iso(now - 3600), ...extra });
const input = (over: Partial<ProgressInput>): ProgressInput => ({
  own: 'me', index: [], jobs: [], uploads: [], upload: null, pending: [], now,
  hasTranscript: () => false, keepsCollection: () => true, ...over,
});

describe('buildProgress', () => {
  it('reads the server times as local times', () => {
    expect(secondsOf(iso(now))).toBe(now);
    expect(secondsOf(undefined)).toBeUndefined();
  });

  it('follows a file through every step, with when each began and ended', () => {
    const e = entry('me/附件/a.m4a', { began: iso(now - 4000), added: iso(now - 3600), device: 'MacBook', backup: { icloud: iso(now - 600) } });
    const j = job('me/附件/a.m4a', 'done', { created: now - 3600, claimed: now - 3000, finished: now - 1200 });
    const { rows, counts } = buildProgress(input({ index: [e], jobs: [j], hasTranscript: () => true }));
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.section).toBe('done');
    expect(r.upload).toMatchObject({ state: 'done', began: now - 4000, ended: now - 3600, device: 'MacBook' });
    expect(r.transcribe).toMatchObject({ state: 'done', queued: now - 3600, began: now - 3000, ended: now - 1200 });
    expect(r.backup).toEqual({ at: now - 600 });
    expect(r.started).toBe(now - 4000);
    expect(r.ended).toBe(now - 600);
    expect(counts.done).toBe(1);
  });

  it('puts what is under way first, then the waiting in their turn, the failed, those waiting for the backup, the finished', () => {
    const index = ['a', 'b', 'c', 'd', 'e'].map(n => entry(`me/${n}.m4a`));
    index[4].backup = { icloud: iso(now - 60) };
    const jobs = [
      job('me/a.m4a', 'claimed', { claimed: now - 100, heartbeat: now, progress: { sec: 60, duration: 600, running: true } }),
      job('me/b.m4a', 'queued', { created: now - 200 }),
      job('me/c.m4a', 'failed', { error: 'boom', finished: now - 50 }),
      job('me/d.m4a', 'done', { finished: now - 300 }),
      job('me/e.m4a', 'done', { finished: now - 300 }),
    ];
    const { rows, counts } = buildProgress(input({ index, jobs, hasTranscript: n => n === 'd.m4a' || n === 'e.m4a' }));
    expect(rows.map(r => `${r.name}:${r.section}`)).toEqual(['a.m4a:running', 'b.m4a:queued', 'c.m4a:failed', 'd.m4a:backup', 'e.m4a:done']);
    expect(rows[0].transcribe.left).toBeCloseTo(900);
    expect(rows[1].transcribe.place).toBe(1);
    expect(rows[2].transcribe.error).toBe('boom');
    expect(counts).toEqual({ running: 1, queued: 1, failed: 1, backup: 1, done: 1 });
  });

  it('shows uploads under way on other devices, paused when no piece came for a while', () => {
    const uploads = [
      { id: '1', path: 'me/附件/p.m4a', size: 1000, received: 400, created: iso(now - 300), moved: iso(now - 10), device: 'Android' },
      { id: '2', path: 'me/附件/q.m4a', size: 1000, received: 100, created: iso(now - 3000), moved: iso(now - STALLED_S - 60), device: 'MacBook' },
      { id: '3', path: 'other/x.m4a', size: 1, received: 0, created: iso(now), moved: iso(now) },
    ];
    const { rows } = buildProgress(input({ uploads }));
    const p = rows.find(r => r.name === 'p.m4a')!;
    const q = rows.find(r => r.name === 'q.m4a')!;
    expect(p.section).toBe('running');
    expect(p.upload).toMatchObject({ state: 'active', sent: 400, size: 1000, device: 'Android', began: now - 300 });
    expect(q.section).toBe('queued');
    expect(q.upload?.state).toBe('paused');
  });

  it("takes this device's own upload as it goes, and its queue in order", () => {
    const upload: UploadStatus = { name: 'a.m4a', size: 100, sent: 40, rate: 10, moved: Date.now(), state: 'sending', queued: 1 };
    const uploads = [{ id: '1', path: 'me/D/a.m4a', size: 100, received: 32, created: iso(now - 30), moved: iso(now - 5), device: 'MacBook' }];
    const { rows } = buildProgress(input({ upload, uploads, pending: ['D/a.m4a', 'D/b.m4a'], queuedAt: p => (p === 'D/b.m4a' ? now - 90 : undefined) }));
    expect(rows.map(r => `${r.name}:${r.section}`)).toEqual(['a.m4a:running', 'b.m4a:queued']);
    expect(rows[0].upload).toMatchObject({ state: 'active', live: upload, sent: 40, began: now - 30, device: 'MacBook' });
    expect(rows[1].upload).toMatchObject({ state: 'queued', place: 1 });
    expect(rows[1].started).toBe(now - 90);  // waiting since it came into the vault
  });

  it('a vault no backup ever took has no backup step', () => {
    const { rows } = buildProgress(input({ index: [entry('me/a.m4a')], hasTranscript: () => true }));
    expect(rows[0].backup).toBeNull();
    expect(rows[0].section).toBe('done');
  });

  it('an upload left for a week is not on its way any more', () => {
    const uploads = [{ id: '1', path: 'me/old.m4a', size: 10, received: 0, created: iso(now - RECENT_S - 100), moved: iso(now - RECENT_S - 100) }];
    expect(buildProgress(input({ uploads })).rows).toEqual([]);
  });

  it('leaves out what finished long ago, but keeps an old file still not backed up', () => {
    const old = iso(now - RECENT_S - 3600);
    const index = [
      entry('me/old.m4a', { added: old, backup: { icloud: old } }),
      entry('me/unbacked.m4a', { added: old }),
      entry('other/x.m4a'),
    ];
    const { rows } = buildProgress(input({ index, hasTranscript: () => true }));
    expect(rows.map(r => `${r.name}:${r.section}`)).toEqual(['unbacked.m4a:backup']);  // old.m4a: backups are kept here
  });

  it('a failure a transcript came since is not a failure', () => {
    const { rows } = buildProgress(input({ index: [entry('me/a.m4a', { backup: { icloud: iso(now) } })], jobs: [job('me/a.m4a', 'failed')], hasTranscript: () => true }));
    expect(rows[0].section).toBe('done');
  });

  it('jobs of the archive and of collections this vault keeps, not of others', () => {
    const jobs = [
      job('_archive/ab/x.mp4', 'claimed', { title: 'A talk', claimed: now - 10 }),
      job('南添/y.m4a', 'queued', { shared: true }),
      job('收藏/z.m4a', 'queued', { shared: true }),
      job('other/w.m4a', 'queued'),
    ];
    const { rows } = buildProgress(input({ jobs, keepsCollection: c => c === '南添' }));
    expect(rows.map(r => r.name).sort()).toEqual(['A talk', 'y.m4a']);
    expect(rows.every(r => r.upload === null && r.backup === null)).toBe(true);
  });
});

describe('leftFrom', () => {
  it('goes by the pace until the worker last said how far it is, and counts down after', () => {
    const j = job('me/a.m4a', 'claimed', { claimed: now - 400, progress: { sec: 60, duration: 300, running: true } });
    // 60 s of audio took 240 s (until now - 160): 240 s more of audio take 960 s, 160 of them gone.
    expect(leftFrom(j, now - 160, now)).toBe(800);
    expect(leftFrom(j, now - 160, now + 1000)).toBe(0);
    expect(leftFrom({ ...j, progress: { sec: 10, duration: 300, running: true } }, now - 160, now)).toBeNull();
  });
});

describe('lastRuns', () => {
  it('the latest run and the latest that went through', () => {
    const runs = [
      { started: '2026-10-23T03:30:00', ok: true },
      { started: '2026-10-24T03:30:00', ok: false, failed: ['server_backup.py'] },
    ];
    expect(lastRuns(runs).last?.started).toBe('2026-10-24T03:30:00');
    expect(lastRuns(runs).lastOk?.started).toBe('2026-10-23T03:30:00');
    expect(lastRuns([])).toEqual({ last: null, lastOk: null });
  });
});
