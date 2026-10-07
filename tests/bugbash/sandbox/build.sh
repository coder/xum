#!/usr/bin/env bash
# Builds the bug-bash sandbox image (#5714, Dockerfile next to this file).
#
#   build.sh --key    print the inputs key of this checkout
#   build.sh          build for linux/amd64 into the local Docker, print the image ID
#   build.sh --push   main publish job only: push to GHCR, print the image.json record
#
# The inputs key is the sha256 of three lines: the sha256 of the Dockerfile, the sha256 of this
# script, and the playwright-core version of @e2e-dev/web in bun.lock. The image carries it as
# the label org.xum.bugbash.inputs, and the runner computes the same key for its checkout.
# The script reads these files from the working tree and refuses when they differ from HEAD, so
# the key always names committed source.
#
# The build gets an empty context, no cache and no build args from the env. --push skips the
# build when the registry already has the tag inputs-<key>: one key, one published digest.
# Nothing here deletes an image.
set -euo pipefail

IMAGE=ghcr.io/coder/xum-bugbash-sandbox
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(git -C "$HERE" rev-parse --show-toplevel)
DOCKERFILE=tests/bugbash/sandbox/Dockerfile
SCRIPT=tests/bugbash/sandbox/build.sh

die() {
  echo "build.sh: $*" >&2
  exit 2
}
# sha256 of stdin. Stock macOS has shasum, not sha256sum.
sha_stdin() {
  if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1
}
sha() { sha_stdin <"$1"; }

cd "$ROOT"
for f in "$DOCKERFILE" "$SCRIPT" bun.lock; do
  git cat-file -e "HEAD:$f" 2>/dev/null || die "$f is not committed: the image builds from committed source"
done
git diff --quiet HEAD -- "$DOCKERFILE" "$SCRIPT" bun.lock ||
  die "$DOCKERFILE, $SCRIPT or bun.lock differs from HEAD: the image builds from committed source"

# The copy that e2e drives Chromium with. The root playwright-core is a different copy.
# No mapfile: the system bash of macOS is 3.2.
versions=$(grep -oE '"@e2e-dev/web/playwright-core": \["playwright-core@[^"]+"' bun.lock |
  sed -E 's/.*playwright-core@//; s/"$//') || true
count=$(printf '%s' "$versions" | grep -c . || true)
[ "$count" -eq 1 ] || die "expected one @e2e-dev/web/playwright-core entry in bun.lock, found $count"
PLAYWRIGHT=$versions
[[ $PLAYWRIGHT =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "unexpected playwright-core version: $PLAYWRIGHT"

KEY=$(printf 'dockerfile %s\nbuild.sh %s\nplaywright-core %s\n' "$(sha "$DOCKERFILE")" "$(sha "$SCRIPT")" "$PLAYWRIGHT" |
  sha_stdin)
[[ $KEY =~ ^[0-9a-f]{64}$ ]] || die "bad inputs key: $KEY"

mode=${1:-local}
[ $# -le 1 ] || die "one argument at most: --key or --push"
case "$mode" in
  --key)
    echo "$KEY"
    exit 0
    ;;
  local | --push) ;;
  *) die "unknown argument: $mode" ;;
esac

context=$(mktemp -d)
trap 'rm -rf "$context" "$context.json" "$context.raw"' EXIT
build() {
  docker buildx build --platform linux/amd64 --no-cache --pull --provenance=false --sbom=false \
    --build-arg "PLAYWRIGHT_CORE_VERSION=$PLAYWRIGHT" --build-arg "INPUTS_SHA256=$KEY" \
    --file "$ROOT/$DOCKERFILE" --metadata-file "$context.json" "$@" "$context" >&2
}

if [ "$mode" = local ]; then
  build --load --tag "xum-bugbash-sandbox:inputs-$KEY"
  docker image inspect --format '{{.Id}}' "xum-bugbash-sandbox:inputs-$KEY"
  exit 0
fi

# --push
TAG="$IMAGE:inputs-$KEY"
# The digest of a manifest is the sha256 of its raw bytes. Hash the file, not a --format value:
# some buildx versions ignore --format here and print a table (docker/buildx#4006).
if docker buildx imagetools inspect --raw "$TAG" >"$context.raw" 2>/dev/null; then
  digest="sha256:$(sha "$context.raw")"
  echo "build.sh: $TAG exists, no build" >&2
else
  build --push --tag "$TAG"
  digest=$(jq -r '."containerimage.digest"' "$context.json")
fi
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || die "bad digest: $digest"
jq -n --arg image "$IMAGE" --arg digest "$digest" --arg key "$KEY" --arg pw "$PLAYWRIGHT" \
  --arg from "$(git rev-parse HEAD)" \
  '{image: $image, digest: $digest, inputsKey: $key, playwrightCore: $pw, publishedFrom: $from}'
