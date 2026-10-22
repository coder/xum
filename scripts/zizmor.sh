#!/usr/bin/env bash

# Usage: ./zizmor.sh [args...]
#
# This script lints GitHub Actions workflows with zizmor.
#
# Primary execution path: run zizmor via its Docker image (CI-friendly).
# Fallback: if Docker isn't available/running (common on dev machines), download a
# prebuilt zizmor binary from GitHub Releases and run it directly.

if ! command -v docker >/dev/null 2>&1; then
  echo "⚠️  docker not found; skipping zizmor" >&2
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "⚠️  docker daemon not running; skipping zizmor" >&2
  exit 0
fi

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

zizmor_version="1.20.0"
# The image and the release archives are pinned by digest, so a moved tag or a replaced
# release asset cannot run here. A version bump needs every digest anew: the image's from
# `crane digest ghcr.io/zizmorcore/zizmor:<version>` (or `docker buildx imagetools inspect`),
# and each archive's from a `sha256sum` of your own download, checked against the digest
# GitHub computed at upload (`gh api repos/zizmorcore/zizmor/releases/tags/v<version> --jq
# '.assets[] | .name + " " + .digest'`).
image="ghcr.io/zizmorcore/zizmor:${zizmor_version}@sha256:4a574a15fc2bfb6c3b30db75410f1faeb7a94b5355d46dcbd32309047dd6d097"

docker_args=(
  "--rm"
  "--volume" "$(pwd):/repo"
  "--workdir" "/repo"
)

if [[ -t 0 ]]; then
  docker_args+=("-it")
fi

# If no GH_TOKEN is set, try to get one from `gh auth token`.
if [[ "${GH_TOKEN:-}" == "" ]] && command -v gh &>/dev/null; then
  set +e
  GH_TOKEN="$(gh auth token)"
  export GH_TOKEN
  set -e
fi

# Pass through the GitHub token if it's set, which allows zizmor to scan
# imported workflows too.
if [[ "${GH_TOKEN:-}" != "" ]]; then
  docker_args+=("--env" "GH_TOKEN")
fi

# Prefer Docker when available (faster + consistent in CI).
# If docker is present but the image can't be pulled (e.g., GHCR auth/rate limits),
# fall back to the prebuilt binary.
if command -v docker &>/dev/null && docker info &>/dev/null; then
  set +e
  docker run "${docker_args[@]}" "$image" "$@"
  status=$?
  set -e

  if [[ $status -eq 0 ]]; then
    exit 0
  fi

  # Exit code 125 indicates the docker invocation failed (image pull, daemon issues, etc.).
  # Only in that case do we fall back to the prebuilt binary.
  #
  # For other non-zero exit codes, zizmor itself failed (e.g., it found issues) and we should
  # propagate that failure rather than masking it.
  if [[ $status -ne 125 ]]; then
    exit $status
  fi

  echo "⚠️  Docker zizmor failed (exit $status); running prebuilt binary..."
else
  echo "⚠️  Docker unavailable; running zizmor via prebuilt binary..."
fi

os="$(uname -s)"
arch="$(uname -m)"

case "$os-$arch" in
  Darwin-arm64) target="aarch64-apple-darwin" sha256="f28ef0570f06e6eb5278a354b314bb314575bb10871efdbd6f49cee74f36e9c5" ;;
  Darwin-x86_64) target="x86_64-apple-darwin" sha256="a409946504c47587b474e1454eac10e38dc2eb8c144607cb8423afd851758540" ;;
  Linux-x86_64) target="x86_64-unknown-linux-gnu" sha256="42fc3dcb9242261309fef0156213c5cb7a7179c1a0693ac8d067cc308f3a55cf" ;;
  Linux-aarch64 | Linux-arm64) target="aarch64-unknown-linux-gnu" sha256="055abb0d8fdb56be5014226343509ef5b0e8f5481a115d673345718d8dcf616a" ;;
  *)
    echo "❌ Unsupported platform for zizmor binary fallback: $os/$arch"
    exit 1
    ;;
esac

# Keyed by the archive digest, so only a binary from a verified download is reused.
cache_dir="node_modules/.cache/mux-tools/zizmor/${sha256}"
bin_path="${cache_dir}/zizmor"

if [[ ! -x "$bin_path" ]]; then
  mkdir -p "$cache_dir"

  tmp_dir="$(mktemp -d)"
  archive_name="zizmor-${target}.tar.gz"
  url="https://github.com/zizmorcore/zizmor/releases/download/v${zizmor_version}/${archive_name}"

  curl -fsSL "$url" -o "${tmp_dir}/${archive_name}"
  if command -v sha256sum >/dev/null 2>&1; then
    echo "${sha256}  ${tmp_dir}/${archive_name}" | sha256sum -c -
  else
    # macOS ships shasum but not always coreutils sha256sum.
    echo "${sha256}  ${tmp_dir}/${archive_name}" | shasum -a 256 -c -
  fi
  tar -xzf "${tmp_dir}/${archive_name}" -C "$tmp_dir"
  mv "${tmp_dir}/zizmor" "$bin_path"
  chmod +x "$bin_path"
  rm -rf "$tmp_dir"
fi

exec "$bin_path" "$@"
