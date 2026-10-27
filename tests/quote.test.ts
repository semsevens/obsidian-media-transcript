import { describe, it, expect } from 'vitest';
import { joinParts, quoteBlock, quoteLabel, quoteOutdated, textBetween, updatedQuote } from '../src/utils/quote';

describe('quoteBlock', () => {
  it('writes a quote callout titled by its link', () => {
    expect(quoteBlock('[[a.json#t=1,5|a · 0:01–0:05]]', '第一句\n第二句\n')).toBe(
      '> [!quote] [[a.json#t=1,5|a · 0:01–0:05]]\n> 第一句\n> 第二句');
  });
  it('labels the passage with its time', () => {
    expect(quoteLabel('talk', 83, 97)).toBe('talk · 1:23–1:37');
  });
});

describe('joinParts', () => {
  it('runs Chinese on and spaces other languages', () => {
    expect(joinParts(['你好。', '再见。'])).toBe('你好。再见。');
    expect(joinParts(['Hello there.', 'Bye.'])).toBe('Hello there. Bye.');
    expect(joinParts(['我说 hello', 'world'])).toBe('我说 hello world');
  });
});

describe('textBetween', () => {
  const segs = [
    { startTime: 0, endTime: 5, text: '第一句。' },
    { startTime: 5, endTime: 10.4, text: '第二句。' },
    { startTime: 10.4, endTime: 15, text: '第三句。' },
  ];
  it('takes the lines in the passage, not the ones its whole seconds touch', () => {
    expect(textBetween(segs, 5, 11)).toBe('第二句。');
    expect(textBetween(segs, 0, 15)).toBe('第一句。第二句。第三句。');
    expect(textBetween([{ startTime: 10.4, endTime: 10.9, text: '短。' }], 10, 11)).toBe('短。');
  });
});

describe('quoteOutdated', () => {
  const source = '我们今天来聊一聊反向传播算法的基本原理和实现。';
  it('passes a quote of part of the passage, whatever its punctuation', () => {
    expect(quoteOutdated('反向传播算法的基本原理', source)).toBe(false);
    expect(quoteOutdated('我们今天来聊一聊 反向传播算法', source)).toBe(false);
  });
  it('flags a single word corrected in the transcript', () => {
    expect(quoteOutdated('我们今天来聊一聊反响传播算法的基本原理', source)).toBe(true);
  });
  it('flags a quote the transcript no longer says', () => {
    expect(quoteOutdated('我们今天来聊一聊BP神经网络', source)).toBe(true);
  });
});

describe('updatedQuote', () => {
  it('offers the corrected stretch the quote covered', () => {
    const now = '开场白。我们今天来聊一聊反向传播算法的基本原理。然后结束。';
    expect(updatedQuote('我们今天来聊一聊反响传播的基本原理', now)).toBe('我们今天来聊一聊反向传播算法的基本原理');
  });
  it('offers the whole passage when nothing is close', () => {
    expect(updatedQuote('完全无关的话', '全新的内容。')).toBe('全新的内容。');
  });
});
