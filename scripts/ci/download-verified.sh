#!/usr/bin/env bash
# Put the file at <url> into <dest>, once it matches <sha256>. Skip the network when <dest>
# already matches.
#
# Usage: scripts/ci/download-verified.sh <url> <sha256> <dest>
#
# A CI cache can hold <dest> from an earlier run. The checksum decides whether to trust it, so
# a stale or tampered cache entry costs a download and never lets unpinned bytes through. The
# bytes reach <dest> only after the checksum passes.
#
# Retries (scripts/retry.sh): DOWNLOAD_BUDGET_SECS (default 900) is the time to keep trying, and
# DOWNLOAD_BACKOFF_SECS (default 2) the first wait, which doubles up to 60 s. A GitHub release
# outage can last that long, and fetch-once.sh ends the retries at once on an HTTP 404 or any
# other answer that no retry changes. Each caller sizes the budget to its job's time limit.
set -euo pipefail

if (($# != 3)); then
  echo "usage: download-verified.sh <url> <sha256> <dest>" >&2
  exit 2
fi
url=$1
sha256=$2
dest=$3
if ! [[ "$sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "download-verified.sh: '$sha256' is not a lowercase sha256 hex digest" >&2
  exit 2
fi
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

matches() {
  printf '%s  %s\n' "$sha256" "$1" | sha256sum -c --status - 2>/dev/null
}

if [[ -f "$dest" ]] && matches "$dest"; then
  echo "$(basename "$dest"): present with the pinned sha256, no download"
  exit 0
fi

mkdir -p "$(dirname "$dest")"
tmp=$(mktemp "$dest.XXXXXX")
trap 'rm -f "$tmp"' EXIT
"$here/../retry.sh" --budget-secs "${DOWNLOAD_BUDGET_SECS:-900}" --max-backoff-secs 60 --fatal-status 64 \
  0 "${DOWNLOAD_BACKOFF_SECS:-2}" "$here/fetch-once.sh" "$url" "$tmp"
if ! matches "$tmp"; then
  echo "::error::$url does not match the pinned sha256 $sha256" >&2
  exit 1
fi
mv "$tmp" "$dest"
echo "$(basename "$dest"): downloaded and checked against the pinned sha256"
