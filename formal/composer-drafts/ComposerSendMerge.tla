------------------------- MODULE ComposerSendMerge -------------------------
(***************************************************************************)
(* PR2's draft merge (#5547 round 3 redesign): two windows share one       *)
(* workspace draft; each may hold unsaved edits, miss pushes (a dropped    *)
(* connection), lose a write's reply, and Stop. ComposerSends.tla models   *)
(* acceptance; here a send is accepted at most once (a row), and the       *)
(* question is what the shared draft shows.                                *)
(*                                                                         *)
(* FixMerge (the design): the backend is the only place that applies send  *)
(* results to the draft. A window's write names the pending sends it has   *)
(* seen since it was last in sync (its basis); the backend merges:         *)
(*   - no write shows a send the backend still holds (pending);            *)
(*   - for a basis send settled since, the stored state wins: a returned   *)
(*     one still in the visible content stays, an accepted one or one      *)
(*     removed since stays out;                                            *)
(*   - an "undone" send (the window could not confirm its draft write and  *)
(*     shows it again) is the window's own once the backend no longer      *)
(*     holds it, and is never re-sent.                                     *)
(* Without FixMerge a write replaces the visible content (no client-side   *)
(* merge either: the pre-redesign client merges are what kept failing).    *)
(* FixFence: Stop asks the receiver about re-sends already on their way    *)
(* before its interrupt; one that has not arrived is refused for good.    *)
(* FixUndone: a lost beginSend reply marks the send undone.                *)
(*                                                                         *)
(* Declined outcomes (recorded in `declined`, exempt from the checks):    *)
(*   - last writer wins between windows: a write drops an item its window  *)
(*     never had, or brings back an item another window discarded, or one *)
(*     another window sent that this window never saw pending (there is no *)
(*     ledger of settled sends);                                           *)
(*   - a send returned (not accepted) after a window removed its text      *)
(*     (another window's copy, or one it undid while the backend still     *)
(*     held it), or a window removes the text of a send it wrote against   *)
(*     (its basis: the backend cannot tell a removal from text the window  *)
(*     hid): the returned text shows again (shown, never sent).            *)
(* Items are text and attachments alike (one set); a send is one item,    *)
(* sent once. Items are unique, so text a window types after it saw a     *)
(* send never matches it; the implementation tells such text from a stale  *)
(* copy by BasisSend.inUnsavedText and takes out only the stale copy.      *)
(* Items are a set here: where a block sits in the text is checked in    *)
(* ComposerSendText.tla.                                                   *)
(***************************************************************************)
EXTENDS FiniteSets, TLC

CONSTANTS Items, Windows, FixMerge, FixFence, FixUndone,
  MutNoStrip,         \* a write may show a pending send
  MutWriterWins,      \* for settled basis sends the write wins (only a missing returned one is added)
  MutNoTheirsCheck    \* a returned basis send is added even if it was removed since

VARIABLES
  typed,    \* ghost: items created
  vis,      \* durable visible content
  pend,     \* durable pending sends (retained, hidden)
  rows,     \* accepted items
  refused,  \* receiver memory: answered "not accepted"
  reqs,     \* requests on their way: <<item, kind, afterStop>>
  sent,     \* items sent (once each)
  dirty, local, view, basis, undone, \* per window
  wreq,     \* writes in flight: <<window, content, basis, undone>>
  dropped,  \* ghost: items the user removed
  declined, \* ghost: items whose loss or return is a declined outcome (see above)
  lost,     \* ghost: <<window, send>> whose draft write's reply was lost (shown again there)
  stopped, lateWork

vars == <<typed, vis, pend, rows, refused, reqs, sent, dirty, local, view, basis, undone, wreq,
          dropped, declined, lost, stopped, lateWork>>
wvars == <<dirty, local, view, basis, undone>>

TypeOK ==
  /\ vis \subseteq Items /\ pend \subseteq Items /\ rows \subseteq Items
  /\ dirty \in [Windows -> BOOLEAN] /\ local \in [Windows -> SUBSET Items]
  /\ view \in [Windows -> SUBSET Items] /\ basis \in [Windows -> SUBSET Items]
  /\ undone \in [Windows -> SUBSET Items]

Init ==
  /\ typed = {} /\ vis = {} /\ pend = {} /\ rows = {} /\ refused = {} /\ reqs = {} /\ sent = {}
  /\ dirty = [w \in Windows |-> FALSE] /\ local = [w \in Windows |-> {}]
  /\ view = [w \in Windows |-> {}] /\ basis = [w \in Windows |-> {}]
  /\ undone = [w \in Windows |-> {}] /\ wreq = {} /\ dropped = {} /\ declined = {} /\ lost = {}
  /\ stopped = FALSE /\ lateWork = FALSE

Shown(w) == IF dirty[w] THEN local[w] ELSE view[w]

-----------------------------------------------------------------------------
(* Windows                                                                 *)

Create(w, i) ==
  /\ i \notin typed
  /\ typed' = typed \cup {i}
  /\ local' = [local EXCEPT ![w] = Shown(w) \cup {i}] /\ dirty' = [dirty EXCEPT ![w] = TRUE]
  /\ UNCHANGED <<vis, pend, rows, refused, reqs, sent, view, basis, undone, wreq, dropped, declined,
                 stopped, lateWork, lost>>

Discard(w, i) ==
  /\ i \in Shown(w)
  /\ local' = [local EXCEPT ![w] = Shown(w) \ {i}] /\ dirty' = [dirty EXCEPT ![w] = TRUE]
  /\ dropped' = dropped \cup {i}
  /\ declined' = IF i \in basis[w] /\ <<w, i>> \notin lost THEN declined \cup {i} ELSE declined
  /\ UNCHANGED <<typed, vis, pend, rows, refused, reqs, sent, view, basis, undone, wreq,
                 stopped, lateWork, lost>>

\* A push or snapshot reaches the window (skipping it models a dropped connection). An
\* unsaved window keeps its edits and only adds the pending sends to its basis.
Observe(w) ==
  /\ view' = [view EXCEPT ![w] = vis]
  /\ basis' = [basis EXCEPT ![w] = IF dirty[w] THEN @ \cup pend ELSE pend]
  /\ undone' = [undone EXCEPT ![w] = IF dirty[w] THEN @ ELSE {}]
  /\ UNCHANGED <<typed, vis, pend, rows, refused, reqs, sent, dirty, local, wreq, dropped, declined,
                 stopped, lateWork, lost>>

SendGuard(w, i) ==
  /\ ~dirty[w] /\ ~\E wr \in wreq : wr[1] = w
  /\ i \in view[w] \cap vis /\ i \notin sent

\* The draft write (beginSend) and the request.
Send(w, i) ==
  /\ SendGuard(w, i)
  /\ vis' = vis \ {i} /\ pend' = pend \cup {i} /\ sent' = sent \cup {i}
  /\ reqs' = reqs \cup {<<i, "send", FALSE>>}
  /\ view' = [view EXCEPT ![w] = vis'] /\ basis' = [basis EXCEPT ![w] = pend']
  /\ UNCHANGED <<typed, rows, refused, dirty, local, undone, wreq, dropped, declined, stopped, lateWork, lost>>

\* The draft write lands but its reply is lost: the composer does not send, and the window shows
\* the item again (FixUndone: marked undone).
SendLostReply(w, i) ==
  /\ SendGuard(w, i)
  /\ vis' = vis \ {i} /\ pend' = pend \cup {i} /\ sent' = sent \cup {i}
  /\ dirty' = [dirty EXCEPT ![w] = TRUE] /\ local' = [local EXCEPT ![w] = view[w]]
  /\ basis' = [basis EXCEPT ![w] = IF FixMerge THEN @ \cup {i} ELSE @]
  /\ undone' = [undone EXCEPT ![w] = IF FixUndone THEN @ \cup {i} ELSE @]
  /\ lost' = lost \cup {<<w, i>>}
  /\ UNCHANGED <<typed, rows, refused, reqs, view, wreq, dropped, declined, stopped, lateWork>>

WriteStart(w) ==
  /\ dirty[w] /\ ~\E wr \in wreq : wr[1] = w
  /\ wreq' = wreq \cup {<<w, local[w], basis[w], undone[w]>>}
  /\ UNCHANGED <<typed, vis, pend, rows, refused, reqs, sent, dirty, local, view, basis, undone,
                 dropped, declined, stopped, lateWork, lost>>

\* The backend's merge of a write (FixMerge), or the plain replace.
Merged(wr) ==
  LET c == wr[2]  B == wr[3]  U == wr[4]
      settled == (B \ U) \ pend
      stays == {i \in settled : i \notin rows /\ (MutNoTheirsCheck \/ i \in vis)}
      own == IF MutNoStrip THEN c ELSE c \ pend
  IN IF ~FixMerge THEN c
     ELSE IF MutWriterWins THEN own \cup {i \in stays : i \notin c}
     ELSE (own \ settled) \cup stays

\* A write lands; its reply brings the merge to the window unless the window edited meanwhile.
\* `ack` FALSE: the reply is lost and the window writes the same edit again later.
WriteApply(wr, ack) ==
  /\ wr \in wreq
  /\ wreq' = wreq \ {wr} /\ vis' = Merged(wr)
  /\ declined' = declined
       \cup {i \in vis \ vis' : i \notin pend \cup wr[2] \cup wr[3] \cup dropped}
       \cup {i \in (vis' \ vis) \cap wr[2] : i \in dropped \/ (i \in rows /\ i \notin wr[3])}
  /\ LET w == wr[1]  synced == ack /\ local[w] = wr[2] IN
     /\ dirty' = [dirty EXCEPT ![w] = IF synced THEN FALSE ELSE @]
     /\ view' = [view EXCEPT ![w] = IF synced THEN vis' ELSE @]
     /\ basis' = [basis EXCEPT ![w] = IF synced THEN pend ELSE @]
     \* In sync the window shows the merge, which hides a send still pending: no longer its own.
     /\ undone' = [undone EXCEPT ![w] = IF synced THEN {} ELSE @]
  /\ UNCHANGED <<typed, pend, rows, refused, reqs, sent, local, dropped, stopped, lateWork, lost>>

\* An automatic re-send of a pending send (same id). Never one a window undid (FixUndone).
Retry(i) ==
  /\ i \in pend /\ ~stopped /\ i \notin refused
  /\ ~(FixUndone /\ \E w \in Windows : i \in undone[w])
  /\ ~\E r \in reqs : r[1] = i
  /\ reqs' = reqs \cup {<<i, "retry", FALSE>>}
  /\ UNCHANGED <<typed, vis, pend, rows, refused, sent, dirty, local, view, basis, undone, wreq,
                 dropped, declined, stopped, lateWork, lost>>

\* Stop: no further re-sends; FixFence refuses the ones already on their way at the receiver
\* before the interrupt (a request that registers later is late work).
Stop ==
  /\ ~stopped /\ stopped' = TRUE
  /\ reqs' = {<<r[1], r[2], r[3] \/ r[2] = "retry">> : r \in reqs}
  /\ refused' = IF FixFence THEN refused \cup {r[1] : r \in {x \in reqs : x[2] = "retry"}}
                ELSE refused
  /\ UNCHANGED <<typed, vis, pend, rows, sent, dirty, local, view, basis, undone, wreq, dropped, declined,
                 lateWork, lost>>

-----------------------------------------------------------------------------
(* Receiver and resolution                                                 *)

\* A request arrives: refused ids are dropped; otherwise the row is written (acceptance).
Register(r) ==
  /\ r \in reqs /\ reqs' = reqs \ {r}
  /\ IF r[1] \in refused
       THEN UNCHANGED <<rows, lateWork>>
       ELSE /\ rows' = rows \cup {r[1]}
            /\ lateWork' = (lateWork \/ r[3])
  /\ UNCHANGED <<typed, vis, pend, refused, sent, dirty, local, view, basis, undone, wreq,
                 dropped, declined, stopped, lost>>

\* Lookup and resolution under the draft lock (any window): accepted drops it; otherwise the
\* receiver remembers the refusal and the item is visible again.
Resolve(i) ==
  /\ i \in pend /\ pend' = pend \ {i}
  /\ IF i \in rows
       THEN UNCHANGED <<vis, refused>>
       ELSE /\ refused' = refused \cup {i} /\ vis' = vis \cup {i}
  /\ declined' = IF i \notin rows /\ i \in dropped THEN declined \cup {i} ELSE declined
  /\ UNCHANGED <<typed, rows, reqs, sent, dirty, local, view, basis, undone, wreq, dropped,
                 stopped, lateWork, lost>>

Next ==
  \/ \E w \in Windows, i \in Items : Create(w, i) \/ Discard(w, i) \/ Send(w, i) \/ SendLostReply(w, i)
  \/ \E w \in Windows : Observe(w) \/ WriteStart(w)
  \/ \E wr \in wreq, ack \in BOOLEAN : WriteApply(wr, ack)
  \/ \E i \in Items : Retry(i) \/ Resolve(i)
  \/ \E r \in reqs : Register(r)
  \/ Stop

Spec == Init /\ [][Next]_vars

\* Items and windows are interchangeable (every invariant is symmetric).
Symm == Permutations(Items) \cup Permutations(Windows)

-----------------------------------------------------------------------------
Unsaved == UNION {local[w] : w \in {x \in Windows : dirty[x]}} \cup UNION {wr[2] : wr \in wreq}

\* Content the user created is never silently lost.
NoSilentLoss ==
  \A i \in typed : i \in vis \cup pend \cup rows \cup dropped \cup declined \cup Unsaved

\* A pending (retained) send is never visible too: it would show twice once returned.
NoDoubleShow == pend \cap vis = {}

Settled ==
  /\ reqs = {} /\ wreq = {} /\ pend = {} /\ \A w \in Windows : ~dirty[w]

\* Once settled, accepted content is not in the draft again.
NoResurrection == Settled => rows \cap vis \subseteq declined

\* Once settled, content a user removed does not come back (no window still held it).
NoDiscardedBack == Settled => dropped \cap vis \subseteq rows \cup Unsaved \cup declined

\* No re-send starts work after Stop.
NoLateWork == ~lateWork
=============================================================================
