#!/usr/bin/env bash
# Put electron-builder's AppImage tool into its cache, so that electron-builder downloads nothing.
#
# Usage: scripts/ci/prefetch-appimage-tool.sh
#        scripts/ci/prefetch-appimage-tool.sh --unpack <archive> <dest>   (the unpack step alone)
#
# `electron-builder --linux` builds an AppImage with app-builder, which downloads
# appimage-12.0.1.7z from github.com and retries nothing: a github.com 504 fails the build, as it
# did for the Electron zip on 2026-11-08 (#8017). When <cache>/appimage/appimage-12.0.1 exists,
# app-builder uses it and makes no request. <cache> is $ELECTRON_BUILDER_CACHE (default
# ~/.cache/electron-builder), the directory that setup-xum caches. This script fills that
# directory: download-verified.sh fetches the archive (retries, no retry on a 404, and the pinned
# sha256 checked before the bytes are used), and the archive is unpacked next to its final name and
# moved into place, so a killed job leaves no half-unpacked tool that app-builder would trust.
#
# Pin: electron-builder 24.13.3 (app-builder-bin) names appimage-12.0.1, and
# scripts/ci/wiring.test.ts fails when app-builder-bin names another version: bump the version, the
# sha256 and this comment together. The release has no upload digest on GitHub (it predates them), so
# the sha256 is that of a download made twice with the same result, and the sha512 that the
# app-builder binary holds for the archive (base64) matched that download:
#   3el6RUh6XoYJCI/ZOApyb0LLU/gSxDntVZ46R6+JNEANzfSo7/TfrzCRp5KlDo35c24r3ZOP7nnw4RqHwkMRLw==
# (grep -a -F that string in node_modules/app-builder-bin/linux/x64/app-builder).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# The folder that unpack fills. Not local: the EXIT trap reads it after a failing command has ended
# the function.
tmp=""
trap '[[ -z "$tmp" ]] || rm -rf "$tmp"' EXIT

# unpack <archive> <dest>: <dest> appears whole or not at all.
unpack() {
  local archive=$1 dest=$2 sevenzip
  # 7zip-bin's binary is not always executable after an install (CI got "Permission denied", 126).
  sevenzip=${SEVENZIP:-$(cd "$here/../.." && node -p 'require("7zip-bin").path7za')}
  [[ -x "$sevenzip" ]] || chmod +x "$sevenzip"
  mkdir -p "$(dirname "$dest")"
  tmp=$(mktemp -d "$dest.XXXXXX")
  "$sevenzip" x -y -bd "-o$tmp" "$archive" >/dev/null
  rm -rf "$dest"
  mv "$tmp" "$dest"
  tmp=""
}

if [[ "${1:-}" == "--unpack" ]]; then
  if (("$#" != 3)); then
    echo "usage: prefetch-appimage-tool.sh --unpack <archive> <dest>" >&2
    exit 2
  fi
  unpack "$2" "$3"
  exit 0
fi
if (("$#" != 0)); then
  echo "usage: prefetch-appimage-tool.sh [--unpack <archive> <dest>]" >&2
  exit 2
fi

version=appimage-12.0.1
sha256=d12ff7eb8f1d1ec4652ca5237a7fbdca33acc0c758045636feca62dc6ecb8ec4
cache=${ELECTRON_BUILDER_CACHE:-$HOME/.cache/electron-builder}
assets=${RELEASE_ASSETS_DIR:-$HOME/.cache/xum-release-assets}
dest=$cache/appimage/$version

# app-builder reads only the directory's name, so check the parts that it runs.
if [[ -d "$dest/linux-x64" && -e "$dest/runtime-x64" ]]; then
  echo "$version: already in $cache, no download"
  exit 0
fi

"$here/download-verified.sh" \
  "https://github.com/electron-userland/electron-builder-binaries/releases/download/$version/$version.7z" \
  "$sha256" "$assets/$version.7z"
unpack "$assets/$version.7z" "$dest"
echo "$version: unpacked into $cache"
