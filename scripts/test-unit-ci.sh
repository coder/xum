#!/usr/bin/env bash
# CI unit-test runner (moved out of .github/workflows/pr.yml so the workflow stays
# declarative and the logic is runnable locally via `make test-unit-ci`).
#
# Sharding: CI fans the unit suite out across SHARD_TOTAL runners. A single
# `bun test --max-concurrency=1` process over every file was the CI critical path
# (~15 min on the 16-core runner while the rest of the pipeline finished in ~11),
# so each shard runs a size-balanced slice of the files in its own process.
#
# Usage: SHARD_INDEX=<1..N> SHARD_TOTAL=<N> ./scripts/test-unit-ci.sh
#        (defaults to 1/1, i.e. the whole suite in one shard)
set -euo pipefail

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
  src/browser/components/WorkspaceHeartbeatModal/WorkspaceHeartbeatModal.test.tsx
  src/browser/features/Messages/InlineSkillMarkdown.test.tsx
  src/browser/hooks/useChatTranscriptFullWidth.test.tsx
  src/browser/utils/commands/sources.test.ts
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
  # Its file-scope mock.module overlays WorkspaceStore's subscribeDerived with a local
  # listener set, and Bun keeps module mocks for every later file in the process:
  # ModelsSection.discovery.test.tsx then times out on every test when it runs after
  # this file (reproduced with a two-import file). Surfaced by a shard reshuffle on #4469.
  src/browser/features/RightSidebar/Workflows/WorkflowTimeline.test.tsx
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
bun_test_retrying_crashes() {
  local label=$1 attempt exit_code
  shift
  for attempt in 1 2 3; do
    exit_code=0
    bun test --max-concurrency=1 "$@" || exit_code=$?
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
  [[ "${1:-}" != "--list" ]] || break
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
if [[ "${1:-}" == "--list" ]]; then
  if ((${#unit_files[@]} > 0)); then
    printf '%s\n' "${unit_files[@]}"
  fi
  exit 0
fi

echo "Unit shard ${SHARD_INDEX}/${SHARD_TOTAL}: ${#unit_files[@]} shared-process files"
if ((${#unit_files[@]} == 0)); then
  exit 0
fi
bun_test_retrying_crashes "unit shard ${SHARD_INDEX}/${SHARD_TOTAL}" \
  --coverage --coverage-reporter=lcov "${unit_files[@]}"
