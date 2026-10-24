/** A file size the way the panels show it: 1.2 GB, 34.5 MB, 120 KB. */
export function formatSize(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${bytes === 0 ? 0 : Math.max(1, Math.round(bytes / 1e3))} KB`;
}
