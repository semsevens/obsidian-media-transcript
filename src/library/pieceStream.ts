import type { PieceSource } from './mediaCache';
import {
  boxAt, concat, findMoof, initSegment, mediaSegment, readFragment, readMoov, sampleAt,
  type AudioTrack, type Fragment,
} from './mp4';

/** Kept appended ahead of what plays, and behind it (for a step back). */
const AHEAD_S = 60;
const BEHIND_S = 30;
/** One append: about this much, or this long. */
const CHUNK_BYTES = 256 * 1024;
const CHUNK_S = 15;
/** Read at once, looking for the next fragments of a fragmented file. */
const WINDOW = 256 * 1024;
/** Offline at a part not kept: try again this often (and when the line is back, or on a jump). */
const RETRY_MS = 15_000;

/**
 * Plays an MP4 audio file through Media Source Extensions from a PieceSource:
 * the pieces this device has, and the others fetched (once, and kept) as
 * playing comes to them. So listening downloads what is heard, no more, and
 * what was heard plays again offline, even a part of a file.
 *
 * A fragmented file goes in fragment by fragment as it is; a plain one is cut
 * into fragments (see mp4.ts). What can't be played so (not MP4, video in it,
 * a codec MediaSource doesn't take) is left to the caller to play as before.
 */
export class PieceStream {
  /** A piece could not be had (offline): the next part waits for the line. */
  private offline = false;
  /** The browser would not take what was given it: play it as before instead. */
  broken = false;
  private closed = false;
  private wakeUp: (() => void) | null = null;
  private retry = 0;
  private readonly url: string;
  private sb: SourceBuffer | null = null;
  private sequence = 1;
  /** Plain file: the next sample to append. Fragmented: where the next box begins. */
  private cursor = 0;
  /** The time (s) `cursor` is at, or -1 when not known yet. */
  private cursorTime = 0;
  private readonly fragments: Fragment[] = [];
  private readonly off: (() => void)[] = [];

  /** Offline, and what plays has run out: at a part this device doesn't have. */
  get gap(): boolean {
    if (!this.offline || !this.sb) return false;
    const t = this.audio.currentTime;
    const end = bufferedEnd(this.sb.buffered, t);
    return end === null || end - t < 1;
  }

  static supported(): boolean {
    return typeof MediaSource !== 'undefined';
  }

  /**
   * Begin playing `src` in `audio`, or null when it can't be played so. Throws
   * when its start can't be read (offline, and not on this device).
   */
  static async open(audio: HTMLAudioElement, src: PieceSource, onChange: () => void, durationHint = 0): Promise<PieceStream | null> {
    const head = await findMoov(src);
    if (!head) return null;
    const track = readMoov(head.moov);
    if (!track || !MediaSource.isTypeSupported(track.mime)) return null;
    if (!track.fragmented && !track.samples?.size.length) return null;
    const stream = new PieceStream(audio, src, track, head, onChange);
    await stream.start(durationHint);
    return stream;
  }

  private readonly ms = new MediaSource();

  private constructor(
    private readonly audio: HTMLAudioElement,
    private readonly src: PieceSource,
    private readonly track: AudioTrack,
    private readonly head: { ftyp: Uint8Array; moov: Uint8Array; after: number },
    private readonly onChange: () => void,
  ) {
    this.url = URL.createObjectURL(this.ms);
  }

