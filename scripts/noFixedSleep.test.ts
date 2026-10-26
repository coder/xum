// Cases for the `local/no-fixed-sleep` rule in eslint.config.mjs, which keeps browser tests from
// waiting a fixed real time before they check what happened.
import { expect, test } from "bun:test";
import { Linter, type Rule } from "eslint";
import tseslint from "typescript-eslint";
import config from "../eslint.config.mjs";

function findRule(): Rule.RuleModule {
  for (const entry of config) {
    const plugin = entry.plugins?.local as { rules?: Record<string, Rule.RuleModule> } | undefined;
    const rule = plugin?.rules?.["no-fixed-sleep"];
    if (rule) {
      return rule;
    }
  }
  throw new Error("local/no-fixed-sleep is not registered in eslint.config.mjs");
}

const linter = new Linter({ configType: "flat" });
const FILE = "src/browser/case.test.ts";

function messages(code: string, allow: Record<string, number> = {}) {
  return linter.verify(
    code,
    [
      {
        files: ["**/*.ts"],
        languageOptions: { parser: tseslint.parser },
        plugins: { local: { rules: { "no-fixed-sleep": findRule() } } },
        rules: { "local/no-fixed-sleep": ["error", { allow }] },
      },
    ],
    FILE
  );
}

const reportCount = (code: string) => messages(code).length;

test("reports a fixed wait of 20 ms or more in each spelling", () => {
  const waits = [
    `await new Promise((resolve) => setTimeout(resolve, 20));`,
    `await new Promise<void>((r) => { setTimeout(r, 1_000); });`,
    `await new Promise((resolve) => setTimeout(() => resolve(undefined), 50));`,
    `await new Promise((resolve) => window.setTimeout(resolve, 50));`,
    `await act(() => new Promise((resolve) => setTimeout(resolve, 50)));`,
    `await Bun.sleep(20);`,
    `const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));\nawait sleep(400);`,
    `function tick(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }\nawait tick(400);`,
    `function tick(ms = 50) { return new Promise((resolve) => setTimeout(resolve, ms)); }\nawait tick();`,
  ];
  for (const code of waits) {
    expect({ code, count: reportCount(code) }).toEqual({ code, count: 1 });
  }
});

test("a delay the rule cannot prove short counts as a fixed wait", () => {
  const waits = [
    `await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS));`,
    `await Bun.sleep(STATUS_DELAY_MS + 50);`,
    `const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));\nawait sleep(40 * RETRY_MS);`,
  ];
  for (const code of waits) {
    expect({ code, count: reportCount(code) }).toEqual({ code, count: 1 });
  }
  expect(messages(`await Bun.sleep(DELAY_MS + 50);`)[0]?.message).toContain("`DELAY_MS + 50` ms");
});

test("a helper with a fixed delay counts once per call", () => {
  const helper = `const waitForThrottle = () => new Promise((resolve) => setTimeout(resolve, 120));`;
  expect(reportCount(`${helper}\nawait waitForThrottle();\nawait waitForThrottle();`)).toBe(2);
  // Also through an act() callback, the shape of the reconnect suites' old flush().
  const flush = `async function flush() {\n  await act(async () => {\n    await new Promise((resolve) => setTimeout(resolve, 20));\n  });\n}`;
  expect(reportCount(`${flush}\nawait flush();\nawait flush();\nawait flush();`)).toBe(3);
});

test("allows yields under 20 ms, timers that do not resolve a wait, and signals", () => {
  const allowed = [
    `await new Promise((resolve) => setTimeout(resolve, 0));`,
    `await new Promise((resolve) => setTimeout(resolve, 19));`,
    `function tick(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }\nawait tick(); await tick(10);`,
    `setTimeout(() => emit("late"), 50);`,
    `await new Promise((resolve, reject) => setTimeout(() => reject(new Error("timeout")), 50));`,
    `await waitFor(() => expect(calls).toBe(1), { timeout: 2000 });`,
    `function setTimeout(fn: () => void, ms: number) {}\nawait new Promise((resolve) => setTimeout(resolve, 50));`,
    `const Bun = { sleep: (_ms: number) => Promise.resolve() };\nawait Bun.sleep(20);`,
    `const settle = () => new Promise((resolve) => setTimeout(resolve, 50));`,
  ];
  for (const code of allowed) {
    expect({ code, count: reportCount(code) }).toEqual({ code, count: 0 });
  }
});

test("the allow entry is an exact count that can only go down", () => {
  const twoWaits = `await Bun.sleep(20);\nawait Bun.sleep(30);`;
  expect(messages(twoWaits, { [FILE]: 2 })).toHaveLength(0);
  // A new wait past the entry fails.
  expect(messages(twoWaits, { [FILE]: 1 }).map((m) => m.message)).toEqual([
    expect.stringContaining("fixed 30 ms"),
  ]);
  // A removed wait must lower the entry.
  expect(messages(twoWaits, { [FILE]: 3 }).map((m) => m.message)).toEqual([
    expect.stringContaining("Lower the entry"),
  ]);
});
