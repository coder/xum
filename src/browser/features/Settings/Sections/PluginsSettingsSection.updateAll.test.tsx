import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, type RenderResult } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type {
  AgentPluginListItem,
  AgentPluginUpdateCheck,
  AgentPluginUpdateReview,
} from "@/common/orpc/schemas/agentPlugins";
import { PluginsSettingsSection } from "./PluginsSettingsSection";
import { publishPluginsSectionIntent } from "./pluginsSectionIntents";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
});

const row = (name: string): AgentPluginListItem => ({
  name,
  managed: true,
  present: true,
  location: `~/.mux/plugins/${name}`,
  lockedSha: "a".repeat(40),
  skillCount: 1,
  mcpServerCount: 0,
});

const review = (name: string, changes: AgentPluginUpdateReview["changes"]) => ({
  name,
  fromSha: "a".repeat(40),
  toSha: "b".repeat(40),
  changes,
  warnings: [],
});
const neutral = (name: string) => review(name, []);
const capabilityChanging = (name: string) => review(name, [{ summary: `adds skill '${name}'` }]);

interface Fixture {
  names: string[];
  /** Plugins with an update waiting; the rest are up to date. */
  pending: Record<string, AgentPluginUpdateReview>;
  /** Plugins whose update the backend rejects. */
  failing?: Record<string, string>;
}

/** A backend where a plugin leaves `pending` once its update applies. */
function createApi(fixture: Fixture) {
  const pending = new Map(Object.entries(fixture.pending));
  const api = createMockORPCClient({ agentPlugins: { items: fixture.names.map(row) } });
  const updates: Array<{ name: string; consent: unknown }> = [];
  const previews: string[] = [];
  const checks = (): AgentPluginUpdateCheck[] =>
    fixture.names.map((name) => ({
      name,
      status: pending.has(name) ? "update-available" : "up-to-date",
    }));
  api.agentPlugins.checkUpdates = (() =>
    Promise.resolve({ success: true, data: checks() })) as typeof api.agentPlugins.checkUpdates;
  api.agentPlugins.previewUpdate = ((input: { name: string }) => {
    previews.push(input.name);
    const found = pending.get(input.name);
    return Promise.resolve(
      found ? { success: true, data: found } : { success: false, error: "nothing to update" }
    );
  }) as typeof api.agentPlugins.previewUpdate;
  api.agentPlugins.update = ((input: { name: string; consent?: unknown }) => {
    updates.push({ name: input.name, consent: input.consent });
    const failure = fixture.failing?.[input.name];
    if (failure !== undefined) return Promise.resolve({ success: false, error: failure });
    pending.delete(input.name);
    return Promise.resolve({ success: true });
  }) as unknown as typeof api.agentPlugins.update;
  return { api, updates, previews };
}

function mount(api: ReturnType<typeof createApi>["api"]): RenderResult {
  return render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
}

// Plain DOM reads: ByRole queries over the whole section are slow in happy-dom.
const buttonsIn = (view: RenderResult): HTMLButtonElement[] =>
  Array.from(view.container.querySelectorAll("button"));
const buttonNamed = (view: RenderResult, name: string | RegExp): HTMLButtonElement | undefined =>
  buttonsIn(view).find((button) => (button.textContent ?? "").match(name) !== null);
const updateAllButton = (view: RenderResult) =>
  waitFor(() => {
    const button = buttonNamed(view, /Update all/);
    if (button === undefined) throw new Error("No Update all button yet");
    return button;
  });
const openReviews = (view: RenderResult) =>
  buttonsIn(view).filter((button) => button.textContent === "Apply update");

test("one click applies the neutral updates, opens the capability-changing review, and leaves up-to-date plugins alone", async () => {
  const { api, updates, previews } = createApi({
    names: ["alpha", "beta", "gamma", "delta"],
    pending: {
      alpha: neutral("alpha"),
      beta: capabilityChanging("beta"),
      delta: neutral("delta"),
    },
  });
  const view = mount(api);

  fireEvent.click(await updateAllButton(view));

  await waitFor(() => expect(openReviews(view)).toHaveLength(1));
  expect(updates.map((update) => update.name)).toEqual(["alpha", "delta"]);
  expect(previews).not.toContain("gamma");

  // The user still confirms the capability change: only then does beta update, with its consent.
  fireEvent.click(openReviews(view)[0]);
  await waitFor(() =>
    expect(updates.map((update) => update.name)).toEqual(["alpha", "delta", "beta"])
  );
  expect(updates[2].consent).toMatchObject({ fromSha: "a".repeat(40), toSha: "b".repeat(40) });
  await waitFor(() => expect(openReviews(view)).toHaveLength(0));
  // Nothing is pending any more, so the button is gone.
  await waitFor(() => expect(buttonNamed(view, /Update all/) === undefined).toBe(true));
});

