import { App, Plugin, TFile } from 'obsidian';
import { MediaTranscriptView, VIEW_TYPE_MEDIA_TRANSCRIPT } from './MediaTranscriptView';
import { MediaTranscriptSettingTab, DEFAULT_SETTINGS } from './settings';
import type { MediaTranscriptSettings } from './settings';

// Media extensions (mp3/mp4/…) are owned by Obsidian core, so `registerExtensions`
// throws for them. To open media in our transcript view we take them over via
// `viewRegistry.unregisterExtensions` — undocumented but stable, and used by
// directory plugins (Custom File Extensions, obsd.any). We register the same
// extensions and clean up on unload.
interface ViewRegistry {
  unregisterExtensions(exts: string[]): void;
}
function viewRegistry(app: App): ViewRegistry {
  return (app as unknown as { viewRegistry: ViewRegistry }).viewRegistry;
}

export default class MediaTranscriptPlugin extends Plugin {
  settings!: MediaTranscriptSettings;

  async onload() {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_MEDIA_TRANSCRIPT,
      leaf => new MediaTranscriptView(leaf, this),
    );

    for (const ext of this.mediaExts()) {
      try {
        this.registerExtensions([ext], VIEW_TYPE_MEDIA_TRANSCRIPT);
      } catch {
        // Owned by core/another plugin — take it over so media opens here.
        try {
          viewRegistry(this.app).unregisterExtensions([ext]);
          this.registerExtensions([ext], VIEW_TYPE_MEDIA_TRANSCRIPT);
        } catch {
          // Give up on this one; the command / file-menu below still works.
        }
      }
    }

    // Explicit "open in this view" — fallback for any extension we couldn't take.
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && this.isMedia(file)) {
          menu.addItem(item =>
            item
              .setTitle('Open in Media Transcript')
              .setIcon('play-circle')
              .onClick(() => this.openInView(file)),
          );
        }
      }),
    );

    this.addCommand({
      id: 'open-current-media-file',
      name: 'Open current media file in transcript view',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && this.isMedia(file);
        if (ok && !checking) this.openInView(file as TFile);
        return ok;
      },
    });

    this.addSettingTab(new MediaTranscriptSettingTab(this.app, this));
  }

  onunload() {
    // Release the extensions we took over (they stay registered otherwise).
    try {
      viewRegistry(this.app).unregisterExtensions(this.mediaExts());
    } catch {
      // ignore
    }
  }

  private mediaExts(): string[] {
    return [
      ...this.settings.supportedVideoExtensions,
      ...this.settings.supportedAudioExtensions,
    ];
  }

  private isMedia(file: TFile): boolean {
    const ext = file.extension.toLowerCase();
    return this.mediaExts().includes(ext);
  }

  private async openInView(file: TFile) {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_MEDIA_TRANSCRIPT,
      state: { file: file.path },
      active: true,
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
