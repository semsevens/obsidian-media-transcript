export type Arrangement = 'side' | 'stack';

/** Below this the transcript beside a video would be too narrow to read. */
export const SIDE_MIN_WIDTH = 640;
/** A portrait video is narrow: it fits beside the transcript in less. */
export const SIDE_MIN_WIDTH_PORTRAIT = 560;
/** Steps taken back from a choice before it turns, so a pane dragged at the edge does not flicker. */
const SLACK_PX = 24;
const SLACK_RATIO = 0.1;

/**
 * Beside or above, chosen by the pane: beside when it is wide enough and at
 * least as wide as tall (a portrait video, by less), above otherwise; above,
 * the transcript would get too little height on a wide, low pane. `current`
 * holds the choice until the pane is clearly past the edge.
 */
export function pickArrangement(width: number, height: number, aspect: number, current?: Arrangement): Arrangement {
  const portrait = aspect > 0 && aspect < 1;
  const minWidth = portrait ? SIDE_MIN_WIDTH_PORTRAIT : SIDE_MIN_WIDTH;
  const minRatio = portrait ? 0.7 : 1;
  const ratio = height > 0 ? width / height : Infinity;
  const px = current === 'side' ? -SLACK_PX : current === 'stack' ? SLACK_PX : 0;
  const r = current === 'side' ? -SLACK_RATIO : current === 'stack' ? SLACK_RATIO : 0;
  return width >= minWidth + px && ratio >= minRatio + r ? 'side' : 'stack';
}
