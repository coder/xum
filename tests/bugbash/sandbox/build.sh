#!/usr/bin/env bash
# Builds the bug-bash sandbox image (#5714, Dockerfile next to this file).
#
#   build.sh --key    print the inputs key of this checkout
#   build.sh          build for linux/amd64 into the local Docker, print the image ID
#   build.sh --push   the manual publish job only: build, push to GHCR, print the image.json record
#
# The inputs key is the sha256 of three lines: the sha256 of the Dockerfile, the sha256 of this
# script, and the playwright-core version of @e2e-dev/web in bun.lock. The image carries it as
# the label org.xum.bugbash.inputs, and the runner computes the same key for its checkout.
# The script reads these files from the working tree and refuses when they differ from HEAD, so
# the key always names committed source.
#
# The build gets an empty context, no cache and no build args from the env. --push always builds
# fresh: it never checks the registry and never reuses an image. It pushes a new tag, so it
# overwrites no tag, and it reports the name and digest from its own build output. Two publishes
# of one inputs key give two digests; the reviewed digest in image.json is what runners trust.
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
trap 'rm -rf "$context" "$context.json"' EXIT
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

# --push. One new tag per publish (inputs key, commit, UTC time), so a publish overwrites no tag.
build --push --tag "$IMAGE:inputs-${KEY:0:16}-$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%d%H%M%S)"
# The name and digest come from this build's own metadata, not from a registry lookup.
digest=$(jq -r '."containerimage.digest"' "$context.json")
pushed=$(jq -r '."image.name"' "$context.json")
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || die "bad digest in the build metadata: $digest"
[[ $pushed == "$IMAGE:"* && $pushed != *,* ]] || die "unexpected image name in the build metadata: $pushed"
jq -n --arg image "${pushed%:*}" --arg digest "$digest" --arg key "$KEY" --arg pw "$PLAYWRIGHT" \
  --arg from "$(git rev-parse HEAD)" \
  '{image: $image, digest: $digest, inputsKey: $key, playwrightCore: $pw, publishedFrom: $from}'
