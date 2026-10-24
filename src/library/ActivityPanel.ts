import { Platform, setIcon } from 'obsidian';
import type MediaTranscriptPlugin from '../main';
import { buildActivity, underWay, type Activity, type Stage } from './activity';
import { describe, roughly } from './UploadStatus';
import { PHONE_DELAY_S, collectionFolder } from './transcriptSync';
import { DeviceState } from './deviceState';
import { formatTime } from '../utils/subtitleParser';
import { t } from '../i18n';

/** While something is being transcribed or brought in, ask the server this often. */
const POLL_MS = 20_000;
/** Rows shown before "N more". */
const SHOWN = 4;

export interface ActivityHost {
  /** Is this library file backed up? null: not in the index (yet). */
  backedUp(path: string): boolean | null;
  /** Show this file in the list below. */
  find(name: string): void;
  /** Open the progress tab: every file, with its times. */
  seeAll(): void;
}

const ICONS: Record<Stage['kind'], string> = { upload: 'upload', transcribe: 'audio-lines', note: 'file-text', backup: 'hard-drive' };

/**
 * "In progress", atop the library: every file on its way through, from this
 * device's upload to the transcript in the vault and the nightly backup, each
 * step ticked off as it is done. Shown only while something is under way or
 * just finished.
 */
export function renderActivity(parent: HTMLElement, plugin: MediaTranscriptPlugin, host: ActivityHost): () => void {
  const device = new DeviceState(plugin.app);
  const box = parent.createDiv('mo-act is-hidden');
  const head = box.createDiv('mo-act-head');
  const caret = head.createSpan('mo-act-caret');
  const title = head.createSpan('mo-act-title');
  const seeAll = head.createEl('a', { cls: 'mo-act-all', text: t('library.activitySeeAll'), attr: { href: '#' } });
  seeAll.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    host.seeAll();
  });
  const list = box.createDiv('mo-act-list');
  let open = device.get<boolean>('activityOpen', true);
  let all = false;
  let items: Activity[] = [];
  head.addEventListener('click', () => {
    open = !open;
    device.set('activityOpen', open);
    paint();
  });

  // Server time, roughly: job times are the server's.
  const now = () => Date.now() / 1000;

  const build = () => {
    const { uploader, transcriptSync, transcripts, library } = plugin;
    items = buildActivity({
      own: library.folder,
      upload: uploader.status,
      pending: uploader.pending,
      jobs: transcriptSync.known,
      now: now(),
      hasTranscript: name => transcripts.transcriptsFor(name).length > 0,
      keepsCollection: c => collectionFolder(plugin.app.vault.getAllFolders(), c) !== null,
      backedUp: path => host.backedUp(path),
      mobile: Platform.isMobile,
      phoneDelay: PHONE_DELAY_S,
    });
  };

  const paint = () => {
    build();
    box.toggleClass('is-hidden', items.length === 0);
    if (items.length === 0) return;
    const busy = underWay(items);
    title.setText(busy ? t('library.activityTitle', { count: busy }) : t('library.activityDone', { count: items.length }));
    setIcon(caret, open ? 'chevron-down' : 'chevron-right');
    list.empty();
    list.toggle(open);
    if (!open) return;
    const shown = all ? items : items.slice(0, SHOWN);
    for (const a of shown) renderItem(list, a, host);
    if (items.length > SHOWN) {
      const more = list.createEl('button', { cls: 'mo-act-more', text: all ? t('library.activityLess') : t('library.activityMore', { count: items.length - SHOWN }) });
      more.addEventListener('click', () => { all = !all; paint(); });
    }
  };

  // Ask the server again soon while a job is moving, or a transcript is on its way in.
  const moving = () => items.some(a => !a.finished && a.stages.some(s => (s.kind === 'transcribe' && s.state !== 'failed' && s.state !== 'done') || (s.kind === 'note' && s.state === 'waiting' && a.stages.some(x => x.kind === 'transcribe' && x.state === 'done'))));
  const poll = window.setInterval(() => {
    if (!box.isShown() || !moving()) return;
    void plugin.transcriptSync.sync();
  }, POLL_MS);
  // An upload just done: its job is on the server now.
  let uploading = !!plugin.uploader.status;
  const offUpload = plugin.uploader.subscribe(() => {
    const was = uploading;
    uploading = !!plugin.uploader.status;
    if (was && !uploading) void plugin.transcriptSync.sync();
    paint();
  });
  const offJobs = plugin.transcriptSync.onJobs(paint);
  // What syncing has seen is only what moved lately: a job waiting since before is in the full list.
  if (plugin.library.configured) {
    plugin.library.jobs().then(r => plugin.transcriptSync.remember(r.jobs), () => { /* shown when the server answers again */ });
  }
  const offTranscripts = plugin.transcripts.onChange(paint);
  // Times and countdowns move on their own.
  const tick = window.setInterval(() => { if (items.length) paint(); }, 5000);
  paint();
  return () => {
    window.clearInterval(poll);
    window.clearInterval(tick);
    offUpload();
    offJobs();
    offTranscripts();
    box.remove();
  };
}

