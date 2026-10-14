// Cases for scripts/check-oxlint-config.mjs, which keeps the committed .oxlintrc.json applying
// the same rules as eslint.config.mjs to every lint file.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { findMismatches } from "./check-oxlint-config.mjs";

const restrict = (name: string): Linter.RuleEntry => ["error", { paths: [{ name }] }];

async function mismatches(
  eslintConfig: Linter.Config[],
  oxlintConfig: object,
  files: string[]
): Promise<Record<string, string[]>> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "check-oxlint-config-"));
  try {
    const found = (await findMismatches({
      cwd,
      files,
      oxlintConfig,
      eslintOptions: { overrideConfigFile: true, overrideConfig: eslintConfig },
    })) as Map<string, string[]>;
    return Object.fromEntries(found);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// ESLint skips the second block for test files, so they keep the first block's value.
const eslintWithIgnores: Linter.Config[] = [
  { files: ["src/**/*.ts"], rules: { "no-restricted-imports": restrict("early") } },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: { "no-restricted-imports": restrict("later") },
  },
];
const oxlintOverrides = [
  { files: ["src/**/*.ts"], rules: { "no-restricted-imports": restrict("early") } },
  { files: ["src/**/*.ts"], rules: { "no-restricted-imports": restrict("later") } },
];

test("reports files where oxlint applies a block that ESLint ignores for them", async () => {
  expect(
    await mismatches(eslintWithIgnores, { overrides: oxlintOverrides }, [
      "src/a.ts",
      "src/a.test.ts",
    ])
  ).toEqual({
    "no-restricted-imports: options differ from ESLint's no-restricted-imports": ["src/a.test.ts"],
  });
});

test("passes once an override restores the earlier value for the ignored files", async () => {
  const restored = [
    ...oxlintOverrides,
    { files: ["src/**/*.test.ts"], rules: { "no-restricted-imports": restrict("early") } },
  ];

  expect(
    await mismatches(eslintWithIgnores, { overrides: restored }, ["src/a.ts", "src/a.test.ts"])
  ).toEqual({});
});

test("reports rules that only one of the two configs enables", async () => {
  expect(
    await mismatches(
      [{ files: ["src/**/*.ts"], rules: { eqeqeq: "error" } }],
      { rules: { "no-debugger": "error" } },
      ["src/a.ts"]
    )
  ).toEqual({
    "eqeqeq: ESLint error, oxlint off": ["src/a.ts"],
    "no-debugger: ESLint off, oxlint error": ["src/a.ts"],
  });
});

test("ignores rules oxlint cannot run: type-aware ones and the listed gaps", async () => {
  expect(
    await mismatches(
      [
        {
          files: ["src/**/*.ts"],
          plugins: { "@typescript-eslint": tseslint.plugin },
          rules: {
            "@typescript-eslint/no-floating-promises": "error",
            "no-unsafe-optional-chaining": "error",
          },
        },
      ],
      {},
      ["src/a.ts"]
    )
  ).toEqual({});
});
