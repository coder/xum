import ProcessLiveness.Evidence

/-!
# The specified judge

Contract (#4415, processLiveness.ts): fail-closed; reclaim only on POSITIVE evidence of death;
never reclaim from a live holder; no age or lease fallback; hostname is diagnostic only.

* Linux observer: the holder's PID domain must be known on both sides (boot id and PID
  namespace). A different boot id (reboot) or namespace (replaced container) is a retired domain
  ⇒ dead. In the same domain: ESRCH, or a recorded start time that differs from the pid's
  current one (pid reuse) ⇒ dead. Anything unknown or missing ⇒ refuse, including a legacy
  record without identity.
* macOS/Windows observer: no PID-domain identity exists, so the contract's single domain is
  assumed. ESRCH ⇒ dead; a live pid ⇒ refuse (pid reuse reads as live: fail-closed).
* Both: a recorded platform that differs from ours is a different OS ⇒ dead; a holder with our
  pid in our domain is this process, dead only when its token is no longer live here.
* Machine id is never decisive: "equal machine id and a different boot id" (a reboot) is
  already decided by the boot id.
-/

namespace ProcessLiveness

def differs {α : Type} [DecidableEq α] (a b : Option α) : Bool :=
  match a, b with
  | some x, some y => x != y
  | _, _ => false

/-- Same-domain decision on Linux. -/
def linuxInDomain (e : Evidence) (r : Identity) : Verdict :=
  if e.pid = e.selfPid then (if e.ownTokenLive then .refuse else .dead)
  else if e.kill = .esrch then .dead
  else match r.birth, e.current with
    | some b, some n => if birthEq n b then .refuse else .dead
    | _, _ => .refuse

def specJudge (e : Evidence) : Verdict :=
  match e.self.platform with
  | none => .refuse
  | some .linux =>
    match e.record with
    | none => .refuse
    | some r =>
      if differs r.platform (some Plat.linux) then .dead
      else match e.self.bootId, e.self.pidNs, r.bootId, r.pidNs with
        | some sb, some sn, some rb, some rn =>
          if rb ≠ sb ∨ rn ≠ sn then .dead else linuxInDomain e r
        | _, _, _, _ => .refuse
  | some p =>
    match e.record with
    | some r =>
      if differs r.platform (some p) then .dead
      else if e.pid = e.selfPid then (if e.ownTokenLive then .refuse else .dead)
      else if e.kill = .esrch then .dead
      else .refuse
    | none =>
      if e.pid = e.selfPid then .refuse
      else if e.kill = .esrch then .dead
      else .refuse

/-- The positive death evidence, as a disjunction of facts (no "field is missing" premise). -/
def SameLinuxDomain (e : Evidence) (r : Identity) : Prop :=
  e.self.platform = some .linux ∧ e.record = some r ∧
  ∃ b n, e.self.bootId = some b ∧ e.self.pidNs = some n ∧ r.bootId = some b ∧ r.pidNs = some n

inductive DeathEvidence (e : Evidence) : Prop where
  /-- Linux observer, holder recorded another OS. -/
  | linuxOtherOs (r : Identity) (p : Plat) : e.self.platform = some .linux → e.record = some r →
      r.platform = some p → p ≠ .linux → DeathEvidence e
  /-- Linux observer, holder recorded another boot or PID namespace (retired domain). -/
  | retired (r : Identity) (sb sn rb rn : Nat) : e.self.platform = some .linux →
      e.record = some r → e.self.bootId = some sb → e.self.pidNs = some sn →
      r.bootId = some rb → r.pidNs = some rn → (rb ≠ sb ∨ rn ≠ sn) → DeathEvidence e
  /-- Same Linux domain, our pid, and its token is no longer live here. -/
  | linuxOwnPid (r : Identity) : SameLinuxDomain e r → e.pid = e.selfPid →
      e.ownTokenLive = false → DeathEvidence e
  /-- Same Linux domain, ESRCH. -/
  | linuxGone (r : Identity) : SameLinuxDomain e r → e.pid ≠ e.selfPid → e.kill = .esrch →
      DeathEvidence e
  /-- Same Linux domain, recorded start time differs from the current one (pid reuse). -/
  | linuxReused (r : Identity) (b : Birth) (n : Nat) : SameLinuxDomain e r → e.pid ≠ e.selfPid →
      r.birth = some b → e.current = some n → birthEq n b = false → DeathEvidence e
  /-- macOS/Windows observer, holder recorded another OS. -/
  | otherOs (r : Identity) (p q : Plat) : e.self.platform = some p → p ≠ .linux →
      e.record = some r → r.platform = some q → q ≠ p → DeathEvidence e
  /-- macOS/Windows observer, identity record with our pid whose token is no longer live. -/
  | ownPid (r : Identity) (p : Plat) : e.self.platform = some p → p ≠ .linux →
      e.record = some r → e.pid = e.selfPid → e.ownTokenLive = false → DeathEvidence e
  /-- macOS/Windows observer (single assumed domain), ESRCH. -/
  | gone (p : Plat) : e.self.platform = some p → p ≠ .linux → e.pid ≠ e.selfPid →
      e.kill = .esrch → DeathEvidence e

