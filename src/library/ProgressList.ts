import { Notice, setIcon } from 'obsidian';
import type MediaTranscriptPlugin from '../main';
import type { BackupRun, IndexEntry, Job, RemoteUpload, ServerStatus } from './client';
import {
  backsUp, buildProgress, dayOf, lastRuns, phasesOf, secondsOf, turnaround, workerState,
  type Phase, type Progress, type ProgressRow, type Section,
} from './progress';
import { describe } from './UploadStatus';
import { collectionFolder } from './transcriptSync';
import { formatSize } from '../utils/format';
import { t } from '../i18n';

/** While something is under way, ask the server this often. */
const POLL_MS = 15_000;
/** Finished rows shown before "N more". */
const SHOWN_DONE = 15;
/** A wait shorter than this isn't worth a word. */
const WAIT_WORTH_S = 60;
/** A disk this full is a worry. */
const DISK_FULL = 0.9;

export interface ProgressHost {
  rerender(): void;
  /** Show this file in the media tab. */
  find(name: string): void;
}

const SECTIONS: Section[] = ['running', 'queued', 'failed', 'backup', 'done'];
const VIDEO = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;

/**
 * The progress tab, a page of its own: how the server, the transcriber, the
 * nightly backup and the disks are, at a glance; then every file on its way,
 * from whichever device sent it to the transcript in the vault and the
 * backup, each with a bar of where its time went. A file opens to show each
 * step's time.
 */
