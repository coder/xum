import { expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";

// Exact-step repros may run on the host (no model picks an action there), and the host pause
// (hostPause.ts, #5714) relies on that. A repro that takes the `agent` fixture lets a model pick
// actions, so it must not exist: it belongs in a model-driven suite. At run time it also fails:
// e2e.config.ts gives its agents no model during the pause.
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

test("no repro lets a model pick actions", () => {
  const files = fs.readdirSync(REPROS).filter((name) => name.endsWith(".e2e.ts"));
  expect(files.length).toBeGreaterThan(0);
  const found = files.flatMap((name) => {
    const why = modelDriven(fs.readFileSync(path.join(REPROS, name), "utf8"));
    return why == null ? [] : [`${name}: ${why}`];
  });
  expect(found).toEqual([]);
});
