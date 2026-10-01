import HistoryLocator.Probe

/-!
# Provider history start: the intended rule

Rows are listed **newest first** (depth 0 is the last row of chat.jsonl), because that is the
order the locator reads them. Empty rows (zero bytes between two newlines) are left out: the
locator skips them without touching any state, and the provider projections skip them too.

The provider receives the `c` newest rows, where `c` is the *cut* computed below; rows at depth
`≥ c` never reach the model.

Every row belongs to one class (what `classifyHistoryScanRow` + `isManualHistoryReset` +
`isDurableContextBoundaryMarker` decide for it in TS):

* `plain`       – readable, neither a floor nor a boundary.
* `boundary`    – readable durable context boundary that is not a manual reset: a compaction
                  boundary or a validated context-window rollover. Skippable (`skip`).
* `resetMarker` – readable manual reset that is also a durable boundary (assistant role): the
                  epoch starts **at** it, so the row itself is kept.
* `resetFloor`  – readable manual reset that is not a durable boundary (e.g. malformed role):
                  the epoch starts **after** it.
* `unreadable`  – the classifier returned no message: malformed JSON, not a history message,
                  ambiguous duplicate keys around a reset, or longer than the 1 MiB line limit.

Unreadable rows carry *raw reset evidence*:

* `localEv` – the row's own text holds the needle after separators are removed and escapes are
  decoded (`hasRawResetMarker`), or the parsed JSON re-serializes to it.
* `toks`    – the reset tokens (key, colon, value) that occur in the row, in file order.

A maximal run of consecutive unreadable rows is a *privacy floor* when some row has local
evidence or the run's tokens hold key, colon, value in order (a marker fragmented over several
rows). The whole run is excluded: the cut is the depth of its newest row.
-/

namespace HistoryLocator

inductive Kind where
  | plain
  | boundary
  | resetMarker
  | resetFloor
  | unreadable
  deriving DecidableEq, Repr

structure Row where
  kind : Kind
  toks : List Tok := []
  localEv : Bool := false
  /-- Longer than `SESSION_HISTORY_MAX_LINE_BYTES`: the locator never parses it. -/
  oversized : Bool := false
  deriving DecidableEq, Repr

/-- File-order tokens of a run that is listed newest first. -/
def runToks (run : List Row) : List Tok := (run.reverse.map Row.toks).flatten

/-- The intended raw-evidence rule for an unreadable run (declarative). -/
def RunEvidence (run : List Row) : Prop :=
  (∃ r ∈ run, r.localEv = true) ∨ markerPattern.Sublist (runToks run)

instance (run : List Row) : Decidable (RunEvidence run) :=
  decidable_of_iff ((∃ r ∈ run, r.localEv = true) ∨ feed markerPattern (runToks run) = [])
    (by rw [feed_eq_nil_iff]; rfl)

theorem runToks_snoc (run : List Row) (r : Row) :
    runToks (run ++ [r]) = r.toks ++ runToks run := by
  simp [runToks]

theorem RunEvidence.snoc {run : List Row} (h : RunEvidence run) (r : Row) :
    RunEvidence (run ++ [r]) := by
  rcases h with ⟨x, hx, hl⟩ | hs
  · exact Or.inl ⟨x, List.mem_append_left _ hx, hl⟩
  · exact Or.inr (by rw [runToks_snoc]; exact hs.trans (List.sublist_append_right _ _))

/-- Events of the rule, in the order a reverse read meets them. `cut` is the provider cut. -/
inductive Event where
  | floor (cut : Nat)
  | boundary (cut : Nat)
  deriving DecidableEq, Repr

def Event.cut : Event → Nat
  | .floor c => c
  | .boundary c => c

def Event.boundaryCut? : Event → Option Nat
  | .floor _ => none
  | .boundary c => some c

/-- The unreadable run being collected: depth of its newest row, and its rows (newest first). -/
abbrev Run := Option (Nat × List Row)

def Run.extend : Run → Nat → Row → Nat × List Row
  | none, d, r => (d, [r])
  | some (a, rows), _, r => (a, rows ++ [r])

def flush : Run → List Event
  | none => []
  | some (a, run) => if RunEvidence run then [.floor a] else []

