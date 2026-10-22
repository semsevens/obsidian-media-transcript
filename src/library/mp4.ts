/**
 * Enough of MP4 to play an audio file a piece at a time through Media Source
 * Extensions, from bytes this device fetched (and keeps) itself: so what is
 * listened to is downloaded once, for playing and for keeping alike.
 *
 * A fragmented file (what Obsidian's recorder makes: moov, then moof+mdat
 * pairs) goes in as it is. A plain one (moov with the whole sample table,
 * what most recorders and podcasts make) is cut into fragments here: an init
 * segment once, then moof+mdat segments of its samples. Audio only: a file
 * with video in it is played as before.
 */

export interface Box {
  type: string;
  start: number;      // where the box begins, in the file
  size: number;       // with its header; 0 when it is not known (to the end)
  header: number;     // 8, or 16 for a 64-bit size
}

/** The box whose header is at `at` in `buf` (`base` is where `buf` begins in the file), or null if it does not fit. */
export function boxAt(buf: Uint8Array, at: number, base = 0): Box | null {
  if (at + 8 > buf.length) return null;
  const v = view(buf);
  let size = v.getUint32(at);
  const type = fourcc(buf, at + 4);
  let header = 8;
  if (size === 1) {
    if (at + 16 > buf.length) return null;
    size = v.getUint32(at + 8) * 2 ** 32 + v.getUint32(at + 12);
    header = 16;
  } else if (size !== 0 && size < 8) return null;
  return { type, start: base + at, size, header };
}

/** The boxes one after another in `buf[from, to)`, as far as they are whole. */
export function boxes(buf: Uint8Array, from = 0, to = buf.length): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    const b = boxAt(buf, at);
    if (!b) break;
    const size = b.size || to - at;
    if (at + size > to) break;
    out.push({ ...b, size });
    at += size;
  }
  return out;
}

/** The first child of the box at `b` (inside `buf`) of `type`, skipping `skip` bytes of its own fields first. */
function child(buf: Uint8Array, b: Box, type: string, skip = 0): Box | null {
  return boxes(buf, b.start + b.header + skip, b.start + b.size).find(c => c.type === type) ?? null;
}

function path(buf: Uint8Array, b: Box, ...types: string[]): Box | null {
  let at: Box | null = b;
  for (const type of types) {
    if (!at) return null;
    at = child(buf, at, type);
  }
  return at;
}

export interface AudioTrack {
  id: number;
  timescale: number;
  /** In the track's timescale; 0 when the file doesn't say (a fragmented one, often). */
  duration: number;
  /**
   * How long it is, in seconds, as best the moov says; 0 if it doesn't. For a
   * fragmented file from the movie header (mehd, mvhd): Chrome's recorder
   * writes the track's own in milliseconds while calling them its timescale's.
   */
  seconds: number;
  /** What MediaSource is told it is, e.g. `audio/mp4; codecs="opus"`. */
  mime: string;
  /** The stsd box as it is: what the decoder needs. */
  stsd: Uint8Array;
  fragmented: boolean;
  /** Per sample, for a plain file: where it is, how large, when, how long. */
  samples: Samples | null;
  /** For a fragmented file: a sample's length when a fragment doesn't give it. */
  defaultDuration: number;
}

export interface Samples {
  offset: Float64Array;
  size: Uint32Array;
  dts: Float64Array;
  duration: Uint32Array;
}

/**
 * The audio track of a moov box (`moov` holds the whole box, header too), or
 * null when there is none, or there is video too.
 */
