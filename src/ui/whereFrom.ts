import type { ResolvedMedia } from '../mediaLocator';
import { t } from '../i18n';

/** Where media is from, said briefly: its folder in the vault, or on the server or disk. */
export function whereFrom(media: ResolvedMedia): string {
  if (media.file) {
    const dir = media.file.parent?.path;
    return dir && dir !== '/' ? dir : media.file.vault.getName();
  }
  const path = /^https?:/i.test(media.location)
    ? decodeURIComponent(media.location.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, ''))
    : media.location;
  return path.split(/[\\/]/).slice(-2, -1)[0] || t('core.fromServer');
}
