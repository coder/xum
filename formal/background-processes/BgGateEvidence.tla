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
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  Runtime,       \* "local" | "devcontainer" | "ssh" | "docker"
  Kind,          \* "spawn" | "migrated"
  TmpdirIsTmp,   \* os.tmpdir() = /tmp (Linux without TMPDIR); FALSE on macOS (/var/folders/...)
  NoRecordScan   \* mutant: the gate skips the record scan

Root == IF Kind = "migrated" THEN (IF TmpdirIsTmp THEN "tmp" ELSE "ostmp")
        ELSE CASE Runtime = "local" -> "tmp"
               [] Runtime = "devcontainer" -> "bind"
               [] OTHER -> "remote"
Scanned == {"tmp"} \cup (IF Runtime = "devcontainer" THEN {"bind"} ELSE {})

VARIABLES
  apc, lease, record, alive,   \* A: turn lease, P's record exists, P runs
  bpc, gate, committed         \* B's structural mutation

vars == <<apc, lease, record, alive, bpc, gate, committed>>

Init == /\ apc = "idle" /\ lease = FALSE /\ record = FALSE /\ alive = FALSE
        /\ bpc = "idle" /\ gate = FALSE /\ committed = FALSE

\* --- A: a turn that starts P, then ends; P keeps running ---
AHold == /\ apc = "idle"                          \* turn lease hold probes the gate
         /\ IF gate THEN apc' = "refused" /\ UNCHANGED lease
                    ELSE apc' = "spawn" /\ lease' = TRUE
         /\ UNCHANGED <<record, alive, bpc, gate, committed>>
ASpawn == /\ apc = "spawn" /\ record' = TRUE /\ alive' = TRUE /\ apc' = "end"
          /\ UNCHANGED <<lease, bpc, gate, committed>>
AEnd == /\ apc = "end" /\ lease' = FALSE /\ apc' = "done"
        /\ UNCHANGED <<record, alive, bpc, gate, committed>>
PExit == /\ alive /\ alive' = FALSE               \* the trap writes exit_code
         /\ UNCHANGED <<apc, lease, record, bpc, gate, committed>>

\* --- B: the mutation gate, then the mutation ---
BGate == /\ bpc = "idle" /\ gate' = TRUE /\ bpc' = "leases"
         /\ UNCHANGED <<apc, lease, record, alive, committed>>
BLeases == /\ bpc = "leases"
           /\ bpc' = IF lease THEN "refused" ELSE "records"
           /\ gate' = IF lease THEN FALSE ELSE gate
           /\ UNCHANGED <<apc, lease, record, alive, committed>>
BRecords == /\ bpc = "records"
            /\ IF ~NoRecordScan /\ record /\ alive /\ Root \in Scanned
                 THEN bpc' = "refused" /\ gate' = FALSE
                 ELSE bpc' = "commit" /\ UNCHANGED gate
            /\ UNCHANGED <<apc, lease, record, alive, committed>>
BCommit == /\ bpc = "commit" /\ committed' = TRUE /\ bpc' = "done"
           /\ UNCHANGED <<apc, lease, record, alive, gate>>

Next == AHold \/ ASpawn \/ AEnd \/ PExit \/ BGate \/ BLeases \/ BRecords \/ BCommit
Spec == Init /\ [][Next]_vars

\* B never commits its mutation while A's background process in W runs.
NoMutationUnderForeignProcess == committed => ~alive

TypeOK == apc \in {"idle", "spawn", "end", "done", "refused"}
=============================================================================
