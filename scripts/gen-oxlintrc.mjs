#!/usr/bin/env node
// Generates .oxlintrc.json from eslint.config.mjs, so `make lint` can run oxlint locally while
// CI keeps running the full type-aware ESLint config (`make lint-full`).
//
// A cold type-aware ESLint run peaks at ~7.6 GiB; several agents running it at once OOM-killed
// shared workspaces. oxlint with the same syntax rules and the custom `local/*` rules lints the
// whole repo in seconds at well under 1 GiB. What oxlint cannot check (type-aware rules,
// `no-restricted-syntax`, `local/no-required-member-typeof-guard`) only fails in CI.
//
// @oxlint/migrate does the rule mapping. This script fixes what it leaves out:
// - settings inside ESLint blocks: oxlint reads settings only at the top level, and the Tailwind
//   plugin resolves a Tailwind config (slowly) without them;
// - block-level `ignores`: oxlint overrides have none, so each block that has them gets an extra
//   override that turns its rules back off for the ignored globs;
// - the inline `local` plugin, which migrate cannot reference, is loaded from
//   eslint-local-rules.mjs;
// - ESLint's root-relative ignore globs, which oxlint would otherwise match at any depth.
//
// Usage: node scripts/gen-oxlintrc.mjs [output path, default .oxlintrc.json]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import migrate from "@oxlint/migrate";
import eslintConfig from "../eslint.config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_PLUGIN = { name: "local", specifier: "./eslint-local-rules.mjs" };

// Rules oxlint does not enforce locally. CI still runs them through ESLint.
const LOCAL_SKIPPED_RULES = {
  // Needs the TypeScript checker, which oxlint JS plugins do not get; it would silently pass.
  "local/no-required-member-typeof-guard": "needs type information",
  // oxlint looks through `as` casts and reports ~40 sites that ESLint accepts.
  "no-unsafe-optional-chaining": "oxlint reports sites that ESLint accepts",
  // oxlint also reports defaulted parameters with literal types (`x: "a" = "a"`).
  "typescript/no-inferrable-types": "oxlint reports sites that ESLint accepts",
};

const ESLINT_PLUGIN_PREFIXES = [
  ["@typescript-eslint/", "typescript/"],
  ["react-hooks/", "react/"],
];

function toOxlintRuleName(name) {
  for (const [from, to] of ESLINT_PLUGIN_PREFIXES) {
    if (name.startsWith(from)) return to + name.slice(from.length);
  }
  return name;
}

/**
 * oxlint globs have no extglobs. `@(a|b)` becomes `{a,b}`. The other forms cannot be expressed,
 * so they widen to `*`; that is only safe for globs that turn rules off (fewer local findings,
 * CI still has the exact globs), so they are rejected anywhere else.
 */
function toOxlintGlob(glob, { allowWiden }) {
  let result = glob.replace(
    /@\(([^()]*)\)/g,
    (_, alternatives) => `{${alternatives.split("|").join(",")}}`
  );
  if (/[*?+!]\([^()]*\)/.test(result)) {
    if (!allowWiden) {
      throw new Error(`gen-oxlintrc: cannot convert extglob ${JSON.stringify(glob)} for oxlint`);
    }
    result = result.replace(/[*?+!]\([^()]*\)/g, "*");
  }
  return result;
}

/**
 * ESLint resolves global ignores against the config directory; oxlint uses gitignore rules, where
 * a pattern without a slash matches at any depth (`*.js` would skip src/node/workflowRuntime/*.js).
 */
function anchorIgnorePattern(pattern) {
  const negated = pattern.startsWith("!");
  const body = negated ? pattern.slice(1) : pattern;
  const anchored = body.startsWith("/") || body.startsWith("**/") ? body : `/${body}`;
  return (negated ? "!" : "") + anchored;
}

function mergeSettings(blocks) {
  const settings = {};
  for (const block of blocks) {
    for (const [plugin, value] of Object.entries(block.settings ?? {})) {
      settings[plugin] = { ...settings[plugin], ...value };
    }
  }
  // oxlint needs an explicit version where eslint-plugin-react can detect it.
  if (settings.react?.version === "detect") {
    const reactPackage = JSON.parse(
      fs.readFileSync(path.join(ROOT, "node_modules/react/package.json"), "utf8")
    );
    settings.react = { ...settings.react, version: reactPackage.version };
  }
  return settings;
}

function filterSkipped(rules) {
  return Object.fromEntries(
    Object.entries(rules).filter(([name]) => !(name in LOCAL_SKIPPED_RULES))
  );
}

export async function generateOxlintConfig(blocks = eslintConfig) {
  const config = await migrate(blocks, undefined, { jsPlugins: true, typeAware: false });

  config.settings = { ...config.settings, ...mergeSettings(blocks) };
  config.ignorePatterns = (config.ignorePatterns ?? []).map(anchorIgnorePattern);
  config.rules = filterSkipped(config.rules ?? {});
  config.overrides = (config.overrides ?? []).map((override) => ({
    ...override,
    files: override.files.map((glob) => toOxlintGlob(glob, { allowWiden: false })),
    rules: filterSkipped(override.rules ?? {}),
  }));

  const migratedRules = new Set(Object.keys(config.rules));
  for (const override of config.overrides) {
    for (const name of Object.keys(override.rules)) migratedRules.add(name);
  }

  // Appended after the migrated overrides, so an "off" override can also switch off a setting
  // that ESLint would apply from another block. That only loses local findings; CI has them.
  for (const block of blocks) {
    if (!block.files || !block.rules) continue;
    const files = block.files.flat().map((glob) => toOxlintGlob(glob, { allowWiden: false }));
    const localRules = {};
    const ignoredRules = [];
    for (const [name, value] of Object.entries(block.rules)) {
      if (name in LOCAL_SKIPPED_RULES) continue;
      if (name.startsWith("local/")) {
        localRules[name] = value;
        ignoredRules.push(name);
        continue;
      }
      const oxlintName = toOxlintRuleName(name);
      if (migratedRules.has(oxlintName) && !(oxlintName in LOCAL_SKIPPED_RULES)) {
        ignoredRules.push(oxlintName);
      }
    }
    if (Object.keys(localRules).length > 0) {
      config.overrides.push({ files, jsPlugins: [LOCAL_PLUGIN], rules: localRules });
    }
    if (block.ignores && ignoredRules.length > 0) {
      config.overrides.push({
        files: block.ignores.map((glob) => toOxlintGlob(glob, { allowWiden: true })),
        rules: Object.fromEntries(ignoredRules.map((name) => [name, "off"])),
      });
    }
  }

  return config;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = path.resolve(ROOT, process.argv[2] ?? ".oxlintrc.json");
  const config = await generateOxlintConfig();
  // oxlint accepts comments in its JSON config but rejects unknown keys.
  const header = "// Generated by scripts/gen-oxlintrc.mjs from eslint.config.mjs. Do not edit.\n";
  // Write then rename, so a concurrent `make lint` never reads a partial file.
  const temporary = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, header + JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(temporary, output);
}
