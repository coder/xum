#!/usr/bin/env bash
# Model-check the SSH connection pool specs: one TLC run per (config, property)
# pair, so each violated property gets its own shortest (BFS) counterexample.
# The config prefix picks the module:
#   MC_ssh2_*    -> SSH2Pool.tla    (SSH2ConnectionPool + SSH2Transport)
#   MC_openssh_* -> OpenSSHPool.tla (sshConnectionPool + OpenSSHTransport)
#
# Usage: formal/ssh-pool/check.sh [config-name-glob]   (default: all MC_*.cfg)
# Env:   TLC (default ~/.local/bin/tlc), WORKERS (default 8),
#        BUDGET seconds per run (default 1800; an unfinished search that found
#        no violation reports "bounded", which fails the check: only an
#        exhaustive search shows a property holds),
#        OUT (default a fresh mktemp dir; traces land in $OUT/<cfg>.<prop>.log),
#        FORMAL_FAST=1 skips the configs listed in SLOW below (PR CI runs)
# Exit:  0 when every result matches EXPECT below, 1 otherwise.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tlc=${TLC:-$HOME/.local/bin/tlc}
workers=${WORKERS:-8}
budget=${BUDGET:-1800}
# Bounded heap: an unbounded default JVM heap was OOM-killed on a shared host.
export TLA_JAVA_OPTS=${TLA_JAVA_OPTS:--Xmx6g}
out=${OUT:-$(mktemp -d)}
# A caller-supplied OUT may not exist yet, and may be relative: TLC runs from $here.
mkdir -p "$out"
out=$(cd "$out" && pwd)
glob=${1:-MC_*}

# Progress and Recovers are temporal properties (checked as PROPERTY); the rest are invariants.
declare -A CHECKS=(
  [SSH2Pool]="TypeOK NoUseAfterClose NoLeak ClassificationSafe Progress"
  [OpenSSHPool]="TypeOK OneProbePerKey ClassificationSafe NoFalseBackoff NoFalsePermanent Recovers"
)
TEMPORAL=" Progress Recovers "

# Expected verdict per config: properties listed here must be violated; all
# others must hold. *_faithful configs model the code at a186481add; *_fix_*
# and *_fixed configs turn on fix probes; MC_*_mut_* break one protocol step
# on a fixed model and must stay caught (they show the model can see the bug class).
declare -A EXPECT=(
  # ssh2 pool. F1: a late close of an idle-closed client deletes the new entry (leak).
  # F2: the idle timer does not see an exec whose channel is still opening.
  # The ssh2 code now carries both fixes (identity-checked close handlers, reserveChannel),
  # so MC_ssh2_fixed models it; MC_ssh2_faithful keeps the pre-fix code.
  [MC_ssh2_faithful]="NoUseAfterClose NoLeak"
  [MC_ssh2_fix_close]="NoUseAfterClose"
  [MC_ssh2_fix_open]="NoLeak"
  [MC_ssh2_fixed]=""
  [MC_ssh2_mut_idle_channels]="NoUseAfterClose"
  [MC_ssh2_mut_no_singleflight]="NoLeak"
  [MC_ssh2_mut_eof_exit0]="ClassificationSafe"
  # OpenSSH pool. F3: a user command's own exit 255 is recorded as a host failure.
  [MC_openssh_faithful]="NoFalseBackoff NoFalsePermanent"
  [MC_openssh_fixed]=""
  [MC_openssh_mut_no_singleflight]="OneProbePerKey"
  [MC_openssh_mut_timeout_missing]="ClassificationSafe"
  [MC_openssh_mut_inflight_stuck]="Recovers"
)

# Configs that take over ~10 min; FORMAL_FAST=1 skips them, the nightly CI run keeps them.
SLOW=" "

module_of() {
  case $1 in
    MC_ssh2_*) echo SSH2Pool ;;
    MC_openssh_*) echo OpenSSHPool ;;
    *) echo "" ;;
  esac
}

status=0
echo "results in $out"

# A full run must cover every expectation: a renamed or deleted config would
# otherwise drop its check silently.
if [[ $glob == "MC_*" ]]; then
  for name in "${!EXPECT[@]}"; do
    if [[ ! -f "$here/$name.cfg" ]]; then
      echo "$name: EXPECT entry without a config" >&2
      status=1
    fi
  done
fi

printf '%-32s %-20s %-9s %-8s %12s %6s\n' config property result expect distinct secs
for cfg in "$here"/$glob.cfg; do
  name=$(basename "$cfg" .cfg)
  module=$(module_of "$name")
  # A config without an expectation or module fails instead of defaulting to "all hold".
  if [[ -z ${EXPECT[$name]+set} || -z $module ]]; then
    echo "$name: no EXPECT entry or module" >&2
    status=1
    continue
  fi
  if [[ ${FORMAL_FAST:-0} == 1 && $SLOW == *" $name "* ]]; then
    echo "$name: skipped (FORMAL_FAST=1)"
    continue
  fi
  expected=" ${EXPECT[$name]} "
  read -r -a checks <<<"${CHECKS[$module]}"
  for prop in "${checks[@]}"; do
    tmpcfg="$out/$name.$prop.cfg"
    grep -v -e '^INVARIANTS' -e '^PROPERTIES' "$cfg" >"$tmpcfg"
    if [[ $TEMPORAL == *" $prop "* ]]; then
      echo "PROPERTY $prop" >>"$tmpcfg"
    else
      echo "INVARIANT $prop" >>"$tmpcfg"
    fi
    log="$out/$name.$prop.log"
    start=$(date +%s)
    rc=0
    (cd "$here" && timeout "$budget" "$tlc" -workers "$workers" -deadlock -noGenerateSpecTE \
      -metadir "$out/meta.$name.$prop" -config "$tmpcfg" "$module.tla") >"$log" 2>&1 || rc=$?
    secs=$(($(date +%s) - start))
    # A run killed before TLC printed a state count has none (grep exits 1).
    distinct=$(grep -oE '[0-9,]+ distinct states found' "$log" | tail -n 1 | cut -d' ' -f1 || true)
    case $rc in
      0) result=holds ;;
      12 | 13) result=VIOLATED ;; # 12: invariant/safety, 13: liveness
      124) result=bounded ;;
      *) result="error($rc)" ;;
    esac
    if [[ $expected == *" $prop "* ]]; then want=VIOLATED; else want=holds; fi
    [[ $result == "$want" ]] || status=1
    printf '%-32s %-20s %-9s %-8s %12s %6s\n' "$name" "$prop" "$result" "$want" "${distinct:-?}" "$secs"
  done
done
exit "$status"
