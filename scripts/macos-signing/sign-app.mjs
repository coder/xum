#!/usr/bin/env node
// Signs a macOS app bundle with rcodesign, on Linux, the way electron-builder signed it with
// Apple's codesign: every Mach-O gets the hardened runtime, and the executables also get the
// entitlements. The result was compared file by file with the app of v0.32.2, the last release
// that codesign signed: identifiers, flags, entitlements and the signature's parts are equal.
//
// Usage: node scripts/macos-signing/sign-app.mjs <app> <entitlements.plist> [rcodesign options...]
//
// The rcodesign options name the key and the certificate, for example `--pkcs11-library <path>
// --pkcs11-key-label <name> --pkcs11-certificate-file <pem>` for a key in Google Cloud KMS, or
// `--pem-file <certificate> --pem-file <key>` for a throwaway one.
//
// rcodesign gives a nested Mach-O only the settings whose scope is that file's path, and
// `--for-notarization` is no shortcut: it refuses a certificate that Apple did not issue, which
// the throwaway certificate of pull request builds is. So each Mach-O gets its own options.
// A scope ends with an architecture, because rcodesign reads the last `@` of a scope as the
// start of one, and the folders of scoped npm packages (`@img/...`) hold Mach-O files.
import { spawnSync } from "node:child_process";
import { listMachO } from "./machO.mjs";

const CPU_TYPES = ["arm64", "x86_64"];

const [app, entitlements, ...keyOptions] = process.argv.slice(2);
if (!app || !entitlements) {
  console.error("usage: sign-app.mjs <app> <entitlements.plist> [rcodesign options...]");
  process.exit(2);
}

const machOs = listMachO(app);
if (machOs.length === 0) {
  console.error(`sign-app.mjs: no Mach-O file under ${app}`);
  process.exit(1);
}

const scoped = [];
for (const machO of machOs) {
  // rcodesign cuts a scoped option at its first colon, so it would read such a path as another
  // scope and sign the file without the settings.
  if (machO.path.includes(":")) {
    console.error(`sign-app.mjs: rcodesign cannot name ${machO.path} in a scope (it has a colon)`);
    process.exit(1);
  }
  for (const cpuType of CPU_TYPES) {
    const scope = `${machO.path}@[cpu_type=${cpuType}]`;
    scoped.push("--code-signature-flags", `${scope}:runtime`);
    if (machO.executable) scoped.push("--entitlements-xml-file", `${scope}:${entitlements}`);
  }
}

const executables = machOs.filter((machO) => machO.executable).length;
console.log(`Signing ${machOs.length} Mach-O files (${executables} executables) in ${app}`);
const result = spawnSync("rcodesign", ["sign", ...keyOptions, ...scoped, app], {
  stdio: "inherit",
});
if (result.error) {
  console.error(`sign-app.mjs: cannot run rcodesign: ${result.error.message}`);
  process.exit(1);
}
// A signal leaves no status: rcodesign has crashed after signing before.
process.exit(result.status ?? 1);
