import { describe, expect, it } from 'vitest';
import { after, moved, placed, type QueueEntry } from '../src/library/playlist';

const e = (path: string): QueueEntry => ({ path, key: path, size: 0, title: path, subtitle: '', transcript: null });
const paths = (l: QueueEntry[]) => l.map(x => x.path);

describe('placed', () => {
  const list = [e('a'), e('b'), e('c')];
  it('puts it first, last, or after what plays', () => {
    expect(paths(placed(list, e('x'), 'top', null))).toEqual(['x', 'a', 'b', 'c']);
    expect(paths(placed(list, e('x'), 'end', null))).toEqual(['a', 'b', 'c', 'x']);
    expect(paths(placed(list, e('x'), 'next', 'b'))).toEqual(['a', 'b', 'x', 'c']);
  });
  it('moves it when it is there already', () => {
    expect(paths(placed(list, e('c'), 'top', null))).toEqual(['c', 'a', 'b']);
    expect(paths(placed(list, e('a'), 'next', 'b'))).toEqual(['b', 'a', 'c']);
  });
  it('next with nothing playing (or not in the list) is first', () => {
    expect(paths(placed(list, e('x'), 'next', null))).toEqual(['x', 'a', 'b', 'c']);
    expect(paths(placed(list, e('x'), 'next', 'zz'))).toEqual(['x', 'a', 'b', 'c']);
  });
});

describe('moved', () => {
  it('moves an entry up or down', () => {
    expect(moved(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moved(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moved(['a', 'b'], 1, 9)).toEqual(['a', 'b']);
  });
});

describe('after', () => {
  it('is the next entry, or nothing at the end', () => {
    const list = [e('a'), e('b')];
    expect(after(list, 'a')?.path).toBe('b');
    expect(after(list, 'b')).toBeNull();
    expect(after(list, null)?.path).toBe('a');
  });
});
