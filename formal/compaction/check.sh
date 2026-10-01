#!/usr/bin/env bash
# Model-check the compaction protocol spec (CompactionProtocol.tla).
#
# Usage: formal/compaction/check.sh [case-name-substring]
#
# Each case writes a TLC config into a scratch directory, runs TLC, and
# compares the outcome with the expected one:
#   pass           - TLC explored the whole state space without a violation
#   <Invariant>    - TLC must report exactly this invariant as violated
# Exit status is non-zero when any case does not match its expectation.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tlc="${TLC:-$HOME/.local/bin/tlc}"
work="$(mktemp -d "${XUM_SCRATCH_DIR:-${TMPDIR:-/tmp}}/compaction-tlc.XXXXXX")"
filter="${1:-}"
failures=0

ALL="FollowUpAtMostOnce StopHonored FoldOnce NoStaleFold NoStaleJournal BoundaryOnce"
REST="StopHonored FoldOnce NoStaleFold NoStaleJournal BoundaryOnce"

# case | expected | constants (space separated k=v) | invariants
cases=(
  # --- pre-fix code (bugs C1/C2; the code now implements F2) -----------------
  "C1-edit-crash-refollow|FollowUpAtMostOnce|B=1 C=1 CH=0 MC=1 E=1 CC=0 R=0 RC=1|FollowUpAtMostOnce"
  "C1-edit-no-crash|pass|B=1 C=0 CH=1 MC=1 E=1 CC=1 R=1 RC=1|$ALL"
  "C2-two-backend-dispatch|FollowUpAtMostOnce|B=2 C=0 CH=0 MC=1 E=0 CC=0 R=0 RC=1|FollowUpAtMostOnce"
  "C2-two-backend-stop-honored|pass|B=2 C=0 CH=0 MC=1 E=0 CC=0 R=0 RC=1|StopHonored"
  "C1-two-backend-edit|FollowUpAtMostOnce|B=2 C=0 CH=0 MC=1 E=1 CC=0 R=0 RC=1 RL=TRUE|FollowUpAtMostOnce"
  "C3-other-properties-1b|pass|B=1 C=2 CH=1 MC=1 E=1 CC=1 R=1 RC=2|$REST"
  "C3-other-properties-2b|pass|B=2 C=1 CH=0 MC=1 E=1 CC=1 R=1 RC=1|$REST"
  # --- fixes: F2 is implemented (agentSession.compactionFollowUpOnce.test.ts) -
  "F1-edit-clears-follow-up|pass|B=1 C=1 CH=1 MC=1 E=1 CC=1 R=1 RC=2 EC=TRUE|$ALL"
  "F2-recheck-under-lock|pass|B=2 C=1 CH=0 MC=1 E=1 CC=1 R=1 RC=1 RL=TRUE EC=TRUE|$ALL"
  # --- mutation sanity -------------------------------------------------------
  "M1-fold-not-idempotent|BoundaryOnce|B=1 C=1 CH=0 MC=0 E=0 CC=1 R=0 RC=1 MF=TRUE|BoundaryOnce"
  "M2-journal-ignores-generation|NoStaleFold|B=2 C=0 CH=0 MC=1 E=0 CC=1 R=0 RC=0 MG=TRUE|NoStaleFold"
  "M3-no-in-memory-stop-fence|StopHonored|B=1 C=0 CH=0 MC=1 E=0 CC=0 R=0 RC=0 MS=TRUE|StopHonored"
)

render_cfg() {
  local kv="$1" invs="$2" B=1 C=1 CH=1 MC=1 E=1 CC=1 R=1 RC=1 RL=FALSE EC=FALSE MG=FALSE MS=FALSE MF=FALSE backends
  local pair
  for pair in $kv; do
    case "$pair" in
      B=*) B="${pair#B=}" ;; C=*) C="${pair#C=}" ;; CH=*) CH="${pair#CH=}" ;;
      MC=*) MC="${pair#MC=}" ;; E=*) E="${pair#E=}" ;; CC=*) CC="${pair#CC=}" ;;
      R=*) R="${pair#R=}" ;; RC=*) RC="${pair#RC=}" ;; RL=*) RL="${pair#RL=}" ;;
      EC=*) EC="${pair#EC=}" ;; MG=*) MG="${pair#MG=}" ;; MS=*) MS="${pair#MS=}" ;;
      MF=*) MF="${pair#MF=}" ;;
      *) echo "unknown constant $pair" >&2; exit 2 ;;
    esac
  done
  if [ "$B" = 1 ]; then backends='{"b1"}'; else backends='{"b1", "b2"}'; fi
  cat <<EOF
SPECIFICATION Spec
CONSTANTS
  Backends = $backends
  MaxCrashes = $C
  MaxChats = $CH
  MaxCompactions = $MC
  MaxEdits = $E
  MaxContinuous = $CC
  MaxResets = $R
  MaxRecoveries = $RC
  RecheckFollowUpUnderLock = $RL
  EditClearsFollowUp = $EC
  MutJournalIgnoresGeneration = $MG
  MutNoInMemoryFence = $MS
  MutNoFoldIdempotence = $MF
INVARIANTS TypeOK $invs
EOF
}

for entry in "${cases[@]}"; do
  IFS='|' read -r name expected kv invs <<<"$entry"
  if [ -n "$filter" ] && [[ "$name" != *"$filter"* ]]; then continue; fi
  cfg="$work/$name.cfg"
  render_cfg "$kv" "$invs" >"$cfg"
  log="$work/$name.log"
  start=$(date +%s)
  set +e
  (cd "$here" && "$tlc" -workers auto -deadlock -noGenerateSpecTE -metadir "$work/$name.meta" \
    -config "$cfg" CompactionProtocol.tla) >"$log" 2>&1
  rc=$?
  set -e
  secs=$(( $(date +%s) - start ))
  states="$(grep -Eo '[0-9,]+ distinct states found' "$log" | tail -n 1 || true)"
  violated="$(sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated\.$/\1/p' "$log" | head -n 1)"
  if [ "$rc" -eq 0 ]; then outcome=pass; elif [ "$rc" -eq 12 ] && [ -n "$violated" ]; then outcome="$violated"; else outcome="error(rc=$rc)"; fi
  if [ "$outcome" = "$expected" ]; then verdict=OK; else verdict=MISMATCH; failures=$((failures + 1)); fi
  printf '%-8s %-32s expected=%-20s got=%-20s %s %ss  log=%s\n' \
    "$verdict" "$name" "$expected" "$outcome" "${states:-?}" "$secs" "$log"
done

if [ "$failures" -ne 0 ]; then
  echo "$failures case(s) did not match their expectation" >&2
  exit 1
fi
echo "all cases matched"
