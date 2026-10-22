import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { boxes, boxAt, readMoov, initSegment, mediaSegment, readFragment, findMoof, sampleAt, concat } from '../src/library/mp4';

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));

function moovOf(file: Uint8Array): Uint8Array {
  const m = boxes(file).find(b => b.type === 'moov')!;
  return file.slice(m.start, m.start + m.size);
}

describe('mp4', () => {
  it('reads the audio track of a plain file, wherever its moov is', () => {
    for (const name of ['aac-faststart.m4a', 'aac-moov-end.m4a']) {
      const file = fixture(name);
      const track = readMoov(moovOf(file))!;
      expect(track.fragmented).toBe(false);
      expect(track.mime).toBe('audio/mp4; codecs="mp4a.40.2"');
      expect(track.duration / track.timescale).toBeCloseTo(5, 0);
      expect(track.seconds).toBeCloseTo(5, 1);
      const s = track.samples!;
      expect(s.size.length).toBeGreaterThan(200);
      // Every sample is inside the mdat, one after another.
      const mdat = boxes(file).find(b => b.type === 'mdat')!;
      expect(s.offset[0]).toBeGreaterThanOrEqual(mdat.start + mdat.header);
      const last = s.size.length - 1;
      expect(s.offset[last] + s.size[last]).toBeLessThanOrEqual(mdat.start + mdat.size);
      expect(s.dts[last] + s.duration[last]).toBe(track.duration);
    }
  });

  it('cuts a plain file into an init segment and media segments that hold all its samples', () => {
    const file = fixture('aac-faststart.m4a');
    const track = readMoov(moovOf(file))!;
    const init = initSegment(track);
    expect(boxes(init).map(b => b.type)).toEqual(['ftyp', 'moov']);
    const s = track.samples!;
    const n = s.size.length;
    const half = n >> 1;
    const parts = [init];
    for (const [a, b] of [[0, half], [half, n]]) {
      const start = s.offset[a];
      const end = s.offset[b - 1] + s.size[b - 1];
      parts.push(mediaSegment(track, a, b, file.slice(start, end), start, parts.length));
    }
    const out = concat(...parts);
    const top = boxes(out);
    expect(top.map(b => b.type)).toEqual(['ftyp', 'moov', 'moof', 'mdat', 'moof', 'mdat']);
    // The fragments read back as the samples they hold.
    const back = readMoov(moovOf(out))!;
    expect(back.fragmented).toBe(true);
    const f1 = readFragment(out, top[2].start, back)!;
    const f2 = readFragment(out, top[4].start, back)!;
    expect(f1.time).toBe(0);
    expect(f1.until).toBe(s.dts[half]);
    expect(f2.time).toBe(s.dts[half]);
    expect(f2.until).toBe(track.duration);
    // The bytes of the second segment's mdat are the samples' own.
    const mdat = top[5];
    const first = s.offset[half];
    expect(out.slice(mdat.start + 8, mdat.start + 8 + s.size[half])).toEqual(file.slice(first, first + s.size[half]));
  });

  it('reads a fragmented file: its track, its fragments in order, and finds a moof anywhere', () => {
    const file = fixture('opus-frag.m4a');
    const track = readMoov(moovOf(file))!;
    expect(track.fragmented).toBe(true);
    expect(track.mime).toBe('audio/mp4; codecs="opus"');
    expect(track.samples).toBeNull();
    let at = findMoof(file);
    let time = 0;
    let count = 0;
    while (at >= 0 && at < file.length) {
      const b = boxAt(file, at)!;
      if (b.type !== 'moof') { at += b.size; continue; } // mfra, free…
      const f = readFragment(file, at, track)!;
      expect(f.time).toBe(time);
      expect(f.until).toBeGreaterThan(f.time);
      time = f.until;
      at = f.end;
      count++;
    }
    expect(count).toBeGreaterThan(3);
    expect(time / track.timescale).toBeCloseTo(3, 0);
    // From the middle of a fragment, the next moof is found.
    const second = readFragment(file, findMoof(file), track)!.end;
    expect(findMoof(file, second - 5)).toBe(second);
  });

  it('finds the sample playing at a time', () => {
    const track = readMoov(moovOf(fixture('aac-faststart.m4a')))!;
    const s = track.samples!;
    expect(sampleAt(s, 0)).toBe(0);
    expect(sampleAt(s, s.dts[10] + 1)).toBe(10);
    expect(sampleAt(s, 1e12)).toBe(s.dts.length - 1);
  });

  it('says no to video, and to what is not a moov', () => {
    expect(readMoov(new Uint8Array(16))).toBeNull();
    expect(boxAt(new Uint8Array(4), 0)).toBeNull();
  });
});
