import { App, PluginSettingTab, Setting } from 'obsidian';
import type MediaTranscriptPlugin from './main';
import { MediaTranscriptView, VIEW_TYPE_MEDIA_TRANSCRIPT } from './MediaTranscriptView';

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
  playerWidthPercent: 75,
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

    // ── Layout ──────────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Layout').setHeading();

    new Setting(containerEl)
      .setName('Video pane width')
      .setDesc(
        'How much horizontal space the video takes in video mode (the rest goes to the transcript). ' +
          '75% ≈ 3:1, 67% ≈ 2:1, 50% = 1:1. Dragging the divider updates this too. Audio mode is always full-width.',
      )
      .addSlider(s =>
        s
          .setLimits(20, 75, 1)
          .setValue(this.plugin.settings.playerWidthPercent)
          .setDynamicTooltip()
          .onChange(async v => {
            this.plugin.settings.playerWidthPercent = v;
            await this.plugin.saveSettings();
            // Live-apply to any open video views.
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MEDIA_TRANSCRIPT)) {
              if (leaf.view instanceof MediaTranscriptView) leaf.view.applyPlayerWidth(v);
            }
          }),
      );
  }
}
