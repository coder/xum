import HistoryLocator.Probe
import HistoryLocator.Spec
import HistoryLocator.Scanner
import HistoryLocator.Chunked

/-!
# Provider history locator: formal model

Model of `findProviderHistoryStart` (src/node/services/historyScanner.ts), the reverse scan
that decides which chat.jsonl rows may reach a model provider. Build with `lake build` in this
directory (Lean 4.34.1, core only).

Main results:

* `Spec.lean`: `specCut` (intended rule), `specCut_greatest` (privacy + maximality),
  `privacy` (row-level), `exhausted_private`.
* `Scanner.lean`: `locate_eq_spec` (streaming locator = rule), `oversized_gap` (the pre-fix
  locator, which ignored oversized rows' local evidence, misses a floor: finding F1).
* `Probe.lean`: `feed_append`, `feed_eq_nil_iff`, `probe_accepts_iff`.
* `Chunked.lean`: `chunkedRows_eq`, `wholeRows_encode`, `chunked_locate_eq`.

Abstraction gaps (checked by src/node/services/historyScanner.formal.test.ts instead):

* Row classes are inputs. The model trusts `classifyHistoryScanRow`, `isManualHistoryReset` and
  the boundary predicates to put each row in the right class.
* The probe works on abstract tokens. The TS regex matches bytes in overlapping windows and
  keeps `SESSION_HISTORY_RESET_PROBE_CHARS - 1` characters of overlap; a token split over a
  window edge is assumed to be matched once. Separator characters are not modeled: `toks` are the
  tokens the TS matcher finds after skipping separators inside and between token characters
  (finding F2 was a token broken by a separator missing from them).
* Oversized compaction boundary recovery is not modeled: an oversized row is `unreadable` or,
  when recovered, `boundary`. The TS re-reads an oversized row whose raw text holds the boundary
  needle in any JSON spelling and lets the classifier decide (finding F3 was a spelling missed).
* An oversized row's `localEv` is computed by a streaming raw probe instead of the classifier;
  the model assumes it equals `hasRawResetMarker` on the whole row.
* Byte offsets are replaced by depths; empty rows are dropped (they change no state).
* `skip` is counted down (`left`) instead of up (`boundaryCount++ === skip`).
* The `visit` stop (status suffix reads) and `includeReadableResetFloor` are out of scope.
-/
