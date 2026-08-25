import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import type { Config } from "@/node/config";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { EditorService } from "./editorService";

interface FakeCliScriptOptions {
  listOutput: string;
  listExitCode?: number;
  installExitCode?: number;
  installLogPath: string;
}

function createFakeCliScript(options: FakeCliScriptOptions): string {
  const listExitCode = options.listExitCode ?? 0;
  const installExitCode = options.installExitCode ?? 0;
  const listLines = options.listOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (process.platform === "win32") {
    const listOutput =
      listLines.length > 0
        ? listLines.map((line) => `  echo ${line}`).join("\n")
        : "  rem no output";

    return `@echo off
if "%1"=="--list-extensions" (
${listOutput}
  exit /b ${listExitCode}
)
if "%1"=="--install-extension" (
  echo %*>>"${options.installLogPath}"
  exit /b ${installExitCode}
)
exit /b 1
`;
  }

  const listOutput =
    listLines.length > 0 ? listLines.map((line) => `  printf '%s\\n' "${line}"`).join("\n") : "  :";

  return `#!/usr/bin/env sh
if [ "$1" = "--list-extensions" ]; then
${listOutput}
  exit ${listExitCode}
fi
if [ "$1" = "--install-extension" ]; then
  printf '%s\\n' "$*" >> "${options.installLogPath}"
  exit ${installExitCode}
fi
exit 1
`;
}

async function readFileIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function withCliInPath(
  cliName: "code" | "cursor",
  scriptFactory: (cliDir: string) => string,
  run: (cliDir: string) => Promise<void>
): Promise<void> {
  const cliDir = await mkdtemp(join(tmpdir(), "mux-editor-service-test-"));
  const originalPath = process.env.PATH;
  const executableName = process.platform === "win32" ? `${cliName}.cmd` : cliName;
  const executablePath = join(cliDir, executableName);

  try {
    await writeFile(executablePath, scriptFactory(cliDir), { mode: 0o755 });
    process.env.PATH = originalPath ? `${cliDir}${delimiter}${originalPath}` : cliDir;
    await run(cliDir);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(cliDir, { recursive: true, force: true });
  }
}

describe("EditorService", () => {
  test("rejects non-custom editors (renderer must use deep links)", async () => {
    const editorService = new EditorService({} as Config);

    const result = await editorService.openInEditor("ws1", "/tmp", {
      editor: "vscode",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("deep links");
    }
  });

  test("validates custom editor executable exists before spawning", async () => {
    const workspace: FrontendWorkspaceMetadata = {
      id: "ws1",
      name: "ws1",
      projectName: "proj",
      projectPath: "/tmp/proj",
      createdAt: "2025-01-01T00:00:00.000Z",
      runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
      namedWorkspacePath: "/tmp/src/proj/ws1",
    };

    const mockConfig: Pick<Config, "getAllWorkspaceMetadata"> = {
      getAllWorkspaceMetadata: () => Promise.resolve([workspace]),
    } as unknown as Pick<Config, "getAllWorkspaceMetadata">;

    const editorService = new EditorService(mockConfig as Config);

    const result = await editorService.openInEditor("ws1", "/tmp", {
      editor: "custom",
      customCommand: "definitely-not-a-command",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Editor command not found");
    }
  });

  test("errors on invalid custom editor command quoting", async () => {
    const workspace: FrontendWorkspaceMetadata = {
      id: "ws1",
      name: "ws1",
      projectName: "proj",
      projectPath: "/tmp/proj",
      createdAt: "2025-01-01T00:00:00.000Z",
      runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
      namedWorkspacePath: "/tmp/src/proj/ws1",
    };

    const mockConfig: Pick<Config, "getAllWorkspaceMetadata"> = {
      getAllWorkspaceMetadata: () => Promise.resolve([workspace]),
    } as unknown as Pick<Config, "getAllWorkspaceMetadata">;

    const editorService = new EditorService(mockConfig as Config);

    const result = await editorService.openInEditor("ws1", "/tmp", {
      editor: "custom",
      customCommand: '"unterminated',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid custom editor command");
    }
  });

  describe("installVsCodeExtension", () => {
    test("returns alreadyInstalled when coder.mux is already present", async () => {
      const editorService = new EditorService({} as Config);

      await withCliInPath(
        "code",
        (cliDir) =>
          createFakeCliScript({
            listOutput: "coder.mux\nms-python.python",
            installLogPath: join(cliDir, "install.log"),
          }),
        async (cliDir) => {
          const result = await editorService.installVsCodeExtension("vscode");

          expect(result).toEqual({ installed: true, alreadyInstalled: true });
          expect(await readFileIfExists(join(cliDir, "install.log"))).toBe("");
        }
      );
    });

    test("installs coder.mux via cursor CLI when extension is missing", async () => {
      const editorService = new EditorService({} as Config);

      await withCliInPath(
        "cursor",
        (cliDir) =>
          createFakeCliScript({
            listOutput: "ms-python.python",
            installLogPath: join(cliDir, "install.log"),
          }),
        async (cliDir) => {
          const result = await editorService.installVsCodeExtension("cursor");

          expect(result).toEqual({ installed: true, alreadyInstalled: false });
          expect(await readFileIfExists(join(cliDir, "install.log"))).toContain(
            "--install-extension coder.mux"
          );
        }
      );
    });

    test("returns an error result instead of throwing when CLI commands fail", async () => {
      const editorService = new EditorService({} as Config);

      await withCliInPath(
        "code",
        (cliDir) =>
          createFakeCliScript({
            listOutput: "",
            listExitCode: 2,
            installLogPath: join(cliDir, "install.log"),
          }),
        async () => {
          const result = await editorService.installVsCodeExtension("vscode");

          expect(result.installed).toBe(false);
          expect(result.alreadyInstalled).toBe(false);
          expect(result.error).toBeDefined();
          expect(typeof result.error).toBe("string");
        }
      );
    });
  });
});
