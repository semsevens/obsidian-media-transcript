import { TFile } from 'obsidian';
import type MediaTranscriptPlugin from '../main';
import { DeviceState } from './deviceState';
import { parseSubtitle, type SubtitleSegment } from '../utils/subtitleParser';
import { resumeAt } from './cachePolicy';
import type { QueueEntry } from './playlist';

/** What is played: a file on the server, and its transcript if the vault has one. */
export interface Track {
  path: string;              // in the library: what the list knows it by
  key: string;               // in the library: what is played (a video's audio twin, say)
  url: string;               // where the server serves it
  size: number;              // of what is played, 0 if unknown
  title: string;
  subtitle: string;          // where it is from, when
  transcript: TFile | null;
}

export const RATES = [1, 1.25, 1.5, 2, 0.75];
const BACK_S = 15;
const AHEAD_S = 30;

/**
 * The one thing playing from the media library, whatever is on screen: it
 * keeps playing when the library is closed or hidden (a phone's drawer shut),
 * and the player bars (in the library, in the status bar, floating on a
 * phone) all show and steer it. One sound at a time: when anything else in
 * Obsidian starts playing (a transcript's player, a video in a note), this
 * pauses.
 */
export class NowPlaying {
  track: Track | null = null;
  private audio: HTMLAudioElement | null = null;
  private segments: SubtitleSegment[] = [];
  private listeners = new Set<() => void>();
  private readonly device: DeviceState;
  private lastKept = 0;
  /** Played from this device's copy, not the server. */
  local = false;
  /** It could not be played (offline, and not on this device). */
  failed = false;
  /** Sleep timer: pause at this time (ms), or when this one ends; null: off. */
  sleep: number | 'end' | null = null;

  constructor(private readonly plugin: MediaTranscriptPlugin) {
    this.device = new DeviceState(plugin.app);
    // Media events do not bubble, but they pass the document on capture.
    plugin.registerDomEvent(document, 'play', evt => {
      if (this.audio && evt.target !== this.audio && !this.audio.paused) this.audio.pause();
      pauseAllBut(evt.target);
    }, true);
    plugin.register(() => this.stop());
  }

  get playing(): boolean {
    return !!this.audio && !this.audio.paused;
  }

  get time(): number {
    return this.audio?.currentTime ?? 0;
  }

  get duration(): number {
    const d = this.audio?.duration ?? 0;
    return Number.isFinite(d) ? d : 0;
  }

  get rate(): number {
    return this.device.get<number>('playbackRate', 1);
  }

  /** The line being said now, or ''. */
  get line(): string {
    const i = lineAt(this.segments, this.time);
    return i >= 0 ? this.segments[i].text : '';
  }

  /** `before` lines before the one being said, it, and `after` lines after ('' where there is none); and which is it. */
  lines(before: number, after: number): { text: string[]; now: number } {
    const i = lineAt(this.segments, this.time);
    const text: string[] = [];
    for (let j = i - before; j <= i + after; j++) text.push(j >= 0 ? this.segments[j]?.text ?? '' : '');
    return { text, now: before };
  }

  /** The line before, the line being said, the line after ('' where there is none). */
  get around(): [string, string, string] {
    const i = lineAt(this.segments, this.time);
    const at = (j: number) => this.segments[j]?.text ?? '';
    return [i > 0 ? at(i - 1) : '', i >= 0 ? at(i) : '', at(i + 1)];
  }

  /**
   * How much is said in each of `n` equal parts of it, 0–1, from the
   * transcript (all 0 without one): what the seek bar draws.
   */
  density(n: number): number[] {
    const d = this.duration;
    const key = `${n}:${d}:${this.segments.length}`;
    if (this.densityMemo?.key === key) return this.densityMemo.value;
    const value = this.computeDensity(n, d);
    this.densityMemo = { key, value };
    return value;
  }

  private densityMemo: { key: string; value: number[] } | null = null;

  private computeDensity(n: number, d: number): number[] {
    const out = new Array<number>(n).fill(0);
    if (!d || this.segments.length === 0) return out;
    for (const s of this.segments) {
      const from = Math.max(0, Math.floor((s.startTime / d) * n));
      const to = Math.min(n - 1, Math.floor((Math.max(s.startTime, s.endTime) / d) * n));
      const share = s.text.length / (to - from + 1);
      for (let i = from; i <= to; i++) out[i] += share;
    }
    const max = Math.max(...out);
    return max > 0 ? out.map(v => v / max) : out;
  }

