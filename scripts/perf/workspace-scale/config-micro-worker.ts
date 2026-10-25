import { createConfigStores } from "../../../src/node/config";
import { readFixture, summarize } from "./common";

const root = process.env.XUM_ROOT;
if (!root) throw new Error("Run config-micro.ts instead of the worker directly");
const repetitions = Number(process.argv[2]);
const fixture = await readFixture(root);
const last = fixture.workspaces.at(-1);
if (!last?.id) throw new Error("Fixture has no final workspace ID");
const lastId = last.id;
const { config } = createConfigStores(root);
const operations = {
  loadConfigOrDefault: () => config.loadConfigOrDefault(),
  findWorkspace: () => config.findWorkspace(lastId),
  metadataProbed: () => config.getAllWorkspaceMetadata(),
  metadataUnprobed: () => config.getAllWorkspaceMetadata({ probeCheckouts: false }),
  editConfig: () =>
    config.editConfig((value) => {
      for (const project of value.projects.values()) {
        const workspace = project.workspaces.find((entry) => entry.id === last.id);
        if (workspace) workspace.title = last.title;
      }
      return value;
    }),
};
const timings: Record<string, ReturnType<typeof summarize>> = {};
for (const [name, operation] of Object.entries(operations)) {
  const samples: number[] = [];
  for (let i = 0; i < repetitions; i++) {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  }
  timings[name] = summarize(samples);
}
console.log("WORKSPACE_SCALE_RESULT=" + JSON.stringify(timings));