function renderItem(list: HTMLElement, a: Activity, host: ActivityHost): void {
  const row = list.createDiv('mo-act-item');
  row.toggleClass('is-finished', a.finished);
  const name = row.createDiv({ cls: 'mo-act-name', text: a.name, attr: { title: a.name } });
  name.addEventListener('click', () => host.find(a.name));
  const current = a.stages.find(s => s.state !== 'done' && s.state !== 'waiting') ?? null;
  const fraction = current ? fractionOf(current) : null;
  if (fraction !== null) {
    const track = row.createDiv('mo-act-track');
    track.createDiv('mo-act-fill');
    row.style.setProperty('--mo-act', String(fraction));
  }
  const steps = row.createDiv('mo-act-steps');
  for (const s of a.stages) {
    const step = steps.createSpan(`mo-act-step is-${s.state}`);
    setIcon(step.createSpan('mo-act-step-icon'), s.state === 'done' ? 'check' : s.state === 'failed' ? 'x' : ICONS[s.kind]);
    step.createSpan({ text: label(s) });
    if (s.state === 'failed' && s.job?.error) step.setAttr('title', s.job.error);
  }
  const detail = current ? detailOf(current) : a.stages.map(phoneNote).find(Boolean) ?? null;
  if (detail) {
    const failed = current?.state === 'failed';
    row.createDiv({ cls: failed ? 'mo-act-detail is-error' : 'mo-act-detail', text: detail, attr: failed ? { title: detail } : {} });
  }
}

function fractionOf(s: Stage): number | null {
  if (s.kind === 'upload' && s.upload) return s.upload.size ? s.upload.sent / s.upload.size : 0;
  if (s.kind === 'transcribe' && s.state === 'active' && s.total && s.done !== undefined) return Math.min(1, s.done / s.total);
  return null;
}

/** The step, in a word or three. */
function label(s: Stage): string {
  switch (s.kind) {
    case 'upload':
      if (s.state === 'done') return t('library.stepUploaded');
      if (s.state === 'active' && s.upload) {
        // "45%" reads as the upload's; "checking", "waiting" say it themselves.
        const { short } = describe(s.upload);
        return /%$/.test(short) ? t('library.stepUploading', { short }) : short;
      }
      return s.place && s.place > 1 ? t('library.stepUploadQueued', { place: s.place }) : t('library.stepUploadNext');
    case 'transcribe':
      if (s.state === 'done') return t('library.stepTranscribed');
      if (s.state === 'failed') return t('library.stepFailed');
      if (s.state === 'active') {
        if (s.onWorker) return t('library.stepOnWorker');
        if (s.total && s.done !== undefined) return t('library.stepTranscribingAt', { done: formatTime(s.done), total: formatTime(s.total) });
        return t('library.stepTranscribing');
      }
      if (s.place) return t('library.stepQueued', { place: s.place });
      return t('library.stepTranscribe');
    case 'note':
      if (s.state === 'done') return t('library.stepInVault');
      return t('library.stepToVault');
    case 'backup':
      return s.state === 'done' ? t('library.stepBackedUp') : t('library.stepBackup');
  }
}

/** The line under the steps, for the one under way. */
function detailOf(s: Stage): string | null {
  if (s.kind === 'upload' && s.upload) return describe(s.upload).detail;
  if (s.kind === 'transcribe' && s.state === 'active' && s.left) return t('library.stepLeft', { left: roughly(s.left) });
  if (s.kind === 'transcribe' && s.state === 'failed') return s.job?.error ?? null;
  return null;
}

/** The note step waiting on a phone: the computer writes it first. */
function phoneNote(s: Stage): string | null {
  return s.kind === 'note' && s.phone ? t('library.stepPhoneWaits') : null;
}