test("capability-changing reviews open one after another, and cancelling one opens the next", async () => {
  const { api, updates } = createApi({
    names: ["beta", "epsilon"],
    pending: { beta: capabilityChanging("beta"), epsilon: capabilityChanging("epsilon") },
  });
  const view = mount(api);

  fireEvent.click(await updateAllButton(view));
  await waitFor(() => expect(openReviews(view)).toHaveLength(1));
  expect(updates).toEqual([]);

  fireEvent.click(buttonNamed(view, "Cancel")!);
  await waitFor(() => expect(openReviews(view)).toHaveLength(1));

  fireEvent.click(openReviews(view)[0]);
  await waitFor(() => expect(updates.map((update) => update.name)).toEqual(["epsilon"]));
  await waitFor(() => expect(openReviews(view)).toHaveLength(0));
});

test("the status of a run goes away once the user settles a review it left open", async () => {
  const { api } = createApi({
    names: ["alpha", "beta"],
    pending: { alpha: neutral("alpha"), beta: capabilityChanging("beta") },
  });
  const view = mount(api);
  const status = () => view.container.querySelector('[role="status"]');

  fireEvent.click(await updateAllButton(view));
  await waitFor(() => expect(status() !== null).toBe(true));
  await waitFor(() => expect(openReviews(view)).toHaveLength(1));

  fireEvent.click(buttonNamed(view, "Cancel")!);
  await waitFor(() => expect(status() === null).toBe(true));
});

test("a failed update does not stop the others and the status names it", async () => {
  const { api, updates } = createApi({
    names: ["alpha", "beta", "gamma"],
    pending: { alpha: neutral("alpha"), beta: neutral("beta"), gamma: neutral("gamma") },
    failing: { beta: "swap failed" },
  });
  const view = mount(api);

  fireEvent.click(await updateAllButton(view));

  const status = () => view.container.querySelector('[role="status"]')?.textContent;
  await waitFor(() => expect(status()).toContain("beta"));
  expect(updates.map((update) => update.name)).toEqual(["alpha", "beta", "gamma"]);
  expect(status()).toContain("swap failed");
  // The two that applied are no longer pending: only the failed one still counts.
  await waitFor(() => expect(buttonNamed(view, /Update all/)?.textContent).toContain("1"));
});

test("no button shows while no managed plugin has an update waiting", async () => {
  const { api } = createApi({ names: ["alpha"], pending: {} });
  const view = mount(api);

  await view.findByText("alpha");
  expect(buttonNamed(view, /Update all/) === undefined).toBe(true);
});

test("every per-card action stays disabled while Update all runs", async () => {
  const { api } = createApi({
    names: ["alpha", "beta"],
    pending: { alpha: neutral("alpha"), beta: neutral("beta") },
  });
  const releaseFirstUpdate = Promise.withResolvers<void>();
  const applyUpdate = api.agentPlugins.update;
  api.agentPlugins.update = (async (input: Parameters<typeof applyUpdate>[0]) => {
    if (input.name === "alpha") await releaseFirstUpdate.promise;
    return applyUpdate(input);
  }) as typeof applyUpdate;
  const view = mount(api);

  const button = await updateAllButton(view);
  fireEvent.click(button);

  await waitFor(() => expect(button.disabled).toBe(true));
  const cardUpdates = buttonsIn(view).filter((candidate) => candidate.textContent === "Update");
  expect(cardUpdates).toHaveLength(2);
  expect(cardUpdates.every((update) => update.disabled)).toBe(true);
  releaseFirstUpdate.resolve();
  await waitFor(() => expect(buttonNamed(view, /Update all/) === undefined).toBe(true));
});

test("reviews a palette Update All found open in the section the same way", async () => {
  const { api, updates } = createApi({
    names: ["beta", "epsilon"],
    pending: { beta: capabilityChanging("beta"), epsilon: capabilityChanging("epsilon") },
  });
  publishPluginsSectionIntent({
    type: "review-updates",
    reviews: [capabilityChanging("beta"), capabilityChanging("epsilon")],
  });
  const view = mount(api);

  await waitFor(() => expect(openReviews(view)).toHaveLength(1));
  fireEvent.click(buttonNamed(view, "Cancel")!);
  await waitFor(() => expect(openReviews(view)).toHaveLength(1));
  fireEvent.click(openReviews(view)[0]);
  await waitFor(() => expect(updates.map((update) => update.name)).toEqual(["epsilon"]));
});
