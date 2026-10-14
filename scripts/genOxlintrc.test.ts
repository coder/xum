// Cases for scripts/gen-oxlintrc.mjs: every file must get exactly the rules ESLint applies to it,
// so `make lint` reports neither more nor (beyond the documented gaps) fewer findings than CI.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Linter } from "eslint";
import { generateOxlintConfig } from "./gen-oxlintrc.mjs";

interface OxlintOverride {
  files: string[];
  jsPlugins?: unknown[];
  rules: Record<string, unknown>;
}

interface OxlintConfig {
  overrides: OxlintOverride[];
  settings: Record<string, Record<string, unknown>>;
}

const localPlugin = {
  meta: { name: "local" },
  rules: {
    "no-sync-fs-methods": { create: () => ({}) },
    "no-required-member-typeof-guard": { create: () => ({}) },
  },
};

const restrict = (name: string): Linter.RuleEntry => ["error", { paths: [{ name }] }];

async function generate(blocks: Linter.Config[], files: string[]): Promise<OxlintConfig> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gen-oxlintrc-"));
  try {
    return (await generateOxlintConfig({
      cwd,
      files,
      eslintOptions: { overrideConfigFile: true, overrideConfig: blocks },
    })) as OxlintConfig;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function overrideFor(config: OxlintConfig, file: string): OxlintOverride | undefined {
  return config.overrides.find((override) => override.files.includes(file));
}

test("gives files that a block ignores the values of the blocks before and after it", async () => {
  const config = await generate(
    [
      { files: ["src/**/*.ts"], rules: { "no-restricted-imports": restrict("early") } },
      {
        files: ["src/**/*.ts"],
        ignores: ["src/**/*.test.ts"],
        rules: { "no-restricted-imports": restrict("ignoring") },
      },
      { files: ["src/late/**/*.ts"], rules: { "no-restricted-imports": restrict("late") } },
    ],
    ["src/a.ts", "src/a.test.ts", "src/late/b.test.ts"]
  );

  expect(overrideFor(config, "src/a.ts")?.rules["no-restricted-imports"]).toEqual(
    restrict("ignoring")
  );
  expect(overrideFor(config, "src/a.test.ts")?.rules["no-restricted-imports"]).toEqual(
    restrict("early")
  );
  expect(overrideFor(config, "src/late/b.test.ts")?.rules["no-restricted-imports"]).toEqual(
    restrict("late")
  );
});

test("gives files that ESLint ignores no rules", async () => {
  const config = await generate(
    [{ ignores: ["src/ignored.ts"] }, { files: ["src/**/*.ts"], rules: { eqeqeq: "error" } }],
    ["src/kept.ts", "src/ignored.ts"]
  );

  expect(overrideFor(config, "src/kept.ts")?.rules).toEqual({ eqeqeq: "error" });
  expect(overrideFor(config, "src/ignored.ts")).toBeUndefined();
});

test("loads the local rules from eslint-local-rules.mjs, minus those oxlint cannot run", async () => {
  const config = await generate(
    [
      {
        files: ["src/**/*.ts"],
        plugins: { local: localPlugin },
        rules: {
          "local/no-sync-fs-methods": "error",
          "local/no-required-member-typeof-guard": "error",
          "no-unsafe-optional-chaining": "error",
        },
      },
    ],
    ["src/a.ts"]
  );

  expect(overrideFor(config, "src/a.ts")).toMatchObject({
    jsPlugins: [{ name: "local", specifier: "./eslint-local-rules.mjs" }],
    rules: { "local/no-sync-fs-methods": "error" },
  });
  expect(Object.keys(overrideFor(config, "src/a.ts")?.rules ?? {})).toEqual([
    "local/no-sync-fs-methods",
  ]);
});

test("hoists settings to the top level, with an explicit React version", async () => {
  const config = await generate(
    [
      {
        files: ["src/**/*.tsx"],
        settings: { react: { version: "detect" }, tailwindcss: { config: false, callees: [] } },
        rules: { eqeqeq: "error" },
      },
    ],
    ["src/a.tsx"]
  );

  expect(config.settings.tailwindcss).toEqual({ config: false, callees: [] });
  expect(config.settings.react.version).toMatch(/^\d+\.\d+\.\d+/);
});
