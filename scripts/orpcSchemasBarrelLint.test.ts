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

  test("keeps the shiki and ai-tokenizer restrictions in guarded files", async () => {
    const messages = await restrictedImports(
      "src/browser/example.ts",
      'import { codeToHtml } from "shiki";\nimport { o200k } from "ai-tokenizer/encoding";'
    );
    expect(messages).toEqual([
      expect.stringContaining("Shiki must only be imported in highlightWorker.ts"),
      expect.stringContaining("ai-tokenizer/encoding barrel"),
    ]);
  });
});
