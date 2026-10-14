import { describe, expect, test } from "bun:test";
import { ESLint, Linter } from "eslint";
import tseslint from "typescript-eslint";

// Resolve the real eslint.config.mjs for a path, then lint a snippet with only the
// no-restricted-imports options that the config gives that path. This checks the block order too:
// a later block that matched the same file would replace the guard's options.
const eslint = new ESLint();

async function restrictedImports(filePath: string, code: string): Promise<string[]> {
  const config = (await eslint.calculateConfigForFile(filePath)) as Linter.Config;
  const rule = config.rules?.["no-restricted-imports"];
  if (rule === undefined) return [];
  const messages = new Linter({ configType: "flat" }).verify(
    code,
    [
      {
        files: ["**/*.{ts,tsx}"],
        languageOptions: { parser: tseslint.parser as Linter.Parser },
        rules: { "no-restricted-imports": rule },
      },
    ],
    filePath
  );
  return messages.map((message) => message.message);
}

const barrelMessage = expect.stringContaining("not the @/common/orpc/schemas barrel");
const nodeMessage = expect.stringContaining("must not value-import src/node");
const backendOnlyMessage = expect.stringContaining("module is backend-only");
const shikiMessage = expect.stringContaining("Shiki must only be imported in highlightWorker.ts");
const tokenizerMessage = expect.stringContaining("ai-tokenizer/encoding barrel");

describe("orpc schemas barrel guard", () => {
  test.each([
    ["src/browser/features/Example.tsx", 'import { AgentIdSchema } from "@/common/orpc/schemas";'],
    ["src/common/types/example.ts", 'import { RuntimeModeSchema } from "../orpc/schemas";'],
    ["src/common/utils/a/example.ts", 'import { X } from "../../orpc/schemas";'],
    ["src/browser/example.ts", 'import { X } from "../common/orpc/schemas";'],
    ["src/browser/example.ts", 'import { type A, X } from "@/common/orpc/schemas";'],
    ["src/browser/example.ts", 'export { X } from "@/common/orpc/schemas";'],
    // Later blocks for these folders replace the main guard's options, so they restate it.
    ["src/common/orpc/client.ts", 'import { X } from "@/common/orpc/schemas";'],
    ["src/common/orpc/client.ts", 'import { X } from "./schemas";'],
    ["src/common/orpc/schemas/api.ts", 'import { X } from "../schemas";'],
    ["src/common/config/schemas/example.ts", 'import { X } from "@/common/orpc/schemas";'],
    // Specifiers with a file extension name the barrel too.
    ["src/browser/example.ts", 'import { X } from "@/common/orpc/schemas.ts";'],
    ["src/common/types/example.ts", 'import { X } from "../orpc/schemas.js";'],
    ["src/common/orpc/client.ts", 'import { X } from "./schemas.ts";'],
    ["src/browser/example.ts", 'import X from "@/common/orpc/schemas?url";'],
    ["src/common/orpc/client.ts", 'import X from "./schemas#x";'],
  ])("reports a value import in %s: %s", async (filePath, code) => {
    expect(await restrictedImports(filePath, code)).toEqual([barrelMessage]);
  });

  test.each([
    ["src/browser/example.ts", 'import type { X } from "@/common/orpc/schemas";'],
    ["src/common/types/example.ts", 'import type { X } from "../orpc/schemas";'],
    [
      "src/browser/example.ts",
      'import { RuntimeModeSchema } from "@/common/orpc/schemas/runtime";',
    ],
    ["src/common/types/example.ts", 'import { RuntimeModeSchema } from "../orpc/schemas/runtime";'],
    ["src/common/orpc/types.ts", 'import type * as schemas from "./schemas";'],
    ["src/common/orpc/client.ts", 'import { RuntimeModeSchema } from "./schemas/runtime";'],
    // Backend code does not ship to the browser, so it may use the barrel.
    ["src/node/services/example.ts", 'import { X } from "@/common/orpc/schemas";'],
  ])("allows %s: %s", async (filePath, code) => {
    expect(await restrictedImports(filePath, code)).toEqual([]);
  });

  // The later blocks for src/common/orpc and src/common/config/schemas replace the src-wide
  // block's options, so they must restate these restrictions (#6107).
  test.each([
    "src/browser/example.ts",
    "src/common/orpc/client.ts",
    "src/common/config/schemas/example.ts",
    "src/common/utils/tools/example.ts",
    "src/common/utils/tools/tools.ts",
  ])("keeps the shiki and ai-tokenizer restrictions in %s", async (filePath) => {
    const messages = await restrictedImports(
      filePath,
      'import { codeToHtml } from "shiki";\nimport { o200k } from "ai-tokenizer/encoding";'
    );
    expect(messages).toEqual([shikiMessage, tokenizerMessage]);
  });
});

