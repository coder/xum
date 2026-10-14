// Cases for scripts/gen-oxlintrc.mjs: the generated oxlint config must keep the ESLint config's
// file scoping, so `make lint` reports neither more nor (beyond the documented gaps) fewer
// findings than CI's ESLint run.
import { expect, test } from "bun:test";
import type { Linter } from "eslint";
import { generateOxlintConfig } from "./gen-oxlintrc.mjs";

interface OxlintOverride {
  files: string[];
  jsPlugins?: unknown[];
  rules: Record<string, unknown>;
}

interface OxlintConfig {
  ignorePatterns: string[];
  overrides: OxlintOverride[];
  rules: Record<string, unknown>;
  settings: Record<string, Record<string, unknown>>;
}

const localPlugin = {
  meta: { name: "local" },
  rules: {
    "no-sync-fs-methods": { create: () => ({}) },
    "no-required-member-typeof-guard": { create: () => ({}) },
  },
};

async function generate(blocks: Linter.Config[]): Promise<OxlintConfig> {
  return (await generateOxlintConfig(blocks)) as OxlintConfig;
}

test("anchors global ignores to the repo root, as ESLint resolves them", async () => {
  const config = await generate([{ ignores: ["dist/", "*.js", "!eslint.config.mjs"] }]);

  // An unanchored `*.js` would also skip src/node/workflowRuntime/*.js, which ESLint lints.
  expect(config.ignorePatterns).toEqual(["/dist/", "/*.js", "!/eslint.config.mjs"]);
});

test("turns a block's rules back off for its ignored files", async () => {
  const config = await generate([
    {
      files: ["src/**/*.ts"],
      ignores: ["src/**/*.@(test|spec)*([a-z]).ts"],
      rules: { eqeqeq: "error", "local/no-sync-fs-methods": "error" },
      plugins: { local: localPlugin },
    },
  ]);

  expect(config.overrides).toContainEqual(
    expect.objectContaining({ files: ["src/**/*.ts"], rules: { eqeqeq: "error" } })
  );
  // `@(...)` converts exactly; `*(...)` widens, which only drops local findings.
  expect(config.overrides.at(-1)).toEqual({
    files: ["src/**/*.{test,spec}*.ts"],
    rules: { eqeqeq: "off", "local/no-sync-fs-methods": "off" },
  });
});

test("loads the local rules from eslint-local-rules.mjs, minus those oxlint cannot run", async () => {
  const config = await generate([
    {
      files: ["src/**/*.ts"],
      plugins: { local: localPlugin },
      rules: {
        "local/no-sync-fs-methods": "error",
        "local/no-required-member-typeof-guard": "error",
        "no-unsafe-optional-chaining": "error",
      },
    },
  ]);

  expect(config.overrides).toContainEqual({
    files: ["src/**/*.ts"],
    jsPlugins: [{ name: "local", specifier: "./eslint-local-rules.mjs" }],
    rules: { "local/no-sync-fs-methods": "error" },
  });
  const allRules = [config.rules, ...config.overrides.map((override) => override.rules)];
  for (const rules of allRules) {
    expect(Object.keys(rules)).not.toContain("local/no-required-member-typeof-guard");
    expect(Object.keys(rules)).not.toContain("no-unsafe-optional-chaining");
  }
});

test("rejects an extglob that would widen the files a rule applies to", async () => {
  await expect(
    generate([{ files: ["src/**/*.*([a-z])fixture.ts"], rules: { eqeqeq: "error" } }])
  ).rejects.toThrow(/cannot convert extglob/);
});

test("hoists block settings to the top level, with an explicit React version", async () => {
  const config = await generate([
    {
      files: ["src/**/*.tsx"],
      settings: { react: { version: "detect" }, tailwindcss: { config: false, callees: [] } },
      rules: { eqeqeq: "error" },
    },
  ]);

  expect(config.settings.tailwindcss).toEqual({ config: false, callees: [] });
  expect(config.settings.react.version).toMatch(/^\d+\.\d+\.\d+/);
});
