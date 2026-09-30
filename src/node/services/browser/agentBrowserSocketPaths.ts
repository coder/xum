import * as os from "node:os";
import * as path from "node:path";

const WINDOWS_DYNAMIC_PORT_START = 49152;
const WINDOWS_DYNAMIC_PORT_RANGE = 16383;

export function getAgentBrowserSocketDir(env: NodeJS.ProcessEnv): string {
  const override = env.AGENT_BROWSER_SOCKET_DIR?.trim();
  if (override) {
    return override;
  }

  const xdgRuntimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (xdgRuntimeDir) {
    return path.join(xdgRuntimeDir, "agent-browser");
  }

  const homeDir = env.HOME?.trim();
  if (homeDir) {
    return path.join(homeDir, ".agent-browser");
  }

  const tmpDir = env.TMPDIR?.trim();
  return path.join(tmpDir ?? os.tmpdir(), "agent-browser");
}

export function getAgentBrowserSocketPath(env: NodeJS.ProcessEnv, sessionName: string): string {
  return path.join(getAgentBrowserSocketDir(env), `${sessionName}.sock`);
}

export function getAgentBrowserPortPath(env: NodeJS.ProcessEnv, sessionName: string): string {
  return path.join(getAgentBrowserSocketDir(env), `${sessionName}.port`);
}

export function getAgentBrowserPortForSession(sessionName: string): number {
  let hash = 0;
  for (const char of sessionName) {
    const charCode = char.codePointAt(0);
    if (charCode == null) {
      continue;
    }
    hash = (Math.imul(hash, 31) + charCode) | 0;
  }

  return WINDOWS_DYNAMIC_PORT_START + (Math.abs(hash) % WINDOWS_DYNAMIC_PORT_RANGE);
}
