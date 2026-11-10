import { describe, expect, test } from "bun:test";
import type { ProjectConfig } from "@/common/types/project";
import { Err, Ok, type Result } from "@/common/types/result";
import { subscribeProjectTrustChanged } from "@/browser/utils/workspaceMcpMutations";
import {
  resolveSshDirectoryTrustNotice,
  applyResolvedProjectDir,
  saveSshDirectoryTrust,
  sshDirectoryTrustRowCopy,
} from "./sshDirectoryTrustState";

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
        // The form still shows the requested directory when the request returns.
        currentSelection: () => ({
          projectPath,
          host: "box",
          projectDir: "~/app",
          applyProjectDir: (dir: string) => calls.resolved.push(dir),
        }),
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

describe("sshDirectoryTrustRowCopy", () => {
  const base = { trusted: false, host: "devbox", projectDir: "~/app" } as const;

  test("a trust that resolves the path on the host names the host while it runs", () => {
    expect(sshDirectoryTrustRowCopy({ ...base, pending: "trust" }).action).toContain("devbox");
    expect(
      sshDirectoryTrustRowCopy({ ...base, projectDir: "/srv/app", pending: "trust" }).action
    ).not.toContain("devbox");
  });

  test("idle and pending labels differ for each direction", () => {
    const idleTrust = sshDirectoryTrustRowCopy({ ...base, pending: null }).action;
    const idleUntrust = sshDirectoryTrustRowCopy({ ...base, trusted: true, pending: null }).action;
    const untrusting = sshDirectoryTrustRowCopy({ ...base, trusted: true, pending: "untrust" });
    expect(new Set([idleTrust, idleUntrust, untrusting.action]).size).toBe(3);
  });
});

describe("applyResolvedProjectDir", () => {
  const request = { projectPath, host: "box", projectDir: "~/app" };

  function selection(
    overrides: Partial<{ projectPath: string; host: string; projectDir: string }>
  ) {
    const applied: string[] = [];
    return {
      applied,
      current: {
        projectPath,
        host: "box",
        projectDir: "~/app",
        ...overrides,
        applyProjectDir: (dir: string) => applied.push(dir),
      },
    };
  }

  test("writes the resolved path while the form still shows the requested directory", () => {
    // Untrimmed input still counts: the request carries the trimmed values.
    const { applied, current } = selection({ host: " box ", projectDir: "~/app " });
    expect(applyResolvedProjectDir(current, request, "/home/me/app")).toBe(true);
    expect(applied).toEqual(["/home/me/app"]);
  });

  test.each([
    ["another host", { host: "other" }],
    ["another directory", { projectDir: "~/other" }],
    ["another project", { projectPath: "/repo/other" }],
  ] as const)("keeps a newer selection on %s", (_label, overrides) => {
    const { applied, current } = selection(overrides);
    expect(applyResolvedProjectDir(current, request, "/home/me/app")).toBe(false);
    expect(applied).toEqual([]);
  });

  test("writes nothing once the SSH+None controls are gone", () => {
    expect(applyResolvedProjectDir(null, request, "/home/me/app")).toBe(false);
  });
});
