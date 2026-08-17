import { App, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { MediaTranscriptView, VIEW_TYPE_MEDIA_TRANSCRIPT } from './MediaTranscriptView';
import { MediaTranscriptSettingTab, DEFAULT_SETTINGS } from './settings';
import type { MediaTranscriptSettings } from './settings';
import { SUBTITLE_EXTENSIONS } from './utils/subtitleFinder';

// Subtitle extensions we globally register for click-to-open. Clicking any of
// these opens the transcript view, which reverse-resolves the matching media
// (video first, else audio) and plays it. `.json` is included: this reliably
// routes every `.json` here (a non-subtitle one just shows a "no media" hint),
// which is the tradeoff for click-to-play working every time — a conditional
// per-file takeover isn't possible since registration is per-extension.
const CLICKABLE_SUBTITLE_EXTS = SUBTITLE_EXTENSIONS;

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

    // Media extensions, plus subtitle extensions (.srt / .vtt / .json) so
    // clicking a subtitle opens here and reverse-resolves its media.
    for (const ext of [...this.mediaExts(), ...CLICKABLE_SUBTITLE_EXTS]) {
      try {
        this.registerExtensions([ext], VIEW_TYPE_MEDIA_TRANSCRIPT);
      } catch {
        // Owned by core/another plugin — take it over so it opens here.
        try {
          viewRegistry(this.app).unregisterExtensions([ext]);
          this.registerExtensions([ext], VIEW_TYPE_MEDIA_TRANSCRIPT);
        } catch {
          // Give up on this one; the command / file-menu below still works.
        }
      }
    }

    // Explicit "open in this view" — fallback for any extension we couldn't
    // take (and the only entry point for .json subtitles). Works for both
    // media files and subtitle files (which resolve to their media).
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && (this.isMedia(file) || this.isSubtitle(file))) {
          menu.addItem(item =>
            item
              .setTitle('Open in Media Transcript')
              .setIcon('play-circle')
              .onClick(() => { void this.openInView(file); }),
          );
        }
      }),
    );

    this.addCommand({
      id: 'open-current-media-file',
      name: 'Open current media file in transcript view',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || (!this.isMedia(file) && !this.isSubtitle(file))) {
          return false;
        }
        if (!checking) void this.openInView(file);
        return true;
      },
    });

    // Focus the transcript search box (bind a hotkey to it if you like).
    this.addCommand({
      id: 'search-transcript',
      name: 'Search transcript',
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(MediaTranscriptView);
        if (!view) return false;
        if (!checking) view.focusSearch();
        return true;
      },
    });

    this.addSettingTab(new MediaTranscriptSettingTab(this.app, this));
  }

  onunload() {
    // Release the extensions we took over (they stay registered otherwise).
    try {
      viewRegistry(this.app).unregisterExtensions([
        ...this.mediaExts(),
        ...CLICKABLE_SUBTITLE_EXTS,
      ]);
    } catch {
      // ignore
    }
  }

  /** Push the current transcript font size into every open transcript view. */
  applyFontSizeToOpenViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MEDIA_TRANSCRIPT)) {
      if (leaf.view instanceof MediaTranscriptView) {
        leaf.view.applyFontSize(this.settings.transcriptFontSize);
      }
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

  private isSubtitle(file: TFile): boolean {
    return SUBTITLE_EXTENSIONS.includes(file.extension.toLowerCase());
  }

  private async openInView(file: TFile) {
    const leaf = this.app.workspace.getLeaf(false);
    await this.swapLeafToView(leaf, file);
  }

  // Point an existing leaf at our transcript view for the given file.
  private async swapLeafToView(leaf: WorkspaceLeaf, file: TFile) {
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