def rowEvent (r : Row) (d : Nat) : List Event :=
  match r.kind with
  | .plain => []
  | .boundary => [.boundary (d + 1)]
  | .resetMarker => [.floor (d + 1)]
  | .resetFloor => [.floor d]
  | .unreadable => []

/-- All events of `rows` (newest first, the head at depth `d`), grouping unreadable runs whole. -/
def evs : Run → Nat → List Row → List Event
  | run, _, [] => flush run
  | run, d, r :: rs =>
    if r.kind = .unreadable then evs (some (run.extend d r)) (d + 1) rs
    else flush run ++ rowEvent r d ++ evs none (d + 1) rs

/-- The first floor, or the `(k+1)`-th boundary, whichever a reverse read meets first. -/
def pick : Nat → List Event → Option Nat
  | _, [] => none
  | _, .floor c :: _ => some c
  | 0, .boundary c :: _ => some c
  | k + 1, .boundary _ :: es => pick k es

/-- The intended provider cut. `none` = no floor and fewer than `skip + 1` boundaries: the
file is exhausted and every row is kept (the caller may continue into the archive). -/
def specCut (skip : Nat) (rows : List Row) : Option Nat := pick skip (evs none 0 rows)

/-- Cut of the `(k+1)`-th boundary event, ignoring floors. -/
def nthBoundary (k : Nat) (es : List Event) : Option Nat := (es.filterMap Event.boundaryCut?)[k]?

/-! ## Events are sorted by cut -/

def Run.lo : Run → Nat → Nat
  | none, d => d
  | some (a, _), _ => a

def Run.Ok : Run → Nat → Prop
  | none, _ => True
  | some (a, _), d => a ≤ d

theorem evs_lower (rows : List Row) :
    ∀ (run : Run) (d : Nat), run.Ok d → ∀ e ∈ evs run d rows, run.lo d ≤ e.cut := by
  induction rows with
  | nil =>
    intro run d _ e he
    cases run with
    | none => simp [evs, flush] at he
    | some p =>
      obtain ⟨a, R⟩ := p
      simp only [evs, flush] at he
      split at he
      · simp at he; subst he; simp [Run.lo, Event.cut]
      · simp at he
  | cons r rs ih =>
    intro run d hok e he
    simp only [evs] at he
    split at he
    · have hok' : Run.Ok (some (run.extend d r)) (d + 1) := by
        cases run with
        | none => simp [Run.extend, Run.Ok]
        | some p => obtain ⟨a, R⟩ := p; simp [Run.extend, Run.Ok] at hok ⊢; omega
      have := ih _ _ hok' e he
      cases run with
      | none => simpa [Run.extend, Run.lo] using this
      | some p => obtain ⟨a, R⟩ := p; simpa [Run.extend, Run.lo] using this
    · have hlo : run.lo d ≤ d := by
        cases run with
        | none => simp [Run.lo]
        | some p => obtain ⟨a, R⟩ := p; simpa [Run.lo, Run.Ok] using hok
      simp only [List.mem_append] at he
      rcases he with (he | he) | he
      · cases run with
        | none => simp [flush] at he
        | some p =>
          obtain ⟨a, R⟩ := p
          simp only [flush] at he
          split at he
          · simp at he; subst he; simp [Run.lo, Event.cut]
          · simp at he
      · unfold rowEvent at he
        split at he <;> simp at he <;> subst he <;> simp [Event.cut] <;> omega
      · have := ih none (d + 1) trivial e he
        simp [Run.lo] at this
        omega

