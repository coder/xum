#!/usr/bin/env bash
# Install release binaries that CI runs, from pinned GitHub release assets.
#
# Usage: scripts/ci/install-release-tools.sh <shfmt-hadolint|static-curl> <bin-dir>
#
# Each asset goes through download-verified.sh into $RELEASE_ASSETS_DIR (default
# ~/.cache/xum-release-assets). The workflows cache that directory under a key that holds this
# file's hash, so a changed pin or checksum starts a fresh cache. A cache hit skips the
# download, because the asset already matches its checksum. A GitHub release outage then
# fails a job only when the cache is cold (retry.sh covers that case).
#
# A version bump needs new checksums for every asset of that tool below. Never copy them from
# the release page: download each asset yourself, run `sha256sum` on it, and check that the
# result equals the digest GitHub computed at upload (`gh api repos/<owner>/<repo>/releases/tags/<tag>
# --jq '.assets[] | .name + " " + .digest'`). hadolint v2.12.0 predates those digests: compare
# with its .sha256 assets. The static-curl release has no build attestations, so the upload
# digest and your own download must agree before the new values land (#6492).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
assets=${RELEASE_ASSETS_DIR:-$HOME/.cache/xum-release-assets}

# fetch <url> <sha256> <asset-file-name>
fetch() {
  "$here/download-verified.sh" "$1" "$2" "$assets/$3"
}

unsupported_cpu() {
  echo "::error::no pinned $1 for $(uname -m); add its assets and checksums" >&2
  exit 1
}

install_shfmt_hadolint() {
  local bin=$1
  local shfmt_version=v3.14.1
  local hadolint_version=v2.12.0
  local shfmt_arch shfmt_sha256 hadolint_arch hadolint_sha256
  case "$(uname -m)" in
    x86_64)
      shfmt_arch=amd64 shfmt_sha256=76e77641faa025814b77f153b29796b8e6fa2fca03e0c76a691608b86c7ea7bf
      hadolint_arch=x86_64 hadolint_sha256=56de6d5e5ec427e17b74fa48d51271c7fc0d61244bf5c90e828aab8362d55010
      ;;
    aarch64 | arm64)
      shfmt_arch=arm64 shfmt_sha256=5f2db09dae91fca848f7adbdd014632e921a383863a2ad7e0450ad3aba0c6489
      hadolint_arch=arm64 hadolint_sha256=5798551bf19f33951881f15eb238f90aef023f11e7ec7e9f4c37961cb87c5df6
      ;;
    *) unsupported_cpu "shfmt or hadolint" ;;
  esac
  local shfmt_file="shfmt_${shfmt_version}_linux_${shfmt_arch}"
  local hadolint_file="hadolint-${hadolint_version}-Linux-${hadolint_arch}"
  fetch "https://github.com/mvdan/sh/releases/download/${shfmt_version}/$shfmt_file" "$shfmt_sha256" "$shfmt_file"
  fetch "https://github.com/hadolint/hadolint/releases/download/${hadolint_version}/hadolint-Linux-${hadolint_arch}" "$hadolint_sha256" "$hadolint_file"
  mkdir -p "$bin"
  install -m 0755 "$assets/$shfmt_file" "$bin/shfmt"
  install -m 0755 "$assets/$hadolint_file" "$bin/hadolint"
  "$bin/shfmt" --version
  "$bin/hadolint" --version
}

# Unpacks only the curl binary. The runner's curl is older than 8.7 (web_fetch's address
# fallback needs 8.7+, #6414), and curl.se lists stunnel/static-curl as a static build.
install_static_curl() {
  local bin=$1
  local version=8.22.0
  local arch sha256
  case "$(uname -m)" in
    x86_64) arch=x86_64 sha256=dfb02460ba2abe513087538f12a3cf79b74b64a5ea3787ce8ac0cdb11251f884 ;;
    aarch64 | arm64) arch=aarch64 sha256=cf94cbeaae1b3c1944a4a761ef04478f8f0b23e93a324b5ed009b2082eda11f3 ;;
    *) unsupported_cpu "static curl" ;;
  esac
  local file="curl-linux-${arch}-musl-${version}.tar.xz"
  fetch "https://github.com/stunnel/static-curl/releases/download/${version}/$file" "$sha256" "$file"
  mkdir -p "$bin"
  tar -xJf "$assets/$file" -C "$bin" curl
}

if (($# != 2)); then
  echo "usage: install-release-tools.sh <shfmt-hadolint|static-curl> <bin-dir>" >&2
  exit 2
fi
case "$1" in
  shfmt-hadolint) install_shfmt_hadolint "$2" ;;
  static-curl) install_static_curl "$2" ;;
  *)
    echo "install-release-tools.sh: unknown tool set '$1'" >&2
    exit 2
    ;;
esac
