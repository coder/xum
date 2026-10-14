#!/usr/bin/env node
// Checks that .oxlintrc.json applies the same rules as eslint.config.mjs to every lint file.
//
// `make lint` runs oxlint with the committed .oxlintrc.json, and CI runs both linters. The two
// configs are maintained side by side until ESLint is removed. For every file ESLint lints, this
// resolves ESLint's effective config and replays oxlint's (top-level rules, then each matching
// override in order), and fails on any rule oxlint supports whose severity or options differ.
// Fix a failure by editing .oxlintrc.json, or list the rule in INTENTIONAL_GAPS with a reason.
//
// Usage: node scripts/check-oxlint-config.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import picomatch from "picomatch";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { listLintFiles } = require("./lib/lint_targets.js");

// Rules ESLint runs that oxlint deliberately does not. CI still runs them through ESLint.
export const INTENTIONAL_GAPS = new Map([
  ["local/no-required-member-typeof-guard", "needs the TypeScript checker, which JS plugins lack"],
  ["no-unsafe-optional-chaining", "oxlint looks through `as` casts and reports ~40 accepted sites"],
  ["typescript/no-inferrable-types", "oxlint also reports defaulted literal-typed parameters"],
]);

const SEVERITIES = { 0: "off", 1: "warn", 2: "error", off: "off", warn: "warn", error: "error" };
SEVERITIES.allow = "off";
SEVERITIES.deny = "error";

function parseRuleValue(value) {
  if (value === undefined) return { severity: "off", options: [] };
  const [severity, ...options] = Array.isArray(value) ? value : [value];
  return { severity: SEVERITIES[severity] ?? String(severity), options };
}

/** True when every key and array item in `expected` appears in `actual` with the same value. */
function isSubset(expected, actual) {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => isSubset(item, actual[index]))
    );
  }
  if (expected !== null && typeof expected === "object") {
    return (
      actual !== null &&
      typeof actual === "object" &&
      Object.entries(expected).every(([key, value]) => isSubset(value, actual[key]))
    );
  }
  return expected === actual;
}

/** The oxlint names an ESLint rule can have: plugin renames plus TypeScript extension rules. */
function oxlintNamesFor(eslintName) {
  if (eslintName.startsWith("@typescript-eslint/")) {
    const rule = eslintName.slice("@typescript-eslint/".length);
    return [`typescript/${rule}`, rule];
  }
  if (eslintName.startsWith("react-hooks/"))
    return [`react/${eslintName.slice("react-hooks/".length)}`];
  return [eslintName];
}

/** Rules oxlint can run with this config: native non-type-aware rules plus its JS plugins' rules. */
function supportedRules(root, oxlintConfig) {
  const oxlint = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin", "oxlint");
  const native = JSON.parse(
    execFileSync(oxlint, ["--rules", "--format", "json"], { cwd: root, encoding: "utf8" })
  );
  const names = new Set();
  for (const rule of native) {
    if (rule.type_aware) continue;
    names.add(rule.scope === "eslint" ? rule.value : `${rule.scope}/${rule.value}`);
  }
  const jsPluginNames = new Set();
  for (const block of [oxlintConfig, ...(oxlintConfig.overrides ?? [])]) {
    for (const plugin of block.jsPlugins ?? []) {
      jsPluginNames.add(
        typeof plugin === "string" ? plugin.replace(/^eslint-plugin-/, "") : plugin.name
      );
    }
  }
  return { has: (name) => names.has(name) || jsPluginNames.has(name.split("/")[0]) };
}

/** oxlint negates character classes with `[!...]`, which picomatch only reads as `[^...]`. */
function toPicomatchGlob(glob) {
  return glob.replaceAll("[!", "[^");
}

function oxlintRulesFor(file, oxlintConfig, matchers) {
  if (matchers.ignored(file)) return {};
  const rules = { ...oxlintConfig.rules };
  oxlintConfig.overrides?.forEach((override, index) => {
    if (matchers.overrides[index](file)) Object.assign(rules, override.rules);
  });
  return rules;
}

