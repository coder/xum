------------------------------ MODULE BgMonitor ------------------------------
(***************************************************************************)
(* A bash monitor (run_in_background + monitor) racing its process's exit, *)
(* at f30a1945a6, backgroundProcessManager.ts:                             *)
(*   tail loop (:1347-1430): read new output (await), match lines, probe   *)
(*     the exit code (await); on exit claim the settlement (:1384) before  *)
(*     its next await and emit the terminal wake                           *)
(*   scheduleMonitorFlush (:1042-1058): a cooldown timer flushes pending   *)
(*     matches as a match-only wake                                        *)
(*   claimMonitorSettlement (:871-881): synchronous `settled` latch; it    *)
(*     clears the cooldown timer, so no flush follows a settlement         *)
(*   terminate with flush (timeout timer, :1834) claims it too; discard    *)
(*     (task_stop, cleanup) cancels the monitor without a wake             *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  MaxLines,     \* matching output lines the process may print
  NoLatch       \* mutant: the claim is not exclusive

VARIABLES
  alive, printed, read, pending, timer, settled,
  tpc,          \* tail loop: "read" | "probe" | "emit" | "done"
  kpc,          \* flush-mode terminate: "idle" | "kill" | "emit" | "done"
  terminalWakes, matchAfterTerminal

vars == <<alive, printed, read, pending, timer, settled, tpc, kpc, terminalWakes,
          matchAfterTerminal>>

Init ==
  /\ alive = TRUE /\ printed = 0 /\ read = 0 /\ pending = 0 /\ timer = FALSE /\ settled = FALSE
  /\ tpc = "read" /\ kpc = "idle" /\ terminalWakes = 0 /\ matchAfterTerminal = FALSE

Print == /\ alive /\ printed < MaxLines /\ printed' = printed + 1
         /\ UNCHANGED <<alive, read, pending, timer, settled, tpc, kpc, terminalWakes,
                        matchAfterTerminal>>
Exit == /\ alive /\ alive' = FALSE
        /\ UNCHANGED <<printed, read, pending, timer, settled, tpc, kpc, terminalWakes,
                       matchAfterTerminal>>

Claim == ~settled \/ NoLatch

TRead ==   \* read the new lines, queue matches, arm the cooldown
  /\ tpc = "read"
  /\ IF printed > read /\ ~settled
       THEN pending' = pending + (printed - read) /\ timer' = TRUE
       ELSE UNCHANGED <<pending, timer>>
  /\ read' = printed /\ tpc' = "probe"
  /\ UNCHANGED <<alive, printed, settled, kpc, terminalWakes, matchAfterTerminal>>
TProbe ==  \* exit-code probe; on exit claim before the next await
  /\ tpc = "probe"
  /\ IF ~alive /\ read = printed
       THEN IF Claim
              THEN settled' = TRUE /\ timer' = FALSE /\ tpc' = "emit"
              ELSE UNCHANGED <<settled, timer>> /\ tpc' = "done"
       ELSE UNCHANGED <<settled, timer>> /\ tpc' = IF settled THEN "done" ELSE "read"
  /\ UNCHANGED <<alive, printed, read, pending, kpc, terminalWakes, matchAfterTerminal>>
TEmit == /\ tpc = "emit" /\ terminalWakes' = terminalWakes + 1 /\ pending' = 0 /\ tpc' = "done"
         /\ UNCHANGED <<alive, printed, read, timer, settled, kpc, matchAfterTerminal>>

Flush ==   \* the cooldown timer fires: a match-only wake
  /\ timer /\ pending > 0
  /\ matchAfterTerminal' = (matchAfterTerminal \/ terminalWakes > 0)
  /\ pending' = 0 /\ timer' = FALSE
  /\ UNCHANGED <<alive, printed, read, settled, tpc, kpc, terminalWakes>>

KStart ==  \* flush-mode terminate (timeout): claim synchronously, then kill
  /\ kpc = "idle" /\ alive
  /\ IF Claim THEN settled' = TRUE /\ timer' = FALSE /\ kpc' = "kill"
              ELSE UNCHANGED <<settled, timer>> /\ kpc' = "done"
  /\ UNCHANGED <<alive, printed, read, pending, tpc, terminalWakes, matchAfterTerminal>>
KKill == /\ kpc = "kill" /\ alive' = FALSE /\ kpc' = "emit"
         /\ UNCHANGED <<printed, read, pending, timer, settled, tpc, terminalWakes,
                        matchAfterTerminal>>
KEmit == /\ kpc = "emit" /\ terminalWakes' = terminalWakes + 1 /\ pending' = 0 /\ kpc' = "done"
         /\ UNCHANGED <<alive, printed, read, timer, settled, tpc, matchAfterTerminal>>

Next == Print \/ Exit \/ TRead \/ TProbe \/ TEmit \/ Flush \/ KStart \/ KKill \/ KEmit
Spec == Init /\ [][Next]_vars

AtMostOneTerminalWake == terminalWakes <= 1
NoMatchWakeAfterTerminal == ~matchAfterTerminal
\* Liveness is not checked: a wake for every exit depends on scheduling (see the report).

TypeOK == pending \in 0..MaxLines /\ terminalWakes \in 0..2
=============================================================================
