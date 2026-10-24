import { Notice, setIcon } from 'obsidian';
import type MediaTranscriptPlugin from '../main';
import type { BackupRun, IndexEntry, Job, RemoteUpload } from './client';
import { backsUp, buildProgress, lastRuns, secondsOf, type Progress, type ProgressRow, type Section } from './progress';
import { describe, roughly } from './UploadStatus';
import { collectionFolder } from './transcriptSync';
import { formatTime } from '../utils/subtitleParser';
import { formatSize } from '../utils/format';
import { t } from '../i18n';

/** While something is under way, ask the server this often. */
const POLL_MS = 15_000;
/** Finished rows shown before "N more". */
const SHOWN_DONE = 15;

export interface ProgressHost {
  rerender(): void;
  /** Show this file in the media tab. */
  find(name: string): void;
}

const SECTIONS: Section[] = ['running', 'queued', 'failed', 'backup', 'done'];

/**
 * The progress tab: every file on its way, from whichever device sent it to
 * the transcript in the vault and the nightly backup, each step with when it
 * began, how long it took and when it ended; and how the nightly backup went.
 */
export class ProgressList {
  private index: IndexEntry[] = [];
  private jobs: Job[] = [];
  private uploads: RemoteUpload[] = [];
  private runs: BackupRun[] = [];
  private error: string | null = null;
  loaded = false;
  private filter: Section | null = null;
  private allDone = false;
  /** Per job: how far the worker last said it was, and when that changed (seconds). */
  private said = new Map<number, { sec: number; at: number }>();
  private progress: Progress = { rows: [], counts: { running: 0, queued: 0, backup: 0, failed: 0, done: 0 } };

  constructor(private plugin: MediaTranscriptPlugin, private host: ProgressHost) {}

