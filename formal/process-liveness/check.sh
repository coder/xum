#!/usr/bin/env bash
# Build and audit the process-liveness proofs.
#
# Usage: formal/process-liveness/check.sh
# Env:   LAKE (default ~/.local/bin/lake), LEANCHECKER (default ~/.local/bin/leanchecker)
# Exit:  0 when the build succeeds, no source escapes the kernel (sorry, admit, axiom,
#        native_decide, implemented_by, extern), every listed theorem depends only on Lean's
#        three standard axioms, and leanchecker re-checks the compiled environment.
#        The topology assumption is a hypothesis (the `Topology` argument), not an axiom.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
lake=${LAKE:-$HOME/.local/bin/lake}
leanchecker=${LEANCHECKER:-$HOME/.local/bin/leanchecker}
cd "$here"

"$lake" build

if grep -nE '\b(sorry|admit|axiom|native_decide|implemented_by)\b|@\[extern' \
  ProcessLiveness.lean ProcessLiveness/*.lean; then
  echo "check.sh: forbidden escape hatch in the sources (above)" >&2
  exit 1
fi

theorems=(specJudge_dead_iff spec_dead_sound spec_never_reclaims_live spec_monotone
  spec_refuse_antitone reboot_dead same_machine_reboot_dead namespace_dead
  unknown_domain_refuses legacy_refuses_on_linux nonlinux_reuse_reads_live
  hostname_irrelevant ts_sound finding_A findingA_machineUnstable finding_B1 finding_B2
  finding_B3 ts_not_monotone)
audit=$(mktemp "${TMPDIR:-/tmp}/liveness-axioms.XXXXXX.lean")
trap 'rm -f "$audit"' EXIT
{
  echo "import ProcessLiveness"
  for t in "${theorems[@]}"; do echo "#print axioms ProcessLiveness.$t"; done
} >"$audit"
out=$("$lake" env lean "$audit" 2>&1)
count=$(grep -cE "^'ProcessLiveness\.[A-Za-z_0-9]+' (depends on axioms|does not depend)" <<<"$out" || true)
if [[ $count -ne ${#theorems[@]} ]]; then
  echo "$out" >&2
  echo "check.sh: expected ${#theorems[@]} axiom reports, got $count" >&2
  exit 1
fi
bad=$(grep -oE 'depends on axioms: \[[^]]*\]' <<<"$out" | sed 's/.*\[//; s/\]//' | tr ',' '\n' |
  sed 's/^ *//' | grep -vxE 'propext|Classical\.choice|Quot\.sound' || true)
if [[ -n $bad ]]; then
  echo "$out" >&2
  echo "check.sh: non-standard axioms: $bad" >&2
  exit 1
fi

"$lake" env "$leanchecker" ProcessLiveness
echo "check.sh: ${#theorems[@]} theorems proved; axioms limited to propext, Classical.choice, Quot.sound"
