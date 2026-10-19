/** Text shown by the core part of the plugin. Keys start with "core.". */
const en = {
  'core.mediaOne': 'Media One',

  // Commands, ribbon and menus
  'core.ribbonLibrary': 'Media library',
  'core.cmdOpenLibrary': 'Open media library',
  'core.cmdUploadCurrent': 'Upload current media file to the server',
  'core.cmdOpenCurrentMedia': 'Open current media file in transcript view',
  'core.cmdSearchTranscript': 'Search transcript',
  'core.cmdInsertTimestampLink': 'Insert link to current playback time',
  'core.cmdLinkTranscriptMedia': 'Link transcript to its audio/video',
  'core.menuOpenInMediaOne': 'Open in Media One',
  'core.menuUploadToServer': 'Upload to Media One server',

  // Notices
  'core.noMediaAnywhere': 'No audio/video found in the vault, media folders or on a server.',
  'core.renamedTranscriptsOne': 'Renamed {n} transcript to match {name}',
  'core.renamedTranscriptsMany': 'Renamed {n} transcripts to match {name}',
  'core.keptTranscripts': 'Kept {names}: a file with the new name already exists.',
  'core.uploadUnreachable': 'Could not upload {name} now; the server cannot be reached.',
  'core.uploadDone': '{name} is on the Media One server',

  // Embeds and cards
  'core.openTranscriptBeside': 'Open the transcript beside this note',
  'core.transcriptButton': 'Transcript',
  'core.lookingForMedia': 'Looking for audio/video…',
  'core.noMediaTranscriptOnly': 'No audio/video found · transcript only · ',
  'core.retry': 'Retry',
  'core.linkMediaPlaceholder': 'Which audio/video is this transcript for?',

  // Where media was looked for
  'core.searchedUnreachable': '{place} (unreachable)',
  'core.searchedSameFolder': 'same folder ({dir})',
  'core.searchedDevice': 'kept on this device',
  'core.searchedVault': 'vault ({name})',
  'core.searchedDesktopOnly': '{place} (skipped: desktop only)',
  'core.searchedUnavailable': '{place} (unavailable)',

  // Transcript view
  'core.notASubtitle': '"{name}" isn\'t a subtitle file.\n' +
    'This view opens .srt / .vtt / .json subtitles. ' +
    'All .json files open here because extensions are claimed whole, not per file.',
  'core.modeVideo': '🎬 Video',
  'core.modeAudioOnly': '🎧 Audio only',
  'core.modeVideoTitle': 'Show the video picture again',
  'core.modeAudioOnlyTitle': 'Hide the picture and just play the audio',
  'core.mediaLoadFailed': 'Can\'t load the media from {location}. The transcript is still readable.',
  'core.audioOnlyFailed': 'This video cannot be played as audio only — showing the picture again.',
  'core.noMediaReadingOnly': 'No audio/video found · reading only',
  'core.lookedIn': 'Looked in:\n{places}\n\nAdd folders under Settings → Media One → Media folders.',
  'core.linkMediaButton': 'Link media…',
  'core.linkMediaAria': 'Pick the audio/video this transcript belongs to',
  'core.speed': 'Speed',
  'core.subtitleLabel': 'Subtitle:',
  'core.fontSmaller': 'Smaller transcript text',
  'core.fontLarger': 'Larger transcript text',
  'core.exportMd': 'Export MD',
  'core.exportMdTitle': 'Export the current transcript as a Markdown note',
  'core.searchPlaceholder': 'Search transcript…',
  'core.prevMatch': 'Previous match (Shift+Enter)',
  'core.nextMatch': 'Next match (Enter)',
  'core.noSubtitlesOption': '(no subtitles)',
  'core.cannotReadSubtitle': 'Cannot read subtitle file: {error}',
  'core.subtitleEmpty': 'Subtitle file is empty or could not be parsed.',
  'core.noSubtitleFound': 'No subtitle found.\nPlace a same-named .json / .srt / .vtt file in the same folder.',
  'core.playFromHere': 'Play from here',
  'core.noMediaToPlay': 'No audio/video to play',
  'core.copyTimestamp': 'Copy timestamp',
  'core.copyTimestampLink': 'Copy timestamp link',
  'core.copyText': 'Copy text',
  'core.nothingToExport': 'Nothing to export.',
  'core.exportedTo': 'Exported to {path}',
  'core.exportFailed': 'Export failed: {error}',

  // Settings
  'core.headingSubtitles': 'Subtitles',
  'core.settingSubtitleFolder': 'Subtitle folder',
  'core.settingSubtitleFolderDesc': 'Leave empty to use each media file\'s own folder (reads a same-named .json / .srt / .vtt).',
  'core.settingSubtitleFolderPlaceholder': 'Empty = media file\'s folder',
  'core.settingSubtitlePriority': 'Subtitle priority',
  'core.settingSubtitlePriorityDesc': 'Order of filename [marker] tags, comma-separated (empty = no marker, e.g. video.srt).',
  'core.headingMedia': 'Media',
  'core.settingMediaFolders': 'Media folders',
  'core.settingMediaFoldersDesc': 'Where to find a transcript\'s audio/video when it isn\'t in the transcript\'s own folder. ' +
    'One folder per line, searched in order, subfolders included; matched by filename. ' +
    'A vault folder (附件/media) or, on desktop, an absolute folder outside the vault ' +
    '(/Volumes/2T/Media, ~/Recordings). With no media found, the transcript opens for reading only.',
  'core.settingRemoteUrls': 'Remote media URLs',
  'core.settingRemoteUrlsDesc': 'Searched after the folders above: a server holding the media, streamed with seeking — ' +
    'e.g. a home computer over Tailscale (https://old-mac.example.ts.net/recordings). ' +
    'One URL per line. A server with an index.json (written by the offload script) can keep files ' +
    'in any folders; otherwise files are expected directly under the URL, by name. ' +
    'If a server doesn\'t answer within 5 seconds, the transcript opens for reading only.',
  'core.settingPreferRemote': 'Play from a server first',
  'core.settingPreferRemoteDesc': 'Look for media on the servers above before the vault and media folders, and use the vault copy ' +
    'only when no server has it or none answers. Useful when local copies live in iCloud and ' +
    'would have to download before playing.',
  'core.headingLayout': 'Layout',
  'core.settingVideoWidth': 'Video pane width',
  'core.settingVideoWidthDesc': 'How much horizontal space the video takes in video mode (the rest goes to the transcript). ' +
    '75% ≈ 3:1, 67% ≈ 2:1, 50% = 1:1. Dragging the divider updates this too. Audio mode is always full-width.',
  'core.settingFontSize': 'Transcript font size',
  'core.settingFontSizeDesc': 'Text size of the transcript, in pixels ({min}–{max}). ' +
    'The A− / A+ buttons in the transcript toolbar change this too.',
  'core.headingPlayback': 'Playback',
  'core.settingAutoScroll': 'Auto-scroll transcript',
  'core.settingAutoScrollDesc': 'While playing, keep the current line vertically centered. ' +
    'Scrolling by hand pauses this for a few seconds so you can read ahead.',
  'core.settingAudioOnly': 'Play videos as audio only',
  'core.settingAudioOnlyDesc': 'Don\'t show the picture for video files — a slim control bar and a full-width ' +
    'transcript instead. The 🎧 / 🎬 button in the transcript toolbar toggles this per view.',
  'core.settingServer': 'Media One server',
  'core.settingServerDesc': 'Where your media lives, reached over Tailscale or your network. Recordings are read from ' +
    '<server>/library and the web image archive is shared through <server>/archive; ' +
    'both are added to the lists below, first. Leave empty to use only those lists.',
  'core.save': 'Save',
  'core.serverSet': 'Media One server: {url}',
  'core.serverRemoved': 'Media One server removed.',
  'core.settingUploadNew': 'Upload new media to the server',
  'core.originNotes': 'In notes:',
  'core.retryFindMedia': 'Look again',
  'core.originNone': 'no note shows it now',
  'core.settingServerVault': 'Vault name on the server',
  'core.settingServerVaultDesc': "This vault's folder in the server's library. Empty: the vault's name here ({name}). Set it when a device names its copy of the vault otherwise, so all of them use one folder.",
  'core.settingArchiveTranscripts': 'Transcripts of archived videos',
  'core.settingArchiveTranscriptsDesc': 'Folder for the transcripts of web videos kept in the archive (they have no file in the vault to sit beside). Each is named after the note it was asked from.',
  'core.settingUploadNewDesc': 'Recordings and videos added to the vault are uploaded to the server right away (checked by sha256), ' +
    'so every device can play them. The file stays in the vault. Without a connection it waits and is ' +
    'retried every 10 minutes.',
  'core.settingUploadNewDescWaiting': 'Recordings and videos added to the vault are uploaded to the server right away (checked by sha256), ' +
    'so every device can play them. The file stays in the vault. Without a connection it waits and is ' +
    'retried every 10 minutes. Waiting on this device: {n}.',
  'core.headingModules': 'Modules',
  'core.settingReload': 'Reload to apply',
  'core.settingReloadDesc': 'Modules switched on or off start or stop when Media One reloads.',
  'core.reloadButton': 'Reload Media One',
  'core.reloadObsidian': 'Reload Obsidian to apply the change.',
} as const;

