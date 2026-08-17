# 插件架构

> 定位：**纯字幕播放器**。在 Obsidian 里打开音视频，读取同目录的现成字幕
> （`json` / `srt` / `vtt`）做同步、可点击、跟读高亮。**不含任何语音转文本功能**
> —— 字幕由外部工具（如 `local-asr`）预先生成。

## 文件结构

```
obsidian-media-transcript/
├── manifest.json           # Obsidian 插件元信息
├── package.json
├── tsconfig.json
├── esbuild.config.mjs      # 构建配置
├── styles.css              # 所有 UI 样式
├── main.js                 # 构建产物（发布/部署用）
├── src/
│   ├── main.ts             # 插件入口：注册视图、接管媒体扩展名、设置页
│   ├── MediaTranscriptView.ts  # 主视图（播放器 + 字幕面板 + 交互）
│   ├── settings.ts         # 设置类型 + 设置页面 UI
│   └── utils/
│       ├── subtitleFinder.ts   # 按命名约定查找字幕文件
│       └── subtitleParser.ts   # 解析 SRT / VTT / JSON
└── docs/
    └── architecture.md     # 本文件
```

## 数据流

```
用户打开 .mp4 / .m4a / .mp3 …
       ↓
MediaTranscriptView.onLoadFile()
       ↓  isVideo?
   ┌───────────────┴────────────────┐
   视频：左右并排                    音频：顶部细控制条
   playerSide(可拖分隔线) + transcript   audioBar(🎵+播放器+倍速) + 整宽 transcript
       └───────────────┬────────────────┘
       ↓
  findSubtitleFiles()  ──→  同目录按 [name].[marker].[ext] 扫 vault
       ↓
  resolvePriority()    ──→  排序（首项自动加载；当前为直通，可扩展）
       ↓
  loadTrack() → 读文件 → parseSubtitle() → renderSegments()
       ↓
  HTML5 media 元素            字幕段落列表
    timeupdate ──────────────→ syncHighlight()（高亮当前段 + 居中滚动）
```

若同目录没有对应字幕 → 显示"未找到字幕"提示，不做其它动作。

## 布局与交互

- **视频**：播放器在左（填满栏宽、`max-height:75vh`、吸顶），字幕在右；中间
  `.mt-divider` 可拖动调整比例，结果存入 `settings.playerWidthPercent`（默认 75%，设置页也有滑杆）。
- **音频**：无画面 → 顶部一条 `.mt-audio-bar`（🎵 标题 + 原生播放器 + 倍速），
  字幕占满整宽。
- **倍速**：`0.75/1/1.25/1.5/2x`，设置 `mediaEl.playbackRate`（视频音频通用）。
- **字号**：字幕工具栏 `A− / A+`（步进 1px，范围 10–32），写入
  `settings.transcriptFontSize`，通过 `.mt-transcript` 上的 `--mt-font-size`
  行内变量生效；时间戳/说话人小块用 `em` 相对缩放。设置页滑杆改的是同一个值，
  两处都会 `applyFontSizeToOpenViews()` 实时应用到所有已打开视图。
- **自动滚动**：`scrollActiveIntoCenter()` 把当前段滚到面板**垂直居中**
  （用 `offsetTop`，因此 `.mt-transcript` 必须 `position: relative`；末尾
  `padding-bottom: 40vh` 让最后几段也能居中）。用户 `wheel/touchmove` 手动滚动后
  暂停 4s（`MANUAL_SCROLL_GRACE_MS`），点击段落立即恢复；可用
  `settings.autoScroll` 整体关闭（关闭后仍高亮）。
- **搜索**：工具栏下面一行 `.mt-searchbar`（输入框 + `n/m` 计数 + ↑/↓）。
  `applySearch()` 大小写不敏感的子串匹配（CJK 同样可用），把命中段的 `.mt-txt`
  重建成「纯文本 + `span.mt-hit`」交替结构（不用 innerHTML）；`clearHighlights()`
  按 `highlightedSegs` 还原原文。命中列表 `hitEls` 扁平存放每一处，
  `gotoHit()` 标 `.mt-hit-current` 并把所在段滚到居中，同时刷新
  `manualScrollUntil` 避免播放把视图拽走。首次跳转从**当前播放段**往后找，
  找不到就回到第一处；切轨/重渲染后会用当前关键词重跑一次。
  命令 `search-transcript` → `focusSearch()`（可自行绑快捷键）。
- **视频 ⇄ 纯音频**：`settings.videoAudioOnly`（工具栏 🎧/🎬 按钮 + 设置页开关）。
  `buildLayout()` 按当前模式搭布局，`transcriptSideEl` 整列**移动复用**，
  所以切换不重新解析字幕、不丢搜索结果和滚动位置；`rebuildPlayer()` 只换播放器，
  把 `currentTime / playbackRate / paused` 搬过去（新元素 `readyState === 0` 时
  推迟到 `loadedmetadata` 再 seek）。纯音频模式用 `<audio>` 播视频文件（同一套解码器），
  万一某容器不支持会触发 `error` → Notice 提示并自动退回视频模式。
- **交互**：左键点段落 → seek+play；右键 → 菜单（从此处播放 / 复制时间戳 / 复制文字）；
  点左侧时间块 → 复制时间戳；hover 仅高亮，不弹按钮（不影响布局）。
- **扩展名接管**：`main.ts` 逐个 `registerExtensions`，被其他插件占用时先
  `unregisterExtensions` 再接管，避免冲突导致加载失败。

## 字幕文件命名约定

Pattern：`{mediaBasename}[.{marker}].{subExt}`

| 例子 | marker | subExt |
|------|--------|--------|
| `video.srt` | `""` (空) | `srt` |
| `video.vibevoice-4bit.json` | `vibevoice-4bit` | `json` |
| `video.en.vtt` | `en` | `vtt` |

搜索目录：`settings.subtitleDirectory`，留空则为媒体文件同目录。

## 支持的字幕格式

| 格式 | 扩展名 | 说明 |
|------|--------|------|
| SubRip | `.srt` | 最通用，时间码精确到毫秒 |
| WebVTT | `.vtt` | Web 标准，支持样式标签（自动剥离）|
| JSON | `.json` | `{segments:[{start,end,text}]}`（兼容 local-asr / Whisper verbose_json；speaker 字段忽略）|

## 待实现 / 可扩展

- [ ] `resolvePriority()` 目前为直通，可按 marker 优先级排序（多字幕并存时选默认）
- [ ] 键盘快捷键（空格暂停/继续，左右箭头跳句）
- [ ] 在字幕里显示说话人 `[S0]` 前缀（parseJSON 读出 speaker 即可）
