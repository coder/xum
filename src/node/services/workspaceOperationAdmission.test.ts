import { describe, expect, test } from "bun:test";
import type { ProjectsConfig } from "@/common/types/project";
import { PreflightCounter } from "@/node/services/preflightCounter";
import { WorkspaceLifecycleGates } from "@/node/services/workspaceLifecycleGates";
import { WorkspaceOperationAdmission } from "@/node/services/workspaceOperationAdmission";

const ARCHIVED = "archived-ws";

// Only the fields findWorkspaceEntry and isWorkspaceArchived read.
const projectsConfig = {
  projects: new Map([
    ["/repo", { workspaces: [{ id: ARCHIVED, archivedAt: "2026-10-01T00:00:00.000Z" }] }],
  ]),
} as unknown as ProjectsConfig;

function createAdmission() {
  const gates = new WorkspaceLifecycleGates();
  const admission = new WorkspaceOperationAdmission({
    config: { loadConfigOrDefault: () => projectsConfig },
    gates,
  });
  return { gates, admission };
}

describe("PreflightCounter", () => {
  test("counts each workspace until every admission is disposed", () => {
    const counter = new PreflightCounter();
    const first = counter.acquire("ws-a");
    const second = counter.acquire("ws-a");
    const other = counter.acquire("ws-b");

    expect(counter.count("ws-a")).toBe(2);
    expect(counter.total()).toBe(3);
    expect([...counter.workspaceIds()].sort()).toEqual(["ws-a", "ws-b"]);

    first[Symbol.dispose]();
    expect(counter.count("ws-a")).toBe(1);
    expect(counter.total()).toBe(2);

    second[Symbol.dispose]();
    other[Symbol.dispose]();
    expect(counter.count("ws-a")).toBe(0);
    expect(counter.total()).toBe(0);
    expect([...counter.workspaceIds()]).toEqual([]);
  });
});

describe("WorkspaceOperationAdmission", () => {
  test("labels every in-flight operation in a fixed order", () => {
    const { admission } = createAdmission();
    // Acquired in reverse order: the labels must still come out in the gates' fixed order.
    using _refine = admission.refine.acquire("ws");
    using _discovery = admission.acquireMcpPromptDiscoveryAdmission("ws");
    using _fork = admission.fork.acquire("ws");
    using _completion = admission.fileCompletion.acquire("ws");
    using _staging = admission.staging.acquire("ws");
    using _exec = admission.exec.acquire("ws");
    using _otherWorkspace = admission.exec.acquire("ws-other");

    expect(admission.inFlightOperationLabels("ws")).toEqual([
      "a bash command executing",
      "an attachment transfer in progress",
      "a file completion refresh in progress",
      "a fork of this workspace in progress",
      "an MCP prompt discovery in progress",
      "a refine apply or publication in progress",
    ]);
    expect(admission.inFlightOperationLabels("ws-idle")).toEqual([]);
  });

  test("each counter labels only its own operation", () => {
    const { admission } = createAdmission();
    const counters = [
      [admission.exec, "a bash command executing"],
      [admission.staging, "an attachment transfer in progress"],
      [admission.fileCompletion, "a file completion refresh in progress"],
      [admission.fork, "a fork of this workspace in progress"],
      [admission.refine, "a refine apply or publication in progress"],
    ] as const;
    for (const [counter, label] of counters) {
      using _held = counter.acquire("ws");
      expect(admission.inFlightOperationLabels("ws")).toEqual([label]);
    }
  });

  test("a disposed MCP prompt discovery no longer holds the gates", () => {
    const { admission } = createAdmission();
    const discovery = admission.acquireMcpPromptDiscoveryAdmission("ws");
    expect(discovery).toBeDefined();
    discovery?.[Symbol.dispose]();
    expect(admission.inFlightOperationLabels("ws")).toEqual([]);
  });

  test("refuses an MCP prompt discovery while archiving, removing or archived", () => {
    const { gates, admission } = createAdmission();
    gates.archiving.add("ws-archiving");
    gates.removing.add("ws-removing");

    expect(admission.acquireMcpPromptDiscoveryAdmission("ws-archiving")).toBeUndefined();
    expect(admission.acquireMcpPromptDiscoveryAdmission("ws-removing")).toBeUndefined();
    expect(admission.acquireMcpPromptDiscoveryAdmission(ARCHIVED)).toBeUndefined();
    expect(admission.inFlightOperationLabels("ws-archiving")).toEqual([]);
  });

  test("a removal aborts the admitted discoveries and waits until they settle", async () => {
    const { admission } = createAdmission();
    const discovery = admission.acquireMcpPromptDiscoveryAdmission("ws");
    const unrelated = admission.acquireMcpPromptDiscoveryAdmission("ws-other");
    expect(discovery).toBeDefined();
    expect(unrelated).toBeDefined();
    // The discovery settles only once it observes the abort, like a real one.
    discovery?.signal.addEventListener("abort", () => {
      queueMicrotask(() => discovery[Symbol.dispose]());
    });

    let joined = false;
    const join = admission.abortAndJoinMcpPromptDiscoveries("ws").then(() => {
      joined = true;
    });
    expect(discovery?.signal.aborted).toBe(true);
    expect(unrelated?.signal.aborted).toBe(false);
    await join;
    expect(joined).toBe(true);
    expect(admission.inFlightOperationLabels("ws")).toEqual([]);
    unrelated?.[Symbol.dispose]();
  });
});
