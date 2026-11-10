import { describe, expect, test } from "bun:test";
import type { ProjectConfig } from "@/common/types/project";
import { Err, Ok, type Result } from "@/common/types/result";
import { subscribeProjectTrustChanged } from "@/browser/utils/workspaceMcpMutations";
import { resolveSshDirectoryTrustNotice, saveSshDirectoryTrust } from "./sshDirectoryTrustState";

const projectPath = "/repo/app";
const directory = { host: "box", projectDir: "/srv/app" };

function projectsWith(owner: Partial<ProjectConfig>): Map<string, ProjectConfig> {
  return new Map<string, ProjectConfig>([
    [projectPath, { workspaces: [], ...owner }],
    ["/repo/app/sub", { workspaces: [], parentProjectPath: projectPath }],
  ]);
}

describe("resolveSshDirectoryTrustNotice", () => {
  test("shows nothing until host and directory are filled in", () => {
    const userProjects = projectsWith({ trusted: true });
    expect(
      resolveSshDirectoryTrustNotice({ projectPath, userProjects, host: " ", projectDir: "/srv" })
    ).toBeNull();
    expect(
      resolveSshDirectoryTrustNotice({ projectPath, userProjects, host: "box", projectDir: "" })
    ).toBeNull();
  });

  test("shows nothing on an untrusted project: its own trust flow governs", () => {
    expect(
      resolveSshDirectoryTrustNotice({
        projectPath,
        userProjects: projectsWith({ trustedSshDirectories: [directory] }),
        host: "box",
        projectDir: "/srv/app",
      })
    ).toBeNull();
  });

  test("reports whether the trimmed directory is trusted", () => {
    expect(
      resolveSshDirectoryTrustNotice({
        projectPath,
        userProjects: projectsWith({ trusted: true }),
        host: " box ",
        projectDir: " /srv/app ",
      })
    ).toEqual({ host: "box", projectDir: "/srv/app", trusted: false });
    expect(
      resolveSshDirectoryTrustNotice({
        projectPath,
        userProjects: projectsWith({ trusted: true, trustedSshDirectories: [directory] }),
        host: "box",
        projectDir: "/srv/app",
      })?.trusted
    ).toBe(true);
  });

  test("a sub-project reads trust from its parent project", () => {
    expect(
      resolveSshDirectoryTrustNotice({
        projectPath: "/repo/app/sub",
        userProjects: projectsWith({ trusted: true, trustedSshDirectories: [directory] }),
        host: "box",
        projectDir: "/srv/app",
      })?.trusted
    ).toBe(true);
  });
});

describe("saveSshDirectoryTrust", () => {
  const request = { projectPath, host: "box", projectDir: "~/app", trusted: true };

  function depsReturning(result: Result<{ projectDir: string }, string>) {
    const calls = { resolved: [] as string[], refreshed: 0 };
    return {
      calls,
      deps: {
        api: { setSshDirectoryTrust: () => Promise.resolve(result) },
        refreshProjects: () => {
          calls.refreshed++;
          return Promise.resolve();
        },
        onProjectDirResolved: (dir: string) => calls.resolved.push(dir),
      },
    };
  }

  test("writes the host-resolved directory back and refreshes trust", async () => {
    const { calls, deps } = depsReturning(Ok({ projectDir: "/home/me/app" }));
    let published = 0;
    const unsubscribe = subscribeProjectTrustChanged(() => published++);
    try {
      expect(await saveSshDirectoryTrust(deps, request)).toBeNull();
    } finally {
      unsubscribe();
    }
    expect(calls.resolved).toEqual(["/home/me/app"]);
    expect(calls.refreshed).toBe(1);
    expect(published).toBe(1);
  });

  test("leaves an already-resolved directory alone", async () => {
    const { calls, deps } = depsReturning(Ok({ projectDir: "~/app" }));
    expect(await saveSshDirectoryTrust(deps, request)).toBeNull();
    expect(calls.resolved).toEqual([]);
  });

  test("returns the backend's refusal without refreshing", async () => {
    const { calls, deps } = depsReturning(Err("Trust the project first"));
    expect(await saveSshDirectoryTrust(deps, request)).toBe("Trust the project first");
    expect(calls.refreshed).toBe(0);
  });

  test("returns a thrown error as a message", async () => {
    const { deps } = depsReturning(Ok({ projectDir: "~/app" }));
    const failing = {
      ...deps,
      api: { setSshDirectoryTrust: () => Promise.reject(new Error("offline")) },
    };
    expect(await saveSshDirectoryTrust(failing, request)).toBe("offline");
  });
});
