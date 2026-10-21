import { App, ItemView, Menu, Modal, Notice, Setting, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import type MediaTranscriptPlugin from '../main';
import type { TrashItem } from './client';
import { deleteMedia, renameMedia, restoreMedia } from './actions';
import { ArchiveList } from './ArchiveList';
import { MediaList } from './MediaList';
import { renderDock, renderPlaylist } from './PlayerBar';
import { renderUploadRow } from './UploadStatus';
import { t } from '../i18n';
import { formatSize } from '../utils/format';

export const VIEW_TYPE_LIBRARY = 'media-one-library';

/**
 * The library on the Media One server, as a folder: play, rename, move and
 * delete media that may no longer be on this device, and restore it from the
 * server's trash. A second tab lists the web archive (images and videos saved
 * from notes).
 */
export class LibraryView extends ItemView {
  private filter = '';
  private listEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private tab: 'media' | 'archive' | 'playlist' = 'media';
  private playlistDown: (() => void) | null = null;
  private tabsEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private readonly media: MediaList;
  private readonly archive: ArchiveList;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: MediaTranscriptPlugin) {
    super(leaf);
    this.media = new MediaList(plugin, {
      rerender: () => this.renderList(),
      rename: vaultPath => this.askRename(vaultPath),
      delete: vaultPath => this.askDelete(vaultPath),
      restore: item => this.restore(item),
      confirm: (heading, body, action, onConfirm) => new ConfirmModal(this.app, heading, body, action, onConfirm, false).open(),
    });
    this.archive = new ArchiveList(plugin, {
      confirm: (heading, body, action, onConfirm) => new ConfirmModal(this.app, heading, body, action, onConfirm).open(),
      rerender: () => this.renderList(),
    });
  }

  getViewType(): string {
    return VIEW_TYPE_LIBRARY;
  }

  getDisplayText(): string {
    return t('library.viewTitle');
  }

  getIcon(): string {
    return 'library';
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('mo-lib');
    const bar = root.createDiv('mo-lib-bar');
    const search = (this.searchEl = bar.createEl('input', { type: 'search', placeholder: t('library.filterPlaceholder'), cls: 'mo-lib-search' }));
    search.addEventListener('input', () => {
      this.filter = search.value.trim().toLowerCase();
      this.renderList();
    });
    const refresh = bar.createEl('button', { cls: 'clickable-icon mo-lib-refresh', attr: { 'aria-label': t('library.refresh') } });
    setIcon(refresh, 'refresh-cw');
    refresh.addEventListener('click', () => { void this.refresh(); });
    this.tabsEl = root.createDiv('mo-lib-tabs');
    for (const [tab, label] of [['media', t('library.tabMedia')], ['archive', t('library.tabArchive')], ['playlist', t('library.tabPlaylist')]] as const) {
      const b = this.tabsEl.createEl('button', { text: label, cls: 'mo-lib-tab' });
      b.dataset.tab = tab;
      b.addEventListener('click', () => {
        this.tab = tab;
        if (tab === 'archive' && !this.archive.loaded) void this.archive.refresh().then(() => this.renderList());
        this.renderList();
      });
    }
    this.register(renderUploadRow(root, this.plugin));
    this.statusEl = root.createDiv('mo-lib-status');
    this.listEl = root.createDiv('mo-lib-list');
    // What plays goes on when the library closes: the player in the status bar
    // (or floating, on a phone) is there to stop it.
    this.register(renderDock(root, this.plugin));
    this.register(this.plugin.nowPlaying.subscribe(() => {
      if (this.tab === 'media') this.media.paintPlaying(this.listEl);
    }));
    this.register(() => this.playlistDown?.());
    this.register(this.plugin.playlist.subscribe(() => {
      if (this.tab === 'media') this.media.paintQueued(this.listEl);
    }));
    this.register(this.plugin.cache.subscribe(() => {
      if (this.tab === 'media') this.media.paintCache(this.listEl);
    }));
    // A transcript arriving (written here, or brought by Sync) and a job
    // moving on show in their row without a refresh. Several files of one
    // transcript come at once: draw once for them.
    let relinkTimer: number | null = null;
    const relink = () => {
      if (relinkTimer !== null) window.clearTimeout(relinkTimer);
      relinkTimer = window.setTimeout(() => {
        relinkTimer = null;
        if (this.media.relink() && this.tab === 'media') this.renderList();
      }, 1000);
    };
    this.register(() => { if (relinkTimer !== null) window.clearTimeout(relinkTimer); });
    this.register(this.plugin.transcripts.onChange(relink));
    this.register(this.plugin.transcriptSync.onJobs(() => {
      if (this.media.takeJobs(this.plugin.transcriptSync.known) && this.tab === 'media') this.renderList();
    }));
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.tab === 'playlist') return this.renderList();
    if (this.tab === 'archive') await this.archive.refresh();
    else await this.media.refresh();
    this.renderList();
  }

  private renderList(): void {
    const { listEl, statusEl } = this;
    this.playlistDown?.();
    this.playlistDown = null;
    listEl.empty();
    statusEl.empty();
    this.tabsEl.querySelectorAll<HTMLElement>('.mo-lib-tab').forEach(b => b.toggleClass('is-active', b.dataset.tab === this.tab));
    this.searchEl.placeholder = t(this.tab === 'archive' ? 'library.filterArchive' : 'library.filterPlaceholder');
    this.searchEl.toggle(this.tab !== 'playlist');
    if (this.tab === 'playlist') this.playlistDown = renderPlaylist(listEl, this.plugin);
    else if (this.tab === 'archive') this.archive.render(listEl, statusEl, this.filter);
    else this.media.render(listEl, statusEl, this.filter);
  }

  askRename(vaultPath: string): void {
    new RenameModal(this.app, vaultPath, async to => {
      try {
        await renameMedia(this.plugin, vaultPath, to);
        new Notice(t('library.renamedTo', { path: to }));
      } catch (e) {
        new Notice(t('library.renameFailed', { error: (e as Error).message }));
      }
      await this.refresh();
    }).open();
  }

  askDelete(vaultPath: string): void {
    new ConfirmModal(this.app, t('library.deleteTitle', { name: nameOf(vaultPath) }),
      t('library.deleteDesc'),
      t('library.delete'), async () => {
        try {
          await deleteMedia(this.plugin, vaultPath);
          new Notice(t('library.deleted', { name: nameOf(vaultPath) }));
        } catch (e) {
          new Notice(t('library.deleteFailed', { error: (e as Error).message }));
        }
        await this.refresh();
      }).open();
  }

  private async restore(item: TrashItem): Promise<void> {
    try {
      const path = await restoreMedia(this.plugin, item.id);
      new Notice(t('library.restored', { path }));
    } catch (e) {
      new Notice(t('library.restoreFailed', { error: (e as Error).message }));
    }
    await this.refresh();
  }
}

