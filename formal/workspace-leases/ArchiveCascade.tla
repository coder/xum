---------------------------- MODULE ArchiveCascade ----------------------------
(***************************************************************************)
(* #4928: a parent archive's sub-agent cascade vs sub-agent creation under *)
(* that parent, at commit ea52e87b33:                                      *)
(*   src/node/services/workspaceService.ts  archiveWithDescendants         *)
(*       (:11233-11309): list unarchived descendants once (:11238), gate   *)
(*       them (:11261), archive each, then the parent (:11296), whose      *)
(*       archiveUnlocked re-checks active descendants (:11442) long before *)
(*       its archivedAt commit (:11715)                                    *)
(*   src/node/services/taskService.ts       task creation: archived check *)
(*       on a config snapshot (:7720-7727), commit under                   *)
(*       assertParentAdmitsChild (:749-773), which checks only             *)
(*       pendingRemoval; serialized with archive only by the in-process   *)
(*       withTaskTreeLifecycleLock (:7640)                                 *)
(* Archiver backend A, creator backend C: SameBackend means C is A (one   *)
(* process, the tree lock serializes them).                                *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Kids,          \* sub-agents that may exist, e.g. {"k1", "k2"}
  Existing,      \* those that exist when the archive starts
  SameBackend,
  PendingMarker  \* fix: a pendingArchive marker set before the listing refuses creations

VARIABLES
  kids, archived, parentArchived, marker,
  apc, listed, todo,
  cpc, cseen, created,
  treeLock   \* "none" | "archive" | "create" (in-process MutexMap, one backend only)

vars == <<kids, archived, parentArchived, marker, apc, listed, todo, cpc, cseen, created,
          treeLock>>

Init ==
  /\ kids = Existing /\ archived = {} /\ parentArchived = FALSE /\ marker = FALSE
  /\ apc = "lock" /\ listed = {} /\ todo = {}
  /\ cpc = "lock" /\ cseen = FALSE /\ created = 0 /\ treeLock = "none"

\* --- Archiver A ---
ALock == /\ apc = "lock"
         /\ IF SameBackend THEN treeLock = "none" /\ treeLock' = "archive" ELSE UNCHANGED treeLock
         /\ apc' = IF PendingMarker THEN "mark" ELSE "list"
         /\ UNCHANGED <<kids, archived, parentArchived, marker, listed, todo, cpc, cseen, created>>
AMark == /\ apc = "mark" /\ marker' = TRUE /\ apc' = "list"        \* fix only
         /\ UNCHANGED <<kids, archived, parentArchived, listed, todo, cpc, cseen, created, treeLock>>
AList == /\ apc = "list"                                            \* :11238
         /\ listed' = kids \ archived /\ todo' = kids \ archived /\ apc' = "kid"
         /\ UNCHANGED <<kids, archived, parentArchived, marker, cpc, cseen, created, treeLock>>
AKid ==  /\ apc = "kid"                                             \* :11272-11294
         /\ IF todo = {}
              THEN apc' = "recheck" /\ UNCHANGED <<archived, todo>>
              ELSE \E k \in todo : archived' = archived \cup {k} /\ todo' = todo \ {k}
                                    /\ UNCHANGED apc
         /\ UNCHANGED <<kids, parentArchived, marker, listed, cpc, cseen, created, treeLock>>
\* The parent's archiveUnlocked refuses while it has active descendants
\* (hasActiveDescendantAgentTasksForWorkspace, :11442-11446); many awaits
\* (hooks, snapshot, metadata reads) follow before its archivedAt commit.
ARecheck == /\ apc = "recheck"
            /\ IF kids \ archived # {}
                 THEN apc' = "done" /\ marker' = FALSE              \* ACTIVE_DESCENDANT_ARCHIVE_ERROR
                      /\ treeLock' = IF SameBackend THEN "none" ELSE treeLock
                 ELSE apc' = "parent" /\ UNCHANGED <<marker, treeLock>>
            /\ UNCHANGED <<kids, archived, parentArchived, listed, todo, cpc, cseen, created>>
AParent == /\ apc = "parent"                                 \* :11715-11723 archivedAt commit
           /\ parentArchived' = TRUE /\ marker' = FALSE /\ apc' = "done"
           /\ treeLock' = IF SameBackend THEN "none" ELSE treeLock
           /\ UNCHANGED <<kids, archived, listed, todo, cpc, cseen, created>>

\* --- Creator C (one sub-agent creation) ---
CLock == /\ cpc = "lock" /\ created < 1
         /\ IF SameBackend THEN treeLock = "none" /\ treeLock' = "create" ELSE UNCHANGED treeLock
         /\ cpc' = "check"
         /\ UNCHANGED <<kids, archived, parentArchived, marker, apc, listed, todo, cseen, created>>
CCheck == /\ cpc = "check"                                          \* :7720-7727 snapshot
          /\ cseen' = parentArchived /\ cpc' = IF parentArchived THEN "end" ELSE "commit"
          /\ UNCHANGED <<kids, archived, parentArchived, marker, apc, listed, todo, created, treeLock>>
CCommit == /\ cpc = "commit"                                        \* editConfig + :749-773
           /\ IF PendingMarker /\ (marker \/ parentArchived)   \* fix: refuse under the edit
                THEN UNCHANGED kids
                ELSE \E k \in Kids \ kids : kids' = kids \cup {k}
           /\ created' = created + 1 /\ cpc' = "end"
           /\ UNCHANGED <<archived, parentArchived, marker, apc, listed, todo, cseen, treeLock>>
CEnd == /\ cpc = "end"
        /\ treeLock' = IF SameBackend /\ treeLock = "create" THEN "none" ELSE treeLock
        /\ cpc' = "done"
        /\ UNCHANGED <<kids, archived, parentArchived, marker, apc, listed, todo, cseen, created>>

Next == ALock \/ AMark \/ AList \/ AKid \/ ARecheck \/ AParent \/ CLock \/ CCheck \/ CCommit \/ CEnd
Spec == Init /\ [][Next]_vars

\* After the cascade committed the parent, every sub-agent under it is archived.
NoLiveChildUnderArchivedParent == parentArchived => kids \subseteq archived

TypeOK == kids \subseteq Kids /\ archived \subseteq kids
=============================================================================
