#!/usr/bin/env node
// Checks, on macOS with Apple's own tools, the signature that sign-app.mjs made on Linux with
// rcodesign: every Mach-O has a signature that verifies and the hardened runtime, and the
// executables (and only they) have the entitlements. A file that sign-app.mjs gave no settings
// would still be signed, and would fail only on a user's machine, so the build checks each file
// here.
//
// Usage: node scripts/macos-signing/check-app.mjs <app> <entitlements.plist> [--requirement <text>]
//
// With `--requirement`, the app must also be what a release ships: codesign accepts the
// signature and it satisfies the requirement, Gatekeeper accepts the app, and the notarization
// ticket is stapled. Without it the certificate is the throwaway one of pull request builds,
// which no Mac trusts, so only the settings are checked.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { listMachO } from "./machO.mjs";

// `xcrun stapler` exit code when Apple's ticket service gives no answer: no ticket yet, or a
// failed request. Only this code goes away by waiting (see #6901).
const STAPLE_TICKET_NOT_READY = 68;
const STAPLE_ATTEMPTS = 5;
const STAPLE_RETRY_DELAY_SECONDS = 30;

function usage() {
  console.error("usage: check-app.mjs <app> <entitlements.plist> [--requirement <text>]");
  process.exit(2);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    console.error(`check-app.mjs: cannot run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  return { status: result.status, stdout: result.stdout, output: result.stdout + result.stderr };
}

// The entitlements of a property list as sorted `key=value` strings. Every entitlement of this
// app is a boolean, and the check must not pass by skipping a value it cannot read.
function entitlementsOf(xml, source) {
  const pairs = [...xml.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\/>/g)];
  if (pairs.length !== [...xml.matchAll(/<key>/g)].length) {
    throw new Error(`${source} has an entitlement that is not a boolean`);
  }
  return pairs.map(([, key, value]) => `${key}=${value}`).sort();
}

const args = process.argv.slice(2);
let requirement = null;
const requirementFlag = args.indexOf("--requirement");
if (requirementFlag !== -1) {
  requirement = args[requirementFlag + 1];
  if (!requirement) usage();
  args.splice(requirementFlag, 2);
}
const [app, entitlementsFile] = args;
if (!app || !entitlementsFile || args.length !== 2) usage();

const wanted = entitlementsOf(readFileSync(entitlementsFile, "utf8"), entitlementsFile);
const machOs = listMachO(app);
const failures = [];
if (machOs.length === 0) failures.push(`no Mach-O file under ${app}`);

for (const machO of machOs) {
  const file = path.join(app, machO.path);
  // `codesign -d` only shows a signature, and the release check's `--verify --deep` does not
  // reach code in Contents/Resources (the unpacked native modules), so each file is verified.
  const verified = run("codesign", ["--verify", "--strict", "--verbose=2", file]);
  if (verified.status !== 0) {
    failures.push(`${machO.path}: the signature does not verify\n${verified.output.trim()}`);
    continue;
  }
  const info = run("codesign", ["-d", "--verbose=2", file]);
  if (info.status !== 0) {
    failures.push(`${machO.path}: codesign cannot read a signature\n${info.output.trim()}`);
    continue;
  }
  const flags = /^CodeDirectory .*\bflags=0x[0-9a-f]+\(([^)]*)\)/m.exec(info.output)?.[1] ?? "";
  if (!flags.split(",").includes("runtime")) {
    failures.push(`${machO.path}: no hardened runtime (flags: ${flags || "none"})`);
  }

  const shown = run("codesign", ["-d", "--entitlements", "-", "--xml", file]);
  if (shown.status !== 0) {
    failures.push(`${machO.path}: codesign cannot read the entitlements\n${shown.output.trim()}`);
    continue;
  }
  const actual = entitlementsOf(shown.stdout, `the signature of ${machO.path}`);
  const expected = machO.executable ? wanted : [];
  if (actual.join("\n") !== expected.join("\n")) {
    failures.push(
      `${machO.path}: entitlements are [${actual.join(", ")}], expected [${expected.join(", ")}]`
    );
  }
}

if (requirement !== null && failures.length === 0) {
  const checks = [
    // `=` marks the requirement as text: codesign reads any other value as a file name.
    ["codesign", ["--verify", "--deep", "--strict", "--verbose=2", `-R=${requirement}`, app]],
    ["spctl", ["--assess", "--type", "execute", "--verbose=2", app]],
  ];
  for (const [command, commandArgs] of checks) {
    const result = run(command, commandArgs);
    if (result.status !== 0) {
      failures.push(`${command} ${commandArgs.join(" ")} failed\n${result.output.trim()}`);
    }
  }
  for (let attempt = 1; ; attempt++) {
    const result = run("xcrun", ["stapler", "validate", "-v", app]);
    if (result.status === 0) break;
    if (result.status !== STAPLE_TICKET_NOT_READY || attempt === STAPLE_ATTEMPTS) {
      failures.push(
        `the stapled ticket failed validation (code ${result.status})\n${result.output.trim()}`
      );
      break;
    }
    console.log(`stapler validate got no answer from Apple (attempt ${attempt}); waiting`);
    run("sleep", [String(STAPLE_RETRY_DELAY_SECONDS)]);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`check-app.mjs: ${failure}`);
  process.exit(1);
}
const executables = machOs.filter((machO) => machO.executable).length;
console.log(
  `Checked ${machOs.length} Mach-O files (${executables} executables) in ${app}` +
    (requirement === null ? "" : ": requirement met, accepted by Gatekeeper, ticket stapled")
);
