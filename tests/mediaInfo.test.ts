import { describe, expect, it } from 'vitest';
import { durationIn, formatDuration, isDatedName, isGenericName, isTranscriptNamedFor, openingWords, recordedAt, withoutDate } from '../src/library/mediaInfo';

describe('recordedAt', () => {
  it('reads the moment a recorder put in the name', () => {
    expect(recordedAt('Recording 20260902210306.m4a')).toEqual(new Date(2026, 8, 2, 21, 3, 6));
    expect(recordedAt('录制于 2026-08-27 11.05.55.m4a')).toEqual(new Date(2026, 7, 27, 11, 5, 55));
    expect(recordedAt('Pasted Image 20261009164946_322.png')).toEqual(new Date(2026, 9, 9, 16, 49, 46));
    expect(recordedAt('2026-09-07 会议.m4a')).toEqual(new Date(2026, 8, 7));
    expect(recordedAt('高买低卖也赚钱！2016-1-10 PM4 24.m4a')).toEqual(new Date(2016, 0, 10));
    // Only the month, or the year, known: its first day.
    expect(recordedAt('2025-07 王斌 - 早盘：攀升.m4a')).toEqual(new Date(2025, 6, 1));
    expect(recordedAt('2023 王斌 - 录音.m4a')).toEqual(new Date(2023, 0, 1));
    expect(recordedAt('2025 年终总结.m4a')).toBeNull();
  });

  it('is null when the name says nothing, or something impossible', () => {
    expect(recordedAt('【0102早盘消息】王斌：2023年大吉大利！.m4a')).toBeNull();
    expect(recordedAt('Recording 20261399250000.m4a')).toBeNull();
    expect(recordedAt('Recording 20260231120000.m4a')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('shows hours only when there are some', () => {
    expect(formatDuration(245)).toBe('4:05');
    expect(formatDuration(4363.16)).toBe('1:12:43');
    expect(formatDuration(0)).toBe('0:00');
  });
});

describe('durationIn', () => {
  it('reads the length a transcript records', () => {
    expect(durationIn('{\n  "source": "a.m4a",\n  "duration": 4363.16,\n  "segments": []}')).toBe(4363.16);
    expect(durationIn('{"segments": []}')).toBeNull();
  });
});

describe('isTranscriptNamedFor', () => {
  it('matches <name>.<model>.json, not annotations or other files', () => {
    expect(isTranscriptNamedFor('Recording 1.vibevoice-4bit.json', 'Recording 1.m4a')).toBe(true);
    expect(isTranscriptNamedFor('Recording 1.m4a.anno.json', 'Recording 1.m4a')).toBe(false);
    expect(isTranscriptNamedFor('Recording 10.vibevoice-4bit.json', 'Recording 1.m4a')).toBe(false);
    expect(isTranscriptNamedFor('Recording 1.vibevoice-4bit.txt', 'Recording 1.m4a')).toBe(false);
  });
});

describe('openingWords', () => {
  it('takes the first speech, skipping silence and music', () => {
    const json = JSON.stringify({ duration: 10, segments: [
      { start: 0, text: '[Silence]' }, { start: 2, text: '好，子涵聊完了。' }, { start: 5, text: '对，怎么样？' }, { start: 8, text: '（音乐）' },
    ] });
    expect(openingWords(json)).toBe('好，子涵聊完了。对，怎么样？');
    expect(openingWords(json, 6)).toBe('好，子涵聊完…');
    expect(openingWords('{"segments": []}')).toBe('');
  });
});

describe('isDatedName', () => {
  it('knows a daily note', () => {
    expect(isDatedName('2026-10-16')).toBe(true);
    expect(isDatedName('2026-09-07 语言即世界 - 和曾鸣聊产业史观')).toBe(false);
    expect(isDatedName('周会')).toBe(false);
  });
});

describe('isGenericName', () => {
  it('tells a name a device gave from one someone chose', () => {
    expect(isGenericName('Recording 20260902210306.m4a')).toBe(true);
    expect(isGenericName('录制于 2026-08-27 11.05.55.m4a')).toBe(true);
    expect(isGenericName('Pasted Image 20261009164946_322.png')).toBe(true);
    expect(isGenericName('高买低卖也赚钱！2016-1-10 PM4 24.m4a')).toBe(false);
    expect(isGenericName('周会.m4a')).toBe(false);
    expect(isGenericName('Recording at 2026-09-13 18.58.30.mp4')).toBe(true);
    expect(isGenericName('周会 2026-09-13.m4a')).toBe(false);
  });
});

describe('withoutDate', () => {
  it('drops the date and time a name carries', () => {
    expect(withoutDate('首秀滴水不漏！2016-03-12 23 12')).toBe('首秀滴水不漏！');
    expect(withoutDate('猴年开盘前消息面综合分析。 2016-2-14 AM11 33')).toBe('猴年开盘前消息面综合分析。');
    expect(withoutDate('初五迎财神！王斌 2016-2-12 PM8 22')).toBe('初五迎财神！王斌');
    expect(withoutDate('周会')).toBe('周会');
    expect(withoutDate('Recording 20260902210306')).toBe('Recording');
    expect(withoutDate('2026-09-02')).toBe('2026-09-02');
  });
});
