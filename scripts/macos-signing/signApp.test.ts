// Tests for scripts/macos-signing/machO.mjs and sign-app.mjs. The bundle is a folder of
// hand-written file headers, and `rcodesign` is a stub first on PATH that records its arguments,
// so the tests run on any OS without a certificate.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally:
// bun test ./scripts/macos-signing/signApp.test.ts
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SPAWNING_TEST_TIMEOUT_MS,
  runScript,
  writeExecutable,
  type RunResult,
} from "../ci/runScript";
import { listMachO } from "./machO.mjs";

setDefaultTimeout(SPAWNING_TEST_TIMEOUT_MS);

const SIGN_APP = path.resolve(import.meta.dir, "sign-app.mjs");
const MH_EXECUTE = 2;
const MH_DYLIB = 6;

let work: string;
let app: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "macos-signing-"));
  app = path.join(work, "Test.app");
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

// A 64-bit little-endian Mach-O header, as the arm64 and x86_64 compilers write it.
function thin(fileType: number): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(fileType, 12);
  return header;
}

// A universal file of two architectures: its header is big-endian and points at the slices.
function universal(fileType: number, wide = false): Buffer {
  const archSize = wide ? 32 : 20;
  const firstSlice = 8 + 2 * archSize;
  const file = Buffer.alloc(firstSlice + 64);
  file.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe, 0);
  file.writeUInt32BE(2, 4);
  for (const [index, offset] of [firstSlice, firstSlice + 32].entries()) {
    const entry = 8 + index * archSize;
    if (wide) file.writeBigUInt64BE(BigInt(offset), entry + 8);
    else file.writeUInt32BE(offset, entry + 8);
    thin(fileType).copy(file, offset);
  }
  return file;
}

async function put(relative: string, content: Buffer | string): Promise<void> {
  const file = path.join(app, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

describe("listMachO", () => {
  test("finds each Mach-O once and tells executables from libraries", async () => {
    await put("Contents/MacOS/Test", thin(MH_EXECUTE));
    await put("Contents/Frameworks/F.framework/Versions/A/F", thin(MH_DYLIB));
    await put("Contents/Frameworks/F.framework/Versions/A/Helpers/crashpad", universal(MH_EXECUTE));
    await put("Contents/Frameworks/libwide.dylib", universal(MH_DYLIB, true));
    await put("Contents/Resources/node_modules/@img/sharp/sharp.node", thin(MH_DYLIB));
    // A framework reaches each file a second time through these links.
    await symlink("A", path.join(app, "Contents/Frameworks/F.framework/Versions/Current"));
    await symlink("Versions/Current/F", path.join(app, "Contents/Frameworks/F.framework/F"));
    // Not Mach-O: a Java class file shares the universal magic number, then holds a version.
    await put("Contents/Resources/Some.class", Buffer.from("cafebabe00000034", "hex"));
    await put("Contents/Resources/app.asar", "feedfacf as text is not a header");
    await put("Contents/Resources/short", Buffer.from("cffaed", "hex"));
    await put("Contents/Resources/empty", "");
    // A universal header whose slice lies past the end of the file.
    await put("Contents/Resources/cut", universal(MH_EXECUTE).subarray(0, 48));

    expect(listMachO(app)).toEqual([
      { path: "Contents/Frameworks/F.framework/Versions/A/F", executable: false },
      { path: "Contents/Frameworks/F.framework/Versions/A/Helpers/crashpad", executable: true },
      { path: "Contents/Frameworks/libwide.dylib", executable: false },
      { path: "Contents/MacOS/Test", executable: true },
      { path: "Contents/Resources/node_modules/@img/sharp/sharp.node", executable: false },
    ]);
  });

  test("reads a big-endian header", async () => {
    const header = Buffer.alloc(32);
    header.writeUInt32BE(0xfeedface, 0);
    header.writeUInt32BE(MH_EXECUTE, 12);
    await put("Contents/MacOS/Old", header);

    expect(listMachO(app)).toEqual([{ path: "Contents/MacOS/Old", executable: true }]);
  });
});

describe("sign-app.mjs", () => {
  const entitlements = "/keys/entitlements.plist";

  // Runs sign-app.mjs with a stub rcodesign that writes one argument per line and exits with
  // `status`.
  async function sign(args: string[], status = 0): Promise<RunResult & { rcodesign: string[] }> {
    const record = path.join(work, "rcodesign.args");
    await writeExecutable(
      path.join(work, "rcodesign"),
      `printf '%s\\n' "$@" > "${record}"\nexit ${status}`
    );
    const result = await runScript(["node", SIGN_APP, ...args], {
      cwd: work,
      env: { PATH: `${work}:${process.env.PATH ?? ""}` },
    });
    const text = await readFile(record, "utf8").catch(() => "");
    return { ...result, rcodesign: text.split("\n").filter((line) => line !== "") };
  }

  test("gives every Mach-O the hardened runtime and only executables the entitlements", async () => {
    await put("Contents/MacOS/Test", thin(MH_EXECUTE));
    await put("Contents/Resources/node_modules/@img/sharp/sharp.node", thin(MH_DYLIB));

    const result = await sign([app, entitlements, "--pem-file", "/keys/throwaway.pem"]);

    expect(result.exitCode).toBe(0);
    const exe = "Contents/MacOS/Test";
    const lib = "Contents/Resources/node_modules/@img/sharp/sharp.node";
    expect(result.rcodesign).toEqual([
      "sign",
      "--pem-file",
      "/keys/throwaway.pem",
      "--code-signature-flags",
      `${exe}@[cpu_type=arm64]:runtime`,
      "--entitlements-xml-file",
      `${exe}@[cpu_type=arm64]:${entitlements}`,
      "--code-signature-flags",
      `${exe}@[cpu_type=x86_64]:runtime`,
      "--entitlements-xml-file",
      `${exe}@[cpu_type=x86_64]:${entitlements}`,
      "--code-signature-flags",
      `${lib}@[cpu_type=arm64]:runtime`,
      "--code-signature-flags",
      `${lib}@[cpu_type=x86_64]:runtime`,
      app,
    ]);
  });

  test("exits with the status of rcodesign", async () => {
    await put("Contents/MacOS/Test", thin(MH_EXECUTE));

    expect((await sign([app, entitlements], 7)).exitCode).toBe(7);
  });

  test("refuses a Mach-O whose path has a colon, before it signs anything", async () => {
    await put("Contents/MacOS/Test", thin(MH_EXECUTE));
    await put("Contents/Resources/a:b.node", thin(MH_DYLIB));

    const result = await sign([app, entitlements]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Contents/Resources/a:b.node");
    expect(result.rcodesign).toEqual([]);
  });

  test("fails on a folder with no Mach-O instead of signing nothing", async () => {
    await put("Contents/Info.plist", "<plist/>");

    const result = await sign([app, entitlements]);

    expect(result.exitCode).toBe(1);
    expect(result.rcodesign).toEqual([]);
  });

  test("fails when rcodesign is not installed", async () => {
    await put("Contents/MacOS/Test", thin(MH_EXECUTE));
    const node = path.dirname(Bun.which("node") ?? "");

    const result = await runScript(["node", SIGN_APP, app, entitlements], {
      cwd: work,
      env: { PATH: node },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot run rcodesign");
  });
});
