---------------------------- MODULE ArchiveCascade ----------------------------
(***************************************************************************)
(* #4928: a parent archive's sub-agent cascade vs sub-agent creation under *)
(* that parent or under one of the sub-agents it archives, at commit       *)
(* ea52e87b33:                                                             *)
(*   src/node/services/workspaceService.ts  archiveWithDescendants         *)
(*       (:11233-11309): list unarchived descendants once (:11238), gate   *)
(*       them (:11261), archive each deepest-first, then the parent        *)
(*       (:11296); every archiveUnlocked re-checks its own active          *)
(*       descendants (:11442) long before its archivedAt commit (:11715)   *)
(*   src/node/services/taskService.ts       task creation: archived check *)
(*       on a config snapshot (:7720-7727), commit under                   *)
(*       assertParentAdmitsChild (:749-773), which checks only             *)
(*       pendingRemoval; serialized with archive only by the in-process   *)
(*       withTaskTreeLifecycleLock (:7640)                                 *)
(* Archiver backend A, creator backend C: SameBackend means C is A (one   *)
(* process, the tree lock serializes them). C creates one sub-agent, under *)
(* the parent (root) or under the existing sub-agent Desc (a reported      *)
(* sub-agent spawns during a turn C admits in it after A's listing).       *)
(* A new sub-agent is queued, so it counts as an active descendant.        *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Kids,          \* sub-agents of the root that may exist, e.g. {"k1", "k2"}
  Existing,      \* those that exist when the archive starts
  Desc,          \* an existing sub-agent of the root the cascade archives
  GKids,         \* sub-agents of Desc that may be created, e.g. {"g1"}
  SameBackend,
  PendingMarker, \* fix: a pendingArchive marker set before the listing refuses creations
                 \* (implemented: WorkspaceService.claimPendingArchive, cleared by the
                 \* archivedAt commit or releasePendingArchive; checked in
                 \* taskService assertParentAdmitsChild)
  MarkerAncestors \* fix: the creation commit checks the marker of every ancestor of its
                  \* parent too, not just the parent's own (FALSE: parent only)

ASSUME Desc \in Existing /\ Existing \subseteq Kids /\ GKids \cap Kids = {}

VARIABLES
  kids, gkids, archived, parentArchived, marker,
  apc, listed, todo, cur,
  cpc, ctarget, created,
  treeLock   \* "none" | "archive" | "create" (in-process MutexMap, one backend only)

vars == <<kids, gkids, archived, parentArchived, marker, apc, listed, todo, cur, cpc, ctarget,
          created, treeLock>>

Live(s) == s \ archived

Init ==
  /\ kids = Existing /\ gkids = {} /\ archived = {} /\ parentArchived = FALSE /\ marker = FALSE
  /\ apc = "lock" /\ listed = {} /\ todo = {} /\ cur = "none"
  /\ cpc = "lock" /\ ctarget = "none" /\ created = 0 /\ treeLock = "none"

ReleaseIfSame == treeLock' = IF SameBackend THEN "none" ELSE treeLock

\* --- Archiver A ---
ALock == /\ apc = "lock"
         /\ IF SameBackend THEN treeLock = "none" /\ treeLock' = "archive" ELSE UNCHANGED treeLock
         /\ apc' = IF PendingMarker THEN "mark" ELSE "list"
         /\ UNCHANGED <<kids, gkids, archived, parentArchived, marker, listed, todo, cur, cpc,
                        ctarget, created>>
AMark == /\ apc = "mark" /\ marker' = TRUE /\ apc' = "list"        \* fix only
         /\ UNCHANGED <<kids, gkids, archived, parentArchived, listed, todo, cur, cpc, ctarget,
                        created, treeLock>>
AList == /\ apc = "list"                                            \* :11238
         /\ listed' = Live(kids \cup gkids) /\ todo' = listed' /\ apc' = "kid"
         /\ UNCHANGED <<kids, gkids, archived, parentArchived, marker, cur, cpc, ctarget, created,
                        treeLock>>
\* Deepest-first: a listed sub-agent of Desc before Desc. The sub-agent's own archiveUnlocked
\* refuses while it has active descendants (:11442); its archivedAt commit is a later step.
AKid ==  /\ apc = "kid"                                             \* :11272-11294
         /\ IF todo = {}
              THEN apc' = "recheck" /\ UNCHANGED <<cur, marker, treeLock>>
              ELSE \E k \in (IF todo \cap gkids # {} THEN todo \cap gkids ELSE todo) :
                     IF k = Desc /\ Live(gkids) # {}
                       THEN apc' = "done" /\ marker' = FALSE /\ ReleaseIfSame   \* refused
                            /\ UNCHANGED cur
                       ELSE apc' = "kidcommit" /\ cur' = k /\ UNCHANGED <<marker, treeLock>>
         /\ UNCHANGED <<kids, gkids, archived, parentArchived, listed, todo, cpc, ctarget, created>>
AKidCommit == /\ apc = "kidcommit"
              /\ archived' = archived \cup {cur} /\ todo' = todo \ {cur} /\ apc' = "kid"
              /\ UNCHANGED <<kids, gkids, parentArchived, marker, listed, cur, cpc, ctarget,
                             created, treeLock>>
\* The parent's archiveUnlocked refuses while it has active descendants
\* (hasActiveDescendantAgentTasksForWorkspace, :11442-11446); many awaits
\* (hooks, snapshot, metadata reads) follow before its archivedAt commit.
ARecheck == /\ apc = "recheck"
            /\ IF Live(kids \cup gkids) # {}
                 THEN apc' = "done" /\ marker' = FALSE /\ ReleaseIfSame  \* ACTIVE_DESCENDANT_ARCHIVE_ERROR
                 ELSE apc' = "parent" /\ UNCHANGED <<marker, treeLock>>
            /\ UNCHANGED <<kids, gkids, archived, parentArchived, listed, todo, cur, cpc, ctarget,
                           created>>
AParent == /\ apc = "parent"                                 \* :11715-11723 archivedAt commit
           /\ parentArchived' = TRUE /\ marker' = FALSE /\ apc' = "done"
           /\ ReleaseIfSame
           /\ UNCHANGED <<kids, gkids, archived, listed, todo, cur, cpc, ctarget, created>>

\* --- Creator C (one sub-agent creation, under the root or under Desc) ---
TargetArchived(t) == IF t = "root" THEN parentArchived ELSE t \in archived
\* The marker sits on the root: the target's own marker only when it is the root.
MarkerSeen(t) == marker /\ (t = "root" \/ MarkerAncestors)

CLock == /\ cpc = "lock" /\ created < 1
         /\ IF SameBackend THEN treeLock = "none" /\ treeLock' = "create" ELSE UNCHANGED treeLock
         /\ cpc' = "check"
         /\ UNCHANGED <<kids, gkids, archived, parentArchived, marker, apc, listed, todo, cur,
                        ctarget, created>>
CCheck == /\ cpc = "check"                                          \* :7720-7727 snapshot
          /\ \E t \in {"root", Desc} :
               /\ ctarget' = t
               /\ cpc' = IF TargetArchived(t) THEN "end" ELSE "commit"
          /\ UNCHANGED <<kids, gkids, archived, parentArchived, marker, apc, listed, todo, cur,
                         created, treeLock>>
CCommit == /\ cpc = "commit"                                        \* editConfig + :749-773
           /\ IF PendingMarker /\ (MarkerSeen(ctarget) \/ TargetArchived(ctarget))
                THEN UNCHANGED <<kids, gkids>>                 \* fix: refuse under the edit
                ELSE IF ctarget = "root"
                       THEN \E k \in Kids \ kids : kids' = kids \cup {k} /\ UNCHANGED gkids
                       ELSE \E g \in GKids \ gkids : gkids' = gkids \cup {g} /\ UNCHANGED kids
           /\ created' = created + 1 /\ cpc' = "end"
           /\ UNCHANGED <<archived, parentArchived, marker, apc, listed, todo, cur, ctarget,
                          treeLock>>
CEnd == /\ cpc = "end"
        /\ treeLock' = IF SameBackend /\ treeLock = "create" THEN "none" ELSE treeLock
        /\ cpc' = "done"
        /\ UNCHANGED <<kids, gkids, archived, parentArchived, marker, apc, listed, todo, cur,
                       ctarget, created>>

Next == ALock \/ AMark \/ AList \/ AKid \/ AKidCommit \/ ARecheck \/ AParent
        \/ CLock \/ CCheck \/ CCommit \/ CEnd
Spec == Init /\ [][Next]_vars

\* After the cascade committed the parent, every sub-agent in its tree is archived.
NoLiveChildUnderArchivedParent == parentArchived => (kids \cup gkids) \subseteq archived
\* A sub-agent the cascade archived has no live sub-agent, whether or not the parent commits.
NoLiveChildUnderArchivedDescendant == Desc \in archived => gkids \subseteq archived

TypeOK == kids \subseteq Kids /\ gkids \subseteq GKids /\ archived \subseteq kids \cup gkids
=============================================================================
