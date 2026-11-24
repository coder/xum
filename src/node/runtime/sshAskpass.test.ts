import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { execFile } from "child_process";
import { EventEmitter } from "events";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getXumHome } from "@/common/constants/paths";
import { askpassSessionsRoot, createAskpassSession, parseHostKeyPrompt } from "./sshAskpass";

describe("sshAskpass", () => {
  describe("createAskpassSession", () => {
    // Sessions live in Xum's home folder: keep them out of the real one.
    const savedRoot = process.env.XUM_ROOT;
    let isolatedRoot: string;
    beforeAll(() => {
      isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xum-askpass-root-"));
      process.env.XUM_ROOT = isolatedRoot;
    });
    afterAll(() => {
      if (savedRoot === undefined) delete process.env.XUM_ROOT;
      else process.env.XUM_ROOT = savedRoot;
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    });

    async function simulateAskpassInvocation(
      askpassDir: string,
      promptText: string,
      requestId: string,
      cleanupResponseFiles = true
    ): Promise<string> {
      const promptFile = path.join(askpassDir, `prompt.${requestId}.txt`);
      const responseFile = path.join(askpassDir, `response.${requestId}.txt`);

      // Simulate askpass writing prompt content for this invocation. Like the
      // script, write a temp name and rename it, so the watcher never reads a
      // half-written prompt.
      await fs.promises.writeFile(`${promptFile}.tmp`, promptText, "utf-8");
      await fs.promises.rename(`${promptFile}.tmp`, promptFile);

      // Poll for the response file written by createAskpassSession().
      for (let i = 0; i < 100; i += 1) {
        try {
          const response = await fs.promises.readFile(responseFile, "utf-8");

          if (cleanupResponseFiles) {
            // Simulate askpass script cleanup.
            await fs.promises.unlink(promptFile).catch(() => undefined);
            await fs.promises.unlink(responseFile).catch(() => undefined);
          }

          return response.trim();
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      throw new Error(`Timeout waiting for response for request '${requestId}'`);
    }

    async function listAskpassTempDirs(): Promise<string[]> {
      const entries = await fs.promises.readdir(askpassSessionsRoot()).catch(() => []);
      return entries.filter((entry) => entry.startsWith("mux-askpass-")).sort();
    }

    test("does not leak temp dir when script bootstrap fails", async () => {
      const tmpBefore = await listAskpassTempDirs();
      const missingScriptError = new Error("ENOENT: script missing");
      const permissionDeniedError = new Error("EACCES: permission denied");
      const accessSpy = spyOn(fs.promises, "access").mockImplementationOnce(() => {
        throw missingScriptError;
      });
      const writeFileSpy = spyOn(fs.promises, "writeFile").mockImplementationOnce(() => {
        throw permissionDeniedError;
      });

      let leakedDirs: string[] = [];

      try {
        let error: unknown;
        try {
          await createAskpassSession(() => Promise.resolve("ok"));
        } catch (thrown) {
          error = thrown;
        }

        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) {
          throw new Error("Expected createAskpassSession to throw an Error");
        }
        expect(error.message).toContain("EACCES");

        const tmpAfter = await listAskpassTempDirs();
        const beforeSet = new Set(tmpBefore);
        leakedDirs = tmpAfter.filter((entry) => !beforeSet.has(entry));
        expect(leakedDirs).toHaveLength(0);
      } finally {
        accessSpy.mockRestore();
        writeFileSpy.mockRestore();
        for (const dir of leakedDirs) {
          await fs.promises
            .rm(path.join(askpassSessionsRoot(), dir), { recursive: true, force: true })
            .catch(() => undefined);
        }
      }
    });

    test("handles a single prompt and returns response", async () => {
      const prompts: string[] = [];
      const session = await createAskpassSession((prompt) => {
        prompts.push(prompt);
        return Promise.resolve("yes");
      });

      try {
        const result = await simulateAskpassInvocation(
          session.env.MUX_ASKPASS_DIR,
          "Are you sure you want to continue connecting (yes/no)?",
          "req1"
        );

        expect(result).toBe("yes");
        expect(prompts).toEqual(["Are you sure you want to continue connecting (yes/no)?"]);
      } finally {
        session.cleanup();
      }
    });

    test("handles two sequential prompts without ignoring the second", async () => {
      const prompts: string[] = [];
      const session = await createAskpassSession((prompt) => {
        prompts.push(prompt);
        return Promise.resolve(prompt.includes("continue connecting") ? "yes" : "denied");
      });

      try {
        const askpassDir = session.env.MUX_ASKPASS_DIR;

        const first = await simulateAskpassInvocation(
          askpassDir,
          "Are you sure you want to continue connecting (yes/no)?",
          "1001.1234",
          false
        );
        expect(first).toBe("yes");

        const second = await simulateAskpassInvocation(
          askpassDir,
          "Enter passphrase for key '/home/user/.ssh/id_ed25519':",
          "1001.5678"
        );
        expect(second).toBe("denied");

        expect(prompts).toHaveLength(2);
      } finally {
        session.cleanup();
      }
    });

    test("the script never reads an answer that is still being written (#7498)", async () => {
      const session = await createAskpassSession(() => Promise.resolve("denied"));
      const askpassDir = session.env.MUX_ASKPASS_DIR;
      const requestId = "race";
      const promptFile = path.join(askpassDir, `prompt.${requestId}.txt`);
      const responseFile = path.join(askpassDir, `response.${requestId}.txt`);

      // Force the window that writeFile always has: the answer's file exists but is
      // still empty. Keep it open until the reader (standing in for the script) has
      // looked at the response path once.
      const realWriteFile = fs.promises.writeFile.bind(fs.promises);
      const windowOpen = Promise.withResolvers<void>();
      const readerLooked = Promise.withResolvers<void>();
      const writeFileSpy = spyOn(fs.promises, "writeFile").mockImplementation(
        async (...args: Parameters<typeof fs.promises.writeFile>) => {
          const target = args[0];
          if (typeof target === "string" && target.includes(`response.${requestId}`)) {
            // Create the file as the real call does (same flags), then fill it.
            await realWriteFile(target, "", args[2]);
            windowOpen.resolve();
            await readerLooked.promise;
            return realWriteFile(target, args[1]);
          }
          return realWriteFile(...args);
        }
      );

      try {
        await realWriteFile(`${promptFile}.tmp`, "Enter passphrase:", "utf-8");
        await fs.promises.rename(`${promptFile}.tmp`, promptFile);
        await windowOpen.promise;

        // The script's check: if the response file exists, its text is the answer.
        const readAnswer = () => fs.promises.readFile(responseFile, "utf-8").catch(() => null);
        let answer = await readAnswer();
        readerLooked.resolve();
        // Yield (no timer) until the answer lands.
        for (let i = 0; answer === null && i < 100_000; i += 1) {
          await new Promise((resolve) => setImmediate(resolve));
          answer = await readAnswer();
        }

        expect(answer).toBe("denied\n");
      } finally {
        readerLooked.resolve();
        writeFileSpy.mockRestore();
        session.cleanup();
      }
    });

    test.skipIf(process.platform === "win32")(
      "the askpass script returns the answer to the prompt it was given",
      async () => {
        const prompts: string[] = [];
        const session = await createAskpassSession((prompt) => {
          prompts.push(prompt);
          return Promise.resolve("yes");
        });

        try {
          const prompt = "Are you sure you want to continue connecting (yes/no)?";
          const { stdout } = await promisify(execFile)("sh", [session.env.SSH_ASKPASS, prompt], {
            env: { ...process.env, ...session.env },
          });

          expect(stdout).toBe("yes\n");
          expect(prompts).toEqual([prompt]);
          // The script removes its prompt and answer files, temp names included.
          expect(await fs.promises.readdir(session.env.MUX_ASKPASS_DIR)).toEqual([]);
        } finally {
          session.cleanup();
        }
      }
    );

    test("cleanup is idempotent", async () => {
      // This test closes the session right after creating it. Bun 1.3.5 leaks one blocked
      // thread-pool thread for each real directory watcher closed that early, and enough
      // leaks stall every later fs call in the shared test process (#4715). Cleanup only
      // needs something to close, so hand the session a stand-in watcher.
      const watcher = Object.assign(new EventEmitter(), { close: () => undefined });
      const watch = spyOn(fs, "watch").mockReturnValue(watcher as unknown as fs.FSWatcher);
      try {
        const session = await createAskpassSession(() => Promise.resolve("ok"));
        expect(watch).toHaveBeenCalledTimes(1);

        session.cleanup();
        expect(() => session.cleanup()).not.toThrow();
        const dirRemoved = await fs.promises.access(session.env.MUX_ASKPASS_DIR).then(
          () => false,
          () => true
        );
        expect(dirRemoved).toBe(true);
      } finally {
        watch.mockRestore();
      }
    });

    // Agent commands in the macOS sandbox can write the temp folder, and the sandbox hides
    // askpassSessionsRoot() (agentSandboxTargets.test.ts).
    test("keeps each session in the folder that the sandbox hides", async () => {
      const session = await createAskpassSession(() => Promise.resolve("ok"));
      try {
        expect(path.dirname(session.env.MUX_ASKPASS_DIR)).toBe(askpassSessionsRoot());
      } finally {
        session.cleanup();
      }
    });

    test.skipIf(process.platform === "win32")(
      "does not write an answer through a link at its temp name",
      async () => {
        const session = await createAskpassSession(() => Promise.resolve("secret"));
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "askpass-outside-"));
        const outside = path.join(outsideDir, "target.txt");
        await fs.promises.writeFile(outside, "original");

        try {
          const askpassDir = session.env.MUX_ASKPASS_DIR;
          await fs.promises.symlink(outside, path.join(askpassDir, "response.link.txt.tmp"));

          expect(await simulateAskpassInvocation(askpassDir, "Password:", "link")).toBe("secret");
          expect(await fs.promises.readFile(outside, "utf-8")).toBe("original");
        } finally {
          session.cleanup();
          fs.rmSync(outsideDir, { recursive: true, force: true });
        }
      }
    );

    test("ignores duplicate request IDs", async () => {
      let callCount = 0;
      const session = await createAskpassSession(() => {
        callCount += 1;
        return Promise.resolve("yes");
      });

      try {
        const askpassDir = session.env.MUX_ASKPASS_DIR;
        const requestId = "dup-test";
        const promptFile = path.join(askpassDir, `prompt.${requestId}.txt`);
        const responseFile = path.join(askpassDir, `response.${requestId}.txt`);

        // Simulate duplicate writes for the same askpass request id.
        await fs.promises.writeFile(promptFile, "test prompt", "utf-8");
        await fs.promises.writeFile(promptFile, "test prompt", "utf-8");

        for (let i = 0; i < 100; i += 1) {
          try {
            await fs.promises.access(responseFile);
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(callCount).toBe(1);
      } finally {
        session.cleanup();
      }
    });

    test("session env includes required SSH variables", async () => {
      const session = await createAskpassSession(() => Promise.resolve("ok"));

      try {
        expect(session.env.SSH_ASKPASS).toBeDefined();
        expect(session.env.SSH_ASKPASS_REQUIRE).toBe("force");
        expect(session.env.DISPLAY).toBeDefined();
        expect(session.env.MUX_ASKPASS_DIR).toBeDefined();

        const stat = await fs.promises.stat(session.env.MUX_ASKPASS_DIR);
        expect(stat.isDirectory()).toBe(true);
      } finally {
        session.cleanup();
      }
    });

    test("writes mux-askpass under getXumHome() instead of creating ~/.mux", async () => {
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "xum-askpass-home-"));
      const previousRoot = process.env.XUM_ROOT;
      process.env.XUM_ROOT = isolatedHome;
      // Force rewrite if an earlier test cached a helper from a different home.
      const accessSpy = spyOn(fs.promises, "access").mockRejectedValueOnce(new Error("missing"));

      try {
        const session = await createAskpassSession(() => Promise.resolve("ok"));
        try {
          const expectedPath = path.join(getXumHome(), "bin", "mux-askpass");
          expect(session.env.SSH_ASKPASS).toBe(expectedPath);
          expect((await fs.promises.stat(expectedPath)).isFile()).toBe(true);
          expect(expectedPath.startsWith(path.join(os.homedir(), ".mux"))).toBe(false);
        } finally {
          session.cleanup();
        }
      } finally {
        accessSpy.mockRestore();
        if (previousRoot === undefined) {
          delete process.env.XUM_ROOT;
        } else {
          process.env.XUM_ROOT = previousRoot;
        }
        fs.rmSync(isolatedHome, { recursive: true, force: true });
      }
    });
  });

  describe("parseHostKeyPrompt", () => {
    test("parses standard host-key prompt", () => {
      const text =
        "The authenticity of host 'example.com (1.2.3.4)' can't be established.\n" +
        "ED25519 key fingerprint is SHA256:abcdef123456\n" +
        "Are you sure you want to continue connecting (yes/no/[fingerprint])?";

      const result = parseHostKeyPrompt(text);

      expect(result.host).toBe("example.com (1.2.3.4)");
      expect(result.keyType).toBe("ED25519");
      expect(result.fingerprint).toBe("SHA256:abcdef123456");
    });

    test("returns unknown for non-host-key text", () => {
      const result = parseHostKeyPrompt("Enter passphrase for key '/home/user/.ssh/id_ed25519':");

      expect(result.host).toBe("unknown");
      expect(result.keyType).toBe("unknown");
      expect(result.fingerprint).toBe("unknown");
    });
  });
});
