import { Notice, TFile, normalizePath } from 'obsidian';
import type MediaTranscriptPlugin from '../main';
import { rewriteNote, type LinkAt, type Target } from './links';
import { t } from '../i18n';
import type { LibraryFile } from './client';

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/**
 * Rename (or move) a media file in the library, and bring the vault along:
 * notes that embed or link it, its transcripts, and its annotations.
 *
 * If the vault still has the file itself (not moved out yet), it is renamed
 * there too, as Obsidian renames any file.
 */
export async function renameMedia(plugin: MediaTranscriptPlugin, from: string, to: string): Promise<void> {
  to = normalizePath(to);
  if (from === to) return;
  await plugin.library.rename(from, to);

  // Links first, while they still resolve to the file, whatever Obsidian's
  // own "update links" setting says.
  const changed = await retargetNotes(plugin, { name: nameOf(from), path: from }, { name: nameOf(to), path: to });
  const local = plugin.app.vault.getAbstractFileByPath(from);
  if (local instanceof TFile) {
    // Transcripts follow the file (see followRename), annotations too when that module runs.
    await plugin.app.fileManager.renameFile(local, to);
  } else {
    await plugin.renameTranscripts(nameOf(from), nameOf(to), dirOf(from));
  }
  await moveAnnotations(plugin, from, to);
  if (changed > 0) new Notice(t(changed > 1 ? 'library.linksUpdatedMany' : 'library.linksUpdatedOne', { count: changed, name: nameOf(to) }));
  plugin.mediaLocator.invalidate();
}

/**
 * Move a media file to the server's trash (kept 30 days), and this device's
 * copy and its transcripts in the vault to Obsidian's trash: the server trashes
 * its own copy of the transcripts, but the vault's would stay and keep syncing.
 */
export async function deleteMedia(plugin: MediaTranscriptPlugin, vaultPath: string): Promise<void> {
  await plugin.library.delete(vaultPath);
  const local = plugin.app.vault.getAbstractFileByPath(vaultPath);
  if (local instanceof TFile) await plugin.app.fileManager.trashFile(local);
  // A transcript found only by its name is shared with another file of that
  // name (the video beside the audio): keep it while one is left.
  const dir = dirOf(vaultPath);
  const others: string[] = (await plugin.library.files().catch((): LibraryFile[] => [])).map(f => f.vaultPath);
  for (const f of plugin.app.vault.getFiles()) others.push(f.path);
  const exts = new Set([...plugin.settings.supportedAudioExtensions, ...plugin.settings.supportedVideoExtensions]);
  await plugin.trashTranscripts(nameOf(vaultPath), dir, base => others.some(p => {
    if (p === vaultPath || dirOf(p) !== dir) return false;
    const n = nameOf(p);
    return n.startsWith(base + '.') && exts.has(n.slice(base.length + 1).toLowerCase());
  }));
  plugin.mediaLocator.invalidate();
}

export async function restoreMedia(plugin: MediaTranscriptPlugin, id: string): Promise<string> {
  const path = await plugin.library.restore(id);
  plugin.mediaLocator.invalidate();
  return path;
}

/** Rewrite every note's links to `from`; returns how many links changed. */
async function retargetNotes(plugin: MediaTranscriptPlugin, from: Target, to: Target): Promise<number> {
  const { vault, metadataCache } = plugin.app;
  let changed = 0;
  for (const note of vault.getMarkdownFiles()) {
    const cache = metadataCache.getFileCache(note);
    const refs = [...(cache?.embeds ?? []), ...(cache?.links ?? [])];
    const links: LinkAt[] = [];
    for (const r of refs) {
      const target = r.link.split('#')[0].split('|')[0];
      if (!target.toLowerCase().endsWith(from.name.toLowerCase()) && !decodeURIComponentSafe(target).toLowerCase().endsWith(from.name.toLowerCase())) continue;
      // A link that resolves to some other file of that name is not ours.
      const resolved = metadataCache.getFirstLinkpathDest(decodeURIComponentSafe(target), note.path);
      if (resolved && resolved.path !== from.path) continue;
      links.push({ original: r.original, link: r.link, start: r.position.start.offset, end: r.position.end.offset });
    }
    if (links.length === 0) continue;
    await vault.process(note, text => {
      const result = rewriteNote(text, links, from, to);
      changed += result.changed;
      return result.text;
    });
  }
  return changed;
}

/**
 * The annotations of a media file live in `<file>.anno.json` beside where the
 * file was, naming it as their target; move them with it.
 */
async function moveAnnotations(plugin: MediaTranscriptPlugin, from: string, to: string): Promise<void> {
  const { vault } = plugin.app;
  const oldName = nameOf(from) + '.anno.json';
  for (const file of vault.getFiles()) {
    if (file.name !== oldName) continue;
    const target = normalizePath(`${file.parent?.path ?? ''}/${nameOf(to)}.anno.json`);
    if (vault.getAbstractFileByPath(target)) {
      new Notice(t('library.annotationsKept', { path: file.path, target }));
      continue;
    }
    await vault.process(file, text => {
      try {
        // The target is the sidecar's own path less `.anno.json`.
        const data = JSON.parse(text) as { target?: string };
        data.target = target.slice(0, -'.anno.json'.length);
        return JSON.stringify(data, null, 2);
      } catch {
        // not ours to fix: leave the text as it is
      }
      return text;
    });
    await plugin.app.fileManager.renameFile(file, target);
  }
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