export class ProgressList {
  private index: IndexEntry[] = [];
  private jobs: Job[] = [];
  private uploads: RemoteUpload[] = [];
  private runs: BackupRun[] = [];
  private status: ServerStatus | null = null;
  private error: string | null = null;
  loaded = false;
  private filter: Section | null = null;
  private allDone = false;
  /** Files opened to their steps. */
  private open = new Set<string>();
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
      const [index, jobs, uploads, runs, status] = await Promise.all([
        library.index(),
        library.jobs(),
        library.uploads().catch(() => [] as RemoteUpload[]),     // a server before 0.9
        library.backupRuns().catch(() => [] as BackupRun[]),
        library.status().catch(() => null),                      // a server before 0.10
      ]);
      this.index = index;
      this.jobs = jobs.jobs;
      this.uploads = uploads;
      this.runs = runs;
      this.status = status;
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
    if (this.error && !this.loaded) status.createDiv({ cls: 'mo-lib-error', text: this.error });
    if (!this.loaded) {
      if (!this.error) status.setText(t('library.loading'));
      return;
    }
    const now = Date.now() / 1000;
    const root = list.createDiv('mo-prog');
    this.renderOverview(root, now);
    this.renderTabs(root);
    const { rows } = this.progress;
    let any = false;
    for (const section of SECTIONS) {
      if (this.filter && this.filter !== section) continue;
      const items = rows.filter(r => r.section === section);
      if (!items.length) continue;
      any = true;
      const box = root.createDiv(`mo-prog-section is-${section}`);
      if (section === 'done') this.renderDone(box, items, now);
      else {
        this.heading(box, t(`library.progress.${section}`), items.length);
        const cards = box.createDiv('mo-prog-cards');
        for (const r of items) this.renderCard(cards, r, now);
      }
    }
    if (!any) root.createDiv({ cls: 'mo-prog-empty', text: t('library.progress.empty') });
  }

  private heading(box: HTMLElement, text: string, count: number): void {
    const h = box.createDiv('mo-prog-heading');
    h.createSpan({ text });
    h.createSpan({ cls: 'mo-prog-count', text: String(count) });
  }

  // ── at a glance ──────────────────────────────────────────────────────────
  private renderOverview(root: HTMLElement, now: number): void {
    const grid = root.createDiv('mo-prog-overview');
    const card = (icon: string, label: string, tone: 'ok' | 'busy' | 'warn' | 'error' | 'none', wide = false) => {
      const c = grid.createDiv(`mo-prog-stat is-${tone}${wide ? ' is-wide' : ''}`);
      const head = c.createDiv('mo-prog-stat-head');
      setIcon(head.createSpan('mo-prog-stat-icon'), icon);
      head.createSpan({ cls: 'mo-prog-stat-label', text: label });
      head.createSpan('mo-prog-dot');
      return c;
    };
    const value = (c: HTMLElement, text: string) => c.createDiv({ cls: 'mo-prog-stat-value', text });
    const sub = (c: HTMLElement, text: string, title?: string) => c.createDiv({ cls: 'mo-prog-stat-sub', text, attr: title ? { title } : {} });

    // The server.
    const st = this.status;
    const online = !this.error;
    const server = card('server', t('library.progress.server'), online ? 'ok' : 'error');
    value(server, online ? t('library.progress.serverOnline') : t('library.progress.serverOffline'));
    if (!online) sub(server, this.error ?? '', this.error ?? undefined);
    else if (st) sub(server, `${t('library.progress.serverHolds', { count: st.library.vaultFiles, size: formatSize(st.library.vaultBytes) })} · v${st.version}`);

    // The transcriber.
    const w = workerState(st, this.jobs, now);
    const waiting = this.jobs.filter(j => j.state === 'queued').length;
    const worker = card('audio-lines', t('library.progress.worker'),
      w.state === 'busy' ? 'busy' : w.state === 'idle' ? 'ok' : w.state === 'offline' ? (waiting ? 'error' : 'warn') : 'none');
    value(worker, w.state === 'busy' ? (w.count > 1 ? t('library.progress.workerBusyMany', { count: w.count }) : t('library.progress.workerBusy'))
      : w.state === 'idle' ? t('library.progress.workerIdle')
        : w.state === 'offline' ? t('library.progress.workerOffline') : t('library.progress.workerUnknown'));
    const queue = waiting ? t('library.progress.workerQueue', { count: waiting }) : t('library.progress.workerNothing');
    sub(worker, w.state === 'offline' ? `${t('library.progress.workerSeen', { ago: brief(now - w.seen) })} · ${queue}` : queue);

    // The nightly backup: only for a vault it takes.
    if (backsUp(this.index, this.plugin.library.folder)) {
      const { last, lastOk } = lastRuns(this.runs);
      const backup = card('hard-drive', t('library.progress.backupCard'), !last ? 'none' : last.ok ? 'ok' : 'error', true);
      if (!last) value(backup, t('library.progress.backupCardNone'));
      else {
        const when = secondsOf(last.started);
        const took = when !== undefined && last.finished ? (secondsOf(last.finished) ?? when) - when : null;
        value(backup, last.ok ? t('library.progress.backupCardOk') : t('library.progress.backupCardFailed'));
        sub(backup, t('library.progress.backupCardWhen', { when: when ? clock(when) : last.started, took: took !== null ? brief(took) : '—' }));
        if (!last.ok) {
          const why = [...(last.failed ?? []), ...(last.problems ?? [])].join(' · ');
          if (why) sub(backup, why, why).addClass('is-error');
          const okAt = lastOk ? secondsOf(lastOk.started) : undefined;
          sub(backup, okAt ? t('library.progress.backupLastOk', { when: clock(okAt) }) : t('library.progress.backupNeverOk'));
        }
      }
    }

    // The disks.
    if (st?.disks.length) {
      const fullest = Math.max(...st.disks.map(d => (d.total - d.free) / d.total));
      const storage = card('database', t('library.progress.storage'), fullest >= DISK_FULL ? 'warn' : 'ok', true);
      for (const d of st.disks) {
        const used = (d.total - d.free) / d.total;
        const row = storage.createDiv(`mo-prog-disk${used >= DISK_FULL ? ' is-full' : ''}`);
        const line = row.createDiv('mo-prog-disk-line');
        line.createSpan({ text: d.key === 'library' ? t('library.progress.diskLibrary') : t('library.progress.diskSystem') });
        line.createSpan({ cls: 'mo-prog-disk-free', text: `${Math.round(used * 100)}% · ${t('library.progress.diskFree', { free: formatSize(d.free) })}` });
        row.createDiv('mo-prog-meter').createDiv('mo-prog-meter-fill').style.width = `${Math.min(100, used * 100)}%`;
        row.setAttr('title', `${formatSize(d.total - d.free)} / ${formatSize(d.total)}`);
      }
    }
  }

  private renderTabs(root: HTMLElement): void {
    const bar = root.createDiv('mo-prog-tabs');
    const tab = (section: Section | null, label: string, count?: number) => {
      const b = bar.createEl('button', { cls: 'mo-prog-tab' });
      b.createSpan({ text: label });
      if (count !== undefined) b.createSpan({ cls: 'mo-prog-tab-count', text: String(count) });
      if (section) b.addClass(`is-${section}`);
      b.toggleClass('is-active', this.filter === section);
      b.addEventListener('click', () => { this.filter = section; this.host.rerender(); });
    };
    tab(null, t('library.collectionAll'));
    for (const s of SECTIONS) {
      const n = this.progress.counts[s];
      if (n || this.filter === s) tab(s, t(`library.progress.${s}Short`), n);
    }
  }

  /** Finished files by the day they finished on, newest first. */
  private renderDone(box: HTMLElement, items: ProgressRow[], now: number): void {
    const more = !this.allDone && items.length > SHOWN_DONE ? items.length - SHOWN_DONE : 0;
    const shown = more ? items.slice(0, SHOWN_DONE) : items;
    const days = new Map<number, ProgressRow[]>();
    for (const r of shown) {
      const day = dayOf(r.ended ?? r.at);
      days.set(day, [...(days.get(day) ?? []), r]);
    }
    for (const [day, rows] of days) {
      this.heading(box, dayName(day, now), rows.length);
      const cards = box.createDiv('mo-prog-cards');
      for (const r of rows) this.renderCard(cards, r, now);
    }
    if (more || (this.allDone && items.length > SHOWN_DONE)) {
      const b = box.createEl('button', { cls: 'mo-act-more', text: more ? t('library.activityMore', { count: more }) : t('library.activityLess') });
      b.addEventListener('click', () => { this.allDone = !this.allDone; this.host.rerender(); });
    }
  }

  // ── a file ───────────────────────────────────────────────────────────────
  private renderCard(parent: HTMLElement, r: ProgressRow, now: number): void {
    const open = this.open.has(r.key);
    const card = parent.createDiv(`mo-prog-card is-${r.section}${open ? ' is-open' : ''}`);
    card.addEventListener('click', e => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (open) this.open.delete(r.key);
      else this.open.add(r.key);
      this.host.rerender();
    });

    const top = card.createDiv('mo-prog-card-top');
    const kind = r.vaultPath === null && r.upload === null && r.transcribe.job?.path.startsWith('_archive/') ? 'web' : VIDEO.test(r.key) ? 'video' : 'audio';
    setIcon(top.createDiv(`mo-prog-icon is-${kind}`), kind === 'web' ? 'globe' : kind === 'video' ? 'film' : 'audio-lines');
    const main = top.createDiv('mo-prog-main');
    main.createDiv({ cls: 'mo-prog-name', text: r.name, attr: { title: r.name } });
    const meta = this.meta(r);
    if (meta) main.createDiv({ cls: 'mo-prog-meta', text: meta });
    const side = top.createDiv('mo-prog-side');
    const [pill, under] = this.pill(r, now);
    side.createSpan({ cls: `mo-prog-pill is-${r.section}`, text: pill });
    if (under) side.createDiv({ cls: 'mo-prog-under', text: under });

    const body = card.createDiv('mo-prog-card-body');
    const phases = phasesOf(r, now);
    const left = r.transcribe.state === 'active' && r.transcribe.left ? r.transcribe.left : 0;
    const sending = r.upload && (r.upload.state === 'active' || r.upload.state === 'paused') && r.upload.size ? r.upload : null;
    if (sending) {
      // How much is in, rather than how long it has taken.
      const bar = body.createDiv('mo-prog-bar');
      const sent = Math.min(1, (sending.sent ?? 0) / (sending.size ?? 1));
      if (sent > 0) bar.createDiv(`mo-prog-seg is-upload${sending.state === 'active' ? ' is-live' : ''}`).style.flexGrow = String(sent);
      bar.createDiv('mo-prog-seg is-left').style.flexGrow = String(1 - sent);
    } else if (phases.length) {
      const bar = body.createDiv('mo-prog-bar');
      for (const p of phases) {
        const seg = bar.createDiv(`mo-prog-seg is-${p.kind}${p.live ? ' is-live' : ''}`);
        seg.style.flexGrow = String(Math.max(1, p.to - p.from));
        seg.setAttr('title', phaseText(p));
      }
      if (left) bar.createDiv('mo-prog-seg is-left').style.flexGrow = String(left);
    }
    const legend = body.createDiv('mo-prog-legend');
    for (const p of phases) {
      if (p.kind === 'wait' && !p.live && p.to - p.from < WAIT_WORTH_S) continue;
      const item = legend.createSpan(`mo-prog-leg is-${p.kind}`);
      item.createSpan('mo-prog-leg-dot');
      item.createSpan({ text: phaseText(p) });
    }
    if (left) legend.createSpan({ cls: 'mo-prog-leg is-left', text: t('library.progress.phaseLeft', { took: brief(left) }) });
    if (r.inVault === false && r.transcribe.state === 'done') this.badge(legend, 'file-text', t('library.stepToVault'), 'wait');
    if (r.backup) {
      if (r.backup.at !== undefined) this.badge(legend, 'hard-drive', clockIn(r.backup.at, r, now), 'ok');
      else if (r.section !== 'running' && r.section !== 'queued') this.badge(legend, 'hard-drive', t('library.progress.pillBackup'), 'wait');
    }
    if (!legend.childElementCount) legend.remove();

    if (r.section === 'failed' && r.transcribe.error && !open) body.createDiv({ cls: 'mo-prog-error', text: r.transcribe.error, attr: { title: r.transcribe.error } });
    if (open) this.renderSteps(card, r, now);
  }

  private badge(parent: HTMLElement, icon: string, text: string, tone: 'ok' | 'wait'): void {
    const b = parent.createSpan(`mo-prog-badge is-${tone}`);
    setIcon(b.createSpan('mo-prog-badge-icon'), icon);
    b.createSpan({ text });
  }

  /** Under the name: how big, from which device. */
  private meta(r: ProgressRow): string {
    const parts: string[] = [];
    const u = r.upload;
    if (u?.live) parts.push(describe(u.live).detail);
    else if (u && (u.state === 'active' || u.state === 'paused') && u.size) parts.push(`${formatSize(u.sent ?? 0)} / ${formatSize(u.size)}`);
    else if (u?.size) parts.push(formatSize(u.size));
    if (u?.device) parts.push(t('library.progress.fromDevice', { device: u.device }));
    if (!u && r.transcribe.job?.path.startsWith('_archive/')) parts.push(t('library.progress.archived'));
    return parts.join(' · ');
  }

  /** The state in a word, and under it the time that matters: when it will be done, how long it took. */
  private pill(r: ProgressRow, now: number): [string, string | null] {
    const u = r.upload;
    const tr = r.transcribe;
    const pct = (a?: number, b?: number) => (a !== undefined && b ? Math.min(99, Math.floor((a / b) * 100)) : 0);
    switch (r.section) {
      case 'running':
        if (u?.state === 'active') return [t('library.progress.pillUpload', { pct: pct(u.sent, u.size) }), t('library.progress.goingFor', { took: brief(now - (u.began ?? r.started)) })];
        if (tr.state === 'active') {
          const word = tr.total && tr.done !== undefined ? t('library.progress.pillTranscribe', { pct: pct(tr.done, tr.total) }) : t('library.progress.pillTranscribing');
          return [word, tr.left ? t('library.progress.eta', { when: clock(now + tr.left) }) : null];
        }
        return [t('library.progress.pillToVault'), null];
      case 'queued': {
        if (u?.state === 'paused') return [t('library.progress.pillPaused'), u.moved !== undefined ? t('library.progress.pausedSince', { when: clock(u.moved) }) : null];
        const place = u && u.state !== 'done' ? u.place ?? 1 : tr.place ?? 1;
        const since = u && u.state !== 'done' ? r.started : tr.queued ?? r.started;
        return [t('library.progress.pillPlace', { place }), t('library.progress.waitingFor', { took: brief(now - since) })];
      }
      case 'failed':
        return [t('library.progress.pillFailed'), tr.ended !== undefined ? clockIn(tr.ended, r, now) : null];
      case 'backup':
        return [t('library.progress.pillBackup'), t('library.progress.waitingFor', { took: brief(now - (u?.ended ?? r.started)) })];
      case 'done': {
        const end = tr.ended ?? u?.ended ?? r.ended ?? r.at;
        const took = turnaround(r);
        return [clockIn(end, r, now), took !== null ? t('library.progress.inAll', { took: brief(took) }) : null];
      }
    }
  }

  /** Opened: each step with its time, and what can be done. */
  private renderSteps(card: HTMLElement, r: ProgressRow, now: number): void {
    const box = card.createDiv('mo-prog-steps');
    const list = box.createDiv('mo-prog-timeline');
    const step = (tone: 'done' | 'active' | 'wait' | 'failed', label: string, when?: number, note?: string) => {
      const s = list.createDiv(`mo-prog-tl is-${tone}`);
      s.createSpan('mo-prog-tl-dot');
      const text = s.createDiv('mo-prog-tl-text');
      text.createSpan({ cls: 'mo-prog-tl-label', text: label });
      if (note) text.createSpan({ cls: 'mo-prog-tl-note', text: note });
      if (when !== undefined) s.createSpan({ cls: 'mo-prog-tl-time', text: clock(when) });
    };
    const u = r.upload;
    const tr = r.transcribe;
    if (u) {
      const device = u.device ? t('library.progress.fromDevice', { device: u.device }) : undefined;
      if (u.state === 'queued') step('wait', t('library.progress.tlWaitingUpload'), r.started, u.place ? t('library.progress.pillPlace', { place: u.place }) : undefined);
      else {
        if (u.began !== undefined) step('done', t('library.progress.tlUploadBegan'), u.began, device);
        if (u.state === 'done') step('done', t('library.progress.tlUploaded'), u.ended, u.began !== undefined && u.ended !== undefined ? brief(u.ended - u.began) : device);
        else step(u.state === 'paused' ? 'wait' : 'active', u.state === 'paused' ? t('library.progress.pillPaused') : t('library.progress.pillUpload', { pct: u.size ? Math.floor(((u.sent ?? 0) / u.size) * 100) : 0 }), u.moved);
      }
    }
    if (tr.state !== 'none') {
      if (tr.queued !== undefined && (tr.began === undefined || tr.began - tr.queued >= WAIT_WORTH_S)) step(tr.state === 'queued' ? 'wait' : 'done', t('library.progress.tlQueued'), tr.queued, tr.state === 'queued' && tr.place ? t('library.progress.pillPlace', { place: tr.place }) : undefined);
      if (tr.began !== undefined) step('done', t('library.progress.tlTranscribeBegan'), tr.began, tr.queued !== undefined && tr.began - tr.queued >= WAIT_WORTH_S ? t('library.progress.phaseWaitTranscribe', { took: brief(tr.began - tr.queued) }) : undefined);
      if (tr.state === 'active') step('active', t('library.progress.pillTranscribing'), undefined, tr.left ? t('library.progress.eta', { when: clock(now + tr.left) }) : undefined);
      if (tr.state === 'done') step('done', t('library.progress.tlTranscribed'), tr.ended, tr.began !== undefined && tr.ended !== undefined ? brief(tr.ended - tr.began) : undefined);
      if (tr.state === 'failed') step('failed', t('library.progress.tlFailed'), tr.ended, tr.error ?? undefined);
    }
    if (r.inVault !== null) step(r.inVault ? 'done' : 'wait', r.inVault ? t('library.progress.tlInVault') : t('library.progress.tlToVault'));
    if (r.backup) step(r.backup.at !== undefined ? 'done' : 'wait', r.backup.at !== undefined ? t('library.progress.tlBackedUp') : t('library.progress.tlNotBackedUp'), r.backup.at);

    const actions = box.createDiv('mo-prog-actions');
    if (r.vaultPath) {
      const find = actions.createEl('button', { text: t('library.progress.showInMedia') });
      find.addEventListener('click', () => this.host.find(r.name));
    }
    if (r.section === 'failed' && r.vaultPath) {
      const retry = actions.createEl('button', { cls: 'mod-cta', text: t('library.retry') });
      retry.addEventListener('click', () => { void this.retry(r); });
    }
    if (!actions.childElementCount) actions.remove();
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

function phaseText(p: Phase): string {
  const took = brief(p.to - p.from);
  if (p.kind === 'upload') return t(p.live ? 'library.progress.phaseUploading' : 'library.progress.phaseUpload', { took });
  if (p.kind === 'transcribe') return t(p.live ? 'library.progress.phaseTranscribing' : 'library.progress.phaseTranscribe', { took });
  return t(p.before === 'upload' ? 'library.progress.phaseWaitUpload' : 'library.progress.phaseWaitTranscribe', { took });
}

/** A length of time, short: 45 s, 9 min, 1 h 16 min, 2 d 3 h. */
export function brief(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return t('library.progress.durS', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t('library.progress.durM', { n: m });
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? t('library.progress.durHM', { h, m: m % 60 }) : t('library.progress.durH', { h });
  return t('library.progress.durDH', { d: Math.floor(h / 24), h: h % 24 });
}

/** A moment within a finished file's day group: just the time when it is that day. */
function clockIn(seconds: number, r: ProgressRow, now: number): string {
  return r.section === 'done' && dayOf(seconds) === dayOf(r.ended ?? r.at) ? hm(seconds) : clock(seconds, now * 1000);
}

function hm(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayName(day: number, now: number): string {
  const today = dayOf(now);
  const d = new Date(day);
  if (day === today) return t('library.progress.today');
  if (Math.round((today - day) / 86_400_000) === 1) return t('library.progress.yesterdayDay');
  return t('library.progress.dayHeading', { month: d.getMonth() + 1, day: d.getDate() });
}

/** A moment, as short as it reads: today's time, yesterday's, or the date. */
export function clock(seconds: number, now = Date.now()): string {
  const d = new Date(seconds * 1000);
  const today = new Date(now);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(today) - day(d)) / 86_400_000);
  if (days === 0) return hm(seconds);
  if (days === 1) return t('library.progress.yesterday', { time: hm(seconds) });
  if (days === -1) return t('library.progress.tomorrow', { time: hm(seconds) });
  return t('library.progress.onDay', { month: d.getMonth() + 1, day: d.getDate(), time: hm(seconds) });
}
