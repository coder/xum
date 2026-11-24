// Tests for scripts/macos-signing/check-app.mjs. `codesign`, `spctl`, `xcrun` and `sleep` are
// stubs first on PATH: codesign answers each file from the `.info` and `.entitlements` files next
// to it, and the others record their runs, so the tests need no Mac.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally:
// bun test ./scripts/macos-signing/checkApp.test.ts
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SPAWNING_TEST_TIMEOUT_MS,
  runScript,
  writeExecutable,
  type RunResult,
} from "../ci/runScript";

setDefaultTimeout(SPAWNING_TEST_TIMEOUT_MS);

const CHECK_APP = path.resolve(import.meta.dir, "check-app.mjs");
const ENTITLEMENTS = path.resolve(import.meta.dir, "../../build/entitlements.mac.plist");
const REQUIREMENT = 'identifier "com.example.test" and anchor apple generic';
const EXE = "Contents/MacOS/Test";
const LIB = "Contents/Frameworks/libtest.dylib";

let work: string;
let app: string;

interface Signature {
  flags?: string;
  entitlements?: string;
  // The stub's per-file `codesign --verify` fails, as for a corrupt signature.
  invalid?: boolean;
}

function machO(fileType: number): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(fileType, 12);
  return header;
}

// Writes a Mach-O and what the stub codesign prints for it.
async function put(relative: string, fileType: number, signature: Signature): Promise<void> {
  const file = path.join(app, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, machO(fileType));
  await writeFile(
    `${file}.info`,
    [
      `Executable=${file}`,
      "Identifier=com.example.test",
      `CodeDirectory v=20500 size=759 flags=${signature.flags ?? "0x10000(runtime)"} hashes=13+7 location=embedded`,
      "",
    ].join("\n")
  );
  await writeFile(`${file}.entitlements`, signature.entitlements ?? "");
  if (signature.invalid) await writeFile(`${file}.invalid`, "");
}

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "macos-check-"));
  app = path.join(work, "Test.app");
  // `-d` prints the signature to stderr and the entitlements to stdout, as codesign does.
  await writeExecutable(
    path.join(work, "codesign"),
    `file="\${*: -1}"
case "$*" in
  "-d --verbose=2 "*) cat "$file.info" >&2 ;;
  "-d --entitlements - --xml "*) cat "$file.entitlements" ;;
  "--verify --strict --verbose=2 "*) [ ! -e "$file.invalid" ] || { echo "$file: invalid signature" >&2; exit 1; } ;;
  *) echo "codesign $*" >> "${work}/runs"; exit "\${CODESIGN_VERIFY_EXIT:-0}" ;;
esac`
  );
  await writeExecutable(
    path.join(work, "spctl"),
    `echo "spctl $*" >> "${work}/runs"; exit "\${SPCTL_EXIT:-0}"`
  );
  // Exits with the next status of STAPLER_EXITS, then 0.
  await writeExecutable(
    path.join(work, "xcrun"),
    `echo "xcrun $*" >> "${work}/runs"
n=$(grep -c '^xcrun' "${work}/runs")
exits=(\${STAPLER_EXITS:-})
exit "\${exits[$((n - 1))]:-0}"`
  );
  await writeExecutable(path.join(work, "sleep"), `echo "sleep $*" >> "${work}/runs"`);
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function check(
  extraArgs: string[] = [],
  env: Record<string, string> = {}
): Promise<RunResult & { runs: string[] }> {
  const result = await runScript(["node", CHECK_APP, app, ENTITLEMENTS, ...extraArgs], {
    cwd: work,
    env: { PATH: `${work}:${process.env.PATH ?? ""}`, ...env },
  });
  const text = await readFile(path.join(work, "runs"), "utf8").catch(() => "");
  return { ...result, runs: text.split("\n").filter((line) => line !== "") };
}

async function signedEntitlements(): Promise<string> {
  // codesign prints the property list on one line, in its own key order.
  const xml = await readFile(ENTITLEMENTS, "utf8");
  const keys = [...xml.matchAll(/<key>[^<]+<\/key>\s*<true\/>/g)].map((match) => match[0]);
  return `<plist version="1.0"><dict>${keys.reverse().join("").replace(/\s+/g, "")}</dict></plist>`;
}

