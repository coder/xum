// Download the Electron zip that node_modules/electron/install.js needs into the @electron/get
// cache, and stop there. install.js would also unpack about 280 MB into node_modules/electron,
// and the node_modules cache would then save it.
//
// The options match install.js's own downloadArtifact call (version, artifact, cacheRoot from
// electron_config_cache, the checksums that ship with the package, platform, arch), so the
// zip lands where install.js looks for it. scripts/ci/prefetchElectronZip.test.ts compares the
// two calls. Run it from the repository root, after `bun install`.
const { createRequire } = require("node:module");

const electron = createRequire(`${process.cwd()}/node_modules/electron/`);

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
      process.exit(1);
    }
  );
