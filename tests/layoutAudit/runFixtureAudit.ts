#!/usr/bin/env bun
/**
 * Runs the SHIPPED layout audit script (LAYOUT_AUDIT_PAGE_SCRIPT) in real Chromium over the
 * fixture pages in tests/fixtures/layout-audit, on a fresh page per fixture and width, and prints
 * what each pass found. Pass `--print` to only print the table.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "playwright";
import {
  LAYOUT_AUDIT_VIEWPORTS,
  type LayoutAuditViewport,
  type LayoutAuditViewportWidth,
} from "@/common/constants/artifactLayoutAudit";
import {
  LayoutAuditPagePassSchema,
  type LayoutAuditPagePass,
} from "@/common/types/artifactLayoutAudit";
import { LAYOUT_AUDIT_PAGE_SCRIPT } from "@/node/services/layoutAudit/layoutAuditPageScript.generated";
import { FIXTURE_EXPECTATIONS } from "./fixtureExpectations";

const FIXTURE_DIR = path.join(import.meta.dir, "../fixtures/layout-audit");
// A page that never settles must fail the run, not hang the job.
const PASS_TIMEOUT_MS = 60_000;

interface Row {
  fixture: string;
  width: LayoutAuditViewportWidth;
  pass: LayoutAuditPagePass;
  ms: number;
}

async function auditFixture(
  browser: Browser,
  fixture: string,
  viewport: LayoutAuditViewport
): Promise<Row> {
  // A fresh context per pass: no state, focus or animation clock carries over.
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(path.join(FIXTURE_DIR, `${fixture}.html`)).href, {
      waitUntil: "load",
    });
    const started = performance.now();
    const raw: unknown = await Promise.race([
      page.evaluate(LAYOUT_AUDIT_PAGE_SCRIPT),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${fixture} did not finish in ${PASS_TIMEOUT_MS} ms`)), PASS_TIMEOUT_MS)
      ),
    ]);
    const ms = performance.now() - started;
    return { fixture, width: viewport.width, pass: LayoutAuditPagePassSchema.parse(raw), ms };
  } finally {
    await context.close();
  }
}

function fixtureNames(): string[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".html"))
    .map((name) => name.slice(0, -".html".length))
    .sort();
}

function formatRow(row: Row): string {
  const findings = row.pass.findings.map((f) => `${f.rule} ${f.selector} ${f.axis} ${f.overflowPx}`);
  return [
    row.fixture.padEnd(30),
    String(row.width).padStart(4),
    String(row.pass.complete).padEnd(5),
    String(row.pass.findings.length).padStart(2),
    `${Math.round(row.ms)} ms`.padStart(8),
    findings.join(" | "),
  ].join("  ");
}

/** Mismatches between a row and its expectation: a settled pass, the width asked for, the rules. */
function mismatches(row: Row): string[] {
  const expected = FIXTURE_EXPECTATIONS[row.fixture]?.[row.width];
  const found = row.pass.findings.map((finding) => finding.rule).sort();
  const problems: string[] = [];
  if (!row.pass.complete) problems.push("the pass is not complete");
  if (row.pass.viewportWidth !== row.width) {
    problems.push(`the page reported width ${row.pass.viewportWidth}`);
  }
  if (!expected || JSON.stringify(found) !== JSON.stringify([...expected].sort())) {
    problems.push(`rules [${found.join(", ")}], expected [${(expected ?? []).join(", ")}]`);
  }
  return problems;
}

/** A fixture without an expectation, or an expectation without a page, is drift. */
function tableDrift(): string[] {
  const names = new Set(fixtureNames());
  const rows = new Set(Object.keys(FIXTURE_EXPECTATIONS));
  return [
    ...[...names].filter((name) => !rows.has(name)).map((name) => `${name} has no expectation`),
    ...[...rows].filter((name) => !names.has(name)).map((name) => `${name} has no fixture page`),
  ];
}

async function main() {
  const { values } = parseArgs({
    options: { print: { type: "boolean" }, chrome: { type: "string" } },
  });
  const drift = tableDrift();
  if (drift.length > 0) throw new Error(`expectation table drift:\n  ${drift.join("\n  ")}`);
  const browser = await chromium.launch({ executablePath: values.chrome });
  const failures: string[] = [];
  try {
    for (const fixture of fixtureNames()) {
      for (const viewport of LAYOUT_AUDIT_VIEWPORTS) {
        const row = await auditFixture(browser, fixture, viewport);
        console.log(formatRow(row));
        failures.push(...mismatches(row).map((problem) => `${fixture} at ${row.width}: ${problem}`));
      }
    }
  } finally {
    await browser.close();
  }
  if (values.print) return;
  if (failures.length > 0) {
    console.error(`\n${failures.length} mismatch(es):\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\nevery fixture reported what its expectation names, at every width");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
