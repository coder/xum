#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

# patchedDependencies only serves this repository's own bun install. bun also honors the field in
# an installed tarball's package.json, resolving patch paths against the installing project, so the
# server updater's `bun add <tarball>` fails once a patched version resolves. Consumers never get
# the patches either way, so pack without the field and restore the source manifest afterwards.
MANIFEST_BACKUP=$(mktemp)
cp -p package.json "$MANIFEST_BACKUP"
trap 'cp -p "$MANIFEST_BACKUP" package.json && rm -f "$MANIFEST_BACKUP"' EXIT
npm pkg delete patchedDependencies

# Scoped package tarballs include the scope in their generated filename, so derive
# the path from npm's machine-readable output instead of duplicating that convention.
PACK_JSON=$(npm pack --json)
TARBALL=$(printf '%s' "$PACK_JSON" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const filename = JSON.parse(input)[0]?.filename;
  if (!filename) process.exit(1);
  process.stdout.write(filename);
});
')

if [[ ! -f "$TARBALL" ]]; then
  echo "npm pack did not create the reported tarball: $TARBALL" >&2
  exit 1
fi

printf '%s/%s\n' "$ROOT_DIR" "$TARBALL"