theorem differs_true {α : Type} [DecidableEq α] {a b : Option α} :
    differs a b = true ↔ ∃ x y, a = some x ∧ b = some y ∧ x ≠ y := by
  cases a <;> cases b <;> simp [differs]

/-- **Characterization.** The judge says dead exactly on positive death evidence. -/
theorem specJudge_dead_iff (e : Evidence) : specJudge e = .dead ↔ DeathEvidence e := by
  constructor
  · intro h
    unfold specJudge at h
    split at h
    · simp at h
    · rename_i hp
      split at h
      · simp at h
      · rename_i r hr
        split at h
        · rename_i hd
          obtain ⟨x, y, hx, hy, hne⟩ := differs_true.1 hd
          cases hy
          exact .linuxOtherOs r x hp hr hx hne
        · split at h
          · rename_i sb sn rb rn hsb hsn hrb hrn
            split at h
            · rename_i hne
              exact .retired r sb sn rb rn hp hr hsb hsn hrb hrn hne
            · rename_i heq
              have hb : rb = sb := by omega
              have hn : rn = sn := by omega
              subst hb hn
              have hdom : SameLinuxDomain e r := ⟨hp, hr, rb, rn, hsb, hsn, hrb, hrn⟩
              unfold linuxInDomain at h
              split at h
              · rename_i hpid
                split at h
                · simp at h
                · rename_i hown
                  exact .linuxOwnPid r hdom hpid (by simpa using hown)
              · rename_i hpid
                split at h
                · rename_i hk; exact .linuxGone r hdom hpid hk
                · split at h
                  · rename_i b n hb hn
                    split at h
                    · simp at h
                    · rename_i hbe
                      exact .linuxReused r b n hdom hpid hb hn (by simpa using hbe)
                  · simp at h
          · simp at h
    · rename_i p hnl' hp
      split at h
      · rename_i r hr
        split at h
        · rename_i hd
          obtain ⟨x, y, hx, hy, hne⟩ := differs_true.1 hd
          cases hy
          exact .otherOs r p x hp hnl' hr hx hne
        · split at h
          · rename_i hpid
            split at h
            · simp at h
            · rename_i hown
              exact .ownPid r p hp hnl' hr hpid (by simpa using hown)
          · rename_i hpid
            split at h
            · rename_i hk; exact .gone p hp hnl' hpid hk
            · simp at h
      · split at h
        · simp at h
        · rename_i hpid
          split at h
          · rename_i hk; exact .gone p hp hnl' hpid hk
          · simp at h
  · intro h
    cases h with
    | linuxOtherOs r p hp hr hrp hne =>
      simp [specJudge, hp, hr, hrp, differs, hne]
    | retired r sb sn rb rn hp hr hsb hsn hrb hrn hne =>
      unfold specJudge
      simp only [hp, hr, hsb, hsn, hrb, hrn]
      split
      · rfl
      · simp
    | linuxOwnPid r hd hpid hown =>
      obtain ⟨hp, hr, b, n, hsb, hsn, hrb, hrn⟩ := hd
      unfold specJudge
      simp only [hp, hr, hsb, hsn, hrb, hrn]
      split
      · rfl
      · simp [linuxInDomain, hpid, hown]
    | linuxGone r hd hpid hk =>
      obtain ⟨hp, hr, b, n, hsb, hsn, hrb, hrn⟩ := hd
      unfold specJudge
      simp only [hp, hr, hsb, hsn, hrb, hrn]
      split
      · rfl
      · simp [linuxInDomain, hpid, hk]
    | linuxReused r bb nn hd hpid hb hn hbe =>
      obtain ⟨hp, hr, b, n, hsb, hsn, hrb, hrn⟩ := hd
      unfold specJudge
      simp only [hp, hr, hsb, hsn, hrb, hrn]
      split
      · rfl
      · unfold linuxInDomain
        simp only [hpid, ↓reduceIte]
        split
        · rfl
        · simp [hb, hn, hbe]
    | otherOs r p q hp hnl hr hrq hne =>
      unfold specJudge
      cases p with
      | linux => exact absurd rfl hnl
      | darwin => simp [hp, hr, hrq, differs, hne]
      | win32 => simp [hp, hr, hrq, differs, hne]
      | other k => simp [hp, hr, hrq, differs, hne]
    | ownPid r p hp hnl hr hpid hown =>
      unfold specJudge
      cases p with
      | linux => exact absurd rfl hnl
      | darwin => simp [hp, hr, hpid, hown]
      | win32 => simp [hp, hr, hpid, hown]
      | other k => simp [hp, hr, hpid, hown]
    | gone p hp hnl hpid hk =>
      unfold specJudge
      cases p with
      | linux => exact absurd rfl hnl
      | darwin =>
        simp only [hp]
        split <;> simp [hpid, hk]
      | win32 =>
        simp only [hp]
        split <;> simp [hpid, hk]
      | other k =>
        simp only [hp]
        split <;> simp [hpid, hk]

end ProcessLiveness
