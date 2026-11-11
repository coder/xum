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

type Deferred = ReturnType<typeof Promise.withResolvers<void>>;

const OLD_SHA = "a".repeat(40);
/** The commit the list reports after an update; no review text carries it. */
const UPDATED_SHA = "c".repeat(40);

const row = (name: string, lockedSha: string): AgentPluginListItem => ({
  name,
  managed: true,
  present: true,
  location: `~/.mux/plugins/${name}`,
  source: {
    type: "git",
    url: `https://example.invalid/${name}.git`,
    ref: "main",
    refType: "branch",
  },
  lockedSha,
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
  pending: Record<string, AgentPluginUpdateReview>;
  failing?: Record<string, string>;
  /** Unmanaged plugins in another container, listed after the managed ones (names may repeat). */
  unmanaged?: string[];
  /** Capability changes that a component review of the plugin lists. */
  componentReviews?: Record<string, AgentPluginUpdateReview>;
}

function createApi(fixture: Fixture) {
  const pending = new Map(Object.entries(fixture.pending));
  const api = createMockORPCClient({ agentPlugins: { items: [] } });
  const locked = new Map(fixture.names.map((name) => [name, OLD_SHA]));
  api.agentPlugins.listForSettings = (() =>
    Promise.resolve({
      list: {
        success: true,
        data: [
          ...fixture.names.map((name) => row(name, locked.get(name)!)),
          ...(fixture.unmanaged ?? []).map(
            (name): AgentPluginListItem => ({
              ...row(name, OLD_SHA),
              managed: false,
              location: `~/.agents/plugins/${name}`,
            })
          ),
        ],
      },
      pendingSignOuts: { kind: "none" },
    })) as typeof api.agentPlugins.listForSettings;
  const updates: Array<{ name: string; consent: unknown }> = [];
  const previews: string[] = [];
  const checks = (): AgentPluginUpdateCheck[] =>
    fixture.names.map((name) => ({
      name,
      status: pending.has(name) ? "update-available" : "up-to-date",
    }));
  let gate: { entered: Deferred; released: Deferred } | null = null;
  api.agentPlugins.checkUpdates = (async () => {
    if (gate !== null) {
      gate.entered.resolve();
      await gate.released.promise;
    }
    return { success: true, data: checks() };
  }) as typeof api.agentPlugins.checkUpdates;
  /** Holds the next update check: `entered` settles when it starts, `release` lets it finish. */
  const holdChecks = () => {
    const held = {
      entered: Promise.withResolvers<void>(),
      released: Promise.withResolvers<void>(),
    };
    gate = held;
    return {
      entered: held.entered.promise,
      release: () => {
        gate = null;
        held.released.resolve();
      },
    };
  };
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
    locked.set(input.name, UPDATED_SHA);
    return Promise.resolve({ success: true });
  }) as unknown as typeof api.agentPlugins.update;
  api.agentPlugins.previewComponentReview = ((input: { name: string }) => {
    const found = fixture.componentReviews?.[input.name];
    return Promise.resolve(
      found ? { success: true, data: found } : { success: false, error: "nothing to review" }
    );
  }) as typeof api.agentPlugins.previewComponentReview;
  const uninstalls: string[] = [];
  api.agentPlugins.uninstall = ((input: { name: string }) => {
    uninstalls.push(input.name);
    fixture.names.splice(fixture.names.indexOf(input.name), 1);
    pending.delete(input.name);
    return Promise.resolve({ success: true });
  }) as unknown as typeof api.agentPlugins.uninstall;
  return { api, updates, previews, uninstalls, holdChecks };
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

  fireEvent.click(openReviews(view)[0]);
  await waitFor(() =>
    expect(updates.map((update) => update.name)).toEqual(["alpha", "delta", "beta"])
  );
  expect(updates[2].consent).toMatchObject({ fromSha: "a".repeat(40), toSha: "b".repeat(40) });
  await waitFor(() => expect(openReviews(view)).toHaveLength(0));
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

