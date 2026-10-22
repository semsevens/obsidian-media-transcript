import { describe, expect, it } from 'vitest';
import { buildActivity, timeLeft, underWay, KEEP_DONE_S, KEEP_FAILED_S, type ActivityInput } from '../src/library/activity';
import type { Job } from '../src/library/client';
import type { UploadStatus } from '../src/library/uploader';

const now = 1_000_000;
let id = 0;
const job = (path: string, state: Job['state'], extra: Partial<Job> = {}): Job =>
  ({ id: ++id, vault: 'me', path, state, outputs: state === 'done' ? ['x.json'] : [], created: now - 600, changed: now - 60, ...extra });
const input = (over: Partial<ActivityInput>): ActivityInput => ({
  own: 'me', upload: null, pending: [], jobs: [], now,
  hasTranscript: () => false, keepsCollection: () => true, backedUp: () => false, mobile: false, phoneDelay: 1800, ...over,
});
const states = (a: { stages: { kind: string; state: string }[] }) => a.stages.map(s => `${s.kind}:${s.state}`);

describe('buildActivity', () => {
  it('follows a new recording from its upload: the one under way, then those waiting their turn', () => {
    const upload: UploadStatus = { name: 'a.m4a', size: 100, sent: 40, rate: 10, moved: Date.now(), state: 'sending', queued: 1 };
    const items = buildActivity(input({ upload, pending: ['Daily/a.m4a', 'Daily/b.m4a'] }));
    expect(items.map(a => a.name)).toEqual(['a.m4a', 'b.m4a']);
    expect(states(items[0])).toEqual(['upload:active', 'transcribe:waiting', 'note:waiting', 'backup:waiting']);
    expect(items[0].stages[0].upload).toBe(upload);
    expect(items[1].stages[0]).toMatchObject({ state: 'waiting', place: 1 });
    expect(items[0].vaultPath).toBe('Daily/a.m4a');
  });

  it('takes up the file at the server: its place in line, how far the worker is, then the vault and the backup', () => {
    const a = job('me/a.m4a', 'queued', { created: now - 300 });
    const b = job('me/b.m4a', 'queued', { created: now - 200 });
    const c = job('me/c.m4a', 'claimed', { claimed: now - 100, heartbeat: now, progress: { sec: 60, duration: 600, running: true } });
    const items = buildActivity(input({ jobs: [b, a, c] }));
    expect(items.map(x => x.name)).toEqual(['c.m4a', 'a.m4a', 'b.m4a']);
    expect(states(items[0])).toEqual(['upload:done', 'transcribe:active', 'note:waiting', 'backup:waiting']);
    expect(items[0].stages[1]).toMatchObject({ done: 60, total: 600, onWorker: false });
    expect(items[0].stages[1].left).toBeCloseTo(900);  // 60 s took 100 s: 540 s more take 900
    expect(items[1].stages[1].place).toBe(1);
    expect(items[2].stages[1].place).toBe(2);
  });

  it('says when the worker has the job but has not started it', () => {
    const [a] = buildActivity(input({ jobs: [job('me/a.m4a', 'claimed', { progress: { running: false } })] }));
    expect(a.stages[1]).toMatchObject({ state: 'active', onWorker: true });
  });

  it('ticks off what is done; a finished file stays a day, then goes', () => {
    const done = job('me/a.m4a', 'done', { finished: now - 100 });
    const items = buildActivity(input({ jobs: [done], hasTranscript: () => true, backedUp: () => true }));
    expect(items).toHaveLength(1);
    expect(items[0].finished).toBe(true);
    expect(underWay(items)).toBe(0);
    const old = job('me/b.m4a', 'done', { finished: now - KEEP_DONE_S - 1, changed: now - KEEP_DONE_S - 1 });
    expect(buildActivity(input({ jobs: [old], hasTranscript: () => true, backedUp: () => true }))).toEqual([]);
  });

  it('waits for the transcript to reach the vault and for the backup', () => {
    const [a] = buildActivity(input({ jobs: [job('me/a.m4a', 'done', { finished: now - 10 })], mobile: true }));
    expect(states(a)).toEqual(['upload:done', 'transcribe:done', 'note:waiting', 'backup:waiting']);
    expect(a.stages[2].phone).toBe(true);
    const [b] = buildActivity(input({ jobs: [job('me/a.m4a', 'done', { finished: now - 10 })], hasTranscript: () => true }));
    expect(states(b)).toEqual(['upload:done', 'transcribe:done', 'note:done', 'backup:waiting']);
  });

  it('shows a collection\'s file and an archived video without the steps that are not theirs', () => {
    const items = buildActivity(input({
      jobs: [job('今日股市/x.m4a', 'claimed', { shared: true }), job('_archive/v/ab.mp4', 'queued', { title: 'A talk' })],
    }));
    expect(items.map(a => [a.name, a.vaultPath])).toEqual([['x.m4a', null], ['A talk', null]]);
    expect(states(items[0])).toEqual(['transcribe:active', 'note:waiting']);
    // Not kept in this vault, or another vault's: left out.
    expect(buildActivity(input({ jobs: [job('今日股市/x.m4a', 'done', { shared: true })], keepsCollection: () => false }))).toEqual([]);
    expect(buildActivity(input({ jobs: [job('dev/x.m4a', 'queued')] }))).toEqual([]);
  });

  it('keeps a failure until there is a transcript; leaves out the canceled; the latest job of a file counts', () => {
    const failed = job('me/a.m4a', 'failed', { error: 'boom', finished: now - 5 });
    expect(states(buildActivity(input({ jobs: [failed] }))[0])).toContain('transcribe:failed');
    expect(buildActivity(input({ jobs: [failed], hasTranscript: () => true }))).toEqual([]);
    const longAgo = job('me/c.m4a', 'failed', { finished: now - KEEP_FAILED_S - 1, changed: now - KEEP_FAILED_S - 1 });
    expect(buildActivity(input({ jobs: [longAgo] }))).toEqual([]);
    expect(buildActivity(input({ jobs: [job('me/b.m4a', 'canceled')] }))).toEqual([]);
    const again = job('me/a.m4a', 'queued', { created: now });
    expect(states(buildActivity(input({ jobs: [failed, again] }))[0])).toContain('transcribe:waiting');
  });

  it('shows a file being uploaded once, though the server has a job for it already', () => {
    const upload: UploadStatus = { name: 'a.m4a', size: 100, sent: 0, rate: 0, moved: Date.now(), state: 'sending', queued: 0 };
    const items = buildActivity(input({ upload, pending: ['a.m4a'], jobs: [job('me/a.m4a', 'done')] }));
    expect(items).toHaveLength(1);
    expect(items[0].stages[0].state).toBe('active');
  });
});

describe('timeLeft', () => {
  it('is not guessed before the worker has gone far enough', () => {
    expect(timeLeft(job('me/a.m4a', 'claimed', { claimed: now - 10, progress: { sec: 5, duration: 600, running: true } }), now)).toBeNull();
    expect(timeLeft(job('me/a.m4a', 'claimed', { claimed: now - 10, progress: { running: false } }), now)).toBeNull();
  });
});