theorem evs_sorted (rows : List Row) :
    ∀ (run : Run) (d : Nat), run.Ok d → (evs run d rows).Pairwise (fun e f => e.cut ≤ f.cut) := by
  induction rows with
  | nil =>
    intro run d _
    cases run with
    | none => simp [evs, flush]
    | some p =>
      obtain ⟨a, R⟩ := p
      simp only [evs, flush]
      split <;> simp
  | cons r rs ih =>
    intro run d hok
    simp only [evs]
    split
    · apply ih
      cases run with
      | none => simp [Run.extend, Run.Ok]
      | some p => obtain ⟨a, R⟩ := p; simp [Run.extend, Run.Ok] at hok ⊢; omega
    · have hrest := ih none (d + 1) trivial
      have hlow := evs_lower rs none (d + 1) trivial
      simp only [Run.lo] at hlow
      have hflush : ∀ e ∈ flush run, e.cut ≤ d := by
        intro e he
        cases run with
        | none => simp [flush] at he
        | some p =>
          obtain ⟨a, R⟩ := p
          simp only [flush] at he
          split at he
          · simp at he; subst he; simpa [Event.cut, Run.Ok] using hok
          · simp at he
      have hrow : ∀ e ∈ rowEvent r d, d ≤ e.cut ∧ e.cut ≤ d + 1 := by
        intro e he
        unfold rowEvent at he
        split at he <;> simp at he <;> subst he <;> simp [Event.cut]
      have hflushP : (flush run).Pairwise (fun e f => e.cut ≤ f.cut) := by
        cases run with
        | none => simp [flush]
        | some p => obtain ⟨a, R⟩ := p; simp only [flush]; split <;> simp
      have hrowP : (rowEvent r d).Pairwise (fun e f => e.cut ≤ f.cut) := by
        unfold rowEvent; split <;> simp
      rw [List.pairwise_append, List.pairwise_append]
      refine ⟨⟨hflushP, hrowP, ?_⟩, hrest, ?_⟩
      · intro e he f hf
        have := hflush e he
        have := hrow f hf
        omega
      · intro e he f hf
        have := hlow f hf
        simp only [List.mem_append] at he
        rcases he with he | he
        · have := hflush e he; omega
        · have := hrow e he; omega

/-! ## `pick` returns the greatest admissible cut -/

theorem pick_le_floor :
    ∀ (k : Nat) (es : List Event), es.Pairwise (fun e f => e.cut ≤ f.cut) →
      ∀ c, pick k es = some c → ∀ c', Event.floor c' ∈ es → c ≤ c'
  | _, [], _, _, h, _, _ => by simp [pick] at h
  | _, .floor x :: es, hs, c, h, c', hm => by
    simp [pick] at h; subst h
    rcases List.mem_cons.1 hm with he | he
    · cases he; exact Nat.le_refl _
    · exact (List.pairwise_cons.1 hs).1 _ he
  | 0, .boundary x :: es, hs, c, h, c', hm => by
    simp [pick] at h; subst h
    rcases List.mem_cons.1 hm with he | he
    · cases he
    · exact (List.pairwise_cons.1 hs).1 _ he
  | k + 1, .boundary x :: es, hs, c, h, c', hm => by
    simp only [pick] at h
    rcases List.mem_cons.1 hm with he | he
    · cases he
    · exact pick_le_floor k es (List.pairwise_cons.1 hs).2 c h c' he

theorem pick_le_boundary :
    ∀ (k : Nat) (es : List Event), es.Pairwise (fun e f => e.cut ≤ f.cut) →
      ∀ c, pick k es = some c → ∀ b, nthBoundary k es = some b → c ≤ b
  | _, [], _, _, h, _, _ => by simp [pick] at h
  | k, .floor x :: es, hs, c, h, b, hb => by
    simp [pick] at h; subst h
    simp only [nthBoundary, List.filterMap_cons, Event.boundaryCut?] at hb
    have hm := List.mem_of_getElem? hb
    rw [List.mem_filterMap] at hm
    obtain ⟨e, he, hc⟩ := hm
    have := (List.pairwise_cons.1 hs).1 e he
    cases e <;> simp [Event.boundaryCut?] at hc
    subst hc; simpa [Event.cut] using this
  | 0, .boundary x :: es, _, c, h, b, hb => by
    simp [pick] at h; subst h
    simp [nthBoundary, Event.boundaryCut?] at hb
    omega
  | k + 1, .boundary x :: es, hs, c, h, b, hb => by
    simp only [pick] at h
    simp only [nthBoundary, List.filterMap_cons, Event.boundaryCut?,
      List.getElem?_cons_succ] at hb
    exact pick_le_boundary k es (List.pairwise_cons.1 hs).2 c h b hb

