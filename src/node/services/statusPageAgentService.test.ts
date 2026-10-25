import { describe, expect, it } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";

import {
  AGENT_INTERFACE_STATUS_ARTIFACT,
  STATUS_PAGE_AGENT_MAX_PENDING_UPDATES,
} from "@/common/constants/artifacts";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { Ok } from "@/common/types/result";
import { Config } from "@/node/config";
import { resolveArtifactsLocation } from "./artifactsOperations";
import { StatusPageAgentService } from "./statusPageAgentService";
import { TestTempDir } from "./tools/testHelpers";

/**
 * Behavior under test: the host queue around the status page runner: batching of updates that
 * arrive during a pass, the experiment and workspace gates, error and drop hand-back on the next
 * enqueue, concurrent page edits, the write-only-on-change rule and the Settings > Agents model
 * choice.
 */

const WORKSPACE_ID = "ws-status";
const MAIN_MODEL = "anthropic:main-model";
const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};

type Behavior = "write" | "noop" | "fail";

function userPromptText(options: LanguageModelV3CallOptions): string {
  return options.prompt
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

function finishWithText(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
  ];
}

/** One pass's model: "write" rewrites the page to name the pass, then finishes. */
function passModel(behavior: Behavior, pass: number, prompts: string[]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: (options) => {
      if (call === 0) prompts.push(userPromptText(options));
      call++;
      if (behavior === "fail") {
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            pull(controller) {
              controller.error(new Error("provider exploded"));
            },
          }),
        });
      }
      const chunks: LanguageModelV3StreamPart[] =
        behavior === "write" && call === 1
          ? [
              {
                type: "tool-call",
                toolCallId: `write-${pass}`,
                toolName: "write_page",
                input: JSON.stringify({ html: `<p>pass ${pass}</p>` }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: USAGE,
              },
            ]
          : finishWithText("done");
      return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
    },
  });
}

