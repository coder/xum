import { describe, expect, mock, test } from "bun:test";

import type { APIClient } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type {
  AgentPluginUpdateCheck,
  AgentPluginUpdateReview,
} from "@/common/orpc/schemas/agentPlugins";
import { summarizeUpdateAll, updateAllPlugins, type UpdateAllResult } from "./updateAllPlugins";

const available = (name: string): AgentPluginUpdateCheck => ({
  name,
  status: "update-available",
  remoteSha: "b".repeat(40),
});

const review = (name: string): AgentPluginUpdateReview => ({
  name,
  fromSha: "a".repeat(40),
  toSha: "b".repeat(40),
  changes: [{ summary: "adds skill 'review'" }],
  warnings: [],
});

const neutral = (name: string): AgentPluginUpdateReview => ({ ...review(name), changes: [] });

type Preview = Awaited<ReturnType<APIClient["agentPlugins"]["previewUpdate"]>>;
type Update = Awaited<ReturnType<APIClient["agentPlugins"]["update"]>>;

/** An API whose previews and updates follow the per-plugin tables (an absent name fails). */
function apiWith(
  previews: Record<string, Preview | Error>,
  updates: Record<string, Update | Error> = {}
) {
  const api = createMockORPCClient({});
  const previewUpdate = mock((input: { name: string }) => {
    const outcome = previews[input.name];
    if (outcome === undefined) return Promise.resolve({ success: false, error: "no preview" });
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  });
  const update = mock((input: { name: string }) => {
    const outcome = updates[input.name];
    if (outcome === undefined) return Promise.resolve({ success: true });
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  });
  api.agentPlugins.previewUpdate =
    previewUpdate as unknown as typeof api.agentPlugins.previewUpdate;
  api.agentPlugins.update = update as unknown as typeof api.agentPlugins.update;
  return { api, previewUpdate, update };
}

const ok = (data: AgentPluginUpdateReview): Preview => ({ success: true, data });

describe("updateAllPlugins", () => {
  test("applies capability-neutral updates and hands capability-changing ones back as reviews", async () => {
    const { api, update } = apiWith({
      a: ok(neutral("a")),
      b: ok(review("b")),
      d: ok(neutral("d")),
    });
    const result = await updateAllPlugins(api, [
      available("a"),
      available("b"),
      { name: "c", status: "up-to-date" },
      available("d"),
    ]);

    expect(result.updated).toEqual(["a", "d"]);
    expect(result.reviews).toEqual([review("b")]);
    expect(result.failures).toEqual([]);
    // The backend refuses a capability-changing update without consent: it is never attempted.
    expect(update.mock.calls.map(([input]) => input.name)).toEqual(["a", "d"]);
    expect(update.mock.calls.every(([input]) => !("consent" in input))).toBe(true);
  });

  test("a failed plugin does not stop the others", async () => {
    const { api } = apiWith(
      {
        a: ok(neutral("a")),
        b: ok(neutral("b")),
        c: { success: false, error: "clone failed" },
        d: ok(neutral("d")),
        e: ok(neutral("e")),
      },
      { b: { success: false, error: "swap failed" }, d: new Error("connection lost") }
    );
    const result = await updateAllPlugins(
      api,
      ["a", "b", "c", "d", "e"].map((name) => available(name))
    );

    expect(result.updated).toEqual(["a", "e"]);
    expect(result.failures).toEqual([
      { name: "b", error: "swap failed" },
      { name: "c", error: "clone failed" },
      { name: "d", error: "connection lost" },
    ]);
  });

  test("a preview that throws is a failure of that plugin only", async () => {
    const { api } = apiWith({ a: new Error("boom"), b: ok(neutral("b")) });
    const result = await updateAllPlugins(api, [available("a"), available("b")]);

    expect(result.failures).toEqual([{ name: "a", error: "boom" }]);
    expect(result.updated).toEqual(["b"]);
  });

  test("tag-moved and unreachable plugins are reported, never previewed or applied", async () => {
    const { api, previewUpdate, update } = apiWith({ a: ok(neutral("a")) });
    const result = await updateAllPlugins(api, [
      available("a"),
      { name: "moved", status: "tag-moved", remoteSha: "c".repeat(40) },
      { name: "offline", status: "error", message: "unreachable" },
      { name: "frozen", status: "pinned" },
    ]);

    expect(result.tagMoved).toEqual(["moved"]);
    expect(result.checkFailures).toEqual(["offline"]);
    expect(result.updated).toEqual(["a"]);
    expect(previewUpdate.mock.calls.map(([input]) => input.name)).toEqual(["a"]);
    expect(update.mock.calls.map(([input]) => input.name)).toEqual(["a"]);
  });

  test("works one plugin at a time, in order, and names each before it starts", async () => {
    const events: string[] = [];
    const api = createMockORPCClient({});
    api.agentPlugins.previewUpdate = ((input: { name: string }) => {
      events.push(`preview ${input.name}`);
      return Promise.resolve(ok(neutral(input.name)));
    }) as unknown as typeof api.agentPlugins.previewUpdate;
    api.agentPlugins.update = ((input: { name: string }) => {
      events.push(`update ${input.name}`);
      return Promise.resolve({ success: true });
    }) as unknown as typeof api.agentPlugins.update;

    await updateAllPlugins(api, [available("a"), available("b")], (name) =>
      events.push(`progress ${name}`)
    );

    expect(events).toEqual([
      "progress a",
      "preview a",
      "update a",
      "progress b",
      "preview b",
      "update b",
    ]);
  });

  test("with nothing to update it calls the API zero times", async () => {
    const { api, previewUpdate, update } = apiWith({});
    const result = await updateAllPlugins(api, [{ name: "a", status: "up-to-date" }]);

    expect(result).toEqual({
      updated: [],
      reviews: [],
      failures: [],
      tagMoved: [],
      checkFailures: [],
    });
    expect(previewUpdate).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("summarizeUpdateAll", () => {
  const empty: UpdateAllResult = {
    updated: [],
    reviews: [],
    failures: [],
    tagMoved: [],
    checkFailures: [],
  };

  test("nothing to report is a success", () => {
    expect(summarizeUpdateAll(empty).tone).toBe("success");
  });

  test("updates and pending reviews are a success that names each plugin", () => {
    const summary = summarizeUpdateAll({
      ...empty,
      updated: ["alpha", "delta"],
      reviews: [review("bravo")],
    });

    expect(summary.tone).toBe("success");
    for (const name of ["alpha", "delta", "bravo"]) expect(summary.message).toContain(name);
  });

  test("a partial success keeps what was updated and names what failed and why", () => {
    const summary = summarizeUpdateAll({
      ...empty,
      updated: ["alpha"],
      failures: [{ name: "charlie", error: "clone failed" }],
    });

    expect(summary.tone).toBe("error");
    expect(summary.message).toContain("alpha");
    expect(summary.message).toContain("charlie");
    expect(summary.message).toContain("clone failed");
  });

  test.each([
    ["a moved tag", { tagMoved: ["moved"] }],
    ["an unreachable remote", { checkFailures: ["offline"] }],
  ])("%s never reads as a clean success", (_label, patch) => {
    const summary = summarizeUpdateAll({ ...empty, ...patch });

    expect(summary.tone).toBe("error");
    expect(summary.message).toContain(Object.values(patch)[0]![0]!);
  });
});
