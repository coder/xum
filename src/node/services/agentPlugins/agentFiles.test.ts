import * as fs from "node:fs/promises";
import * as path from "node:path";

import { expect, test } from "bun:test";

import { DisposableTempDir } from "@/node/services/tempDir";
import { listPluginAgentFiles } from "./agentFiles";

async function readonlyFlags(files: Record<string, string>): Promise<Record<string, boolean>> {
  using dir = new DisposableTempDir("agent-files-readonly");
  for (const [name, frontmatter] of Object.entries(files)) {
    await fs.writeFile(path.join(dir.path, name), `---\n${frontmatter}\n---\nBody\n`, "utf-8");
  }
  const agents = await listPluginAgentFiles(dir.path);
  return Object.fromEntries(agents.map((agent) => [agent.file, agent.readonly]));
}

test("an agent is read-only for the review only while it runs on Explore and keeps bash", async () => {
  expect(
    await readonlyFlags({
      "searcher.md": "description: d\ntools: [Read, Grep, Glob]",
      "cursor-readonly.md": "description: d\nreadonly: true",
      "no-shell.md": "description: d\ntools: [Read, Grep, Glob]\ndisallowedTools: [Bash]",
      "cursor-no-shell.md": "description: d\nreadonly: true\ndisallowedTools: [Bash]",
      "writer.md": "description: d\ntools: [Read, Edit, Grep]",
      "plain.md": "description: d",
    })
  ).toEqual({
    "cursor-no-shell.md": false,
    "cursor-readonly.md": true,
    "no-shell.md": false,
    "plain.md": false,
    "searcher.md": true,
    "writer.md": false,
  });
});
