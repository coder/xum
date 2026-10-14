/**
 * $XUM_SCRATCH_DIR and the Artifacts tab on SSH and Docker runtimes, against a real sshd
 * container (Alpine: busybox stat/head/readlink, so this also proves the listing and read
 * scripts work without GNU tools). The same container doubles as the Docker runtime's
 * container, like runtime.test.ts.
 */

// Jest globals are available automatically - no need to import
import { execBuffered } from "@/node/utils/runtime/helpers";
import type { Runtime } from "@/node/runtime/Runtime";
import type { RuntimeConfig } from "@/common/types/runtime";
import {
  DOCKER_SCRATCH_DIR,
  RUNTIME_SCRATCH_DIR_NAME,
  ensureScratchDirForSpec,
  removeRuntimeScratchDir,
  resolveScratchDirSpec,
} from "@/node/runtime/runtimeScratchDir";
import {
  listArtifactsOnRuntime,
  readArtifactOnRuntime,
} from "@/node/services/artifactRuntimeStore";
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "./test-fixtures/ssh-fixture";
import { createTestRuntime } from "./test-fixtures/test-helpers";

function shouldRunIntegrationTests(): boolean {
  return process.env.TEST_INTEGRATION === "1" || process.env.TEST_INTEGRATION === "true";
}
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

let sshConfig: SSHServerConfig | undefined;

describeIntegration("runtime scratch dir and artifacts", () => {
  beforeAll(async () => {
    if (!(await isDockerAvailable())) {
      throw new Error("Docker is required for runtime integration tests.");
    }
    sshConfig = await startSSHServer();
  }, 120000);

  afterAll(async () => {
    if (sshConfig) await stopSSHServer(sshConfig);
  }, 30000);

  const cases: { type: "ssh" | "docker"; runtimeConfig: RuntimeConfig }[] = [
    {
      type: "ssh",
      runtimeConfig: { type: "ssh", host: "testuser@localhost", srcBaseDir: "~/src" },
    },
    { type: "docker", runtimeConfig: { type: "docker", image: "mux-ssh-test" } },
  ];

  test.each(cases)(
    "$type: creates the scratch dir, lists and reads artifacts through the runtime",
    async ({ type, runtimeConfig }) => {
      const runtime: Runtime = createTestRuntime(
        type,
        type === "ssh" ? sshConfig!.workdir : "/src",
        sshConfig,
        type === "docker"
          ? { image: "mux-ssh-test", containerName: sshConfig!.containerId }
          : undefined
      );
      const workspaceId = `scratch${Date.now().toString(36)}`;
      const spec = await resolveScratchDirSpec({
        runtimeConfig,
        workspaceId,
        sessionsDir: "/unused-host-sessions",
        runtime,
      });

      const scratchDir = await ensureScratchDirForSpec(runtime, spec);

      expect(scratchDir).toBe(
        type === "ssh"
          ? `/home/testuser/.mux/${RUNTIME_SCRATCH_DIR_NAME}/${workspaceId}`
          : DOCKER_SCRATCH_DIR
      );
      const artifactsDir = `${scratchDir!}/artifacts`;
      const setup = await execBuffered(
        runtime,
        [
          `mkdir -p "$D/reports" "$D/.git"`,
          `printf '# Summary' > "$D/reports/summary.md"`,
          `printf 'a b' > "$D/with space.txt"`,
          `printf 'nl' > "$D/line
break.md"`,
          `printf 'x' > "$D/.hidden.md"`,
          `printf 'secret' > /tmp/xum-secret-${type}.md`,
          `ln -s /tmp/xum-secret-${type}.md "$D/link.md"`,
          `ln -s /tmp "$D/out"`,
          `head -c 2048 /dev/zero | tr '\\0' 'x' > "$D/big.txt"`,
        ].join(" && "),
        { cwd: "/", env: { D: artifactsDir }, timeout: 30 }
      );
      expect({ exitCode: setup.exitCode, stderr: setup.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });

      const listing = await listArtifactsOnRuntime(runtime, artifactsDir);
      expect(listing.dir).toBe(artifactsDir);
      expect(listing.truncated).toBe(false);
      expect(listing.entries.map((entry) => [entry.path, entry.kind, entry.size]).sort()).toEqual(
        [
          ["big.txt", "text", 2048],
          ["line\nbreak.md", "markdown", 2],
          ["reports/summary.md", "markdown", 9],
          ["with space.txt", "text", 3],
        ].sort()
      );
      expect(listing.entries.every((entry) => entry.modifiedMs > 0)).toBe(true);

      expect(
        await readArtifactOnRuntime(runtime, artifactsDir, "reports/summary.md", 1024)
      ).toMatchObject({
        success: true,
        data: { status: "ok", encoding: "utf8", content: "# Summary", size: 9 },
      });
      expect(await readArtifactOnRuntime(runtime, artifactsDir, "big.txt", 1024)).toMatchObject({
        success: true,
        data: { status: "too_large", size: 2048, maxBytes: 1024 },
      });
      // Fresh secret path per case: protected_regular blocks writing another user's /tmp file.
      for (const relPath of ["link.md", `out/xum-secret-${type}.md`, "missing.md"]) {
        expect(await readArtifactOnRuntime(runtime, artifactsDir, relPath, 1024)).toEqual({
          success: false,
          error: `Artifact not found: ${relPath}`,
        });
      }

      if (type === "ssh") {
        // Removal deletes the SSH host's scratch dir.
        expect(await removeRuntimeScratchDir(runtime, workspaceId)).toBe(true);
        const gone = await execBuffered(runtime, `test -e "$D"`, {
          cwd: "/",
          env: { D: scratchDir! },
          timeout: 30,
        });
        expect(gone.exitCode).not.toBe(0);
      } else {
        await execBuffered(runtime, `rm -rf "$D"`, {
          cwd: "/",
          env: { D: artifactsDir },
          timeout: 30,
        });
      }
    },
    90000
  );
});