/** ignorePatterns use .gitignore syntax; the config anchors them to the repo root. */
function ignoreMatcher(patterns = []) {
  const toGlob = (pattern) => pattern.replace(/^\//, "").replace(/\/$/, "/**");
  const ignore = picomatch(patterns.filter((p) => !p.startsWith("!")).map(toGlob), { dot: true });
  const keep = picomatch(
    patterns.filter((p) => p.startsWith("!")).map((p) => toGlob(p.slice(1))),
    { dot: true }
  );
  return (file) => ignore(file) && !keep(file);
}

/**
 * ESLint's effective value for each oxlint rule name. When both a base rule and its
 * typescript-eslint extension map to one oxlint rule, the enabled one wins. typescript-eslint
 * rules that need type information have no oxlint counterpart without --type-aware.
 */
function eslintRulesByOxlintName(eslintConfig, supported) {
  const typescriptRules = eslintConfig.plugins?.["@typescript-eslint"]?.rules ?? {};
  const byName = new Map();
  for (const [eslintName, value] of Object.entries(eslintConfig.rules ?? {})) {
    if (eslintName.startsWith("@typescript-eslint/")) {
      const rule = typescriptRules[eslintName.slice("@typescript-eslint/".length)];
      if (rule?.meta?.docs?.requiresTypeChecking) continue;
    }
    const parsed = parseRuleValue(value);
    for (const name of oxlintNamesFor(eslintName)) {
      if (!supported.has(name)) continue;
      const current = byName.get(name);
      if (current === undefined || (current.severity === "off" && parsed.severity !== "off")) {
        byName.set(name, { ...parsed, eslintName });
      }
      break;
    }
  }
  return byName;
}

/**
 * @param {{ cwd?: string, files?: string[], oxlintConfig?: object, eslintOptions?: object }} [options]
 * @returns {Promise<Map<string, string[]>>} mismatch description -> files
 */
export async function findMismatches({
  cwd = ROOT,
  files = listLintFiles(cwd),
  oxlintConfig = JSON.parse(fs.readFileSync(path.join(cwd, ".oxlintrc.json"), "utf8")),
  eslintOptions = {},
} = {}) {
  const eslint = new ESLint({ cwd, ...eslintOptions });
  const supported = supportedRules(cwd, oxlintConfig);
  const matchers = {
    ignored: ignoreMatcher(oxlintConfig.ignorePatterns),
    overrides: (oxlintConfig.overrides ?? []).map((override) =>
      picomatch(override.files.map(toPicomatchGlob), { dot: true })
    ),
  };
  const mismatches = new Map();
  const report = (description, file) => {
    if (!mismatches.has(description)) mismatches.set(description, []);
    mismatches.get(description).push(file);
  };

  for (const file of files) {
    const eslintConfig = await eslint.calculateConfigForFile(file);
    // oxlint skips the same files through ignorePatterns; ESLint-ignored files are not compared.
    if (eslintConfig === undefined) continue;
    const expected = eslintRulesByOxlintName(eslintConfig, supported);
    const actual = oxlintRulesFor(file, oxlintConfig, matchers);
    for (const name of new Set([...expected.keys(), ...Object.keys(actual)])) {
      if (INTENTIONAL_GAPS.has(name)) continue;
      const want = expected.get(name) ?? { severity: "off", options: [] };
      const got = parseRuleValue(actual[name]);
      if (want.severity !== got.severity) {
        report(`${name}: ESLint ${want.severity}, oxlint ${got.severity}`, file);
      } else if (
        got.severity !== "off" &&
        !isSubset(got.options, want.options.slice(0, got.options.length))
      ) {
        report(`${name}: options differ from ESLint's ${want.eslintName}`, file);
      }
    }
  }
  return mismatches;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mismatches = await findMismatches();
  if (mismatches.size === 0) {
    console.log(".oxlintrc.json matches eslint.config.mjs for every lint file.");
  } else {
    console.error(".oxlintrc.json does not match eslint.config.mjs:");
    for (const [description, files] of mismatches) {
      const sample = files.slice(0, 3).join(", ");
      const more = files.length > 3 ? `, and ${files.length - 3} more` : "";
      console.error(`  ${description} (${sample}${more})`);
    }
    console.error(
      "Edit .oxlintrc.json to match, or add the rule to INTENTIONAL_GAPS in scripts/check-oxlint-config.mjs."
    );
    process.exit(1);
  }
}
