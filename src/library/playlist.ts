import type MediaTranscriptPlugin from '../main';

/** What the playlist holds of a media file: enough to play it without the library open. */
export interface QueueEntry {
  path: string;              // in the library: what the list knows it by
  key: string;               // in the library: what is played (a video's audio twin, say)
  size: number;              // of what is played
  title: string;
  subtitle: string;          // where it is from, when
  transcript: string | null; // vault path
}

/** Put `entry` at `where`: first, after `current` (next to play), or last. Moves it if there already. */
export function placed(list: QueueEntry[], entry: QueueEntry, where: 'top' | 'next' | 'end', current: string | null): QueueEntry[] {
  const rest = list.filter(e => e.path !== entry.path);
  if (where === 'top') return [entry, ...rest];
  if (where === 'end') return [...rest, entry];
  const at = current ? rest.findIndex(e => e.path === current) : -1;
  return [...rest.slice(0, at + 1), entry, ...rest.slice(at + 1)];
}

/** The list with the entry at `from` moved to `to`. */
export function moved<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item);
  return out;
}

/** What plays after `path`: the next entry, or (if it is not in the list) the first. */
export function after(list: QueueEntry[], path: string | null): QueueEntry | null {
  const i = path ? list.findIndex(e => e.path === path) : -1;
  return list[i + 1] ?? null;
}

/**
 * The playlist: what plays next, in order, kept with the settings (and so
 * synced). What is played goes to its top; what is listened to the end
 * leaves it, and the next one plays.
 */
export class Playlist {
  private listeners = new Set<() => void>();

  constructor(private readonly plugin: MediaTranscriptPlugin) {}

  get entries(): QueueEntry[] {
    return this.plugin.settings.playlist ?? [];
  }

  has(path: string): boolean {
    return this.entries.some(e => e.path === path);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  add(entry: QueueEntry, where: 'top' | 'next' | 'end'): void {
    this.set(placed(this.entries, entry, where, this.plugin.nowPlaying?.track?.path ?? null));
  }

  remove(path: string): void {
    this.set(this.entries.filter(e => e.path !== path));
  }

  move(from: number, to: number): void {
    this.set(moved(this.entries, from, to));
  }

  clear(): void {
    this.set([]);
  }

  next(path: string | null): QueueEntry | null {
    return after(this.entries, path);
  }

  /** The settings were changed elsewhere (synced from another device). */
  reloaded(): void {
    this.changed();
  }

  private set(list: QueueEntry[]): void {
    this.plugin.settings.playlist = list;
    void this.plugin.saveSettings();
    this.changed();
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}
