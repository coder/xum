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
 * refinement/refineRunner.ts, memoryHarvest.ts and continuousCompactionSummary.ts (plugin `request.assemble` tools). None of them runs shell
 * commands in the seeded bug-bash app.
 */
export function isAgentToolsDisabled(): boolean {
  return process.env.XUM_DISABLE_AGENT_TOOLS === "1";
}

/**
 * XUM_DISABLE_TERMINALS=1: no terminal starts and no input reaches one (TerminalService), and no
 * Cursor command hook starts a process (cursorHookRunner.ts). The bug-bash app's real-AI mode sets
 * it, because an explorer model that follows injected text could otherwise reach a host shell.
 */
export function isTerminalsDisabled(): boolean {
  return process.env.XUM_DISABLE_TERMINALS === "1";
}