  private async start(durationHint: number): Promise<void> {
    const { audio, ms, track } = this;
    const opened = new Promise<void>(resolve => ms.addEventListener('sourceopen', () => resolve(), { once: true }));
    audio.src = this.url;
    await opened;
    const sb = (this.sb = ms.addSourceBuffer(track.mime));
    await this.append(track.fragmented ? concat(this.head.ftyp, this.head.moov) : initSegment(track));
    const duration = track.seconds || durationHint || await this.tailDuration();
    if (duration > 0 && !sb.updating) ms.duration = duration;
    this.cursor = track.fragmented ? this.head.after : 0;
    const wake = () => this.wake();
    let last = 0;
    const tick = () => {
      if (Date.now() - last < 1000) return;
      last = Date.now();
      wake();
    };
    audio.addEventListener('seeking', wake);
    audio.addEventListener('play', wake);
    audio.addEventListener('timeupdate', tick);
    window.addEventListener('online', wake);
    this.off.push(() => {
      audio.removeEventListener('seeking', wake);
      audio.removeEventListener('play', wake);
      audio.removeEventListener('timeupdate', tick);
      window.removeEventListener('online', wake);
    });
    void this.run();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const f of this.off) f();
    window.clearTimeout(this.retry);
    this.wake();
    URL.revokeObjectURL(this.url);
  }

  private wake(): void {
    const w = this.wakeUp;
    this.wakeUp = null;
    w?.();
  }

  private sleep(): Promise<void> {
    return new Promise(resolve => { this.wakeUp = resolve; });
  }

  private async run(): Promise<void> {
    while (!this.closed) {
      try {
        if (!await this.step()) await this.sleep();
      } catch (e) {
        if (this.closed) return;
        console.warn('[media-one] stream:', e);
        if (!(e instanceof GapError)) {
          this.broken = true;
          this.onChange();
          return;
        }
        if (!this.offline) {
          this.offline = true;
          this.onChange();
        }
        window.clearTimeout(this.retry);
        this.retry = window.setTimeout(() => this.wake(), RETRY_MS);
        await this.sleep();
      }
    }
  }

  /** Append what comes next, if anything is wanted now; false when nothing is. */
  private async step(): Promise<boolean> {
    const { audio, sb, ms } = this;
    if (!sb || ms.readyState === 'closed') return false;
    const t = audio.currentTime;
    const end = bufferedEnd(sb.buffered, t);
    // Where appending should go on from: after what is there around `t`.
    const want = end ?? t;
    if (this.cursorTime < 0 || this.cursorTime > want + 1 || this.cursorTime < want - CHUNK_S - 1) await this.relocate(want);
    if (this.done()) {
      if (ms.readyState === 'open' && !sb.updating) ms.endOfStream();
      return false;
    }
    if (end !== null && end - t >= AHEAD_S) return false;
    if (this.track.fragmented) await this.appendFragments();
    else await this.appendSamples();
    if (this.offline) {
      this.offline = false;
      this.onChange();
    }
    await this.trimBehind(t);
    return true;
  }

  private done(): boolean {
    return this.track.fragmented ? this.cursor >= this.src.size : this.cursor >= this.track.samples!.size.length;
  }

  /** Go on from time `t` (s): the sample, or the fragment, it is in. */
  private async relocate(t: number): Promise<void> {
    const { track } = this;
    const at = t * track.timescale;
    if (!track.fragmented) {
      this.cursor = sampleAt(track.samples!, at);
      this.cursorTime = track.samples!.dts[this.cursor] / track.timescale;
      return;
    }
    const known = this.fragments.find(f => f.time <= at && at < f.until);
    if (known) {
      this.cursor = known.start;
      this.cursorTime = known.time / track.timescale;
      return;
    }
    const first = this.head.after;
    const duration = this.ms.duration;
    if (!(duration > 0) || !Number.isFinite(duration) || t <= 0) {
      this.cursor = first;
      this.cursorTime = 0;
      return;
    }
    // Where it should be, were the file even: then a step back until a fragment begins by `t`.
    let guess = first + Math.floor((t / duration) * (this.src.size - first));
    for (let k = 0; k < 12; k++) {
      guess = Math.max(first, Math.min(guess, this.src.size - 1));
      const f = await this.fragmentFrom(guess);
      if (!f) {
        // Past the last fragment's beginning: back a little.
        if (guess === first) break;
        guess -= 4 * WINDOW;
        continue;
      }
      if (f.time <= at || guess === first) {
        this.cursor = f.start;
        this.cursorTime = f.time / track.timescale;
        return;
      }
      guess -= Math.max(WINDOW, Math.floor(((f.time - at) / track.timescale / duration) * (this.src.size - first)) + WINDOW);
    }
    this.cursor = first;
    this.cursorTime = 0;
  }

  /** The first fragment beginning at or after `offset` (a recorder's are a megabyte apart: looks on until one is found). */
  private async fragmentFrom(offset: number): Promise<Fragment | null> {
    const { src } = this;
    for (let from = offset; from < src.size; from += WINDOW - 16) {
      const buf = await read(src, from, Math.min(src.size, from + WINDOW));
      const at = findMoof(buf);
      if (at < 0) continue;
      const f = readFragment(buf, at, this.track, from);
      if (f) return f;
      // Its moof runs past the window: read it whole.
      const whole = await read(src, from + at, Math.min(src.size, from + at + WINDOW));
      return readFragment(whole, 0, this.track, from + at);
    }
    return null;
  }

  private async appendSamples(): Promise<void> {
    const { track } = this;
    const s = track.samples!;
    const from = this.cursor;
    let to = from;
    let bytes = 0;
    const limit = s.dts[from] + CHUNK_S * track.timescale;
    while (to < s.size.length && (to === from || (bytes + s.size[to] <= CHUNK_BYTES && s.dts[to] < limit))) bytes += s.size[to++];
    let start = Infinity;
    let end = 0;
    for (let i = from; i < to; i++) {
      start = Math.min(start, s.offset[i]);
      end = Math.max(end, s.offset[i] + s.size[i]);
    }
    const data = await read(this.src, start, end);
    if (this.closed || this.cursor !== from) return;
    await this.append(mediaSegment(track, from, to, data, start, this.sequence++));
    this.cursor = to;
    this.cursorTime = to < s.size.length ? s.dts[to] / track.timescale : this.ms.duration;
  }

  private async appendFragments(): Promise<void> {
    const { track, src } = this;
    const from = this.cursor;
    let buf = await read(src, from, Math.min(src.size, from + WINDOW));
    let at = 0;
    const take: Uint8Array[] = [];
    let time = -1;
    while (from + at < src.size) {
      const box = boxAt(buf, at, from);
      if (!box) break;
      const size = box.size || src.size - (from + at);
      if (box.type !== 'moof') {
        // mfra, free, sidx…: not for the decoder.
        if (take.length) break;
        at += size;
        continue;
      }
      let f = readFragment(buf, at, track, from);
      if (!f) {
        // Its moof, or the header of its mdat, goes past what was read.
        if (take.length) break;
        buf = await read(src, from, Math.min(src.size, from + at + size + 16));
        f = readFragment(buf, at, track, from);
        if (!f) throw new Error('not a fragment');
      }
      if (f.end - from > buf.length) {
        // A fragment larger than the window (a recorder's: a minute each): read all of it.
        if (take.length) break;
        buf = await read(src, from, Math.min(src.size, f.end));
        if (f.end - from > buf.length) throw new Error('fragment cut short');
      }
      take.push(buf.subarray(at, f.end - from));
      if (!this.fragments.some(k => k.start === f.start)) this.fragments.push(f);
      if (time < 0) time = f.time;
      at = f.end - from;
      if (at >= CHUNK_BYTES) break;
    }
    if (this.closed || this.cursor !== from) return;
    if (take.length) await this.append(concat(...take));
    else if (at === 0) {
      // Not a box here: on to the next fragment.
      const next = findMoof(buf, 1);
      at = next > 0 ? next : Math.max(1, buf.length - 16);
    }
    this.cursor = from + at;
    const last = this.fragments.find(f => f.end === this.cursor);
    this.cursorTime = last ? last.until / track.timescale : this.cursorTime;
  }

  /** The length of a fragmented file, from its last fragment (its end is fetched for it, and kept). */
  private async tailDuration(): Promise<number> {
    try {
      const { src, track } = this;
      // A recorder's fragments run to a minute (a megabyte): look far enough back for the last one.
      const from = Math.max(this.head.after, src.size - 8 * WINDOW);
      const buf = await read(src, from, src.size);
      let until = 0;
      for (let at = findMoof(buf); at >= 0; at = findMoof(buf, at + 8)) {
        const f = readFragment(buf, at, track, from);
        if (f) until = Math.max(until, f.until);
      }
      return until / track.timescale;
    } catch {
      return 0;
    }
  }

  private async append(data: Uint8Array): Promise<void> {
    const sb = this.sb!;
    try {
      await whenDone(sb, () => sb.appendBuffer(data as Uint8Array<ArrayBuffer>));
    } catch (e) {
      if ((e as DOMException).name !== 'QuotaExceededError') throw e;
      // Full: let go what was played, and try once more.
      const t = this.audio.currentTime;
      if (t > 10) await whenDone(sb, () => sb.remove(0, t - 5));
      await whenDone(sb, () => sb.appendBuffer(data as Uint8Array<ArrayBuffer>));
    }
  }

  private async trimBehind(t: number): Promise<void> {
    const sb = this.sb!;
    if (sb.buffered.length && sb.buffered.start(0) < t - BEHIND_S * 2) {
      await whenDone(sb, () => sb.remove(0, t - BEHIND_S));
    }
  }
}

