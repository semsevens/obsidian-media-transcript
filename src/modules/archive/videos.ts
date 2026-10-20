import { Menu, Notice, Platform, TFile, requestUrl, setIcon } from "obsidian";
import type ArchiveRedirectPlugin from "./main";
import type MediaTranscriptPlugin from "../../main";
import { download } from "./downloader";
import { isVideoUrl } from "./policies";
import { archiveName, resolve } from "./resolver";
import { extractUrls } from "./scanner";
import { storeFor } from "./store";
import { formatSize } from "../../utils/format";
import { ASK_PIECE, streamSource, uploadInPieces } from "../../library/pieceUpload";
import { t } from "../../i18n";

// Kept whole in memory on its way, a video is limited to what a phone can hold.
// Larger, and with a Media One server, it goes from the web to the server as a
// stream, a piece at a time, whatever its size.
const PHONE_MAX_BYTES = 500 * 1024 * 1024;
const STREAM_FROM = 64 * 1024 * 1024;
const VIDEO_TIMEOUT_MS = 30 * 60_000;
const RECHECK_MS = 60_000;

type State = "unknown" | "remote" | "downloading" | "archived";

/**
 * Videos linked from notes (`![](https://…/clip.mp4)`), shown as players with
 * a bar under each to keep a copy in the archive. Obsidian shows such a link
 * as an image that can't play, so the image is swapped for a <video>; the
 * archive's redirect then plays the archived copy once there is one.
 *
 * Videos are archived only when asked: on the device that asks, which uploads
 * the copy to the servers. The note is left as it is. An archived video can
 * then be transcribed on the Media One server; the transcript comes to the
 * vault's transcripts folder and the bar opens it.
 */
export class VideoEmbeds {
	private states = new Map<string, State>();
	/** When each video's state was last asked of the servers: asked again after a while (it may be deleted meanwhile). */
	private checkedAt = new Map<string, number>();
	/** The bars on screen, by video URL, to update them all when one is downloaded. */
	private bars = new Map<string, Set<HTMLElement>>();

	constructor(private plugin: ArchiveRedirectPlugin) {}

	private get core(): MediaTranscriptPlugin {
		return this.plugin.hostPlugin as MediaTranscriptPlugin;
	}

