#!/usr/bin/env bun
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as prettier from "prettier";

const ARGS = new Set(process.argv.slice(2));
const MODE = ARGS.has("check") ? "check" : "write";
const PROJECT_ROOT = path.join(import.meta.dir, "..");
const RUNTIME_SOURCE_DIR = path.join(PROJECT_ROOT, "src", "node", "workflowRuntime");
const OUTPUT_PATH = path.join(
  PROJECT_ROOT,
  "src",
  "node",
  "services",
  "workflows",
  "workflowRuntimeSources.generated.ts"
);

const SOURCES = [
  ["WORKFLOW_RUNTIME_STDLIB_SOURCE", "workflowRuntimeStdlib.js"],
] as const;

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function readSource(filename: string): string {
  const sourcePath = path.join(RUNTIME_SOURCE_DIR, filename);
  assert(fs.existsSync(sourcePath), `Missing workflow runtime source ${sourcePath}`);
  const source = normalizeNewlines(fs.readFileSync(sourcePath, "utf-8"));
  assert(source.trim().length > 0, `Workflow runtime source ${sourcePath} must not be empty`);
  return source;
}

function generate(): string {
  let output = "";
  output += "// AUTO-GENERATED - DO NOT EDIT\n";
  output += "// Run: bun scripts/gen_workflow_runtime_sources.ts\n";
  output += "// Source: src/node/workflowRuntime/*.js\n\n";
  for (const [name, filename] of SOURCES) {
    output += `export const ${name} = ${JSON.stringify(readSource(filename))};\n\n`;
  }
  return output;
}

async function main(): Promise<void> {
  const raw = generate();
  const prettierConfig = await prettier.resolveConfig(OUTPUT_PATH);
  const formatted = await prettier.format(raw, { ...prettierConfig, filepath: OUTPUT_PATH });
  const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, "utf-8") : null;
  const outOfSync = current !== formatted;
  if (MODE === "check") {
    if (!outOfSync) {
      console.log(`✓ ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} is up-to-date`);
      return;
    }
    console.error(`✗ ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} is out of sync`);
    console.error("  Run 'bun scripts/gen_workflow_runtime_sources.ts' to regenerate.");
    process.exit(1);
  }
  if (outOfSync) {
    fs.writeFileSync(OUTPUT_PATH, formatted, "utf-8");
    console.log(`✓ Updated ${path.relative(PROJECT_ROOT, OUTPUT_PATH)}`);
  } else {
    console.log(`✓ ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} is up-to-date`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
