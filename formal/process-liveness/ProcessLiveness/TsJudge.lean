import ProcessLiveness.Theorems

/-!
# The TypeScript judge, branch for branch

`tsJudge` transcribes `judgeHolder` (src/node/utils/concurrency/processLiveness.ts) on the same
evidence. `linuxDomain` is the TS test `self.bootId !== null && self.pidNs !== null`; the
legacy branch reads `linuxBirth(pid)` only for a recorded `linux-ticks:` birth.

Results:
* `ts_sound`: under the topology assumption alone, TS never reclaims a live holder.
* `finding_A` (fixed): same boot id and PID namespace, a running pid with the recorded start
  time, but a different machine id. The former judge read the machine-id mismatch as a retired
  domain and said dead; the judge now ignores the machine id (diagnostic only) and refuses, as
  the spec does, although the evidence violates machine-id stability (`MachineStable`).
* `finding_B_*` (deferred, #4480): TS is not monotonic: removing evidence can turn its refusal
  into dead (legacy records, an observer that cannot read its own namespace, record domain
  fields on macOS). Each is sound under the topology assumption (`ts_sound`), so none reclaims
  a live holder.
-/

namespace ProcessLiveness

def tsRest (e : Evidence) (r : Identity) (linuxDomain : Bool) : Verdict :=
  if e.pid = e.selfPid then (if e.ownTokenLive then .refuse else .dead)
  else if e.kill = .esrch then .dead
  else if !linuxDomain then .refuse
  else match r.birth with
    | none => .refuse
    | some b =>
      match e.current with
      | none => .refuse
      | some n => if birthEq n b then .refuse else .dead

def tsJudge (e : Evidence) : Verdict :=
  match e.record with
  | none =>
    if e.kill = .esrch then .dead
    else match e.legacyBirth, e.current with
      | some (.ticks m), some n => if n = m then .refuse else .dead
      | _, _ => .refuse
  | some r =>
    if differs r.platform e.self.platform then .dead
    else if e.self.bootId.isSome && e.self.pidNs.isSome then
      if r.bootId.isNone || r.pidNs.isNone then .refuse
      else if r.bootId ≠ e.self.bootId ∨ r.pidNs ≠ e.self.pidNs then .dead
      else tsRest e r true
    else if r.bootId.isSome || r.pidNs.isSome then .refuse
    else tsRest e r false

theorem tsRest_refuse (e : Evidence) (r : Identity) (ld : Bool) (ht : Topology e)
    (hr : e.record = some r) : tsRest e r ld = .refuse := by
  unfold tsRest
  split
  · rename_i hpid; simp [ht.selfIsHolder hpid]
  · split
    · rename_i hk; exact absurd hk ht.notGone
    · split
      · rfl
      · split
        · rfl
        · rename_i b hb
          split
          · rfl
          · rename_i n hn
            simp [ht.birth r b n hr hb hn]

/-- **TS soundness** under the topology assumption alone (no machine-id stability). -/
theorem ts_sound (e : Evidence) (ht : Topology e) : tsJudge e = .refuse := by
  unfold tsJudge
  split
  · rename_i hr
    simp only [ht.notGone, ↓reduceIte]
    split
    · rename_i m n hb hn
      have := ht.legacyBirth (.ticks m) n hr hb hn
      simp [birthEq] at this
      simp [this]
    · rfl
  · rename_i r hr
    split
    · rename_i hd
      exfalso
      obtain ⟨x, y, hx, hy, hne⟩ := differs_true.1 hd
      have := ht.platform r x hr hx
      rw [hy] at this; cases this; exact hne rfl
    · split
      · rename_i hdom
        obtain ⟨hsb, hsn⟩ := Bool.and_eq_true_iff.1 hdom
        split
        · rfl
        · rename_i hsome
          split
          · rename_i hne
            exfalso
            simp only [Bool.or_eq_true, Option.isNone_iff_eq_none, not_or] at hsome
            obtain ⟨b, hb⟩ := Option.ne_none_iff_exists'.1 hsome.1
            obtain ⟨n, hn⟩ := Option.ne_none_iff_exists'.1 hsome.2
            obtain ⟨sb, hsb'⟩ := Option.isSome_iff_exists.1 hsb
            obtain ⟨sn, hsn'⟩ := Option.isSome_iff_exists.1 hsn
            have e1 := ht.bootId r b sb hr hb hsb'
            have e2 := ht.pidNs r n sn hr hn hsn'
            subst e1 e2
            rw [hb, hsb', hn, hsn'] at hne
            simp at hne
          · exact tsRest_refuse e r true ht hr
      · split
        · rfl
        · exact tsRest_refuse e r false ht hr

/-! ## Finding A (fixed): a machine-id mismatch no longer overrides a proven same PID domain -/

/-- Same boot id and PID namespace, pid running with the recorded start time, machine id
differs (e.g. `docker run --pid=host` with the container's own /etc/machine-id, or a machine id
rewritten while the holder runs). -/
def findingA : Evidence where
  pid := 10
  record := some { birth := some (.ticks 7), bootId := some 1, pidNs := some 1,
                   machineId := some 2, platform := some .linux }
  self := { bootId := some 1, pidNs := some 1, machineId := some 1, platform := some .linux }
  selfPid := 20
  kill := .alive
  current := some 7
  ownTokenLive := false

theorem findingA_topology : Topology findingA where
  notGone := by decide
  selfIsHolder := by decide
  platform := by intro r p hr hp; simp [findingA] at hr; subst hr; simpa [findingA] using hp
  bootId := by intro r b b' hr hb hb'; simp [findingA] at hr hb'; subst hr; simp at hb; omega
  pidNs := by intro r n n' hr hn hn'; simp [findingA] at hr hn'; subst hr; simp at hn; omega
  birth := by
    intro r b n hr hb hn; simp [findingA] at hr hn; subst hr hn; simp at hb; subst hb; decide
  legacyBirth := by intro b n hr; simp [findingA] at hr

theorem findingA_machineUnstable : ¬MachineStable findingA := by
  intro h
  have := h _ 2 1 rfl rfl rfl
  omega

/-- Regression: a live same-domain holder whose machine id changed is refused, by TS and spec. -/
theorem finding_A :
    Topology findingA ∧ ¬MachineStable findingA ∧ tsJudge findingA = .refuse ∧
      specJudge findingA = .refuse :=
  ⟨findingA_topology, findingA_machineUnstable, by decide, by decide⟩

/-! ## Finding B: TS is not monotonic (less evidence can reclaim) -/

/-- Linux observer, ESRCH. -/
def linuxSelf : Identity := { bootId := some 1, pidNs := some 1, platform := some .linux }

/-- B1: an identity record without domain fields is refused, the same record as a legacy one
(no identity; also any crossProcessLock record whose `v` is not 2) is reclaimed on ESRCH. -/
def b1Full : Evidence :=
  { pid := 10, record := some {}, self := linuxSelf, selfPid := 20, kill := .esrch,
    current := none, ownTokenLive := false }
def b1Less : Evidence := { b1Full with record := none }

/-- B2: an observer that cannot read its own PID namespace stops checking domains at all. -/
def b2Less : Evidence := { b1Full with self := { linuxSelf with pidNs := none } }

/-- B3: on macOS a record naming a Linux boot id is refused; without it, ESRCH reclaims. -/
def b3Full : Evidence :=
  { pid := 10, record := some { bootId := some 1 }, self := { platform := some .darwin },
    selfPid := 20, kill := .esrch, current := none, ownTokenLive := false }
def b3Less : Evidence := { b3Full with record := some {} }

theorem finding_B1 : EvLe b1Less b1Full ∧ tsJudge b1Full = .refuse ∧ tsJudge b1Less = .dead ∧
    specJudge b1Less = .refuse := by
  refine ⟨⟨rfl, rfl, rfl, trivial, Or.inr rfl, ?_, Or.inr rfl, Or.inr rfl⟩, by decide, by decide,
    by decide⟩
  exact ⟨Or.inr rfl, Or.inr rfl, Or.inr rfl, Or.inr rfl, Or.inr rfl, Or.inr rfl⟩

theorem finding_B2 : EvLe b2Less b1Full ∧ tsJudge b1Full = .refuse ∧ tsJudge b2Less = .dead ∧
    specJudge b2Less = .refuse := by
  refine ⟨⟨rfl, rfl, rfl, ?_, Or.inr rfl, ?_, Or.inr rfl, Or.inr rfl⟩, by decide, by decide,
    by decide⟩
  · exact ⟨Or.inr rfl, Or.inr rfl, Or.inr rfl, Or.inr rfl, Or.inr rfl, Or.inr rfl⟩
  · exact ⟨Or.inr rfl, Or.inr rfl, Or.inl rfl, Or.inr rfl, Or.inr rfl, Or.inr rfl⟩

theorem finding_B3 : EvLe b3Less b3Full ∧ tsJudge b3Full = .refuse ∧ tsJudge b3Less = .dead ∧
    specJudge b3Full = .dead := by
  refine ⟨⟨rfl, rfl, rfl, ?_, Or.inr rfl, ?_, Or.inr rfl, Or.inr rfl⟩, by decide, by decide,
    by decide⟩
  · exact ⟨Or.inr rfl, Or.inl rfl, Or.inr rfl, Or.inr rfl, Or.inr rfl, Or.inr rfl⟩
  · exact ⟨Or.inr rfl, Or.inr rfl, Or.inr rfl, Or.inr rfl, Or.inr rfl, Or.inr rfl⟩

theorem ts_not_monotone : ¬∀ e' e, EvLe e' e → tsJudge e' = .dead → tsJudge e = .dead := by
  intro h
  have := h b1Less b1Full finding_B1.1 finding_B1.2.2.1
  rw [finding_B1.2.1] at this
  cases this

end ProcessLiveness