theorem pick_witness :
    ∀ (k : Nat) (es : List Event) (c : Nat), pick k es = some c →
      Event.floor c ∈ es ∨ nthBoundary k es = some c
  | _, [], _, h => by simp [pick] at h
  | _, .floor x :: _, c, h => by simp [pick] at h; subst h; simp
  | 0, .boundary x :: _, c, h => by
    simp [pick] at h; subst h; right; simp [nthBoundary, Event.boundaryCut?]
  | k + 1, .boundary x :: es, c, h => by
    simp only [pick] at h
    rcases pick_witness k es c h with hm | hb
    · left; exact List.mem_cons_of_mem _ hm
    · right
      simpa [nthBoundary, Event.boundaryCut?] using hb

theorem pick_none :
    ∀ (k : Nat) (es : List Event), pick k es = none →
      (∀ c, Event.floor c ∉ es) ∧ nthBoundary k es = none
  | _, [], _ => by simp [nthBoundary]
  | _, .floor x :: _, h => by simp [pick] at h
  | 0, .boundary x :: _, h => by simp [pick] at h
  | k + 1, .boundary x :: es, h => by
    simp only [pick] at h
    obtain ⟨hf, hb⟩ := pick_none k es h
    refine ⟨?_, ?_⟩
    · intro c hc
      rcases List.mem_cons.1 hc with he | he
      · cases he
      · exact hf c he
    · simpa [nthBoundary, Event.boundaryCut?] using hb

/-- A cut is admissible when it keeps nothing below any floor or the `(skip+1)`-th boundary. -/
def Admissible (skip : Nat) (rows : List Row) (c : Nat) : Prop :=
  (∀ f, Event.floor f ∈ evs none 0 rows → c ≤ f) ∧
  (∀ b, nthBoundary skip (evs none 0 rows) = some b → c ≤ b)

/-- **Privacy + maximality.** The specified cut is admissible and every admissible cut is at most
it: the provider gets the longest suffix that crosses no floor and at most `skip` boundaries. -/
theorem specCut_greatest (skip : Nat) (rows : List Row) (c : Nat)
    (h : specCut skip rows = some c) :
    Admissible skip rows c ∧ ∀ c', Admissible skip rows c' → c' ≤ c := by
  have hs := evs_sorted rows none 0 trivial
  refine ⟨⟨pick_le_floor _ _ hs c h, pick_le_boundary _ _ hs c h⟩, ?_⟩
  intro c' ⟨hf, hb⟩
  rcases pick_witness _ _ c h with hm | hm
  · exact hf c hm
  · exact hb c hm

/-- **Exhaustion.** No cut means no floor at all and at most `skip` boundaries. -/
theorem specCut_none (skip : Nat) (rows : List Row) (h : specCut skip rows = none) :
    (∀ c, Event.floor c ∉ evs none 0 rows) ∧ nthBoundary skip (evs none 0 rows) = none :=
  pick_none _ _ h

/-! ## Row-level floors: every reset row and every locally evidenced unreadable row yields a
floor at or before it, so it (and everything older) is excluded. -/

theorem evs_flush_mem (rows : List Row) :
    ∀ (a d : Nat) (R : List Row), RunEvidence R → Event.floor a ∈ evs (some (a, R)) d rows := by
  induction rows with
  | nil => intro a d R h; simp [evs, flush, h]
  | cons r rs ih =>
    intro a d R h
    simp only [evs]
    split
    · simp only [Run.extend]; exact ih a (d + 1) _ (h.snoc r)
    · simp [flush, h]

