/**
 * Host processes and network calls of agent-loop code (phase 5): the git spawns of
 * skillsCatalogFetch.ts and of the bash tool's repo-automation probe (gitNoHooksEnv.ts), and the
 * catalog search fetch. The import lint (local/no-host-imports) cannot see these calls, because
 * execFileAsync and the global fetch are not host modules. Tests pass the scripted layer
 * (scriptedCommands.testHarness.ts), which runs no process and opens no socket.
 *
 * Add a member only when a moved caller needs it. Type-only imports keep this module free of
 * runtime dependencies, so di/tags.ts can import it without a cycle.
 */
import type { ExecFileAsyncOptions } from "@/node/utils/disposableExec";

/** What execFileAsync returns, as its callers use it: `using proc = ...; await proc.result`. */
export interface HostProcess extends Disposable {
  /** Resolves on exit 0. Rejects like execFileAsync: an Error with code, signal, stdout, stderr. */
  readonly result: Promise<{ stdout: string; stderr: string }>;
}

export interface HostProcesses {
  /** Spawns `file` with `args`, without a shell (execFileAsync, utils/disposableExec.ts). */
  execFile(file: string, args: string[], options?: ExecFileAsyncOptions): HostProcess;
  /**
   * The global fetch, for the URL strings that the callers build. Not named `fetch`, so that
   * `rg '\bfetch\('` over the tools finds only direct calls of the global (phase 5 end check).
   */
  fetchUrl(url: string, init?: RequestInit): Promise<Response>;
}
