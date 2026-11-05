---
author: @ThomasK33
date: 2026-11-05
---

# Aliases for foreign plugin agents

- **Status:** Draft. Split out of [`20261104_plugin-install-methods.md`](./20261104_plugin-install-methods.md) on 2026-11-05, because its alias design (A1) did not converge in two review rounds.

---

## Overview

Xum names a plugin agent after its file stem, so egm's `design_critic.md` loads as `design_critic`. egm's skills spawn it by its frontmatter `name`, `egm-design`, and egm's synthesizer spawns the scoped form `egm:egm-zoom-out`. Today `task` rejects both. This RFC lets `task` accept those names without changing any stored agent ID.

Until this RFC ships, the `egm-in-xum` skill in `coder/fux-plugins` keeps a table that maps each egm agent name to its file stem.

## Draft design (from the parent RFC, not yet sound)

The text below is the A1 section as it stood when it was split out. It is the starting point, not a decision.

### Draft: agent aliases

The file stem stays the agent's ID. Consent records, consent fingerprints, per-agent settings (`agentAiDefaults`, `subagentAiDefaults`) and the `agentId` saved on child workspaces keep using it. Nothing stored changes, so upgrades and downgrades need no migration.

New: a foreign plugin agent also has aliases, which `task` accepts and turns into the ID.

