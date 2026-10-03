--------------------------- MODULE OpenSSHPool ---------------------------
(***************************************************************************)
(* The OpenSSH connection pool for one host key, in discrete time.         *)
(*                                                                         *)
(* Modeled source (code at a186481add):                                    *)
(*   src/node/runtime/sshConnectionPool.ts                                 *)
(*     acquireConnection: backoff wait or fail fast, healthy + TTL +       *)
(*     ready ControlPath, singleflight join, start shared probe; the       *)
(*     "Last error:" text of the backoff and budget errors                 *)
(*     startSharedProbe / probeConnection / markHealthyByKey /             *)
(*     markFailedByKey (clears ready ControlPaths) / reportFailure         *)
(*   src/node/runtime/transports/OpenSSHTransport.ts                       *)
(*     spawnRemoteProcess: acquire with a sharded ControlPath, then        *)
(*     onExit: exit 255 -> reportFailure(stderr), else markHealthy         *)
(*     (FixUserExit255, the F3 fix: exit 255 -> requireReprobe instead)    *)
(*   src/node/runtime/RemoteRuntime.ts exec: onExit for every exit except  *)
(*     abort and timeout                                                   *)
(*   src/node/runtime/SSHRuntime.ts isTransportFailureExit (255, timeout)  *)
(*   src/node/runtime/Runtime.ts isPermanentSSHFailure (message text)      *)
(*   execFileIO read retry: one retry on a retryable transport error with  *)
(*     a short budget (READ_RETRY_TIMEOUT_SECS); the first error wins.     *)
(*                                                                         *)
(* Error texts are abstracted to classes: "net" (a transport failure) and  *)
(* "auth" (text that isPermanentSSHFailure matches, e.g. "Permission       *)
(* denied ("). The host's keys are always valid here, so any "auth" text   *)
(* that reaches a caller is a false permanent failure.                     *)
(*                                                                         *)
(* Users run arbitrary commands (the bash tool); Readers run cat/stat.     *)
(* A user command may itself exit 255 with any stderr, for example a       *)
(* nested `ssh other-host` that was refused.                               *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, Sequences

CONSTANTS
  Users, Readers,  \* disjoint caller sets
  Shard,           \* ControlPath shards (OPENSSH_EXEC_SHARD_COUNT)
  TTL,             \* HEALTHY_TTL_MS in ticks
  Budgets,         \* wait budgets a caller can bring (0 = maxWaitMs 0, fail fast)
  RetryBudget,     \* READ_RETRY_TIMEOUT_SECS in ticks
  FixUserExit255,        \* fix probe F3: an exec's exit 255 re-probes instead of backing off
  MutNoSingleflight,     \* mutant: start a probe even when one is in flight
  MutTimeoutAsMissing,   \* mutant: a timed-out read is not a transport failure (#4825 regression)
  MutInflightNotCleared  \* mutant: a failed probe stays in the in-flight map

Req == Users \cup Readers
None == "none"
Schedule == <<1, 2>>   \* SSH_BACKOFF_SCHEDULE_SECONDS, scaled (see SSH2Pool)
MaxBackoff == Schedule[Len(Schedule)]
Terminal == {"idle", "ok", "failed", "missing"}

VARIABLES
  hostUp,
  status,       \* health.status
  ttlLeft,      \* ticks until a healthy record is stale
  failures,     \* health.consecutiveFailures
  backoffLeft,  \* ticks until health.backoffUntil
  lastErr,      \* health.lastError class: "none" | "net" | "auth"
  lastCause,    \* who reported the failure behind the record: "none" | "transport" | "user"
  ready,        \* readyControlPaths for the key
  inflight,     \* inflight.get(key): the probe's owner, or None
  probe,        \* probe[o]: the ControlPath o's probe is bootstrapping, None when settled
  st            \* per caller: [pc, budget, wait, sh, attempt, err, first, on]

vars == <<hostUp, status, ttlLeft, failures, backoffLeft, lastErr, lastCause, ready,
          inflight, probe, st>>

Rec == [pc : Terminal \cup {"acq", "joined", "owner", "exec"},
        budget : 0..3, wait : BOOLEAN, sh : Shard, attempt : 0..1,
        err : {"none", "net", "auth"}, first : {"none", "net", "auth"},
        on : Req \cup {None}]

TypeOK ==
  /\ hostUp \in BOOLEAN
  /\ status \in {"unknown", "healthy", "unhealthy"}
  /\ ttlLeft \in 0..TTL
  /\ failures \in 0..Len(Schedule)
  /\ backoffLeft \in 0..MaxBackoff
  /\ lastErr \in {"none", "net", "auth"}
  /\ lastCause \in {"none", "transport", "user"}
  /\ ready \subseteq Shard
  /\ inflight \in Req \cup {None}
  /\ probe \in [Req -> Shard \cup {None}]
  /\ st \in [Req -> Rec]

Init ==
  /\ hostUp = TRUE
  /\ status = "unknown"
  /\ ttlLeft = 0
  /\ failures = 0
  /\ backoffLeft = 0
  /\ lastErr = "none"
  /\ lastCause = "none"
  /\ ready = {}
  /\ inflight = None
  /\ probe = [r \in Req |-> None]
  /\ st = [r \in Req |-> [pc |-> "idle", budget |-> 0, wait |-> FALSE,
                          sh |-> CHOOSE s \in Shard : TRUE, attempt |-> 0,
                          err |-> "none", first |-> "none", on |-> None]]

\* markHealthyByKey (probe success, or any exec exit that is not 255).
MarkHealthy ==
  /\ status' = "healthy" /\ ttlLeft' = TTL /\ failures' = 0 /\ backoffLeft' = 0
  /\ lastErr' = "none" /\ lastCause' = "none"

\* markFailedByKey (probe failure, reportFailure): next backoff step, ready paths cleared.
MarkFailed(e, cause) ==
  LET f == IF failures < Len(Schedule) THEN failures + 1 ELSE failures
  IN /\ status' = "unhealthy" /\ ttlLeft' = 0 /\ failures' = f /\ backoffLeft' = Schedule[f]
     /\ lastErr' = e /\ lastCause' = cause /\ ready' = {}

\* A caller's operation fails with error text class e. Readers retry once on a retryable
\* transport error (not permanent text) with a short budget; if the retry fails too, the
\* first error is the result.
Fail(r, s, e) ==
  IF r \in Readers /\ s.attempt = 0 /\ e = "net"
    THEN [s EXCEPT !.pc = "acq", !.attempt = 1, !.budget = RetryBudget,
                   !.wait = (RetryBudget > 0), !.first = e, !.on = None]
    ELSE [s EXCEPT !.pc = "failed", !.err = IF s.attempt = 1 THEN s.first ELSE e, !.on = None]

-----------------------------------------------------------------------------
(* Callers *)

\* One pass of the acquireConnection while-loop that does not sleep (lines 224-346).
AcqStep(r) ==
  LET s == st[r] IN
  /\ s.pc = "acq"
  /\ IF backoffLeft > 0
       THEN \* In backoff: fail fast, or the budget ran out; both carry "Last error: <lastError>".
            \* With budget left the caller sleeps instead (Tick), so this step is disabled.
            /\ (~s.wait \/ s.budget = 0)
            /\ st' = [st EXCEPT ![r] = Fail(r, s, lastErr)]
            /\ UNCHANGED <<inflight, probe>>
       ELSE IF status = "healthy" /\ ttlLeft > 0 /\ s.sh \in ready
         THEN /\ st' = [st EXCEPT ![r].pc = "exec"]
              /\ UNCHANGED <<inflight, probe>>
       ELSE IF inflight # None /\ ~MutNoSingleflight
         THEN IF probe[inflight] = None
                THEN \* (Mutant only) the map holds a settled, failed probe: awaiting it
                     \* rejects at once and the loop goes round again without sleeping.
                     /\ st' = [st EXCEPT ![r] = IF s.wait THEN s ELSE Fail(r, s, "net")]
                     /\ UNCHANGED <<inflight, probe>>
                ELSE IF s.wait /\ s.budget = 0
                  THEN /\ st' = [st EXCEPT ![r] = Fail(r, s, lastErr)]
                       /\ UNCHANGED <<inflight, probe>>
                  ELSE /\ st' = [st EXCEPT ![r].pc = "joined", ![r].on = inflight]
                       /\ UNCHANGED <<inflight, probe>>
       ELSE IF s.wait /\ s.budget = 0
         THEN /\ st' = [st EXCEPT ![r] = Fail(r, s, lastErr)]
              /\ UNCHANGED <<inflight, probe>>
         ELSE \* startSharedProbe: inflight.set(key, probe) with no await before it.
              /\ probe' = [probe EXCEPT ![r] = s.sh]
              /\ inflight' = r
              /\ st' = [st EXCEPT ![r].pc = "owner"]
  /\ UNCHANGED <<hostUp, status, ttlLeft, failures, backoffLeft, lastErr, lastCause, ready>>

\* A joiner's wait budget runs out: createWaitBudgetExceededError(health.lastError).
JoinExpire(r) ==
  /\ st[r].pc = "joined" /\ st[r].wait /\ st[r].budget = 0
  /\ st' = [st EXCEPT ![r] = Fail(r, st[r], lastErr)]
  /\ UNCHANGED <<hostUp, status, ttlLeft, failures, backoffLeft, lastErr, lastCause, ready,
                 inflight, probe>>

\* The probe settles. Success marks the host healthy and its ControlPath ready; failure
\* records a "net" failure. The owner returns or loops; joiners loop (or fail fast).
ProbeDone(o) ==
  /\ probe[o] # None
  /\ LET ok == hostUp
         after(r, s) ==
           IF r = o
             THEN IF ok THEN [s EXCEPT !.pc = "exec"]
                  ELSE IF s.wait THEN [s EXCEPT !.pc = "acq"] ELSE Fail(r, s, "net")
           ELSE IF s.pc = "joined" /\ s.on = o
             THEN IF ok \/ s.wait THEN [s EXCEPT !.pc = "acq", !.on = None]
                  ELSE Fail(r, s, "net")
           ELSE s
     IN /\ IF ok
             THEN /\ MarkHealthy
                  /\ ready' = ready \cup {probe[o]}
             ELSE MarkFailed("net", "transport")
        /\ st' = [r \in Req |-> after(r, st[r])]
        /\ inflight' = IF inflight = o /\ (ok \/ ~MutInflightNotCleared) THEN None ELSE inflight
        /\ probe' = [probe EXCEPT ![o] = None]
  /\ UNCHANGED hostUp

\* The exec's ssh process exits.
ExecDone(r) ==
  LET s == st[r] IN
  /\ s.pc = "exec"
  /\ IF hostUp
       THEN IF r \in Readers
              THEN /\ st' = [st EXCEPT ![r].pc = "ok"]
                   /\ MarkHealthy /\ UNCHANGED ready
              ELSE \E code \in {0, 255}, text \in {"net", "auth"} :
                     IF code = 0
                       THEN /\ st' = [st EXCEPT ![r].pc = "ok"]
                            /\ MarkHealthy /\ UNCHANGED ready
                       ELSE \* The user's command exited 255: RemoteRuntime calls onExit.
                            /\ st' = [st EXCEPT ![r].pc = "ok"]
                            /\ IF FixUserExit255
                                 \* Re-probe instead: the next acquire learns the truth.
                                 THEN /\ status' = "unknown" /\ ttlLeft' = 0 /\ ready' = {}
                                      /\ UNCHANGED <<failures, backoffLeft, lastErr, lastCause>>
                                 ELSE MarkFailed(text, "user")
       ELSE \* Host down: ssh exits 255, or the client-side timeout kills it first
            \* (RemoteRuntime skips onExit for timeouts).
            \E timedOut \in BOOLEAN :
              /\ IF timedOut
                   THEN UNCHANGED <<status, ttlLeft, failures, backoffLeft, lastErr, lastCause, ready>>
                   ELSE IF FixUserExit255
                          \* The fix cannot tell this 255 from the user's: re-probe here too;
                          \* the failing probe then sets the backoff.
                          THEN /\ status' = "unknown" /\ ttlLeft' = 0 /\ ready' = {}
                               /\ UNCHANGED <<failures, backoffLeft, lastErr, lastCause>>
                          ELSE MarkFailed("net", "transport")
              /\ st' = [st EXCEPT ![r] =
                          IF timedOut /\ MutTimeoutAsMissing /\ r \in Readers
                            THEN [s EXCEPT !.pc = "missing"]
                            ELSE Fail(r, s, "net")]
  /\ UNCHANGED <<hostUp, inflight, probe>>

HostDown == hostUp /\ hostUp' = FALSE /\ UNCHANGED <<status, ttlLeft, failures, backoffLeft,
              lastErr, lastCause, ready, inflight, probe, st>>
HostUp == ~hostUp /\ hostUp' = TRUE /\ UNCHANGED <<status, ttlLeft, failures, backoffLeft,
              lastErr, lastCause, ready, inflight, probe, st>>

Urgent == \E r \in Req : ENABLED AcqStep(r) \/ ENABLED JoinExpire(r)

Dec(x) == IF x > 0 THEN x - 1 ELSE x

\* Time passes: backoff and TTL count down; callers sleeping in backoff or joined to a probe
\* spend their budget.
Tick ==
  /\ ~Urgent
  /\ backoffLeft' = Dec(backoffLeft)
  /\ ttlLeft' = Dec(ttlLeft)
  /\ st' = [r \in Req |->
              IF (st[r].pc = "acq" \/ st[r].pc = "joined") /\ st[r].wait
                THEN [st[r] EXCEPT !.budget = Dec(@)] ELSE st[r]]
  /\ <<backoffLeft', ttlLeft', st'>> # <<backoffLeft, ttlLeft, st>>
  /\ UNCHANGED <<hostUp, status, failures, lastErr, lastCause, ready, inflight, probe>>

\* A new call is a macrotask: pending synchronous loop steps (microtasks) run first. This also
\* keeps callers from arriving infinitely often in zero time (see Fairness).
Begin(r) ==
  /\ ~Urgent
  /\ st[r].pc \in Terminal
  /\ \E b \in Budgets, s \in Shard :
       st' = [st EXCEPT ![r] = [pc |-> "acq", budget |-> b, wait |-> b > 0, sh |-> s,
                                attempt |-> 0, err |-> "none", first |-> "none", on |-> None]]
  /\ UNCHANGED <<hostUp, status, ttlLeft, failures, backoffLeft, lastErr, lastCause, ready,
                 inflight, probe>>

Next ==
  \/ \E r \in Req : Begin(r) \/ AcqStep(r) \/ JoinExpire(r) \/ ProbeDone(r) \/ ExecDone(r)
  \/ Tick \/ HostDown \/ HostUp

Fairness ==
  /\ \A r \in Req : WF_vars(AcqStep(r)) /\ WF_vars(JoinExpire(r)) /\ WF_vars(ProbeDone(r))
                    /\ WF_vars(ExecDone(r))
  \* Non-Zeno: time keeps passing. Strong fairness, because callers that arrive and fail fast
  \* in zero time disable Tick (Urgent) again and again, which weak fairness allows forever.
  /\ SF_vars(Tick)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

\* At most one probe runs per host key (the singleflight).
OneProbePerKey == Cardinality({r \in Req : probe[r] # None}) <= 1

\* A read never reports "missing" because of a transport failure (all files exist here).
ClassificationSafe == \A r \in Req : st[r].pc # "missing"

\* The pool backs off only on evidence that the host or its transport failed.
NoFalseBackoff == backoffLeft > 0 => lastCause = "transport"

\* No caller gets a permanent ("auth") failure: the keys are valid, so such a failure stops
\* the read retry and the backoff wait for nothing.
NoFalsePermanent == \A r \in Req : ~(st[r].pc = "failed" /\ st[r].err = "auth")

\* Once the host stays up and callers keep coming, the pool is healthy again and again.
Recovers ==
  (<>[]hostUp /\ []<>(\E r \in Req : st[r].pc \in {"acq", "joined"}))
    => []<>(status = "healthy")

=============================================================================
