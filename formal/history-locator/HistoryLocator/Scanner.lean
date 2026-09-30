import HistoryLocator.Spec

/-!
# The streaming locator and its correctness

`scan` models the row-by-row part of `findProviderHistoryStart` (`settle` in
src/node/services/historyScanner.ts): rows arrive newest first, one at a time.

* The probe state is the remaining reverse pattern (`addHistoryResetProbe`'s three stages); it
  is kept across the rows of an unreadable run and reset after every readable row.
* `runStart` is `unreadableRunEnd`: the depth of the newest row of the current unreadable run.
* An unreadable row floors the read when the probe accepts, or when the row's own text holds
  local evidence (`hasRawResetMarker` / re-serialization inside `classifyHistoryScanRow`).
  Oversized rows are never classified; their local evidence comes from the streaming raw probe
  (`createReverseRawHistoryProbe`), which applies `hasRawResetMarker`'s rule to the whole row.
* `left` counts the boundaries still to skip (`boundaryCount++ === skip`).

`locate_eq_spec` proves the streaming locator equals the whole-run rule of `Spec.lean`. Before
the fix, oversized rows' local evidence was ignored and the equality needed a hypothesis about
the concrete recognizers (whatever local evidence an oversized row has is also visible to the
token probe); `oversized_gap` shows that pre-fix locator misses a floor the rule requires.
-/

namespace HistoryLocator

def scan : Nat → Option Nat → List Tok → Nat → List Row → Option Nat
  | _, _, _, _, [] => none
  | left, runStart, pat, d, r :: rest =>
    match r.kind with
    | .unreadable =>
      let pat' := feed pat r.toks.reverse
      let start := runStart.getD d
      if pat' = [] ∨ r.localEv = true then some start
      else scan left (some start) pat' (d + 1) rest
    | .plain => scan left none revPattern (d + 1) rest
    | .resetMarker => some (d + 1)
    | .resetFloor => some d
    | .boundary =>
      match left with
      | 0 => some (d + 1)
      | k + 1 => scan k none revPattern (d + 1) rest

/-- `findProviderHistoryStart` on the rows of one file (newest first). -/
def locate (skip : Nat) (rows : List Row) : Option Nat := scan skip none revPattern 0 rows

/-- Tokens of a newest-first run in the order the reverse probe consumes them. -/
def revToks (run : List Row) : List Tok := (run.map fun r => r.toks.reverse).flatten

theorem revToks_snoc (run : List Row) (r : Row) :
    revToks (run ++ [r]) = revToks run ++ r.toks.reverse := by
  simp [revToks]

theorem revToks_eq (run : List Row) : revToks run = (runToks run).reverse := by
  induction run with
  | nil => rfl
  | cons r rs ih =>
    simp only [revToks, runToks, List.map_cons, List.flatten_cons, List.reverse_cons,
      List.map_append, List.map_nil, List.flatten_append, List.reverse_append] at ih ⊢
    rw [ih]; simp

theorem probe_run_iff (run : List Row) :
    feed revPattern (revToks run) = [] ↔ markerPattern.Sublist (runToks run) := by
  rw [revToks_eq, probe_accepts_iff]

/-- Invariant linking the locator's state to the rule's collected run. -/
def Inv : Run → Option Nat → List Tok → Prop
  | none, runStart, pat => runStart = none ∧ pat = revPattern
  | some (a, R), runStart, pat =>
    runStart = some a ∧ pat = feed revPattern (revToks R) ∧ ¬RunEvidence R

theorem flush_eq_nil {run : Run} {rs : Option Nat} {pat : List Tok} (h : Inv run rs pat) :
    flush run = [] := by
  cases run with
  | none => rfl
  | some p =>
    obtain ⟨a, R⟩ := p
    simp only [Inv] at h
    simp [flush, h.2.2]

theorem pick_evs_evidence (rows : List Row) :
    ∀ (k a d : Nat) (R : List Row), RunEvidence R → pick k (evs (some (a, R)) d rows) = some a := by
  induction rows with
  | nil => intro k a d R h; simp [evs, flush, h]; cases k <;> rfl
  | cons r rs ih =>
    intro k a d R h
    simp only [evs]
    split
    · exact ih k a (d + 1) _ (h.snoc r)
    · simp [flush, h]; cases k <;> rfl

theorem scan_eq_evs (rows : List Row) :
    ∀ (left : Nat) (run : Run) (rs : Option Nat) (pat : List Tok) (d : Nat),
      Inv run rs pat → scan left rs pat d rows = pick left (evs run d rows) := by
  induction rows with
  | nil =>
    intro left run rs pat d hinv
    simp [scan, evs, flush_eq_nil hinv]
    cases left <;> rfl
  | cons r rest ih =>
    intro left run rs pat d hinv
    -- Unreadable row joining the collected run `R` that starts at depth `a`.
    have key : ∀ a R, pat = feed revPattern (revToks R) → ¬RunEvidence R → rs.getD d = a →
        r.kind = .unreadable →
        scan left rs pat d (r :: rest) = pick left (evs (some (a, R ++ [r])) (d + 1) rest) := by
      intro a R hpat hno hrs hk
      have hpat' : feed pat r.toks.reverse = feed revPattern (revToks (R ++ [r])) := by
        rw [hpat, revToks_snoc, feed_append]
      simp only [scan, hk, hrs]
      split
      · rename_i hdet
        symm
        apply pick_evs_evidence
        rcases hdet with hacc | hl
        · rw [hpat'] at hacc
          exact Or.inr ((probe_run_iff _).1 hacc)
        · exact Or.inl ⟨r, by simp, hl⟩
      · rename_i hdet
        apply ih
        refine ⟨rfl, hpat', ?_⟩
        rintro (⟨x, hx, hl⟩ | hs)
        · rcases List.mem_append.1 hx with hx | hx
          · exact hno (Or.inl ⟨x, hx, hl⟩)
          · simp at hx; subst hx
            exact hdet (Or.inr hl)
        · exact hdet (Or.inl (by rw [hpat']; exact (probe_run_iff _).2 hs))
    -- Readable rows: the collected run has no evidence, so it contributes no event.
    have readable : r.kind ≠ .unreadable →
        scan left rs pat d (r :: rest) = pick left (rowEvent r d ++ evs none (d + 1) rest) := by
      intro hk
      have hih := ih
      cases hkr : r.kind with
      | unreadable => exact absurd hkr hk
      | plain =>
        simp only [scan, hkr, rowEvent, List.nil_append]
        exact hih left none none revPattern (d + 1) ⟨rfl, rfl⟩
      | resetMarker => simp [scan, hkr, rowEvent, pick]
      | resetFloor => simp [scan, hkr, rowEvent, pick]
      | boundary =>
        cases left with
        | zero => simp [scan, hkr, rowEvent, pick]
        | succ k =>
          simp only [scan, hkr, rowEvent, List.singleton_append, pick]
          exact hih k none none revPattern (d + 1) ⟨rfl, rfl⟩
    by_cases hk : r.kind = .unreadable
    · cases run with
      | none =>
        obtain ⟨h1, h2⟩ := hinv
        subst h1 h2
        have := key d [] (by simp [revToks]) (by
          rintro (⟨x, hx, _⟩ | hs)
          · simp at hx
          · simp [runToks, markerPattern] at hs) rfl hk
        simpa [evs, hk, Run.extend] using this
      | some p =>
        obtain ⟨a, R⟩ := p
        obtain ⟨h1, h2, h3⟩ := hinv
        subst h1
        have := key a R h2 h3 rfl hk
        simpa [evs, hk, Run.extend] using this
    · rw [readable hk]
      simp [evs, hk, flush_eq_nil hinv]

/-- **Streaming = whole-run rule.** The row-by-row locator returns exactly the specified cut, so
it inherits `privacy`, `specCut_greatest` and `exhausted_private`. -/
theorem locate_eq_spec (skip : Nat) (rows : List Row) :
    locate skip rows = specCut skip rows :=
  scan_eq_evs rows skip none none revPattern 0 ⟨rfl, rfl⟩

theorem locate_privacy (skip : Nat) (rows : List Row) (c : Nat)
    (hc : locate skip rows = some c) :
    ∀ i r, rows[i]? = some r →
      (r.kind = .resetFloor → c ≤ i) ∧
      (r.kind = .resetMarker → c ≤ i + 1) ∧
      (r.kind = .unreadable → r.localEv = true → c ≤ i) :=
  privacy skip rows c (by rw [← locate_eq_spec skip rows]; exact hc)

theorem locate_greatest (skip : Nat) (rows : List Row) (c : Nat)
    (hc : locate skip rows = some c) :
    Admissible skip rows c ∧ ∀ c', Admissible skip rows c' → c' ≤ c :=
  specCut_greatest skip rows c (by rw [← locate_eq_spec skip rows]; exact hc)

/-! ## Finding F1: the pre-fix locator

Before the fix the locator ignored oversized rows' local evidence: only the probe counted for
them. `scanPreFix` is `scan` with that condition. Newest first: a readable row, an oversized
unreadable row whose text holds the reset needle only once separators are removed (e.g. a NUL
inside the key, so no clean key token), and an older readable row. The rule floors at the
oversized row (cut 1: keep only the newest row); the pre-fix locator keeps all three rows. The
fixed `locate` agrees with the rule here, as `locate_eq_spec` says for every input. -/
def scanPreFix : Nat → Option Nat → List Tok → Nat → List Row → Option Nat
  | _, _, _, _, [] => none
  | left, runStart, pat, d, r :: rest =>
    match r.kind with
    | .unreadable =>
      let pat' := feed pat r.toks.reverse
      let start := runStart.getD d
      if pat' = [] ∨ (r.oversized = false ∧ r.localEv = true) then some start
      else scanPreFix left (some start) pat' (d + 1) rest
    | .plain => scanPreFix left none revPattern (d + 1) rest
    | .resetMarker => some (d + 1)
    | .resetFloor => some d
    | .boundary =>
      match left with
      | 0 => some (d + 1)
      | k + 1 => scanPreFix k none revPattern (d + 1) rest

def gapRows : List Row :=
  [ { kind := .plain },
    { kind := .unreadable, toks := [.colon, .value], localEv := true, oversized := true },
    { kind := .plain } ]

theorem gap_spec : specCut 0 gapRows = some 1 := by decide
theorem gap_locate : locate 0 gapRows = some 1 := by decide

theorem oversized_gap : scanPreFix 0 none revPattern 0 gapRows ≠ specCut 0 gapRows := by decide

end HistoryLocator