async function putGoodApp(): Promise<void> {
  await put(EXE, 2, { entitlements: await signedEntitlements() });
  await put(LIB, 6, {});
}

test("accepts an app signed with a certificate no Mac trusts, without asking Gatekeeper", async () => {
  await put(EXE, 2, { entitlements: await signedEntitlements() });
  await put(LIB, 6, { flags: "0x10002(adhoc,runtime)" });

  const result = await check();

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.runs).toEqual([]);
});

test("names every Mach-O without the hardened runtime", async () => {
  await putGoodApp();
  await put("Contents/Frameworks/libbare.dylib", 6, { flags: "0x0(none)" });
  await put("Contents/Frameworks/libadhoc.dylib", 6, { flags: "0x2(adhoc)" });

  const result = await check();

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("libbare.dylib: no hardened runtime");
  expect(result.stderr).toContain("libadhoc.dylib: no hardened runtime");
  expect(result.stderr).not.toContain(LIB);
});

test("fails an executable that lacks an entitlement", async () => {
  const all = await signedEntitlements();
  await put(EXE, 2, {
    entitlements: all.replace("<key>com.apple.security.cs.allow-jit</key><true/>", ""),
  });

  const result = await check();

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`${EXE}: entitlements are`);
});

test("fails an executable whose entitlement is off", async () => {
  const all = await signedEntitlements();
  await put(EXE, 2, {
    entitlements: all.replace(
      "<key>com.apple.security.cs.allow-jit</key><true/>",
      "<key>com.apple.security.cs.allow-jit</key><false/>"
    ),
  });

  expect((await check()).exitCode).toBe(1);
});

test("fails a library that has entitlements", async () => {
  await putGoodApp();
  await put("Contents/Frameworks/libextra.dylib", 6, { entitlements: await signedEntitlements() });

  const result = await check();

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("libextra.dylib: entitlements are");
});

test("fails a Mach-O whose signature does not verify, in Contents/Resources too", async () => {
  await putGoodApp();
  await put("Contents/Resources/app.asar.unpacked/native.node", 6, { invalid: true });

  const result = await check();

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    "Contents/Resources/app.asar.unpacked/native.node: the signature does not verify"
  );
});

test("for a release, asks codesign, Gatekeeper and the stapler about the app", async () => {
  await putGoodApp();

  const result = await check(["--requirement", REQUIREMENT]);

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.runs).toEqual([
    `codesign --verify --deep --strict --verbose=2 -R=${REQUIREMENT} ${app}`,
    `spctl --assess --type execute --verbose=2 ${app}`,
    `xcrun stapler validate -v ${app}`,
  ]);
});

test.each([
  ["codesign", { CODESIGN_VERIFY_EXIT: "1" }],
  ["Gatekeeper", { SPCTL_EXIT: "3" }],
  ["the stapler", { STAPLER_EXITS: "65" }],
])("for a release, fails when %s rejects the app", async (_name, env) => {
  await putGoodApp();

  expect((await check(["--requirement", REQUIREMENT], env)).exitCode).toBe(1);
});

test("waits and asks the stapler again only while Apple's ticket service gives no answer", async () => {
  await putGoodApp();

  const result = await check(["--requirement", REQUIREMENT], { STAPLER_EXITS: "68 68" });

  expect(result.exitCode).toBe(0);
  expect(result.runs.slice(2)).toEqual([
    `xcrun stapler validate -v ${app}`,
    "sleep 30",
    `xcrun stapler validate -v ${app}`,
    "sleep 30",
    `xcrun stapler validate -v ${app}`,
  ]);
});

test("stops asking the stapler after five answers of no ticket", async () => {
  await putGoodApp();

  const result = await check(["--requirement", REQUIREMENT], {
    STAPLER_EXITS: "68 68 68 68 68 68",
  });

  expect(result.exitCode).toBe(1);
  expect(result.runs.filter((run) => run.startsWith("xcrun"))).toHaveLength(5);
});
