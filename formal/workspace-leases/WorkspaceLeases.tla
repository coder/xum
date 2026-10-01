-------------------------- MODULE WorkspaceLeases --------------------------
(***************************************************************************)
(* Workspace-use leases and the structural mutation gate (#4476), for ONE *)
(* workspace W shared by backends on one Xum root, at commit ea52e87b33:   *)
(*   src/node/services/workspaceUseLeases.ts    hold / release /           *)
(*       acquireMutationGate / assertUnused                                *)
(*   src/node/services/workspaceService.ts      acquireStructuralMutation- *)
(*       Gate (:10881), executeBash "exec" lease (:18979-19206)            *)
(*   src/node/services/agentSession.ts          "turn" lease: begun        *)
(*       without await in completePreparation (:3914), confirmed only in   *)
(*       streamWithHistory (:7934)                                         *)
(*                                                                         *)
(* Granularity: one action per await-free segment. Each backend           *)
(* incarnation runs one turn, one one-off command (exec) and one          *)
(* structural mutator; crash and restart (pid reuse) of a backend are     *)
(* environment actions.                                                    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Backends,      \* e.g. {"A", "B"}
  Kinds,         \* lease kinds modelled: subset of {"turn", "exec"}
  MutIgnore,     \* own kinds the mutator ignores: rename {"exec"}, remove/archive {"turn","exec"}
  MaxGen,        \* incarnations per backend (crash + restart bound)
  CanCrash,
  MaxRuns,       \* activities per process incarnation (bounds the state space)
  \* Fix probe / mutants (FALSE for the faithful model):
  ConfirmFirst,  \* fix: the turn confirms its lease before preparation touches the checkout
  NoProbe,       \* mutant: hold() skips its gate probe (workspaceUseLeases.ts:318-327)
  NoScan,        \* mutant: the mutator skips its lease scan (:189-191)
  ScanFirst      \* mutant: the mutator scans before publishing its gate

NoGate == [b |-> "none", g |-> 0]
NoProc == <<"none", "none">>
Roles == {"turn", "lease", "exec", "mut"}   \* "lease": the turn's un-awaited hold
Procs == Backends \X Roles

VARIABLES
  alive, gen,
  file,      \* [b][k]: lease file <instanceToken>.<k>.lock published, with its writer's gen
  cnt,       \* [b][k]: in-memory hold count (lost on crash)
  tlock,     \* [b]: process holding this backend's transition lock for W, or NoProc
  gate,      \* NoGate or [b, g]: the mutation gate's writer
  pc, runs,
  leaseSt,   \* [b]: the turn lease future: "none" | "pending" | "held" | "refused"
  fresh,     \* [p]: this hold published a new file (withdrawn on refusal)
  badTouch   \* history: an activity touched the checkout during a forbidden mutation

vars == <<alive, gen, file, cnt, tlock, gate, pc, runs, leaseSt, fresh, badTouch>>

FileLive(b, k) == file[b][k] # 0 /\ alive[b] /\ file[b][k] = gen[b]
GateLive == gate.b # "none" /\ alive[gate.b] /\ gate.g = gen[gate.b]
Committing(b) == pc[<<b, "mut">>] = "commit"

\* A touch of the checkout by backend b's activity of kind k is forbidden
\* while another backend mutates W, or while b mutates it without ignoring k.
Forbidden(b, k) == \E m \in Backends : Committing(m) /\ (m # b \/ k \notin MutIgnore)
Touch(b, k) == badTouch' = (badTouch \/ Forbidden(b, k))

Init ==
  /\ alive = [b \in Backends |-> TRUE]
  /\ gen = [b \in Backends |-> 1]
  /\ file = [b \in Backends |-> [k \in Kinds |-> 0]]
  /\ cnt = [b \in Backends |-> [k \in Kinds |-> 0]]
  /\ tlock = [b \in Backends |-> NoProc]
  /\ gate = NoGate
  /\ pc = [p \in Procs |-> "idle"]
  /\ runs = [p \in Procs |-> 0]
  /\ leaseSt = [b \in Backends |-> "none"]
  /\ fresh = [p \in Procs |-> FALSE]
  /\ badTouch = FALSE

Go(p, to) == pc' = [pc EXCEPT ![p] = to]
KindOf(p) == IF p[2] = "lease" THEN "turn" ELSE p[2]

---------------------------------------------------------------------------
(* hold(W, k), workspaceUseLeases.ts:298-336, run by process p.            *)
(* Entry pc "h_lock"; exits to "h_ok" or "h_refused".                      *)

HLock(p) ==
  LET b == p[1] IN
  /\ pc[p] = "h_lock" /\ tlock[b] = NoProc                 \* :299 transitions.withLock
  /\ tlock' = [tlock EXCEPT ![b] = p]
  /\ Go(p, "h_pub")
  /\ UNCHANGED <<alive, gen, file, cnt, gate, runs, leaseSt, fresh, badTouch>>

HPub(p) ==   \* :303-314 first hold of the kind publishes this instance's file
  LET b == p[1]  k == KindOf(p) IN
  /\ pc[p] = "h_pub"
  /\ IF cnt[b][k] = 0
       THEN file' = [file EXCEPT ![b][k] = gen[b]] /\ fresh' = [fresh EXCEPT ![p] = TRUE]
       ELSE UNCHANGED file /\ fresh' = [fresh EXCEPT ![p] = FALSE]
  /\ Go(p, "h_probe")
  /\ UNCHANGED <<alive, gen, cnt, tlock, gate, runs, leaseSt, badTouch>>

HProbe(p) == \* :318-335 probe the gate; live gate => withdraw and throw
  LET b == p[1]  k == KindOf(p) IN
  /\ pc[p] = "h_probe"
  /\ IF GateLive /\ ~NoProbe
       THEN Go(p, "h_withdraw") /\ UNCHANGED <<cnt, tlock>>
       ELSE /\ cnt' = [cnt EXCEPT ![b][k] = @ + 1]
            /\ tlock' = [tlock EXCEPT ![b] = NoProc]
            /\ Go(p, "h_ok")
  /\ UNCHANGED <<alive, gen, file, gate, runs, leaseSt, fresh, badTouch>>

HWithdraw(p) == \* :322 await release?.() of a freshly published file, then throw
  LET b == p[1]  k == KindOf(p) IN
  /\ pc[p] = "h_withdraw"
  /\ file' = IF fresh[p] THEN [file EXCEPT ![b][k] = 0] ELSE file
  /\ tlock' = [tlock EXCEPT ![b] = NoProc]
  /\ Go(p, "h_refused")
  /\ UNCHANGED <<alive, gen, cnt, gate, runs, leaseSt, fresh, badTouch>>

(* release(), :341-355: count--, and at zero unlink the file (one await).  *)
RLock(p) ==
  LET b == p[1]  k == KindOf(p) IN
  /\ pc[p] = "r_lock" /\ tlock[b] = NoProc
  /\ cnt' = [cnt EXCEPT ![b][k] = @ - 1]
  /\ IF cnt[b][k] = 1
       THEN tlock' = [tlock EXCEPT ![b] = p] /\ Go(p, "r_unlink")
       ELSE UNCHANGED tlock /\ Go(p, "r_done")
  /\ UNCHANGED <<alive, gen, file, gate, runs, leaseSt, fresh, badTouch>>
RUnlink(p) ==
  LET b == p[1]  k == KindOf(p) IN
  /\ pc[p] = "r_unlink"
  /\ file' = [file EXCEPT ![b][k] = 0]
  /\ tlock' = [tlock EXCEPT ![b] = NoProc]
  /\ Go(p, "r_done")
  /\ UNCHANGED <<alive, gen, cnt, gate, runs, leaseSt, fresh, badTouch>>

HoldStep(p) == HLock(p) \/ HPub(p) \/ HProbe(p) \/ HWithdraw(p) \/ RLock(p) \/ RUnlink(p)

---------------------------------------------------------------------------
(* One-off command, workspaceService.ts executeBash: hold (awaited) at     *)
(* :19025 before path/runtime resolution and spawn; released at exit.      *)
ExecStart(p) ==
  /\ p[2] = "exec" /\ "exec" \in Kinds /\ pc[p] = "idle" /\ runs[p] < MaxRuns
  /\ runs' = [runs EXCEPT ![p] = @ + 1]
  /\ Go(p, "h_lock")
  /\ UNCHANGED <<alive, gen, file, cnt, tlock, gate, leaseSt, fresh, badTouch>>
ExecAfterHold(p) ==
  /\ p[2] = "exec"
  /\ \/ pc[p] = "h_refused" /\ Go(p, "idle") /\ UNCHANGED badTouch
     \/ pc[p] = "h_ok" /\ Touch(p[1], "exec") /\ Go(p, "x_run")          \* :19057-19206
  /\ UNCHANGED <<alive, gen, file, cnt, tlock, gate, runs, leaseSt, fresh>>
ExecRun(p) ==
  /\ p[2] = "exec" /\ pc[p] = "x_run"
  /\ Touch(p[1], "exec") /\ Go(p, "r_lock")
  /\ UNCHANGED <<alive, gen, file, cnt, tlock, gate, runs, leaseSt, fresh>>
ExecDone(p) ==
  /\ p[2] = "exec" /\ pc[p] = "r_done" /\ Go(p, "idle")
  /\ UNCHANGED <<alive, gen, file, cnt, tlock, gate, runs, leaseSt, fresh, badTouch>>

---------------------------------------------------------------------------
(* Turn, agentSession.ts. The lease future runs as process <<b,"lease">>.   *)

\* :3906-3914 completePreparation: beginTurnUseLease() starts hold, no await.
TurnBegin(b) ==
  LET t == <<b, "turn">>  l == <<b, "lease">> IN
  /\ "turn" \in Kinds /\ pc[t] = "idle" /\ runs[t] < MaxRuns /\ pc[l] = "idle"
  /\ runs' = [runs EXCEPT ![t] = @ + 1]
  /\ leaseSt' = [leaseSt EXCEPT ![b] = "pending"]
  /\ pc' = [pc EXCEPT ![t] = "prep", ![l] = "h_lock"]
  /\ UNCHANGED <<alive, gen, file, cnt, tlock, gate, fresh, badTouch>>

\* The hold settles: :3980 .catch keeps a refusal as a value.
LeaseSettle(b) ==
  LET l == <<b, "lease">> IN
  /\ pc[l] \in {"h_ok", "h_refused"}
  /\ leaseSt' = [leaseSt EXCEPT ![b] = IF pc[l] = "h_ok" THEN "held" ELSE "refused"]
  /\ Go(l, "idle")
  /\ UNCHANGED <<alive, gen, file, cnt, tlock, gate, runs, fresh, badTouch>>

\* prepareMessage before confirmation: @file reads (:4838), skill dynamic-
\* context commands run in the checkout (:12085), rollover ensureReady /
\* init wait (turnRequestBuilder.ts:1464-1490), changed-file reads (:7826).
\* Faithful: runs whatever the pending hold will say.
TurnPrep(b) ==
  LET t == <<b, "turn">> IN
  /\ pc[t] = "prep"
  /\ ConfirmFirst => leaseSt[b] = "held"
  /\ Touch(b, "turn") /\ Go(t, "confirm")
  /\ UNCHANGED <<alive, gen, file, cnt, tlock, gate, runs, leaseSt, fresh>>
TurnPrepRefusedFix(b) ==   \* fix probe only: a refused lease ends the turn before preparation
  LET t == <<b, "turn">> IN
  /\ ConfirmFirst /\ pc[t] = "prep" /\ leaseSt[b] = "refused"
  /\ leaseSt' = [leaseSt EXCEPT ![b] = "none"] /\ Go(t, "idle")
  /\ UNCHANGED <<alive, gen, file, cnt, tlock, gate, runs, fresh, badTouch>>

\* :7934-7935 confirmTurnUseLease: a refusal fails the send.
TurnConfirm(b) ==
  LET t == <<b, "turn">> IN
  /\ pc[t] = "confirm" /\ leaseSt[b] \in {"held", "refused"}
  /\ IF leaseSt[b] = "held"
       THEN Go(t, "stream") /\ UNCHANGED leaseSt
       ELSE Go(t, "idle") /\ leaseSt' = [leaseSt EXCEPT ![b] = "none"]
  /\ UNCHANGED <<alive, gen, file, cnt, tlock, gate, runs, fresh, badTouch>>

\* The provider stream and its tools (:8037 onward).
TurnStream(b) ==
  LET t == <<b, "turn">> IN
  /\ pc[t] = "stream"
  /\ Touch(b, "turn") /\ Go(t, "end")
  /\ UNCHANGED <<alive, gen, file, cnt, tlock, gate, runs, leaseSt, fresh>>

\* Idle: releaseTurnUseLeaseIfIdle (:4007) runs the lease's release.
TurnEnd(b) ==
  LET t == <<b, "turn">>  l == <<b, "lease">> IN
  /\ pc[t] = "end" /\ pc[l] = "idle"
  /\ leaseSt' = [leaseSt EXCEPT ![b] = "none"]
  /\ pc' = [pc EXCEPT ![t] = "idle", ![l] = "r_lock"]
  /\ UNCHANGED <<alive, gen, file, cnt, tlock, gate, runs, fresh, badTouch>>
LeaseReleased(b) ==
  LET l == <<b, "lease">> IN
  /\ pc[l] = "r_done" /\ Go(l, "idle")
  /\ UNCHANGED <<alive, gen, file, cnt, tlock, gate, runs, leaseSt, fresh, badTouch>>

---------------------------------------------------------------------------
(* Structural mutator: acquireMutationGate (:145-198) + the mutation.      *)

MutStart(b) ==
  LET m == <<b, "mut">> IN
  /\ pc[m] = "idle" /\ runs[m] < MaxRuns
  /\ runs' = [runs EXCEPT ![m] = @ + 1]
  /\ Go(m, IF ScanFirst THEN "scan_lock" ELSE "g_acq")
  /\ UNCHANGED <<alive, gen, file, cnt, tlock, gate, leaseSt, fresh, badTouch>>

\* :171-177 try-lock the gate (acquireTimeoutMs 0; a dead writer's gate is
\* taken over by crossProcessLock's supersede).
MutGate(b) ==
  LET m == <<b, "mut">> IN
  /\ pc[m] = "g_acq"
  /\ IF GateLive
       THEN Go(m, "idle") /\ UNCHANGED gate            \* WorkspaceBusyError
       ELSE /\ gate' = [b |-> b, g |-> gen[b]]
            /\ Go(m, IF ScanFirst THEN "commit" ELSE "scan_lock")
  /\ UNCHANGED <<alive, gen, file, cnt, tlock, runs, leaseSt, fresh, badTouch>>

\* :190 assertUnused under the transition lock: own counts of non-ignored
\* kinds (:205-213), then other backends' live files (:214-240; one
\* readdir + inspect pass, atomic here: files published after the gate see it).
MutScanLock(b) ==
  LET m == <<b, "mut">> IN
  /\ pc[m] = "scan_lock" /\ tlock[b] = NoProc
  /\ tlock' = [tlock EXCEPT ![b] = m] /\ Go(m, "scan")
  /\ UNCHANGED <<alive, gen, file, cnt, gate, runs, leaseSt, fresh, badTouch>>
Busy(b) ==
  \/ \E k \in Kinds \ MutIgnore : cnt[b][k] > 0
  \/ \E o \in Backends \ {b}, k \in Kinds : FileLive(o, k)
MutScan(b) ==
  LET m == <<b, "mut">> IN
  /\ pc[m] = "scan"
  /\ tlock' = [tlock EXCEPT ![b] = NoProc]
  /\ IF Busy(b) /\ ~NoScan
       THEN /\ Go(m, "idle")
            /\ gate' = IF ~ScanFirst /\ gate.b = b THEN NoGate ELSE gate  \* :193
       ELSE Go(m, IF ScanFirst THEN "g_acq" ELSE "commit") /\ UNCHANGED gate
  /\ UNCHANGED <<alive, gen, file, cnt, runs, leaseSt, fresh, badTouch>>

\* The mutation (rename / remove / checkout-deleting archive), then the
\* gate's release (:196-197).
MutCommitDone(b) ==
  LET m == <<b, "mut">> IN
  /\ pc[m] = "commit"
  /\ gate' = IF gate.b = b THEN NoGate ELSE gate
  /\ Go(m, "idle")
  /\ UNCHANGED <<alive, gen, file, cnt, tlock, runs, leaseSt, fresh, badTouch>>

---------------------------------------------------------------------------
(* Environment: SIGKILL of a backend (files stay, memory is lost) and its   *)
(* restart as a new process (new pid or reused pid with a new start time). *)
Crash(b) ==
  /\ CanCrash /\ alive[b]
  /\ alive' = [alive EXCEPT ![b] = FALSE]
  /\ cnt' = [cnt EXCEPT ![b] = [k \in Kinds |-> 0]]
  /\ tlock' = [tlock EXCEPT ![b] = NoProc]
  /\ pc' = [p \in Procs |-> IF p[1] = b THEN "dead" ELSE pc[p]]
  /\ leaseSt' = [leaseSt EXCEPT ![b] = "none"]
  /\ UNCHANGED <<gen, file, gate, runs, fresh, badTouch>>
Restart(b) ==
  /\ ~alive[b] /\ gen[b] < MaxGen
  /\ alive' = [alive EXCEPT ![b] = TRUE]
  /\ gen' = [gen EXCEPT ![b] = @ + 1]
  /\ pc' = [p \in Procs |-> IF p[1] = b THEN "idle" ELSE pc[p]]
  \* MaxRuns bounds each incarnation: the new process may run every activity again, so a
  \* turn or mutation is explored on both sides of a crash (stale files, pid reuse).
  /\ runs' = [p \in Procs |-> IF p[1] = b THEN 0 ELSE runs[p]]
  /\ UNCHANGED <<file, cnt, tlock, gate, leaseSt, fresh, badTouch>>

Next ==
  \/ \E p \in Procs : alive[p[1]] /\ (HoldStep(p) \/ ExecStart(p) \/ ExecAfterHold(p)
                                      \/ ExecRun(p) \/ ExecDone(p))
  \/ \E b \in Backends : alive[b] /\
       ( TurnBegin(b) \/ LeaseSettle(b) \/ TurnPrep(b) \/ TurnPrepRefusedFix(b)
         \/ TurnConfirm(b) \/ TurnStream(b) \/ TurnEnd(b) \/ LeaseReleased(b)
         \/ MutStart(b) \/ MutGate(b) \/ MutScanLock(b) \/ MutScan(b) \/ MutCommitDone(b))
  \/ \E b \in Backends : Crash(b) \/ Restart(b)

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
(* Properties *)

\* Protocol (Dekker) safety: while a backend commits a mutation, no other
\* live backend counts a lease on W, and it counts none of its own
\* non-ignored kinds.
GateExclusion == \A m \in Backends : Committing(m) =>
  /\ \A o \in Backends \ {m}, k \in Kinds : ~(alive[o] /\ cnt[o][k] > 0)
  /\ \A k \in Kinds \ MutIgnore : cnt[m][k] = 0

\* Ground truth: no activity touches the checkout during a mutation that
\* must not run beside it (workspaceUseLeases.ts:17-29 header).
NoTouchDuringMutation == ~badTouch

\* At most one mutation commits at a time.
OneMutator == Cardinality({b \in Backends : Committing(b)}) <= 1

TypeOK == /\ \A b \in Backends, k \in Kinds : cnt[b][k] \in 0..2
          /\ \A b \in Backends : leaseSt[b] \in {"none", "pending", "held", "refused"}
=============================================================================
