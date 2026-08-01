import { App, PluginSettingTab, Setting } from 'obsidian';
import type MediaTranscriptPlugin from './main';

export interface SubtitlePriority {
  marker: string;
  label: string;
}

export interface MediaTranscriptSettings {
  // ── Subtitle matching ────────────────────────────────────────────────────
  subtitleDirectory: string;
  priorities: SubtitlePriority[];

  // ── Media file types ─────────────────────────────────────────────────────
  supportedVideoExtensions: string[];
  supportedAudioExtensions: string[];

  // ── Layout ───────────────────────────────────────────────────────────────
  playerWidthPercent: number; // video 左侧播放器宽度(%)，拖动分隔线后记住
}

export const DEFAULT_SETTINGS: MediaTranscriptSettings = {
  subtitleDirectory: '',
  priorities: [{ marker: '', label: '默认（无标记）' }],
  supportedVideoExtensions: ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v'],
  supportedAudioExtensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus'],
  playerWidthPercent: 48,
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
    containerEl.createEl('h2', { text: 'Media Transcript' });

    // ── Subtitle ────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: '字幕文件' });

    new Setting(containerEl)
      .setName('字幕目录')
      .setDesc('留空 = 与媒体文件同目录（默认读取同目录下的同名 .json / .srt / .vtt）')
      .addText(t =>
        t.setPlaceholder('留空 = 与媒体文件同目录')
          .setValue(this.plugin.settings.subtitleDirectory)
          .onChange(async v => {
            this.plugin.settings.subtitleDirectory = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('字幕优先级')
      .setDesc('文件名 [xx] 标记的优先顺序，逗号分隔（空值 = 无标记，如 video.srt）')
      .addText(t =>
        t.setPlaceholder('vibevoice-4bit, whisper,')
          .setValue(this.plugin.settings.priorities.map(p => p.marker).join(', '))
          .onChange(async v => {
            const markers = v.split(',').map(s => s.trim()).filter((m, i, a) => a.indexOf(m) === i);
            this.plugin.settings.priorities = markers.map(m => ({ marker: m, label: m || '默认' }));
            await this.plugin.saveSettings();
          }),
      );
  }
}
