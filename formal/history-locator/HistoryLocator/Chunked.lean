import HistoryLocator.Scanner

/-!
# Chunk-boundary independence

`findProviderHistoryStart` reads chat.jsonl backwards in `SESSION_HISTORY_SCAN_CHUNK_BYTES`
chunks. Inside a chunk it walks newline positions backwards, `add`s the bytes between two
newlines to the row being assembled (`parts`) and `deliver`s the row at each newline; the partial
row at a chunk's start is carried into the next (earlier) chunk.

We model the byte stream with a newline symbol, and the row assembly as one step per byte over
the reversed file. Then:

* `foldl_segment`: `add`ing a newline-free segment in one call equals feeding its bytes one by
  one, so the TS segment loop is an instance of this per-byte model.
* `chunkedRows_eq`: for every chunk size `k > 0`, the rows delivered by the chunked reader equal
  the rows of a whole-file read.
* `wholeRows_encode`: on a well-formed file (each row followed by a newline) the reader delivers
  exactly the rows, newest first, after one empty row for the final newline (which `deliver`
  ignores: `size === 0`).
* `chunked_locate_eq`: hence the located start does not depend on the chunk size, for any
  per-row classifier applied to whole-row bytes (the TS concatenates `parts` before classifying,
  and feeds the reverse probe segment by segment, which `feed_segments` shows is the same).
-/

namespace HistoryLocator

inductive Sym where
  | nl
  | byte (b : Nat)
  deriving DecidableEq, Repr

structure Asm where
  /-- Delivered rows, in delivery order (newest first). -/
  rows : List (List Nat)
  /-- The row being assembled, in file order (`parts` reversed and concatenated). -/
  cur : List Nat

def step (s : Asm) : Sym → Asm
  | .nl => ⟨s.rows ++ [s.cur], []⟩
  | .byte b => ⟨s.rows, b :: s.cur⟩

/-- The final `deliver(0)` at the start of the file. -/
def Asm.finish (s : Asm) : List (List Nat) := s.rows ++ [s.cur]

def wholeRows (file : List Sym) : List (List Nat) :=
  (file.reverse.foldl step ⟨[], []⟩).finish

-- `h` is used by `decreasing_by`; the linter does not see that use.
set_option linter.unusedVariables false in
/-- Split the reversed file into reads of `k` symbols: `[end - k, end)`, then the chunk before. -/
def chunks (k : Nat) (hk : 0 < k) (xs : List Sym) : List (List Sym) :=
  if h : xs = [] then [] else xs.take k :: chunks k hk (xs.drop k)
termination_by xs.length
decreasing_by
  simp only [List.length_drop]
  have : 0 < xs.length := List.length_pos_iff.2 h
  omega

theorem chunks_flatten (k : Nat) (hk : 0 < k) (xs : List Sym) :
    (chunks k hk xs).flatten = xs := by
  induction xs using WellFounded.induction (measure List.length).wf with
  | h xs ih =>
    rw [chunks]
    split
    · rename_i h; subst h; rfl
    · rename_i h
      simp only [List.flatten_cons]
      have hlt : (xs.drop k).length < xs.length := by
        have : 0 < xs.length := List.length_pos_iff.2 h
        simp only [List.length_drop]
        omega
      rw [ih (xs.drop k) hlt]
      exact List.take_append_drop k xs

/-- The chunked reader: each chunk is walked backwards, state carried across chunk edges. -/
def chunkedRows (k : Nat) (hk : 0 < k) (file : List Sym) : List (List Nat) :=
  ((chunks k hk file.reverse).foldl (fun (s : Asm) (ch : List Sym) => ch.foldl step s)
    (⟨[], []⟩ : Asm)).finish

theorem chunkedRows_eq (k : Nat) (hk : 0 < k) (file : List Sym) :
    chunkedRows k hk file = wholeRows file := by
  unfold chunkedRows wholeRows
  rw [← List.foldl_flatten, chunks_flatten]

/-- A newline-free segment, walked backwards, is prepended to the row: `add(segment)`. -/
theorem foldl_segment (seg : List Nat) (rows : List (List Nat)) (cur : List Nat) :
    ((seg.map Sym.byte).reverse.foldl step ⟨rows, cur⟩) = ⟨rows, seg ++ cur⟩ := by
  induction seg generalizing cur with
  | nil => rfl
  | cons b seg ih =>
    simp only [List.map_cons, List.reverse_cons, List.foldl_append, ih]
    rfl

/-- A file whose every row is followed by a newline. -/
def encode (rows : List (List Nat)) : List Sym :=
  (rows.map fun r => r.map Sym.byte ++ [Sym.nl]).flatten

theorem foldl_blocks (L : List (List Nat)) (rows : List (List Nat)) (cur : List Nat) :
    ((L.map fun r => Sym.nl :: (r.map Sym.byte).reverse).flatten.foldl step ⟨rows, cur⟩).finish =
      rows ++ cur :: L := by
  induction L generalizing rows cur with
  | nil => simp [Asm.finish]
  | cons r L ih =>
    simp only [List.map_cons, List.flatten_cons, List.foldl_append, List.foldl_cons]
    simp only [step]
    rw [foldl_segment, List.append_nil, ih]
    simp

theorem encode_reverse (rows : List (List Nat)) :
    (encode rows).reverse = (rows.reverse.map fun r => Sym.nl :: (r.map Sym.byte).reverse).flatten := by
  induction rows with
  | nil => rfl
  | cons r rs ih =>
    simp only [encode, List.map_cons, List.flatten_cons, List.reverse_append] at ih ⊢
    rw [ih]
    simp

/-- A well-formed file is read as its rows, newest first (after the empty EOF row). -/
theorem wholeRows_encode (rows : List (List Nat)) :
    wholeRows (encode rows) = [] :: rows.reverse := by
  unfold wholeRows
  rw [encode_reverse, foldl_blocks]
  rfl

/-- The reverse probe fed a row segment by segment equals the probe over the whole row. -/
theorem feed_segments (p : List Tok) (segs : List (List Tok)) :
    segs.foldl feed p = feed p segs.flatten := by
  induction segs generalizing p with
  | nil => simp
  | cons s segs ih => simp [List.foldl_cons, ih, feed_append]

/-- **Chunk-boundary independence of the located start.** For any classifier of whole-row bytes
(empty rows dropped, as `deliver` does), every chunk size gives the whole-file answer. -/
theorem chunked_locate_eq (classify : List Nat → Row) (skip k : Nat) (hk : 0 < k)
    (file : List Sym) :
    locate skip (((chunkedRows k hk file).filter (· ≠ [])).map classify) =
      locate skip (((wholeRows file).filter (· ≠ [])).map classify) := by
  rw [chunkedRows_eq]

/-- On a well-formed file the locator sees exactly the non-empty rows, newest first. -/
theorem encode_locate (classify : List Nat → Row) (skip : Nat) (rows : List (List Nat)) :
    locate skip (((wholeRows (encode rows)).filter (· ≠ [])).map classify) =
      locate skip ((rows.reverse.filter (· ≠ [])).map classify) := by
  rw [wholeRows_encode]
  simp

end HistoryLocator
