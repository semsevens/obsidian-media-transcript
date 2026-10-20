import { beforeAll, describe as group, expect, it } from 'vitest';
import { describe, roughly } from '../src/library/UploadStatus';
import type { UploadStatus } from '../src/library/uploader';
import { setLanguage } from '../src/i18n';

beforeAll(() => setLanguage('zh'));

const MB = 1e6;
const now = 1_000_000;
const base: UploadStatus = { name: 'Recording.m4a', size: 97 * MB, sent: 75 * MB, rate: 80e3, moved: now - 5000, state: 'sending', queued: 0 };

group('describe', () => {
  it('while sending: how far, how fast, how long left', () => {
    expect(describe(base, now)).toEqual({ short: '77%', detail: '75.0 MB / 97.0 MB · 80 KB/s · 约剩 5 分钟' });
  });

  it('no speed or time left once nothing has gone in for a while', () => {
    expect(describe({ ...base, moved: now - 60_000 }, now).detail).toBe('75.0 MB / 97.0 MB · 网络很慢，正在等服务器响应');
  });

  it('waiting to try again, counting down', () => {
    expect(describe({ ...base, state: 'waiting', rate: 0, retryAt: now + 30_000 }, now)).toEqual({ short: '77% 暂停', detail: '75.0 MB / 97.0 MB · 网络断了，30 秒后重试' });
  });

  it('checking, and what waits behind it', () => {
    expect(describe({ ...base, sent: base.size, state: 'checking', queued: 2 }, now)).toEqual({ short: '校验中', detail: '已传完，服务器正在校验 · 还有 2 个排队' });
  });

  it('never says 100% before the server has it', () => {
    expect(describe({ ...base, sent: base.size - 1 }, now).short).toBe('99%');
  });
});

group('roughly', () => {
  it('seconds, minutes, hours', () => {
    expect(roughly(40)).toBe('40 秒');
    expect(roughly(170)).toBe('3 分钟');
    expect(roughly(3900)).toBe('1 小时 5 分钟');
  });
});
