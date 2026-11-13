import * as fs from "node:fs/promises";
import * as path from "node:path";

import { expect, test } from "bun:test";

import { DisposableTempDir } from "@/node/services/tempDir";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { listPluginAgentFiles } from "./agentFiles";

async function shellFlags(
  files: Record<string, string>
): Promise<Record<string, { readonly: boolean; keepsShell: boolean }>> {
  using dir = new DisposableTempDir("agent-files-readonly");
  for (const [name, frontmatter] of Object.entries(files)) {
    await fs.writeFile(path.join(dir.path, name), `---\n${frontmatter}\n---\nBody\n`, "utf-8");
  }
  const agents = await listPluginAgentFiles(dir.path);
  return Object.fromEntries(
    agents.map((agent) => [agent.file, { readonly: agent.readonly, keepsShell: agent.keepsShell }])
  );
}

test("a read-only agent is flagged, and so is whether the mapped tools keep its shell", async () => {
  expect(
    await shellFlags({
      "searcher.md": "description: d\ntools: [Read, Grep, Glob]",
      "cursor-readonly.md": "description: d\nreadonly: true",
      "no-shell.md": "description: d\ntools: [Read, Grep, Glob]\ndisallowedTools: [Bash]",
      "cursor-no-shell.md": "description: d\nreadonly: true\ndisallowedTools: [Bash]",
      // An allowlist without a bash tool removes the shell too, with no `disallowedTools` entry.
      "cursor-tools-no-shell.md": "description: d\nreadonly: true\ntools: [Read]",
      "writer.md": "description: d\ntools: [Read, Edit, Grep]",
      "reads-only.md": "description: d\ntools: [Read]",
    })
  ).toEqual({
    "cursor-no-shell.md": { readonly: true, keepsShell: false },
    "cursor-readonly.md": { readonly: true, keepsShell: true },
    "cursor-tools-no-shell.md": { readonly: true, keepsShell: false },
    "no-shell.md": { readonly: true, keepsShell: false },
    "reads-only.md": { readonly: false, keepsShell: false },
    "searcher.md": { readonly: true, keepsShell: true },
    "writer.md": { readonly: false, keepsShell: false },
  });
});

test("an agent whose description is over the cap is listed with it cut, as discovery loads it", async () => {
  using dir = new DisposableTempDir("agent-files-long-description");
  await fs.writeFile(
    path.join(dir.path, "wordy.md"),
    `---\nname: Wordy\ndescription: ${"w".repeat(2000)}\n---\nBody\n`,
    "utf-8"
  );

  const agents = await listPluginAgentFiles(dir.path);

  expect(agents.map((agent) => agent.file)).toEqual(["wordy.md"]);
  expect((agents[0]?.frontmatter as { description?: string }).description).toBe("w".repeat(1024));
});

test("a file of exactly the size cap is listed, and one byte more is skipped", async () => {
  using dir = new DisposableTempDir("agent-files-size-cap");
  const head = "---\ndescription: d\n---\n";
  const filler = (bytes: number) => head + "x".repeat(bytes - head.length);
  await fs.writeFile(path.join(dir.path, "at-cap.md"), filler(MAX_FILE_SIZE), "utf-8");
  await fs.writeFile(path.join(dir.path, "over-cap.md"), filler(MAX_FILE_SIZE + 1), "utf-8");

  const agents = await listPluginAgentFiles(dir.path);

  expect(agents.map((agent) => agent.file)).toEqual(["at-cap.md"]);
});