export function readMoov(moov: Uint8Array): AudioTrack | null {
  const root = boxAt(moov, 0);
  if (!root || root.type !== 'moov') return null;
  const v = view(moov);
  let audio: Box | null = null;
  for (const trak of boxes(moov, root.header, root.size).filter(b => b.type === 'trak')) {
    const hdlr = path(moov, trak, 'mdia', 'hdlr');
    const kind = hdlr ? fourcc(moov, hdlr.start + hdlr.header + 8) : '';
    if (kind === 'vide') return null;
    if (kind === 'soun' && !audio) audio = trak;
  }
  if (!audio) return null;

  const tkhd = child(moov, audio, 'tkhd');
  const mdhd = path(moov, audio, 'mdia', 'mdhd');
  const stbl = path(moov, audio, 'mdia', 'minf', 'stbl');
  const stsd = stbl && child(moov, stbl, 'stsd');
  if (!tkhd || !mdhd || !stbl || !stsd) return null;
  const tk = tkhd.start + tkhd.header;
  const id = v.getUint32(tk + (moov[tk] === 1 ? 20 : 12));
  const md = mdhd.start + mdhd.header;
  const timescale = moov[md] === 1 ? v.getUint32(md + 20) : v.getUint32(md + 12);
  const duration = moov[md] === 1 ? v.getUint32(md + 24) * 2 ** 32 + v.getUint32(md + 28) : v.getUint32(md + 16);
  const codec = codecOf(moov, stsd);
  if (!codec || !timescale) return null;

  const mvhd = child(moov, root, 'mvhd');
  const mv = mvhd ? mvhd.start + mvhd.header : -1;
  const movieScale = mv < 0 ? 0 : moov[mv] === 1 ? v.getUint32(mv + 20) : v.getUint32(mv + 12);
  const movieLength = mv < 0 ? 0 : moov[mv] === 1 ? v.getUint32(mv + 24) * 2 ** 32 + v.getUint32(mv + 28) : v.getUint32(mv + 16);
  const mvex = child(moov, root, 'mvex');
  const mehd = mvex && child(moov, mvex, 'mehd');
  const fragmentLength = !mehd ? 0 : moov[mehd.start + mehd.header] === 1
    ? v.getUint32(mehd.start + mehd.header + 4) * 2 ** 32 + v.getUint32(mehd.start + mehd.header + 8)
    : v.getUint32(mehd.start + mehd.header + 4);
  const movieSeconds = movieScale ? (fragmentLength || movieLength) / movieScale : 0;
  const trex = mvex && boxes(moov, mvex.start + mvex.header, mvex.start + mvex.size)
    .find(b => b.type === 'trex' && v.getUint32(b.start + b.header + 4) === id);
  const fragmented = !!mvex;
  return {
    id,
    timescale,
    duration,
    seconds: fragmented ? movieSeconds : duration / timescale || movieSeconds,
    mime: `audio/mp4; codecs="${codec}"`,
    stsd: moov.slice(stsd.start, stsd.start + stsd.size),
    fragmented,
    samples: fragmented ? null : readSamples(moov, stbl),
    defaultDuration: trex ? v.getUint32(trex.start + trex.header + 12) : 0,
  };
}

/** The codecs parameter for the first sample entry of an stsd box. */
function codecOf(buf: Uint8Array, stsd: Box): string | null {
  const entry = boxAt(buf, stsd.start + stsd.header + 8);
  if (!entry) return null;
  switch (entry.type) {
    case 'Opus': return 'opus';
    case 'fLaC': return 'flac';
    case 'ac-3': return 'ac-3';
    case 'ec-3': return 'ec-3';
    case 'mp4a': return mp4aCodec(buf, entry) ?? 'mp4a.40.2';
    default: return null;
  }
}