// A src/node module can value-import the barrel, so browser and common code reaching it through
// src/node bypasses the barrel guard (#6107), e.g. src/common/utils/tools/tools.ts ->
// src/node/services/tools/agent_skill_read.ts -> @/common/orpc/schemas.
describe("src/node guard for browser and common code", () => {
  test.each([
    ["src/browser/example.ts", 'import { log } from "@/node/services/log";'],
    ["src/browser/features/a/example.tsx", 'import { X } from "../../../node/services/log";'],
    ["src/common/types/example.ts", 'export { X } from "@/node/utils/main/tokenizer";'],
    ["src/common/orpc/client.ts", 'import { X } from "@/node/services/log";'],
    ["src/common/config/schemas/example.ts", 'import { X } from "@/node/services/log";'],
    // tsconfig maps @shared/* to src/* too.
    ["src/common/types/example.ts", 'import { X } from "@shared/node/services/log";'],
    // src/constants is shared with the browser too.
    ["src/constants/example.ts", 'import { X } from "@/node/services/log";'],
    // The highlight worker is exempt from the shiki rule only.
    ["src/browser/workers/highlightWorker.ts", 'import { X } from "@/node/services/log";'],
  ])("reports a value import of src/node in %s: %s", async (filePath, code) => {
    expect(await restrictedImports(filePath, code)).toEqual([nodeMessage]);
  });

  // These src/common modules value-import src/node and are exempt from that rule, so browser and
  // common code must not value-import them.
  test.each([
    ["src/browser/example.ts", 'import { getToolsForModel } from "@/common/utils/tools/tools";'],
    ["src/common/types/example.ts", 'import { X } from "../utils/tokens/tokenStatsCalculator";'],
    ["src/common/utils/ai/example.ts", 'import { X } from "../tools/tools";'],
    ["src/common/utils/tools/example.ts", 'import { X } from "./tools";'],
    ["src/common/utils/tokens/example.ts", 'import { X } from "./tokenStatsCalculator.ts";'],
    ["src/common/utils/ai/example.ts", 'import { X } from "./providerOptions";'],
    ["src/common/orpc/client.ts", 'import { X } from "@/common/utils/ai/providerOptions";'],
    // Vite resolves query and hash suffixes to the same module.
    ["src/browser/example.ts", 'import X from "@/common/utils/tools/tools?worker";'],
    ["src/common/utils/tools/example.ts", 'import X from "./tools.ts?raw";'],
    // Files in subfolders reach the module through "../".
    ["src/common/utils/tools/internal/example.ts", 'import { X } from "../tools";'],
    ["src/common/utils/ai/a/b/example.ts", 'import { X } from "../../providerOptions";'],
    // Every guarded folder, alias and re-export form.
    ["src/constants/example.ts", 'import { X } from "@/common/utils/tools/tools";'],
    ["src/browser/workers/highlightWorker.ts", 'import { X } from "@/common/utils/tools/tools";'],
    ["src/common/config/schemas/example.ts", 'import { X } from "@/common/utils/tools/tools";'],
    [
      "src/browser/example.ts",
      'import { X } from "@shared/common/utils/tokens/tokenStatsCalculator";',
    ],
    ["src/common/types/example.ts", 'export { X } from "@/common/utils/ai/providerOptions";'],
  ])("reports a value import of a backend-only module in %s: %s", async (filePath, code) => {
    expect(await restrictedImports(filePath, code)).toEqual([backendOnlyMessage]);
  });

  test.each([
    ["src/browser/example.ts", 'import type { log } from "@/node/services/log";'],
    ["src/common/types/example.ts", 'import type { X } from "@/common/utils/tools/tools";'],
    // Same names in other folders are different modules.
    ["src/common/orpc/schemas/api.ts", 'import { BashToolResultSchema } from "./tools";'],
    ["src/common/orpc/schemas/stream.ts", 'import { X } from "./providerOptions";'],
    ["src/common/types/example.ts", 'import { X } from "./tools";'],
    // The backend-only modules themselves (also among each other), tests, and backend code.
    ["src/common/utils/tools/tools.ts", 'import { X } from "@/common/utils/ai/providerOptions";'],
    ["src/browser/example.test.ts", 'import { X } from "@/common/utils/tools/tools";'],
    [
      "src/common/utils/tools/tools.ts",
      'import { X } from "@/node/services/tools/agent_skill_read";',
    ],
    ["src/common/utils/ai/providerOptions.ts", 'import { log } from "@/node/services/log";'],
    ["src/node/services/example.ts", 'import { X } from "@/common/utils/tools/tools";'],
    // Tests may use src/node helpers in every folder, including the folders with own blocks.
    ["src/common/types/example.test.ts", 'import { X } from "@/node/services/log";'],
    ["src/common/orpc/example.test.ts", 'import { X } from "@/node/services/log";'],
    ["src/common/config/schemas/example.test.ts", 'import { X } from "@/node/services/log";'],
    ["src/browser/workers/highlightWorker.ts", 'import { createHighlighter } from "shiki";'],
  ])("allows %s: %s", async (filePath, code) => {
    expect(await restrictedImports(filePath, code)).toEqual([]);
  });

  test.each([
    ["src/common/orpc/example.test.ts", 'import { X } from "./schemas";', barrelMessage],
    [
      "src/common/config/schemas/example.test.ts",
      'import { X } from "@/common/orpc/schemas/runtime";',
      expect.stringContaining("Config schemas must not import from ORPC"),
    ],
  ])("keeps the folder rules for tests in %s: %s", async (filePath, code, message) => {
    expect(await restrictedImports(filePath, code)).toEqual([message]);
  });
});
