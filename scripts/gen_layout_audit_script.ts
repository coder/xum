#!/usr/bin/env bun
/**
 * Bundles the page side of the HTML artifact layout audit (src/browser/layoutAudit/entry.ts)
 * into one JavaScript expression and writes it as the tracked string
 * `LAYOUT_AUDIT_PAGE_SCRIPT` (src/node/services/layoutAudit/layoutAuditPageScript.generated.ts).
 *
 * The expression evaluates in a page to the promise of the audit result. Write mode regenerates
 * the file; `check` mode fails when the tracked file differs from a fresh build.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";
import * as prettier from "prettier";

const MODE = process.argv.slice(2).includes("check") ? "check" : "write";
const PROJECT_ROOT = path.join(import.meta.dir, "..");
const ENTRY = "src/browser/layoutAudit/entry.ts";
const LICENSE = "src/browser/layoutAudit/lavish-axi-LICENSE.txt";
const OUTPUT_PATH = path.join(
  PROJECT_ROOT,
  "src/node/services/layoutAudit/layoutAuditPageScript.generated.ts"
);
const GLOBAL_NAME = "__xumLayoutAudit";
// The script is about 35 KB. An accidental import (zod, a schema module, a React component) would add
// far more, and the string travels through an agent-browser stdin pipe on every HTML publish.
const MAX_SCRIPT_BYTES = 96 * 1024;
const COPYRIGHT = "Copyright (c) 2026 Kun Chen";

function readLicense(): string {
  const license = fs.readFileSync(path.join(PROJECT_ROOT, LICENSE), "utf-8").replace(/\r\n?/g, "\n");
  assert(license.includes(COPYRIGHT), `${LICENSE} must hold the lavish-axi copyright notice`);
  assert(!license.includes("*/"), `${LICENSE} must not close a block comment`);
  return license;
}

async function buildScript(): Promise<string> {
  const license = readLicense();
  const result = await esbuild.build({
    absWorkingDir: PROJECT_ROOT,
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: "iife",
    globalName: GLOBAL_NAME,
    platform: "browser",
    target: "es2020",
    // Readable, so a reviewer can diff it. keepNames would add a `__name` helper that a bare
    // page does not define.
    minify: false,
    keepNames: false,
    banner: { js: `/*!\n${license}*/` },
    logLevel: "error",
  });
  assert.equal(result.outputFiles.length, 1, "the audit bundle must be one file");
  const bundle = result.outputFiles[0].text.replace(/\r\n?/g, "\n");
  const script = `(() => {\n${bundle}\nreturn ${GLOBAL_NAME}.run();\n})()`;
  assert(script.includes(COPYRIGHT), "the MIT notice must ship with the ported code");
  const bytes = Buffer.byteLength(script);
  assert(bytes <= MAX_SCRIPT_BYTES, `the audit script is ${bytes} bytes, over ${MAX_SCRIPT_BYTES}: did a heavy import reach it?`);
  return script;
}

async function generate(): Promise<string> {
  const script = await buildScript();
  let output = "// AUTO-GENERATED - DO NOT EDIT\n";
  output += "// Run: bun scripts/gen_layout_audit_script.ts\n";
  output += `// Source: ${ENTRY}\n\n`;
  output += `export const LAYOUT_AUDIT_PAGE_SCRIPT = ${JSON.stringify(script)};\n`;
  const prettierConfig = await prettier.resolveConfig(OUTPUT_PATH);
  return prettier.format(output, { ...prettierConfig, filepath: OUTPUT_PATH });
}

async function main(): Promise<void> {
  const formatted = await generate();
  const relative = path.relative(PROJECT_ROOT, OUTPUT_PATH);
  const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, "utf-8") : null;
  if (current === formatted) {
    console.log(`✓ ${relative} is up-to-date`);
    return;
  }
  if (MODE === "check") {
    console.error(`✗ ${relative} is out of sync`);
    console.error("  Run 'bun scripts/gen_layout_audit_script.ts' to regenerate.");
    process.exit(1);
  }
  fs.writeFileSync(OUTPUT_PATH, formatted, "utf-8");
  console.log(`✓ Updated ${relative}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