async function createFixture() {
  const tempDir = new TestTempDir("test-status-page-agent-service");
  const config = new Config(path.join(tempDir.path, "xum-home"));
  await config.editConfig((cfg) => {
    cfg.projects.set("/projects/demo", {
      workspaces: [{ id: WORKSPACE_ID, name: WORKSPACE_ID, path: "/projects/demo/ws" }],
    });
    return cfg;
  });
  // The artifact writer refuses to recreate a deleted session dir, so a live one must exist.
  await fsPromises.mkdir(path.join(config.sessionsDir, WORKSPACE_ID), { recursive: true });

  const metadata: {
    runtimeConfig: { type: "local" };
    projectPath: string;
    name: string;
    namedWorkspacePath: string;
    archivedAt?: string;
  } = {
    runtimeConfig: { type: "local" },
    projectPath: "/projects/demo",
    name: WORKSPACE_ID,
    namedWorkspacePath: "/projects/demo/ws",
  };
  const location = await resolveArtifactsLocation(config.sessionsDir, WORKSPACE_ID, metadata);
  if (location.kind !== "host") throw new Error("expected a host artifacts location");
  const pagePath = path.join(location.dir, AGENT_INTERFACE_STATUS_ARTIFACT);

  const state = {
    enabled: new Set<ExperimentId>([
      EXPERIMENT_IDS.ARTIFACTS,
      EXPERIMENT_IDS.ARTIFACTS_AGENT_INTERFACE,
      EXPERIMENT_IDS.ARTIFACTS_STATUS_PAGE_AGENT,
    ]),
    removing: false,
    behavior: "write" as Behavior,
    gate: null as Promise<void> | null,
    /** Called when a pass asks for its model, before it waits on the gate. */
    onModelRequested: null as (() => void) | null,
  };
  const modelStrings: string[] = [];
  const prompts: string[] = [];
  const usageRecords: Array<{ model: string; source: string | undefined }> = [];

  const service = new StatusPageAgentService({
    config,
    isExperimentEnabled: (id) => state.enabled.has(id),
    getWorkspaceMetadata: () => Promise.resolve(metadata),
    isWorkspaceRemoving: () => state.removing,
    modelFactory: {
      createModelWithPinnedMetadata: async (modelString) => {
        modelStrings.push(modelString);
        state.onModelRequested?.();
        if (state.gate) await state.gate;
        return Ok({
          model: passModel(state.behavior, modelStrings.length, prompts),
          metadataModel: modelString,
        });
      },
    },
    sessionUsageService: {
      recordHeadlessUsage: (_workspaceId, model, _usage, _metadata, options) => {
        usageRecords.push({ model, source: options?.analyticsSource });
        return Promise.resolve(undefined);
      },
    },
  });

  return {
    config,
    service,
    state,
    metadata,
    modelStrings,
    prompts,
    usageRecords,
    pagePath,
    enqueue: (update: string) =>
      service.enqueue(WORKSPACE_ID, { update, fallbackModel: MAIN_MODEL }),
    readPage: async () => {
      try {
        return await fsPromises.readFile(pagePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    whenIdle: () => service.whenIdle(WORKSPACE_ID),
    [Symbol.dispose]() {
      tempDir[Symbol.dispose]();
    },
  };
}

describe("StatusPageAgentService", () => {
  it("batches updates that arrive during a pass into exactly one next pass", async () => {
    using fixture = await createFixture();
    let release!: () => void;
    fixture.state.gate = new Promise((resolve) => (release = resolve));

    expect(fixture.enqueue("first update")).toEqual({ queued: true });
    fixture.enqueue("second update");
    fixture.enqueue("third update");
    release();
    await fixture.whenIdle();

    expect(fixture.modelStrings).toHaveLength(2);
    expect(fixture.prompts[0]).toContain("first update");
    expect(fixture.prompts[0]).not.toContain("second update");
    expect(fixture.prompts[1]).toContain("second update");
    expect(fixture.prompts[1]).toContain("third update");
    expect(await fixture.readPage()).toBe("<p>pass 2</p>");
  });

  it("makes no model call and no write while a gate is closed", async () => {
    const gates: Array<[string, (fixture: Awaited<ReturnType<typeof createFixture>>) => unknown]> =
      [
        [
          "status page agent off",
          (f) => f.state.enabled.delete(EXPERIMENT_IDS.ARTIFACTS_STATUS_PAGE_AGENT),
        ],
        [
          "agent interface view off",
          (f) => f.state.enabled.delete(EXPERIMENT_IDS.ARTIFACTS_AGENT_INTERFACE),
        ],
        ["artifacts off", (f) => f.state.enabled.delete(EXPERIMENT_IDS.ARTIFACTS)],
        ["workspace removing", (f) => (f.state.removing = true)],
        ["workspace archived", (f) => (f.metadata.archivedAt = new Date().toISOString())],
        [
          "switched off in Settings > Agents",
          (f) =>
            f.config.editConfig((cfg) => ({
              ...cfg,
              agentAiDefaults: { status_page: { enabled: false } },
            })),
        ],
      ];
    for (const [label, closeGate] of gates) {
      using fixture = await createFixture();
      await closeGate(fixture);
      fixture.enqueue("an update");
      await fixture.whenIdle();
      expect({ label, calls: fixture.modelStrings.length }).toEqual({ label, calls: 0 });
      expect({ label, page: await fixture.readPage() }).toEqual({ label, page: null });
    }
  });

  it("does not write when the workspace is archived while the pass runs", async () => {
    using fixture = await createFixture();
    let release!: () => void;
    fixture.state.gate = new Promise((resolve) => (release = resolve));
    const modelRequested = new Promise<void>(
      (resolve) => (fixture.state.onModelRequested = resolve)
    );
    fixture.enqueue("an update");
    await modelRequested;
    fixture.metadata.archivedAt = new Date().toISOString();
    release();
    await fixture.whenIdle();

    expect(fixture.modelStrings).toHaveLength(1);
    expect(await fixture.readPage()).toBeNull();
  });

  it("hands a failed pass's error to the next enqueue once and leaves the page", async () => {
    using fixture = await createFixture();
    await fsPromises.mkdir(path.dirname(fixture.pagePath), { recursive: true });
    await fsPromises.writeFile(fixture.pagePath, "<p>before</p>");
    fixture.state.behavior = "fail";
    fixture.enqueue("an update");
    await fixture.whenIdle();
    expect(await fixture.readPage()).toBe("<p>before</p>");
    expect(fixture.usageRecords).toHaveLength(0);

    fixture.state.behavior = "noop";
    expect(fixture.enqueue("next update").previousError).toContain("provider exploded");
    await fixture.whenIdle();
    expect(fixture.enqueue("later update").previousError).toBeUndefined();
    await fixture.whenIdle();
  });

  it("retries a failed pass's updates with the next pass and drops the note once it succeeds", async () => {
    using fixture = await createFixture();
    fixture.state.behavior = "fail";
    let passes = 0;
    fixture.state.onModelRequested = () => {
      if (++passes === 2) fixture.state.behavior = "write";
    };

    fixture.enqueue("first update");
    // Lands while the first pass runs, so it is batched into the second one.
    fixture.enqueue("second update");
    await fixture.whenIdle();

    expect(fixture.prompts[0]).not.toContain("second update");
    expect(fixture.prompts[1]).toContain("first update");
    expect(fixture.prompts[1]).toContain("second update");
    expect(await fixture.readPage()).toBe("<p>pass 2</p>");
    expect(fixture.enqueue("third update").previousError).toBeUndefined();
    await fixture.whenIdle();
  });

  it("keeps an edit made to the page during a pass and applies the updates on top later", async () => {
    using fixture = await createFixture();
    await fsPromises.mkdir(path.dirname(fixture.pagePath), { recursive: true });
    await fsPromises.writeFile(fixture.pagePath, "<p>before</p>");
    let release!: () => void;
    fixture.state.gate = new Promise((resolve) => (release = resolve));
    const modelRequested = new Promise<void>(
      (resolve) => (fixture.state.onModelRequested = resolve)
    );
    fixture.enqueue("first update");
    await modelRequested;
    await fsPromises.writeFile(fixture.pagePath, "<p>edited by the main agent</p>");
    release();
    await fixture.whenIdle();
    expect(await fixture.readPage()).toBe("<p>edited by the main agent</p>");

    fixture.state.gate = null;
    expect(fixture.enqueue("second update").previousError).toContain("changed");
    await fixture.whenIdle();
    expect(fixture.prompts[1]).toContain("edited by the main agent");
    expect(fixture.prompts[1]).toContain("first update");
    expect(await fixture.readPage()).toBe("<p>pass 2</p>");
  });

  it("reports updates the queue caps dropped once, on the enqueue that dropped them", async () => {
    using fixture = await createFixture();
    let release!: () => void;
    fixture.state.gate = new Promise((resolve) => (release = resolve));
    // The first update starts a pass at once; the next ones wait in the queue behind it.
    fixture.enqueue("running update");
    const results = Array.from({ length: STATUS_PAGE_AGENT_MAX_PENDING_UPDATES + 2 }, (_, i) =>
      fixture.enqueue(`queued update ${i}`)
    );
    release();
    await fixture.whenIdle();

    expect(results.map((result) => result.discardedUpdates ?? 0)).toEqual([
      ...Array<number>(STATUS_PAGE_AGENT_MAX_PENDING_UPDATES).fill(0),
      1,
      1,
    ]);
    expect(fixture.enqueue("later update").discardedUpdates).toBeUndefined();
    await fixture.whenIdle();
  });

  it("reports the updates of a pass cut short by a closed gate and never applies them", async () => {
    using fixture = await createFixture();
    let release!: () => void;
    fixture.state.gate = new Promise((resolve) => (release = resolve));
    const modelRequested = new Promise<void>(
      (resolve) => (fixture.state.onModelRequested = resolve)
    );
    fixture.enqueue("cut short update");
    await modelRequested;
    fixture.state.enabled.delete(EXPERIMENT_IDS.ARTIFACTS_STATUS_PAGE_AGENT);
    release();
    await fixture.whenIdle();
    expect(await fixture.readPage()).toBeNull();

    fixture.state.enabled.add(EXPERIMENT_IDS.ARTIFACTS_STATUS_PAGE_AGENT);
    fixture.state.gate = null;
    expect(fixture.enqueue("next update").discardedUpdates).toBe(1);
    await fixture.whenIdle();
    expect(fixture.prompts[1]).not.toContain("cut short update");
  });

  it("drops a failed pass's updates and error on discard, reporting only the drop", async () => {
    using fixture = await createFixture();
    fixture.state.behavior = "fail";
    fixture.enqueue("failed update");
    await fixture.whenIdle();

    fixture.service.discard(WORKSPACE_ID);
    fixture.state.behavior = "write";
    const result = fixture.enqueue("after the mode came back");
    await fixture.whenIdle();

    expect(result).toEqual({ queued: true, discardedUpdates: 1 });
    expect(fixture.prompts[1]).not.toContain("failed update");
    expect(fixture.prompts[1]).toContain("after the mode came back");
  });

  it("writes nothing when the agent leaves the page unchanged", async () => {
    using fixture = await createFixture();
    fixture.state.behavior = "noop";
    fixture.enqueue("an update");
    await fixture.whenIdle();

    expect(fixture.modelStrings).toHaveLength(1);
    // The pass started from the seeded template because the page was missing; an unchanged
    // draft must not materialize it.
    expect(await fixture.readPage()).toBeNull();
  });

  it("runs on the Status Page model from Settings, else on the main agent's model", async () => {
    using fixture = await createFixture();
    fixture.enqueue("an update");
    await fixture.whenIdle();

    await fixture.config.editConfig((cfg) => ({
      ...cfg,
      agentAiDefaults: { status_page: { modelString: "openai:status-model" } },
    }));
    fixture.enqueue("another update");
    await fixture.whenIdle();

    expect(fixture.modelStrings).toEqual([MAIN_MODEL, "openai:status-model"]);
    expect(fixture.usageRecords).toEqual([
      { model: MAIN_MODEL, source: "status_page_agent" },
      { model: "openai:status-model", source: "status_page_agent" },
    ]);
  });
});