test("settling a review takes only its name out of the status, and the failure text stays", async () => {
  const { api } = createApi({
    names: ["alpha", "beta", "gamma", "delta"],
    pending: {
      alpha: neutral("alpha"),
      beta: capabilityChanging("beta"),
      gamma: capabilityChanging("gamma"),
      delta: neutral("delta"),
    },
    failing: { delta: "swap failed" },
  });
  const view = mount(api);
  const status = () => view.container.querySelector('[role="status"]')?.textContent ?? "";

  fireEvent.click(await updateAllButton(view));
  await waitFor(() => expect(openReviews(view)).toHaveLength(1));
  expect(status()).toContain("beta");
  expect(status()).toContain("gamma");

  fireEvent.click(buttonNamed(view, "Cancel")!);
  await waitFor(() => expect(status()).not.toContain("beta"));
  expect(status()).toContain("gamma");
  expect(status()).toContain("swap failed");

  fireEvent.click(buttonNamed(view, "Cancel")!);
  await waitFor(() => expect(status()).not.toContain("gamma"));
  expect(status()).toContain("swap failed");
});

test("the status goes away once the last review it listed settles and nothing else is left to say", async () => {
  const { api } = createApi({
    names: ["beta"],
    pending: { beta: capabilityChanging("beta") },
  });
  const view = mount(api);
  const status = () => view.container.querySelector('[role="status"]');

  fireEvent.click(await updateAllButton(view));
  await waitFor(() => expect(status() !== null).toBe(true));
  await waitFor(() => expect(openReviews(view)).toHaveLength(1));

  fireEvent.click(buttonNamed(view, "Cancel")!);
  await waitFor(() => expect(status() === null).toBe(true));
});

test("a settled review does not come back in the status when a later palette run queues the same plugin", async () => {
  const { api } = createApi({
    names: ["beta"],
    pending: { beta: capabilityChanging("beta") },
  });
  const view = mount(api);
  const status = () => view.container.querySelector('[role="status"]');

  fireEvent.click(await updateAllButton(view));
  await waitFor(() => expect(openReviews(view)).toHaveLength(1));
  fireEvent.click(buttonNamed(view, "Cancel")!);
  await waitFor(() => expect(status() === null).toBe(true));

  publishPluginsSectionIntent({ type: "review-updates", reviews: [capabilityChanging("beta")] });

  await waitFor(() => expect(openReviews(view)).toHaveLength(1));
  expect(status() === null).toBe(true);
});

test("a card Update click dismisses the status of the earlier run", async () => {
  const { api } = createApi({
    names: ["alpha", "beta"],
    pending: { alpha: neutral("alpha"), beta: neutral("beta") },
    failing: { alpha: "swap failed" },
  });
  const view = mount(api);
  const status = () => view.container.querySelector('[role="status"]');

  fireEvent.click(await updateAllButton(view));
  await waitFor(() => expect(status()?.textContent).toContain("swap failed"));
  await waitFor(() => expect(buttonsIn(view).some((b) => b.textContent === "Update")).toBe(true));

  fireEvent.click(buttonsIn(view).find((b) => b.textContent === "Update")!);
  await waitFor(() => expect(status() === null).toBe(true));
});

test("reviews and the status appear only once the run has refreshed, with their controls enabled", async () => {
  const { api, holdChecks } = createApi({
    names: ["alpha", "beta"],
    pending: { alpha: neutral("alpha"), beta: capabilityChanging("beta") },
  });
  const view = mount(api);
  const status = () => view.container.querySelector('[role="status"]');
  const button = await updateAllButton(view);

  const hold = holdChecks();
  fireEvent.click(button);
  await hold.entered;
  // The refreshed list has rendered (alpha shows its new commit), and the check is still held.
  await waitFor(() =>
    expect((view.container.textContent ?? "").includes(UPDATED_SHA.slice(0, 12))).toBe(true)
  );
  // A review shown while the run holds the busy state would still list its changes.
  expect((view.container.textContent ?? "").includes("adds skill 'beta'")).toBe(false);
  expect(status() === null).toBe(true);

  hold.release();
  await waitFor(() => expect(openReviews(view)).toHaveLength(1));
  expect(openReviews(view)[0].disabled).toBe(false);
  expect(status() !== null).toBe(true);
});

