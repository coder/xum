/**
 * XUM_DISABLE_AGENT_TOOLS=1: no agent turn (chat, sub-agent or workflow agent) sends tools to the
 * model, whatever agent, project file or plugin assembled them. The bug-bash app's real-AI mode
 * (tests/bugbash/startApp.ts) sets it, because there a real model answers in an app that runs on
 * the host.
 *
 * TurnRequestBuilder drops the tools before prompt assembly, so the prompt and every context
 * budget see the request that is sent. StreamManager also drops them at its streamText call, the
 * boundary every agent turn passes.
 *
 * Scope: callers that call streamText themselves with their own tools do not check this flag:
 * refinement/refineRunner.ts, memoryHarvest.ts, memoryIntuition.ts and
 * continuousCompactionSummary.ts (plugin `request.assemble` tools). None of them runs shell
 * commands in the seeded bug-bash app.
 */
export function isAgentToolsDisabled(): boolean {
  return process.env.XUM_DISABLE_AGENT_TOOLS === "1";
}
