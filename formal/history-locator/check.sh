#!/usr/bin/env bash
# Build the history-locator proofs.
#
# Usage: formal/history-locator/check.sh
# Env:   LAKE (default ~/.local/bin/lake)
# Exit:  0 when `lake build` succeeds and no source escapes the kernel (sorry, admit, axiom,
#        native_decide, implemented_by, extern).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
lake=${LAKE:-$HOME/.local/bin/lake}
cd "$here"

"$lake" build

if grep -nE '\b(sorry|admit|axiom|native_decide|implemented_by)\b|@\[extern' \
  HistoryLocator.lean HistoryLocator/*.lean; then
  echo "check.sh: forbidden escape hatch in the sources (above)" >&2
  exit 1
fi
echo "check.sh: history-locator proofs build"
