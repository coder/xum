// Cases for the `local/no-cast-to-api-client` rule in eslint.config.mjs, which keeps test doubles
// typed against the real oRPC procedures (createTestApiClient) instead of cast to the client type.
import { expect, test } from "bun:test";
import { Linter, type Rule } from "eslint";
import tseslint from "typescript-eslint";
import config from "../eslint.config.mjs";

function findRule(): Rule.RuleModule {
  for (const entry of config) {
    const plugin = entry.plugins?.local as { rules?: Record<string, Rule.RuleModule> } | undefined;
    const rule = plugin?.rules?.["no-cast-to-api-client"];
    if (rule) {
      return rule;
    }
  }
  throw new Error("local/no-cast-to-api-client is not registered in eslint.config.mjs");
}

const linter = new Linter({ configType: "flat" });
const lintConfig = [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { local: { rules: { "no-cast-to-api-client": findRule() } } },
    rules: { "local/no-cast-to-api-client": "error" as const },
  },
];

const IMPORTS = [
  `import type { APIClient } from "@/browser/contexts/API";`,
  `import * as APIModule from "@/browser/contexts/API";`,
  `import { useAPI } from "@/browser/contexts/API";`,
  `import type { TestApiOverrides } from "@/browser/testUtils";`,
  `import type { RouterClient } from "@orpc/server";`,
  `import type { AppRouter } from "@/node/orpc/router";`,
  `import { createClient } from "@/common/orpc/client";`,
].join("\n");

function reportCount(code: string, imports = IMPORTS): number {
  return linter.verify(`${imports}\n${code}`, lintConfig, "case.test.ts").length;
}

test("reports a cast to any spelling of the client type, once per chain", () => {
  const casts = [
    `const a = fake as APIClient;`,
    `const a = fake as unknown as APIClient;`,
    `const a = fake as APIModule.APIClient;`,
    `const a = fake as unknown as TestApiOverrides<APIClient>;`,
    `const a = fake as TestApiOverrides<APIClient["projects"]>;`,
    `const a = fake as unknown as NonNullable<ReturnType<typeof useAPI>["api"]>;`,
    `const a = fake as unknown as NonNullable<ReturnType<typeof APIModule.useAPI>["api"]>;`,
    `const a = fake as unknown as RouterClient<AppRouter>;`,
    `const a = fake as ReturnType<typeof createClient>;`,
    `const a = fake as APIClient["workspace"];`,
    `const a = fake as APIClient["workspace"]["getInfo"];`,
    `const a = fake as Partial<APIClient>;`,
    `const a = fake as Readonly<Partial<APIClient>>;`,
  ];
  for (const code of casts) {
    expect({ code, count: reportCount(code) }).toEqual({ code, count: 1 });
  }
});

test("follows aliased imports and local type aliases", () => {
  expect(
    reportCount(`import type { APIClient as Client } from "./api";\nconst a = fake as Client;`)
  ).toBe(1);
  expect(
    reportCount(
      `import type { TestApiOverrides as Overrides } from "./t";\nconst a = fake as unknown as Overrides<X>;`
    )
  ).toBe(1);
  expect(
    reportCount(
      `type Api = NonNullable<ReturnType<typeof useAPI>["api"]>;\ntype Alias = Api;\nconst a = fake as Alias;`
    )
  ).toBe(1);
});

test("allows typed doubles and casts to unrelated types", () => {
  const allowed = [
    `const a = { config: {} } satisfies TestApiOverrides<APIClient>;`,
    `const a: TestApiOverrides<APIClient> = {};`,
    `const a: APIClient = createTestApiClient({});`,
    `const a = createORPCClient<RouterClient<AppRouter>>(link);`,
    `const a = fake as RouterClient<OtherRouter>;`,
    `const a = fake as ReturnType<typeof useOther>["api"];`,
    `const a = fake as ReturnType<typeof useAPI>["status"];`,
    `const a = fake as ReturnType<typeof makeClient>;`,
    `const a = fake as WorkspaceMetadata;`,
    `const a = ["x"] as const;`,
    `type Other = Partial<Config>;\nconst a = fake as Other;`,
  ];
  for (const code of allowed) {
    expect({ code, count: reportCount(code) }).toEqual({ code, count: 0 });
  }
});

test("the factory and router names count only when they are imported", () => {
  // Router and node tests define their own helpers with these names.
  const localHelpers = [
    `function createClient() { return {}; }\nconst a = fake as ReturnType<typeof createClient>;`,
    `const api = { useAPI: () => ({ api: 1 }) };\nconst a = fake as ReturnType<typeof api.useAPI>["api"];`,
    `function useAPI() { return { api: 1 }; }\nconst a = fake as ReturnType<typeof useAPI>["api"];`,
    `type AppRouter = { ping: () => void };\nconst a = fake as RouterClient<AppRouter>;`,
  ];
  const imports = `import type { RouterClient } from "@orpc/server";`;
  for (const code of localHelpers) {
    expect({ code, count: reportCount(code, imports) }).toEqual({ code, count: 0 });
  }
  expect(
    reportCount(
      `import { createClient as make } from "@/common/orpc/client";\nconst a = fake as ReturnType<typeof make>;`,
      ""
    )
  ).toBe(1);
});