  /** Call `fn` whenever anything changes (the track, playing or not, the time); returns how to stop. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Play `track`, or pause and resume it if it is the one playing. */
  play(track: Track): void {
    if (this.track?.path === track.path && this.audio) {
      this.toggle();
      return;
    }
    this.stop();
    this.track = track;
    this.local = false;
    this.failed = false;
    const { cache } = this.plugin;
    cache.playing = track.key;
    // What is played goes to the top of the playlist.
    this.plugin.playlist.add(entryOf(track), 'top');
    const audio = (this.audio = new Audio());
    audio.preload = 'auto';
    for (const type of ['play', 'pause', 'timeupdate', 'loadedmetadata', 'ratechange']) audio.addEventListener(type, () => this.changed());
    // Not on the page, so its own start is not seen by the listener above.
    audio.addEventListener('play', () => pauseAllBut(audio));
    audio.addEventListener('ended', () => {
      this.keepPlace(true);
      this.finished(track);
    });
    audio.addEventListener('pause', () => this.keepPlace(true));
    audio.addEventListener('timeupdate', () => {
      this.keepPlace(false);
      if (typeof this.sleep === 'number' && Date.now() >= this.sleep) {
        this.sleep = null;
        audio.pause();
      }
    });
    audio.addEventListener('error', () => {
      if (this.audio !== audio) return;
      this.failed = true;
      this.changed();
    });
    // Where it was left last time.
    const from = resumeAt(cache.statsOf(track.key));
    audio.addEventListener('loadedmetadata', () => {
      if (from > 0 && audio.currentTime < 1) audio.currentTime = from;
    }, { once: true });
    const file = track.transcript;
    if (file) {
      void this.plugin.app.vault.cachedRead(file).then(text => {
        if (this.track !== track) return;
        this.segments = parseSubtitle(text, file.extension).filter(s => !/^[[(（【].*[\])）】]$/.test(s.text.trim()));
        this.changed();
      });
    }
    this.mediaSession(track);
    this.changed();
    void cache.url(track.key).then(local => {
      if (this.audio !== audio) return;
      this.local = !!local;
      audio.src = local ?? track.url;
      audio.playbackRate = this.rate;
      cache.played(track.key, from, 0, true);
      // Kept on this device too, to play offline next time.
      if (!local) cache.auto({ path: track.key, url: track.url, size: track.size });
      this.changed();
      void audio.play().catch(() => this.changed());
    });
  }

  /** Play what the playlist holds. */
  playEntry(entry: QueueEntry): void {
    const file = entry.transcript ? this.plugin.app.vault.getAbstractFileByPath(entry.transcript) : null;
    this.play({
      path: entry.path,
      key: entry.key,
      url: this.plugin.library.libraryUrl(entry.key),
      size: entry.size,
      title: entry.title,
      subtitle: entry.subtitle,
      transcript: file instanceof TFile ? file : null,
    });
  }

  /** Listened to the end: it leaves the playlist, and the next one plays (unless the timer says stop). */
  private finished(track: Track): void {
    const { playlist } = this.plugin;
    const next = playlist.next(track.path);
    playlist.remove(track.path);
    const stopHere = this.sleep === 'end';
    if (stopHere) this.sleep = null;
    this.stop();
    if (next && !stopHere) this.playEntry(next);
  }

  /** Sleep timer: in `minutes`, at the end of this one, or off. */
  setSleep(minutes: number | 'end' | null): void {
    this.sleep = typeof minutes === 'number' ? Date.now() + minutes * 60000 : minutes;
    this.changed();
  }

  /** Play the next in the playlist now. */
  skip(): void {
    const next = this.plugin.playlist.next(this.track?.path ?? null);
    if (next) this.playEntry(next);
  }

  /** Keep where it is, to take it up there next time (and to know what was listened to). */
  private keepPlace(now: boolean): void {
    const { audio, track } = this;
    if (!audio || !track || audio.readyState === 0) return;
    if (!now && Date.now() - this.lastKept < 5000) return;
    this.lastKept = Date.now();
    this.plugin.cache.played(track.key, audio.ended ? this.duration : audio.currentTime, this.duration);
  }

  toggle(): void {
    const { audio } = this;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => this.changed());
    else audio.pause();
  }

  seek(seconds: number): void {
    if (!this.audio) return;
    this.audio.currentTime = Math.max(0, Math.min(seconds, this.duration || seconds));
    this.changed();
  }

  back(): void {
    this.seek(this.time - BACK_S);
  }

  ahead(): void {
    this.seek(this.time + AHEAD_S);
  }

  /** The next speed: 1×, 1.25×, 1.5×, 2×, 0.75×, and round again. Kept on this device. */
  nextRate(): void {
    const next = RATES[(RATES.indexOf(this.rate) + 1) % RATES.length] ?? 1;
    this.device.set('playbackRate', next);
    if (this.audio) this.audio.playbackRate = next;
    this.changed();
  }

  stop(): void {
    const { audio } = this;
    if (!audio && !this.track) return;
    this.keepPlace(true);
    this.audio = null;
    this.track = null;
    this.segments = [];
    this.plugin.cache.playing = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    this.changed();
  }

  /** Read along: the transcript, at where the playing is; this stops, the transcript's player takes over. */
  async openTranscript(): Promise<void> {
    const file = this.track?.transcript;
    if (!file) return;
    const at = this.time;
    this.stop();
    await this.plugin.openTranscript(file, at);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** The phone's lock screen and notification shade, where the system offers them. */
  private mediaSession(track: Track): void {
    if (!('mediaSession' in navigator)) return;
    try {
      const session = navigator.mediaSession;
      session.metadata = new MediaMetadata({ title: track.title, artist: 'Media One' });
      session.setActionHandler('play', () => this.toggle());
      session.setActionHandler('pause', () => this.toggle());
      session.setActionHandler('seekbackward', () => this.back());
      session.setActionHandler('seekforward', () => this.ahead());
      session.setActionHandler('stop', () => this.stop());
    } catch {
      // not offered here
    }
  }
}

/** What the playlist keeps of a track. */
export function entryOf(track: Track): QueueEntry {
  return { path: track.path, key: track.key, size: track.size, title: track.title, subtitle: track.subtitle, transcript: track.transcript?.path ?? null };
}

/** One sound at a time: pause every other audio or video on the page. */
function pauseAllBut(playing: EventTarget | null): void {
  for (const media of Array.from(document.querySelectorAll<HTMLMediaElement>('audio, video'))) {
    if (media !== playing && !media.paused) media.pause();
  }
}

/** The last line that has started by `t` seconds, or -1 before the first. */
export function lineAt(segments: SubtitleSegment[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].startTime <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
