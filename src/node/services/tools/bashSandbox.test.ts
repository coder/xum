import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { BashSandboxApprovalEvent } from "@/common/types/stream";
import type { BashToolResult } from "@/common/types/tools";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { ExecOptions, ExecStream } from "@/node/runtime/Runtime";
import type { AgentSandboxPolicy } from "@/node/runtime/sandbox/agentSandboxTargets";
import { sandboxApprovalManager } from "@/node/services/agentSandbox/sandboxApprovalManager";
import { createBashTool } from "./bash";
import { SANDBOX_APPROVAL_DENIED } from "./bashSandbox";
import { createTestToolConfig } from "./testHelpers";

const POLICY: AgentSandboxPolicy = {
  writeRoots: [],
  denyWrite: [],
  denyRead: [],
  allowRead: [],
  network: "loopback",
  allowedHosts: [],
  allowLocalBinding: true,
};

/** A local runtime that reports a sandbox policy (or none) and records each exec's options. */
class RecordingRuntime extends LocalRuntime {
  readonly execOptions: ExecOptions[] = [];

  constructor(
    projectPath: string,
    private readonly policy: AgentSandboxPolicy | null
  ) {
    super(projectPath);
  }

  override agentSandboxPolicy(): AgentSandboxPolicy | null {
    return this.policy;
  }

  override exec(command: string, options: ExecOptions): Promise<ExecStream> {
    this.execOptions.push(options);
    return super.exec(command, options);
  }
}

describe("bash outside_sandbox_reason", () => {
  let cwd: string;
  let events: BashSandboxApprovalEvent[];

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "xum-bash-sandbox-"));
    events = [];
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function setup(
    policy: AgentSandboxPolicy | null,
    overrides: Partial<ToolConfiguration> = {}
  ): { runtime: RecordingRuntime; run: (abortSignal?: AbortSignal) => Promise<BashToolResult> } {
    const runtime = new RecordingRuntime(cwd, policy);
    const config: ToolConfiguration = {
      ...createTestToolConfig(cwd, { runtime, workspaceId: "ws-sandbox" }),
      emitChatEvent: (event: WorkspaceChatMessage) => {
        if (event.type === "bash-sandbox-approval") events.push(event);
        return Promise.resolve();
      },
      ...overrides,
    };
    const tool = createBashTool(config);
    const run = async (abortSignal?: AbortSignal) =>
      (await tool.execute!(
        {
          script: "echo ran",
          timeout_secs: 10,
          run_in_background: false,
          display_name: "outside",
          outside_sandbox_reason: "needs the login keychain",
        },
        { toolCallId: "call-1", messages: [], context: undefined, abortSignal }
      )) as BashToolResult;
    return { runtime, run };
  }

  it("waits for the user and runs once with the sandbox off after an approval", async () => {
    const { runtime, run } = setup(POLICY);

    const result = run();
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ toolCallId: "call-1", pending: true });
    expect(runtime.execOptions).toHaveLength(0);
    expect(sandboxApprovalManager.answer("ws-sandbox", "call-1", true)).toBe(true);

    const settled = await result;
    expect(settled.success).toBe(true);
    expect(runtime.execOptions.map((options) => options.sandbox)).toEqual(["off"]);
    expect(events.at(-1)).toMatchObject({ toolCallId: "call-1", pending: false });
  });

  it("runs nothing after a denial or a Stop", async () => {
    const { runtime, run } = setup(POLICY);

    const denied = run();
    await waitFor(() => events.length === 1);
    sandboxApprovalManager.answer("ws-sandbox", "call-1", false);
    expect(await denied).toMatchObject({ success: false, error: SANDBOX_APPROVAL_DENIED });

    const controller = new AbortController();
    const stopped = run(controller.signal);
    await waitFor(() => events.length === 3);
    controller.abort();
    expect(await stopped).toMatchObject({ success: false, error: SANDBOX_APPROVAL_DENIED });
    expect(runtime.execOptions).toHaveLength(0);
  });

  it("denies at once when no user can answer", async () => {
    const { runtime, run } = setup(POLICY, { noInteractiveUser: true });

    expect(await run()).toMatchObject({ success: false, error: SANDBOX_APPROVAL_DENIED });
    expect(events).toHaveLength(0);
    expect(runtime.execOptions).toHaveLength(0);
  });

  it("ignores the field where no sandbox applies", async () => {
    const { runtime, run } = setup(null);

    expect((await run()).success).toBe(true);
    expect(events).toHaveLength(0);
    expect(runtime.execOptions.map((options) => options.sandbox)).toEqual([undefined]);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}
