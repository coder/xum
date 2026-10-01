import ProcessLiveness.Evidence
import ProcessLiveness.Spec
import ProcessLiveness.Theorems
import ProcessLiveness.TsJudge

/-!
# Process-liveness reclaim judge: formal model

Model of `judgeHolder` (src/node/utils/concurrency/processLiveness.ts), which every
cross-process lock kit uses to decide whether a holder may be reclaimed (crossProcessLock,
fileLock, and WorkspaceService's pending-removal marker). Run `./check.sh` here: it builds with
`lake build` (Lean 4.34.1, core only), rejects proof escape hatches, audits the axioms of
every listed theorem and re-checks the environment with leanchecker.

* `Spec.lean`: `specJudge`, the contract as a total function, and `specJudge_dead_iff`
  (dead ⇔ `DeathEvidence`, a disjunction of positive facts).
* `Theorems.lean`: (S) `spec_dead_sound`, `spec_never_reclaims_live` (under `Topology`);
  (M) `spec_monotone`, `spec_refuse_antitone` (under `EvLe`); (R) `reboot_dead`,
  `same_machine_reboot_dead`, `namespace_dead`, `unknown_domain_refuses`,
  `legacy_refuses_on_linux`, `nonlinux_reuse_reads_live`, `hostname_irrelevant`.
* `TsJudge.lean`: `tsJudge` (the TS branches), `ts_sound` (under `Topology` alone),
  `finding_A` (fixed: refused although `MachineStable` fails), `finding_B1..3` and
  `ts_not_monotone` (deferred, #4480).

Assumptions and gaps (the TS side, src/node/utils/concurrency/processLiveness.formal.test.ts,
checks `tsJudge` against the real function on an exhaustive case set):

* `Topology` is the deployment contract, a hypothesis of the soundness theorems: a live holder
  runs in the observer's PID domain, records its true identity, and our own pid is us.
* Probe results are inputs: `kill(pid, 0)`, `/proc/<pid>/stat` starttime, the observer's
  identity. Their implementations (`probeProcessBirth`, `getSelfIdentity`) are not modeled, nor
  is the timing between the probes (a pid can die or be reused between kill and the /proc read).
* Record parsing is abstracted to "absent or malformed field = none" (`parseProcessIdentity`).
  A corrupted value that still parses (another pid, another start time) is indistinguishable from
  real death evidence and is out of scope; so is a forged record.
* Lock protocols around the judge (tokens, guards, leases for unparseable content, renewal) are
  out of scope: see formal/filelock for the fileLock protocol.
-/
