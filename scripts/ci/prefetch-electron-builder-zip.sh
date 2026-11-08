#!/usr/bin/env bash
# Put the Electron zip that electron-builder needs into $ELECTRON_CACHE, once it matches the
# sha256 that ships with the electron package.
#
# Usage (from the repository root, after `bun install`):
#   ELECTRON_CACHE=<dir> scripts/ci/prefetch-electron-builder-zip.sh
#
# electron-builder downloads the zip itself through its app-builder binary. That binary reads
# $ELECTRON_CACHE, keeps the zip flat in it as <dir>/electron-v<version>-<platform>-<arch>.zip,
# uses a file that is there without any network call, and does not check the file's checksum.
# This script fills that cache so a GitHub release outage cannot fail a build job (a 504 for
# the zip failed Build / Linux on 2026-11-08). It runs through download-verified.sh, so a cached
# zip that matches the pin costs no download, and a stale or corrupt one is downloaded again:
# the checksum decides, as app-builder would not. Which zip: the one for this runner's platform
# and CPU, at the version of node_modules/electron (the version electron-builder picks).
#
# ELECTRON_MIRROR (the variable app-builder and @electron/get read) names another release host.
# Retries and budget: see download-verified.sh (DOWNLOAD_BUDGET_SECS, DOWNLOAD_BACKOFF_SECS).
set -euo pipefail

: "${ELECTRON_CACHE:?ELECTRON_CACHE must name the directory electron-builder reads}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mirror=${ELECTRON_MIRROR:-https://github.com/electron/electron/releases/download/}

# One line: the version, the asset name and its pinned sha256.
# shellcheck disable=SC2016 # node, not bash, expands the ${...} in the JavaScript.
asset=$(
  node -e '
    const { createRequire } = require("node:module");
    const electron = createRequire(`${process.cwd()}/node_modules/electron/`);
    const version = electron("./package.json").version;
    const name = `electron-v${version}-${process.platform}-${process.arch}.zip`;
    const sha256 = electron("./checksums.json")[name];
    if (!sha256) {
      console.error(`node_modules/electron/checksums.json has no ${name}`);
      process.exit(1);
    }
    console.log(version, name, sha256);
  '
)
read -r version name sha256 <<<"$asset"

exec "$here/download-verified.sh" "${mirror%/}/v${version}/${name}" "$sha256" "$ELECTRON_CACHE/$name"
