import { afterEach, expect, test } from "bun:test";
import { flushUserPreferences, getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { createTestApiClient, createTestPreferencesConfig } from "@/browser/testUtils";
import * as defaults from "./runtimeOptionDefaults";

const withRuntimeConfig = (lastRuntimeConfig: Record<string, unknown>) => ({
  workspaceCreation: { byProject: { "/repo": { lastRuntimeConfig } } },
});

afterEach(() => getAppConfigStore().setClient(null));

async function saveAfterOtherClientEdit(
  saved: Record<string, unknown>,
  otherClientEdit: Record<string, unknown>,
  update: (prev: defaults.RuntimeOptionDefaults) => defaults.RuntimeOptionDefaults
) {
  const server = createTestPreferencesConfig(withRuntimeConfig(saved));
  getAppConfigStore().setClient(createTestApiClient({ config: server }));
  await getAppConfigStore().refresh();
  await server.updateUserPreferences({ patches: [withRuntimeConfig(otherClientEdit)] });
  defaults.updateRuntimeOptionDefaults("/repo", update);
  await flushUserPreferences();
  const { userPreferences } = await server.getConfig();
  return userPreferences?.workspaceCreation?.byProject?.["/repo"]?.lastRuntimeConfig;
}

test("an update keeps runtime options another client changed after this snapshot", async () => {
  const saved = await saveAfterOtherClientEdit(
    { ssh: { host: "a@host", coderEnabled: false }, docker: { image: "a" } },
    { ssh: { coderEnabled: true }, docker: { image: "b" } },
    (prev) => defaults.writeOptionField(prev, "ssh", "host", "c@host")
  );
  expect(saved).toEqual({ ssh: { host: "c@host", coderEnabled: true }, docker: { image: "b" } });
});

test("an update deletes the fields it removed", async () => {
  const oldCoder = { existingWorkspace: true, workspaceName: "old", template: "t1", preset: "p" };
  const newCoder = { existingWorkspace: false, template: "t2" };
  const saved = await saveAfterOtherClientEdit({ ssh: { coderConfig: oldCoder } }, {}, (prev) =>
    defaults.writeSshCoderDefaultsPreservingMode(prev, newCoder)
  );
  expect(saved).toEqual({ ssh: { coderEnabled: false, coderConfig: newCoder } });
});
