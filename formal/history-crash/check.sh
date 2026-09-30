#!/usr/bin/env bash
# Model-check the HistoryService crash-consistency specs.
#
# Usage: formal/history-crash/check.sh [case-name-substring]
#
# Each case writes a TLC config into a scratch directory, runs TLC, and
# compares the outcome with the expected one:
#   pass           - TLC explored the whole state space without a violation
#   <Invariant>    - TLC must report exactly this invariant as violated
# Exit status is non-zero when any case does not match its expectation.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tlc="${TLC:-$HOME/.local/bin/tlc}"
work="$(mktemp -d "${XUM_SCRATCH_DIR:-${TMPDIR:-/tmp}}/history-crash-tlc.XXXXXX")"
filter="${1:-}"
failures=0

# spec | case | expected | constants (space separated k=v) | invariants
cases=(
  # --- HistoryPartial: current code ------------------------------------------
  # F1/F2 are fixed (RR=TRUE UI=TRUE): commitPartial retires a partial without its own row,
  # and updateHistory matches rows by message id (historyService.ts).
  "HistoryPartial|P4-fixed-all|pass|B=2 C=1 T=3 E=1 P=1 DF=FALSE RR=TRUE UI=TRUE|NoGhostRow NoDuplicateRow NoDuplicateSeq NoLostCommittedRow NoLostStreamedContent NoCommitError"
  "HistoryPartial|P4-fixed-concurrent|pass|B=2 C=1 T=2 E=1 P=1 DF=FALSE RR=TRUE UI=TRUE CS=TRUE|NoGhostRow NoDuplicateRow NoDuplicateSeq NoLostCommittedRow NoCommitError"
  # F3 is fixed (DF=FALSE): stream completion writes the final row, then deletes its partial.
  "HistoryPartial|P1-finish-order-fixed|pass|B=1 C=1 T=2 E=0 P=2 DF=FALSE RR=TRUE UI=TRUE|NoLostStreamedContent"
  # F4, not fixed (DF=FALSE isolates it from F3): concurrent streams share partial.json.
  "HistoryPartial|P5-concurrent-streams|NoLostStreamedContent|B=2 C=0 T=2 E=0 P=1 DF=FALSE RR=TRUE UI=TRUE CS=TRUE|NoLostStreamedContent"
  # --- HistoryPartial: before the F1/F2 fix (RR=FALSE UI=FALSE) ----------------
  # commitPartial and updateHistory matched rows by historySequence alone.
  "HistoryPartial|P2-edit-crash-ghost|NoGhostRow|B=1 C=2 T=3 E=1 P=1 DF=FALSE|NoGhostRow"
  "HistoryPartial|P2-edit-one-crash|pass|B=1 C=1 T=3 E=1 P=1 DF=FALSE|NoGhostRow NoDuplicateRow NoDuplicateSeq NoLostCommittedRow NoLostStreamedContent NoCommitError"
  "HistoryPartial|P2-edit-crash-others|pass|B=1 C=2 T=3 E=1 P=1 DF=FALSE|NoDuplicateRow NoDuplicateSeq NoLostCommittedRow NoLostStreamedContent NoCommitError"
  "HistoryPartial|P3-two-backend-ghost|NoGhostRow|B=2 C=0 T=2 E=1 P=2 DF=FALSE|NoGhostRow"
  "HistoryPartial|P3-two-backend-commit-err|NoCommitError|B=2 C=0 T=2 E=1 P=2 DF=FALSE|NoCommitError"
  "HistoryPartial|P3-two-backend-overwrite|NoLostCommittedRow|B=2 C=0 T=2 E=1 P=1 DF=FALSE CS=TRUE|NoLostCommittedRow"
  "HistoryPartial|P3-two-backend-guarded|pass|B=2 C=0 T=2 E=1 P=2 DF=FALSE G=TRUE|NoGhostRow NoDuplicateRow NoDuplicateSeq NoLostCommittedRow NoLostStreamedContent NoCommitError"
  # --- HistoryPartial: mutation sanity -----------------------------------------
  # Pre-F3-fix completion order (deletePartial, then updateHistory) loses the reply.
  "HistoryPartial|P1-finish-order|NoLostStreamedContent|B=1 C=1 T=2 E=0 P=2 DF=TRUE RR=TRUE UI=TRUE|NoLostStreamedContent"
  "HistoryPartial|M1-unlink-before-commit|NoLostStreamedContent|B=1 C=1 T=2 E=0 P=1 DF=FALSE RR=TRUE UI=TRUE MU=TRUE|NoLostStreamedContent"
  "HistoryPartial|M2-no-torn-separator|NoLostCommittedRow|B=1 C=1 T=2 E=0 P=1 DF=FALSE RR=TRUE UI=TRUE MS=TRUE|NoLostCommittedRow"
  # --- ArchiveSwap: current code -------------------------------------------
  "ArchiveSwap|A1-single-backend|pass|B=1 C=1 A=3 R=2 X=1|NoLostRow NoResurrectedRow TruncationAtomic"
  "ArchiveSwap|A1-single-backend-2crash|pass|B=1 C=2 A=3 R=2 X=1|NoLostRow NoResurrectedRow TruncationAtomic"
  # F5, not fixed yet: read-path rotation skips truncate recovery. Checks NoLostRow only:
  # TLC's parallel workers otherwise report NoLostRow or TruncationAtomic nondeterministically.
  "ArchiveSwap|A2-two-backend-rotation|NoLostRow|B=2 C=1 A=3 R=2 X=1|NoLostRow"
  "ArchiveSwap|A2-two-backend-no-crash|pass|B=2 C=0 A=3 R=2 X=1|NoLostRow NoResurrectedRow TruncationAtomic"
  # --- ArchiveSwap: candidate F5 fix + mutation sanity ---------------------
  "ArchiveSwap|A3-rotation-recovers|pass|B=2 C=1 A=3 R=2 X=1 RR=TRUE|NoLostRow NoResurrectedRow TruncationAtomic"
  "ArchiveSwap|M3-unlink-tombstone-first|TruncationAtomic|B=1 C=1 A=3 R=1 X=1 MU=TRUE|TruncationAtomic"
  "ArchiveSwap|M4-recover-forward-only|NoLostRow|B=1 C=1 A=3 R=1 X=1 MR=TRUE|NoLostRow"
  "ArchiveSwap|M5-no-torn-separator|NoLostRow|B=1 C=1 A=2 R=0 X=0 MT=TRUE|NoLostRow"
)

