import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";

// The renderer ships the upstream Geist fonts from the geist npm package (src/browser/styles/
// globals.css). OFL condition 2 requires the copyright notice and the license with every copy
// (#6125), so public/ carries the package's LICENSE.TXT and Vite copies it into dist/ next to the
// fonts. This catches a geist upgrade that changes the notice or the license text.
const root = path.resolve(import.meta.dir, "..");

describe("Geist font license", () => {
  test("public/geist-LICENSE.txt contains the geist package license verbatim", () => {
    const upstream = fs.readFileSync(path.join(root, "node_modules/geist/LICENSE.TXT"), "utf-8");
    const shipped = fs.readFileSync(path.join(root, "public/geist-LICENSE.txt"), "utf-8");
    expect(upstream).toContain("Copyright (c)");
    expect(upstream).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(shipped).toContain(upstream);
  });
});