  async refresh(): Promise<void> {
    const { library } = this.plugin;
    if (!library.configured) {
      this.error = t('library.notConfigured');
      return;
    }
    try {
      const [index, jobs, uploads, runs] = await Promise.all([
        library.index(),
        library.jobs(),
        library.uploads().catch(() => [] as RemoteUpload[]),     // a server before 0.9
        library.backupRuns().catch(() => [] as BackupRun[]),
      ]);
      this.index = index;
      this.jobs = jobs.jobs;
      this.uploads = uploads;
      this.runs = runs;
      this.plugin.transcriptSync.remember(jobs.jobs);
      this.error = null;
      this.loaded = true;
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  /** Under way on the server: worth asking again soon. */
  get moving(): boolean {
    return this.progress.counts.running > 0 || this.progress.rows.some(r => r.section === 'queued');
  }

  /** Jobs as sync last saw them, newer than what refresh fetched. */
  takeJobs(known: readonly Job[]): void {
    const byId = new Map(this.jobs.map(j => [j.id, j]));
    for (const j of known) byId.set(j.id, j);
    this.jobs = [...byId.values()];
  }

  /** Note when each job's progress moved, for an estimate that counts down between the worker's words. */
  private notice(): void {
    const now = Date.now() / 1000;
    for (const j of this.jobs) {
      const sec = j.progress?.sec;
      if (j.state !== 'claimed' || sec === undefined) continue;
      const had = this.said.get(j.id);
      if (!had || had.sec !== sec) this.said.set(j.id, { sec, at: had ? now : (j.heartbeat ?? now) });
    }
  }

  private build(): void {
    const { plugin } = this;
    this.notice();
    this.progress = buildProgress({
      own: plugin.library.folder,
      index: this.index,
      jobs: this.jobs,
      uploads: this.uploads,
      upload: plugin.uploader.status,
      pending: plugin.uploader.pending,
      queuedAt: path => {
        const f = plugin.app.vault.getFileByPath(path);
        return f ? f.stat.ctime / 1000 : undefined;
      },
      progressAt: job => job.progress?.at ?? this.said.get(job.id)?.at,
      now: Date.now() / 1000,
      hasTranscript: name => plugin.transcripts.transcriptsFor(name).length > 0,
      keepsCollection: c => collectionFolder(plugin.app.vault.getAllFolders(), c) !== null,
    });
  }

  render(list: HTMLElement, status: HTMLElement): void {
    this.build();
    if (this.error) status.createDiv({ cls: 'mo-lib-error', text: this.error });
    if (!this.loaded) {
      if (!this.error) status.setText(t('library.loading'));
      return;
    }
    const root = list.createDiv('mo-prog');
    if (backsUp(this.index, this.plugin.library.folder)) this.renderBackup(root);
    this.renderSummary(root);
    const { rows } = this.progress;
    let any = false;
    for (const section of SECTIONS) {
      if (this.filter && this.filter !== section) continue;
      let items = rows.filter(r => r.section === section);
      if (!items.length) continue;
      any = true;
      const box = root.createDiv(`mo-prog-section is-${section}`);
      box.createDiv({ cls: 'mo-prog-heading', text: `${t(`library.progress.${section}`)} · ${items.length}` });
      const more = section === 'done' && !this.allDone && items.length > SHOWN_DONE ? items.length - SHOWN_DONE : 0;
      if (more) items = items.slice(0, SHOWN_DONE);
      for (const r of items) this.renderRow(box, r);
      if (more || (section === 'done' && this.allDone && items.length > SHOWN_DONE)) {
        const b = box.createEl('button', { cls: 'mo-act-more', text: more ? t('library.activityMore', { count: more }) : t('library.activityLess') });
        b.addEventListener('click', () => { this.allDone = !this.allDone; this.host.rerender(); });
      }
    }
    if (!any) root.createDiv({ cls: 'mo-prog-empty', text: t('library.progress.empty') });
  }

  private renderBackup(root: HTMLElement): void {
    const { last, lastOk } = lastRuns(this.runs);
    const line = root.createDiv('mo-prog-backup');
    setIcon(line.createSpan('mo-prog-backup-icon'), 'hard-drive');
    const text = line.createDiv('mo-prog-backup-text');
    if (!last) {
      text.createSpan({ text: t('library.progress.backupNone') });
      return;
    }
    const when = secondsOf(last.started);
    const took = when !== undefined && last.finished ? (secondsOf(last.finished) ?? when) - when : null;
    if (last.ok) {
      line.addClass('is-ok');
      text.createSpan({ text: t('library.progress.backupOk', { when: when ? clock(when) : last.started, took: took !== null ? roughly(took) : '—' }) });
    } else {
      line.addClass('is-error');
      text.createSpan({ text: t('library.progress.backupFailed', { when: when ? clock(when) : last.started }) });
      const why = [...(last.failed ?? []), ...(last.problems ?? [])].join(' · ');
      if (why) text.createDiv({ cls: 'mo-prog-backup-why', text: why, attr: { title: why } });
      const okAt = lastOk ? secondsOf(lastOk.started) : undefined;
      text.createDiv({ cls: 'mo-prog-backup-why', text: okAt ? t('library.progress.backupLastOk', { when: clock(okAt) }) : t('library.progress.backupNeverOk') });
    }
  }

  private renderSummary(root: HTMLElement): void {
    const bar = root.createDiv('mo-prog-summary');
    const chip = (section: Section | null, label: string, count?: number) => {
      const b = bar.createEl('button', { cls: 'mo-prog-chip', text: count === undefined ? label : `${label} ${count}` });
      if (section) b.addClass(`is-${section}`);
      b.toggleClass('is-active', this.filter === section);
      if (count === 0) b.addClass('is-zero');
      b.addEventListener('click', () => { this.filter = section; this.host.rerender(); });
    };
    chip(null, t('library.collectionAll'));
    for (const s of SECTIONS) chip(s, t(`library.progress.${s}Short`), this.progress.counts[s]);
  }

  private renderRow(box: HTMLElement, r: ProgressRow): void {
    const now = Date.now() / 1000;
    const row = box.createDiv(`mo-prog-row is-${r.section}`);
    const head = row.createDiv('mo-prog-head');
    const name = head.createDiv({ cls: 'mo-prog-name', text: r.name, attr: { title: r.name } });
    if (r.vaultPath) name.addEventListener('click', () => this.host.find(r.name));
    head.createDiv({ cls: 'mo-prog-total', text: this.total(r, now) });

    const fraction = this.fraction(r);
    if (fraction !== null) {
      const track = row.createDiv('mo-act-track');
      track.createDiv('mo-act-fill');
      row.style.setProperty('--mo-act', String(fraction));
    }

    const steps = row.createDiv('mo-prog-steps');
    const step = (icon: string, state: string, text: string, title?: string) => {
      const s = steps.createSpan(`mo-act-step is-${state}`);
      setIcon(s.createSpan('mo-act-step-icon'), state === 'done' ? 'check' : state === 'failed' ? 'x' : icon);
      s.createSpan({ text });
      if (title) s.setAttr('title', title);
    };
    const u = r.upload;
    if (u) {
      const device = u.device ? ` · ${u.device}` : '';
      if (u.state === 'done') {
        const took = u.began !== undefined && u.ended !== undefined ? t('library.progress.took', { took: roughly(u.ended - u.began) }) : '';
        step('upload', 'done', `${t('library.progress.uploadedAt', { when: u.ended !== undefined ? clock(u.ended) : '' })}${took}${device}`);
      } else if (u.state === 'active') {
        const pct = u.size ? Math.floor(((u.sent ?? 0) / u.size) * 100) : 0;
        step('upload', 'active', `${t('library.progress.uploading', { pct })}${device}`);
      } else if (u.state === 'paused') {
        const pct = u.size ? Math.floor(((u.sent ?? 0) / u.size) * 100) : 0;
        step('upload', 'waiting', `${t('library.progress.uploadPaused', { pct })}${device}`);
      } else {
        step('upload', 'waiting', u.place && u.place > 1 ? t('library.stepUploadQueued', { place: u.place }) : t('library.stepUploadNext'));
      }
    }
    const tr = r.transcribe;
    if (tr.state === 'done' && tr.ended !== undefined) {
      const wait = tr.queued !== undefined && tr.began !== undefined && tr.began - tr.queued >= 60 ? t('library.progress.waited', { took: roughly(tr.began - tr.queued) }) : '';
      const took = tr.began !== undefined ? t('library.progress.took', { took: roughly(tr.ended - tr.began) }) : '';
      step('audio-lines', 'done', `${t('library.progress.transcribedAt', { when: clock(tr.ended) })}${wait}${took}`);
    } else if (tr.state === 'done') {
      step('audio-lines', 'done', t('library.stepTranscribed'));
    } else if (tr.state === 'active') {
      const at = tr.total && tr.done !== undefined ? t('library.stepTranscribingAt', { done: formatTime(tr.done), total: formatTime(tr.total) }) : t('library.stepTranscribing');
      step('audio-lines', 'active', at);
    } else if (tr.state === 'queued') {
      const waited = tr.queued !== undefined ? t('library.progress.waiting', { took: roughly(now - tr.queued) }) : '';
      step('audio-lines', 'waiting', `${t('library.stepQueued', { place: tr.place ?? 1 })}${waited}`);
    } else if (tr.state === 'failed') {
      step('audio-lines', 'failed', t('library.stepFailed'), tr.error ?? undefined);
    } else if (u?.state === 'done') {
      step('audio-lines', 'waiting', t('library.progress.notTranscribed'));
    } else {
      step('audio-lines', 'waiting', t('library.stepTranscribe'));
    }
    if (r.inVault !== null) step('file-text', r.inVault ? 'done' : 'waiting', r.inVault ? t('library.stepInVault') : t('library.stepToVault'));
    if (r.backup) {
      if (r.backup.at !== undefined) step('hard-drive', 'done', t('library.progress.backedUpAt', { when: clock(r.backup.at) }));
      else step('hard-drive', 'waiting', t('library.stepBackup'));
    }

    const detail = this.detail(r, now);
    if (detail) row.createDiv({ cls: r.section === 'failed' ? 'mo-act-detail is-error' : 'mo-act-detail', text: detail, attr: { title: detail } });
    if (r.section === 'failed' && r.vaultPath) {
      const retry = row.createEl('button', { cls: 'mo-prog-retry', text: t('library.retry') });
      retry.addEventListener('click', () => { void this.retry(r); });
    }
  }

  /** The right side of the row: how long it all took, or has taken so far. */
  private total(r: ProgressRow, now: number): string {
    if (r.section === 'done' && r.ended !== null) {
      return t('library.progress.doneIn', { took: roughly(r.ended - r.started), when: clock(r.ended) });
    }
    if (r.section === 'backup') {
      const since = r.upload?.ended ?? r.started;
      return t('library.progress.waitingFor', { took: roughly(now - since) });
    }
    if (r.section === 'failed') return r.transcribe.ended !== undefined ? clock(r.transcribe.ended) : '';
    if (r.upload?.state === 'paused' && r.upload.moved !== undefined) return t('library.progress.pausedSince', { when: clock(r.upload.moved) });
    return t('library.progress.goingFor', { took: roughly(now - r.started) });
  }

  private fraction(r: ProgressRow): number | null {
    const u = r.upload;
    if (u && (u.state === 'active' || u.state === 'paused') && u.size) return Math.min(1, (u.sent ?? 0) / u.size);
    const tr = r.transcribe;
    if (tr.state === 'active' && tr.total && tr.done !== undefined) return Math.min(1, tr.done / tr.total);
    return null;
  }

  private detail(r: ProgressRow, now: number): string | null {
    const u = r.upload;
    if (u?.live) return describe(u.live).detail;
    if (u && (u.state === 'active' || u.state === 'paused') && u.size) {
      return `${formatSize(u.sent ?? 0)} / ${formatSize(u.size)}`;
    }
    const tr = r.transcribe;
    if (tr.state === 'active' && tr.left) {
      return `${t('library.stepLeft', { left: roughly(tr.left) })} · ${t('library.progress.eta', { when: clock(now + tr.left) })}`;
    }
    if (tr.state === 'failed') return tr.error ?? null;
    return null;
  }

  private async retry(r: ProgressRow): Promise<void> {
    if (!r.vaultPath) return;
    try {
      await this.plugin.library.transcribe(r.vaultPath, true);
      await this.refresh();
      this.host.rerender();
    } catch (e) {
      new Notice((e as Error).message);
    }
  }

  /** Keep the tab moving while it shows: ask the server again while something is under way. */
  poll(): number {
    return window.setInterval(() => {
      if (!this.moving) return;
      void this.refresh().then(() => this.host.rerender());
    }, POLL_MS);
  }
}

/** A moment, as short as it reads: today's time, yesterday's, or the date. */
export function clock(seconds: number, now = Date.now()): string {
  const d = new Date(seconds * 1000);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date(now);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(today) - day(d)) / 86_400_000);
  if (days === 0) return hm;
  if (days === 1) return t('library.progress.yesterday', { time: hm });
  if (days === -1) return t('library.progress.tomorrow', { time: hm });
  return t('library.progress.onDay', { month: d.getMonth() + 1, day: d.getDate(), time: hm });
}