export class RenameModal extends Modal {
  constructor(app: App, private readonly current: string, private readonly onSubmit: (to: string) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(t('library.renameOrMove'));
    let value = this.current;
    const submit = () => {
      const to = value.trim();
      this.close();
      if (to && to !== this.current) void this.onSubmit(to);
    };
    new Setting(this.contentEl)
      .setName(t('library.newPath'))
      .setDesc(t('library.newPathDesc'))
      .addText(text => {
        text.setValue(value).onChange(v => { value = v; });
        text.inputEl.addClass('mo-lib-rename-input');
        text.inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
        // Select the name without the extension, ready to type over.
        const start = value.lastIndexOf('/') + 1;
        const end = value.lastIndexOf('.') > start ? value.lastIndexOf('.') : value.length;
        window.setTimeout(() => { text.inputEl.focus(); text.inputEl.setSelectionRange(start, end); }, 0);
      });
    new Setting(this.contentEl).addButton(b => b.setButtonText(t('library.rename')).setCta().onClick(submit));
  }
}

export class ConfirmModal extends Modal {
  constructor(app: App, private readonly heading: string, private readonly body: string,
    private readonly confirm: string, private readonly onConfirm: () => Promise<void>, private readonly warning = true) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.heading);
    this.contentEl.createEl('p', { text: this.body });
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText(t('library.cancel')).onClick(() => this.close()))
      .addButton(b => {
        b.setButtonText(this.confirm).onClick(() => {
          this.close();
          void this.onConfirm();
        });
        if (this.warning) b.setWarning();
        else b.setCta();
      });
  }
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

