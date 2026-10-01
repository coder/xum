import ProcessLiveness.Spec

/-!
# Soundness (S), monotonic fail-closed (M), reboot/namespace classification (R)
-/

namespace ProcessLiveness

theorem OptLe.some {α : Type} {a b : Option α} {x : α} (h : OptLe a b) (ha : a = some x) :
    b = some x := by
  rcases h with h | h
  · rw [ha] at h; cases h
  · rw [← h, ha]

theorem RecLe.some {r' : Identity} {a b : Option Identity} (h : RecLe a b) (ha : a = some r') :
    ∃ r, b = some r ∧ IdLe r' r := by
  subst ha
  cases b with
  | none => exact absurd h id
  | some r => exact ⟨r, rfl, h⟩

theorem KillLe.esrch {k' k : Kill} (h : KillLe k' k) (hk : k' = .esrch) : k = .esrch := by
  rcases h with h | h
  · rw [hk] at h; cases h
  · rw [← h, hk]

/-! ## (S) Soundness -/

/-- **(S1)** Dead only on positive death evidence. -/
theorem spec_dead_sound (e : Evidence) (h : specJudge e = .dead) : DeathEvidence e :=
  (specJudge_dead_iff e).1 h

/-- **(S2)** Under the topology assumption, a live holder is never reclaimed. -/
theorem spec_never_reclaims_live (e : Evidence) (ht : Topology e) : specJudge e = .refuse := by
  cases hj : specJudge e with
  | refuse => rfl
  | dead =>
    exfalso
    cases spec_dead_sound e hj with
    | linuxOtherOs r p hp hr hrp hne =>
      have := ht.platform r p hr hrp; rw [hp] at this; cases this; exact hne rfl
    | retired r sb sn rb rn _ hr hsb hsn hrb hrn hne =>
      have h1 := ht.bootId r rb sb hr hrb hsb
      have h2 := ht.pidNs r rn sn hr hrn hsn
      rcases hne with h | h <;> contradiction
    | linuxOwnPid r _ hpid hown =>
      have := ht.selfIsHolder hpid; rw [hown] at this; cases this
    | linuxGone r _ _ hk => exact ht.notGone hk
    | linuxReused r b n hd _ hb hn hbe =>
      obtain ⟨_, hr, _⟩ := hd
      have := ht.birth r b n hr hb hn; rw [hbe] at this; cases this
    | otherOs r p q hp _ hr hrq hne =>
      have := ht.platform r q hr hrq; rw [hp] at this; cases this; exact hne rfl
    | ownPid r p _ _ _ hpid hown =>
      have := ht.selfIsHolder hpid; rw [hown] at this; cases this
    | gone p _ _ _ hk => exact ht.notGone hk

/-! ## (M) Monotonic fail-closed -/

theorem deathEvidence_mono {e' e : Evidence} (hle : EvLe e' e) (h : DeathEvidence e') :
    DeathEvidence e := by
  obtain ⟨hpid, hspid, hown, hrec, _, hself, hkill, hcur⟩ := hle
  obtain ⟨_, hsb, hsn, _, hsp, _⟩ := hself
  have dom : ∀ r', SameLinuxDomain e' r' → ∃ r, SameLinuxDomain e r ∧ IdLe r' r := by
    intro r' ⟨hp, hr, b, n, h1, h2, h3, h4⟩
    obtain ⟨r, hr', hid⟩ := hrec.some hr
    have ⟨_, hb, hn, _, _, _⟩ := hid
    exact ⟨r, ⟨hsp.some hp, hr', b, n, hsb.some h1, hsn.some h2, hb.some h3, hn.some h4⟩, hid⟩
  cases h with
  | linuxOtherOs r' p hp hr hrp hne =>
    obtain ⟨r, hr', _, _, _, _, hpl, _⟩ := hrec.some hr
    exact .linuxOtherOs r p (hsp.some hp) hr' (hpl.some hrp) hne
  | retired r' sb sn rb rn hp hr h1 h2 h3 h4 hne =>
    obtain ⟨r, hr', _, hb, hn, _, _, _⟩ := hrec.some hr
    exact .retired r sb sn rb rn (hsp.some hp) hr' (hsb.some h1) (hsn.some h2) (hb.some h3)
      (hn.some h4) hne
  | linuxOwnPid r' hd hp ho =>
    obtain ⟨r, hd', _⟩ := dom r' hd
    exact .linuxOwnPid r hd' (by rw [← hpid, ← hspid]; exact hp) (by rw [← hown]; exact ho)
  | linuxGone r' hd hp hk =>
    obtain ⟨r, hd', _⟩ := dom r' hd
    exact .linuxGone r hd' (by rw [← hpid, ← hspid]; exact hp) (hkill.esrch hk)
  | linuxReused r' b n hd hp hb hn hbe =>
    obtain ⟨r, hd', hbirth, _⟩ := dom r' hd
    exact .linuxReused r b n hd' (by rw [← hpid, ← hspid]; exact hp) (hbirth.some hb)
      (hcur.some hn) hbe
  | otherOs r' p q hp hnl hr hrq hne =>
    obtain ⟨r, hr', _, _, _, _, hpl, _⟩ := hrec.some hr
    exact .otherOs r p q (hsp.some hp) hnl hr' (hpl.some hrq) hne
  | ownPid r' p hp hnl hr hpd ho =>
    obtain ⟨r, hr', _⟩ := hrec.some hr
    exact .ownPid r p (hsp.some hp) hnl hr' (by rw [← hpid, ← hspid]; exact hpd)
      (by rw [← hown]; exact ho)
  | gone p hp hnl hpd hk =>
    exact .gone p (hsp.some hp) hnl (by rw [← hpid, ← hspid]; exact hpd) (hkill.esrch hk)

/-- **(M)** Removing or corrupting any evidence (record fields, the whole identity, the
observer's own identity, the kill probe, the start-time read) never turns refuse into dead. -/
theorem spec_monotone {e' e : Evidence} (hle : EvLe e' e) (h : specJudge e' = .dead) :
    specJudge e = .dead :=
  (specJudge_dead_iff e).2 (deathEvidence_mono hle ((specJudge_dead_iff e').1 h))

theorem spec_refuse_antitone {e' e : Evidence} (hle : EvLe e' e) (h : specJudge e = .refuse) :
    specJudge e' = .refuse := by
  cases h' : specJudge e' with
  | refuse => rfl
  | dead => rw [spec_monotone hle h'] at h; cases h

/-! ## (R) Reboot, namespace and platform classification -/

/-- A different boot id (both PID namespaces known) is a reboot: dead, whatever the pid does. -/
theorem reboot_dead (e : Evidence) (r : Identity) (sb sn rb rn : Nat)
    (hp : e.self.platform = some .linux) (hr : e.record = some r) (hsb : e.self.bootId = some sb)
    (hsn : e.self.pidNs = some sn) (hrb : r.bootId = some rb) (hrn : r.pidNs = some rn)
    (hne : rb ≠ sb) : specJudge e = .dead :=
  (specJudge_dead_iff e).2 (.retired r sb sn rb rn hp hr hsb hsn hrb hrn (Or.inl hne))

/-- The contract's wording: equal machine id with a different boot id is a reboot. -/
theorem same_machine_reboot_dead (e : Evidence) (r : Identity) (m sb sn rb rn : Nat)
    (hp : e.self.platform = some .linux) (hr : e.record = some r)
    (_hm : r.machineId = some m) (_hsm : e.self.machineId = some m)
    (hsb : e.self.bootId = some sb) (hsn : e.self.pidNs = some sn) (hrb : r.bootId = some rb)
    (hrn : r.pidNs = some rn) (hne : rb ≠ sb) : specJudge e = .dead :=
  reboot_dead e r sb sn rb rn hp hr hsb hsn hrb hrn hne

/-- A different PID namespace on the same boot is a replaced container: dead. -/
theorem namespace_dead (e : Evidence) (r : Identity) (sb sn rn : Nat)
    (hp : e.self.platform = some .linux) (hr : e.record = some r) (hsb : e.self.bootId = some sb)
    (hsn : e.self.pidNs = some sn) (hrb : r.bootId = some sb) (hrn : r.pidNs = some rn)
    (hne : rn ≠ sn) : specJudge e = .dead :=
  (specJudge_dead_iff e).2 (.retired r sb sn sb rn hp hr hsb hsn hrb hrn (Or.inr hne))

/-- Linux, record missing its boot id or namespace: refuse, whatever kill and /proc say. -/
theorem unknown_domain_refuses (e : Evidence) (r : Identity) (hp : e.self.platform = some .linux)
    (hr : e.record = some r) (hpl : r.platform = none ∨ r.platform = some .linux)
    (hmissing : r.bootId = none ∨ r.pidNs = none) : specJudge e = .refuse := by
  unfold specJudge
  simp only [hp, hr]
  have : differs r.platform (some Plat.linux) = false := by
    rcases hpl with h | h <;> simp [h, differs]
  rw [this]
  simp only [Bool.false_eq_true, ↓reduceIte]
  rcases hmissing with h | h <;> simp [h] <;> split <;> simp_all

/-- Linux, legacy record (no identity): refuse. -/
theorem legacy_refuses_on_linux (e : Evidence) (hp : e.self.platform = some .linux)
    (hr : e.record = none) : specJudge e = .refuse := by
  simp [specJudge, hp, hr]

/-- macOS/Windows: pid reuse reads as live. A running pid is refused, whatever its start time. -/
theorem nonlinux_reuse_reads_live (e : Evidence) (p : Plat) (hp : e.self.platform = some p)
    (hnl : p ≠ .linux) (hk : e.kill ≠ .esrch) (hpid : e.pid ≠ e.selfPid)
    (hpl : ∀ r q, e.record = some r → r.platform = some q → q = p) : specJudge e = .refuse := by
  cases hj : specJudge e with
  | refuse => rfl
  | dead =>
    exfalso
    cases spec_dead_sound e hj with
    | linuxOtherOs _ _ h => rw [hp] at h; cases h; exact hnl rfl
    | retired _ _ _ _ _ h => rw [hp] at h; cases h; exact hnl rfl
    | linuxOwnPid _ hd => obtain ⟨h, _⟩ := hd; rw [hp] at h; cases h; exact hnl rfl
    | linuxGone _ hd => obtain ⟨h, _⟩ := hd; rw [hp] at h; cases h; exact hnl rfl
    | linuxReused _ _ _ hd => obtain ⟨h, _⟩ := hd; rw [hp] at h; cases h; exact hnl rfl
    | otherOs r p' q h _ hr hrq hne =>
      rw [hp] at h; cases h; exact hne (hpl r q hr hrq)
    | ownPid _ _ _ _ _ hpd => exact hpid hpd
    | gone _ _ _ _ h => exact hk h

/-- Hostname is diagnostic only: changing either side's hostname never changes the verdict. -/
theorem hostname_irrelevant (e : Evidence) (h h' : Option Nat) :
    specJudge { e with record := e.record.map ({ · with hostname := h }),
                       self := { e.self with hostname := h' } } = specJudge e := by
  rcases e with ⟨pid, record, lb, self, spid, k, cur, own⟩
  cases record <;> rfl

end ProcessLiveness
