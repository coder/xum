import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { ExperimentsService } from "./experimentsService";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { TelemetryService } from "./telemetryService";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const OVERRIDES_FILE = "feature_flags.json";

function createTelemetryService(): {
  telemetryService: TelemetryService;
  setFeatureFlagVariant: ReturnType<typeof mock>;
} {
  const setFeatureFlagVariant = mock(() => undefined);
  return {
    telemetryService: { setFeatureFlagVariant } as unknown as TelemetryService,
    setFeatureFlagVariant,
  };
}

describe("ExperimentsService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-experiments-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function readOverridesFile(): Promise<{
    experiments?: unknown;
    overrides?: Record<string, unknown>;
  }> {
    const raw = await fs.readFile(path.join(tempDir, OVERRIDES_FILE), "utf-8");
    return JSON.parse(raw) as { experiments?: unknown; overrides?: Record<string, unknown> };
  }

  test("experiments are disabled until the user sets an override", async () => {
    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.initialize();

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)).toBe(false);

    await service.setOverride(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING, true);

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)).toBe(true);
  });

  test("overrides survive a restart and re-apply their telemetry variant", async () => {
    const first = createTelemetryService();
    const service = new ExperimentsService({
      telemetryService: first.telemetryService,
      xumHome: tempDir,
    });
    await service.setOverride(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES, true);

    expect((await readOverridesFile()).overrides).toEqual({
      [EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES]: true,
    });

    const second = createTelemetryService();
    const reloaded = new ExperimentsService({
      telemetryService: second.telemetryService,
      xumHome: tempDir,
    });
    await reloaded.initialize();

    expect(reloaded.isExperimentEnabled(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES)).toBe(true);
    expect(second.setFeatureFlagVariant).toHaveBeenCalledWith(
      EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES,
      true
    );
  });

  test("clearing an override disables the experiment and drops its telemetry variant", async () => {
    const { telemetryService, setFeatureFlagVariant } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.setOverride(EXPERIMENT_IDS.MEMORY, true);

    await service.setOverride(EXPERIMENT_IDS.MEMORY, null);

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.MEMORY)).toBe(false);
    expect((await readOverridesFile()).overrides).toEqual({});
    expect(setFeatureFlagVariant).toHaveBeenLastCalledWith(EXPERIMENT_IDS.MEMORY, null);
  });

  test("an explicit false override keeps the experiment disabled", async () => {
    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.setOverride(EXPERIMENT_IDS.AGENT_BROWSER, false);

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.AGENT_BROWSER)).toBe(false);
    expect((await readOverridesFile()).overrides).toEqual({
      [EXPERIMENT_IDS.AGENT_BROWSER]: false,
    });
  });

  test("platform-restricted experiments ignore overrides on unsupported platforms", async () => {
    await fs.writeFile(
      path.join(tempDir, OVERRIDES_FILE),
      JSON.stringify({
        version: 1,
        experiments: {},
        overrides: { [EXPERIMENT_IDS.PORTABLE_DESKTOP]: true },
      }),
      "utf-8"
    );

    const { telemetryService, setFeatureFlagVariant } = createTelemetryService();
    const service = new ExperimentsService({
      telemetryService,
      xumHome: tempDir,
      platform: "darwin",
    });
    await service.initialize();

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.PORTABLE_DESKTOP)).toBe(false);

    await service.setOverride(EXPERIMENT_IDS.PORTABLE_DESKTOP, true);

    expect((await readOverridesFile()).overrides).toEqual({});
    expect(setFeatureFlagVariant).toHaveBeenCalledWith(EXPERIMENT_IDS.PORTABLE_DESKTOP, null);
  });

  test("overrides written by a build with remote evaluation still load", async () => {
    await fs.writeFile(
      path.join(tempDir, OVERRIDES_FILE),
      JSON.stringify({
        version: 1,
        experiments: {
          [EXPERIMENT_IDS.TOOL_SEARCH]: { value: "test", fetchedAtMs: Date.now() },
        },
        overrides: { [EXPERIMENT_IDS.AGENT_BROWSER]: true },
      }),
      "utf-8"
    );

    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.initialize();

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.AGENT_BROWSER)).toBe(true);
    // A cached remote assignment must not survive as an implicit opt-in.
    expect(service.isExperimentEnabled(EXPERIMENT_IDS.TOOL_SEARCH)).toBe(false);
  });

  test("stale overrides for removed experiments are ignored, never rejected", async () => {
    // "programmatic-tool-calling-exclusive" was a real experiment ID before
    // PTC became exclusive-only. Users upgrading with the old key persisted
    // must load cleanly with the stale entry filtered out.
    await fs.writeFile(
      path.join(tempDir, OVERRIDES_FILE),
      JSON.stringify({
        version: 1,
        experiments: {},
        overrides: {
          "programmatic-tool-calling-exclusive": true,
          [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: true,
        },
      }),
      "utf-8"
    );

    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.initialize();

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)).toBe(true);
    expect(await service.getOverrides()).toEqual({
      [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: true,
    });
  });

  test("a client with empty local state does not clear overrides it never knew about", async () => {
    await fs.writeFile(
      path.join(tempDir, OVERRIDES_FILE),
      JSON.stringify({
        version: 1,
        experiments: {},
        overrides: { [EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT]: true },
      }),
      "utf-8"
    );

    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.initialize();

    // A second renderer (different origin, so empty localStorage) uploads nothing and
    // reads state back. It must not disable what another client persisted.
    await service.setOverride(EXPERIMENT_IDS.AGENT_BROWSER, true);

    expect(await service.getOverrides()).toEqual({
      [EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT]: true,
      [EXPERIMENT_IDS.AGENT_BROWSER]: true,
    });
    expect(service.isExperimentEnabled(EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT)).toBe(true);
  });

  test("getOverrides hides overrides for platform-unsupported experiments", async () => {
    await fs.writeFile(
      path.join(tempDir, OVERRIDES_FILE),
      JSON.stringify({
        version: 1,
        experiments: {},
        overrides: { [EXPERIMENT_IDS.PORTABLE_DESKTOP]: true },
      }),
      "utf-8"
    );

    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({
      telemetryService,
      xumHome: tempDir,
      platform: "darwin",
    });

    expect(await service.getOverrides()).toEqual({});
  });

  test("writes an empty experiments map so older builds still read overrides", async () => {
    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.setOverride(EXPERIMENT_IDS.TIMELINE, true);

    expect((await readOverridesFile()).experiments).toEqual({});
  });
});