/** mp4a.40.2 (AAC-LC), mp4a.40.5 (HE-AAC), mp4a.6B (MP3)…: from the esds in an mp4a entry. */
function mp4aCodec(buf: Uint8Array, entry: Box): string | null {
  const end = entry.start + entry.size;
  let at = -1;
  for (let i = entry.start + 8; i + 4 <= end; i++) {
    if (buf[i] === 0x65 && buf[i + 1] === 0x73 && buf[i + 2] === 0x64 && buf[i + 3] === 0x73) { at = i + 8; break; } // 'esds' + version/flags
  }
  if (at < 0) return null;
  const desc = (p: number): { tag: number; len: number; body: number } | null => {
    if (p >= end) return null;
    const tag = buf[p++];
    let len = 0;
    for (let k = 0; k < 4 && p < end; k++) {
      const c = buf[p++];
      len = (len << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return { tag, len, body: p };
  };
  const es = desc(at);
  if (!es || es.tag !== 3) return null;
  let p = es.body + 2;
  const flags = buf[p++];
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + buf[p];
  if (flags & 0x20) p += 2;
  const dc = desc(p);
  if (!dc || dc.tag !== 4) return null;
  const oti = buf[dc.body];
  if (oti !== 0x40) return `mp4a.${oti.toString(16).toUpperCase()}`;
  const ds = desc(dc.body + 13);
  if (!ds || ds.tag !== 5) return 'mp4a.40.2';
  let aot = buf[ds.body] >> 3;
  if (aot === 31) aot = 32 + (((buf[ds.body] & 7) << 3) | (buf[ds.body + 1] >> 5));
  return `mp4a.40.${aot}`;
}

function readSamples(buf: Uint8Array, stbl: Box): Samples | null {
  const v = view(buf);
  const body = (type: string) => {
    const b = child(buf, stbl, type);
    return b ? b.start + b.header + 4 : -1; // past version/flags
  };
  const stsz = body('stsz');
  const stts = body('stts');
  const stsc = body('stsc');
  const stco = body('stco');
  const co64 = body('co64');
  if (stsz < 0 || stts < 0 || stsc < 0 || (stco < 0 && co64 < 0)) return null;

  const fixed = v.getUint32(stsz);
  const n = v.getUint32(stsz + 4);
  const size = new Uint32Array(n);
  for (let i = 0; i < n; i++) size[i] = fixed || v.getUint32(stsz + 8 + i * 4);

  const dts = new Float64Array(n);
  const duration = new Uint32Array(n);
  let i = 0;
  let t = 0;
  for (let e = 0, entries = v.getUint32(stts); e < entries && i < n; e++) {
    const count = v.getUint32(stts + 4 + e * 8);
    const delta = v.getUint32(stts + 8 + e * 8);
    for (let k = 0; k < count && i < n; k++, i++) {
      dts[i] = t;
      duration[i] = delta;
      t += delta;
    }
  }

  const chunks = stco >= 0 ? v.getUint32(stco) : v.getUint32(co64);
  const chunkAt = (c: number) => stco >= 0
    ? v.getUint32(stco + 4 + c * 4)
    : v.getUint32(co64 + 4 + c * 8) * 2 ** 32 + v.getUint32(co64 + 8 + c * 8);
  const offset = new Float64Array(n);
  const runs = v.getUint32(stsc);
  let s = 0;
  for (let r = 0; r < runs && s < n; r++) {
    const first = v.getUint32(stsc + 4 + r * 12) - 1;
    const per = v.getUint32(stsc + 8 + r * 12);
    const last = r + 1 < runs ? v.getUint32(stsc + 4 + (r + 1) * 12) - 1 : chunks;
    for (let c = first; c < last && s < n; c++) {
      let at = chunkAt(c);
      for (let k = 0; k < per && s < n; k++, s++) {
        offset[s] = at;
        at += size[s];
      }
    }
  }
  return { offset, size, dts, duration };
}

/** The init segment for a plain file's audio track: its sample entry, an empty sample table, and mvex. */
export function initSegment(track: AudioTrack): Uint8Array {
  const zero = (n: number) => new Uint8Array(n);
  const matrix = u32s(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);
  const ftyp = box('ftyp', ascii('isom'), u32s(0x200), ascii('isomiso6mp41'));
  const mvhd = box('mvhd', u32s(0, 0, 0, track.timescale, 0, 0x00010000), u16s(0x0100), zero(10), matrix, zero(24), u32s(track.id + 1));
  const tkhd = box('tkhd', u32s(0x00000003, 0, 0, track.id, 0, 0), zero(8), u16s(0, 0, 0x0100, 0), matrix, u32s(0, 0));
  const mdhd = box('mdhd', u32s(0, 0, 0, track.timescale, 0), u16s(0x55c4, 0));
  const hdlr = box('hdlr', u32s(0, 0), ascii('soun'), zero(12), ascii('SoundHandler'), zero(1));
  const smhd = box('smhd', u32s(0, 0));
  const dinf = box('dinf', box('dref', u32s(0, 1), box('url ', u32s(1))));
  const stbl = box('stbl', track.stsd, box('stts', u32s(0, 0)), box('stsc', u32s(0, 0)), box('stsz', u32s(0, 0, 0)), box('stco', u32s(0, 0)));
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', smhd, dinf, stbl)));
  const mvex = box('mvex', box('trex', u32s(0, track.id, 1, 0, 0, 0)));
  return concat(ftyp, box('moov', mvhd, trak, mvex));
}

/**
 * A media segment (moof+mdat) of a plain file's samples `[from, to)`, whose
 * bytes are `data`, read from the file at `dataStart`.
 */
export function mediaSegment(track: AudioTrack, from: number, to: number, data: Uint8Array, dataStart: number, sequence: number): Uint8Array {
  const s = track.samples!;
  const n = to - from;
  const mdatBody = new Uint8Array(s.size.subarray(from, to).reduce((a, b) => a + b, 0));
  let at = 0;
  for (let i = from; i < to; i++) {
    const start = s.offset[i] - dataStart;
    mdatBody.set(data.subarray(start, start + s.size[i]), at);
    at += s.size[i];
  }
  const entries = new Uint8Array(n * 8);
  const ev = view(entries);
  for (let i = 0; i < n; i++) {
    ev.setUint32(i * 8, s.duration[from + i]);
    ev.setUint32(i * 8 + 4, s.size[from + i]);
  }
  const base = s.dts[from];
  const build = (dataOffset: number) => box('moof',
    box('mfhd', u32s(0, sequence)),
    box('traf',
      box('tfhd', u32s(0x00020000, track.id)),
      box('tfdt', u32s(0x01000000, Math.floor(base / 2 ** 32), base % 2 ** 32)),
      box('trun', u32s(0x00000301, n, dataOffset), entries)));
  const moofSize = build(0).length;
  return concat(build(moofSize + 8), box('mdat', mdatBody));
}

/** A fragment of a fragmented file: when it begins, and when it ends, in its timescale. */
export interface Fragment {
  start: number;      // where its moof begins, in the file
  end: number;        // where its mdat ends
  time: number;
  until: number;
}

/**
 * The fragment whose moof begins at `at` in `buf` (`base` is where `buf`
 * begins in the file), if its moof and the header of its mdat are in `buf`.
 */
export function readFragment(buf: Uint8Array, at: number, track: AudioTrack, base = 0): Fragment | null {
  const moof = boxAt(buf, at, base);
  if (!moof || moof.type !== 'moof' || at + moof.size > buf.length) return null;
  const mdat = boxAt(buf, at + moof.size, base);
  if (!mdat || mdat.type !== 'mdat') return null;
  const v = view(buf);
  for (const traf of boxes(buf, at + moof.header, at + moof.size).filter(b => b.type === 'traf')) {
    const tfhd = child(buf, traf, 'tfhd');
    if (!tfhd) continue;
    const h = tfhd.start + tfhd.header;
    if (v.getUint32(h + 4) !== track.id) continue;
    const flags = v.getUint32(h) & 0xffffff;
    let p = h + 8;
    if (flags & 0x01) p += 8;
    if (flags & 0x02) p += 4;
    const fallback = flags & 0x08 ? v.getUint32(p) : track.defaultDuration;
    const tfdt = child(buf, traf, 'tfdt');
    const time = !tfdt ? 0 : buf[tfdt.start + tfdt.header] === 1
      ? v.getUint32(tfdt.start + tfdt.header + 4) * 2 ** 32 + v.getUint32(tfdt.start + tfdt.header + 8)
      : v.getUint32(tfdt.start + tfdt.header + 4);
    let length = 0;
    for (const trun of boxes(buf, traf.start + traf.header, traf.start + traf.size).filter(b => b.type === 'trun')) {
      const r = trun.start + trun.header;
      const tf = v.getUint32(r) & 0xffffff;
      const count = v.getUint32(r + 4);
      let q = r + 8;
      if (tf & 0x01) q += 4;
      if (tf & 0x04) q += 4;
      const per = ((tf & 0x100) ? 4 : 0) + ((tf & 0x200) ? 4 : 0) + ((tf & 0x400) ? 4 : 0) + ((tf & 0x800) ? 4 : 0);
      for (let k = 0; k < count; k++) length += tf & 0x100 ? v.getUint32(q + k * per) : fallback;
    }
    return { start: base + at, end: base + at + moof.size + (mdat.size || 0), time, until: time + length };
  }
  return null;
}

/** Where in `buf[from…)` the next moof begins (a box 'moof' holding 'mfhd' first), or -1. */
export function findMoof(buf: Uint8Array, from = 0): number {
  for (let i = Math.max(0, from); i + 16 <= buf.length; i++) {
    if (buf[i + 4] !== 0x6d || buf[i + 5] !== 0x6f || buf[i + 6] !== 0x6f || buf[i + 7] !== 0x66) continue; // 'moof'
    if (fourcc(buf, i + 12) === 'mfhd' && view(buf).getUint32(i) >= 24) return i;
  }
  return -1;
}

/** The index of the sample playing at `t` (in the timescale): the last one starting by then. */
export function sampleAt(samples: Samples, t: number): number {
  let lo = 0;
  let hi = samples.dts.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples.dts[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

// ── writing boxes ─────────────────────────────────────────────────────────────

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(...parts);
  const out = new Uint8Array(8 + body.length);
  view(out).setUint32(0, out.length);
  out.set(ascii(type), 4);
  out.set(body, 8);
  return out;
}

function u32s(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  values.forEach((n, i) => view(out).setUint32(i * 4, n >>> 0));
  return out;
}

function u16s(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  values.forEach((n, i) => view(out).setUint16(i * 2, n));
  return out;
}

function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function fourcc(buf: Uint8Array, at: number): string {
  return String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
}

function view(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}
