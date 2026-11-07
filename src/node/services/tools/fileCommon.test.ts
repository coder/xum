import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it, expect } from "bun:test";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import type { FileStat, Runtime } from "@/node/runtime/Runtime";
import {
  validatePlanModeAccess,
  validateFileSize,
  validateNoRedundantPrefix,
  resolveFileToolPath,
  resolvePathWithinCwd,
  MAX_FILE_SIZE,
} from "./fileCommon";
import { TestTempDir } from "./testHelpers";
import type { AgentSandboxPolicy } from "@/node/runtime/sandbox/agentSandboxTargets";
// A static import, not a require("...?real=1") copy: Bun's LCOV keeps only the last-loaded copy of
// a file, so a copy would replace runtimeFactory.test.ts's coverage of runtimeFactory.ts.
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { nodeSessionLocks } from "@/node/services/sessionLocks/nodeSessionLocks";

describe("fileCommon", () => {
  describe("validateFileSize", () => {
    it("should return null for files within size limit", () => {
      const stats: FileStat = {
        size: 1024, // 1KB
        modifiedTime: new Date(),
        isDirectory: false,
      };

      expect(validateFileSize(stats)).toBeNull();
    });

    it("should return null for files at exactly the limit", () => {
      const stats: FileStat = {
        size: MAX_FILE_SIZE,
        modifiedTime: new Date(),
        isDirectory: false,
      };

      expect(validateFileSize(stats)).toBeNull();
    });

    it("should return error for files exceeding size limit", () => {
      const stats: FileStat = {
        size: MAX_FILE_SIZE + 1,
        modifiedTime: new Date(),
        isDirectory: false,
      };

      const result = validateFileSize(stats);
      expect(result).not.toBeNull();
      expect(result?.error).toContain("too large");
      expect(result?.error).toContain("system tools");
    });

    it("should include size information in error message", () => {
      const stats: FileStat = {
        size: MAX_FILE_SIZE * 2, // 2MB
        modifiedTime: new Date(),
        isDirectory: false,
      };

      const result = validateFileSize(stats);
      expect(result?.error).toContain("2.00MB");
      expect(result?.error).toContain("1.00MB");
    });

    it("should suggest alternative tools in error message", () => {
      const stats: FileStat = {
        size: MAX_FILE_SIZE + 1,
        modifiedTime: new Date(),
        isDirectory: false,
      };

      const result = validateFileSize(stats);
      expect(result?.error).toContain("grep");
      expect(result?.error).toContain("sed");
    });
  });

  describe("resolveFileToolPath", () => {
    const cwd = "/workspace/project";
    const runtime = createRuntime({ type: "local", srcBaseDir: cwd });

    it("keeps resolving configured plan files outside cwd", () => {
      const planFilePath = "/home/user/.mux/plans/plan.md";
      const result = resolveFileToolPath(planFilePath, cwd, runtime);

      expect(result.correctedPath).toBe(planFilePath);
      expect(result.resolvedPath).toBe(planFilePath);
    });

    it("keeps resolving unrelated absolute paths outside cwd", () => {
      const otherPath = "/home/user/.mux/plans/other.md";
      const result = resolveFileToolPath(otherPath, cwd, runtime);

      expect(result.correctedPath).toBe(otherPath);
      expect(result.resolvedPath).toBe(otherPath);
    });

    it("resolves relative paths that traverse outside cwd", () => {
      const result = resolveFileToolPath("../plans/ancestor.md", cwd, runtime);

      expect(result.correctedPath).toBe("../plans/ancestor.md");
      expect(result.resolvedPath).toBe("/workspace/plans/ancestor.md");
    });
  });

  describe("resolvePathWithinCwd under the agent sandbox", () => {
    // A stand-in home under a temp folder, so the policy never names the developer's real home.
    async function sandboxFixture(temp: TestTempDir) {
      const root = await fs.realpath(temp.path);
      const home = path.join(root, "home");
      const workspace = path.join(home, "ws");
      const tools = path.join(home, "tools");
      const secretDir = path.join(home, "secret");
      const plans = path.join(home, "plans");
      const outputs = path.join(home, "outputs");
      for (const dir of [workspace, tools, secretDir, plans, outputs]) {
        await fs.mkdir(dir, { recursive: true });
      }
      await fs.symlink(secretDir, path.join(workspace, "secret-link"));
      await fs.symlink(path.join(secretDir, "new.txt"), path.join(workspace, "dangling-link"));
      await fs.symlink(path.join(workspace, "loop-b"), path.join(workspace, "loop-a"));
      await fs.symlink(path.join(workspace, "loop-a"), path.join(workspace, "loop-b"));
      const policy: AgentSandboxPolicy = {
        writeRoots: [workspace],
        denyWrite: [],
        denyRead: [home],
        allowRead: [workspace, tools],
        network: "allowlist",
        allowedHosts: [],
        allowLocalBinding: true,
      };
      const runtime = createRuntime({ type: "local", srcBaseDir: workspace });
      runtime.agentSandboxPolicy = () => policy;
      const sandbox = {
        exemptPaths: [path.join(plans, "plan.md")],
        readExemptPaths: [path.join(plans, "ancestor.md"), outputs],
      };
      return { home, workspace, runtime, sandbox };
    }

    const cases: Array<{
      name: string;
      target: (home: string) => string;
      access: "read" | "write";
      allowed: boolean;
    }> = [
      { name: "reads in the workspace", target: () => "src/a.ts", access: "read", allowed: true },
      { name: "writes in the workspace", target: () => "src/a.ts", access: "write", allowed: true },
      {
        name: "reads a closed folder",
        target: (home) => path.join(home, "secret", "key"),
        access: "read",
        allowed: false,
      },
      {
        name: "reads a read-only folder",
        target: (home) => path.join(home, "tools", "bin"),
        access: "read",
        allowed: true,
      },
      {
        name: "writes a read-only folder",
        target: (home) => path.join(home, "tools", "bin"),
        access: "write",
        allowed: false,
      },
      {
        name: "reads through a link that points out of the workspace",
        target: () => "secret-link/key",
        access: "read",
        allowed: false,
      },
      {
        name: "writes through a dangling link that points out of the workspace",
        target: () => "dangling-link",
        access: "write",
        allowed: false,
      },
      // A link loop has no real path, so the check fails closed instead of chasing it forever.
      {
        name: "writes through a link loop",
        target: () => "loop-a",
        access: "write",
        allowed: false,
      },
      {
        name: "writes the plan file",
        target: (home) => path.join(home, "plans", "plan.md"),
        access: "write",
        allowed: true,
      },
      {
        name: "reads an ancestor plan file",
        target: (home) => path.join(home, "plans", "ancestor.md"),
        access: "read",
        allowed: true,
      },
      {
        name: "writes an ancestor plan file",
        target: (home) => path.join(home, "plans", "ancestor.md"),
        access: "write",
        allowed: false,
      },
      {
        name: "reads bash overflow output",
        target: (home) => path.join(home, "outputs", "bash-1.txt"),
        access: "read",
        allowed: true,
      },
    ];

    for (const testCase of cases) {
      it(`${testCase.allowed ? "allows" : "blocks"}: ${testCase.name}`, async () => {
        using temp = new TestTempDir("file-sandbox");
        const fixture = await sandboxFixture(temp);
        const outcome = await resolvePathWithinCwd(
          testCase.target(fixture.home),
          fixture.workspace,
          fixture.runtime,
          testCase.access,
          fixture.sandbox
        ).then(
          () => "allowed",
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        );
        if (testCase.allowed) {
          expect(outcome).toBe("allowed");
        } else {
          expect(outcome).toMatch(/The agent sandbox blocks/);
        }
      });
    }

    it("checks nothing when no sandbox applies", async () => {
      using temp = new TestTempDir("file-sandbox");
      const fixture = await sandboxFixture(temp);
      fixture.runtime.agentSandboxPolicy = () => null;
      const secret = path.join(fixture.home, "secret", "key");

      expect(
        (await resolvePathWithinCwd(secret, fixture.workspace, fixture.runtime, "write"))
          .resolvedPath
      ).toBe(secret);
    });

    // SSH and the other remote runtimes have no agent sandbox at all.
    it("checks nothing on a runtime without an agent sandbox", async () => {
      const sshRuntime = createRuntime({
        type: "ssh",
        host: "user@localhost",
        srcBaseDir: "/home/user/mux",
        identityFile: "/tmp/fake-key",
      });

      expect(
        (
          await resolvePathWithinCwd(
            "/home/user/.ssh/id_rsa",
            "/home/user/mux/p/b",
            sshRuntime,
            "write"
          )
        ).resolvedPath
      ).toBe("/home/user/.ssh/id_rsa");
    });
  });

  describe("validateNoRedundantPrefix", () => {
    const cwd = "/workspace/project";
    const runtime = createRuntime({ type: "local", srcBaseDir: cwd });

    it("should allow relative paths", () => {
      expect(validateNoRedundantPrefix("src/file.ts", cwd, runtime)).toBeNull();
      expect(validateNoRedundantPrefix("./src/file.ts", cwd, runtime)).toBeNull();
      expect(validateNoRedundantPrefix("file.ts", cwd, runtime)).toBeNull();
    });

    it("should auto-correct absolute paths that contain the cwd prefix", () => {
      const result = validateNoRedundantPrefix("/workspace/project/src/file.ts", cwd, runtime);
      expect(result).not.toBeNull();
      expect(result?.correctedPath).toBe("src/file.ts");
      expect(result?.warning).toContain("Using relative paths");
      expect(result?.warning).toContain("saves tokens");
      expect(result?.warning).toContain("auto-corrected");
    });

    it("should auto-correct absolute paths at the cwd root", () => {
      const result = validateNoRedundantPrefix("/workspace/project/file.ts", cwd, runtime);
      expect(result).not.toBeNull();
      expect(result?.correctedPath).toBe("file.ts");
      expect(result?.warning).toContain("auto-corrected");
    });

    it("should allow absolute paths outside cwd", () => {
      // This validation only catches redundant prefixes, not paths outside cwd
      expect(validateNoRedundantPrefix("/etc/passwd", cwd, runtime)).toBeNull();
      expect(validateNoRedundantPrefix("/home/user/file.ts", cwd, runtime)).toBeNull();
    });

    it("should handle paths with ..", () => {
      // Relative paths with .. are fine for this check
      expect(validateNoRedundantPrefix("../outside.ts", cwd, runtime)).toBeNull();
      expect(validateNoRedundantPrefix("src/../../outside.ts", cwd, runtime)).toBeNull();
    });

    it("should work with cwd that has trailing slash", () => {
      const cwdWithSlash = "/workspace/project/";
      const result = validateNoRedundantPrefix(
        "/workspace/project/src/file.ts",
        cwdWithSlash,
        runtime
      );
      expect(result).not.toBeNull();
      expect(result?.correctedPath).toBe("src/file.ts");
      expect(result?.warning).toContain("auto-corrected");
    });

    it("should handle nested paths correctly", () => {
      const result = validateNoRedundantPrefix(
        "/workspace/project/src/components/Button/index.ts",
        cwd,
        runtime
      );
      expect(result).not.toBeNull();
      expect(result?.correctedPath).toBe("src/components/Button/index.ts");
      expect(result?.warning).toContain("auto-corrected");
    });

    it("should auto-correct path that equals cwd exactly", () => {
      const result = validateNoRedundantPrefix("/workspace/project", cwd, runtime);
      expect(result).not.toBeNull();
      expect(result?.correctedPath).toBe(".");
      expect(result?.warning).toContain("auto-corrected");
    });

    it("should not match partial directory names", () => {
      // /workspace/project2 should NOT match /workspace/project
      expect(validateNoRedundantPrefix("/workspace/project2/file.ts", cwd, runtime)).toBeNull();
      expect(validateNoRedundantPrefix("/workspace/project-old/file.ts", cwd, runtime)).toBeNull();
    });

    it("should work with SSH runtime", () => {
      const sshRuntime = createRuntime({
        type: "ssh",
        host: "user@localhost",
        srcBaseDir: "/home/user/mux",
        identityFile: "/tmp/fake-key",
      });
      const sshCwd = "/home/user/mux/project/branch";

      // Should auto-correct absolute paths with redundant prefix on SSH too
      const result = validateNoRedundantPrefix(
        "/home/user/mux/project/branch/src/file.ts",
        sshCwd,
        sshRuntime
      );
      expect(result).not.toBeNull();
      expect(result?.correctedPath).toBe("src/file.ts");
      expect(result?.warning).toContain("auto-corrected");

      // Should allow relative paths on SSH
      expect(validateNoRedundantPrefix("src/file.ts", sshCwd, sshRuntime)).toBeNull();
    });
  });

  describe("validatePlanModeAccess", () => {
    const planFilePath = "~/.mux/plans/plan.md";
    const resolvedPlanFilePath = "/home/user/.mux/plans/plan.md";

    const mockRuntime = {
      resolvePath: (targetPath: string): Promise<string> => {
        if (targetPath === planFilePath) {
          return Promise.resolve(resolvedPlanFilePath);
        }
        if (targetPath === resolvedPlanFilePath) {
          return Promise.resolve(resolvedPlanFilePath);
        }
        if (targetPath === "src/main.ts") {
          return Promise.resolve("/home/user/project/src/main.ts");
        }
        return Promise.resolve(targetPath);
      },
    } as unknown as Runtime;

    const planModeConfig: ToolConfiguration = {
      sessionLocks: nodeSessionLocks,
      cwd: "/home/user/project",
      runtime: mockRuntime,
      runtimeTempDir: "/tmp",
      planFileOnly: true,
      planFilePath,
    };

    const execConfig: ToolConfiguration = {
      ...planModeConfig,
      planFileOnly: false,
    };

    it("should allow editing the configured plan file outside plan mode", async () => {
      expect(await validatePlanModeAccess(planFilePath, execConfig)).toBeNull();
      expect(await validatePlanModeAccess(resolvedPlanFilePath, execConfig)).toBeNull();
    });

    it("should allow editing when filePath is exactly planFilePath in plan mode", async () => {
      expect(await validatePlanModeAccess(planFilePath, planModeConfig)).toBeNull();
    });

    it("should reject alternate paths that resolve to the plan file in plan mode", async () => {
      const result = await validatePlanModeAccess(resolvedPlanFilePath, planModeConfig);
      expect(result).not.toBeNull();
      expect(result?.error).toContain("exact plan file path");
      expect(result?.error).toContain(planFilePath);
      expect(result?.error).toContain(resolvedPlanFilePath);
      expect(result?.error).toContain("resolves to the plan file");
    });

    it("should reject non-plan files in plan mode", async () => {
      const result = await validatePlanModeAccess("src/main.ts", planModeConfig);
      expect(result).not.toBeNull();
      expect(result?.error).toContain("only the plan file can be edited");
      expect(result?.error).toContain("exact plan file path");
      expect(result?.error).toContain(planFilePath);
      expect(result?.error).toContain("src/main.ts");
    });
  });
});
