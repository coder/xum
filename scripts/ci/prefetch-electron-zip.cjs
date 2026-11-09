// Download the Electron zips that node_modules/electron/install.js and electron-builder need
// into the @electron/get cache, and stop there. install.js would also unpack about 280 MB into
// node_modules/electron, and the node_modules cache would then save it.
//
// Usage: node scripts/ci/prefetch-electron-zip.cjs [<platform>-<arch>...]
// With no argument it fetches the zip of this host (what install.js asks for). A target such as
// darwin-x64, darwin-arm64, linux-arm64 or win32-x64 names a zip that electron-builder unpacks
// for another architecture than the host's (a macOS job builds both x64 and arm64).
//
// The options match install.js's own downloadArtifact call (version, artifact, cacheRoot from
// electron_config_cache, the checksums that ship with the package, platform, arch), so the
// zip lands where install.js looks for it. scripts/ci/prefetchElectronZip.test.ts compares the
// two calls. Run it from the repository root, after `bun install`.
//
// Output, one line each: `Electron zip ready: <zip>` per target, then `Electron zip dir: <dir>`
// (forward slashes, the directory that holds every zip). electron-builder's `electronDist`
// takes that directory, so all zips must be in one: @electron/get names the directory after the
// release, which is the same for every target.
//
// Exit 0: every zip is in the cache and matches checksums.json. Exit 64: no retry changes the
// result: the release answered an HTTP 4xx other than 408 and 429 (a version that has no
// release, say), a target is not <platform>-<arch>, or the zips are not in one directory:
// scripts/retry.sh runs this with --fatal-status 64. Exit 1: anything else (a 5xx, a timeout,
// a network error).
const { createRequire } = require("node:module");
const path = require("node:path");

const FATAL_EXIT = 64;
const TARGET = /^(darwin|linux|win32)-(x64|arm64|ia32)$/;

const electron = createRequire(`${process.cwd()}/node_modules/electron/`);

function exitCodeFor(err) {
  const status = err.response?.status;
  const final = status >= 400 && status < 500 && status !== 408 && status !== 429;
  return final ? FATAL_EXIT : 1;
}

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

// A Windows path has backslashes (and only a Windows host makes one), so ask path.win32 for its
// directory. The result uses forward slashes, which every consumer here accepts and which
// survive a bash `echo` into $GITHUB_ENV.
function directoryOf(zip) {
  const api = zip.includes("\\") ? path.win32 : path.posix;
  return api.dirname(zip).replaceAll("\\", "/");
}

async function main(targets) {
  const downloadArtifact = electron("@electron/get").downloadArtifact;
  const zips = [];
  for (const target of targets) {
    const [platform, arch] = target.split("-");
    const zip = await downloadArtifact({
      version: electron("./package.json").version,
      artifactName: "electron",
      cacheRoot: process.env.electron_config_cache,
      checksums: electron("./checksums.json"),
      platform,
      arch,
    });
    console.log(`Electron zip ready: ${zip}`);
    zips.push(zip);
  }
  const dirs = new Set(zips.map(directoryOf));
  if (dirs.size !== 1) {
    fail(`the Electron zips are in different directories: ${[...dirs].join(", ")}`, FATAL_EXIT);
  }
  console.log(`Electron zip dir: ${[...dirs][0]}`);
}

const targets =
  process.argv.length > 2 ? process.argv.slice(2) : [`${process.platform}-${process.arch}`];
const invalid = targets.filter((target) => !TARGET.test(target));
if (invalid.length > 0) {
  fail(
    `not an Electron zip target (<platform>-<arch>, e.g. darwin-arm64): ${invalid.join(" ")}`,
    FATAL_EXIT
  );
}
main(targets).catch((err) => fail(err.message, exitCodeFor(err)));
