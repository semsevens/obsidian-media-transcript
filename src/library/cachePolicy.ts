/**
 * Which media this device keeps for offline listening, and which it lets go
 * first when space runs short. Pure, so it can be tested.
 */

/** A media file kept on this device. */
export interface CacheEntry {
  path: string;          // in the library
  size: number;          // bytes, when whole
  have: number;          // bytes downloaded so far
  kind: 'auto' | 'kept'; // kept: downloaded on purpose, never let go by itself
  added: number;         // ms since the epoch
  used: number;          // last played or opened, ms
}

/** How it has been listened to: kept for every file played, cached or not. */
export interface PlayStats {
  position: number;      // seconds
  duration: number;      // seconds, 0 if unknown
  plays: number;
  last: number;          // ms
}

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Kept by itself and not touched for this long: let go. */
export const IDLE_DAYS = 30;
/** Half listened this recently: kept, it will be gone back to. */
export const IN_PROGRESS_DAYS = 14;
/** Over the limit, let go until this share of it is used. */
export const TRIM_TO = 0.8;

export function finished(s: PlayStats | undefined): boolean {
  return !!s && s.duration > 0 && s.position >= s.duration * 0.9;
}

export function inProgress(s: PlayStats | undefined, now: number): boolean {
  return !!s && s.duration > 0 && s.position > 10 && !finished(s) && now - s.last < IN_PROGRESS_DAYS * DAY_MS;
}

/** Never let go by itself: kept on purpose, playing now, or half listened lately. */
export function isProtected(e: CacheEntry, s: PlayStats | undefined, now: number, playing: string | null): boolean {
  return e.kind === 'kept' || e.path === playing || inProgress(s, now);
}

/**
 * How readily to let it go, higher first: listened to the end, long untouched,
 * seldom played, large (a video before an audio).
 */
export function evictionScore(e: CacheEntry, s: PlayStats | undefined, now: number): number {
  const idleDays = (now - Math.max(e.used, s?.last ?? 0)) / DAY_MS;
  return (finished(s) ? 10 : 0)
    + idleDays / 3
    - Math.min(s?.plays ?? 0, 5)
    + e.have / (200 * 1024 * 1024);
}

/**
 * What to let go: whatever was kept by itself and is untouched for
 * IDLE_DAYS, then (over `limit` bytes) the most readily let go until
 * TRIM_TO of the limit is used. Never what is protected.
 */
export function toEvict(
  entries: CacheEntry[], stats: Record<string, PlayStats>, limit: number, now: number, playing: string | null,
): string[] {
  const out: string[] = [];
  const left: CacheEntry[] = [];
  for (const e of entries) {
    const s = stats[e.path];
    if (!isProtected(e, s, now, playing) && now - Math.max(e.used, s?.last ?? 0) > IDLE_DAYS * DAY_MS) out.push(e.path);
    else left.push(e);
  }
  let used = left.reduce((n, e) => n + e.have, 0);
  if (used <= limit) return out;
  const target = limit * TRIM_TO;
  const candidates = left
    .filter(e => !isProtected(e, stats[e.path], now, playing))
    .sort((a, b) => evictionScore(b, stats[b.path], now) - evictionScore(a, stats[a.path], now));
  for (const e of candidates) {
    if (used <= target) break;
    out.push(e.path);
    used -= e.have;
  }
  return out;
}

/** Where to take up a file again: where it was left, unless near its start or end. */
export function resumeAt(s: PlayStats | undefined): number {
  if (!s || s.position < 10 || finished(s) || (s.duration > 0 && s.duration - s.position < 10)) return 0;
  return Math.max(0, s.position - 3);
}
