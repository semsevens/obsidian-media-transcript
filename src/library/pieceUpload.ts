import type { LibraryClient } from './client';

/** Pieces of 8 MB, unless the server says otherwise: little to hold, few requests. */
export const PIECE = 8 * 1024 * 1024;
/**
 * What a device asks for when it begins an upload: 2 MB. Over a slow line (a
 * relay, some 50 KB/s) a piece then goes in under a minute, so one cut off
 * costs little and the progress moves; on a fast one the requests are still few.
 */
export const ASK_PIECE = 2 * 1024 * 1024;
/** Pieces on their way at once: enough to keep the line busy while the server writes. */
const PARALLEL = 3;
const TRIES = 5;
/**
 * A piece not answered by then is taken for lost and sent again: a request on
 * a network that stalled (a VPN coming back) may never answer, and would hold
 * up every upload behind it. The server takes a piece sent twice in its stride.
 * Three minutes, or longer for a big piece: as long as it takes at 16 KB/s.
 */
const PIECE_TIMEOUT_MS = 3 * 60_000;
const SLOWEST = 16 * 1024;

/** Where the pieces are read from. */
export interface PieceSource {
  read(offset: number, length: number): Promise<ArrayBuffer>;
  close(): Promise<void>;
}

/**
 * Upload a file a piece at a time, never holding more than a few pieces: how
 * media of any size is sent, from a phone as from a computer, into the
 * library or (a video saved from the web) into the archive — `begin` says which. Each piece is
 * checked by its sha256; several go at once; the server keeps what arrived,
 * so after a break (the app closed or sent to the background, the network
 * gone) the next try sends only what is missing.
 *
 * Returns true if the file was stored now, false if the server had it already.
 * Stopped by `signal`, it sends no more pieces and rejects.
 */
/** What beginning an upload answers: where to send pieces and which are there, or that the file is there. */
export type Begun = { id: string; piece: number; have: number[] } | { entry: unknown };

export async function uploadInPieces(
  client: LibraryClient,
  begin: () => Promise<Begun>,
  size: number,
  source: PieceSource,
  onProgress?: (sent: number) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    // A round: ask what the server has, send what's missing, ask it to keep the file.
    // Finishing may find a piece spoiled on its disk and ask for it again: another round.
    for (let round = 1; ; round++) {
      const begun = await begin();
      if ('entry' in begun) return false;
      await sendMissing(client, begun, size, source, onProgress, signal);
      try {
        await finish(client, begun.id);
        return true;
      } catch (e) {
        if ((e as { status?: number }).status !== 409 || round >= ROUNDS) throw e;
      }
    }
  } finally {
    await source.close();
  }
}

const ROUNDS = 3;

async function sendMissing(
  client: LibraryClient,
  begun: { id: string; piece: number; have: number[] },
  size: number,
  source: PieceSource,
  onProgress?: (sent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const piece = begun.piece || PIECE;
  const have = new Set(begun.have ?? []);
  const missing: number[] = [];
  let sent = 0;
  for (let offset = 0; offset < size; offset += piece) {
    if (have.has(offset)) sent += Math.min(piece, size - offset);
    else missing.push(offset);
  }
  onProgress?.(sent);

  const inFlight = new Set<Promise<void>>();
  const failed: { error?: Error } = {};
  // A piece that had to be sent again means the line can't carry several at
  // once: one at a time from then on, rather than each crowding out the others.
  const line = { parallel: PARALLEL };
  for (const offset of missing) {
    if (failed.error) break;
    // Stopped (the plugin unloaded): what arrived stays on the server for next time.
    if (signal?.aborted) {
      failed.error = new Error('stopped');
      break;
    }
    const length = Math.min(piece, size - offset);
    const data = await source.read(offset, length);
    const task = sendPiece(client, begun.id, offset, data, () => { line.parallel = 1; }).then(
      () => {
        sent += length;
        onProgress?.(sent);
      },
      (e: unknown) => { failed.error ??= e instanceof Error ? e : new Error('a piece could not be sent'); },
    );
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
    while (inFlight.size >= line.parallel) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);
  if (failed.error) throw failed.error;
}

/** Ask the server to keep the file; a passing failure (its store slow to answer) is tried again. */
async function finish(client: LibraryClient, id: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.uploadFinish(id);
      return;
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (attempt >= TRIES || (status >= 400 && status < 500)) throw e;
      await new Promise(r => window.setTimeout(r, 2000 * attempt));
    }
  }
}

/**
 * One piece, tried again on a passing failure. That includes a 400: the
 * server answers so when a piece reaches it cut short or spoiled (the line
 * dropped midway), and the same piece sent again goes in. An upload it no
 * longer knows (404) or a piece it won't take (413) is no passing failure.
 */
async function sendPiece(client: LibraryClient, id: string, offset: number, data: ArrayBuffer, retried?: () => void): Promise<void> {
  const digest = await sha256Hex(data);
  const timeout = Math.max(PIECE_TIMEOUT_MS, (data.byteLength / SLOWEST) * 1000);
  for (let attempt = 1; ; attempt++) {
    try {
      await withTimeout(client.uploadPiece(id, offset, data, digest), timeout);
      return;
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (attempt >= TRIES || (status > 400 && status < 500)) throw e;
      retried?.();
      await new Promise(r => window.setTimeout(r, 2000 * attempt));
    }
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer = 0;
  const late = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(Object.assign(new Error('no answer in time'), { status: 0 })), ms);
  });
  return Promise.race([work, late]).finally(() => window.clearTimeout(timer));
}

/**
 * A file read as a stream from where it is asked for (`open(offset)`): what a
 * phone has, serving vault files over its local web server with ranges. Read
 * in order, one stream does; a jump opens another.
 */
export function streamSource(open: (offset: number) => Promise<ReadableStream<Uint8Array>>): PieceSource {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let position = -1;
  let rest: Uint8Array = new Uint8Array(0);
  const drop = async () => {
    await reader?.cancel().catch(() => {});
    reader = null;
    rest = new Uint8Array(0);
  };
  return {
    async read(offset, length) {
      if (!reader || position !== offset) {
        await drop();
        reader = (await open(offset)).getReader();
        position = offset;
      }
      const out = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        if (rest.length === 0) {
          const { done, value } = await reader.read();
          if (done) throw new Error(`the file ended at ${position + filled}`);
          rest = value;
        }
        const take = Math.min(rest.length, length - filled);
        out.set(rest.subarray(0, take), filled);
        filled += take;
        rest = rest.subarray(take);
      }
      position += length;
      return out.buffer;
    },
    close: drop,
  };
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