test("the next queued review opens only after the confirmed update has settled", async () => {
  const { api, updates, holdChecks } = createApi({
    names: ["beta", "epsilon"],
    pending: { beta: capabilityChanging("beta"), epsilon: capabilityChanging("epsilon") },
  });
  const view = mount(api);
  const shows = (text: string) => (view.container.textContent ?? "").includes(text);

  fireEvent.click(await updateAllButton(view));
  await waitFor(() => expect(openReviews(view)).toHaveLength(1));
  expect(shows("adds skill 'beta'")).toBe(true);

  const hold = holdChecks();
  fireEvent.click(openReviews(view)[0]);
  await hold.entered;
  // The refreshed list has rendered (beta shows its new commit), and the check is still held.
  await waitFor(() => expect(shows(UPDATED_SHA.slice(0, 12))).toBe(true));
  expect(updates.map((update) => update.name)).toEqual(["beta"]);
  expect(shows("adds skill 'epsilon'")).toBe(false);

  hold.release();
  await waitFor(() => expect(shows("adds skill 'epsilon'")).toBe(true));
  expect(openReviews(view)[0].disabled).toBe(false);
});

test("an unmanaged plugin that shares a managed plugin's name is not counted twice", async () => {
  const { api } = createApi({
    names: ["alpha"],
    pending: { alpha: neutral("alpha") },
    unmanaged: ["alpha"],
  });
  const view = mount(api);

  const button = await updateAllButton(view);

  expect(button.textContent).toContain("(1)");
});

test("a single card Update click drops the queued reviews", async () => {
  const { api, updates } = createApi({
    names: ["beta", "epsilon", "delta"],
    pending: {
      beta: capabilityChanging("beta"),
      epsilon: capabilityChanging("epsilon"),
      delta: neutral("delta"),
    },
  });
  publishPluginsSectionIntent({
    type: "review-updates",
    reviews: [capabilityChanging("beta"), capabilityChanging("epsilon")],
  });
  const view = mount(api);
  const shows = (text: string) => (view.container.textContent ?? "").includes(text);
  await waitFor(() => expect(shows("adds skill 'beta'")).toBe(true));

  // The cards list beta, epsilon, delta: the last Update belongs to the neutral delta.
  const cardUpdates = await waitFor(() => {
    const found = buttonsIn(view).filter((candidate) => candidate.textContent === "Update");
    if (found.length !== 3) throw new Error("The cards have not rendered their Update buttons");
    return found;
  });
  fireEvent.click(cardUpdates[2]);

  await waitFor(() => expect(updates.map((update) => update.name)).toEqual(["delta"]));
  await waitFor(() => expect(shows("adds skill 'beta'")).toBe(false));
  expect(shows("adds skill 'epsilon'")).toBe(false);
});

