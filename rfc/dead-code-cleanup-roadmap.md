# Dead Code Cleanup Roadmap

## Objective

Remove confirmed dead code from the repository while preserving entrypoints, Storybook stories, public/shared schemas, and test-only helpers that are intentionally exported.

## Detection Sources

- `make check-deadcode` (`ts-prune` with repository filters) is the primary signal.
- Follow-up `rg`/import checks are required before removing anything because `ts-prune` reports known false positives for:
  - Storybook `*.stories.tsx` exports.
  - schema/type barrels used across IPC, oRPC, generated docs, or runtime validation.
  - public package/extension exports and dynamically loaded smoke/debug entrypoints.

## Current Progress

- [x] Ran initial repository dead-code scan.
- [x] Identified noisy false-positive clusters: Storybook stories, `src/common/orpc/schemas.ts`, `src/common/config/schemas/index.ts`, and type/schema barrels.
- [x] Investigated filtered non-story findings with repo-wide callsite checks.
- [x] Removed confirmed-unused symbols/files in small reviewable batches.
- [x] Reran `make check-deadcode` and documented remaining intentional findings.
- [x] Ran `make typecheck` after removals.
- [ ] Run final validation (`make static-check`) before declaring the cleanup complete.

## Removed in This Cleanup

- Browser: unused compatibility/test helpers, unused vim helpers, unused settings barrel/type aliases, unused message-list hook, unused concurrent-warning wrapper, unused error component, unused slash-command re-export, unused browser bridge type, and unused Storybook helper functions.
- Common: unused worktree archive helper, cursor/ID type aliases, image-thumbnail alias, and language display-name helper/map.
- Node/runtime: unused auth cookie wrapper, devcontainer exec/container helpers, SSH prompt getter, stream process helper file, compatibility runtime type alias, transport barrel type re-exports, built-in skill cache reset helper, browser discovery status alias, stream chunk event alias, and unused config tool exports/read helper.

## Remaining `make check-deadcode` Findings Reviewed as Intentional / False Positive

- Dynamic/public entrypoints:
  - `src/desktop/attachFileSmokeTest.ts` — loaded dynamically by `src/desktop/main.ts` for attach-file smoke tests.
  - `src/vite/novncCompatPlugin.ts` — imported and invoked by `vite.config.ts`.
  - `src/browser/contexts/ChatHostContext.tsx` — public chat-components/VS Code webview API.
  - `src/node/utils/extensionMetadata.ts` — imported by the VS Code package through the `mux/node/...` package path.
- Barrel exports with live consumers that `ts-prune` misses or reports noisily:
  - `src/common/routing/index.ts` — consumed by browser hooks/settings and node services.
  - `src/browser/components/WorkspaceHeartbeatModal/index.ts` — consumed by workspace UI components.
  - `src/node/runtime/transports/index.ts` — consumed by runtime code, services, and tests.
  - `src/browser/features/RightSidebar/BrowserTab/index.ts`, `DevToolsTab/index.ts`, and `Tabs/index.ts` — consumed by right-sidebar registry/sidebar code.
- Tool/parser artifacts:
  - `src/browser/utils/runtimeUi.ts: Partial` — TypeScript utility type syntax, not an export.
  - `satisfies`, `Record`, `Readonly` entries in schema/config files — TypeScript syntax artifacts.
- Intentional entrypoints:
  - Storybook story exports (`*.stories.tsx`) are discovered by Storybook/Pixel.
  - Shared schema barrels (`src/common/orpc/schemas.ts`, `src/common/config/schemas/index.ts`) are API/schema surfaces and contain many type-only false positives.

## Completion Criteria

The cleanup is complete when:

1. No remaining filtered `make check-deadcode` finding is confirmed removable after repo-wide callsite review.
2. `make typecheck` passes.
3. `make static-check` passes, or any blocker is documented with exact failure output.
