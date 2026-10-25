// Cases for the `local/no-host-imports` rule (eslint-local-rules.mjs), the lint ratchet of the
// agent loop refactor: agent-loop files get host access (fs, os, net, child_process, electron,
// disk helpers, concrete runtimes) from Effect services, not by a value import. Type-only
// imports and pure helpers pass. A file's allow-map entries are today's debt, and an entry the
// file no longer needs fails, so the map only shrinks.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Linter, type Rule } from "eslint";
import tseslint from "typescript-eslint";
import config from "../eslint.config.mjs";

/** The config entry that turns the rule on for the agent-loop files. */
function ruleEntry() {
  const entry = config.find(
    (candidate) => candidate.rules?.["local/no-host-imports"] !== undefined
  );
  if (entry === undefined) throw new Error("local/no-host-imports is in no config entry");
  return entry;
}

function findRule(): Rule.RuleModule {
  for (const entry of config) {
    const plugin = entry.plugins?.local as { rules?: Record<string, Rule.RuleModule> } | undefined;
    const rule = plugin?.rules?.["no-host-imports"];
    if (rule) {
      return rule;
    }
  }
  throw new Error("local/no-host-imports is not registered in eslint.config.mjs");
}

const linter = new Linter({ configType: "flat" });

const MODULES = [
  "fs",
  "fs/promises",
  "os",
  "electron",
  "@/node/utils/writeFileAtomic",
  { module: "@/node/utils/fs", names: ["ensurePrivateDir", "ensurePrivateDirSync"] },
  "@/node/runtime/LocalBaseRuntime",
  // The two builders make concrete runtimes. The path helpers and types of runtimeHelpers pass.
  {
    module: "@/node/runtime/runtimeHelpers",
    names: ["createRuntimeForWorkspace", "createRuntimeContextForWorkspace"],
  },
];

/** The message IDs that the rule reports for `code` in src/node/services/tools/x.ts. */
function ids(code: string, allow: Record<string, string[]> = {}): string[] {
  const lintConfig = [
    {
      files: ["**/*.ts"],
      languageOptions: { parser: tseslint.parser },
      plugins: { local: { rules: { "no-host-imports": findRule() } } },
      rules: {
        "local/no-host-imports": ["error", { modules: MODULES, allow }] as ["error", unknown],
      },
    },
  ];
  return linter
    .verify(code, lintConfig, "src/node/services/tools/x.ts")
    .map((message) => message.messageId ?? message.message);
}

test("reports value imports in bare and node: forms", () => {
  expect(ids(`import * as fs from "fs";`)).toEqual(["host"]);
  expect(ids(`import { readFile } from "node:fs/promises";`)).toEqual(["host"]);
  expect(ids(`import os from "node:os";`)).toEqual(["host"]);
  expect(ids(`import "fs";`)).toEqual(["host"]);
  expect(ids(`const fs = require("fs");`)).toEqual(["host"]);
  expect(ids(`await import("electron");`)).toEqual(["host"]);
  expect(ids(`export { readFile } from "fs/promises";`)).toEqual(["host"]);
  expect(ids(`export * from "os";`)).toEqual(["host"]);
  expect(ids(`export {} from "fs";`)).toEqual(["host"]);
  expect(ids("const fs = require(`fs`);")).toEqual(["host"]);
  expect(ids(`import fs = require("fs");`)).toEqual(["host"]);
  expect(ids(`import type fs = require("fs");`)).toEqual([]);
  expect(ids("await import(`node:fs/promises`);")).toEqual(["host"]);
  expect(ids(`require("@/node/utils/writeFileAtomic?fresh=1");`)).toEqual(["host"]);
});

test("resolves relative specifiers, the @shared alias and extensions to @/ modules", () => {
  expect(ids(`import { writeFileAtomic } from "@shared/node/utils/writeFileAtomic";`)).toEqual([
    "host",
  ]);
  expect(ids(`import { LocalBaseRuntime } from "@/node/runtime/LocalBaseRuntime.js";`)).toEqual([
    "host",
  ]);
  expect(ids(`import { writeFileAtomic } from "../../utils/writeFileAtomic";`)).toEqual(["host"]);
  expect(ids(`import { LocalBaseRuntime } from "../../runtime/LocalBaseRuntime";`)).toEqual([
    "host",
  ]);
});

test("passes type-only imports and pure helpers", () => {
  expect(ids(`import type { Stats } from "fs";`)).toEqual([]);
  expect(ids(`import { type Dirent } from "fs/promises";`)).toEqual([]);
  expect(ids(`export type { Stats } from "fs";`)).toEqual([]);
  expect(ids(`import { isErrnoWithCode } from "@/node/utils/fs";`)).toEqual([]);
  expect(ids(`import { ensurePrivateDir } from "@/node/utils/fs";`)).toEqual(["host"]);
  expect(ids(`import { resolveWorkspaceRootPath } from "@/node/runtime/runtimeHelpers";`)).toEqual(
    []
  );
  expect(ids(`import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";`)).toEqual(
    ["host"]
  );
  // A namespace or default import of a module with listed names counts as all names.
  expect(ids(`import * as fsUtils from "@/node/utils/fs";`)).toEqual(["host"]);
});

test("allows listed modules and fails stale entries", () => {
  const allow = { "src/node/services/tools/x.ts": ["fs/promises"] };
  expect(ids(`import { readFile } from "fs/promises";`, allow)).toEqual([]);
  expect(ids(`import os from "os";`, allow)).toEqual(["host", "stale"]);
  expect(ids(`export {};`, allow)).toEqual(["stale"]);
});

// The allow map is frozen: a PR adds a (file, module) pair only when its phase plan lists it.
// Phases 2 to 5 remove pairs until the map is empty.
const FROZEN_ALLOW_PAIRS: string[] = [];

function allowMap(): Record<string, string[]> {
  const setting = ruleEntry().rules?.["local/no-host-imports"] as [
    string,
    { allow: Record<string, string[]> },
  ];
  return setting[1].allow;
}

test("the allow map holds only the frozen (file, module) pairs", () => {
  const pairs = Object.entries(allowMap()).flatMap(([file, modules]) =>
    modules.map((module) => `${file} ${module}`)
  );
  expect(pairs.sort()).toEqual([...FROZEN_ALLOW_PAIRS].sort());
});

test("each allow key is an agent-loop file", () => {
  const entry = ruleEntry();
  const root = path.join(import.meta.dir, "..");
  const matches = (globs: unknown, file: string) =>
    (globs as string[]).some((glob) => new Bun.Glob(glob).match(file));
  for (const file of Object.keys(allowMap())) {
    expect({ file, exists: fs.existsSync(path.join(root, file)) }).toEqual({ file, exists: true });
    expect({ file, loop: matches(entry.files, file) && !matches(entry.ignores, file) }).toEqual({
      file,
      loop: true,
    });
  }
});
