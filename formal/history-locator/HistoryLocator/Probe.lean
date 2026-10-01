/-!
# The reverse reset-token probe

`addHistoryResetProbe` (src/node/services/historyScanner.ts) matches three raw tokens of the
reset needle `"contextBoundaryKind":"reset"`: the key, the colon and the value. The provider
locator reads the file from the end, so it sees the value first. A three-stage recognizer
(stage 0 → value → 1 → colon → 2 → key → reset) runs over every token it meets, and the state is
kept across the rows of an unreadable run.

We abstract the byte-level regex matching to a token stream (`Tok`) and prove:

* `feed_append`: feeding two segments one after the other equals feeding their concatenation.
  This is the segment/chunk independence the TS code needs (it feeds each row in reverse byte
  segments and keeps state across rows and chunk edges).
* `feed_eq_nil_iff`: the recognizer accepts iff the pattern is a subsequence of the stream
  (greedy subsequence matching is complete).
* `probe_accepts_iff`: on the reversed stream the stage machine accepts iff key, colon, value
  occur in file order, i.e. the reset marker may be fragmented with arbitrary junk in between.
-/

namespace HistoryLocator

/-- Raw tokens the probe distinguishes. `other` is everything else (junk). -/
inductive Tok where
  | key
  | colon
  | value
  | other
  deriving DecidableEq, Repr

/--
Greedy subsequence matcher. `pat` is the remaining pattern; the result is the remaining pattern
after the stream. `[]` means "accepted" (sticky: `feed [] ts = []`).
-/
def feed : List Tok → List Tok → List Tok
  | [], _ => []
  | p :: ps, [] => p :: ps
  | p :: ps, t :: ts => if t = p then feed ps ts else feed (p :: ps) ts

/-- The reverse probe's pattern: tokens in the order a reverse read meets them. -/
def revPattern : List Tok := [.value, .colon, .key]

/-- The reset marker's tokens in file order. -/
def markerPattern : List Tok := [.key, .colon, .value]

theorem revPattern_eq : revPattern = markerPattern.reverse := rfl

@[simp] theorem feed_nil_left (ts : List Tok) : feed [] ts = [] := by
  cases ts <;> rfl

@[simp] theorem feed_nil_right (p : List Tok) : feed p [] = p := by
  cases p <;> rfl

/-- Segment independence: the probe state after `xs ++ ys` is the state after `xs`, then `ys`. -/
theorem feed_append (p xs ys : List Tok) : feed p (xs ++ ys) = feed (feed p xs) ys := by
  induction xs generalizing p with
  | nil => simp
  | cons x xs ih =>
    cases p with
    | nil => simp
    | cons q qs =>
      simp only [List.cons_append, feed]
      split <;> exact ih _

/-- Acceptance is sticky: once the pattern is consumed, more input never un-accepts. -/
theorem feed_accept_mono (p xs ys : List Tok) (h : feed p xs = []) : feed p (xs ++ ys) = [] := by
  rw [feed_append, h, feed_nil_left]

/-- Greedy matching is complete for subsequences. -/
theorem feed_eq_nil_iff (p ts : List Tok) : feed p ts = [] ↔ p.Sublist ts := by
  induction ts generalizing p with
  | nil =>
    simp [List.sublist_nil]
  | cons t ts ih =>
    cases p with
    | nil => simp
    | cons q qs =>
      simp only [feed]
      split
      · rename_i h
        subst h
        rw [ih]
        exact List.cons_sublist_cons.symm
      · rename_i h
        rw [ih]
        constructor
        · intro hs
          exact List.Sublist.cons t hs
        · intro hs
          cases hs with
          | cons _ hs' => exact hs'
          | cons_cons _ _ => exact absurd rfl h

/--
The stage machine over a reverse read accepts iff the marker's tokens occur in file order
(possibly separated by junk, possibly spread over several segments).
-/
theorem probe_accepts_iff (ts : List Tok) :
    feed revPattern ts.reverse = [] ↔ markerPattern.Sublist ts := by
  rw [feed_eq_nil_iff, revPattern_eq, List.reverse_sublist]

end HistoryLocator
