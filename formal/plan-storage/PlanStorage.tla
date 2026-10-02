---------------------------- MODULE PlanStorage ----------------------------
(***************************************************************************)
(* Where plan files live and who may create, copy, read and delete them.   *)
(*                                                                         *)
(* Plans live at <xumHome>/plans/<project basename>/<workspace name>.md    *)
(* (src/common/utils/planStorage.ts getPlanFilePath). Every workspace in   *)
(* this model has the same project basename and the same name N, so the    *)
(* only question is whether two workspaces' plan paths are physically one  *)
(* file and whether the code's guards know it.                             *)
(*                                                                         *)
(* Physical sharing: one SSH host (or the local home) holds one file per   *)
(* (basename, name). Two Xum installations on one SSH host both use        *)
(* ~/.mux there (#5174); with InstallScopedPaths (candidate fix) each      *)
(* installation gets its own file.                                         *)
(*                                                                         *)
(* What the guards see (Sees): only rows in the deciding installation's    *)
(* config, and only when sharesPlanDirectory says the storage is shared.   *)
(* sharesPlanStorage compares raw SSH host strings, so two spellings of    *)
(* one host count as different storage (#5180, Alias); ResolveAlias is    *)
(* the candidate fix. Rename's name check compares every workspace of the  *)
(* installation, whatever its storage (SeesRename).                        *)
(*                                                                         *)
(* Operations, one sub-step per await point of the code (workspaceService):*)
(*  create  pre: planDirectoryNames preflight (create ~6057)               *)
(*          reg: registration editConfig (~6330), no re-check (#5181)      *)
(*               unless CreateRecheck                                      *)
(*  fork    pre: namesTakenFrom check (~13172)                             *)
(*          copy: copyPlanFileAcrossRuntimes (~13519), overwrites          *)
(*          reg: addWorkspace refuseTakenName (~13779); on refusal the     *)
(*               rollback keeps the copy (copiedPlanPath := undefined)     *)
(*          ForkCopyAfterRegister moves copy after reg (#5175 fix), and    *)
(*          the copy no longer overwrites: on an existing target it fails  *)
(*          and the fork's rollback removes its row.                       *)
(*  rename  pre: global name check (~9419); reg: editConfig (~9694), no    *)
(*          re-check unless RenameRecheck; mv: movePlanFile (`mv`, which   *)
(*          overwrites) brings the workspace's existing plan to N.         *)
(*  write   the agent writes its plan (registered workspaces only)         *)
(*  clear   full clear / replaceHistory(deletePlanFile): deletes the plan  *)
(*          path with no sharing guard (~16965) unless ClearGuard          *)
(*  remove  dereg: config row removed; del: deletePlanFilesOfRemoved-      *)
(*          Workspace keeps the path when a visible row shares it (~8297)  *)
(*  mkfifo  something replaces the plan path with a FIFO                   *)
(*  send    sendMessage's FileChangeTracker.getChangedAttachments: bare    *)
(*          stat + readFile on the tracked plan path (fileChangeTracker.ts *)
(*          ~170); a FIFO without a writer blocks it unless RegularOnlyRead*)
(* Crash stops a workspace's script between any two sub-steps.             *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Scenario,  \* which workspaces run which scripts (below)
  Alias,     \* the guards' sharesPlanStorage misses that a and b share one host (#5180)
  Crashes,   \* model crashes between sub-steps
  Fixes,     \* candidate fixes on; {} = the code at origin/main f30a1945a6
  Mutant     \* "none" or a mutation that must be caught

None == "none"
W == {"a", "b"}

CreateRecheck == "createRecheck" \in Fixes
ForkCopyAfterRegister == "forkCopyAfterRegister" \in Fixes
RenameRecheck == "renameRecheck" \in Fixes
ClearGuard == "clearGuard" \in Fixes
ResolveAlias == "resolveAlias" \in Fixes
InstallScopedPaths == "installScopedPaths" \in Fixes
RegularOnlyRead == "regularOnlyRead" \in Fixes
MutRemoveNoGuard == Mutant = "removeNoGuard"
MutForkNoRefuse == Mutant = "forkNoRefuse"
MutForkSkipCopy == Mutant = "forkSkipCopy"

\* Two installations on one SSH host (#5174); otherwise one installation.
Install == IF Scenario = "two_installs" THEN [w \in W |-> IF w = "a" THEN 1 ELSE 2]
                                        ELSE [w \in W |-> 1]
\* "seeded_*": both rows already registered under N in one plan directory, as the races below
\* (or a pre-#5139 build) leave them.
Seeded == Scenario \in {"seeded_remove", "seeded_clear"}
Script ==
  CASE Scenario = "create_race" ->
         [w \in W |-> IF w = "a" THEN <<"create", "write">> ELSE <<"create", "write", "clear">>]
    [] Scenario = "fork_race" ->
         [w \in W |-> IF w = "a" THEN <<"fork", "write">> ELSE <<"fork">>]
    [] Scenario = "rename_race" ->
         [w \in W |-> IF w = "a" THEN <<"create", "write">> ELSE <<"rename">>]
    [] Scenario \in {"two_installs", "alias"} ->
         [w \in W |-> IF w = "a" THEN <<"create", "write">>
                                 ELSE <<"create", "write", "clear", "remove">>]
    [] Scenario = "seeded_remove" ->
         [w \in W |-> IF w = "a" THEN <<"write">> ELSE <<"remove">>]
    [] Scenario = "seeded_clear" ->
         [w \in W |-> IF w = "a" THEN <<"write">> ELSE <<"clear">>]
    [] Scenario = "fifo" ->
         [w \in W |-> IF w = "a" THEN <<"create", "write", "mkfifo", "send">> ELSE <<>>]

\* One physical file per path; installation-scoped paths split it per installation.
PathOf(w) == IF InstallScopedPaths THEN Install[w] ELSE 0
Paths == {PathOf(w) : w \in W}

\* Whether w's guards treat w2's row as sharing w's plan directory.
Sees(w, w2) == Install[w] = Install[w2] /\ (~Alias \/ ResolveAlias)
\* Rename's name check: every row of the installation (stricter than Sees).
SeesRename(w, w2) == Install[w] = Install[w2]

Steps == [create |-> <<"pre", "reg">>,
          fork |-> IF ForkCopyAfterRegister THEN <<"pre", "reg", "copy">>
                                            ELSE <<"pre", "copy", "reg">>,
          rename |-> <<"pre", "reg", "mv">>,
          write |-> <<"do">>, clear |-> <<"do">>,
          remove |-> <<"dereg", "del">>,
          mkfifo |-> <<"do">>, send |-> <<"do">>]

VARIABLES
  pc,       \* [W -> index into Script[w]] (Len+1 = done)
  sub,      \* [W -> index into the current op's Steps]
  halted,   \* [W -> BOOLEAN] crashed
  reg,      \* [W -> {"none","reg","removed"}] config row
  file,     \* [Paths -> None \cup W]: whose plan the file holds
  kind,     \* [Paths -> {"regular","fifo"}]
  copied,   \* [W -> BOOLEAN] fork's copiedPlanPath is set
  lost,     \* [W -> BOOLEAN] another workspace changed w's live plan
  blocked   \* a send-path read blocked on a FIFO

vars == <<pc, sub, halted, reg, file, kind, copied, lost, blocked>>

TypeOK ==
  /\ pc \in [W -> 1..10]
  /\ sub \in [W -> 1..3]
  /\ halted \in [W -> BOOLEAN]
  /\ reg \in [W -> {"none", "reg", "removed"}]
  /\ file \in [Paths -> {None} \cup W]
  /\ kind \in [Paths -> {"regular", "fifo"}]
  /\ copied \in [W -> BOOLEAN]
  /\ lost \in [W -> BOOLEAN]
  /\ blocked \in BOOLEAN

Init ==
  /\ pc = [w \in W |-> 1]
  /\ sub = [w \in W |-> 1]
  /\ halted = [w \in W |-> FALSE]
  /\ reg = [w \in W |-> IF Seeded THEN "reg" ELSE "none"]
  /\ file = [p \in Paths |-> None]
  /\ kind = [p \in Paths |-> "regular"]
  /\ copied = [w \in W |-> FALSE]
  /\ lost = [w \in W |-> FALSE]
  /\ blocked = FALSE

Active(w) == ~halted[w] /\ pc[w] <= Len(Script[w])
Op(w) == Script[w][pc[w]]
Step(w) == Steps[Op(w)][sub[w]]

\* Finish the current sub-step; `fail` abandons the rest of the op.
Advance(w, fail) ==
  IF fail \/ sub[w] = Len(Steps[Op(w)])
  THEN /\ pc' = [pc EXCEPT ![w] = pc[w] + 1]
       /\ sub' = [sub EXCEPT ![w] = 1]
  ELSE /\ sub' = [sub EXCEPT ![w] = sub[w] + 1]
       /\ UNCHANGED pc

\* A visible registered row with name N (all rows are named N).
Taken(w) == \E w2 \in W : w2 # w /\ reg[w2] = "reg" /\ Sees(w, w2)
TakenRename(w) == \E w2 \in W : w2 # w /\ reg[w2] = "reg" /\ SeesRename(w, w2)

\* x sets w's plan path to v; a live plan of another registered workspace there is lost.
SetFile(x, v) ==
  LET p == PathOf(x) IN
  /\ file' = [file EXCEPT ![p] = v]
  /\ lost' = [w \in W |-> lost[w] \/
                (w # x /\ reg[w] = "reg" /\ PathOf(w) = p /\ file[p] = w /\ v # w)]

Exec(w) ==
  /\ Active(w)
  /\ LET op == Op(w)
         st == Step(w)
         p == PathOf(w) IN
     CASE op = "create" /\ st = "pre" ->
            /\ Advance(w, Taken(w))
            /\ UNCHANGED <<reg, file, kind, copied, lost, blocked>>
       [] op = "create" /\ st = "reg" ->
            /\ IF CreateRecheck /\ Taken(w)
               THEN UNCHANGED reg
               ELSE reg' = [reg EXCEPT ![w] = "reg"]
            /\ Advance(w, FALSE)
            /\ UNCHANGED <<file, kind, copied, lost, blocked>>
       [] op = "fork" /\ st = "pre" ->
            /\ Advance(w, Taken(w))
            /\ UNCHANGED <<reg, file, kind, copied, lost, blocked>>
       [] op = "fork" /\ st = "copy" /\ MutForkSkipCopy ->
            /\ Advance(w, FALSE)
            /\ UNCHANGED <<reg, file, kind, copied, lost, blocked>>
       [] op = "fork" /\ st = "copy" ->
            IF ForkCopyAfterRegister /\ file[p] # None
            THEN \* No-clobber copy: it refuses an existing target, and the fork's rollback
                 \* removes its row.
                 /\ reg' = [reg EXCEPT ![w] = "none"]
                 /\ Advance(w, TRUE)
                 /\ UNCHANGED <<file, kind, copied, lost, blocked>>
            ELSE \* The copy returns its path only when the target did not exist.
                 /\ copied' = [copied EXCEPT ![w] = (file[p] = None)]
                 /\ SetFile(w, w)
                 /\ kind' = [kind EXCEPT ![p] = "regular"]
                 /\ Advance(w, FALSE)
                 /\ UNCHANGED <<reg, blocked>>
       [] op = "fork" /\ st = "reg" ->
            IF Taken(w) /\ ~MutForkNoRefuse
            THEN \* WorkspaceNameTakenError: copiedPlanPath := undefined, copy kept.
                 /\ copied' = [copied EXCEPT ![w] = FALSE]
                 /\ Advance(w, TRUE)
                 /\ UNCHANGED <<reg, file, kind, lost, blocked>>
            ELSE /\ reg' = [reg EXCEPT ![w] = "reg"]
                 /\ Advance(w, FALSE)
                 /\ UNCHANGED <<file, kind, copied, lost, blocked>>
       [] op = "rename" /\ st = "pre" ->
            /\ Advance(w, TakenRename(w))
            /\ UNCHANGED <<reg, file, kind, copied, lost, blocked>>
       [] op = "rename" /\ st = "reg" ->
            /\ IF RenameRecheck /\ TakenRename(w)
               THEN /\ Advance(w, TRUE)
                    /\ UNCHANGED reg
               ELSE /\ reg' = [reg EXCEPT ![w] = "reg"]
                    /\ Advance(w, FALSE)
            /\ UNCHANGED <<file, kind, copied, lost, blocked>>
       [] op = "rename" /\ st = "mv" ->
            \* The workspace's plan under its old name moves onto N.
            /\ SetFile(w, w)
            /\ kind' = [kind EXCEPT ![p] = "regular"]
            /\ Advance(w, FALSE)
            /\ UNCHANGED <<reg, copied, blocked>>
       [] op = "write" ->
            /\ IF reg[w] = "reg"
               THEN /\ SetFile(w, w)
                    /\ kind' = [kind EXCEPT ![p] = "regular"]
               ELSE UNCHANGED <<file, lost, kind>>
            /\ Advance(w, FALSE)
            /\ UNCHANGED <<reg, copied, blocked>>
       [] op = "clear" ->
            /\ IF reg[w] = "reg" /\ ~(ClearGuard /\ Taken(w))
               THEN /\ SetFile(w, None)
                    /\ kind' = [kind EXCEPT ![p] = "regular"]
               ELSE UNCHANGED <<file, lost, kind>>
            /\ Advance(w, FALSE)
            /\ UNCHANGED <<reg, copied, blocked>>
       [] op = "remove" /\ st = "dereg" ->
            /\ Advance(w, reg[w] # "reg")
            /\ reg' = [reg EXCEPT ![w] = IF reg[w] = "reg" THEN "removed" ELSE reg[w]]
            /\ UNCHANGED <<file, kind, copied, lost, blocked>>
       [] op = "remove" /\ st = "del" ->
            /\ IF ~MutRemoveNoGuard /\ Taken(w)
               THEN UNCHANGED <<file, lost, kind>>
               ELSE /\ SetFile(w, None)
                    /\ kind' = [kind EXCEPT ![p] = "regular"]
            /\ Advance(w, FALSE)
            /\ UNCHANGED <<reg, copied, blocked>>
       [] op = "mkfifo" ->
            /\ IF reg[w] = "reg"
               THEN /\ kind' = [kind EXCEPT ![p] = "fifo"]
                    /\ SetFile(w, w)
               ELSE UNCHANGED <<kind, file, lost>>
            /\ Advance(w, FALSE)
            /\ UNCHANGED <<reg, copied, blocked>>
       [] op = "send" ->
            \* The tracked plan changed since it was read: readFile runs.
            /\ blocked' = (blocked \/ (reg[w] = "reg" /\ kind[p] = "fifo" /\ ~RegularOnlyRead))
            /\ Advance(w, FALSE)
            /\ UNCHANGED <<reg, file, kind, copied, lost>>

Crash(w) ==
  /\ Crashes
  /\ Active(w)
  /\ halted' = [halted EXCEPT ![w] = TRUE]
  /\ UNCHANGED <<pc, sub, reg, file, kind, copied, lost, blocked>>

Next ==
  \/ \E w \in W : Exec(w) /\ UNCHANGED halted
  \/ \E w \in W : Crash(w)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants. *)

\* Each physical plan path has at most one live owner workspace.
UniqueOwner ==
  \A p \in Paths : Cardinality({w \in W : reg[w] = "reg" /\ PathOf(w) = p}) <= 1

\* No create, fork, rename, write, clear or remove of one workspace changes (overwrites or
\* deletes) the live plan of another registered workspace.
NoForeignClobber == \A w \in W : ~lost[w]

\* A plan read on the send path never blocks on a non-regular file.
NoBlockedRead == ~blocked

\* A fork that registered and finished holds its plan (every modeled source has one). With
\* ForkCopyAfterRegister a crash between the registration and the copy leaves a live row without
\* its plan; that fork is halted mid-op, which this allows: the code reads a missing plan as no
\* plan, the same state as forking a source that has none (#5462 item 1). Fork scripts never
\* clear, so "finished" is any later point in the script.
ForkHasPlan ==
  \A w \in W : (Script[w] # <<>> /\ Script[w][1] = "fork" /\ pc[w] > 1 /\ reg[w] = "reg")
                 => file[PathOf(w)] = w
=============================================================================