render_partial_cfg() {
  local kv="$1" invs="$2" B=1 C=1 T=2 E=1 P=1 G=FALSE DF=FALSE RE=TRUE RR=FALSE UI=FALSE MU=FALSE MS=FALSE CS=FALSE backends
  local pair
  for pair in $kv; do
    case "$pair" in
      B=*) B="${pair#B=}" ;; C=*) C="${pair#C=}" ;; T=*) T="${pair#T=}" ;;
      E=*) E="${pair#E=}" ;; P=*) P="${pair#P=}" ;; G=*) G="${pair#G=}" ;;
      DF=*) DF="${pair#DF=}" ;; RE=*) RE="${pair#RE=}" ;; RR=*) RR="${pair#RR=}" ;;
      UI=*) UI="${pair#UI=}" ;; MU=*) MU="${pair#MU=}" ;; MS=*) MS="${pair#MS=}" ;;
      CS=*) CS="${pair#CS=}" ;;
      *) echo "unknown constant $pair" >&2; exit 2 ;;
    esac
  done
  if [ "$B" = 1 ]; then backends='{"b1"}'; else backends='{"b1", "b2"}'; fi
  cat <<EOF
SPECIFICATION Spec
CONSTANTS
  Backends = $backends
  MaxCrashes = $C
  MaxTurns = $T
  MaxEdits = $E
  MaxParts = $P
  CrossBackendBusyGuard = $G
  CompleteDeletesFirst = $DF
  RetirePartialOnEdit = $RE
  CommitRequiresRow = $RR
  UpdateMatchesId = $UI
  MutUnlinkFirst = $MU
  MutNoSeparator = $MS
  ConcurrentStreams = $CS
INVARIANTS TypeOK $invs
EOF
}

render_archive_cfg() {
  local kv="$1" invs="$2" B=1 C=1 A=2 R=1 X=1 RR=FALSE MU=FALSE MR=FALSE MT=FALSE backends
  local pair
  for pair in $kv; do
    case "$pair" in
      B=*) B="${pair#B=}" ;; C=*) C="${pair#C=}" ;; A=*) A="${pair#A=}" ;;
      R=*) R="${pair#R=}" ;; X=*) X="${pair#X=}" ;; MU=*) MU="${pair#MU=}" ;;
      MR=*) MR="${pair#MR=}" ;; MT=*) MT="${pair#MT=}" ;; RR=*) RR="${pair#RR=}" ;;
      *) echo "unknown constant $pair" >&2; exit 2 ;;
    esac
  done
  if [ "$B" = 1 ]; then backends='{"b1"}'; else backends='{"b1", "b2"}'; fi
  cat <<EOF
SPECIFICATION Spec
CONSTANTS
  Backends = $backends
  MaxCrashes = $C
  MaxAppends = $A
  MaxRotations = $R
  MaxTruncations = $X
  RotationRecovers = $RR
  MutUnlinkTombstoneFirst = $MU
  MutRecoverForwardOnly = $MR
  MutNoTornSeparator = $MT
INVARIANTS TypeOK $invs
EOF
}

for entry in "${cases[@]}"; do
  IFS='|' read -r spec name expected kv invs <<<"$entry"
  if [ -n "$filter" ] && [[ "$name" != *"$filter"* ]]; then continue; fi
  cfg="$work/$name.cfg"
  if [ "$spec" = HistoryPartial ]; then
    render_partial_cfg "$kv" "$invs" >"$cfg"
  else
    render_archive_cfg "$kv" "$invs" >"$cfg"
  fi
  log="$work/$name.log"
  start=$(date +%s)
  set +e
  (cd "$here" && "$tlc" -workers auto -deadlock -noGenerateSpecTE -metadir "$work/$name.meta" \
    -config "$cfg" "$spec.tla") >"$log" 2>&1
  rc=$?
  set -e
  secs=$(( $(date +%s) - start ))
  states="$(grep -Eo '[0-9,]+ distinct states found' "$log" | tail -n 1 || true)"
  violated="$(sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated\.$/\1/p' "$log" | head -n 1)"
  if [ "$rc" -eq 0 ]; then outcome=pass; elif [ "$rc" -eq 12 ] && [ -n "$violated" ]; then outcome="$violated"; else outcome="error(rc=$rc)"; fi
  if [ "$outcome" = "$expected" ]; then verdict=OK; else verdict=MISMATCH; failures=$((failures + 1)); fi
  printf '%-8s %-30s expected=%-22s got=%-22s %s %ss  log=%s\n' \
    "$verdict" "$name" "$expected" "$outcome" "${states:-?}" "$secs" "$log"
done

if [ "$failures" -ne 0 ]; then
  echo "$failures case(s) did not match their expectation" >&2
  exit 1
fi
echo "all cases matched"
