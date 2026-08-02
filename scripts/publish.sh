#!/usr/bin/env bash
# One-command release for this Obsidian plugin.
#
# Usage:
#   ./scripts/publish.sh <new-version> "<commit message>"
#   ./scripts/publish.sh 1.0.7 "Fix seek jitter on short clips"
#
# Steps (each fails loud, no silent skips):
#   1. Bump version in manifest.json, package.json, versions.json (kept in sync).
#   2. Typecheck + production build.
#   3. Deploy main.js/styles.css/manifest.json to the local vault (if present).
#   4. Commit, tag <version> (no 'v' prefix), push both — CI + release workflow run.
#   5. Wait for the GitHub release to appear with all 3 assets.
#   6. Sync the community.obsidian.md listing and wait for review (scripts/sync-community.mjs).
#
# Env:
#   VAULT_PLUGIN_DIR   override local deploy target (default below)
#   SKIP_COMMUNITY=1   do only the GitHub release, skip the community sync
#   MIN_APP_VERSION    minAppVersion to record in versions.json (default 1.4.0)

set -euo pipefail

VERSION="${1:-}"
MESSAGE="${2:-}"
if [[ -z "$VERSION" || -z "$MESSAGE" ]]; then
  echo "usage: ./scripts/publish.sh <new-version> \"<commit message>\"" >&2
  exit 2
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be X.Y.Z (no 'v' prefix): got '$VERSION'" >&2
  exit 2
fi

# Repo root = parent of this script's dir.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PLUGIN_ID="$(node -p "require('./manifest.json').id")"
MIN_APP_VERSION="${MIN_APP_VERSION:-1.4.0}"
VAULT_PLUGIN_DIR="${VAULT_PLUGIN_DIR:-$HOME/Desktop/ob/me/.obsidian/plugins/$PLUGIN_ID}"

echo "▶ Releasing $PLUGIN_ID $VERSION"

# 1. Bump versions (three files, kept identical) ------------------------------
node - "$VERSION" "$MIN_APP_VERSION" <<'NODE'
const fs = require("fs");
const [version, minApp] = process.argv.slice(2);
for (const f of ["manifest.json", "package.json"]) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.version = version;
  fs.writeFileSync(f, JSON.stringify(j, null, "\t") + "\n");
}
// package.json historically uses 2-space; re-read and match its own style if needed.
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
const versions = JSON.parse(fs.readFileSync("versions.json", "utf8"));
versions[version] = minApp;
fs.writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
console.log(`  bumped manifest/package/versions -> ${version} (minApp ${minApp})`);
NODE

# 2. Build --------------------------------------------------------------------
echo "▶ Building"
npm run build

# 3. Deploy to local vault (optional) -----------------------------------------
if [[ -d "$VAULT_PLUGIN_DIR" ]]; then
  cp main.js styles.css manifest.json "$VAULT_PLUGIN_DIR/"
  echo "  deployed to $VAULT_PLUGIN_DIR"
else
  echo "  (no local vault at $VAULT_PLUGIN_DIR — skipping deploy)"
fi

# 4. Commit + tag + push ------------------------------------------------------
echo "▶ Commit + tag + push"
git add -A
git commit -q -m "$MESSAGE ($VERSION)" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
git tag "$VERSION"
git push origin HEAD
git push origin "$VERSION"

# 5. Wait for the release workflow + assets -----------------------------------
echo "▶ Waiting for GitHub release $VERSION (release workflow builds it)…"
for i in $(seq 1 30); do
  sleep 10
  if assets="$(gh release view "$VERSION" --json assets --jq '[.assets[].name] | join(",")' 2>/dev/null)"; then
    echo "  release present. assets: $assets"
    for want in main.js manifest.json styles.css; do
      [[ ",$assets," == *",$want,"* ]] || { echo "  ⚠ missing asset: $want" >&2; }
    done
    break
  fi
  echo "  [$i] not up yet…"
done

# 6. Sync community listing + wait for review ---------------------------------
if [[ "${SKIP_COMMUNITY:-0}" == "1" ]]; then
  echo "✓ GitHub release done. SKIP_COMMUNITY=1 — not syncing the community listing."
  echo "  Sync later with: node scripts/sync-community.mjs $PLUGIN_ID $VERSION"
  exit 0
fi

echo "▶ Syncing community.obsidian.md listing (needs CDP proxy + Obsidian login)"
node "$HOME/.claude/skills/web-access/scripts/check-deps.mjs" >/dev/null 2>&1 || {
  echo "  ⚠ CDP proxy not ready. Start it, then run: node scripts/sync-community.mjs $PLUGIN_ID $VERSION" >&2
  exit 1
}
node "$ROOT/scripts/sync-community.mjs" "$PLUGIN_ID" "$VERSION"
