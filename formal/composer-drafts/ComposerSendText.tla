------------------------- MODULE ComposerSendText -------------------------
(***************************************************************************)
(* Where a send's text sits in the draft text (#5547). ComposerSendMerge   *)
(* treats the draft as a set, so position cannot matter there. Here one    *)
(* window and the backend keep the draft as a sequence of blocks: the      *)
(* backend puts a returned send back in front of the visible text, so      *)
(* after several returns a send's block can sit in the middle. A window    *)
(* with unsaved edits hid the pending sends it saw (its basis); its write  *)
(* keeps a returned basis send only if the backend finds the block in the  *)
(* stored text (Found).                                                    *)
(*                                                                         *)
(* MatchMiddle: Found looks at every block (removeDraftBlock). Without it, *)
(* Found sees only the first and last block (removeSentText): the round-5  *)
(* head, which lost a returned send in the middle.                         *)
(*                                                                         *)
(* Items stand for whole blocks with unrelated texts, so Found is block    *)
(* equality. removeDraftBlock matches exactly that since #5567; before, it *)
(* also matched a send's text at the end or start of a longer line ("I     *)
(* said yes" for "yes"), which this abstraction cannot express.            *)
(***************************************************************************)
EXTENDS Sequences, FiniteSets, Naturals

CONSTANTS Items, MatchMiddle

VARIABLES
  typed,    \* ghost: items created
  vis,      \* stored visible text: a sequence of distinct blocks
  pend,     \* pending sends (retained, hidden)
  rows,     \* accepted sends
  dirty, local, basis, \* the window: unsaved edits, and the sends it saw
  dropped   \* ghost: items the user removed

vars == <<typed, vis, pend, rows, dirty, local, basis, dropped>>

Range(s) == {s[k] : k \in 1..Len(s)}
Without(s, i) == SelectSeq(s, LAMBDA x : x # i)
\* A sequence of the items of a finite set (any order).
SeqOf(S) == CHOOSE s \in [1..Cardinality(S) -> S] : Range(s) = S

Found(s, i) ==
  IF MatchMiddle THEN i \in Range(s)
  ELSE Len(s) > 0 /\ (s[1] = i \/ s[Len(s)] = i)

Shown == IF dirty THEN local ELSE vis

TypeOK ==
  /\ vis \in Seq(Items) /\ local \in Seq(Items)
  /\ pend \subseteq Items /\ rows \subseteq Items /\ basis \subseteq Items

Init ==
  /\ typed = {} /\ vis = <<>> /\ pend = {} /\ rows = {}
  /\ dirty = FALSE /\ local = <<>> /\ basis = {} /\ dropped = {}

Create(i) ==
  /\ i \notin typed /\ typed' = typed \cup {i}
  /\ local' = Append(Shown, i) /\ dirty' = TRUE
  /\ UNCHANGED <<vis, pend, rows, basis, dropped>>

Discard(i) ==
  /\ i \in Range(Shown)
  /\ local' = Without(Shown, i) /\ dirty' = TRUE /\ dropped' = dropped \cup {i}
  /\ UNCHANGED <<typed, vis, pend, rows, basis>>

\* A send from the window in sync: its block leaves the visible text.
Send(i) ==
  /\ ~dirty /\ i \in Range(vis)
  /\ vis' = Without(vis, i) /\ pend' = pend \cup {i} /\ basis' = pend'
  /\ UNCHANGED <<typed, rows, dirty, local, dropped>>

\* The backend settles a send: accepted, or returned in front of the visible text. A window in
\* sync sees it; one with unsaved edits keeps them (and its basis).
Resolve(i, accepted) ==
  /\ i \in pend /\ pend' = pend \ {i}
  /\ IF accepted
       THEN rows' = rows \cup {i} /\ UNCHANGED vis
       ELSE vis' = <<i>> \o vis /\ UNCHANGED rows
  /\ basis' = IF dirty THEN basis ELSE pend'
  /\ UNCHANGED <<typed, dirty, local, dropped>>

\* The window's write: its text, plus every returned basis send it hid that the stored text
\* still holds.
Merged(c) ==
  LET restored == {i \in basis \ pend : i \notin rows /\ Found(vis, i) /\ i \notin Range(c)}
  IN SeqOf(restored) \o c

Write ==
  /\ dirty /\ vis' = Merged(local) /\ dirty' = FALSE /\ basis' = pend
  /\ UNCHANGED <<typed, pend, rows, local, dropped>>

Next ==
  \/ \E i \in Items : Create(i) \/ Discard(i) \/ Send(i)
  \/ \E i \in Items, a \in BOOLEAN : Resolve(i, a)
  \/ Write

Spec == Init /\ [][Next]_vars

\* Content the user created is never silently lost.
NoSilentLoss ==
  \A i \in typed :
    i \in Range(vis) \cup pend \cup rows \cup dropped \cup (IF dirty THEN Range(local) ELSE {})

\* Accepted content is not in the draft again.
NoResurrection == rows \cap Range(vis) = {}
=============================================================================
