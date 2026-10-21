import { beforeAll, describe, expect, it } from 'vitest';
import { PIECE, streamSource, uploadInPieces, type PieceSource } from '../src/library/pieceUpload';
import type { LibraryClient } from '../src/library/client';

beforeAll(() => {
  // sendPiece waits between tries with window.setTimeout; keep the tests quick.
  (globalThis as { window?: unknown }).window = { setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, (ms ?? 0) > 60_000 ? 30 : 1), clearTimeout };
});

/** A server keeping pieces by offset, in any order, as Media One does. */
function fakeServer(opts: { have?: number[]; there?: boolean; failures?: Map<number, number[]>; finishes?: Array<number | { spoil: number }> } = {}) {
  const pieces = new Map<number, Uint8Array>();
  let finished = false;
  let inFlight = 0;
  let maxInFlight = 0;
  const sentOffsets: number[] = [];
  const client = {
    uploadBegin: async () => (opts.there ? { entry: {} } : { id: 'u1', piece: PIECE, have: [...new Set([...(opts.have ?? []), ...pieces.keys()])] }),
    uploadPiece: async (_id: string, offset: number, data: ArrayBuffer) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      sentOffsets.push(offset);
      // Uneven answers: later pieces may land first.
      await new Promise(r => setTimeout(r, (offset / PIECE) % 2 ? 1 : 5));
      inFlight--;
      const fail = opts.failures?.get(offset);
      if (fail?.length) {
        const status = fail.shift()!;
        throw Object.assign(new Error(`HTTP ${status}`), { status });
      }
      pieces.set(offset, new Uint8Array(data));
    },
    uploadFinish: async () => {
      const next = opts.finishes?.shift();
      if (typeof next === 'number') throw Object.assign(new Error(`HTTP ${next}`), { status: next });
      if (next) {
        // The piece is spoiled on the server's disk: it drops it and asks for it again.
        pieces.delete(next.spoil);
        throw Object.assign(new Error('HTTP 409'), { status: 409 });
      }
      finished = true;
    },
  } as unknown as LibraryClient;
  const joined = () => {
    const offsets = [...pieces.keys()].sort((a, b) => a - b);
    const out = new Uint8Array(offsets.reduce((n, o) => n + pieces.get(o)!.length, 0));
    let at = 0;
    for (const o of offsets) {
      out.set(pieces.get(o)!, at);
      at += pieces.get(o)!.length;
    }
    return out;
  };
  return { client, pieces, sentOffsets, joined, get finished() { return finished; }, get maxInFlight() { return maxInFlight; } };
}

const file = new Uint8Array(PIECE * 5 + 12345).map((_, i) => (i * 7) % 251);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** The file as a stream from `offset`, in uneven chunks the way a reader hands them out. */
function streamed(opened: number[]) {
  return streamSource(async offset => {
    opened.push(offset);
    let at = offset;
    const sizes = [1000, 3 * 1024 * 1024 + 7, 5 * 1024 * 1024];
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= file.length) return controller.close();
        const n = sizes[i++ % sizes.length];
        controller.enqueue(file.subarray(at, at + n));
        at += n;
      },
    });
  });
}

/** A source that notes whether it was closed. */
function watched(source: PieceSource) {
  let closed = false;
  return { source: { read: source.read, close: async () => { closed = true; await source.close(); } }, get closed() { return closed; } };
}

