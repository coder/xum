import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { INSTRUCTION_SCOPE } from "@/common/types/instructions";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { RuntimeError } from "@/node/runtime/Runtime";
import {
  readClaudeCompatGlobalInstructionSet,
  readInstructionSet,
  readInstructionSetFromRuntime,
} from "./instructionFiles";

describe("instructionFiles", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "instruction-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("readInstructionSet", () => {
    it("should return null when no instruction files exist", async () => {
      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result).toBeNull();
    });

    it("should return base instruction file content", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "base instructions");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.combinedContent).toBe("base instructions");
      expect(result?.files).toHaveLength(1);
      expect(result?.files[0]?.filename).toBe("AGENTS.md");
      expect(result?.files[0]?.isLocal).toBe(false);
      expect(result?.files[0]?.scope).toBe(INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.files[0]?.bytes).toBe(Buffer.byteLength("base instructions", "utf-8"));
    });

    it("should append AGENTS.local.md to base instructions", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "base instructions");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local overrides");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.WORKSPACE);
      expect(result?.combinedContent).toBe("base instructions\n\nlocal overrides");
      expect(result?.files).toHaveLength(2);
      expect(result?.files[0]?.filename).toBe("AGENTS.md");
      expect(result?.files[0]?.isLocal).toBe(false);
      expect(result?.files[1]?.filename).toBe("AGENTS.local.md");
      expect(result?.files[1]?.isLocal).toBe(true);
    });

    it("should work with AGENT.md + AGENTS.local.md", async () => {
      await fs.writeFile(path.join(tempDir, "AGENT.md"), "base content");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local content");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.combinedContent).toBe("base content\n\nlocal content");
      expect(result?.files[0]?.filename).toBe("AGENT.md");
    });

    it("should work with CLAUDE.md + AGENTS.local.md", async () => {
      await fs.writeFile(path.join(tempDir, "CLAUDE.md"), "base content");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local content");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.combinedContent).toBe("base content\n\nlocal content");
      expect(result?.files[0]?.filename).toBe("CLAUDE.md");
    });

    it("should ignore AGENTS.local.md if no base file exists", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local only");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result).toBeNull();
    });

    it("should strip markdown comments from instructions", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "<!-- secret -->\nVisible directive");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.combinedContent).toBe("Visible directive");
      expect(result?.files[0]?.content).toBe("Visible directive");
    });

    it("should return null if stripping comments leaves no content", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "<!-- only comments -->");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result).toBeNull();
    });

    it("should preserve local instructions when the base file strips to empty", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "<!-- tracked-only comment -->");
      await fs.writeFile(path.join(tempDir, "AGENT.md"), "lower priority base");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local guidance");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.combinedContent).toBe("local guidance");
      expect(result?.files).toHaveLength(1);
      expect(result?.files[0]?.filename).toBe("AGENTS.local.md");
    });

    it("should prefer AGENTS.md even if AGENT.md and AGENTS.local.md exist", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "agents base");
      await fs.writeFile(path.join(tempDir, "AGENT.md"), "agent base");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.combinedContent).toBe("agents base\n\nlocal");
      expect(result?.files[0]?.filename).toBe("AGENTS.md");
    });

    it("should propagate projectName for project scope", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "project content");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.PROJECT, "my-project");
      expect(result?.scope).toBe(INSTRUCTION_SCOPE.PROJECT);
      expect(result?.projectName).toBe("my-project");
      expect(result?.files[0]?.projectName).toBe("my-project");
    });

    it("should mark shared base files as not xumOnly", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "base instructions");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local overrides");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.WORKSPACE);
      expect(result?.files.map((f) => f.xumOnly)).toEqual([false, false]);
    });

    it("should read .mux/AGENTS.md as a xumOnly file even without a shared base file", async () => {
      await fs.mkdir(path.join(tempDir, ".mux"));
      await fs.writeFile(path.join(tempDir, ".mux", "AGENTS.md"), "mux-only directives");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.WORKSPACE);
      expect(result?.combinedContent).toBe("mux-only directives");
      expect(result?.files).toHaveLength(1);
      expect(result?.files[0]?.filename).toBe("AGENTS.md");
      expect(result?.files[0]?.path).toBe(path.join(tempDir, ".mux", "AGENTS.md"));
      expect(result?.files[0]?.xumOnly).toBe(true);
    });

    it("prefers .xum/AGENTS.md without combining the legacy tree", async () => {
      await fs.mkdir(path.join(tempDir, ".mux"));
      await fs.writeFile(path.join(tempDir, ".mux", "AGENTS.md"), "legacy directives");
      await fs.mkdir(path.join(tempDir, ".xum"));
      await fs.writeFile(path.join(tempDir, ".xum", "AGENTS.md"), "canonical directives");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.WORKSPACE);
      expect(result?.combinedContent).toBe("canonical directives");
      expect(result?.files[0]?.path).toBe(path.join(tempDir, ".xum", "AGENTS.md"));
    });

    it("should append .mux/AGENTS.md (+ .local.md) after the shared files", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "shared base");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "shared local");
      await fs.mkdir(path.join(tempDir, ".mux"));
      await fs.writeFile(path.join(tempDir, ".mux", "AGENTS.md"), "mux base");
      await fs.writeFile(path.join(tempDir, ".mux", "AGENTS.local.md"), "mux local");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.WORKSPACE);
      expect(result?.combinedContent).toBe("shared base\n\nshared local\n\nmux base\n\nmux local");
      expect(result?.files.map((f) => f.xumOnly)).toEqual([false, false, true, true]);
      expect(result?.files.map((f) => f.isLocal)).toEqual([false, true, false, true]);
    });

    it("should ignore .mux/AGENTS.local.md when .mux/AGENTS.md is missing", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "shared base");
      await fs.mkdir(path.join(tempDir, ".mux"));
      await fs.writeFile(path.join(tempDir, ".mux", "AGENTS.local.md"), "mux local only");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.WORKSPACE);
      expect(result?.combinedContent).toBe("shared base");
    });

    it("should mark global files as xumOnly and skip nested .mux lookup", async () => {
      // Global scope reads ~/.mux itself, which is Xum-dedicated by construction.
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "global instructions");
      await fs.mkdir(path.join(tempDir, ".mux"));
      await fs.writeFile(path.join(tempDir, ".mux", "AGENTS.md"), "should not be read");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.combinedContent).toBe("global instructions");
      expect(result?.files).toHaveLength(1);
      expect(result?.files[0]?.xumOnly).toBe(true);
    });
  });

  describe("readClaudeCompatGlobalInstructionSet", () => {
    it("returns null when CLAUDE.md is missing", async () => {
      expect(await readClaudeCompatGlobalInstructionSet(tempDir)).toBeNull();
    });

    it("reads only CLAUDE.md as a shared global instruction file", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "native candidate");
      await fs.writeFile(path.join(tempDir, "AGENT.md"), "secondary candidate");
      await fs.writeFile(path.join(tempDir, "CLAUDE.md"), "claude instructions");

      const result = await readClaudeCompatGlobalInstructionSet(tempDir);

      expect(result?.combinedContent).toBe("claude instructions");
      expect(result?.scope).toBe(INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.files).toHaveLength(1);
      expect(result?.files[0]).toMatchObject({
        filename: "CLAUDE.md",
        isLocal: false,
        xumOnly: false,
        scope: INSTRUCTION_SCOPE.GLOBAL,
      });
    });

    it("does not append local or nested Xum instruction files", async () => {
      await fs.writeFile(path.join(tempDir, "CLAUDE.md"), "claude instructions");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local instructions");
      await fs.mkdir(path.join(tempDir, ".mux"));
      await fs.writeFile(path.join(tempDir, ".mux", "AGENTS.md"), "nested instructions");

      const result = await readClaudeCompatGlobalInstructionSet(tempDir);

      expect(result?.files.map((file) => file.content)).toEqual(["claude instructions"]);
    });
  });

  // #4438: on SSH runtimes a read that failed in transport says nothing about the file.
  // It must fail loudly instead of letting a lower-priority file (CLAUDE.md, the legacy
  // .mux tree) or a missing .local.md silently change the instructions.
  describe("readInstructionSetFromRuntime transport failures", () => {
    function failInTransport(runtime: LocalRuntime, failingPath: string) {
      const readFile = runtime.readFile.bind(runtime);
      spyOn(runtime, "readFile").mockImplementation((filePath, ...rest) => {
        if (filePath !== failingPath) return readFile(filePath, ...rest);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(
              new RuntimeError(`Failed to read file ${filePath}: Connection refused`, "network")
            );
          },
        });
      });
    }

    it.each([
      // An unreadable AGENTS.md must not let CLAUDE.md win.
      ["AGENTS.md", ["AGENTS.md", "CLAUDE.md"]],
      // An unreadable companion must not silently drop local instructions.
      ["AGENTS.local.md", ["AGENTS.md", "AGENTS.local.md"]],
      // An unreadable .xum/AGENTS.md must not fall back to the legacy .mux tree.
      [".xum/AGENTS.md", [".xum/AGENTS.md", ".mux/AGENTS.md"]],
    ])("rejects when %s fails in transport", async (failing, files) => {
      for (const file of files) {
        await fs.mkdir(path.dirname(path.join(tempDir, file)), { recursive: true });
        await fs.writeFile(path.join(tempDir, file), `${file} instructions`);
      }
      const runtime = new LocalRuntime(tempDir);
      failInTransport(runtime, path.join(tempDir, failing));

      const error: unknown = await readInstructionSetFromRuntime(
        runtime,
        tempDir,
        INSTRUCTION_SCOPE.WORKSPACE
      ).then(
        () => null,
        (rejection: unknown) => rejection
      );
      expect(error).toMatchObject({ type: "network" });
    });

    it("still falls back to CLAUDE.md when AGENTS.md is missing", async () => {
      await fs.writeFile(path.join(tempDir, "CLAUDE.md"), "claude instructions");
      const runtime = new LocalRuntime(tempDir);

      const result = await readInstructionSetFromRuntime(
        runtime,
        tempDir,
        INSTRUCTION_SCOPE.WORKSPACE
      );
      expect(result?.files.map((file) => file.filename)).toEqual(["CLAUDE.md"]);
    });
  });
});
