/**
 * macOS notarization for electron-builder (`afterSign` hook), with a patient staple retry.
 *
 * electron-builder's built-in notarization (`mac.notarize: true`) calls @electron/notarize 2.2.1,
 * which staples right after notarytool accepts the app. Its staple "retry" never retries: it wraps
 * the staple in promise-retry but never calls promise-retry's retry callback, so a failed staple
 * fails at once. Apple's ticket service often has no ticket yet at that point: `xcrun stapler`
 * exits 68 and the build fails (#6901). CI's outer `retry.sh` then rebuilds, re-signs and
 * re-notarizes the whole app, and hits the same window again. This hook runs the same notarization
 * steps once, then retries only the staple and its validation, and only on code 68, up to 5 times
 * 30 s apart. Any other failure, and a staple or validation that still fails, stays a hard
 * failure.
 *
 * Why a hook and not a step after `make dist-mac`: electron-builder runs afterSign before it builds
 * the dmg and zip targets from the .app, so they package the stapled app. A staple after the build
 * would change only the loose .app, and the shipped dmg and zip would carry no ticket.
 *
 * Credentials: the App Store Connect API key that scripts/setup-macos-signing.sh exports
 * (APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER). Without them the hook skips notarization,
 * as electron-builder did. Other electron-builder credential kinds (APPLE_ID with
 * APPLE_APP_SPECIFIC_PASSWORD, or a keychain profile), even half of a pair, fail the build instead
 * of shipping an app that is silently not notarized.
 */

const { spawn } = require("child_process");
const path = require("path");
// Load the @electron/notarize copy that electron-builder itself uses (electron-builder ->
// app-builder-lib -> @electron/notarize), so this hook runs the code `mac.notarize: true` ran.
// Its index only exports notarize(), which always staples once, so the hook loads the steps
// notarize() runs before the staple, in the same order. A missing path throws
// here, when electron-builder loads the hook, so every macOS build (PR builds too) catches it.
const resolveFrom = (from, request) => require.resolve(request, { paths: [from] });
const appBuilderLibDir = path.dirname(
  resolveFrom(
    path.dirname(resolveFrom(__dirname, "electron-builder/package.json")),
    "app-builder-lib/package.json"
  )
);
const notarizeLibDir = path.join(
  path.dirname(resolveFrom(appBuilderLibDir, "@electron/notarize/package.json")),
  "lib"
);
const { checkSignatures } = require(path.join(notarizeLibDir, "check-signature.js"));
const { isNotaryToolAvailable, notarizeAndWaitForNotaryTool } = require(
  path.join(notarizeLibDir, "notarytool.js")
);

const STAPLE_ATTEMPTS = 5;
const STAPLE_RETRY_DELAY_MS = 30_000;
// `xcrun stapler` exit code when it gets no ticket from Apple's ticket service: none yet, or the
// request failed. Other codes (65 for a bad ticket or signature, for example) do not go away by
// waiting, so they fail at once.
const STAPLE_TICKET_NOT_READY = 68;

/** Runs `xcrun stapler <action> -v <app>` in the app's folder, like @electron/notarize does. */
function runStapler(action, appPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("xcrun", ["stapler", action, "-v", path.basename(appPath)], {
      cwd: path.dirname(appPath),
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

/**
 * Runs one stapler action, retrying only exit code 68 after `delayMs`. Any other failure, or 68 on
 * the last attempt, throws `failure(attempt, result)`.
 */
async function runStaplerWithRetry(action, appPath, attempts, delayMs, failure) {
  for (let attempt = 1; ; attempt++) {
    const result = await runStapler(action, appPath);
    if (result.code === 0) return attempt;
    if (result.code !== STAPLE_TICKET_NOT_READY || attempt === attempts) {
      throw new Error(`${failure(attempt)} with code: ${result.code}\n\n${result.output}`);
    }
    console.log(
      `⚠️ Stapler ${action} attempt ${attempt} of ${attempts}: code ${result.code} (no ticket from Apple yet); retrying in ${delayMs / 1000}s...`
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/**
 * Staples the notarization ticket, then validates it. Both steps fetch the ticket from Apple's
 * ticket service and exit 68 when it has none yet or the request fails (main run 39110844974:
 * validate hit "The network connection was lost" right after a good staple). So both retry only
 * exit code 68, after `delayMs`; any other failure, or 68 on the last attempt, throws.
 * @param {string} appPath
 * @param {{ attempts?: number, delayMs?: number }} [options]
 */
async function stapleWithRetry(appPath, options = {}) {
  const attempts = options.attempts ?? STAPLE_ATTEMPTS;
  const delayMs = options.delayMs ?? STAPLE_RETRY_DELAY_MS;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`stapleWithRetry needs a positive attempt count, got ${attempts}`);
  }
  const name = path.basename(appPath);
  const stapled = await runStaplerWithRetry(
    "staple",
    appPath,
    attempts,
    delayMs,
    (attempt) => `Failed to staple ${appPath} on attempt ${attempt} of ${attempts}`
  );
  console.log(`✅ Stapled ${name} (attempt ${stapled} of ${attempts})`);
  const validated = await runStaplerWithRetry(
    "validate",
    appPath,
    attempts,
    delayMs,
    (attempt) =>
      `Stapled ticket of ${appPath} failed validation on attempt ${attempt} of ${attempts}`
  );
  console.log(`✅ Validated the stapled ticket of ${name} (attempt ${validated} of ${attempts})`);
}

/** @param {import("electron-builder").AfterPackContext} context */
async function notarizeMac(context) {
  // afterSign also runs for signed Windows builds.
  if (context.electronPlatformName !== "darwin") return;

  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  if (!APPLE_API_KEY && !APPLE_API_KEY_ID && !APPLE_API_ISSUER) {
    // electron-builder notarized with (or failed on half of) these; never skip them silently.
    const otherCredentials = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_KEYCHAIN_PROFILE"];
    if (otherCredentials.some((name) => process.env[name])) {
      throw new Error(
        "scripts/notarize-mac.js supports only API key notarization (APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER)"
      );
    }
    console.log("⚠️ No notarization credentials - skipping notarization");
    return;
  }
  if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
    throw new Error("APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER must all be set");
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await checkSignatures({ appPath });
  if (!(await isNotaryToolAvailable())) {
    throw new Error("notarytool is not available, you must be on at least Xcode 13");
  }
  console.log(`🔏 Notarizing ${appPath}...`);
  await notarizeAndWaitForNotaryTool({
    appPath,
    appleApiKey: APPLE_API_KEY,
    appleApiKeyId: APPLE_API_KEY_ID,
    appleApiIssuer: APPLE_API_ISSUER,
  });
  await stapleWithRetry(appPath);
}

exports.default = notarizeMac;
exports.stapleWithRetry = stapleWithRetry;
