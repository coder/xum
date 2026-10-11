import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SEED_CODE_LINE, seedBootWorkspace } from "./bootSeed";

test("seeds a trusted project whose workspace history holds the code line", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boot-seed-test-"));
  try {
    const id = seedBootWorkspace(root);
    const session = path.join(root, "sessions", id);
    expect(JSON.parse(fs.readFileSync(path.join(session, "metadata.json"), "utf8")).id).toBe(id);
    const rows = fs
      .readFileSync(path.join(session, "chat.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { workspaceId: string; parts: Array<{ text: string }> });
    expect(rows.map((row) => row.workspaceId)).toEqual([id, id, id, id]);
    // The code line must open a fenced ts block, or MarkdownComponents renders no .code-line.
    expect(rows[1].parts[0].text).toContain(
      `\`\`\`ts\n/** Returns a minus b. */\n${SEED_CODE_LINE}\n`
    );
    const config = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")) as {
      projects: Array<[string, { trusted?: boolean; workspaces: unknown[] }]>;
    };
    expect(config.projects.map(([, p]) => [p.trusted, p.workspaces.length])).toEqual([[true, 1]]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
