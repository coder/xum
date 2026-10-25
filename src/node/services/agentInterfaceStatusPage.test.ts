import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { AGENT_INTERFACE_STATUS_ARTIFACT } from "@/common/constants/artifacts";
import type { CompletedMessagePart } from "@/common/types/stream";
import {
  AGENT_INTERFACE_STATUS_TEMPLATE,
  needsStatusPageTurnEndNudge,
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
    expect(await prepare(ALL_ON)).not.toBeNull();
    expect(await fs.readFile(statusPath(), "utf8")).toBe(AGENT_INTERFACE_STATUS_TEMPLATE);
  });

  test("never overwrites a page the agent wrote", async () => {
    await fs.mkdir(artifactsDir);
    await fs.writeFile(statusPath(), "<p>agent status</p>");
    expect(await prepare(ALL_ON)).not.toBeNull();
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
      expect(await prepare(flags)).toBeNull();
      expect(existsSync(statusPath())).toBe(false);
    }
  );

  test("a failing location does not throw into the turn", async () => {
    const active = prepareAgentInterfaceStatusPage({
      ...ALL_ON,
      resolveLocation: () => Promise.reject(new Error("runtime unreachable")),
    });
    expect(await active).not.toBeNull();
  });
});

describe("needsStatusPageTurnEndNudge", () => {
  let scratchDir: string;
  let artifactsDir: string;
  const statusPath = () => path.join(artifactsDir, AGENT_INTERFACE_STATUS_ARTIFACT);
  const startTurn = () =>
    prepareAgentInterfaceStatusPage({
      ...ALL_ON,
      resolveLocation: () => Promise.resolve({ kind: "host", dir: artifactsDir }),
    });
  const writePage = async (content: string) => {
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(statusPath(), content);
  };
  const toolCall = (output: unknown): CompletedMessagePart => ({
    type: "dynamic-tool",
    toolCallId: "bash-1",
    toolName: "bash",
    input: { script: "make test" },
    state: "output-available",
    output,
  });
  const ranTools: CompletedMessagePart[] = [
    toolCall({ success: true }),
    { type: "text", text: "Done." },
  ];
  const nestedTools: CompletedMessagePart[] = [
    {
      type: "dynamic-tool",
      toolCallId: "code-1",
      toolName: "code_execution",
      input: { code: "" },
      state: "output-available",
      output: { result: 1 },
      nestedCalls: [
        {
          toolCallId: "bash-1",
          toolName: "bash",
          input: { script: "make test" },
          state: "output-available",
          output: { success: true },
        },
      ],
    },
  ];
  const failedTools: CompletedMessagePart[] = [toolCall({ success: false, error: "exit 2" })];
  const textOnly: CompletedMessagePart[] = [{ type: "text", text: "Hello." }];

  beforeEach(async () => {
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-interface-nudge-"));
    artifactsDir = path.join(scratchDir, "artifacts");
  });

  afterEach(async () => {
    await fs.rm(scratchDir, { recursive: true, force: true });
  });

  test.each([
    {
      name: "a tool-free turn left the placeholder",
      agentPage: false,
      parts: textOnly,
      nudge: true,
    },
    {
      name: "a turn that ran tools left the page unchanged",
      agentPage: true,
      parts: ranTools,
      nudge: true,
    },
    {
      name: "a nested tool call left the page unchanged",
      agentPage: true,
      parts: nestedTools,
      nudge: true,
    },
    {
      name: "a tool-free turn left the agent's page unchanged",
      agentPage: true,
      parts: textOnly,
      nudge: false,
    },
    {
      name: "a failed tool call left the page unchanged",
      agentPage: true,
      parts: failedTools,
      nudge: false,
    },
  ])("$name: nudge $nudge", async (row) => {
    if (row.agentPage) await writePage("<p>Fixing the build</p>");
    const turn = await startTurn();
    expect(await needsStatusPageTurnEndNudge({ turn: turn ?? undefined, parts: row.parts })).toBe(
      row.nudge
    );
  });

  test("a turn that updated the page gets no nudge", async () => {
    const turn = await startTurn();
    await writePage("<p>Build fixed</p>");
    expect(await needsStatusPageTurnEndNudge({ turn: turn ?? undefined, parts: ranTools })).toBe(
      false
    );
  });

  test("a page the agent deleted is seeded again and gets the nudge", async () => {
    const turn = await startTurn();
    await fs.rm(statusPath());
    expect(await needsStatusPageTurnEndNudge({ turn: turn ?? undefined, parts: textOnly })).toBe(
      true
    );
    expect(await fs.readFile(statusPath(), "utf8")).toBe(AGENT_INTERFACE_STATUS_TEMPLATE);
  });

  test("a folder at the page's path gets no nudge", async () => {
    const turn = await startTurn();
    await fs.rm(statusPath());
    await fs.mkdir(statusPath());
    expect(await needsStatusPageTurnEndNudge({ turn: turn ?? undefined, parts: ranTools })).toBe(
      false
    );
  });

  test.each([
    { name: "a small page", bytes: 64 },
    { name: "an oversize page", bytes: 1024 * 1024 + 1 },
  ])("a turn that only touched $name gets the nudge", async (row) => {
    await writePage(`<p>${"x".repeat(row.bytes)}</p>`);
    const turn = await startTurn();
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(statusPath(), later, later);
    expect(await needsStatusPageTurnEndNudge({ turn: turn ?? undefined, parts: ranTools })).toBe(
      true
    );
  });

  test("an inactive view gets no nudge", async () => {
    expect(await needsStatusPageTurnEndNudge({ turn: undefined, parts: ranTools })).toBe(false);
  });

  test("a location that fails at turn end gets no nudge and does not throw", async () => {
    const turn = await startTurn();
    expect(turn).not.toBeNull();
    const failing = {
      startFingerprint: turn?.startFingerprint ?? null,
      resolveLocation: () => Promise.reject(new Error("runtime unreachable")),
    };
    expect(await needsStatusPageTurnEndNudge({ turn: failing, parts: ranTools })).toBe(false);
  });
});
