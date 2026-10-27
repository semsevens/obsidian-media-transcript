/**
 * Media-fragment timestamps in link subpaths: `[[talk.m4a#t=83]]`.
 *
 * `#t=` is the W3C media-fragment syntax Obsidian's own media embeds already
 * honour, so a link we copy keeps working without this plugin. We write plain
 * seconds (the most widely understood form) and read the forms people type by
 * hand: `83`, `83.5`, `1:23`, `1:02:03`, and a `start,end` range (start wins).
 */
export function parseTimeFragment(subpath: string | undefined | null): number | null {
  return parseTimeRange(subpath)?.start ?? null;
}

/**
 * Both ends of a `#t=start,end` fragment — what a quoted passage links to.
 * `end` is null for a plain start, or an end that isn't after the start.
 */
export function parseTimeRange(subpath: string | undefined | null): { start: number; end: number | null } | null {
  if (!subpath) return null;
  const m = subpath.replace(/^#/, '').match(/(?:^|&)t=(?:npt:)?([0-9:.]+)(?:,([0-9:.]+))?/);
  if (!m) return null;
  const start = clock(m[1]);
  if (start === null) return null;
  const end = m[2] !== undefined ? clock(m[2]) : null;
  return { start, end: end !== null && end > start ? end : null };
}

function clock(text: string): number | null {
  const parts = text.split(':');
  if (parts.length > 3 || parts.some(p => p === '' || isNaN(Number(p)))) return null;
  const seconds = parts.reduce((acc, p) => acc * 60 + Number(p), 0);
  return Number.isFinite(seconds) ? seconds : null;
}

/** The subpath for a link that starts playback at `seconds` (whole seconds). */
export function timeFragment(seconds: number): string {
  return `#t=${Math.max(0, Math.floor(seconds))}`;
}

/** The subpath for a passage from `start` to `end`, whole seconds taking it all in. */
export function timeRangeFragment(start: number, end: number): string {
  const from = Math.max(0, Math.floor(start));
  return `#t=${from},${Math.max(from + 1, Math.ceil(end))}`;
}
