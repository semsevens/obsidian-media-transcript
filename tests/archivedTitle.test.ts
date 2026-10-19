import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({ Platform: {}, TFile: class {}, normalizePath: (p: string) => p }));
const { archivedTitle } = await import('../src/library/transcriptSync');

const hash = '97452e24f46a8b8aa6f7de9f327af55cd1f68b51';

describe('archivedTitle', () => {
  it('is the note title and the first six of the hash', () => {
    expect(archivedTitle('mo-video-test', hash)).toBe('mo-video-test · 97452e');
  });

  it('drops what a file name may not hold, and keeps it short', () => {
    expect(archivedTitle('a/b: "c"? #d [e]', hash)).toBe('a b c d e · 97452e');
    expect(archivedTitle('x'.repeat(200), hash)).toBe(`${'x'.repeat(80)} · 97452e`);
  });

  it('falls back to the hash without a title', () => {
    expect(archivedTitle('', hash)).toBe('97452e24f46a');
    expect(archivedTitle(undefined, hash)).toBe('97452e24f46a');
  });
});

const { collectionFolder } = await import('../src/library/transcriptSync');

describe('collectionFolder', () => {
  const folder = (path: string, names: string[]) => ({ name: path.split('/').pop()!, path, children: names.map(name => ({ name })) });

  it('is the folder named after the collection that holds its transcripts', () => {
    const folders = [
      folder('工作', ['plan.md']),
      folder('raw/media/工作', ['a.vibevoice-4bit.json', 'a.vibevoice-4bit.txt', 'b.vibevoice-4bit.json']),
      folder('raw/media/南添', ['c.vibevoice-4bit.json']),
    ];
    expect(collectionFolder(folders, '工作')).toBe('raw/media/工作');
  });

  it('is none when no such folder holds a transcript', () => {
    expect(collectionFolder([folder('播客', ['x.m4a.anno.json', 'notes.md'])], '播客')).toBeNull();
    expect(collectionFolder([], '播客')).toBeNull();
  });
});
