--------------------------- MODULE BgGateEvidence ---------------------------
(***************************************************************************)
(* Backend A runs a background process P in workspace W; backend B (same  *)
(* Xum root) renames/removes/archives W. At f30a1945a6:                    *)
(*   workspaceUseLeases.ts acquireMutationGate (:155-256): publish gate,   *)
(*     scan foreign use leases, then hasRunningBackgroundProcesses         *)
(*   workspaceService.ts (:10915-10980, :11014-11020): that check is       *)
(*     hasOrphanedRunningBackgroundProcesses over localBgWorkspaceDir      *)
(*     (= /tmp/mux-bashes/<ws>, backgroundProcessExecutor.ts:99-102) plus  *)
(*     the devcontainer bind-mount dir; a record not in B's own map with   *)
(*     status running, no exit_code and a live pid (or pid 0) is evidence  *)
(*   Background processes hold no use lease (findForeignUse reads only     *)
(*     .lock files, workspaceUseLeases.ts:284-303). A's spawn runs inside  *)
(*     A's turn, whose turn lease B's gate does see; once the turn ends,   *)
(*     the record is the only evidence.                                    *)
(*   Record roots: spawn on local/worktree -> /tmp; devcontainer -> the    *)
(*     bind mount; SSH/Coder, Docker -> the remote host. A migrated        *)
(*     (foreground->background) command's record is written under the     *)
(*     manager's bgOutputDir = path.join(os.tmpdir(), "mux-bashes")        *)
(*     (di/layers/core.ts:203), whatever the runtime.                      *)
(* #5465 case 3 (code at 486f156905), Crash: A's backend dies between the  *)
(*   spawn and writeMeta. spawnProcess creates the record directory with   *)
(*   output.log and clears exit_code (backgroundProcessExecutor.ts         *)
(*   :242-268) BEFORE it starts the child (:294); the manager writes       *)
(*   meta.json after (backgroundProcessManager.ts :1867). The crash drops  *)
(*   A's turn lease, but the scan reads a directory with neither meta.json *)
(*   nor exit_code as a live orphan (recordRootHoldsOrphan :2877-2890;     *)
(*   tests: backgroundProcessManager.test.ts \"fails closed on unreadable  *)
(*   records without an exit marker\"), and the wrapper's trap writes the  *)
(*   marker when P exits. Benign on the scanned roots:                     *)
(*   MC_gate_crash_before_meta and MC_gate_crash_devcontainer hold. A crash *)
(*   before the child starts leaves a markerless directory that keeps      *)
(*   refusing (safe over-refusal). Remote roots stay unscanned (#4889).    *)
(*   MetalessTrusted is the mutant that skips meta-less directories.       *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  Runtime,       \* "local" | "devcontainer" | "ssh" | "docker"
  Kind,          \* "spawn" | "migrated"
  TmpdirIsTmp,   \* os.tmpdir() = /tmp (Linux without TMPDIR); FALSE on macOS (/var/folders/...)
  NoRecordScan,  \* mutant: the gate skips the record scan
  Crash,         \* case 3: A's backend can die after its turn-lease hold, before AEnd
  MetalessTrusted \* mutant: the scan skips record directories without meta.json

\* The step order below is the spawn's; a migrated command runs before its directory exists.
ASSUME Crash => Kind = "spawn"

Root == IF Kind = "migrated" THEN (IF TmpdirIsTmp THEN "tmp" ELSE "ostmp")
        ELSE CASE Runtime = "local" -> "tmp"
               [] Runtime = "devcontainer" -> "bind"
               [] OTHER -> "remote"
Scanned == {"tmp"} \cup (IF Runtime = "devcontainer" THEN {"bind"} ELSE {})

VARIABLES
  apc, lease, dir, record, alive, marker, \* A: turn lease, P's record directory, its meta.json,
                                         \* P runs, P's exit_code marker
  bpc, gate, committed                   \* B's structural mutation

vars == <<apc, lease, dir, record, alive, marker, bpc, gate, committed>>

Init == /\ apc = "idle" /\ lease = FALSE /\ dir = FALSE /\ record = FALSE /\ alive = FALSE
        /\ marker = FALSE /\ bpc = "idle" /\ gate = FALSE /\ committed = FALSE

\* recordRootHoldsOrphan on one record: an exit marker settles it; meta.json says running and
\* the PID is live; no meta.json fails closed (unless the mutant trusts it).
Evidence == /\ Root \in Scanned /\ dir /\ ~marker
            /\ IF record THEN alive ELSE ~MetalessTrusted

\* --- A: a turn that starts P, then ends; P keeps running ---
AHold == /\ apc = "idle"                          \* turn lease hold probes the gate
         /\ IF gate THEN apc' = "refused" /\ UNCHANGED lease
                    ELSE apc' = "spawn" /\ lease' = TRUE
         /\ UNCHANGED <<dir, record, alive, marker, bpc, gate, committed>>
ADir == /\ apc = "spawn" /\ dir' = TRUE /\ apc' = "child"   \* output dir, no exit_code
        /\ UNCHANGED <<lease, record, alive, marker, bpc, gate, committed>>
AChild == /\ apc = "child" /\ alive' = TRUE /\ apc' = "meta"  \* the detached child starts
          /\ UNCHANGED <<lease, dir, record, marker, bpc, gate, committed>>
AMeta == /\ apc = "meta" /\ record' = TRUE /\ apc' = "end"    \* writeMeta
         /\ UNCHANGED <<lease, dir, alive, marker, bpc, gate, committed>>
AEnd == /\ apc = "end" /\ lease' = FALSE /\ apc' = "done"
        /\ UNCHANGED <<dir, record, alive, marker, bpc, gate, committed>>
\* Case 3: A's backend dies; its lease goes stale, P (if started) survives under nohup/setsid.
ACrash == /\ Crash /\ apc \in {"spawn", "child", "meta", "end"}
          /\ apc' = "crashed" /\ lease' = FALSE
          /\ UNCHANGED <<dir, record, alive, marker, bpc, gate, committed>>
PExit == /\ alive /\ alive' = FALSE /\ marker' = TRUE  \* the trap writes exit_code
         /\ UNCHANGED <<apc, lease, dir, record, bpc, gate, committed>>

\* --- B: the mutation gate, then the mutation ---
BGate == /\ bpc = "idle" /\ gate' = TRUE /\ bpc' = "leases"
         /\ UNCHANGED <<apc, lease, dir, record, alive, marker, committed>>
BLeases == /\ bpc = "leases"
           /\ bpc' = IF lease THEN "refused" ELSE "records"
           /\ gate' = IF lease THEN FALSE ELSE gate
           /\ UNCHANGED <<apc, lease, dir, record, alive, marker, committed>>
BRecords == /\ bpc = "records"
            /\ IF ~NoRecordScan /\ Evidence
                 THEN bpc' = "refused" /\ gate' = FALSE
                 ELSE bpc' = "commit" /\ UNCHANGED gate
            /\ UNCHANGED <<apc, lease, dir, record, alive, marker, committed>>
BCommit == /\ bpc = "commit" /\ committed' = TRUE /\ bpc' = "done"
           /\ UNCHANGED <<apc, lease, dir, record, alive, marker, gate>>

Next == AHold \/ ADir \/ AChild \/ AMeta \/ AEnd \/ ACrash \/ PExit
        \/ BGate \/ BLeases \/ BRecords \/ BCommit
Spec == Init /\ [][Next]_vars

\* B never commits its mutation while A's background process in W runs.
NoMutationUnderForeignProcess == committed => ~alive

TypeOK == apc \in {"idle", "spawn", "child", "meta", "end", "done", "refused", "crashed"}
=============================================================================
