/**
 * XUM_DISABLE_AGENT_TOOLS=1: no agent turn sends tools to the model, whatever agent, project
 * file or plugin assembled them. The bug-bash app's real-AI mode (tests/bugbash/startApp.ts)
 * sets it, because there a real model answers in an app that runs on the host.
 *
 * TurnRequestBuilder drops the tools before prompt assembly, so the prompt and every context
 * budget see the request that is sent. StreamManager also drops them at the streamText call, the
 * boundary every turn passes, so no other caller can send them.
 */
export function isAgentToolsDisabled(): boolean {
  return process.env.XUM_DISABLE_AGENT_TOOLS === "1";
}