describe('uploadInPieces', () => {
  it('sends the whole file, several pieces at once, never more than three', async () => {
    const server = fakeServer();
    const opened: number[] = [];
    const progress: number[] = [];
    const w = watched(streamed(opened));
    expect(await uploadInPieces(server.client, () => server.client.uploadBegin('a.mp4', file.length), file.length, w.source, p => progress.push(p))).toBe(true);
    expect(same(server.joined(), file)).toBe(true);
    expect(server.finished).toBe(true);
    expect(opened).toEqual([0]);                 // read in one pass
    expect(server.maxInFlight).toBeGreaterThan(1);
    expect(server.maxInFlight).toBeLessThanOrEqual(3);
    expect(progress.at(-1)).toBe(file.length);
    expect(w.closed).toBe(true);
  });

  it('after a break, sends only the pieces missing, reading from where they are', async () => {
    const server = fakeServer({ have: [0, PIECE, 3 * PIECE] });
    for (const o of [0, PIECE, 3 * PIECE]) server.pieces.set(o, file.slice(o, o + PIECE));
    const opened: number[] = [];
    const progress: number[] = [];
    await uploadInPieces(server.client, () => server.client.uploadBegin('a.mp4', file.length), file.length, streamed(opened), p => progress.push(p));
    expect(server.sentOffsets.sort((a, b) => a - b)).toEqual([2 * PIECE, 4 * PIECE, 5 * PIECE]);
    expect(opened).toEqual([2 * PIECE, 4 * PIECE]);   // a jump over a piece that is there opens the file again
    expect(progress[0]).toBe(3 * PIECE);             // starts from what arrived
    expect(same(server.joined(), file)).toBe(true);
  });

  it('tries a piece again after a passing failure', async () => {
    const server = fakeServer({ failures: new Map([[2 * PIECE, [502, 503]]]) });
    await uploadInPieces(server.client, () => server.client.uploadBegin('a.mp4', file.length), file.length, streamed([]));
    expect(server.sentOffsets.filter(o => o === 2 * PIECE)).toHaveLength(3);
    expect(same(server.joined(), file)).toBe(true);
  });

  it('sends a piece again that reached the server cut short (400: the line dropped midway)', async () => {
    const server = fakeServer({ failures: new Map([[PIECE, [400]]]) });
    await uploadInPieces(server.client, () => server.client.uploadBegin('a.mp4', file.length), file.length, streamed([]));
    expect(server.sentOffsets.filter(o => o === PIECE)).toHaveLength(2);
    expect(same(server.joined(), file)).toBe(true);
  });

  it('gives up on a piece the server refuses, without finishing, and closes the file', async () => {
    const server = fakeServer({ failures: new Map([[PIECE, [413]]]) });
    const w = watched(streamed([]));
    await expect(uploadInPieces(server.client, () => server.client.uploadBegin('a.mp4', file.length), file.length, w.source)).rejects.toThrow('HTTP 413');
    expect(server.sentOffsets.filter(o => o === PIECE)).toHaveLength(1);  // not tried again
    expect(server.finished).toBe(false);
    expect(w.closed).toBe(true);
  });

  it('sends one piece at a time once one had to be sent again', async () => {
    const server = fakeServer();
    const send = server.client.uploadPiece.bind(server.client);
    let inFlight = 0;
    let failed = false;
    let failNow = () => {};
    const hasFailed = new Promise<void>(r => { failNow = r; });
    const startedWith: number[] = [];
    const order: number[] = [];
    server.client.uploadPiece = async (id, offset, data, sha) => {
      // The first piece fails; the two sent beside it wait for that, so none
      // finishes (and lets a fourth go) while three at once still holds.
      if (offset === 0 && !failed) {
        failed = true;
        failNow();
        throw Object.assign(new Error('HTTP 503'), { status: 503 });
      }
      if (offset !== 0 && offset / PIECE < 3) await hasFailed;
      inFlight++;
      startedWith.push(inFlight);
      order.push(offset / PIECE);
      try {
        await send(id, offset, data, sha);
      } finally {
        inFlight--;
      }
    };
    await uploadInPieces(server.client, () => server.client.uploadBegin('a.mp4', file.length), file.length, streamed([]));
    expect(same(server.joined(), file)).toBe(true);
    // The first three set off together (0 failing at once); every later one, alone.
    const later = order.map((p, i) => [p, startedWith[i]]).filter(([p]) => p >= 3);
    expect(later.map(([p]) => p).sort()).toEqual([3, 4, 5]);
    expect(later.every(([, n]) => n === 1)).toBe(true);
  });

  it('gives up after five failures in a row', async () => {
    const server = fakeServer({ failures: new Map([[0, [500, 500, 500, 500, 500]]]) });
    await expect(uploadInPieces(server.client, () => server.client.uploadBegin('a.mp4', file.length), file.length, streamed([]))).rejects.toThrow('HTTP 500');
    expect(server.finished).toBe(false);
  });

  it('stops sending when told to, and closes the file', async () => {
    const server = fakeServer();
    const stop = new AbortController();
    const w = watched(streamed([]));
    let progressCalls = 0;
    const run = uploadInPieces(server.client, () => server.client.uploadBegin('a.mp4', file.length), file.length, w.source, () => {
      if (++progressCalls === 2) stop.abort();
    }, stop.signal);
    await expect(run).rejects.toThrow('stopped');
    expect(server.sentOffsets.length).toBeLessThan(6);
    expect(server.finished).toBe(false);
    expect(w.closed).toBe(true);
  });

  it('sends a piece again when its request never answers', async () => {
    const server = fakeServer();
    const real = server.client.uploadPiece.bind(server.client);
    let hung = false;
    (server.client as unknown as { uploadPiece: typeof real }).uploadPiece = (id, offset, data, sha) => {
      if (offset === PIECE && !hung) {
        hung = true;
        return new Promise(() => {});  // a stalled network: no answer, ever
      }
      return real(id, offset, data, sha);
    };
    await uploadInPieces(server.client, () => server.client.uploadBegin('a.mp4', file.length), file.length, streamed([]));
    expect(hung).toBe(true);
    expect(same(server.joined(), file)).toBe(true);
    expect(server.finished).toBe(true);
  });

  it('sends a piece again when finishing finds it spoiled, then finishes', async () => {
    const server = fakeServer({ finishes: [{ spoil: 2 * PIECE }] });
    await uploadInPieces(server.client, () => server.client.uploadBegin('a.mp4', file.length), file.length, streamed([]));
    expect(server.sentOffsets.filter(o => o === 2 * PIECE)).toHaveLength(2);
    expect(server.finished).toBe(true);
    expect(same(server.joined(), file)).toBe(true);
  });

  it('tries finishing again when the server stumbles', async () => {
    const server = fakeServer({ finishes: [500, 502] });
    await uploadInPieces(server.client, () => server.client.uploadBegin('a.mp4', file.length), file.length, streamed([]));
    expect(server.finished).toBe(true);
  });

  it('does nothing when the server has the file', async () => {
    const server = fakeServer({ there: true });
    const opened: number[] = [];
    const w = watched(streamed(opened));
    expect(await uploadInPieces(server.client, () => server.client.uploadBegin('a.mp4', file.length), file.length, w.source)).toBe(false);
    expect(opened).toEqual([]);
    expect(w.closed).toBe(true);
  });
});

describe('streamSource', () => {
  it('reads pieces in order from one stream, and opens another on a jump', async () => {
    const opened: number[] = [];
    const s = streamed(opened);
    expect(same(new Uint8Array(await s.read(0, 10)), file.subarray(0, 10))).toBe(true);
    expect(same(new Uint8Array(await s.read(10, 5000)), file.subarray(10, 5010))).toBe(true);
    expect(same(new Uint8Array(await s.read(PIECE, 100)), file.subarray(PIECE, PIECE + 100))).toBe(true);
    expect(opened).toEqual([0, PIECE]);
    await s.close();
  });

  it('says so when the file is shorter than asked', async () => {
    const s = streamed([]);
    await expect(s.read(file.length - 10, 100)).rejects.toThrow('ended');
  });
});
