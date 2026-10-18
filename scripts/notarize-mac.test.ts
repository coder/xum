import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface AfterSignContext {
  electronPlatformName: string;
  appOutDir: string;
  packager: { appInfo: { productFilename: string } };
}

// Local shape for the untyped CommonJS electron-builder hook; only the members these tests use.
interface NotarizeMacModule {
  default(context: AfterSignContext): Promise<void>;
  stapleWithRetry(
    appPath: string,
    options?: { attempts?: number; delayMs?: number }
  ): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain CommonJS electron-builder hook
const notarizeMac = require("./notarize-mac.js") as NotarizeMacModule;

const CREDENTIAL_ENV = [
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_KEYCHAIN_PROFILE",
] as const;

let tempDir: string;
let appPath: string;
let callLog: string;
let savedEnv: Record<string, string | undefined>;

interface FakeTools {
  /** Exit code of each `xcrun stapler staple` call in order; the last one repeats. */
  stapleCodes: number[];
  validateCode?: number;
  /** `status` in the JSON that `xcrun notarytool submit --wait` prints. */
  notaryStatus?: string;
}

/**
 * Puts fake `xcrun`, `codesign` and `ditto` first on PATH. Every call logs
 * `<tool> <args>|<cwd>` to the call log.
 */
function installFakeTools(tools: FakeTools): void {
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const stapleCodesFile = path.join(tempDir, "staple-codes");
  fs.writeFileSync(stapleCodesFile, tools.stapleCodes.join("\n") + "\n");
  const log = `echo "$(basename "$0") $*|$(pwd)" >> "${callLog}"`;
  const xcrun = `#!/usr/bin/env bash
${log}
case "$1 $2" in
  "--find notarytool") echo /usr/bin/notarytool; exit 0 ;;
  "notarytool submit") echo '{"id":"fake-id","status":"${tools.notaryStatus ?? "Accepted"}","message":"fake"}'; exit 0 ;;
  "notarytool log") echo '{}'; exit 0 ;;
  "stapler validate") echo "fake validate output"; exit ${tools.validateCode ?? 0} ;;
  "stapler staple")
    count=$(grep -c '^xcrun stapler staple' "${callLog}")
    code=$(sed -n "\${count}p" "${stapleCodesFile}")
    [ -n "$code" ] || code=$(tail -n 1 "${stapleCodesFile}")
    echo "fake staple output, call $count"
    exit "$code" ;;
esac
echo "unexpected xcrun call: $*" >&2
exit 99
`;
  fs.writeFileSync(path.join(binDir, "xcrun"), xcrun);
  for (const tool of ["codesign", "ditto"]) {
    fs.writeFileSync(path.join(binDir, tool), `#!/usr/bin/env bash\n${log}\nexit 0\n`);
  }
  for (const tool of ["xcrun", "codesign", "ditto"]) fs.chmodSync(path.join(binDir, tool), 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${savedEnv.PATH ?? ""}`;
}

function calls(): Array<{ command: string; cwd: string }> {
  if (!fs.existsSync(callLog)) return [];
  return fs
    .readFileSync(callLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [command, cwd] = line.split("|");
      return { command, cwd };
    });
}

const stapleCalls = () => calls().filter((call) => call.command.startsWith("xcrun stapler"));

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error: ${String(error)}`);
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notarize-mac-"));
  appPath = path.join(tempDir, "out", "Xum.app");
  fs.mkdirSync(appPath, { recursive: true });
  callLog = path.join(tempDir, "calls.log");
  savedEnv = { PATH: process.env.PATH };
  for (const name of CREDENTIAL_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("code 68 (no ticket yet) is retried after the delay until the staple succeeds, then validated", async () => {
  installFakeTools({ stapleCodes: [68, 68, 0] });

  // performance.now() is monotonic; the fake's wall-clock stamps can jump when NTP steps the clock.
  const startedAt = performance.now();
  await notarizeMac.stapleWithRetry(appPath, { attempts: 5, delayMs: 150 });
  const elapsedMs = performance.now() - startedAt;

  const made = stapleCalls();
  expect(made.map((call) => call.command)).toEqual([
    "xcrun stapler staple -v Xum.app",
    "xcrun stapler staple -v Xum.app",
    "xcrun stapler staple -v Xum.app",
    "xcrun stapler validate -v Xum.app",
  ]);
  // Like @electron/notarize, the stapler runs in the app's folder with the bundle's base name.
  for (const call of made) {
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(path.dirname(appPath)));
  }
  // Two waits of 150 ms: one after each code 68.
  expect(elapsedMs).toBeGreaterThanOrEqual(2 * 150);
});

test("any other staple failure fails at once, without a retry", async () => {
  installFakeTools({ stapleCodes: [65, 0] });

  const error = await rejection(notarizeMac.stapleWithRetry(appPath, { attempts: 5, delayMs: 0 }));

  expect(error.message).toContain("on attempt 1 of 5 with code: 65");
  expect(stapleCalls().map((call) => call.command)).toEqual(["xcrun stapler staple -v Xum.app"]);
});

test("code 68 on every attempt is a hard failure after the last one", async () => {
  installFakeTools({ stapleCodes: [68] });

  const error = await rejection(notarizeMac.stapleWithRetry(appPath, { attempts: 5, delayMs: 0 }));

  expect(error.message).toContain("on attempt 5 of 5 with code: 68");
  expect(error.message).toContain("fake staple output, call 5");
  expect(stapleCalls().map((call) => call.command)).toEqual(
    Array<string>(5).fill("xcrun stapler staple -v Xum.app")
  );
});

test("a stapled ticket that fails validation is a hard failure", async () => {
  installFakeTools({ stapleCodes: [0], validateCode: 65 });

  const error = await rejection(notarizeMac.stapleWithRetry(appPath, { attempts: 5, delayMs: 0 }));

  expect(error.message).toContain("failed validation with code: 65");
});

const macContext = (): AfterSignContext => ({
  electronPlatformName: "darwin",
  appOutDir: path.dirname(appPath),
  packager: { appInfo: { productFilename: "Xum" } },
});

function setApiKeyCredentials(): void {
  process.env.APPLE_API_KEY = path.join(tempDir, "AuthKey.p8");
  process.env.APPLE_API_KEY_ID = "fake-key-id";
  process.env.APPLE_API_ISSUER = "fake-issuer";
}

test("the hook notarizes once with the API key, then staples and validates", async () => {
  installFakeTools({ stapleCodes: [0] });
  setApiKeyCredentials();

  await notarizeMac.default(macContext());

  const commands = calls().map((call) => call.command);
  const submits = commands.filter((command) => command.startsWith("xcrun notarytool submit"));
  expect(submits).toHaveLength(1);
  expect(submits[0]).toContain(
    `--key ${process.env.APPLE_API_KEY} --key-id fake-key-id --issuer fake-issuer --wait`
  );
  expect(commands.slice(commands.indexOf(submits[0]) + 1)).toEqual([
    "xcrun stapler staple -v Xum.app",
    "xcrun stapler validate -v Xum.app",
  ]);
});

test("a failed notarization fails the hook at once, without a staple", async () => {
  installFakeTools({ stapleCodes: [0], notaryStatus: "Invalid" });
  setApiKeyCredentials();

  const error = await rejection(notarizeMac.default(macContext()));

  expect(error.message).toContain("Failed to notarize via notarytool");
  expect(calls().filter((call) => call.command.startsWith("xcrun notarytool submit"))).toHaveLength(
    1
  );
  expect(stapleCalls()).toEqual([]);
});

test("the hook does nothing for other platforms or without notarization credentials", async () => {
  installFakeTools({ stapleCodes: [0] });
  setApiKeyCredentials();

  await notarizeMac.default({ ...macContext(), electronPlatformName: "win32" });
  for (const name of CREDENTIAL_ENV) delete process.env[name];
  await notarizeMac.default(macContext());

  expect(calls()).toEqual([]);
});

test("the hook refuses credentials it cannot notarize with instead of skipping", async () => {
  installFakeTools({ stapleCodes: [0] });

  process.env.APPLE_API_KEY_ID = "fake-key-id";
  expect((await rejection(notarizeMac.default(macContext()))).message).toContain("must all be set");

  delete process.env.APPLE_API_KEY_ID;
  process.env.APPLE_ID = "dev@example.com";
  expect((await rejection(notarizeMac.default(macContext()))).message).toContain(
    "supports only API key notarization"
  );

  expect(calls()).toEqual([]);
});