/** A piece neither here nor to be had (offline): the rest waits for the line. */
class GapError extends Error {}

/** The bytes `[start, end)` of `src`. */
export async function read(src: PieceSource, start: number, end: number): Promise<Uint8Array> {
  const size = src.pieceSize;
  const parts: Uint8Array[] = [];
  for (let i = Math.floor(start / size); i * size < end; i++) {
    try {
      parts.push(await src.piece(i));
    } catch (e) {
      // The server answered (not there, say): no gap to wait out.
      if ((e as { status?: number }).status) throw e;
      throw new GapError((e as Error).message);
    }
  }
  const all = concat(...parts);
  const base = Math.floor(start / size) * size;
  return all.subarray(start - base, Math.min(all.length, end - base));
}

/** ftyp and moov (whole), and where what follows moov begins; walks the top boxes, wherever moov is. */
async function findMoov(src: PieceSource): Promise<{ ftyp: Uint8Array; moov: Uint8Array; after: number } | null> {
  let at = 0;
  let ftyp: Uint8Array = new Uint8Array(0);
  for (let k = 0; k < 32 && at < src.size; k++) {
    const head = await read(src, at, Math.min(src.size, at + 16));
    const box = boxAt(head, 0, at);
    if (!box) return null;
    const size = box.size || src.size - at;
    if (box.type === 'ftyp') ftyp = await read(src, at, at + size);
    if (box.type === 'moov') return { ftyp, moov: (await read(src, at, at + size)).slice(), after: at + size };
    at += size;
  }
  return null;
}

/** The end of the buffered range around `t` (a little before it counts), or null. */
function bufferedEnd(ranges: TimeRanges, t: number): number | null {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= t + 0.3 && t <= ranges.end(i)) return ranges.end(i);
  }
  return null;
}

class AppendError extends Error {}

function whenDone(sb: SourceBuffer, act: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail); resolve(); };
    const fail = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail); reject(new AppendError('the browser would not take it')); };
    sb.addEventListener('updateend', done);
    sb.addEventListener('error', fail);
    try {
      act();
    } catch (e) {
      sb.removeEventListener('updateend', done);
      sb.removeEventListener('error', fail);
      reject((e as DOMException).name === 'QuotaExceededError' ? e as Error : new AppendError((e as Error).message));
    }
  });
}
