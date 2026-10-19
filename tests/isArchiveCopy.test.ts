import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({ Platform: {}, Notice: class {}, TFile: class {}, FileSystemAdapter: class {}, normalizePath: (p: string) => p }));
const { isArchiveCopy } = await import('../src/library/uploader');

describe('isArchiveCopy', () => {
  it('knows a web archive copy by its name, whatever folder it is in', () => {
    expect(isArchiveCopy('raw/cloud/_archive/82/82bbe9f1a15628271b9da1d02a234d3c92e12737.mp4')).toBe(true);
    expect(isArchiveCopy('_archive/82/82bbe9f1a15628271b9da1d02a234d3c92e12737.mp4')).toBe(true);
  });

  it('takes recordings for recordings', () => {
    expect(isArchiveCopy('raw/media/南添/录制于 2026-10-18 18.55.33.mp4')).toBe(false);
    expect(isArchiveCopy('附件/Recording 20260902210306.m4a')).toBe(false);
    // a hash-like name not in its bucket folder
    expect(isArchiveCopy('clips/82bbe9f1a15628271b9da1d02a234d3c92e12737.mp4')).toBe(false);
  });
});
