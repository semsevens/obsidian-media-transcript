# Media Transcript

在 Obsidian 里打开音视频，配同目录的现成字幕，做**同步、可点击、跟读高亮**的转录阅读。

> **纯字幕播放器** —— 不含语音转文本。字幕由外部工具预先生成（推荐搭配
> [`local-asr`](../local-asr)：本地 VibeVoice-ASR 批量转录，输出 `<名字>.<模型>.json`）。

## 功能

- 打开 `.mp4/.m4a/.mp3/…`，自动读取**同目录同名字幕**（`json` / `srt` / `vtt`）；
  没有就提示、不做其它动作
- **视频**：左右并排 —— 大播放器 + 右侧字幕，中间**分隔线可拖动**（记住比例）
- **音频**：顶部细控制条（🎵 标题 + 播放器 + 倍速）+ 整宽字幕
- **倍速播放** `0.75~2x`（视频音频通用）
- **点句跳转、跟读高亮**：点段落 seek+play，播放到哪句自动高亮并滚动
- 右键菜单：从此处播放 / 复制时间戳 / 复制文字；点时间块复制时间戳
- 导出当前字幕为 Markdown 笔记

## 安装

### 通过 BRAT（推荐，待上架社区插件前）

1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件
2. 命令面板 → `BRAT: Add a beta plugin for testing`
3. 填入本仓库地址 `semsevens/obsidian-media-transcript`
4. 在「设置 → 第三方插件」启用 **Media Transcript**

### 手动

从 [最新 Release](https://github.com/semsevens/obsidian-media-transcript/releases) 下载
`main.js` / `manifest.json` / `styles.css`，放进
`<vault>/.obsidian/plugins/obsidian-media-transcript/`，再启用。

### 从源码构建

```bash
npm install
npm run build          # 生成 main.js
cp main.js manifest.json styles.css <vault>/.obsidian/plugins/obsidian-media-transcript/
```

启用后打开任意音视频即可。

## 发布（维护者）

版本号在 `manifest.json` / `package.json` / `versions.json` 三处保持一致，然后打
**不带 `v` 前缀**的 tag，GitHub Actions 会自动构建并发布 Release：

```bash
git tag 1.0.1 && git push origin 1.0.1
```

## 字幕格式

同目录放 `<媒体名>.<标记>.{json,srt,vtt}`，例如 `讲座.mp4` → `讲座.vibevoice-4bit.json`。

JSON 结构（兼容 local-asr / Whisper verbose_json）：

```json
{ "segments": [ { "start": 0.0, "end": 4.2, "text": "……" } ] }
```

## 设置

- **字幕目录**：留空 = 与媒体同目录
- **字幕优先级**：多字幕并存时按文件名 `[标记]` 排序（逗号分隔）
- **播放器宽度**：视频左栏比例，拖动分隔线后自动记住

更多设计细节见 [`docs/architecture.md`](docs/architecture.md)。
