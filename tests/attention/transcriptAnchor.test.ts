import { describe, it, expect } from 'vitest';
import {
  resolveTranscript,
  describeTranscript,
  Seg,
  TIME_TOLERANCE_S,
  nearestRun,
} from '../../src/modules/attention/anchor/transcriptAnchor';
import { TranscriptAnchor } from '../../src/modules/attention/model';

// Track A: as one engine segmented it.
const TRACK_A = 'lecture.whisper.json';
const segsA: Seg[] = [
  { seg: 1, start: 0.0, text: '所以这里的反向传播并不需要额外的显存' },
  { seg: 2, start: 5.2, text: '用计算换显存就是这个思路' },
  { seg: 3, start: 11.8, text: '反向传播是关键' },
];

// Track B: another engine — different boundaries, and it misheard a word.
const TRACK_B = 'lecture.vibevoice.json';
const segsB: Seg[] = [
  { seg: 1, start: 0.4, text: '所以这里的反向传播并不需要额外的显存，用计算换显存' },
  { seg: 2, start: 11.5, text: '就是这个思路，反向传播是关键' },
];

function anchorOn(segs: Seg[], seg: number, from: number, to: number, track: string): TranscriptAnchor {
  return describeTranscript(segs.find(s => s.seg === seg)!, from, to, track);
}

describe('describeTranscript', () => {
  it('captures quote, context and the timeline position', () => {
    const a = anchorOn(segsA, 1, 5, 9, TRACK_A);
    expect(a.quote).toBe('反向传播');
    expect(a.prefix).toBe('所以这里的');
    expect(a.suffix).toBe('并不需要额外的显存');
    expect(a.start).toBe(0);
    expect(a.track).toBe(TRACK_A);
  });
});

describe('resolveTranscript on the track it was made against', () => {
  it('hits the stored offsets directly', () => {
    const a = anchorOn(segsA, 1, 5, 9, TRACK_A);
    expect(resolveTranscript(segsA, a, TRACK_A)).toEqual({
      seg: 1, charStart: 5, charEnd: 9, how: 'exact',
    });
  });

  it('follows the quote when the line was re-generated slightly differently', () => {
    const a = anchorOn(segsA, 1, 5, 9, TRACK_A);
    const edited: Seg[] = [{ seg: 1, start: 0, text: '嗯，所以这里的反向传播并不需要额外的显存' }];
    const hit = resolveTranscript(edited, a, TRACK_A)!;
    expect(hit.how).toBe('drifted');
    expect(edited[0].text.slice(hit.charStart, hit.charEnd)).toBe('反向传播');
  });
});

describe('resolveTranscript across tracks', () => {
  // The point of anchoring to the media rather than the track: swap ASR engines
  // and the marks should still land.
  it('finds the passage in a differently-segmented track', () => {
    const a = anchorOn(segsA, 1, 5, 9, TRACK_A); // 反向传播 at t=0
    const hit = resolveTranscript(segsB, a, TRACK_B)!;
    expect(hit.how).toBe('retimed');
    expect(hit.seg).toBe(1);
    expect(segsB[0].text.slice(hit.charStart, hit.charEnd)).toBe('反向传播');
  });

  it('uses the timestamp to pick between repeated phrases', () => {
    // 反向传播 appears in both of track B's segments; the anchor is at t=11.8,
    // so it must land in the second, not the first.
    const a = anchorOn(segsA, 3, 0, 4, TRACK_A);
    expect(a.start).toBe(11.8);
    const hit = resolveTranscript(segsB, a, TRACK_B)!;
    expect(hit.seg).toBe(2);
    expect(segsB[1].text.slice(hit.charStart, hit.charEnd)).toBe('反向传播');
  });

  it('ignores a match too far from the remembered time', () => {
    const a = anchorOn(segsA, 1, 5, 9, TRACK_A); // t=0
    const far: Seg[] = [{ seg: 1, start: 600, text: '反向传播是关键' }];
    // Sole match in the track, so it is accepted — but as 'unique', not 'retimed'.
    expect(resolveTranscript(far, a, TRACK_B)!.how).toBe('unique');
  });

  it('refuses to guess between several distant matches', () => {
    const a = anchorOn(segsA, 1, 5, 9, TRACK_A);
    const far: Seg[] = [
      { seg: 1, start: 600, text: '反向传播是关键' },
      { seg: 2, start: 900, text: '再说一次反向传播' },
    ];
    expect(resolveTranscript(far, a, TRACK_B)).toBeNull();
  });

  it('returns null when the passage is gone entirely', () => {
    const a = anchorOn(segsA, 1, 5, 9, TRACK_A);
    expect(resolveTranscript([{ seg: 1, start: 0, text: '完全不同的内容' }], a, TRACK_B)).toBeNull();
  });

  it('searches a window on both sides of the timestamp', () => {
    const a = anchorOn(segsA, 2, 0, 2, TRACK_A); // 用计算, t=5.2
    const shifted: Seg[] = [
      { seg: 1, start: 5.2 - TIME_TOLERANCE_S + 0.1, text: '用计算换显存' },
    ];
    expect(resolveTranscript(shifted, a, TRACK_B)!.how).toBe('retimed');
  });
});

