/-!
# Evidence seen by the holder-liveness judge

Model of the inputs of `judgeHolder` (src/node/utils/concurrency/processLiveness.ts).

* The holder record, as parsed by the callers: `record = none` is a legacy record (no identity:
  pre-#4415 builds, a crossProcessLock record whose `v` is not 2, a fileLock token without the
  identity segment); `legacyBirth` is the birth such legacy fileLock tokens carried.
  Every identity field is optional: `parseProcessIdentity` maps an absent or malformed field to
  `null`, so "corrupted" means "none" here.
* The observer: its own identity (`getSelfIdentity()`), its pid, the result of `kill(pid, 0)`,
  the holder pid's current Linux start time (`linuxBirth(pid)`, `none` when /proc cannot be
  read or the platform is not Linux), and whether the record's token is one this process may
  still write (`ownTokenLive`).

Strings are abstracted to natural numbers (only equality matters), births to `Birth`.
-/

namespace ProcessLiveness

/-- `process.platform`. -/
inductive Plat where
  | linux
  | darwin
  | win32
  | other (n : Nat)
  deriving DecidableEq, Repr

/-- A recorded birth: Linux `/proc/<pid>/stat` starttime (`linux-ticks:N`) or anything else
(`ps-lstart:...` from macOS, or a corrupted value). -/
inductive Birth where
  | ticks (n : Nat)
  | other (n : Nat)
  deriving DecidableEq, Repr

/-- `current === recorded`, where `current` is always a `linux-ticks:` value. -/
def birthEq (current : Nat) : Birth → Bool
  | .ticks n => current == n
  | .other _ => false

/-- Outcome of `process.kill(pid, 0)`. Only `esrch` proves absence. -/
inductive Kill where
  | alive
  | eperm
  | esrch
  | other
  deriving DecidableEq, Repr

/-- `ProcessIdentity`. `hostname` is carried to show that it never matters. -/
structure Identity where
  birth : Option Birth := none
  bootId : Option Nat := none
  pidNs : Option Nat := none
  machineId : Option Nat := none
  platform : Option Plat := none
  hostname : Option Nat := none
  deriving DecidableEq, Repr

structure Evidence where
  pid : Nat
  record : Option Identity
  legacyBirth : Option Birth := none
  self : Identity
  selfPid : Nat
  kill : Kill
  current : Option Nat
  ownTokenLive : Bool
  deriving DecidableEq, Repr

inductive Verdict where
  | dead
  | refuse
  deriving DecidableEq, Repr

/-! ## Information order: `e' ≼ e` when `e'` knows less (fields removed or corrupted to none) -/

def OptLe {α : Type} (a b : Option α) : Prop := a = none ∨ a = b

def IdLe (r' r : Identity) : Prop :=
  OptLe r'.birth r.birth ∧ OptLe r'.bootId r.bootId ∧ OptLe r'.pidNs r.pidNs ∧
  OptLe r'.machineId r.machineId ∧ OptLe r'.platform r.platform ∧ OptLe r'.hostname r.hostname

/-- Dropping the whole identity (a legacy record) is the least informative record. -/
def RecLe : Option Identity → Option Identity → Prop
  | none, _ => True
  | some r', some r => IdLe r' r
  | some _, none => False

/-- A probe error (`other`) knows less than any definite kill result. -/
def KillLe (k' k : Kill) : Prop := k' = .other ∨ k' = k

def EvLe (e' e : Evidence) : Prop :=
  e'.pid = e.pid ∧ e'.selfPid = e.selfPid ∧ e'.ownTokenLive = e.ownTokenLive ∧
  RecLe e'.record e.record ∧ OptLe e'.legacyBirth e.legacyBirth ∧ IdLe e'.self e.self ∧
  KillLe e'.kill e.kill ∧ OptLe e'.current e.current

/-! ## The topology assumption, stated as a hypothesis

**Deployment contract (#4415):** every cooperating Xum process sharing one XUM_ROOT runs in one
PID domain. `Topology e` spells out what that means for a holder that is ALIVE when observed:
it exists in our PID namespace, a pid equal to ours is this process (whose registry knows its
live tokens), its recorded platform, boot id and PID namespace (when recorded and readable by
us) are ours, and its recorded birth is its true start time, which is what we read now.

Machine id is deliberately NOT part of it: /etc/machine-id belongs to the file system (mount
namespace), not to the PID domain, and it can be rewritten while a process runs. -/
structure Topology (e : Evidence) : Prop where
  notGone : e.kill ≠ .esrch
  selfIsHolder : e.pid = e.selfPid → e.ownTokenLive = true
  platform : ∀ r p, e.record = some r → r.platform = some p → e.self.platform = some p
  bootId : ∀ r b b', e.record = some r → r.bootId = some b → e.self.bootId = some b' → b = b'
  pidNs : ∀ r n n', e.record = some r → r.pidNs = some n → e.self.pidNs = some n' → n = n'
  birth : ∀ r b n, e.record = some r → r.birth = some b → e.current = some n → birthEq n b = true
  legacyBirth : ∀ b n, e.record = none → e.legacyBirth = some b → e.current = some n →
    birthEq n b = true

/-- Machine-id stability: a live holder recorded the machine id we read now. The judges do not
need it (`ts_sound`, `spec_never_reclaims_live`); `finding_A` shows a holder violating it. -/
def MachineStable (e : Evidence) : Prop :=
  ∀ r m m', e.record = some r → r.machineId = some m → e.self.machineId = some m' → m = m'

end ProcessLiveness