test("reviews a palette Update All finds while Settings is already open show up live", async () => {
  const { api } = createApi({
    names: ["beta", "epsilon"],
    pending: { beta: capabilityChanging("beta"), epsilon: capabilityChanging("epsilon") },
  });
  const view = mount(api);
  await updateAllButton(view);
  expect(openReviews(view)).toHaveLength(0);

  publishPluginsSectionIntent({
    type: "review-updates",
    reviews: [capabilityChanging("beta"), capabilityChanging("epsilon")],
  });

  await waitFor(() => expect(openReviews(view)).toHaveLength(1));
  fireEvent.click(buttonNamed(view, "Cancel")!);
  await waitFor(() =>
    expect((view.container.textContent ?? "").includes("adds skill 'epsilon'")).toBe(true)
  );
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

test("a queued review whose plugin has no managed card does not hide the reviews behind it", async () => {
  const { api, updates } = createApi({
    names: ["epsilon"],
    unmanaged: ["beta"],
    pending: { epsilon: capabilityChanging("epsilon") },
  });
  // `ghost` was uninstalled from another client, and `beta` only exists as an unmanaged plugin.
  publishPluginsSectionIntent({
    type: "review-updates",
    reviews: [
      capabilityChanging("ghost"),
      capabilityChanging("beta"),
      capabilityChanging("epsilon"),
    ],
  });
  const view = mount(api);

  await waitFor(() => expect(openReviews(view)).toHaveLength(1));
  const text = view.container.textContent ?? "";
  expect(text).toContain("adds skill 'epsilon'");
  expect(text).not.toContain("adds skill 'ghost'");
  expect(text).not.toContain("adds skill 'beta'");
  expect(openReviews(view)[0].disabled).toBe(false);

  fireEvent.click(openReviews(view)[0]);
  await waitFor(() => expect(updates.map((update) => update.name)).toEqual(["epsilon"]));
  await waitFor(() => expect(openReviews(view)).toHaveLength(0));
});

test("a confirm that fails keeps the queue where it is, with the same review open", async () => {
  const { api, updates } = createApi({
    names: ["beta", "epsilon"],
    pending: { beta: capabilityChanging("beta"), epsilon: capabilityChanging("epsilon") },
    failing: { beta: "swap failed" },
  });
  const view = mount(api);
  const shows = (text: string) => (view.container.textContent ?? "").includes(text);

  fireEvent.click(await updateAllButton(view));
  await waitFor(() => expect(openReviews(view)).toHaveLength(1));
  fireEvent.click(openReviews(view)[0]);

  await waitFor(() => expect(updates.map((update) => update.name)).toEqual(["beta"]));
  await waitFor(() => expect(shows("swap failed")).toBe(true));
  expect(openReviews(view)).toHaveLength(1);
  expect(shows("adds skill 'beta'")).toBe(true);
  expect(shows("adds skill 'epsilon'")).toBe(false);
  expect(openReviews(view)[0].disabled).toBe(false);

  fireEvent.click(buttonNamed(view, "Cancel")!);
  await waitFor(() => expect(shows("adds skill 'epsilon'")).toBe(true));
});

test("a confirm that settles after a palette run replaced the queue leaves the palette's reviews alone", async () => {
  const { api, holdChecks } = createApi({
    names: ["beta", "epsilon", "gamma", "delta"],
    pending: { beta: capabilityChanging("beta"), epsilon: capabilityChanging("epsilon") },
  });
  const view = mount(api);
  const shows = (text: string) => (view.container.textContent ?? "").includes(text);

  fireEvent.click(await updateAllButton(view));
  await waitFor(() => expect(shows("adds skill 'beta'")).toBe(true));
  const hold = holdChecks();
  fireEvent.click(openReviews(view)[0]);
  await hold.entered;
  publishPluginsSectionIntent({
    type: "review-updates",
    reviews: [capabilityChanging("gamma"), capabilityChanging("delta")],
  });
  await waitFor(() => expect(shows("adds skill 'gamma'")).toBe(true));

  hold.release();

  await waitFor(() => expect(buttonNamed(view, /Update all/)?.textContent).toContain("(1)"));
  expect(shows("adds skill 'gamma'")).toBe(true);
  expect(shows("adds skill 'delta'")).toBe(false);
});

async function uninstallPlugin(view: RenderResult, name: string) {
  fireEvent.click(view.container.querySelector(`button[aria-label="Uninstall ${name}"]`)!);
  const confirm = await waitFor(() => {
    const found = buttonsIn(view).find(
      (button) => button.textContent === "Uninstall" && !button.hasAttribute("aria-label")
    );
    if (found === undefined) throw new Error("The uninstall confirmation has not opened");
    return found;
  });
  fireEvent.click(confirm);
}

test("uninstalling the plugin whose review is open opens the next queued review", async () => {
  const { api, uninstalls } = createApi({
    names: ["beta", "epsilon"],
    pending: { beta: capabilityChanging("beta"), epsilon: capabilityChanging("epsilon") },
  });
  const view = mount(api);
  const shows = (text: string) => (view.container.textContent ?? "").includes(text);

  fireEvent.click(await updateAllButton(view));
  await waitFor(() => expect(shows("adds skill 'beta'")).toBe(true));

  await uninstallPlugin(view, "beta");

  await waitFor(() => expect(uninstalls).toEqual(["beta"]));
  await waitFor(() => expect(shows("adds skill 'epsilon'")).toBe(true));
  expect(shows("adds skill 'beta'")).toBe(false);
  expect(openReviews(view)).toHaveLength(1);
  expect(openReviews(view)[0].disabled).toBe(false);
  const status = view.container.querySelector('[role="status"]')?.textContent ?? "";
  expect(status).not.toContain("beta");
  expect(status).toContain("epsilon");
});

test("the next review opens only after the uninstall has settled", async () => {
  const { api } = createApi({
    names: ["beta", "epsilon"],
    pending: { beta: capabilityChanging("beta"), epsilon: capabilityChanging("epsilon") },
  });
  const listed = api.agentPlugins.listForSettings;
  const releaseList = Promise.withResolvers<void>();
  let holdingList = false;
  api.agentPlugins.listForSettings = (async () => {
    if (holdingList) await releaseList.promise;
    return listed();
  }) as typeof listed;
  const view = mount(api);
  const shows = (text: string) => (view.container.textContent ?? "").includes(text);
  const uninstalling = () =>
    buttonsIn(view).some((button) => button.textContent === "Uninstalling…");

  fireEvent.click(await updateAllButton(view));
  await waitFor(() => expect(shows("adds skill 'beta'")).toBe(true));
  holdingList = true;
  await uninstallPlugin(view, "beta");
  await waitFor(() => expect(uninstalling()).toBe(true));
  await waitFor(() => expect(uninstalling()).toBe(false));

  expect(shows("adds skill 'epsilon'")).toBe(false);

  releaseList.resolve();
  await waitFor(() => expect(shows("adds skill 'epsilon'")).toBe(true));
  expect(openReviews(view)[0].disabled).toBe(false);
});

test("uninstalling a plugin whose review is still queued drops it from the queue", async () => {
  const { api } = createApi({
    names: ["beta", "epsilon", "delta"],
    pending: {
      beta: capabilityChanging("beta"),
      epsilon: capabilityChanging("epsilon"),
      delta: capabilityChanging("delta"),
    },
  });
  const view = mount(api);
  const shows = (text: string) => (view.container.textContent ?? "").includes(text);

  fireEvent.click(await updateAllButton(view));
  await waitFor(() => expect(shows("adds skill 'beta'")).toBe(true));

  await uninstallPlugin(view, "epsilon");
  await waitFor(() =>
    expect(view.container.querySelector('button[aria-label="Uninstall epsilon"]') === null).toBe(
      true
    )
  );
  fireEvent.click(buttonNamed(view, "Cancel")!);

  await waitFor(() => expect(shows("adds skill 'delta'")).toBe(true));
  expect(shows("adds skill 'beta'")).toBe(false);
});

/** Holds every uninstall until `release`, so another plugin stays busy meanwhile. */
function holdUninstalls(api: ReturnType<typeof createApi>["api"]) {
  const released = Promise.withResolvers<void>();
  const uninstall = api.agentPlugins.uninstall;
  api.agentPlugins.uninstall = (async (input: Parameters<typeof uninstall>[0]) => {
    await released.promise;
    return uninstall(input);
  }) as typeof uninstall;
  return released.resolve;
}

test("an open update review cannot be applied while another plugin is busy, and can again when it settles", async () => {
  const { api, uninstalls } = createApi({
    names: ["beta", "epsilon"],
    pending: { beta: capabilityChanging("beta") },
  });
  const release = holdUninstalls(api);
  publishPluginsSectionIntent({ type: "review-updates", reviews: [capabilityChanging("beta")] });
  const view = mount(api);
  await waitFor(() => expect(openReviews(view)).toHaveLength(1));
  expect(openReviews(view)[0].disabled).toBe(false);

  await uninstallPlugin(view, "epsilon");

  await waitFor(() => expect(openReviews(view)[0].disabled).toBe(true));
  release();
  await waitFor(() => expect(uninstalls).toEqual(["epsilon"]));
  await waitFor(() => expect(openReviews(view)[0].disabled).toBe(false));
});

test("an open component review cannot be approved while another plugin is busy, and can again when it settles", async () => {
  const { api, uninstalls } = createApi({
    names: ["beta", "epsilon"],
    pending: {},
    componentReviews: { beta: review("beta", [{ summary: "adds the hook 'audit'" }]) },
  });
  const release = holdUninstalls(api);
  publishPluginsSectionIntent({ type: "review-components", name: "beta" });
  const view = mount(api);
  const approve = () => buttonNamed(view, "Approve components");
  await waitFor(() => expect(approve()).toBeDefined());
  expect(approve()!.disabled).toBe(false);

  await uninstallPlugin(view, "epsilon");

  await waitFor(() => expect(approve()!.disabled).toBe(true));
  release();
  await waitFor(() => expect(uninstalls).toEqual(["epsilon"]));
  await waitFor(() => expect(approve()!.disabled).toBe(false));
});

test("starting Update all closes the component review that is open", async () => {
  const { api } = createApi({
    names: ["alpha"],
    pending: { alpha: neutral("alpha") },
    componentReviews: { alpha: review("alpha", [{ summary: "adds the hook 'audit'" }]) },
  });
  const view = mount(api);
  const shows = (text: string) => (view.container.textContent ?? "").includes(text);
  const button = await updateAllButton(view);

  publishPluginsSectionIntent({ type: "review-components", name: "alpha" });
  await waitFor(() => expect(shows("adds the hook 'audit'")).toBe(true));

  fireEvent.click(button);

  await waitFor(() => expect(shows("adds the hook 'audit'")).toBe(false));
});
