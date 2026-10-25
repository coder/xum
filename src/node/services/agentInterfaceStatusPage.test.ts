import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { AGENT_INTERFACE_STATUS_ARTIFACT } from "@/common/constants/artifacts";
import {
  AGENT_INTERFACE_STATUS_TEMPLATE,
  prepareAgentInterfaceStatusPage,
} from "./agentInterfaceStatusPage";
import type { ArtifactsLocation } from "./artifactsOperations";

const ALL_ON = {
  scratchDirSet: true,
  artifactsEnabled: true,
  agentInterfaceEnabled: true,
  sideChat: false,
  compactionRequest: false,
};

describe("prepareAgentInterfaceStatusPage", () => {
  let scratchDir: string;
  let artifactsDir: string;
  let location: ArtifactsLocation;
  const statusPath = () => path.join(artifactsDir, AGENT_INTERFACE_STATUS_ARTIFACT);
  const prepare = (flags: typeof ALL_ON) =>
    prepareAgentInterfaceStatusPage({ ...flags, resolveLocation: () => Promise.resolve(location) });

  beforeEach(async () => {
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-interface-seed-"));
    artifactsDir = path.join(scratchDir, "artifacts");
    location = { kind: "host", dir: artifactsDir };
  });

  afterEach(async () => {
    await fs.rm(scratchDir, { recursive: true, force: true });
  });

  test("writes the template when the status page is missing", async () => {
    expect(await prepare(ALL_ON)).toBe(true);
    expect(await fs.readFile(statusPath(), "utf8")).toBe(AGENT_INTERFACE_STATUS_TEMPLATE);
  });

  test("never overwrites a page the agent wrote", async () => {
    await fs.mkdir(artifactsDir);
    await fs.writeFile(statusPath(), "<p>agent status</p>");
    expect(await prepare(ALL_ON)).toBe(true);
    expect(await fs.readFile(statusPath(), "utf8")).toBe("<p>agent status</p>");
  });

  test.each([
    { ...ALL_ON, artifactsEnabled: false },
    { ...ALL_ON, agentInterfaceEnabled: false },
    { ...ALL_ON, scratchDirSet: false },
    { ...ALL_ON, sideChat: true },
    { ...ALL_ON, compactionRequest: true },
  ])(
    "is inactive and writes nothing unless both flags are on in a main chat turn that is not a compaction, with a scratch dir (%o)",
    async (flags) => {
      expect(await prepare(flags)).toBe(false);
      expect(existsSync(statusPath())).toBe(false);
    }
  );

  test("a failing location does not throw into the turn", async () => {
    const active = prepareAgentInterfaceStatusPage({
      ...ALL_ON,
      resolveLocation: () => Promise.reject(new Error("runtime unreachable")),
    });
    expect(await active).toBe(true);
  });
});
