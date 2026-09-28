#!/usr/bin/env bash
# CI unit-test runner (moved out of .github/workflows/pr.yml so the workflow stays
# declarative and the logic is runnable locally via `make test-unit-ci`).
#
# Sharding: CI fans the unit suite out across SHARD_TOTAL runners. A single
# `bun test --max-concurrency=1` process over every file was the CI critical path
# (~15 min on the 16-core runner while the rest of the pipeline finished in ~11),
# so each shard runs a size-balanced slice of the files in its own process.
#
# Usage: SHARD_INDEX=<1..N> SHARD_TOTAL=<N> ./scripts/test-unit-ci.sh [--list | --list-all]
#        (defaults to 1/1, i.e. the whole suite in one shard)
#        --list      prints this shard's shared-process files
#        --list-all  prints every file this lane runs (isolated, tooling and shared)
#                    across all shards; consumed by scripts/check-test-routing.sh
set -euo pipefail

mode="${1:-}"
if [[ "$mode" == "--list-all" ]]; then
  SHARD_INDEX=1
  SHARD_TOTAL=1
fi

SHARD_INDEX="${SHARD_INDEX:-1}"
SHARD_TOTAL="${SHARD_TOTAL:-1}"
if ! [[ "$SHARD_INDEX" =~ ^[0-9]+$ && "$SHARD_TOTAL" =~ ^[0-9]+$ ]] \
  || ((SHARD_TOTAL < 1 || SHARD_INDEX < 1 || SHARD_INDEX > SHARD_TOTAL)); then
  echo "Invalid shard ${SHARD_INDEX}/${SHARD_TOTAL}" >&2
  exit 2
fi

isolated_unit_tests=(
  # QuickJS-heavy tests can crash or lose runtime callbacks under Bun coverage
  # when sharing the monolithic process; keep them in fresh isolated processes.
  src/node/services/workflows/WorkflowRunner.test.ts
  # The evaluate() lifecycle suites run a QuickJS workflow per case (~40 runtimes);
  # the shared process segfaulted Bun twice on the same head with them included.
  src/node/services/workflows/WorkflowRunner.evaluate.test.ts
  src/node/services/workflows/WorkflowService.evaluate.test.ts
  src/node/services/ptc/quickjsRuntime.test.ts
  src/node/services/tools/code_execution.test.ts
  # This suite also creates QuickJS runtimes. Shared coverage can trap during startup.
  src/node/services/tools/code_execution.integration.test.ts
  src/node/services/sandbox/sandboxHostService.test.ts
  src/node/services/agentPlugins/hookService.test.ts
  src/node/orpc/router.test.ts
  # In the shared monolithic process on CI runners this file can enter an
  # infinite 'Maximum update depth exceeded' render loop (timing/coverage
  # sensitive; also seen on main and sibling branches) that spews ~1GB of
  # warnings until the 15-minute job timeout. Passes reliably in isolation
  # and could not be reproduced locally even with the exact CI file order,
  # bun version, and coverage flags.
  src/browser/components/CommandPalette/CommandPalette.prompt.test.tsx
  # Its tooltip test asserts Radix portal content, and Radix tooltip module
  # state binds to the first document that mounted a TooltipProvider in the
  # process — any earlier test file rendering a tooltip (raw happy-dom swap
  # or installDom alike) makes the portal land in a stale document. Verified
  # order-dependent on origin/main; only reliable in its own process.
  src/browser/features/RightSidebar/Memory/MemoryTab.test.tsx
  # Its "last prompt" popup tests fail when any earlier test file in the
  # shared process evaluated UI modules without a DOM installed (Radix's
  # use-layout-effect binds to `globalThis.document` at module eval, so a
  # DOM-less first import caches the broken no-op mode process-wide).
  # Verified order-dependent on origin/main via a two-file repro; only
  # reliable in its own process. Took the merge queue down on 2026-08-29
  # when runner file enumeration order changed.
  src/browser/components/ChatPane/WorkspaceFooterBar.test.tsx
  # Post-login catalog refreshes can outlive their test and hit a later global fetch mock,
  # making catalog-call assertions order-dependent in the shared process.
  src/node/services/coderOauthService.test.ts
  # Loads the native sharp/libvips addon into the test process. In the shared
  # coverage process Bun hit an allocator panic ("pas panic: deallocation did
  # fail", exit 133) as this file started on main run 35782976621, with zero
  # failing assertions; isolation gets it the signal-exit retry below.
  src/node/services/mcpIconDecodeClient.test.ts
  # Its Discard-shortcut tests fail after a combination of earlier files in the shared
  # process (order-dependent; passes alone). Isolated until the polluter is found and
  # fixed; then move it back (#5084).
  src/browser/features/Messages/HeldInput.test.tsx
  # Guards the DOM harness itself by deliberately poisoning process globals
  # (document/window set to undefined, a replaced baseline window), which would
  # perturb later suites in a shared process.
  ./tests/ui/domIsolation.test.ts
)