const zh: Partial<Record<keyof typeof en, string>> = {
  'core.mediaOne': 'Media One',

  'core.ribbonLibrary': '媒体库',
  'core.cmdOpenLibrary': '打开媒体库',
  'core.cmdUploadCurrent': '上传当前媒体文件到服务器',
  'core.cmdOpenCurrentMedia': '在转录稿视图中打开当前媒体文件',
  'core.cmdSearchTranscript': '搜索转录稿',
  'core.cmdInsertTimestampLink': '插入当前播放时间的链接',
  'core.cmdLinkTranscriptMedia': '为转录稿关联音频/视频',
  'core.menuOpenInMediaOne': '在 Media One 中打开',
  'core.menuUploadToServer': '上传到 Media One 服务器',

  'core.noMediaAnywhere': '在库、媒体文件夹和服务器中都没有找到音频/视频。',
  'core.renamedTranscriptsOne': '已重命名 {n} 个转录稿以匹配 {name}',
  'core.renamedTranscriptsMany': '已重命名 {n} 个转录稿以匹配 {name}',
  'core.keptTranscripts': '保留了 {names}：使用新名称的文件已存在。',
  'core.uploadUnreachable': '暂时无法上传 {name}：无法连接服务器。',
  'core.uploadDone': '{name} 已在 Media One 服务器上',

  'core.openTranscriptBeside': '在此笔记旁打开转录稿',
  'core.transcriptButton': '转录稿',
  'core.lookingForMedia': '正在查找音频/视频…',
  'core.noMediaTranscriptOnly': '未找到音频/视频 · 仅转录稿 · ',
  'core.retry': '重试',
  'core.linkMediaPlaceholder': '这份转录稿对应哪个音频/视频？',

  'core.searchedUnreachable': '{place}（无法连接）',
  'core.searchedSameFolder': '同一文件夹（{dir}）',
  'core.searchedDevice': '本机缓存',
  'core.searchedVault': '库（{name}）',
  'core.searchedDesktopOnly': '{place}（已跳过：仅限桌面端）',
  'core.searchedUnavailable': '{place}（不可用）',

  'core.notASubtitle': '“{name}”不是字幕文件。\n' +
    '此视图用于打开 .srt / .vtt / .json 字幕。' +
    '由于扩展名只能整体接管、无法按文件区分，所有 .json 文件都会在这里打开。',
  'core.modeVideo': '🎬 视频',
  'core.modeAudioOnly': '🎧 仅音频',
  'core.modeVideoTitle': '重新显示视频画面',
  'core.modeAudioOnlyTitle': '隐藏画面，只播放音频',
  'core.mediaLoadFailed': '无法从 {location} 加载媒体。转录稿仍可阅读。',
  'core.audioOnlyFailed': '此视频无法仅以音频播放，已恢复显示画面。',
  'core.noMediaReadingOnly': '未找到音频/视频 · 仅阅读',
  'core.lookedIn': '已查找：\n{places}\n\n可在“设置 → Media One → 媒体文件夹”中添加文件夹。',
  'core.linkMediaButton': '关联媒体…',
  'core.linkMediaAria': '选择此转录稿对应的音频/视频',
  'core.speed': '倍速',
  'core.subtitleLabel': '字幕：',
  'core.fontSmaller': '缩小转录稿文字',
  'core.fontLarger': '放大转录稿文字',
  'core.exportMd': '导出 MD',
  'core.exportMdTitle': '将当前转录稿导出为 Markdown 笔记',
  'core.searchPlaceholder': '搜索转录稿…',
  'core.prevMatch': '上一个匹配（Shift+Enter）',
  'core.nextMatch': '下一个匹配（Enter）',
  'core.noSubtitlesOption': '（无字幕）',
  'core.cannotReadSubtitle': '无法读取字幕文件：{error}',
  'core.subtitleEmpty': '字幕文件为空或无法解析。',
  'core.noSubtitleFound': '未找到字幕。\n请在同一文件夹中放置同名的 .json / .srt / .vtt 文件。',
  'core.playFromHere': '从这里播放',
  'core.noMediaToPlay': '没有可播放的音频/视频',
  'core.copyTimestamp': '复制时间戳',
  'core.copyTimestampLink': '复制时间戳链接',
  'core.copyText': '复制文本',
  'core.nothingToExport': '没有可导出的内容。',
  'core.exportedTo': '已导出到 {path}',
  'core.exportFailed': '导出失败：{error}',

  'core.headingSubtitles': '字幕',
  'core.settingSubtitleFolder': '字幕文件夹',
  'core.settingSubtitleFolderDesc': '留空则使用各媒体文件所在的文件夹（读取同名的 .json / .srt / .vtt）。',
  'core.settingSubtitleFolderPlaceholder': '留空 = 媒体文件所在文件夹',
  'core.settingSubtitlePriority': '字幕优先级',
  'core.settingSubtitlePriorityDesc': '文件名中 [标记] 的优先顺序，用逗号分隔（留空 = 无标记，如 video.srt）。',
  'core.headingMedia': '媒体',
  'core.settingMediaFolders': '媒体文件夹',
  'core.settingMediaFoldersDesc': '转录稿的音频/视频不在转录稿所在文件夹时，到这些文件夹查找。' +
    '每行一个文件夹，按顺序搜索，包含子文件夹；按文件名匹配。' +
    '可以是库中的文件夹（附件/media），在桌面端也可以是库外的绝对路径' +
    '（/Volumes/2T/Media、~/Recordings）。找不到媒体时，转录稿以只读方式打开。',
  'core.settingRemoteUrls': '远程媒体 URL',
  'core.settingRemoteUrlsDesc': '在上述文件夹之后搜索：存放媒体的服务器，以可拖动进度的流式方式播放，' +
    '例如通过 Tailscale 访问家里的电脑（https://old-mac.example.ts.net/recordings）。' +
    '每行一个 URL。带有 index.json（由 offload 脚本生成）的服务器可以把文件放在任意文件夹；' +
    '否则文件需按文件名直接位于该 URL 下。' +
    '服务器 5 秒内没有响应时，转录稿以只读方式打开。',
  'core.settingPreferRemote': '优先从服务器播放',
  'core.settingPreferRemoteDesc': '先在上述服务器上查找媒体，再查找库和媒体文件夹；只有在没有服务器存有该文件或都无响应时，' +
    '才使用库中的副本。适用于本地副本存放在 iCloud、播放前需要先下载的情况。',
  'core.headingLayout': '布局',
  'core.settingVideoWidth': '视频窗格宽度',
  'core.settingVideoWidthDesc': '视频模式下视频所占的水平空间（其余留给转录稿）。' +
    '75% ≈ 3:1，67% ≈ 2:1，50% = 1:1。拖动分隔条也会更新此值。音频模式始终为全宽。',
  'core.settingFontSize': '转录稿字号',
  'core.settingFontSizeDesc': '转录稿的文字大小，单位为像素（{min}–{max}）。' +
    '转录稿工具栏中的 A− / A+ 按钮也会更改此值。',
  'core.headingPlayback': '播放',
  'core.settingAutoScroll': '转录稿自动滚动',
  'core.settingAutoScrollDesc': '播放时让当前行保持垂直居中。' +
    '手动滚动会让它暂停几秒，方便往后阅读。',
  'core.settingAudioOnly': '视频仅播放音频',
  'core.settingAudioOnlyDesc': '视频文件不显示画面，改为精简的控制栏和全宽的转录稿。' +
    '转录稿工具栏中的 🎧 / 🎬 按钮可在单个视图中切换。',
  'core.settingServer': 'Media One 服务器',
  'core.settingServerDesc': '存放媒体的服务器，通过 Tailscale 或你的网络访问。录音从 ' +
    '<server>/library 读取，网页图片存档通过 <server>/archive 共享；' +
    '两者都会加到下方列表的最前面。留空则只使用这些列表。',
  'core.save': '保存',
  'core.serverSet': 'Media One 服务器：{url}',
  'core.serverRemoved': '已移除 Media One 服务器。',
  'core.settingUploadNew': '上传新媒体到服务器',
  'core.originNotes': '出自笔记：',
  'core.retryFindMedia': '重新查找',
  'core.originNone': '目前没有笔记引用它',
  'core.settingServerVault': '服务器上的库名',
  'core.settingServerVaultDesc': '这个库在服务器媒体库里的文件夹名。留空则用本设备上的库名（{name}）。如果某台设备上这个库的名字不一样（比如手机上叫别的名字），就填上同一个名字，让所有设备用同一个文件夹。',
  'core.settingArchiveTranscripts': '归档视频的转录稿',
  'core.settingArchiveTranscriptsDesc': '存放归档网页视频转录稿的文件夹（这些视频不在库里，转录稿没有地方挨着放）。转录稿以发起转文字的笔记命名。',
  'core.settingUploadNewDesc': '添加到库中的录音和视频会立即上传到服务器（按 sha256 校验），' +
    '让每台设备都能播放。文件仍保留在库中。没有网络时会等待，' +
    '并每 10 分钟重试一次。',
  'core.settingUploadNewDescWaiting': '添加到库中的录音和视频会立即上传到服务器（按 sha256 校验），' +
    '让每台设备都能播放。文件仍保留在库中。没有网络时会等待，' +
    '并每 10 分钟重试一次。本设备待上传：{n} 个。',
  'core.headingModules': '模块',
  'core.settingReload': '重新加载以生效',
  'core.settingReloadDesc': '开启或关闭的模块会在 Media One 重新加载时启动或停止。',
  'core.reloadButton': '重新加载 Media One',
  'core.reloadObsidian': '请重新加载 Obsidian 以应用更改。',
};

export default { en, zh };
