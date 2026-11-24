#!/usr/bin/env bun
/**
 * Fails `make test-bugbash-repros` when its phases together selected no test.
 *
 * Usage: bun tests/bugbash/reproSelection.ts <report.json>...
 *
 * The target runs a mock-only phase and a phase on the resolved app AI. Each passes
 * `--pass-with-no-tests`, because a BUGBASH_REPRO_ARGS filter can select tests of one phase only
 * (#5716). Without this check, a filter that matches nothing would pass falsely. A missing or
 * unreadable report fails too: then a phase did not run as expected.
 */
import * as fs from "fs";

interface Report {
  run?: { summary?: { selected?: unknown } };
}

function selectedCount(file: string): number {
  const report = JSON.parse(fs.readFileSync(file, "utf8")) as Report;
  const selected = report.run?.summary?.selected;
  if (typeof selected !== "number" || !Number.isInteger(selected) || selected < 0) {
    throw new Error(`${file}: run.summary.selected is not a count`);
  }
  return selected;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: bun tests/bugbash/reproSelection.ts <report.json>...");
  process.exit(2);
}
try {
  const total = files.reduce((sum, file) => sum + selectedCount(file), 0);
  if (total === 0) {
    console.error("[bugbash repros] NO_TESTS: no phase selected a test; check BUGBASH_REPRO_ARGS");
    process.exit(2);
  }
  console.log(`[bugbash repros] ${total} selected test(s) across ${files.length} phase(s)`);
} catch (error) {
  console.error(`[bugbash repros] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
