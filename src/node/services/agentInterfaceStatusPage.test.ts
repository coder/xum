import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { AGENT_INTERFACE_STATUS_ARTIFACT } from "@/common/constants/artifacts";
import {
  AGENT_INTERFACE_STATUS_TEMPLATE,
  seedAgentInterfaceStatusPage,
} from "./agentInterfaceStatusPage";
import type { ArtifactsLocation } from "./artifactsOperations";

describe("seedAgentInterfaceStatusPage", () => {
  let scratchDir: string;
  let artifactsDir: string;
  let location: ArtifactsLocation;
  const statusPath = () => path.join(artifactsDir, AGENT_INTERFACE_STATUS_ARTIFACT);
  const seed = (flags: { artifactsEnabled: boolean; agentInterfaceEnabled: boolean }) =>
    seedAgentInterfaceStatusPage({ ...flags, resolveLocation: () => Promise.resolve(location) });

  beforeEach(async () => {
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-interface-seed-"));
    artifactsDir = path.join(scratchDir, "artifacts");
    location = { kind: "host", dir: artifactsDir };
  });

  afterEach(async () => {
    await fs.rm(scratchDir, { recursive: true, force: true });
  });

  test("writes the template when the status page is missing", async () => {
    expect(await seed({ artifactsEnabled: true, agentInterfaceEnabled: true })).toBe(true);
    expect(await fs.readFile(statusPath(), "utf8")).toBe(AGENT_INTERFACE_STATUS_TEMPLATE);
  });

  test("never overwrites a page the agent wrote", async () => {
    await fs.mkdir(artifactsDir);
    await fs.writeFile(statusPath(), "<p>agent status</p>");
    expect(await seed({ artifactsEnabled: true, agentInterfaceEnabled: true })).toBe(false);
    expect(await fs.readFile(statusPath(), "utf8")).toBe("<p>agent status</p>");
  });

  test.each([
    { artifactsEnabled: false, agentInterfaceEnabled: true },
    { artifactsEnabled: true, agentInterfaceEnabled: false },
  ])("writes nothing unless both flags are on (%o)", async (flags) => {
    expect(await seed(flags)).toBe(false);
    await expect(fs.stat(statusPath())).rejects.toThrow();
  });

  test("a failing location does not throw into the turn", async () => {
    const failing = seedAgentInterfaceStatusPage({
      artifactsEnabled: true,
      agentInterfaceEnabled: true,
      resolveLocation: () => Promise.reject(new Error("runtime unreachable")),
    });
    expect(await failing).toBe(false);
  });
});
