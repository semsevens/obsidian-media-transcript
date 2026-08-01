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
  playerWidthPercent: number; // video: left player width (%), remembered after dragging the divider
}

export const DEFAULT_SETTINGS: MediaTranscriptSettings = {
  subtitleDirectory: '',
  priorities: [{ marker: '', label: 'Default (no marker)' }],
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

    // Obsidian shows the plugin name as the heading automatically.
    new Setting(containerEl).setName('Subtitles').setHeading();

    new Setting(containerEl)
      .setName('Subtitle folder')
      .setDesc("Leave empty to use each media file's own folder (reads a same-named .json / .srt / .vtt).")
      .addText(t =>
        t.setPlaceholder("Empty = media file's folder")
          .setValue(this.plugin.settings.subtitleDirectory)
          .onChange(async v => {
            this.plugin.settings.subtitleDirectory = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Subtitle priority')
      .setDesc('Order of filename [marker] tags, comma-separated (empty = no marker, e.g. video.srt).')
      .addText(t =>
        t.setPlaceholder('vibevoice-4bit, whisper,')
          .setValue(this.plugin.settings.priorities.map(p => p.marker).join(', '))
          .onChange(async v => {
            const markers = v.split(',').map(s => s.trim()).filter((m, i, a) => a.indexOf(m) === i);
            this.plugin.settings.priorities = markers.map(m => ({ marker: m, label: m || 'Default' }));
            await this.plugin.saveSettings();
          }),
      );
  }
}
