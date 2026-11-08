// Download the Electron zip that node_modules/electron/install.js needs into the @electron/get
// cache, and stop there. install.js would also unpack about 280 MB into node_modules/electron,
// and the node_modules cache would then save it.
//
// The options match install.js's own downloadArtifact call (version, artifact, cacheRoot from
// electron_config_cache, the checksums that ship with the package, platform, arch), so the
// zip lands where install.js looks for it. scripts/ci/prefetchElectronZip.test.ts compares the
// two calls. Run it from the repository root, after `bun install`.
//
// Exit 0: the zip is in the cache. Exit 64: the release answered an HTTP 4xx other than 408
// and 429 (a version that has no release, say), which no retry changes: scripts/retry.sh runs
// this with --fatal-status 64. Exit 1: anything else (a 5xx, a timeout, a network error).
const { createRequire } = require("node:module");

const FATAL_EXIT = 64;

const electron = createRequire(`${process.cwd()}/node_modules/electron/`);

function exitCodeFor(err) {
  const status = err.response?.status;
  const final = status >= 400 && status < 500 && status !== 408 && status !== 429;
  return final ? FATAL_EXIT : 1;
}

electron("@electron/get")
  .downloadArtifact({
    version: electron("./package.json").version,
    artifactName: "electron",
    cacheRoot: process.env.electron_config_cache,
    checksums: electron("./checksums.json"),
    platform: process.platform,
    arch: process.arch,
  })
  .then(
    (zip) => console.log(`Electron zip ready: ${zip}`),
    (err) => {
      console.error(err.message);
      process.exit(exitCodeFor(err));
    }
  );