describe('resolveTranscript after the marked words were corrected', () => {
  const line: Seg[] = [{ seg: 7, start: 42, text: '我们今天来聊一聊反响传播算法的基本原理和实现' }];
  const mark = describeTranscript(line[0], 8, 14, TRACK_A); // 反响传播算法

  it('follows a typo fixed inside the mark', () => {
    const fixed: Seg[] = [{ seg: 7, start: 42, text: '我们今天来聊一聊反向传播算法的基本原理和实现' }];
    const hit = resolveTranscript(fixed, mark, TRACK_A)!;
    expect(hit.how).toBe('fuzzy');
    expect(fixed[0].text.slice(hit.charStart, hit.charEnd)).toBe('反向传播算法');
  });

  it('follows words added inside the mark, on a re-cut line', () => {
    const fixed: Seg[] = [
      { seg: 3, start: 30, text: '前面一句' },
      { seg: 4, start: 43, text: '今天来聊一聊反向传播这个算法的基本原理' },
    ];
    const hit = resolveTranscript(fixed, mark, TRACK_A)!;
    expect(hit.how).toBe('fuzzy');
    expect(hit.seg).toBe(4);
    expect(fixed[1].text.slice(hit.charStart, hit.charEnd)).toBe('反向传播这个算法');
  });

  it('takes what replaced a rewritten mark when the words around it are intact', () => {
    const fixed: Seg[] = [{ seg: 7, start: 42, text: '我们今天来聊一聊BP神经网络训练的基本原理和实现' }];
    const hit = resolveTranscript(fixed, mark, TRACK_A)!;
    expect(hit.how).toBe('fuzzy');
    expect(fixed[0].text.slice(hit.charStart, hit.charEnd)).toBe('BP神经网络训练');
  });

  it('stays where it was when the line says the same thing again further on', () => {
    const twice: Seg[] = [{ seg: 7, start: 42, text: '今天天气很好，适合测试。大家好，今天天气很好，适合测试。' }];
    const m = describeTranscript(twice[0], 0, 6, TRACK_A); // the first 今天天气很好
    const fixed: Seg[] = [{ seg: 7, start: 42, text: '今天天气真不错，适合测试。大家好，今天天气很好，适合测试。' }];
    const hit = resolveTranscript(fixed, m, TRACK_A)!;
    expect(hit.how).toBe('fuzzy');
    expect([hit.charStart, fixed[0].text.slice(hit.charStart, hit.charEnd)]).toEqual([0, '今天天气真不错']);
  });

  it('takes the rewording at the old place over the same words left elsewhere in the line', () => {
    const said = '转录、写入稿子和备份的每一步都能看到。大家好，转录、写入稿子和备份的每一步都能看到。';
    const m = describeTranscript({ seg: 7, start: 42, text: said }, 3, 10, TRACK_A); // the first 写入稿子和备份
    const now = said.replace('写入稿子和备份', '写进稿子以及备份');
    const hit = resolveTranscript([{ seg: 7, start: 42, text: now }], m, TRACK_A)!;
    expect([hit.charStart, now.slice(hit.charStart, hit.charEnd)]).toEqual([3, '写进稿子以及备份']);
  });

  it('gives up when both the mark and its surroundings are gone', () => {
    const fixed: Seg[] = [{ seg: 7, start: 42, text: '这一段完全换成了别的内容没有关系' }];
    expect(resolveTranscript(fixed, mark, TRACK_A)).toBeNull();
  });

  it('does not look for resemblance far from the timestamp', () => {
    const far: Seg[] = [{ seg: 7, start: 400, text: '我们今天来聊一聊反向传播算法的基本原理和实现' }];
    expect(resolveTranscript(far, mark, TRACK_B)).toBeNull();
  });

  it('does not guess at short marks', () => {
    const short = describeTranscript(line[0], 8, 10, TRACK_A); // 反响
    const fixed: Seg[] = [{ seg: 7, start: 42, text: '完全不同的东西反向' }];
    expect(resolveTranscript(fixed, short, TRACK_A)).toBeNull();
  });
});

describe('nearestRun', () => {
  it('finds an exact run with no edits', () => {
    expect(nearestRun('abcdefg', 'cde')).toEqual({ from: 2, to: 5, edits: 0 });
  });
  it('counts a substitution', () => {
    expect(nearestRun('the quick brown fox', 'quack')).toMatchObject({ from: 4, to: 9, edits: 1 });
  });
});