/-- Depth of the run that a row at depth `d` joins, given the collected run. -/
theorem floor_of_row (rows : List Row) :
    ∀ (run : Run) (d i : Nat) (r : Row), run.Ok d → rows[i]? = some r →
      (r.kind = .resetFloor → Event.floor (d + i) ∈ evs run d rows) ∧
      (r.kind = .resetMarker → Event.floor (d + i + 1) ∈ evs run d rows) ∧
      (r.kind = .unreadable → r.localEv = true →
        ∃ a, a ≤ d + i ∧ Event.floor a ∈ evs run d rows) := by
  induction rows with
  | nil => intro run d i r _ h; simp at h
  | cons x xs ih =>
    intro run d i r hok hi
    cases i with
    | zero =>
      simp at hi; subst hi
      refine ⟨fun hk => ?_, fun hk => ?_, fun hk hl => ?_⟩
      · simp [evs, hk, rowEvent]
      · simp [evs, hk, rowEvent]
      · simp only [evs, hk, ite_true]
        have hR : RunEvidence (run.extend d x).2 := by
          cases run with
          | none => exact Or.inl ⟨x, by simp [Run.extend], hl⟩
          | some p =>
            obtain ⟨a, R⟩ := p
            exact Or.inl ⟨x, by simp [Run.extend], hl⟩
        refine ⟨(run.extend d x).1, ?_, ?_⟩
        · cases run with
          | none => simp [Run.extend]
          | some p => obtain ⟨a, R⟩ := p; simpa [Run.extend, Run.Ok] using hok
        · exact evs_flush_mem xs _ (d + 1) _ hR
    | succ i =>
      simp only [List.getElem?_cons_succ] at hi
      simp only [evs]
      split
      · have hok' : Run.Ok (some (run.extend d x)) (d + 1) := by
          cases run with
          | none => simp [Run.extend, Run.Ok]
          | some p => obtain ⟨a, R⟩ := p; simp [Run.extend, Run.Ok] at hok ⊢; omega
        obtain ⟨h1, h2, h3⟩ := ih _ (d + 1) i r hok' hi
        refine ⟨fun hk => ?_, fun hk => ?_, fun hk hl => ?_⟩
        · have := h1 hk; rwa [show d + 1 + i = d + (i + 1) by omega] at this
        · have := h2 hk; rwa [show d + 1 + i + 1 = d + (i + 1) + 1 by omega] at this
        · obtain ⟨a, ha, hm⟩ := h3 hk hl
          exact ⟨a, by omega, hm⟩
      · obtain ⟨h1, h2, h3⟩ := ih none (d + 1) i r trivial hi
        refine ⟨fun hk => ?_, fun hk => ?_, fun hk hl => ?_⟩
        · have := h1 hk
          rw [show d + 1 + i = d + (i + 1) by omega] at this
          exact List.mem_append_right _ this
        · have := h2 hk
          rw [show d + 1 + i + 1 = d + (i + 1) + 1 by omega] at this
          exact List.mem_append_right _ this
        · obtain ⟨a, ha, hm⟩ := h3 hk hl
          exact ⟨a, by omega, List.mem_append_right _ hm⟩

/-- **Row-level privacy.** With cut `c`, the provider receives `rows.take c`. -/
theorem privacy (skip : Nat) (rows : List Row) (c : Nat) (h : specCut skip rows = some c) :
    ∀ i r, rows[i]? = some r →
      (r.kind = .resetFloor → c ≤ i) ∧
      (r.kind = .resetMarker → c ≤ i + 1) ∧
      (r.kind = .unreadable → r.localEv = true → c ≤ i) := by
  intro i r hi
  have hf := (specCut_greatest skip rows c h).1.1
  obtain ⟨h1, h2, h3⟩ := floor_of_row rows none 0 i r trivial hi
  refine ⟨fun hk => ?_, fun hk => ?_, fun hk hl => ?_⟩
  · have := hf _ (h1 hk); omega
  · have := hf _ (h2 hk); omega
  · obtain ⟨a, ha, hm⟩ := h3 hk hl
    have := hf _ hm; omega

/-- **Row-level exhaustion.** If no cut is found, the file holds no reset row and no locally
evidenced unreadable row, so keeping every row is private. -/
theorem exhausted_private (skip : Nat) (rows : List Row) (h : specCut skip rows = none) :
    ∀ r ∈ rows, r.kind ≠ .resetFloor ∧ r.kind ≠ .resetMarker ∧
      ¬(r.kind = .unreadable ∧ r.localEv = true) := by
  intro r hr
  obtain ⟨i, hi⟩ := List.getElem?_of_mem hr
  have hf := (specCut_none skip rows h).1
  obtain ⟨h1, h2, h3⟩ := floor_of_row rows none 0 i r trivial hi
  refine ⟨fun hk => hf _ (h1 hk), fun hk => hf _ (h2 hk), fun ⟨hk, hl⟩ => ?_⟩
  obtain ⟨a, _, hm⟩ := h3 hk hl
  exact hf _ hm

end HistoryLocator
