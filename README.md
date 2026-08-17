# Media Transcript

Play video/audio inside Obsidian with a **synchronized, clickable transcript** read from
a same-named subtitle file next to the media. Click any line to seek; the playing line
auto-highlights and scrolls into view.

> This is a **transcript player, not a transcriber** — it does not do speech-to-text.
> Transcripts are produced by external tools; drop a `.json` / `.srt` / `.vtt` next to
> your media and it just works.

## Features

- Opens `.mp4 / .m4a / .mp3 / …` and automatically loads a **same-named subtitle** in the
  same folder (`.json` / `.srt` / `.vtt`). If none exists, it shows a hint and does nothing else.
- **Video**: side-by-side layout — a large player on the left, transcript on the right, with a
  **draggable divider** (the ratio is remembered).
- **Audio**: a slim top control bar (title + player + speed) with a full-width transcript.
- **Playback speed** `0.75×–2×` (video and audio).
- **Click to seek, auto-highlight**: click a line to seek and play; the current line highlights.
- **Auto-scroll keeps the playing line centered** — not stuck at the bottom edge. Scrolling by
  hand pauses it for a few seconds so you can read ahead; click a line to resume immediately.
- **Adjustable transcript text size** — `A−` / `A+` in the transcript toolbar, or the slider in
  settings (10–32 px, remembered).
- Right-click menu: play from here / copy timestamp / copy text; click a timestamp to copy it.
- **Per-speaker labels** (colored `S0` / `S1` …) when a JSON transcript has 2+ speakers.
- Export the current transcript to a Markdown note.

## Installation

### Via BRAT

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. Command palette → `BRAT: Add a beta plugin for testing`.
3. Enter `semsevens/obsidian-media-transcript`.
4. Enable **Media Transcript** in Community plugins.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/semsevens/obsidian-media-transcript/releases) into
`<vault>/.obsidian/plugins/media-transcript/`, then enable the plugin.

### From source

```bash
npm install
npm run build
cp main.js manifest.json styles.css <vault>/.obsidian/plugins/media-transcript/
```

## Subtitle format

Place `<media-name>.<marker>.{json,srt,vtt}` next to the media, e.g. `lecture.mp4` →
`lecture.whisper.json`. JSON follows the Whisper `verbose_json` shape:

```json
{ "segments": [ { "start": 0.0, "end": 4.2, "text": "…", "speaker": 0 } ] }
```

## Settings

- **Subtitle folder** — leave empty to use each media file's own folder.
- **Subtitle priority** — order of filename `[marker]` tags when several subtitles exist.
- **Video pane width** — how much width the player takes in video mode (dragging the divider
  updates it too).
- **Transcript font size** — text size in px; the toolbar's `A−` / `A+` change the same value.
- **Auto-scroll transcript** — keep the playing line centered while playing (on by default).

If a media extension is already handled by Obsidian core or another plugin, use the
**Open in Media Transcript** file-menu item or the *Open current media file in transcript view*
command to open it in this view.

## License

MIT
