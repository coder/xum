// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tailwindcss from "eslint-plugin-tailwindcss";
import tseslint from "typescript-eslint";
import localPlugin from "./eslint-local-rules.mjs";

// Shared by the two no-restricted-imports blocks for src/** (a later block replaces an earlier
// block's options for the files it matches, so each block must restate these).
const AI_TOKENIZER_ENCODING_RESTRICTION = {
  name: "ai-tokenizer/encoding",
  allowTypeImports: true,
  message:
    "The ai-tokenizer/encoding barrel evaluates all four encodings (~14.5 s of CPU, #4816). Load one encoding through its subpath (ai-tokenizer/encoding/<name>) inside tokenizer.worker.ts.",
};
const SHIKI_RESTRICTION = {
  group: ["shiki"],
  importNamePattern: "^(?!type\\s)",
  allowTypeImports: true,
  message:
    "Shiki must only be imported in highlightWorker.ts to avoid blocking the main thread. Use highlightCode() from highlightWorkerClient.ts instead.",
};
// Browser and common code must not value-import the @/common/orpc/schemas barrel (#5971).
// Matches "@/common/orpc/schemas" and relative forms such as "../orpc/schemas", but not leaf
// modules such as "@/common/orpc/schemas/runtime". Every later no-restricted-imports block that
// matches browser or common files must include it, because that block replaces this one's options.
const ORPC_SCHEMAS_BARREL_RESTRICTION = {
  regex: "(^|/)orpc/schemas$",
  allowTypeImports: true,
  message:
    "Import schemas from their leaf module (e.g. @/common/orpc/schemas/runtime), not the @/common/orpc/schemas barrel: a value import of the barrel adds every schema to the first load. Type-only imports are fine.",
};

