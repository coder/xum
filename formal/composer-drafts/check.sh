#!/usr/bin/env bash
# Model-check ComposerDrafts.tla: one TLC run per (config, invariant) pair, so each
# violated invariant gets its own shortest (BFS) counterexample.
#
# Usage: formal/composer-drafts/check.sh [config-name-glob]   (default: all MC_*.cfg)
# Env:   TLC (default ~/.local/bin/tlc), WORKERS (default 8),
#        BUDGET seconds per run (default 300; an unfinished search that found
#        no violation reports "bounded", which fails the check: only an
#        exhaustive search shows an invariant holds),
#        OUT (default a fresh mktemp dir; traces land in $OUT/<cfg>.<inv>.log)
# Exit:  0 when every result matches EXPECT below, 1 otherwise.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tlc=${TLC:-$HOME/.local/bin/tlc}
workers=${WORKERS:-8}
budget=${BUDGET:-300}
# Bounded heap: an unbounded default JVM heap was OOM-killed on a shared host.
export TLA_JAVA_OPTS=${TLA_JAVA_OPTS:--Xmx6g}
out=${OUT:-$(mktemp -d)}
# A caller-supplied OUT may not exist yet.
mkdir -p "$out"
glob=${1:-MC_*}

invariants=(TypeOK NoSilentLoss NoDup NoResurrection)

# Expected verdict per config: invariants listed here must be violated; all
# others must hold. A config missing here fails. *_fixed configs turn the fix
# flags on; the code at f30a1945a6 has every fix flag off. The D1/D4 fix later implemented
# FixMergeRestore and FixKeepUntilAccepted; no config has exactly that flag set (D2/D5 stay open),
# so the rows below keep the pre-fix snapshot and the *_fixed targets.
declare -A EXPECT=(
  # The workspace composer at f30a1945a6 (every fix flag off).
  [MC_current]="NoSilentLoss NoDup NoResurrection"
  # One finding each (other fixes on where they would mask it).
  [MC_send_restore]="NoSilentLoss NoDup NoResurrection" # D1 failed send replaces newer text; D2 restore after accept
  [MC_quit_during_send]="NoSilentLoss NoDup NoResurrection" # D4 cleared draft saved before acceptance; D5 accepted text back after a crash
  [MC_creation]="NoSilentLoss"                          # D3 non-consumed creation /goal
  [MC_held_rollback]="NoDup NoResurrection"             # H1 held Retry refused after its row became durable
  # Declined by the project (last writer wins on simultaneous edits).
  [MC_simultaneous]="NoSilentLoss"
  # Mutant: the GC must not read an unreadable list as empty.
  [MC_mut_laxgc]="NoSilentLoss"
  # Fixed models and controls.
  [MC_send_restore_fixed]=""
  [MC_quit_during_send_fixed]=""
  [MC_creation_fixed]=""
  [MC_held]=""
  [MC_simultaneous_cas]=""
  [MC_all_fixed]=""
)
# Configs too large to search exhaustively under BUDGET: check only these.
declare -A ONLY=()

status=0
# A full run fails when an EXPECT entry has no config (a renamed or deleted cfg would
# otherwise drop its expectation silently). A glob run checks only the matched configs.
if [[ $glob == "MC_*" ]]; then
  for name in "${!EXPECT[@]}"; do
    if [[ ! -f "$here/$name.cfg" ]]; then
      echo "$name: EXPECT entry has no $name.cfg" >&2
      status=1
    fi
  done
fi
echo "results in $out"
printf '%-22s %-24s %-9s %-8s %12s %6s\n' config invariant result expect distinct secs
for cfg in "$here"/$glob.cfg; do
  name=$(basename "$cfg" .cfg)
  # A config without an expectation fails instead of defaulting to "all hold".
  if [[ -z ${EXPECT[$name]+set} ]]; then
    echo "$name: no EXPECT entry" >&2
    status=1
    continue
  fi
  expected=" ${EXPECT[$name]} "
  read -r -a invs <<<"${ONLY[$name]-${invariants[*]}}"
  for inv in "${invs[@]}"; do
    tmpcfg="$out/$name.$inv.cfg"
    grep -v '^INVARIANTS' "$cfg" >"$tmpcfg"
    echo "INVARIANT $inv" >>"$tmpcfg"
    log="$out/$name.$inv.log"
    start=$(date +%s)
    rc=0
    (cd "$here" && timeout "$budget" "$tlc" -workers "$workers" -deadlock -noGenerateSpecTE \
      -metadir "$out/meta.$name.$inv" -config "$tmpcfg" ComposerDrafts.tla) >"$log" 2>&1 || rc=$?
    secs=$(($(date +%s) - start))
    # A run killed before TLC printed a state count has none (grep exits 1).
    distinct=$(grep -oE '[0-9,]+ distinct states found' "$log" | tail -n 1 | cut -d' ' -f1 || true)
    case $rc in
      0) result=holds ;;
      12) result=VIOLATED ;;
      124) result=bounded ;;
      *) result="error($rc)" ;;
    esac
    if [[ $expected == *" $inv "* ]]; then want=VIOLATED; else want=holds; fi
    [[ $result == "$want" ]] || status=1
    printf '%-22s %-24s %-9s %-8s %12s %6s\n' "$name" "$inv" "$result" "$want" "${distinct:-?}" "$secs"
  done
done
exit "$status"