- **Alias sources.** For a foreign agent of plugin `P` whose frontmatter `name` is `N`: the bare alias `lower(N)` and the scoped alias `P:lower(N)`. Xum-format plugin agents get no aliases. Their `name` is a display name today and stays one.
- **ID first.** `task` looks the requested name up as an ID first, exactly as today. A spawn by ID runs no discovery. The ID lookup has three results. **Found**: the spawn uses it. **Refused**: the ID lookup returns a refusal under the parent RFC's A4 rule, and the spawn returns that refusal without trying aliases. The lookup returns `folder-unreachable` when the first candidate with the ID is unreachable. It returns `not-reviewed`, `ambiguous-file` or `invalid-definition` only when no later scope has the ID, because those candidates are skipped. **Not found**: no agent has that ID. Only on not found, or when the name contains `:`, does Xum build the alias table.
- **Alias table.** Xum builds it from one agent discovery, over the precedence-ordered candidates before deduplication and sorting (see Terms for the order). It reads the `name` of every plugin agent file that discovery parses, before the consent and availability checks. An agent that fails those checks keeps its aliases with its refusal reason, so a spawn by alias returns that reason (A4).
- **Rules.**
  1. An alias equal to its own agent's ID is not an alias. Xum drops it without a refusal.
  2. A bare alias that equals any agent ID in the list, built-ins included, is refused (`alias-refused`). The ID wins. This stops `name: explore` from replacing Xum's Explore agent and from becoming the base of other mapped agents.
  3. When two agents claim one bare alias, the earlier one in precedence order keeps it. The other stays reachable by its scoped alias and its ID. This is the rule skill lookups already use (`src/common/utils/agentSkills/skillLookupName.ts:62-101`).
  4. A scoped alias that two files of one plugin claim is refused for both. This extends the [#6629](https://github.com/coder/xum/issues/6629) rule, which refuses two files that claim one file stem (`src/node/services/agentPlugins/agentFiles.ts:72-96`), to names.
  5. An alias that is not a valid agent ID after lowercasing (for example it contains a space) is dropped.
- **Scoped grammar.** The task input accepts `<plugin>:<agent>`, split at the first `:`. The left half follows the plugin-name rule (which allows `.`), and the right half follows `AgentIdSchema`. This is the parser that skill lookups use (`skillLookupName.ts:12-42`). `AgentIdSchema` itself does not change, so no stored ID can contain `:`.
- **Resolution point.** `TaskService` resolves the name in the step that `Task.create` and `Task.createMany` share, before their `AgentIdSchema` checks (`src/node/services/taskService.ts:8942-8950`, `:6626-6631`). Every later field, `agentType` and the desktop owner included, gets the resolved ID. Best-of recovery compares the resolved ID of the tool input, not its raw text. The `kind: "workspace"` path does not accept aliases: it takes agent modes, not plugin agents. A scoped name passes the shared task input schema and is then refused there with the existing "invalid agentId" error (`src/node/services/workspaceTurnManager.ts:1251-1253`).
- **Task tool description.** Each listed foreign agent shows its aliases that are not refused, from the discovery that already builds the list, for example `- design_critic (also egm-design, egm:egm-design): Architecture and design critic.`
- **Visibility.** The install preview and Settings → Plugins show each agent's ID, aliases and the refusals that depend only on the install: aliases equal to a built-in ID, and scoped aliases that two files of the plugin claim. Refusals that depend on a workspace (project agents, other plugins) appear in the composition inspector and in spawn errors.

### Draft spawn errors

`TaskService` passes `alias-refused` (with its rule and the agent that holds the alias) to the model, in addition to the by-ID refusals that the parent RFC ships in A4 (`not-reviewed`, `ambiguous-file`, `folder-unreachable`, `invalid-definition`).

## Open problems (must be solved before this RFC is proposed)

These come from the parent RFC's second review round (`reaudit_report.md`, R1 to R5).

1. **A scoped alias can start a different agent (Blocker).** The draft turns an alias into the bare file-stem ID, and the spawn then loads the first agent in precedence order with that ID (`src/node/services/agentDefinitions/agentDefinitionsService.ts:981-1068`). With `~/.xum/agents/style.md` present, `egm:egm-style` starts the user's agent, with no error. Options: resolve an alias to an ID plus its source and pin that source (the task reservation already carries `definitionSource`, `src/node/services/taskService.ts:7230`), or refuse the alias as `id-shadowed` when the aliased file does not win its ID.
2. **There is no place to resolve aliases (Blocker).** `Task.create` (`readTaskCreateRequest`, `taskService.ts:8929-8975`) and `Task.createMany` (`resolveReservationAgentId`, `:6623-6640`) check the name in two separate synchronous steps. Both run before the parent runtime and workspace path are loaded, and `create` runs its check before the mutex. Alias lookup needs the runtime, the workspace path and `projectPluginsTrusted`, which exist only later (`checkTaskAgentRunnable`, `:9278-9287`). The raw name also feeds `agentType`, the desktop owner and the reservation snapshot (`:8957-8962`, `:6521`, `:7067`, `:7163`). This needs a decision about lock order and about where the spawn path takes ownership of the resolved ID.
3. **Best-of recovery cannot resolve an alias.** `readPendingBestOfRequest` and `matchConfigBestOfRow` are synchronous by design (`taskService.ts:3450-3504`, invariant at `:22355`).
4. **The skill lookup parser rejects agent IDs with `_`.** Its right half uses `SkillNameSchema` (`src/common/orpc/schemas/agentSkill.ts:12-16`).
5. **Scoped aliases of two plugins with the same name in different sources have no rule.** Trusted project content can also capture bare aliases.
6. **Shape changes break unlisted files.** Changing the preview's `agents` field from file names to objects breaks stories, `installService*.test.ts` assertions and `tests/bugbash/pluginInstallFixtures.test.ts`.

## Rejected alternative carried over

### Frontmatter `name` as the stored agent ID

- **Mechanism**: A foreign plugin agent's ID becomes its lowercased `name` instead of its file stem.
- **Pros**: One name per agent. It matches Claude Code's naming.
- **Cons**: Consent records and fingerprints, per-agent settings and the `agentId` on child workspaces all use the ID. Changing it means every installed foreign agent needs a new review, and saved settings stop applying. After a downgrade, saved child workspaces hold IDs that the older build cannot find. Xum then falls back to `exec` with every tool on turns that do not fail closed (`src/node/services/agentResolution.ts:387-403`).
- **Reason for Rejection**: Decided by: author (delegated). Aliases (A1) give the same spawn names with no stored-state change.

## Draft file plan (from the parent RFC, advisory)

### Aliases (was PR 2 of the parent RFC)

1. `src/node/services/agentDefinitions/pluginAgentAliases.ts` (Create)
   - `buildAgentAliasTable(candidates: AliasCandidate[]): AliasTable`. The input is the precedence-ordered list of every parsed agent file, each with its ID, plugin name, foreign flag, `name` and refusal reason (if any).
   - `AliasTable.resolve(ref)` returns `{ kind: "alias", id }`, `{ kind: "refused", reason, rule, holder? }` or `{ kind: "unknown" }`.
   - It applies rules 1 to 5 of A1. It asserts that every returned ID exists in the input.
2. `src/node/services/agentDefinitions/pluginAgentAliases.test.ts` (Create): every rule, that a Xum-format plugin agent gets no aliases, the scoped grammar with a `.` in the plugin name, and that an ID always takes precedence over an alias.
3. `src/common/orpc/schemas/agentDefinition.ts` (Modify): the descriptor gains `aliases?: string[]` (aliases that are not refused).
4. `src/node/services/agentDefinitions/agentDefinitionsService.ts` (Modify)
   - A new `discoverAliasCandidates` returns the precedence-ordered candidates before deduplication and sorting (`:775-796`), including files that fail consent, availability or the #6629 check, with their reason.
   - `discoverAgentDefinitions` fills `aliases` on foreign plugin descriptors from the same table.
   - `loadAgentDefinition` records `not-reviewed` and `ambiguous-file` refusals of plugin candidates on the PR 1 channel.
5. `src/node/services/agentPlugins/agentFiles.ts` (Modify): expose the file-stem ambiguity result per file, so the alias table can mark `ambiguous-file`.
6. `src/common/utils/tools/toolDefinitions.ts` (Modify): `TaskAgentIdSchema` and `SubagentTypeSchema` accept an agent ID or a scoped alias, parsed with the skill lookup parser (`src/common/utils/agentSkills/skillLookupName.ts`), after the same trim and lowercase.
7. `src/common/utils/tools/toolDefinitions.test.ts` (Modify): the scoped form parses, including a plugin name with `.`. Empty halves and a second `:` are rejected.
8. `src/node/services/taskService.ts` (Modify)
   - In the step that `Task.create` and `Task.createMany` share, before the `AgentIdSchema` checks (`:8942-8950`, `:6626-6631`): look the name up as an ID with `resolveAgentFrontmatter`. A `PluginAgentRefusalError` is returned as is. Only when the lookup reports not found, or the name contains `:`, run `discoverAliasCandidates` once and resolve through the alias table.
   - `agentType` and the desktop owner (`:8958`, `:8961`) get the resolved ID.
   - Best-of group recovery (`:3467-3504`) compares the resolved ID of the tool input.
   - Map each refusal to its `Task.create:` error text.
9. `src/node/services/taskService.pluginAgents.test.ts` (Modify): spawns by bare and by scoped alias that store the file-stem ID, the `alias-refused` error and the by-ID refusals that an alias carries, and best-of recovery by alias, through `TaskService.create` and `createMany`.
10. `src/node/services/tools/task.ts` (Modify): `buildTaskDescription` prints each foreign agent's `aliases`.
11. `src/node/services/tools/task.test.ts` (Modify): the description shows aliases and leaves refused ones out.
12. `src/common/orpc/schemas/agentPlugins.ts` (Modify): the preview's `agents` field becomes a list of `{ file, id, aliases, refusedAliases }`. `readonlyAgents` matches on `file`.
13. `src/node/services/agentPlugins/installService.ts` (Modify): the preview's agent rows (`:3954-3958`) carry the ID, aliases and the install-only refusals (rule 2 against built-in IDs, rule 4 inside the plugin).
14. `src/browser/features/Settings/Sections/PluginsSettingsSection.tsx` (Modify): show each agent as `ID (aliases)` and each refused alias with its rule.
15. `src/browser/features/Settings/Sections/PluginsSettingsSection.reviewText.test.tsx` (Modify): the agent row text.
16. `src/node/services/agentPlugins/composition.ts` and `src/node/services/agentPlugins/composition.test.ts` (Modify): the composition inspector lists aliases and every refusal, including those caused by project agents and other plugins.
17. `docs/agents/index.mdx` (Modify): how plugin agents are named, the scoped form and the alias rules. Then regenerate the built-in skill content.

---

_Drafted with EGM_
