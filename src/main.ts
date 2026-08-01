import { Plugin } from 'obsidian';
import { MediaTranscriptView, VIEW_TYPE_MEDIA_TRANSCRIPT } from './MediaTranscriptView';
import { MediaTranscriptSettingTab, DEFAULT_SETTINGS } from './settings';
import type { MediaTranscriptSettings } from './settings';

export default class MediaTranscriptPlugin extends Plugin {
  settings: MediaTranscriptSettings;

  async onload() {
    await this.loadSettings();

    // Register our custom view
    this.registerView(
      VIEW_TYPE_MEDIA_TRANSCRIPT,
      leaf => new MediaTranscriptView(leaf, this),
    );

    // Associate media file extensions with this view.
    // Register each extension individually and tolerate conflicts: if another
    // plugin already owns an extension, Obsidian throws — skip it instead of
    // failing the whole plugin load.
    const allExts = [
      ...this.settings.supportedVideoExtensions,
      ...this.settings.supportedAudioExtensions,
    ];
    for (const ext of allExts) {
      try {
        this.registerExtensions([ext], VIEW_TYPE_MEDIA_TRANSCRIPT);
      } catch (e) {
        // Another plugin (or core) already owns this extension — take it over so
        // media files open in our transcript view.
        try {
          (this.app as any).viewRegistry.unregisterExtensions([ext]);
          this.registerExtensions([ext], VIEW_TYPE_MEDIA_TRANSCRIPT);
        } catch (e2) {
          console.warn(`[Media Transcript] 无法接管扩展名 .${ext}`, e2);
        }
      }
    }

    // Settings tab
    this.addSettingTab(new MediaTranscriptSettingTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_MEDIA_TRANSCRIPT);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
