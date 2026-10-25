import { describe, expect, it } from 'vitest';
import { pickArrangement } from '../src/ui/videoLayout';

const WIDE = 16 / 9;

describe('pickArrangement', () => {
  it('beside on a wide pane, above on a narrow or tall one', () => {
    expect(pickArrangement(1400, 900, WIDE)).toBe('side');
    expect(pickArrangement(600, 900, WIDE)).toBe('stack');
    expect(pickArrangement(900, 1200, WIDE)).toBe('stack');  // wide enough, but taller than wide
    expect(pickArrangement(800, 770, WIDE)).toBe('side');
  });

  it('a portrait video fits beside in less', () => {
    expect(pickArrangement(620, 800, 9 / 16)).toBe('side');
    expect(pickArrangement(620, 900, WIDE)).toBe('stack');
  });

  it('holds its choice near the edge, so a pane being dragged does not flicker', () => {
    expect(pickArrangement(700, 500, WIDE, 'side')).toBe('side');
    expect(pickArrangement(740, 500, WIDE, 'stack')).toBe('stack');
    expect(pickArrangement(770, 500, WIDE, 'stack')).toBe('side');
    expect(pickArrangement(670, 500, WIDE, 'side')).toBe('stack');
    expect(pickArrangement(1000, 1050, WIDE, 'side')).toBe('side');
    expect(pickArrangement(1000, 1050, WIDE, 'stack')).toBe('stack');
  });

  it('an unknown height or aspect does not keep it from choosing', () => {
    expect(pickArrangement(1000, 0, 0)).toBe('side');
  });
});
