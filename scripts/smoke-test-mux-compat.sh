#!/usr/bin/env bash
# Smoke test the published `mux` forwarding package against the canonical tarball.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CANONICAL_TARBALL="${CANONICAL_TARBALL:-}"
MUX_COMPAT_DIR="${MUX_COMPAT_DIR:-packages/mux-compat}"

if [[ -z "$CANONICAL_TARBALL" ]] || [[ ! -f "$CANONICAL_TARBALL" ]]; then
  echo "CANONICAL_TARBALL must point to the packed @coder/xum tarball" >&2
  exit 1
fi

CANONICAL_TARBALL=$(realpath "$CANONICAL_TARBALL")
MUX_COMPAT_DIR=$(realpath "$MUX_COMPAT_DIR")
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

# npm cannot resolve the unpublished scoped dependency, so pack a temporary mux
# package that points at the exact canonical tarball produced by this checkout.
TEMP_MUX_DIR="$TEST_DIR/mux-package"
cp -R "$MUX_COMPAT_DIR" "$TEMP_MUX_DIR"
node - "$TEMP_MUX_DIR/package.json" "$CANONICAL_TARBALL" <<'NODE'
const fs = require("node:fs");
const [packageJsonPath, canonicalTarball] = process.argv.slice(2);
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
packageJson.dependencies["@coder/xum"] = `file:${canonicalTarball}`;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
NODE

MUX_TARBALL=$(cd "$TEMP_MUX_DIR" && npm pack --json | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const filename = JSON.parse(input)[0]?.filename;
  if (!filename) process.exit(1);
  process.stdout.write(filename);
});
')
MUX_TARBALL="$TEMP_MUX_DIR/$MUX_TARBALL"

# Install mux the way npm installs it from the registry, with @coder/xum's npm-shrinkwrap.json
# (smoke-test.sh explains why `npm install <tarball>` cannot).
INSTALL_DIR="$TEST_DIR/install"
mkdir -p "$INSTALL_DIR"
bun "$SCRIPT_DIR/generate-npm-shrinkwrap.ts" --tarball-install "$INSTALL_DIR" "$CANONICAL_TARBALL" "$MUX_TARBALL"
(cd "$INSTALL_DIR" && "$SCRIPT_DIR/retry.sh" 3 30 npm ci --ignore-scripts --no-audit --no-fund)

if [[ ! -x "$INSTALL_DIR/node_modules/.bin/mux" ]]; then
  echo "mux forwarding binary was not installed" >&2
  exit 1
fi

"$INSTALL_DIR/node_modules/.bin/mux" --help >/dev/null
