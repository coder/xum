import { expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Exact-step repros may run on the host (no model picks an action there), and the host pause
// (hostPause.ts, #5714) relies on that. A repro that takes the `agent` fixture lets a model pick
// actions. The user allowed that (a repro can state the bug as a story), but only with the
// `agent` tag on each of its tests: the free runs (`make test-bugbash-repros`, the sandbox repro
// job) pass `--exclude-tag agent`, so no such test runs where e2e.config.ts gives no model.
const REPROS = path.join(import.meta.dir, "repros");

/** Why a test file lets a model pick actions, or null. */
function modelDriven(source: string): string | null {
  for (const match of source.matchAll(/\(\s*\{([^}]*)\}\s*\)\s*=>/g))
    if (match[1].split(",").some((name) => name.trim().split(/[\s:=]/)[0] === "agent"))
      return "takes the agent fixture";
  if (/\bagent\s*\.\s*\w+\s*\(/.test(source)) return "calls agent.*";
  return null;
}

test("the rule catches a suite that drives flows with agent.act", () => {
  const suite = fs.readFileSync(path.join(import.meta.dir, "mcpapps/mcp-apps.e2e.ts"), "utf8");
  expect(modelDriven(suite)).not.toBeNull();
  expect(modelDriven("test('x', async ({ screen, agent: a }) => {})")).toBe(
    "takes the agent fixture"
  );
});

/**
 * Whether every test in the file has the `agent` tag. A narrow grammar on purpose: comments are
 * removed first, and then each `test(` call must hold a literal `tags: [...]` array with "agent"
 * before its callback starts (`=>`). So a tag in a comment, in a helper or on another test does
 * not count, and tags from a variable count as untagged.
 */
function agentTagged(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // Not `pattern.test(...)`: only a bare `test(` call declares a test.
  const calls = [...code.matchAll(/(?<![\w$.])test\s*\(/g)];
  return (
    calls.length > 0 &&
    calls.every((call) => {
      const head = code.slice(call.index, code.indexOf("=>", call.index) >>> 0);
      return /\btags\s*:\s*\[[^\]]*(["'`])agent\1/.test(head);
    })
  );
}

test("the agent tag must cover every test of a model-driven file", () => {
  const tagged = 'test("x", { tags: ["bugbash", "agent"] }, async ({ agent }) => {});';
  const untagged = 'test("y", { tags: ["bugbash"] }, async ({ agent }) => {});';
  expect(agentTagged(tagged)).toBe(true);
  expect(agentTagged(untagged)).toBe(false);
  expect(agentTagged(`${tagged}\n${untagged}`)).toBe(false);
  expect(agentTagged('test("x", { tags: TAGS }, async ({ agent }) => {});')).toBe(false);
  // A tag outside the test call does not count (Codex review of #7006).
  expect(agentTagged(`// tags: ["agent"]\n${untagged}`)).toBe(false);
  expect(agentTagged(`const opts = { tags: ["agent"] };\n${untagged}`)).toBe(false);
  expect(agentTagged(`/* tags: ["agent"] */ ${untagged}`)).toBe(false);
  expect(agentTagged(`${tagged}\nconst ok = /x/.test("x");`)).toBe(true);
});

// Every model-driven test file under `dir` that does not tag each of its tests `agent`.
// Recursive, like the runner's tests glob (e2e.config.ts).
function modelDrivenFiles(dir: string): string[] {
  const files = fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".e2e.ts"));
  expect(files.length).toBeGreaterThan(0);
  return files.flatMap((name) => {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    const why = modelDriven(source);
    return why == null || agentTagged(source) ? [] : [`${name}: ${why}`];
  });
}

test("the scan finds a model-driven repro in a nested folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-repro-rules-"));
  try {
    fs.mkdirSync(path.join(dir, "group"));
    fs.writeFileSync(path.join(dir, "group/x.e2e.ts"), "test('x', async ({ agent }) => {})");
    fs.writeFileSync(
      path.join(dir, "group/tagged.e2e.ts"),
      "test('y', { tags: ['bugbash', 'agent'] }, async ({ agent }) => {})"
    );
    expect(modelDrivenFiles(dir)).toEqual([
      `${path.join("group", "x.e2e.ts")}: takes the agent fixture`,
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no repro lets a model pick actions without the agent tag", () => {
  expect(modelDrivenFiles(REPROS)).toEqual([]);
});
