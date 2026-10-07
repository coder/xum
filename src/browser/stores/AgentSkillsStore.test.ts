import { afterEach, describe, expect, mock, test } from "bun:test";
import { createTestApiClient } from "@/browser/testUtils";
import { publishAgentPluginsMutated } from "@/browser/utils/agentPluginMutations";
import { SkillNameSchema } from "@/common/orpc/schemas/agentSkill";
import type { AgentSkillDescriptor, AgentSkillListResult } from "@/common/types/agentSkill";
import { AgentSkillsStore, type AgentSkillsDiscovery } from "./AgentSkillsStore";

const DISCOVERY: AgentSkillsDiscovery = { workspaceId: "ws-1", disableWorkspaceAgents: false };

function skill(name: string): AgentSkillDescriptor {
  return { name: SkillNameSchema.parse(name), description: `${name} skill`, scope: "global" };
}

function listResult(names: string[], unavailable = false): AgentSkillListResult {
  return {
    skills: names.map(skill),
    invalidSkills: [],
    unavailableSources: unavailable
      ? [{ scope: "project", displayPath: "/repo/.xum/skills", message: "SSH probe timed out" }]
      : [],
  };
}

type ListResponse = AgentSkillListResult | Promise<AgentSkillListResult> | Error;

function createStore(responses: ListResponse[]) {
  const list = mock(() => {
    const next = responses.shift() ?? listResult([]);
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const store = new AgentSkillsStore();
  store.setClient(createTestApiClient({ agentSkills: { list } }));
  return { store, list };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const stores: AgentSkillsStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

function track<T extends { store: AgentSkillsStore }>(created: T): T {
  stores.push(created.store);
  return created;
}

const skillNames = (store: AgentSkillsStore) =>
  store.getResult(DISCOVERY).skills.map((descriptor) => descriptor.name);

describe("AgentSkillsStore", () => {
  test("subscribers of one key share one fetch, also across a resubscribe", async () => {
    const { store, list } = track(createStore([listResult(["review"])]));

    const unsubscribe = store.subscribe(DISCOVERY, () => undefined);
    // React resubscribes (unsubscribe, then subscribe) when the callback changes.
    unsubscribe();
    store.subscribe(DISCOVERY, () => undefined);
    store.subscribe({ ...DISCOVERY }, () => undefined);
    await settle();

    expect(list).toHaveBeenCalledTimes(1);
    expect(skillNames(store)).toEqual(["review"]);
  });

  test.each<{ name: string; first: ListResponse; fetches: number }>([
    { name: "a list that missed a source", first: listResult(["review"], true), fetches: 2 },
    { name: "a failed call", first: new Error("offline"), fetches: 2 },
    { name: "a complete list", first: listResult(["review"]), fetches: 1 },
  ])("ensureFresh after $name", async ({ first, fetches }) => {
    const { store, list } = track(createStore([first, listResult(["review", "deploy"])]));
    store.subscribe(DISCOVERY, () => undefined);
    await settle();

    store.ensureFresh(DISCOVERY);
    store.ensureFresh(DISCOVERY);
    await settle();

    expect(list).toHaveBeenCalledTimes(fetches);
  });

  test.each<{
    name: string;
    trigger: "signal" | "ensureFresh";
    first: AgentSkillListResult;
    second: ListResponse;
    fetches: number;
    expected: string[];
  }>([
    {
      name: "a refresh signal: the newer list lands",
      trigger: "signal",
      first: listResult(["review"]),
      second: listResult(["review", "deploy"]),
      fetches: 2,
      expected: ["review", "deploy"],
    },
    {
      name: "a refresh signal: a failed newer call keeps the older list",
      trigger: "signal",
      first: listResult(["review"]),
      second: new Error("offline"),
      fetches: 2,
      expected: ["review"],
    },
    {
      name: "ensureFresh: asks again when the list missed a source",
      trigger: "ensureFresh",
      first: listResult(["review"], true),
      second: listResult(["review", "deploy"]),
      fetches: 2,
      expected: ["review", "deploy"],
    },
    {
      name: "ensureFresh: does not ask again for a complete list",
      trigger: "ensureFresh",
      first: listResult(["review"]),
      second: listResult(["review", "deploy"]),
      fetches: 1,
      expected: ["review"],
    },
  ])("during a request, $name", async ({ trigger, first, second, fetches, expected }) => {
    let resolveFirst: (result: AgentSkillListResult) => void = () => undefined;
    const pending = new Promise<AgentSkillListResult>((resolve) => {
      resolveFirst = resolve;
    });
    const { store, list } = track(createStore([pending, second]));
    store.subscribe(DISCOVERY, () => undefined);

    if (trigger === "signal") publishAgentPluginsMutated();
    else store.ensureFresh(DISCOVERY);
    await settle();
    expect(list).toHaveBeenCalledTimes(1);

    resolveFirst(first);
    await settle();
    expect(list).toHaveBeenCalledTimes(fetches);
    expect(skillNames(store)).toEqual(expected);
  });
});
