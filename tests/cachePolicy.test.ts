import { describe, expect, it } from 'vitest';
import { DAY_MS, OLD_PIECE, resumeAt, toEvict, upgradeEntry, type CacheEntry, type PlayStats } from '../src/library/cachePolicy';

const MB = 1024 * 1024;
const now = 100 * DAY_MS;
const entry = (path: string, size: number, daysAgo: number, kind: CacheEntry['kind'] = 'auto'): CacheEntry =>
  ({ path, size: size * MB, have: size * MB, kind, added: now - daysAgo * DAY_MS, used: now - daysAgo * DAY_MS });
const stats = (position: number, duration: number, plays: number, daysAgo: number): PlayStats =>
  ({ position, duration, plays, last: now - daysAgo * DAY_MS });

describe('toEvict', () => {
  it('keeps everything under the limit that was touched lately', () => {
    expect(toEvict([entry('a', 10, 1), entry('b', 10, 2)], {}, 100 * MB, now, null)).toEqual([]);
  });

  it('lets go what was kept by itself and untouched for 30 days, even under the limit', () => {
    expect(toEvict([entry('old', 10, 31), entry('new', 10, 1)], {}, 1000 * MB, now, null)).toEqual(['old']);
  });

  it('never lets go a file downloaded on purpose', () => {
    expect(toEvict([entry('kept', 500, 90, 'kept')], {}, 100 * MB, now, null)).toEqual([]);
  });

  it('over the limit, lets go first what was listened to the end, then trims to 80%', () => {
    const entries = [entry('done', 30, 1), entry('fresh', 30, 1), entry('older', 30, 5), entry('other', 30, 2)];
    const s = { done: stats(590, 600, 1, 1) };
    // 120 MB used, limit 100: to 80 MB, so two go.
    expect(toEvict(entries, s, 100 * MB, now, null)).toEqual(['done', 'older']);
  });

  it('keeps what is playing and what was half listened lately', () => {
    const entries = [entry('playing', 60, 10), entry('half', 60, 10), entry('spare', 60, 1)];
    const s = { half: stats(300, 1200, 1, 2) };
    expect(toEvict(entries, s, 100 * MB, now, 'playing')).toEqual(['spare']);
  });

  it('lets go a seldom played file before an often played one, and a large one first', () => {
    const entries = [entry('often', 40, 3), entry('once', 40, 3), entry('big', 400, 3)];
    const s = { often: stats(0, 0, 5, 3), once: stats(0, 0, 1, 3) };
    expect(toEvict(entries, s, 380 * MB, now, null)).toEqual(['big']);
    expect(toEvict(entries.slice(0, 2), s, 50 * MB, now, null)).toEqual(['once']);
  });
});

describe('resumeAt', () => {
  it('takes up where it was left, a little before', () => {
    expect(resumeAt(stats(300, 1200, 1, 0))).toBe(297);
  });
  it('starts over near the start or the end', () => {
    expect(resumeAt(stats(5, 1200, 1, 0))).toBe(0);
    expect(resumeAt(stats(1195, 1200, 1, 0))).toBe(0);
    expect(resumeAt(undefined)).toBe(0);
  });
});

describe('upgradeEntry', () => {
  it('a whole file kept in 8 MB pieces has them all, the last one short', () => {
    const e = upgradeEntry(entry('a', 20, 1));
    expect(e.piece).toBe(OLD_PIECE);
    expect(e.got).toEqual([0, 1, 2]);
    expect(e.have).toBe(20 * MB);
  });

  it('a download broken off has the whole pieces from the start, not the one cut short', () => {
    const e = upgradeEntry({ ...entry('a', 20, 1), have: 10 * MB });
    expect(e.got).toEqual([0]);
    expect(e.have).toBe(8 * MB);
  });

  it('leaves alone what knows its pieces already', () => {
    const e = { ...entry('a', 1, 1), piece: 512 * 1024, got: [3] };
    expect(upgradeEntry(e)).toBe(e);
  });
});
