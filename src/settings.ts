import { App, Notice, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import { MODULES } from './modules';
import type MediaTranscriptPlugin from './main';
import { parseFolderList } from './utils/mediaMatch';
import { t } from './i18n';
import type { QueueEntry } from './library/playlist';
import { formatSize } from './utils/format';
import { ConfirmModal } from './library/LibraryView';
import {
  MediaTranscriptView,
  VIEW_TYPE_MEDIA_TRANSCRIPT,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
} from './MediaTranscriptView';

export interface SubtitlePriority {
  marker: string;
  label: string;
}

export interface MediaTranscriptSettings {
  // ── Media One server ─────────────────────────────────────────────────────
  // Its address; the modules' own lists hold what it stands for.
  serverUrl: string;
  // This vault's folder on the server. Empty: the vault's name, which may
  // differ between devices (a phone's copy named otherwise), so set it to keep
  // every device on one folder. Synced with the settings.
  serverVault: string;
  // Upload media added to the vault to the server at once. (What is waiting
  // to upload is this device's own, kept in DeviceState, not here.)
  uploadNewMedia: boolean;
  // Where transcripts of archived web videos go (they have no media in the vault to sit beside).
  archiveTranscriptFolder: string;

  // ── Subtitle matching ────────────────────────────────────────────────────
  subtitleDirectory: string;
  priorities: SubtitlePriority[];

  // ── Media lookup ─────────────────────────────────────────────────────────
  // Where to look for a subtitle's media after its own folder, in order.
  // Vault-relative folders, or absolute ones outside the vault (desktop only).
  mediaFolders: string[];
  // Then these URL prefixes, e.g. a home server over Tailscale. Streamed.
  mediaUrls: string[];
  // Ask those servers before looking on disk at all.
  preferRemote: boolean;
  // Media picked by hand for a transcript that can't name its own (an .srt or
  // .vtt has nowhere to keep a `source`): transcript path → media filename.
  mediaLinks: Record<string, string>;

  // ── Media file types ─────────────────────────────────────────────────────
  supportedVideoExtensions: string[];
  supportedAudioExtensions: string[];

  // ── Layout ───────────────────────────────────────────────────────────────
  videoLayout: VideoLayout; // video: picture beside the transcript, above it, or by the pane's width
  playerWidthPercent: number; // video: left player width (%), remembered after dragging the divider
  lowSideWidthPercent: number | null; // the same on a low pane (a phone on its side); null: as wide as the video's shape asks
  stackVideoPercent: number | null;   // video above: its height (% of the pane); null: the default
  quotesKept: string[];               // quotes left as written though their transcript changed (transcript#range#words)
  transcriptFontSize: number; // transcript text size in px (A−/A+ buttons update this too)

  // ── Playback ─────────────────────────────────────────────────────────────
  autoScroll: boolean;      // keep the playing line centered in the transcript
  videoAudioOnly: boolean;  // play videos without showing the picture

  // ── Media library ────────────────────────────────────────────────────────
  // What plays next, in order: synced, so a phone goes on with a list made on the computer.
  playlist: QueueEntry[];
}

export type VideoLayout = 'auto' | 'side' | 'stack';

export const DEFAULT_SETTINGS: MediaTranscriptSettings = {
  serverUrl: '',
  serverVault: '',
  uploadNewMedia: false,
  archiveTranscriptFolder: 'Transcripts',
  subtitleDirectory: '',
  priorities: [{ marker: '', label: 'Default (no marker)' }],
  mediaFolders: [],
  mediaUrls: [],
  preferRemote: false,
  mediaLinks: {},
  supportedVideoExtensions: ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v'],
  supportedAudioExtensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus'],
  videoLayout: 'auto',
  playerWidthPercent: 75,
  lowSideWidthPercent: null,
  stackVideoPercent: null,
  quotesKept: [],
  transcriptFontSize: 15,
  autoScroll: true,
  videoAudioOnly: false,
  playlist: [],
};

// ── Settings Tab ──────────────────────────────────────────────────────────────

export class MediaTranscriptSettingTab extends PluginSettingTab {
  plugin: MediaTranscriptPlugin;

  constructor(app: App, plugin: MediaTranscriptPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Obsidian shows the plugin name as the heading automatically.
    this.displayServer(containerEl);
    this.displayModuleSwitches(containerEl);

    new Setting(containerEl).setName(t('core.headingSubtitles')).setHeading();

    new Setting(containerEl)
      .setName(t('core.settingSubtitleFolder'))
      .setDesc(t('core.settingSubtitleFolderDesc'))
      .addText(text =>
        text.setPlaceholder(t('core.settingSubtitleFolderPlaceholder'))
          .setValue(this.plugin.settings.subtitleDirectory)
          .onChange(async v => {
            this.plugin.settings.subtitleDirectory = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t('core.settingSubtitlePriority'))
      .setDesc(t('core.settingSubtitlePriorityDesc'))
      .addText(text =>
        text.setPlaceholder('vibevoice-4bit, whisper,')
          .setValue(this.plugin.settings.priorities.map(p => p.marker).join(', '))
          .onChange(async v => {
            const markers = v.split(',').map(s => s.trim()).filter((m, i, a) => a.indexOf(m) === i);
            this.plugin.settings.priorities = markers.map(m => ({ marker: m, label: m || 'Default' }));
            await this.plugin.saveSettings();
          }),
      );

    // ── Media ───────────────────────────────────────────────────────────────
    new Setting(containerEl).setName(t('core.headingMedia')).setHeading();

    new Setting(containerEl)
      .setName(t('core.settingMediaFolders'))
      .setDesc(t('core.settingMediaFoldersDesc'))
      .addTextArea(text => {
        text.setPlaceholder('附件/media\n/Volumes/2T/Media')
          .setValue(this.plugin.settings.mediaFolders.join('\n'))
          .onChange(async v => {
            this.plugin.settings.mediaFolders = parseFolderList(v);
            await this.plugin.saveSettings();
            this.plugin.mediaLocator.invalidate();
          });
        text.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName(t('core.settingRemoteUrls'))
      .setDesc(t('core.settingRemoteUrlsDesc'))
      .addTextArea(text => {
        text.setPlaceholder('https://old-mac.example.ts.net/recordings')
          .setValue(this.plugin.settings.mediaUrls.join('\n'))
          .onChange(async v => {
            this.plugin.settings.mediaUrls = parseFolderList(v);
            await this.plugin.saveSettings();
            this.plugin.mediaLocator.invalidate();
          });
        text.inputEl.rows = 3;
      });

    new Setting(containerEl)
      .setName(t('core.settingPreferRemote'))
      .setDesc(t('core.settingPreferRemoteDesc'))
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.preferRemote).onChange(async v => {
          this.plugin.settings.preferRemote = v;
          await this.plugin.saveSettings();
        }),
      );

    // ── Layout ──────────────────────────────────────────────────────────────
    new Setting(containerEl).setName(t('core.headingLayout')).setHeading();

    new Setting(containerEl)
      .setName(t('core.settingVideoLayout'))
      .setDesc(t('core.settingVideoLayoutDesc'))
      .addDropdown(d =>
        d
          .addOption('auto', t('core.videoLayoutAuto'))
          .addOption('side', t('core.videoLayoutSide'))
          .addOption('stack', t('core.videoLayoutStack'))
          .setValue(this.plugin.settings.videoLayout)
          .onChange(async v => {
            this.plugin.settings.videoLayout = v as VideoLayout;
            await this.plugin.saveSettings();
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MEDIA_TRANSCRIPT)) {
              if (leaf.view instanceof MediaTranscriptView) leaf.view.applyVideoLayout();
            }
          }),
      );

    new Setting(containerEl)
      .setName(t('core.settingVideoWidth'))
      .setDesc(t('core.settingVideoWidthDesc'))
      .addSlider(s =>
        s
          .setLimits(20, 75, 1)
          .setValue(this.plugin.settings.playerWidthPercent)
          .onChange(async v => {
            this.plugin.settings.playerWidthPercent = v;
            await this.plugin.saveSettings();
            // Live-apply to any open video views.
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MEDIA_TRANSCRIPT)) {
              if (leaf.view instanceof MediaTranscriptView) leaf.view.applyPlayerWidth(v);
            }
          }),
      );

    new Setting(containerEl)
      .setName(t('core.settingFontSize'))
      .setDesc(t('core.settingFontSizeDesc', { min: MIN_FONT_SIZE, max: MAX_FONT_SIZE }))
      .addSlider(s =>
        s
          .setLimits(MIN_FONT_SIZE, MAX_FONT_SIZE, 1)
          .setValue(this.plugin.settings.transcriptFontSize)
          .onChange(async v => {
            this.plugin.settings.transcriptFontSize = v;
            await this.plugin.saveSettings();
            this.plugin.applyFontSizeToOpenViews();
          }),
      );

    // ── Playback ────────────────────────────────────────────────────────────
    new Setting(containerEl).setName(t('core.headingPlayback')).setHeading();

    new Setting(containerEl)
      .setName(t('core.settingAutoScroll'))
      .setDesc(t('core.settingAutoScrollDesc'))
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.autoScroll).onChange(async v => {
          this.plugin.settings.autoScroll = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t('core.settingAudioOnly'))
      .setDesc(t('core.settingAudioOnlyDesc'))
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.videoAudioOnly).onChange(async v => {
          this.plugin.settings.videoAudioOnly = v;
          await this.plugin.saveSettings();
          for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MEDIA_TRANSCRIPT)) {
            if (leaf.view instanceof MediaTranscriptView) await leaf.view.applyAudioOnly();
          }
        }),
      );

    this.displayCache(containerEl);

    // Each running module's own settings, in a section of their own.
    for (const info of MODULES) {
      const tab = this.plugin.modules?.loaded.get(info.key)?.settingTab;
      if (!tab) continue;
      new Setting(containerEl).setName(info.name).setHeading();
      tab.containerEl = containerEl.createDiv('mt-module-settings');
      tab.display();
    }
  }

  /** The one address the modules share. */
  private displayServer(containerEl: HTMLElement): void {
    let value = this.plugin.settings.serverUrl;
    new Setting(containerEl)
      .setName(t('core.settingServer'))
      .setDesc(t('core.settingServerDesc'))
      .addText(text =>
        text.setPlaceholder('https://media.example.ts.net')
          .setValue(value)
          .onChange(v => { value = v; }),
      )
      .addButton(b =>
        b.setButtonText(t('core.save')).onClick(async () => {
          await this.plugin.setServer(value);
          new Notice(this.plugin.settings.serverUrl
            ? t('core.serverSet', { url: this.plugin.settings.serverUrl })
            : t('core.serverRemoved'));
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName(t('core.settingServerVault'))
      .setDesc(t('core.settingServerVaultDesc', { name: this.app.vault.getName() }))
      .addText(text =>
        text.setPlaceholder(this.app.vault.getName()).setValue(this.plugin.settings.serverVault).onChange(async v => {
          this.plugin.settings.serverVault = v.trim();
          await this.plugin.saveSettings();
          this.plugin.mediaLocator.invalidate();
        }),
      );
    new Setting(containerEl)
      .setName(t('core.settingUploadNew'))
      .setDesc(
        this.plugin.uploader.pending.length
          ? t('core.settingUploadNewDescWaiting', { n: this.plugin.uploader.pending.length })
          : t('core.settingUploadNewDesc'),
      )
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.uploadNewMedia).onChange(async v => {
          this.plugin.settings.uploadNewMedia = v;
          await this.plugin.saveSettings();
          if (v) {
            this.plugin.uploader.startCountingFromNow();
            void this.plugin.uploader.flush();
          }
        }),
      );

    new Setting(containerEl)
      .setName(t('core.settingArchiveTranscripts'))
      .setDesc(t('core.settingArchiveTranscriptsDesc'))
      .addText(text =>
        text.setPlaceholder('Transcripts').setValue(this.plugin.settings.archiveTranscriptFolder).onChange(async v => {
          this.plugin.settings.archiveTranscriptFolder = normalizePath(v.trim() || 'Transcripts');
          await this.plugin.saveSettings();
        }),
      );
  }

  /** Which of the features that used to be separate plugins are on. */
  /** Media kept on this device to play offline (see MediaCache). Per device: not synced. */
  private displayCache(containerEl: HTMLElement): void {
    const { cache } = this.plugin;
    if (!cache?.available) return;
    new Setting(containerEl).setName(t('library.cacheHeading')).setHeading();
    const prefs = cache.prefs;
    new Setting(containerEl)
      .setName(t('library.cacheAuto'))
      .setDesc(t('library.cacheAutoDesc'))
      .addToggle(toggle => toggle.setValue(prefs.auto).onChange(v => cache.setPrefs({ auto: v })));
    new Setting(containerEl)
      .setName(t('library.cacheLimit'))
      .setDesc(t('library.cacheLimitDesc'))
      .addDropdown(d => {
        for (const gb of [1, 2, 5, 10, 20, 50]) d.addOption(String(gb), `${gb} GB`);
        if (![1, 2, 5, 10, 20, 50].includes(prefs.limitGB)) d.addOption(String(prefs.limitGB), `${prefs.limitGB} GB`);
        d.setValue(String(prefs.limitGB)).onChange(v => {
          cache.setPrefs({ limitGB: Number(v) });
          this.display();
        });
      });
    const usage = cache.usage();
    new Setting(containerEl)
      .setName(t('library.cacheUsed', { used: formatSize(usage.total), limit: formatSize(cache.limit) }))
      .setDesc(t('library.cacheUsedDesc', { kept: formatSize(usage.kept), auto: formatSize(usage.auto), files: usage.files }))
      .addButton(b => b.setButtonText(t('library.cacheClearAuto')).onClick(async () => {
        await cache.clear('auto');
        this.display();
      }))
      .addButton(b => b.setButtonText(t('library.cacheClearAll')).setWarning().onClick(() => {
        new ConfirmModal(this.app, t('library.cacheClearAllTitle'), t('library.cacheClearAllDesc'), t('library.cacheClearAll'), async () => {
          await cache.clear('all');
          this.display();
        }).open();
      }));
  }

  private displayModuleSwitches(containerEl: HTMLElement): void {
    const modules = this.plugin.modules;
    if (!modules) return;
    new Setting(containerEl).setName(t('core.headingModules')).setHeading();
    let changed = false;
    const reload = new Setting(containerEl)
      .setName(t('core.settingReload'))
      .setDesc(t('core.settingReloadDesc'))
      .addButton(b => b.setButtonText(t('core.reloadButton')).setCta().onClick(() => { void this.reloadPlugin(); }));
    reload.settingEl.hide();
    for (const info of MODULES) {
      const setting = new Setting(containerEl).setName(info.name).setDesc(info.desc);
      const why = modules.skipped.get(info.key);
      if (why) setting.descEl.createDiv({ cls: 'mod-warning', text: why });
      setting.addToggle(toggle => {
        toggle.setValue(modules.chosen(info.key));
        toggle.onChange(async on => {
          await modules.setEnabled(info.key, on);
          if (!changed) {
            changed = true;
            reload.settingEl.show();
          }
        });
      });
    }
    // The switches above the button they apply with.
    containerEl.appendChild(reload.settingEl);
  }

  private async reloadPlugin(): Promise<void> {
    const plugins = (this.app as unknown as { plugins?: { disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<boolean> } }).plugins;
    const id = this.plugin.manifest.id;
    if (!plugins) {
      new Notice(t('core.reloadObsidian'));
      return;
    }
    await plugins.disablePlugin(id);
    await plugins.enablePlugin(id);
  }
}