# One process per file rather than one shared isolated process. Sharing it still
# segfaults Bun on the runner (exit 132, "Bun has crashed", zero failing assertions)
# while leaving the file transition as the only suspect, and these files are already
# here because they do not survive sharing a process.
# Bun can also crash at teardown after every test passed (e.g. exit 132).
# Retry only signal exits (>= 128); genuine test failures exit 1.
# Isolated files are spread round-robin across shards.
# The shared-process shards use the same retry: a shard hit "Bun has crashed" (exit 132,
# segfault) with no failing assertion on PR #4351, just as the isolated files do.
#
# Stall watchdog (#4957): a merge-queue shard printed nothing for 17 minutes in the
# middle of src/node/orpc/server.test.ts until GitHub cancelled the step. Bun's own
# per-test timeout never fired. It does fire for a pending promise, so the process
# itself was stuck (a blocked JS thread or a native hang), and `bun test --timeout`
# cannot catch that. Healthy shards never go quiet for longer than their slowest
# single test (~11 s in CI), so BUN_TEST_STALL_SECS of silence means a hang: name the
# file and last test, dump the process state for diagnosis, and SIGKILL it (with any
# children, which the stuck process cannot tear down itself) so the
# signal-exit retry below handles it like a crash.
BUN_TEST_STALL_SECS="${BUN_TEST_STALL_SECS:-180}"
# Stop each process before listing its children so none can fork or be reparented
# away mid-walk, then kill the subtree bottom-up. A process group would also work,
# but job control would detach Bun from the terminal's Ctrl-C for local runs.
kill_process_tree() {
  local child
  kill -STOP "$1" 2>/dev/null || true
  for child in $(pgrep -P "$1" || true); do
    kill_process_tree "$child"
  done
  kill -KILL "$1" 2>/dev/null || true
}
bun_test_with_stall_watchdog() {
  local out pid size last_size=-1 quiet=0 exit_code=0
  out=$(mktemp)
  bun test --max-concurrency=1 "$@" > >(tee "$out") 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    size=$(wc -c <"$out")
    if [[ "$size" -ne "$last_size" ]]; then
      last_size=$size
      quiet=0
      continue
    fi
    quiet=$((quiet + 1))
    if ((quiet >= BUN_TEST_STALL_SECS)); then
      echo "::error::bun test printed nothing for ${BUN_TEST_STALL_SECS}s; killing it (pid $pid). Last file and output:"
      grep -E '^(##\[group\])?[^ ]+\.test\.tsx?:$' "$out" | tail -n 1 || true
      tail -n 2 "$out"
      if [[ -r "/proc/$pid/status" ]]; then
        # Distinguishes a busy JS thread (State R, CPU ticks rising) from a deadlock
        # (State S, threads parked in futex_wait) or memory pressure.
        grep -E '^(State|VmRSS|Threads):' "/proc/$pid/status" || true
        echo "utime+stime ticks: $(awk '{print $14 + $15}' "/proc/$pid/stat")"
        sleep 2
        echo "utime+stime ticks after 2s: $(awk '{print $14 + $15}' "/proc/$pid/stat")"
        echo "thread wait channels:"
        for task in /proc/"$pid"/task/*; do
          cat "$task/wchan" 2>/dev/null || true
          echo
        done | sort | uniq -c
        free -m || true
      fi
      kill_process_tree "$pid"
      break
    fi
  done
  wait "$pid" || exit_code=$?
  rm -f "$out"
  return "$exit_code"
}

bun_test_retrying_crashes() {
  local label=$1 attempt exit_code
  shift
  for attempt in 1 2 3; do
    exit_code=0
    bun_test_with_stall_watchdog "$@" || exit_code=$?
    if [[ "$exit_code" -eq 0 ]]; then
      return 0
    fi
    if [[ "$exit_code" -lt 128 || "$attempt" -eq 3 ]]; then
      exit "$exit_code"
    fi
    echo "bun crashed (exit $exit_code) on $label, retrying (attempt $attempt of 3)..."
  done
}

for i in "${!isolated_unit_tests[@]}"; do
  [[ -z "$mode" ]] || break
  ((i % SHARD_TOTAL == SHARD_INDEX - 1)) || continue
  bun_test_retrying_crashes "${isolated_unit_tests[$i]}" "${isolated_unit_tests[$i]}"
done

# Derive the exclusions from isolated_unit_tests so the two lists cannot
# drift. A hand-maintained duplicate list previously desynced: the QuickJS-heavy
# sandboxHostService.test.ts ran a second time inside this shared coverage
# process and segfaulted Bun mid-suite (merge-queue runs 32666269009 and
# 32667158072), kicking a fully green PR out of the queue.
find_excludes=()
for isolated_unit_test in "${isolated_unit_tests[@]}"; do
  find_excludes+=(! -path "$isolated_unit_test")
done

# Bun-run test trees outside src/ (Jest ignores them, see jest.config.js): Storybook
# policy tests, the VS Code extension's pure helpers (incl. the webview oRPC allowlist
# guard) and tooling tests under scripts/. check-startup-imports.test.ts and
# check-test-seam-comments.test.ts are excluded because their static-check make
# targets run them right before the guard itself; orpcConnection.integration.test.ts
# needs a live xum server (see scripts/check-test-routing.sh for every file run
# outside this lane).
#
# Paths outside bunfig's `root = "src"` need a ./ prefix (here and in
# isolated_unit_tests): without it `bun test` treats them as name filters over src/
# and runs nothing. They run in one extra process on shard 1, never inside the shared
# src shards: a single ./ path switches `bun test` from filter mode (files run in
# bun's own traversal order) to path mode (argument order), which reorders the whole
# shard and exposed order-dependent module mocks that the usual order hides.
tooling_roots=(./tests/ui/storybook ./vscode/src ./scripts)
tooling_files=()
while IFS= read -r tooling_file; do
  tooling_files+=("$tooling_file")
done < <(
  find "${tooling_roots[@]}" -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) \
    ! -path ./scripts/check-startup-imports.test.ts \
    ! -path ./scripts/check-test-seam-comments.test.ts \
    ! -path ./vscode/src/api/orpcConnection.integration.test.ts \
    "${find_excludes[@]}" | LC_ALL=C sort
)
if [[ -z "$mode" ]] && ((SHARD_INDEX == 1 && ${#tooling_files[@]} > 0)); then
  bun_test_retrying_crashes "tooling tests" "${tooling_files[@]}"
fi

# Deterministic, size-balanced split: largest files first, each assigned to the
# currently lightest shard (file size is a cheap proxy for runtime). Every shard
# computes the same assignment, so the union of shards is exactly the full suite.
# Kept portable to macOS (Bash 3.2 has no mapfile; BSD find has no -printf) so shards
# reproduce locally; LC_ALL=C keeps the tie-break order identical across machines.
unit_files=()
while IFS= read -r unit_file; do
  unit_files+=("$unit_file")
done < <(
  find src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) \
    "${find_excludes[@]}" -exec wc -c {} + \
    | awk '$2 != "total"' \
    | LC_ALL=C sort -k1,1nr -k2,2 \
    | awk -v total="$SHARD_TOTAL" -v shard="$SHARD_INDEX" '
      {
        best = 1
        for (s = 2; s <= total; s++) if (load[s] < load[best]) best = s
        load[best] += $1
        path = $0
        sub(/^[ \t]*[0-9]+[ \t]+/, "", path)
        if (best == shard) print path
      }'
)

# --list prints this shard's shared-process files, e.g. to reproduce a shard locally.
if [[ "$mode" == "--list" ]]; then
  if ((${#unit_files[@]} > 0)); then
    printf '%s\n' "${unit_files[@]}"
  fi
  exit 0
fi
if [[ "$mode" == "--list-all" ]]; then
  printf '%s\n' "${isolated_unit_tests[@]}" "${tooling_files[@]}" "${unit_files[@]}"
  exit 0
fi

echo "Unit shard ${SHARD_INDEX}/${SHARD_TOTAL}: ${#unit_files[@]} shared-process files"
if ((${#unit_files[@]} == 0)); then
  exit 0
fi
bun_test_retrying_crashes "unit shard ${SHARD_INDEX}/${SHARD_TOTAL}" \
  --coverage --coverage-reporter=lcov "${unit_files[@]}"