	start(): void {
		const { plugin } = this;
		this.sendNoReferrer();
		// A transcript arriving, or a job moving on, shows on the bars.
		plugin.registerEvent(plugin.app.vault.on("create", (f) => {
			if (f.path.endsWith(".json")) window.setTimeout(() => this.repaintAll(), 1500);
		}));
		plugin.registerInterval(window.setInterval(() => this.repaintAll(), 30_000));
		this.core.transcriptSync.onJobs(() => this.repaintAll());
		plugin.addCommand({
			id: "archive-download-videos",
			name: t("archive.commandDownloadVideos"),
			checkCallback: (checking) => {
				const file = plugin.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.downloadAll(file);
				return true;
			},
		});
		plugin.registerDomEvent(document, "contextmenu", (e) => {
			const box = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(".mo-video");
			const url = box?.dataset.url;
			if (!box || !url) return;
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle(t("archive.videoDownload"))
					.setIcon("download")
					.setDisabled(this.states.get(url) !== "remote")
					.onClick(() => void this.downloadOne(url, box.dataset.note ?? "")),
			);
			menu.showAtMouseEvent(e);
			e.preventDefault();
		});
	}

	/**
	 * Turn the remote video links under `root` into players with a bar. In
	 * Reading mode the image is replaced; in Live Preview it belongs to the
	 * editor, so it is hidden and the player put before it.
	 */
	decorate(root: HTMLElement, sourcePath: string, inEditor: boolean): void {
		const found: HTMLElement[] = [];
		root.querySelectorAll<HTMLElement>("img, iframe.auto-embed").forEach((el) => {
			const url = el.getAttribute("src") ?? "";
			if (el.dataset.moVideo || !isVideoUrl(url)) return;
			found.push(el);
		});
		// Images first: Auto Embed's frame for the same link is then only hidden.
		found.sort((a, b) => Number(a.tagName === "IFRAME") - Number(b.tagName === "IFRAME"));
		for (const el of found) {
			const url = el.getAttribute("src") ?? "";
			el.dataset.moVideo = "1";
			// Auto Embed shows such links in a frame of its own (a block of its own in
			// Live Preview, beside Obsidian's image): one player is enough.
			const target = el.tagName === "IFRAME"
				? (el.closest<HTMLElement>(".auto-embed-container") ?? el.closest<HTMLElement>(".default-fallback-embed-container") ?? el)
				: el;
			if (target !== el && this.hasPlayer(root, url)) {
				target.addClass("mo-video-replaced");
				continue;
			}
			const box = createSpan({ cls: "mo-video" });
			box.dataset.url = url;
			box.dataset.note = sourcePath;
			const video = box.createEl("video", { attr: { controls: "", preload: "metadata", playsinline: "", referrerpolicy: "no-referrer", src: url } });
			video.dataset.moVideo = "1";
			box.appendChild(this.bar(url, sourcePath));
			target.parentElement?.insertBefore(box, target);
			if (inEditor || target !== el) target.addClass("mo-video-replaced");
			else el.remove();
		}
	}

	private hasPlayer(root: HTMLElement, url: string): boolean {
		return Array.from(root.querySelectorAll<HTMLElement>(".mo-video")).some((b) => b.dataset.url === url);
	}

	/**
	 * Some hosts (video.twimg.com) refuse a video whose request names the page
	 * it is on. The desktop app's page (app://obsidian.md) is never named; a
	 * phone's (http://localhost) is, so there such videos don't play. A page-wide
	 * referrer policy makes the phone send what the desktop does: nothing.
	 */
	private sendNoReferrer(): void {
		if (!/^https?:$/.test(window.location.protocol) || document.querySelector('meta[name="referrer"]')) return;
		const meta = document.head.createEl("meta", { attr: { name: "referrer", content: "no-referrer" } });
		this.plugin.register(() => meta.remove());
	}

	private bar(url: string, sourcePath: string): HTMLElement {
		const bar = createDiv({ cls: "mo-video-bar" });
		bar.dataset.note = sourcePath;
		let set = this.bars.get(url);
		if (!set) this.bars.set(url, (set = new Set()));
		set.add(bar);
		this.paint(bar, url);
		const settled = this.states.get(url) === "archived" || this.states.get(url) === "remote";
		if (!this.states.has(url) || (settled && Date.now() - (this.checkedAt.get(url) ?? 0) > RECHECK_MS)) {
			void this.check(url, sourcePath);
		}
		return bar;
	}

	private paint(bar: HTMLElement, url: string): void {
		bar.empty();
		const state = this.states.get(url) ?? "unknown";
		if (state === "unknown") return;
		if (state === "archived") {
			const label = bar.createSpan({ cls: "mo-video-status" });
			setIcon(label.createSpan({ cls: "mo-video-icon" }), "check");
			label.appendText(t("archive.videoArchived"));
			this.paintTranscript(bar, url);
			return;
		}
		button(bar, "download", state === "downloading" ? t("archive.videoDownloading") : t("archive.videoDownload"),
			state === "downloading", () => void this.downloadOne(url, bar.dataset.note ?? ""));
	}

	/** After "Archived": open its transcript, or transcribe it (on the server, so only with one set). */
	private paintTranscript(bar: HTMLElement, url: string): void {
		const { core } = this;
		const media = archiveName(url).slice(3);
		const transcript = core.transcripts.transcriptsFor(media).find((f) => f.extension === "json");
		if (transcript) {
			button(bar, "file-text", t("archive.videoTranscript"), false, () => void core.openTranscript(transcript));
			return;
		}
		if (!core.library.configured) return;
		const job = core.transcriptSync.known.find((j) => j.path === `_archive/${archiveName(url)}`);
		if (job && (job.state === "queued" || job.state === "claimed")) {
			bar.createSpan({ cls: "mo-video-status", text: t("archive.videoTranscribing") });
			return;
		}
		if (job?.state === "done" && job.outputs.length) {
			// Done on the server; the transcript is on its way to the vault.
			bar.createSpan({ cls: "mo-video-status", text: t("archive.videoTranscriptComing") });
			return;
		}
		if (job?.state === "failed" && /没有音轨|no audio/i.test(job.error ?? "")) {
			bar.createSpan({ cls: "mo-video-status", text: t("archive.videoNoAudio") });
			return;
		}
		button(bar, "captions", t("archive.videoTranscribe"), false, () => void this.transcribe(url, bar.dataset.note ?? ""));
		if (job?.state === "failed") bar.createSpan({ cls: "mo-video-status mod-warning", text: t("archive.videoTranscribeFailed"), attr: { title: job.error ?? "" } });
	}

	private repaintAll(): void {
		for (const url of this.bars.keys()) this.setState(url, this.states.get(url) ?? "unknown");
	}

	async transcribe(url: string, sourcePath: string): Promise<void> {
		const { core } = this;
		const title = sourcePath.slice(sourcePath.lastIndexOf("/") + 1).replace(/\.md$/, "");
		try {
			const job = await core.library.transcribeArchived(archiveName(url), url, title);
			if (job) core.transcriptSync.remember([job]);
			new Notice(job ? t("archive.noticeTranscribeQueued") : t("archive.noticeTranscribeExists"));
			// Already done before: fetch it now rather than at the next round.
			if (!job || job.state === "done") void core.transcriptSync.sync();
		} catch (e) {
			new Notice(t("archive.noticeTranscribeFailed", { reason: e instanceof Error ? e.message : String(e) }));
		}
		this.repaintAll();
	}

	private setState(url: string, state: State): void {
		this.states.set(url, state);
		const set = this.bars.get(url);
		if (!set) return;
		for (const bar of [...set]) {
			if (!bar.isConnected) set.delete(bar);
			else this.paint(bar, url);
		}
	}

	private async check(url: string, sourcePath: string): Promise<void> {
		if (!this.states.has(url)) this.states.set(url, "unknown");
		this.checkedAt.set(url, Date.now());
		const archived = await this.isArchived(url, sourcePath);
		if (this.states.get(url) === "downloading") return;
		this.setState(url, archived ? "archived" : "remote");
	}

	private async isArchived(url: string, sourcePath: string): Promise<boolean> {
		const { plugin } = this;
		const local = storeFor(plugin.app.vault, resolve(url, sourcePath, plugin.settings));
		if (local && (await local.store.exists(local.path))) return true;
		return plugin.servers.storedAnywhere(url);
	}

	/** Archive the video at `url`; true if it is archived now. */
	async downloadOne(url: string, sourcePath: string, quiet = false): Promise<boolean> {
		const { plugin } = this;
		if (this.states.get(url) === "downloading") return false;
		const size = await contentLength(url);
		const stream = size !== null && size > STREAM_FROM && this.core.library.configured;
		if (!stream && Platform.isMobile && size !== null && size > PHONE_MAX_BYTES) {
			new Notice(t("archive.videoTooBigPhone", { size: formatSize(size) }), 10000);
			return false;
		}
		this.setState(url, "downloading");
		const progress = quiet ? null : new Notice(t("archive.videoDownloading"), 0);
		try {
			if (stream && size !== null) {
				await this.streamToArchive(url, size, sent => {
					progress?.setMessage(t("archive.videoDownloadingPercent", { percent: Math.floor((sent / size) * 100) }));
				});
				this.setState(url, "archived");
				if (!quiet) new Notice(t("archive.noticeVideoArchived"));
				return true;
			}
			const dest = resolve(url, sourcePath, plugin.settings);
			const r = await download(url, dest, plugin.app.vault, plugin.settings, plugin.servers, {
				onDemand: true,
				timeoutMs: VIDEO_TIMEOUT_MS,
			});
			const ok = r === "downloaded" || r === "skipped-exists";
			this.setState(url, ok ? "archived" : "remote");
			if (!quiet) new Notice(ok ? t("archive.noticeVideoArchived") : t("archive.noticeVideoFailed", { reason: r }));
			return ok;
		} catch (e) {
			this.setState(url, "remote");
			new Notice(t("archive.noticeVideoFailed", { reason: e instanceof Error ? e.message : String(e) }));
			return false;
		} finally {
			progress?.hide();
		}
	}

	/**
	 * A large video, from the web to the Media One server's archive as it
	 * downloads: read as a stream, sent a piece at a time, carried on after a
	 * break. Never held whole, so a phone archives a video of gigabytes too.
	 */
	private async streamToArchive(url: string, size: number, onProgress: (sent: number) => void): Promise<void> {
		const library = this.core.library;
		const source = streamSource(async (offset) => {
			const r = await fetch(url, { referrerPolicy: "no-referrer", headers: offset ? { Range: `bytes=${offset}-` } : {} });
			if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
			if (offset > 0 && r.status !== 206) throw new Error("the site won't send part of the video");
			return r.body;
		});
		await uploadInPieces(library, () => library.uploadBeginArchive(archiveName(url), url, size, ASK_PIECE), size, source, onProgress);
	}

	async downloadAll(file: TFile): Promise<void> {
		const urls = extractUrls(await this.plugin.app.vault.read(file)).filter(isVideoUrl);
		if (urls.length === 0) {
			new Notice(t("archive.noticeNoVideos"));
			return;
		}
		const progress = new Notice(t("archive.noticeVideosStart", { total: urls.length }), 0);
		let ok = 0;
		for (const url of urls) {
			if (await this.downloadOne(url, file.path, true)) ok++;
		}
		progress.hide();
		new Notice(t("archive.noticeVideosDone", { ok, total: urls.length }));
	}
}

function button(bar: HTMLElement, icon: string, text: string, disabled: boolean, onClick: () => void): void {
	const b = bar.createEl("button", { cls: "mo-video-button" });
	setIcon(b.createSpan({ cls: "mo-video-icon" }), icon);
	b.appendText(text);
	b.disabled = disabled;
	b.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		onClick();
	});
}

/** The size the server gives for `url`, or null if it doesn't say. */
async function contentLength(url: string): Promise<number | null> {
	try {
		const r = await requestUrl({ url, method: "HEAD", throw: false });
		const header = Object.entries(r.headers).find(([k]) => k.toLowerCase() === "content-length")?.[1];
		const n = header ? Number(header) : NaN;
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	}
}
