#!/usr/bin/env bash
# Model-check PlanStorage.tla: one TLC run per (config, invariant) pair, so each
# violated invariant gets its own shortest (BFS) counterexample.
#
# Usage: formal/plan-storage/check.sh [config-name-glob]   (default: all MC_*.cfg)
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

invariants=(TypeOK UniqueOwner NoForeignClobber NoBlockedRead ForkHasPlan)

# Expected verdict per config: invariants listed here must be violated; all others must hold.
# Each finding config (the code at origin/main f30a1945a6) has a *_fixed twin with a candidate
# fix that must hold; the mutants must stay caught. seeded_* configs start with two live rows on
# one path (what the races leave behind), so UniqueOwner is violated from the initial state.
declare -A EXPECT=(
  # Findings.
  [MC_create_race]="UniqueOwner NoForeignClobber"
  [MC_fork_race]="NoForeignClobber ForkHasPlan"
  [MC_rename_race]="UniqueOwner NoForeignClobber"
  [MC_two_installs]="UniqueOwner NoForeignClobber"
  [MC_alias]="UniqueOwner NoForeignClobber"
  [MC_seeded_clear]="UniqueOwner NoForeignClobber"
  [MC_fifo]="NoBlockedRead"
  # What holds: removal's sharing guard.
  [MC_seeded_remove]="UniqueOwner"
  # Fixed twins.
  [MC_create_race_fixed]=""
  [MC_fork_race_fixed]=""
  [MC_rename_race_fixed]=""
  [MC_two_installs_fixed]=""
  [MC_alias_fixed]=""
  [MC_seeded_clear_fixed]="UniqueOwner"
  [MC_fifo_fixed]=""
  # Mutation checks.
  [MC_mut_remove_noguard]="UniqueOwner NoForeignClobber"
  # The no-clobber fork copy keeps the first plan, but both rows still register.
  [MC_mut_fork_norefuse]="UniqueOwner"
  [MC_mut_fork_skipcopy]="ForkHasPlan"
)
declare -A ONLY=()

status=0
# A full run must cover every EXPECT entry: a deleted or renamed config would otherwise drop its
# scenario silently. A filtered run (a glob argument) checks only the configs it matches.
if [[ $glob == "MC_*" ]]; then
  for name in "${!EXPECT[@]}"; do
    if [[ ! -f $here/$name.cfg ]]; then
      echo "$name: EXPECT entry without a config file" >&2
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
      -metadir "$out/meta.$name.$inv" -config "$tmpcfg" PlanStorage.tla) >"$log" 2>&1 || rc=$?
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
