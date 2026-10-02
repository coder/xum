#!/usr/bin/env bash
# Model-check the background-process specs: one TLC run per (config, invariant)
# pair, so each violated invariant gets its own shortest (BFS) counterexample.
# The config prefix picks the module:
#   MC_term_*                    -> BgTerminate.tla    (kill after exit, PGID reuse)
#   MC_cleanup_*, MC_mut_cleanup_* -> BgCleanup.tla    (spawn/migration vs removal/archive)
#   MC_name_*, MC_mut_name_*     -> BgSpawnName.tla    (record-name claims across backends)
#   MC_monitor*, MC_mut_monitor_* -> BgMonitor.tla     (monitor wakes vs exit)
#   MC_gate_*, MC_mut_gate_*     -> BgGateEvidence.tla (cross-backend evidence, #4889)
#
# Usage: formal/background-processes/check.sh [config-name-glob]   (default: all MC_*.cfg)
# Env:   TLC (default ~/.local/bin/tlc), WORKERS (default 8),
#        BUDGET seconds per run (default 1800; an unfinished search that found
#        no violation reports "bounded", which fails the check: only an
#        exhaustive search shows an invariant holds),
#        OUT (default a fresh mktemp dir; traces land in $OUT/<cfg>.<inv>.log)
# Exit:  0 when every result matches EXPECT below, 1 otherwise.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tlc=${TLC:-$HOME/.local/bin/tlc}
workers=${WORKERS:-8}
budget=${BUDGET:-1800}
# Bounded heap: an unbounded default JVM heap was OOM-killed on a shared host.
export TLA_JAVA_OPTS=${TLA_JAVA_OPTS:--Xmx6g}
out=${OUT:-$(mktemp -d)}
# A caller-supplied OUT may not exist yet.
mkdir -p "$out"
glob=${1:-MC_*}

declare -A INVARIANTS=(
  [BgTerminate]="TypeOK NoSignalToReusedPgid NaturalExitPreserved OneKillSequence"
  [BgCleanup]="TypeOK NoLiveAfterDelete FgBgExclusive MigrationOwned"
  [BgSpawnName]="TypeOK NoReuseWhileTracked OneProcessPerDir"
  [BgMonitor]="TypeOK AtMostOneTerminalWake NoMatchWakeAfterTerminal"
  [BgGateEvidence]="TypeOK NoMutationUnderForeignProcess"
)

# Expected verdict per config: invariants listed here must be violated; all
# others must hold. Faithful configs model the code at f30a1945a6; *_fixed
# configs turn on a fix probe and must hold; MC_mut_* break one protocol step
# and must stay caught (they show the model can see the bug class).
declare -A EXPECT=(
  # Terminate (B1).
  [MC_term_faithful]="NoSignalToReusedPgid NaturalExitPreserved OneKillSequence"
  [MC_term_one_caller]="NoSignalToReusedPgid NaturalExitPreserved"
  [MC_term_fixed]=""
  # The shipped fix: only reuse during its own `sleep 2` escalation window remains.
  [MC_term_shipped]="NoSignalToReusedPgid"
  # Cleanup (B2 spawn vs removal, B3 archive); migration vs removal holds.
  [MC_cleanup_spawn_remove]="NoLiveAfterDelete"
  [MC_cleanup_migration_remove]=""
  [MC_cleanup_archive]="NoLiveAfterDelete"
  [MC_cleanup_fixed]=""
  [MC_cleanup_archive_fixed]=""
  [MC_mut_cleanup_nodrain]="NoLiveAfterDelete"
  # Record names: host-local holds; remote runtimes are #4889 at f30a1945a6, and
  # MC_name_remote_fixed (atomic mkdir claim) holds.
  [MC_name_host]=""
  [MC_name_remote]="NoReuseWhileTracked OneProcessPerDir"
  [MC_name_remote_nocrash]="NoReuseWhileTracked OneProcessPerDir"
  [MC_name_remote_serial]="NoReuseWhileTracked"
  [MC_name_remote_fixed]=""
  [MC_mut_name_nolock]="NoReuseWhileTracked OneProcessPerDir"
  # Monitors hold.
  [MC_monitor]=""
  [MC_mut_monitor_nolatch]="AtMostOneTerminalWake"
  # Cross-backend evidence: SSH/Docker are #4889 (documented); B4 is the os.tmpdir() root.
  [MC_gate_local_spawn]=""
  [MC_gate_devcontainer_spawn]=""
  [MC_gate_ssh_spawn]="NoMutationUnderForeignProcess"
  [MC_gate_docker_spawn]="NoMutationUnderForeignProcess"
  [MC_gate_migrated_tmp]=""
  [MC_gate_migrated_ostmp]="NoMutationUnderForeignProcess"
  [MC_mut_gate_norecords]="NoMutationUnderForeignProcess"
)

module_of() {
  case $1 in
    MC_term_*) echo BgTerminate ;;
    MC_cleanup_* | MC_mut_cleanup_*) echo BgCleanup ;;
    MC_name_* | MC_mut_name_*) echo BgSpawnName ;;
    MC_monitor* | MC_mut_monitor_*) echo BgMonitor ;;
    MC_gate_* | MC_mut_gate_*) echo BgGateEvidence ;;
    *) echo "" ;;
  esac
}

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
printf '%-26s %-30s %-9s %-8s %12s %6s\n' config invariant result expect distinct secs
for cfg in "$here"/$glob.cfg; do
  name=$(basename "$cfg" .cfg)
  module=$(module_of "$name")
  # A config without an expectation or module fails instead of defaulting to "all hold".
  if [[ -z ${EXPECT[$name]+set} || -z $module ]]; then
    echo "$name: no EXPECT entry or module" >&2
    status=1
    continue
  fi
  expected=" ${EXPECT[$name]} "
  read -r -a invs <<<"${INVARIANTS[$module]}"
  for inv in "${invs[@]}"; do
    tmpcfg="$out/$name.$inv.cfg"
    grep -v '^INVARIANTS' "$cfg" >"$tmpcfg"
    echo "INVARIANT $inv" >>"$tmpcfg"
    log="$out/$name.$inv.log"
    start=$(date +%s)
    rc=0
    (cd "$here" && timeout "$budget" "$tlc" -workers "$workers" -deadlock -noGenerateSpecTE \
      -metadir "$out/meta.$name.$inv" -config "$tmpcfg" "$module.tla") >"$log" 2>&1 || rc=$?
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
    printf '%-26s %-30s %-9s %-8s %12s %6s\n' "$name" "$inv" "$result" "$want" "${distinct:-?}" "$secs"
  done
done
exit "$status"