export default defineConfig([
  {
    ignores: [
      "dist/",
      "build/",
      "node_modules/",
      "*.js",
      "*.cjs",
      "*.mjs",
      "!eslint.config.mjs",
      "vite.config.ts",
      "electron.vite.config.ts",
      "src/browser/main.tsx",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        exports: "writable",
        module: "writable",
        require: "readonly",
        global: "readonly",
        window: "readonly",
        document: "readonly",
        requestAnimationFrame: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        navigator: "readonly",
        alert: "readonly",
      },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      tailwindcss,
      local: localPlugin,
    },
    linterOptions: {
      // Grandfathered anti-slop violations are marked with per-site
      // eslint-disable-next-line directives. Erroring on unused directives
      // makes that a true shrink-only ratchet: fixing a site forces removal
      // of its directive, and the directive cannot silently outlive the code.
      reportUnusedDisableDirectives: "error",
    },
    settings: {
      react: {
        version: "detect",
      },
      tailwindcss: {
        // Don't try to load Tailwind config (v4 doesn't export resolveConfig)
        config: false,
        // CSS files to check
        cssFiles: ["**/*.css", "!**/node_modules", "!**/.*", "!**/dist", "!**/build"],
        // Disable callees check to avoid resolving config
        callees: [],
      },
    },
    rules: {
      ...react.configs.recommended.rules,
      // Use recommended-latest to get React Compiler lint rules
      ...reactHooks.configs["recommended-latest"].rules,

      // Flag unused variables, parameters, and imports
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          vars: "all",
          args: "after-used",
          ignoreRestSiblings: true,
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
        },
      ],

      // Prohibit 'as any' type assertions
      "@typescript-eslint/no-explicit-any": "error",

      // Additional rule to catch 'as any' specifically
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        {
          assertionStyle: "as",
          objectLiteralTypeAssertions: "allow-as-parameter",
        },
      ],

      // Enforce shorthand array notation, e.g. Foo[] instead of Array<Foo>
      "@typescript-eslint/array-type": [
        "error",
        {
          default: "array-simple",
          readonly: "array-simple",
        },
      ],

      // Keep type-only imports explicit to avoid runtime inclusion
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          disallowTypeAnnotations: true,
        },
      ],

      // Require handling Promises instead of letting them float
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          ignoreVoid: true,
          ignoreIIFE: true,
        },
      ],

      // Highlight unnecessary assertions to keep code idiomatic
      "@typescript-eslint/no-unnecessary-type-assertion": "error",

      // Switches over union types must handle every member (or declare an
      // explicit default). Pairs with the Record<Enum, Value> mapping rule:
      // adding a union member then surfaces every switch that needs updating.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        {
          // A default case counts as handling the rest; without this the rule
          // would force enumerating members that intentionally share one path.
          considerDefaultExhaustiveForUnions: true,
        },
      ],

      // Encourage readonly where possible to surface unintended mutations
      "@typescript-eslint/prefer-readonly": [
        "error",
        {
          onlyInlineLambdas: true,
        },
      ],

      // Prevent using any type at all
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      // React specific
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",

      // Tailwind CSS
      "tailwindcss/classnames-order": "warn",
      "tailwindcss/enforces-negative-arbitrary-values": "warn",
      "tailwindcss/enforces-shorthand": "warn",
      "tailwindcss/migration-from-tailwind-2": "warn",
      "tailwindcss/no-arbitrary-value": "off",
      "tailwindcss/no-contradicting-classname": "error",
      "tailwindcss/no-custom-classname": "off",

      // Safe Node.js patterns
      "local/no-unsafe-child-process": "error",
      "local/no-sync-fs-methods": "error",
      "local/no-cross-boundary-imports": "error",

      "local/no-native-interactive-tooltips": "error",

      // Anti-slop ports (see localPlugin). Chained assertions are banned in
      // production code; test/story/mock files are exempt (casting partial
      // doubles through `unknown` is the standard mock idiom). Pre-existing
      // violations carry per-site eslint-disable-next-line directives so new
      // violations fail lint even in files that contain grandfathered ones.
      "local/no-chained-type-assertions": "error",
      // Implemented but not enforced: 629 existing occurrences across 145
      // files use `...(cond ? { x } : {})` deliberately to omit keys
      // (omitted-vs-undefined matters for JSON serialization and spread
      // merging). Flip to "error" only after a codebase-wide cleanup.
      "local/no-conditional-empty-object-spread": "off",
      // Assertion-position widening of known values (`{...} as Record<string,
      // unknown>`, `literal as unknown`) is never necessary — an annotation or
      // `satisfies` always works and, unlike an assertion, cannot mask typos.
      // Annotation flows stay unchecked (checkAnnotations: false): 247 prod
      // sites include semantically required open dictionaries (arbitrary-key
      // tables like `Record<string, LucideIcon>` need the index signature at
      // call sites), the `Record<Enum, Value>` exhaustive-mapping pattern this
      // repo mandates, and legit `unknown`-returning boundary parsers.
      "local/no-known-value-widening": ["error", { checkAnnotations: false }],
      "local/no-widen-then-assert": "error",
      "local/no-unknown-type-aliases": "error",
      "local/no-object-parameters": "error",

      // Allow console for this app (it's a dev tool)
      "no-console": "off",

      // Allow require in specific contexts
      "@typescript-eslint/no-var-requires": "off",

      // Enforce absolute imports with @/ alias for cross-directory imports
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../!(tests)*", "../../!(tests)*"],
              message:
                "Use absolute imports with @/ instead of relative parent imports. Same-directory imports (./foo) are allowed.",
            },
          ],
        },
      ],

      // Warn on TODO comments
      "no-warning-comments": [
        "off",
        {
          terms: ["TODO", "FIXME", "XXX", "HACK"],
          location: "start",
        },
      ],

      // Enable TypeScript deprecation warnings
      "@typescript-eslint/prefer-ts-expect-error": "error",

      // Ban @ts-ignore comments and suggest @ts-expect-error instead
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          minimumDescriptionLength: 3,
        },
      ],

      // Ban dynamic imports - they hide circular dependencies and should be avoided
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message:
            "Dynamic imports are not allowed. Use static imports at the top of the file instead. Dynamic imports hide circular dependencies and improper module structure.",
        },
      ],

      // Prevent accidentally interpolating undefined/null in template literals and JSX
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowNumber: true,
          allowBoolean: true,
          allowAny: false,
          allowNullish: false, // Catch undefined/null interpolations
          allowRegExp: false,
        },
      ],
    },
  },
  {
    // Allow dynamic imports for lazy-loading (startup optimization / platform compat)
    files: [
      "src/services/aiService.ts",
      "src/utils/tools/tools.ts",
      "src/utils/ai/providerFactory.ts",
      "src/utils/main/tokenizer.ts",
      "src/node/runtime/SSH2ConnectionPool.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  {
    // Web storage goes through the persisted-state helpers (see local/no-direct-web-storage).
    // Tests, stories and story utilities seed and inspect storage directly.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/browser/hooks/usePersistedState.ts",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.stories.ts",
      "**/*.stories.tsx",
      "src/browser/stories/**",
      "src/**/*StoryUtils.tsx",
      "**/*.testHarness.ts",
      "src/**/test[A-Z]*.ts",
    ],
    rules: {
      "local/no-direct-web-storage": "error",
    },
  },
  {
    // Backend production code: required-member typeof guards only exist to tolerate partial
    // test doubles; tests must complete the doubles instead (see the rule's docs).
    files: ["src/node/services/**/*.ts"],
    ignores: ["**/*.test.ts", "**/*.testHarness.ts", "**/*.testUtils.ts", "**/test*/**"],
    rules: {
      "local/no-required-member-typeof-guard": "error",
    },
  },
  {
    // Temporarily allow sync fs methods in files with existing usage
    // TODO: Gradually migrate these to async operations
    files: [
      "src/node/config/index.ts",
      "src/node/config/**/*.ts",
      "src/cli/debug/**/*.ts",
      "src/node/git.ts",
      "src/desktop/main.ts",
      "src/node/config.test.ts",
      "src/node/services/gitService.ts",
      "src/node/services/log.ts",
      "src/node/services/streamManager.ts",
      "src/node/services/tempDir.ts",
      "src/node/services/tools/bash.ts",
      "src/node/services/tools/bash.test.ts",
      "src/node/services/tools/testHelpers.ts",
      "src/node/utils/providerRequirements.ts",
    ],
    rules: {
      "local/no-sync-fs-methods": "off",
    },
  },
  {
    // Frontend architectural boundary - prevent services and tokenizer imports
    // Note: src/browser/utils/** and src/browser/stores/** are not included because:
    // - Some utils are shared between main/renderer (e.g., utils/tools registry)
    // - Stores can import from utils/messages which is renderer-safe
    // - Type-only imports from services are safe (types live in src/common/types/)
    files: [
      "src/browser/components/**",
      "src/browser/contexts/**",
      "src/browser/hooks/**",
      "src/browser/App.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/services/**", "../services/**", "../../services/**"],
              message:
                "Frontend code cannot import from services/. Use IPC or move shared code to utils/.",
            },
            {
              group: ["**/tokens/tokenizer", "**/tokens/tokenStatsCalculator"],
              message:
                "Frontend code cannot import tokenizer (2MB+ encodings). Use @/utils/tokens/usageAggregator for aggregation or @/utils/tokens/modelStats for pricing.",
            },
            {
              group: ["**/utils/main/**", "@/utils/main/**"],
              message:
                "Frontend code cannot import from utils/main/ (contains Node.js APIs). Move shared code to utils/ or use IPC.",
            },
          ],
        },
      ],
    },
  },
  {
    // Shiki must only be imported in the highlight worker to avoid blocking main thread
    // Type-only imports are allowed (erased at compile time)
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/browser/workers/highlightWorker.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // Lives here, not in the src/** block above: this later block replaces that block's
          // no-restricted-imports options for every file it matches.
          paths: [AI_TOKENIZER_ENCODING_RESTRICTION],
          patterns: [SHIKI_RESTRICTION],
        },
      ],
    },
  },
  {
    // Browser and common code import schemas from their leaf modules, never the
    // @/common/orpc/schemas barrel: one value import of the barrel puts every schema, including
    // the api.ts router schemas, on the browser's first load (#5971). Type-only imports are
    // erased at compile time, so they stay allowed. Restates the block above, because this block
    // replaces its no-restricted-imports options for the files it matches.
    files: ["src/browser/**/*.{ts,tsx}", "src/common/**/*.{ts,tsx}"],
    ignores: ["src/browser/workers/highlightWorker.ts", "src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [AI_TOKENIZER_ENCODING_RESTRICTION],
          patterns: [SHIKI_RESTRICTION, ORPC_SCHEMAS_BARREL_RESTRICTION],
        },
      ],
    },
  },
  {
    // ORPC must import config schemas via direct file paths, never the schemas barrel
    files: ["src/common/orpc/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/common/config/schemas",
              message:
                "Import config schemas via direct file paths (e.g., @/common/config/schemas/appConfigOnDisk), not the barrel.",
            },
            {
              name: "@/common/config/schemas/index",
              message:
                "Import config schemas via direct file paths (e.g., @/common/config/schemas/appConfigOnDisk), not the barrel.",
            },
          ],
          patterns: [
            ORPC_SCHEMAS_BARREL_RESTRICTION,
            // Inside src/common/orpc, "./schemas" and "../schemas" are the barrel too.
            { ...ORPC_SCHEMAS_BARREL_RESTRICTION, regex: "^\\.\\.?/schemas$" },
          ],
        },
      ],
    },
  },
  {
    // Config schemas must remain independent from ORPC schema definitions
    files: ["src/common/config/schemas/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/common/orpc/schemas/*", "**/orpc/schemas/*"],
              message:
                "Config schemas must not import from ORPC; use @/common/schemas/* or @/common/config/schemas/* instead.",
            },
            ORPC_SCHEMAS_BARREL_RESTRICTION,
          ],
        },
      ],
    },
  },
  {
    // Production code must not add non-null assertions: `x!` hides a missing
    // check, and the CRAP gate (.xum/skills/crap-gate) forbids trading `?.`/`??`
    // for `!` to lower complexity. Each site from before the ban carries an
    // inline disable comment; reportUnusedDisableDirectives flags a stale one.
    files: ["src/**/*.{ts,tsx}"],
    // These globs must match isProductionSource() in
    // scripts/check-test-seam-comments.ts, the repo's one definition of
    // production code (the CRAP gate uses it too), plus benchmarks. Change both
    // together; do not add conventions that isProductionSource() does not have.
    ignores: [
      "src/**/{__tests__,__mocks__,test,tests,testing,mocks,stories}/**",
      "src/**/*.@(test|spec)*([a-zA-Z0-9_-]).{ts,tsx}",
      "src/**/*.@(stories|generated).{ts,tsx}",
      "src/**/test[A-Z_.-]*",
      "src/**/*Test@(Helper|Helpers|Harness|Utils|Fixture|Fixtures|Overlay|Child)[!a-zA-Z0-9_]*",
      "src/**/*.*([a-zA-Z0-9_])[fF]ixture?(s).{ts,tsx}",
      "src/version.ts",
      "src/**/*.bench.{ts,tsx}",
    ],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  {
    // Renderer process (frontend) architectural boundary - prevent Node.js API usage
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [
      "src/cli/**",
      "src/desktop/**",
      "src/node/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      // This file is only used by Node.js code (cli/debug) but lives in common/
      // TODO: Consider moving to node/utils/
      "src/common/utils/providers/ensureProvidersConfig.ts",
      // Telemetry uses defensive process checks for test environments
      "src/common/telemetry/**",
    ],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "process",
          message:
            "Renderer code cannot access 'process' global (not available in renderer). Use IPC to communicate with main process or use constants for environment-agnostic values.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Renderer code cannot access process.env (not available in renderer). Use IPC to get environment variables from main process or use constants.",
        },
      ],
    },
  },
  {
    // Workflow/action/runtime and script helper sources are plain JS evaluated outside the TS
    // program (QuickJS, skill assets, generated child-process wrappers, or local tooling), so
    // type-aware rules cannot apply. Lint them with core untyped rules so typos and dead helpers
    // fail loudly instead of becoming silent globals.
    files: [
      "src/node/builtinSkills/**/*.js",
      "src/node/builtinWorkflowActions/**/*.js",
      "src/node/workflowRuntime/*.js",
      "scripts/lib/*.js",
    ],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        exports: "writable",
        module: "writable",
        require: "readonly",
        globalThis: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        mux: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/prefer-for-of": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-undef": "error",
      "no-unused-vars": "error",
    },
  },
  {
    files: ["src/node/builtinWorkflowActions/**/_shared.js"],
    rules: {
      "no-unused-vars": "off",
    },
  },
  {
    files: ["src/node/builtinWorkflowActions/**/*.js"],
    ignores: ["src/node/builtinWorkflowActions/**/_shared.js"],
    languageOptions: {
      globals: {
        boundedCharBudget: "readonly",
        boundedCommentBodyCaptureBytes: "readonly",
        boundedIssueViewBodyCaptureBytes: "readonly",
        boundedIssueListBodyCaptureBytes: "readonly",
        boundedLimit: "readonly",
        captureGit: "readonly",
        excludedLabelSearchQuery: "readonly",
        findComment: "readonly",
        getIssueView: "readonly",
        inputObject: "readonly",
        issueListBodyJq: "readonly",
        isMatchingMarker: "readonly",
        listComments: "readonly",
        markerStatus: "readonly",
        normalizeIssue: "readonly",
        optionalString: "readonly",
        parseNameStatus: "readonly",
        parseStatusLine: "readonly",
        readStatus: "readonly",
        repositoryFromInput: "readonly",
        requiredIssueNumber: "readonly",
        requiredRepository: "readonly",
        requiredString: "readonly",
        resolveBase: "readonly",
        resolveMergeBase: "readonly",
        runGit: "readonly",
        splitRepository: "readonly",
        stringList: "readonly",
        truncateText: "readonly",
        tryResolveBase: "readonly",
        tryGit: "readonly",
      },
    },
  },
  {
    // Test/story/mock files and shared test support (harnesses/utils named
    // per repo convention: *.testHarness.ts, test[A-Z]*.ts): casting partial
    // doubles through `unknown` is the standard mocking idiom, so the
    // chained-assertion ban is production-only. Microbenchmarks (*.bench.ts)
    // never ship either and stub services the same way.
    files: [
      "**/*.bench.ts",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.stories.ts",
      "**/*.stories.tsx",
      "src/browser/stories/**",
      "**/*.testHarness.ts",
      "src/**/test[A-Z]*.ts",
    ],
    rules: {
      "local/no-chained-type-assertions": "off",
      "local/no-known-value-widening": "off",
      "local/no-widen-then-assert": "off",
      "local/no-object-parameters": "off",
    },
  },
  {
    // tests/ (IPC, e2e, runtime, UI harness) is type-checked by tsconfig.json; lint it with the
    // same type-aware base rules as src/. src/-only architecture rules stay scoped to src/.
    files: ["tests/**/*.{ts,tsx}"],
    // Registered so repo-wide test rules (e.g. local/no-cast-to-api-client on
    // **/*.test.ts) resolve here too.
    plugins: {
      local: localPlugin,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        require: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        window: "readonly",
        document: "readonly",
      },
    },
    rules: {
      // Harness doubles implement async interfaces with synchronous or empty bodies
      // (`async () => {}` stubs for services, windows, and IPC handlers).
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-empty-function": "off",
      // Same options as src/: a leading underscore marks an intentionally unused binding
      // (mock signatures, destructured tuple slots). The base default flags those too.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          vars: "all",
          args: "after-used",
          ignoreRestSiblings: true,
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
        },
      ],
    },
  },
  {
    // Test file configuration
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "local/no-cast-to-api-client": "error",
      "local/no-clear-dom-global": "error",
      "local/require-module-mock-restore": [
        "error",
        {
          allow: {
            // bun 1.3.5 cannot load the real noVNC RFB module (`require() async module
            // .../util/browser.js is unsupported`), so there are no real exports to restore and
            // no later suite can observe the stub.
            "src/browser/features/desktop/DesktopPanel.test.tsx": ["@novnc/novnc/lib/rfb"],
            "src/browser/features/desktop/useDesktopConnection.test.tsx": ["@novnc/novnc/lib/rfb"],
          },
        },
      ],
    },
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        jest: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
      },
    },
  },
  {
    // Test files and the support code they load run in the same covered bun process.
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "tests/**/*.{ts,tsx}",
      "src/**/*.testHarness.{ts,tsx}",
      "src/**/*.testUtils.{ts,tsx}",
      "src/**/test[A-Z]*.{ts,tsx}",
    ],
    rules: {
      "local/no-module-query-copy": [
        "error",
        {
          // Existing copies. Each one can still lose coverage of its module in a shared shard;
          // replace it with a file-scope snapshot or a static import, then drop it from here.
          allow: {
            "src/browser/AppEarlyPageImport.test.tsx": [
              "@/browser/components/AIView/AIView?real=1",
              "@/browser/App?earlyImport=root",
              "@/browser/App?earlyImport=workspace",
              "@/browser/App?prefetch=browser",
              "@/browser/App?prefetch=desktop",
            ],
            "src/browser/components/AgentListItem/AgentListItem.test.tsx": [
              "./AgentListItem?agent-list-item-test=1",
            ],
            "src/browser/components/ChatPane/WorkspaceFooterBar.test.tsx": [
              "./WorkspaceFooterBar?workspace-footer-bar-test=1",
              "./WorkspaceFooterBar?workspace-footer-bar-test=2",
            ],
            "src/browser/components/Dialog/Dialog.test.tsx": ["./Dialog?real=1"],
            "src/browser/components/LoadingScreen/LoadingScreen.test.tsx": [
              "../LoadingScreen/LoadingScreen?real=1",
            ],
            "src/browser/components/ProjectSidebar/ProjectSidebar.test.tsx": [
              "../AgentListItem/AgentListItem?project-sidebar-real-row=1",
              "./ProjectSidebar?project-sidebar-test=1",
              "./ProjectSidebar?project-sidebar-scratch-test=1",
              "./ProjectSidebar?project-sidebar-flat-test=1",
            ],
            "src/browser/components/WorkspaceMenuBar/WorkspaceMenuBar.test.tsx": [
              "../Dialog/Dialog?real=1",
              "./WorkspaceMenuBar?workspace-menu-bar-test=1",
            ],
            "src/browser/contexts/API.test.tsx": ["./API?real=1"],
            "src/browser/features/Analytics/SavedQuerySqlDialog.test.tsx": [
              "./SavedQuerySqlDialog?real=1",
            ],
            "src/browser/features/RightSidebar/BrowserTab/useBrowserBridgeConnection.test.tsx": [
              "./useBrowserBridgeConnection.ts?test-isolation=static",
            ],
            "src/browser/utils/feedbackToast.test.tsx": ["../components/Dialog/Dialog?real=1"],
            "src/browser/utils/perf/appShellReady.test.ts": ["./appShellReady?fresh=1"],
          },
        },
      ],
    },
  },
  {
    // Storybook story files - disable type-aware rules for Storybook 10 barrel exports
    files: ["**/*.stories.ts", "**/*.stories.tsx", ".storybook/**/*.ts", ".storybook/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  ...storybook.configs["flat/recommended"],
]);
