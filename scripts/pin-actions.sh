#!/usr/bin/env bash

# Downloads pinact and runs it to pin all GitHub Actions to SHA hashes.
# Usage: ./pin-actions.sh [files...]
#
# If no files are specified, defaults to all workflow and action files.

set -euo pipefail

VERSION="v3.8.0"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Detect OS and architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ARCH="amd64" ;;
  aarch64 | arm64) ARCH="arm64" ;;
esac

# The release archives are pinned by checksum. A version bump needs every checksum anew: a
# `sha256sum` of your own download of each archive, checked against the digest GitHub computed
# at upload (`gh api repos/suzuki-shunsuke/pinact/releases/tags/<version> --jq '.assets[] |
# .name + " " + .digest'`).
case "${OS}_${ARCH}" in
  linux_amd64) SHA256="13a5415f6a9e6f6cc7140954eeff120488c0b6c69525fa541011acc2a39f0429" ;;
  linux_arm64) SHA256="03ac062b927571372b6575e11a5e5760c4e1e3658a246ffbf6c8062369ffa5e5" ;;
  darwin_amd64) SHA256="4f658c9258ba261019114afcf8cbc155ce1b9a1157d17cb1fc2e0a48d962d1d7" ;;
  darwin_arm64) SHA256="512e90fb9861912b1414b473cea7277794750be1d7756c6d296fa1077ce9e5ec" ;;
  *)
    echo "No pinned pinact ${VERSION} for ${OS}/${ARCH}; add its archive checksum" >&2
    exit 1
    ;;
esac

# Download pinact
TARBALL="pinact_${OS}_${ARCH}.tar.gz"
curl -sSfL -o "$TMPDIR/$TARBALL" "https://github.com/suzuki-shunsuke/pinact/releases/download/${VERSION}/${TARBALL}"
if command -v sha256sum >/dev/null 2>&1; then
  echo "${SHA256}  $TMPDIR/$TARBALL" | sha256sum -c -
else
  # macOS ships shasum but not always coreutils sha256sum.
  echo "${SHA256}  $TMPDIR/$TARBALL" | shasum -a 256 -c -
fi
tar xzf "$TMPDIR/$TARBALL" -C "$TMPDIR"

# Run pinact with GitHub token
export GITHUB_TOKEN="${GH_TOKEN:-$(gh auth token)}"
"$TMPDIR/pinact" run "$@"
