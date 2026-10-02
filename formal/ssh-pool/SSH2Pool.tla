---------------------------- MODULE SSH2Pool ----------------------------
(***************************************************************************)
(* The ssh2 connection pool for one host key, in discrete time.            *)
(*                                                                         *)
(* Modeled source (code at a186481add):                                    *)
(*   src/node/runtime/SSH2ConnectionPool.ts                                *)
(*     acquireConnection  (existing entry -> backoff -> singleflight)      *)
(*     touchConnection / trackChannel / closeIdleConnection (idle close)   *)
(*     connect: onClose / "error" handlers, connections.set on ready       *)
(*     markHealthy / reportFailure (SSH_BACKOFF_SCHEDULE_SECONDS)          *)
(*   src/node/runtime/transports/SSH2Transport.ts spawnRemoteProcess       *)
(*     acquire -> client.exec -> trackChannel inside the exec callback;    *)
(*     SSH2ChildProcess: a channel closed by a dropped connection is a     *)
(*     "network" error (#4835), never exit 0.                              *)
(*                                                                         *)
(* Time: one Tick is one discrete unit. The idle timer and the backoff are *)
(* countdowns, so the state space stays finite without a time bound and    *)
(* liveness can be checked. Code that runs without awaiting a timer or I/O *)
(* (the acquire loop's checks, the microtask hand-off of a finished        *)
(* connect to its waiters) is one atomic step, and time cannot pass while  *)
(* such a step is pending (Urgent).                                        *)
(*                                                                         *)
(* A client's terminal events ("end", "close", "error") are asynchronous:  *)
(* after the pool calls client.end() or the network drops the socket, the  *)
(* client is "ending" until LateEvent delivers them. Nothing bounds that   *)
(* delay (a dead TCP path, a ProxyCommand that is slow to exit).           *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, Sequences

CONSTANTS
  Req,          \* concurrent callers (acquire + one exec each, repeated)
  Client,       \* ssh2 Client objects; recycled once nothing refers to them
  Idle,         \* IDLE_TIMEOUT_MS in ticks
  IdentityCheckOnClose,   \* fix probe F1: onClose/error delete only their own entry
  TrackPendingOpen,       \* fix probe F2: an exec whose channel is still opening keeps the connection
  MutIdleIgnoresChannels, \* mutant: idle close ignores open channels (#4876 regression)
  MutNoSingleflight,      \* mutant: start a connect even when one is in flight
  MutEofAsExit0           \* mutant: a channel cut by a dropped connection reads as exit 0 (#4835 regression)

None == "none"
AcqStates == {"acquiring", "joined"}
Terminal == {"idle", "ok", "network", "missing", "gaveup"}
\* SSH_BACKOFF_SCHEDULE_SECONDS = [1, 2, 4, 7, 10], scaled down to two growing steps in ticks
\* (more steps only lengthen waits; jitter, +-20%, is not modeled).
Schedule == <<1, 2>>
MaxBackoff == Schedule[Len(Schedule)]

VARIABLES
  hostUp,
  cst,          \* client state: "closed" | "connecting" | "open" | "ending"
  closedBy,     \* who started the close: "none" | "pool" | "net"
  idleLeft,     \* idle timer countdown, -1 = no timer armed for this client
  openCh,       \* SSH2ConnectionEntry.openChannels
  pendOpen,     \* execs whose channel is still opening (only counted with TrackPendingOpen)
  conn,         \* connections.get(key)
  inflight,     \* inflight.get(key)
  failures,     \* health.consecutiveFailures
  backoffLeft,  \* ticks until health.backoffUntil (0 = not in backoff)
  pc,           \* per caller
  rc            \* the client a caller acquired or waits on

vars == <<hostUp, cst, closedBy, idleLeft, openCh, pendOpen, conn, inflight,
          failures, backoffLeft, pc, rc>>

TypeOK ==
  /\ hostUp \in BOOLEAN
  /\ cst \in [Client -> {"closed", "connecting", "open", "ending"}]
  /\ closedBy \in [Client -> {"none", "pool", "net"}]
  /\ idleLeft \in [Client -> -1..Idle]
  /\ openCh \in [Client -> 0..Cardinality(Req)]
  /\ pendOpen \in [Client -> 0..Cardinality(Req)]
  /\ conn \in Client \cup {None}
  /\ inflight \in Client \cup {None}
  /\ failures \in 0..Len(Schedule)
  /\ backoffLeft \in 0..MaxBackoff
  /\ pc \in [Req -> Terminal \cup AcqStates \cup {"opening", "running"}]
  /\ rc \in [Req -> Client \cup {None}]

Init ==
  /\ hostUp = TRUE
  /\ cst = [c \in Client |-> "closed"]
  /\ closedBy = [c \in Client |-> "none"]
  /\ idleLeft = [c \in Client |-> -1]
  /\ openCh = [c \in Client |-> 0]
  /\ pendOpen = [c \in Client |-> 0]
  /\ conn = None
  /\ inflight = None
  /\ failures = 0
  /\ backoffLeft = 0
  /\ pc = [r \in Req |-> "idle"]
  /\ rc = [r \in Req |-> None]

\* markHealthy: a fresh health record without backoffUntil.
Healthy == /\ failures' = 0 /\ backoffLeft' = 0
\* reportFailure: next schedule step (capped at the last entry).
Failure ==
  LET f == IF failures < Len(Schedule) THEN failures + 1 ELSE failures
  IN /\ failures' = f /\ backoffLeft' = Schedule[f]

Referenced(c) ==
  \/ conn = c \/ inflight = c
  \/ \E r \in Req : rc[r] = c /\ pc[r] \notin Terminal

-----------------------------------------------------------------------------
(* Callers *)

\* acquireConnection, existing entry: touchConnection + markHealthy + return; SSH2Transport
\* calls client.exec in the continuation (a microtask, so no timer or socket event runs between).
AcqUse(r) ==
  /\ pc[r] = "acquiring"
  /\ conn # None
  /\ LET c == conn IN
     /\ idleLeft' = [idleLeft EXCEPT ![c] = Idle]
     /\ pendOpen' = IF TrackPendingOpen THEN [pendOpen EXCEPT ![c] = @ + 1] ELSE pendOpen
     /\ pc' = [pc EXCEPT ![r] = "opening"]
     /\ rc' = [rc EXCEPT ![r] = c]
  /\ Healthy
  /\ UNCHANGED <<hostUp, cst, closedBy, openCh, conn, inflight>>

\* acquireConnection, no entry, not in backoff, nothing in flight: start the shared connect.
AcqConnect(r) ==
  /\ pc[r] = "acquiring"
  /\ conn = None
  /\ backoffLeft = 0
  /\ inflight = None \/ MutNoSingleflight
  /\ \E c \in Client :
       /\ cst[c] = "closed" /\ ~Referenced(c)
       /\ cst' = [cst EXCEPT ![c] = "connecting"]
       /\ closedBy' = [closedBy EXCEPT ![c] = "none"]
       /\ idleLeft' = [idleLeft EXCEPT ![c] = -1]
       /\ openCh' = [openCh EXCEPT ![c] = 0]
       /\ pendOpen' = [pendOpen EXCEPT ![c] = 0]
       /\ inflight' = c
       /\ pc' = [pc EXCEPT ![r] = "joined"]
       /\ rc' = [rc EXCEPT ![r] = c]
  /\ UNCHANGED <<hostUp, conn, failures, backoffLeft>>

\* acquireConnection, a connect is in flight: wait on it.
AcqJoin(r) ==
  /\ pc[r] = "acquiring"
  /\ conn = None
  /\ backoffLeft = 0
  /\ inflight # None
  /\ ~MutNoSingleflight
  /\ pc' = [pc EXCEPT ![r] = "joined"]
  /\ rc' = [rc EXCEPT ![r] = inflight]
  /\ UNCHANGED <<hostUp, cst, closedBy, idleLeft, openCh, pendOpen, conn, inflight,
                 failures, backoffLeft>>

\* The caller's wait budget or abort ends its wait (the connect keeps going). Not fair.
GiveUp(r) ==
  /\ pc[r] \in AcqStates
  /\ pc' = [pc EXCEPT ![r] = "gaveup"]
  /\ rc' = [rc EXCEPT ![r] = None]
  /\ UNCHANGED <<hostUp, cst, closedBy, idleLeft, openCh, pendOpen, conn, inflight,
                 failures, backoffLeft>>

\* The exec callback: on an open client, trackChannel; otherwise the exec fails ("network",
\* reportFailure in spawnRemoteProcess's catch).
Opened(r) ==
  /\ pc[r] = "opening"
  /\ LET c == rc[r] IN
     /\ pendOpen' = IF TrackPendingOpen THEN [pendOpen EXCEPT ![c] = @ - 1] ELSE pendOpen
     /\ IF cst[c] = "open"
          THEN /\ openCh' = [openCh EXCEPT ![c] = @ + 1]
               /\ pc' = [pc EXCEPT ![r] = "running"]
               /\ UNCHANGED <<failures, backoffLeft, rc>>
          ELSE /\ pc' = [pc EXCEPT ![r] = "network"]
               /\ rc' = [rc EXCEPT ![r] = None]
               /\ Failure
               /\ UNCHANGED openCh
  /\ UNCHANGED <<hostUp, cst, closedBy, idleLeft, conn, inflight>>

\* The channel ends. On an open client the command exits normally (markHealthy). On a client
\* that is closing, ssh2 closes the channel with EOF and no exit status: SSH2ChildProcess
\* reports "network" (reportFailure). The last channel to close restarts the idle window.
ChannelEnd(r) ==
  /\ pc[r] = "running"
  /\ LET c == rc[r] IN
     /\ openCh' = [openCh EXCEPT ![c] = @ - 1]
     /\ idleLeft' = IF openCh[c] = 1 /\ cst[c] \in {"open", "ending"}
                      THEN [idleLeft EXCEPT ![c] = Idle] ELSE idleLeft
     /\ IF cst[c] = "open"
          THEN /\ pc' = [pc EXCEPT ![r] = "ok"] /\ Healthy
          ELSE IF MutEofAsExit0
            \* Exit 0 with truncated output: an empty stat parses as "missing".
            THEN /\ pc' = [pc EXCEPT ![r] = "missing"] /\ Healthy
            ELSE /\ pc' = [pc EXCEPT ![r] = "network"] /\ Failure
     /\ rc' = [rc EXCEPT ![r] = None]
  /\ UNCHANGED <<hostUp, cst, closedBy, pendOpen, conn, inflight>>

-----------------------------------------------------------------------------
(* The pool and the network *)

\* connect() resolves: connections.set(key, entry) (no check for an existing entry), idle
\* timer armed, markHealthy; every waiter gets the entry and calls client.exec at once.
ConnectOk(c) ==
  /\ cst[c] = "connecting"
  /\ hostUp
  /\ LET waiters == {r \in Req : pc[r] = "joined" /\ rc[r] = c} IN
     /\ cst' = [cst EXCEPT ![c] = "open"]
     /\ conn' = c
     /\ idleLeft' = [idleLeft EXCEPT ![c] = Idle]
     /\ pendOpen' = IF TrackPendingOpen
                      THEN [pendOpen EXCEPT ![c] = Cardinality(waiters)] ELSE pendOpen
     /\ pc' = [r \in Req |-> IF r \in waiters THEN "opening" ELSE pc[r]]
  /\ inflight' = IF inflight = c THEN None ELSE inflight
  /\ Healthy
  /\ UNCHANGED <<hostUp, closedBy, openCh, rc>>

\* connect() rejects (host down): reportFailure; waiters loop back into the acquire loop.
ConnectFail(c) ==
  /\ cst[c] = "connecting"
  /\ ~hostUp
  /\ cst' = [cst EXCEPT ![c] = "closed"]
  /\ closedBy' = [closedBy EXCEPT ![c] = "net"]
  /\ inflight' = IF inflight = c THEN None ELSE inflight
  /\ pc' = [r \in Req |-> IF pc[r] = "joined" /\ rc[r] = c THEN "acquiring" ELSE pc[r]]
  /\ rc' = [r \in Req |-> IF pc[r] = "joined" /\ rc[r] = c THEN None ELSE rc[r]]
  /\ Failure
  /\ UNCHANGED <<hostUp, idleLeft, openCh, pendOpen, conn>>

\* closeIdleConnection(key, entry), run by the entry's idle timer.
IdleFire(c) ==
  /\ idleLeft[c] = 0
  /\ IF conn # c
       THEN \* Not the active entry any more: return without closing it.
            /\ idleLeft' = [idleLeft EXCEPT ![c] = -1]
            /\ UNCHANGED <<cst, closedBy, conn>>
       ELSE IF (openCh[c] > 0 /\ ~MutIdleIgnoresChannels) \/ pendOpen[c] > 0
         THEN \* Busy: re-arm (#4876).
              /\ idleLeft' = [idleLeft EXCEPT ![c] = Idle]
              /\ UNCHANGED <<cst, closedBy, conn>>
         ELSE \* connections.delete(key); client.end(): its events arrive later.
              /\ idleLeft' = [idleLeft EXCEPT ![c] = -1]
              /\ conn' = None
              /\ cst' = [cst EXCEPT ![c] = "ending"]
              /\ closedBy' = IF cst[c] = "open" THEN [closedBy EXCEPT ![c] = "pool"] ELSE closedBy
  /\ UNCHANGED <<hostUp, openCh, pendOpen, inflight, failures, backoffLeft, pc, rc>>

\* The client's "end"/"close" (and possibly "error") handlers run: clear the idle timer, delete
\* connections[key] (unconditionally in the current code), and on "error" reportFailure.
LateEvent(c) ==
  /\ cst[c] = "ending"
  /\ cst' = [cst EXCEPT ![c] = "closed"]
  /\ idleLeft' = [idleLeft EXCEPT ![c] = -1]
  /\ conn' = IF IdentityCheckOnClose /\ conn # c THEN conn ELSE None
  /\ \/ Failure                                  \* "error" fired (keepalive, write after end)
     \/ UNCHANGED <<failures, backoffLeft>>      \* only "end"/"close"
  /\ UNCHANGED <<hostUp, closedBy, openCh, pendOpen, inflight, pc, rc>>

\* The host goes down: every live socket dies (its events come later); connects in flight fail.
HostDown ==
  /\ hostUp
  /\ hostUp' = FALSE
  /\ cst' = [c \in Client |-> IF cst[c] = "open" THEN "ending" ELSE cst[c]]
  /\ closedBy' = [c \in Client |-> IF cst[c] = "open" THEN "net" ELSE closedBy[c]]
  /\ UNCHANGED <<idleLeft, openCh, pendOpen, conn, inflight, failures, backoffLeft,
                 pc, rc>>

HostUp ==
  /\ ~hostUp
  /\ hostUp' = TRUE
  /\ UNCHANGED <<cst, closedBy, idleLeft, openCh, pendOpen, conn, inflight, failures,
                 backoffLeft, pc, rc>>

\* A step that runs without awaiting time is pending: time cannot pass first.
Urgent == \E r \in Req : ENABLED (AcqUse(r) \/ AcqConnect(r) \/ AcqJoin(r))

Dec(x) == IF x > 0 THEN x - 1 ELSE x

Tick ==
  /\ ~Urgent
  /\ backoffLeft' = Dec(backoffLeft)
  /\ idleLeft' = [c \in Client |-> Dec(idleLeft[c])]
  /\ <<backoffLeft', idleLeft'>> # <<backoffLeft, idleLeft>>
  /\ UNCHANGED <<hostUp, cst, closedBy, openCh, pendOpen, conn, inflight, failures,
                 pc, rc>>

System ==
  \/ \E r \in Req : AcqUse(r) \/ AcqConnect(r) \/ AcqJoin(r) \/ Opened(r) \/ ChannelEnd(r)
  \/ \E c \in Client : ConnectOk(c) \/ ConnectFail(c) \/ IdleFire(c) \/ LateEvent(c)
  \/ Tick

\* A caller starts an operation (acquire + exec). Not fair: callers come and go. A new call is a
\* macrotask, so pending synchronous loop steps (Urgent) run first.
Begin(r) ==
  /\ ~Urgent
  /\ pc[r] \in Terminal
  /\ pc' = [pc EXCEPT ![r] = "acquiring"]
  /\ rc' = [rc EXCEPT ![r] = None]
  /\ UNCHANGED <<hostUp, cst, closedBy, idleLeft, openCh, pendOpen, conn, inflight,
                 failures, backoffLeft>>

Next ==
  \/ System
  \/ \E r \in Req : Begin(r) \/ GiveUp(r)
  \/ HostDown \/ HostUp

Fairness ==
  /\ \A r \in Req : WF_vars(AcqUse(r)) /\ WF_vars(AcqConnect(r)) /\ WF_vars(AcqJoin(r))
                    /\ WF_vars(Opened(r)) /\ WF_vars(ChannelEnd(r))
  /\ \A c \in Client : WF_vars(ConnectOk(c)) /\ WF_vars(ConnectFail(c))
                       /\ WF_vars(IdleFire(c)) /\ WF_vars(LateEvent(c))
  /\ WF_vars(Tick)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

\* No caller's exec is opening or running on a client the pool itself closed. (A client the
\* network killed is unavoidable and reads as "network"; see ClassificationSafe.)
NoUseAfterClose ==
  \A r \in Req : pc[r] \in {"opening", "running"} => closedBy[rc[r]] # "pool"

\* Every open client is the pool's entry. An open client the pool no longer maps can never be
\* idle-closed (closeIdleConnection returns when connections.get(key) !== entry): a leaked
\* connection, and a second master for the same host key.
NoLeak == \A c \in Client : cst[c] = "open" => conn = c

\* A transport failure is never reported as a result the caller reads as "file missing".
\* (The model's files all exist, so any "missing" is wrong.)
ClassificationSafe == \A r \in Req : pc[r] # "missing"

\* Once the host stays up, no caller waits in acquire forever (the budget is not needed).
Progress ==
  (<>[]hostUp) => \A r \in Req : [](pc[r] \in AcqStates => <>(pc[r] \notin AcqStates))

=============================================================================
