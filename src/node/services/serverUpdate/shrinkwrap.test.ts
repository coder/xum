import { describe, expect, test } from "bun:test";
import { nestShrinkwrap, pinnedDigests } from "./shrinkwrap";

describe("release shrinkwrap", () => {
  test("pins each package under the name it is installed as, with every digest it records", () => {
    const pins = pinnedDigests({
      packages: {
        "": { name: "@coder/xum", version: "2.0.0", dependencies: { "left-pad": "^1.3.0" } },
        "node_modules/left-pad": { version: "1.3.0", integrity: "sha512-pad" },
        "node_modules/left-pad/node_modules/@scope/nested": {
          version: "2.0.0-next.1",
          integrity: "sha1-old sha512-new",
        },
      },
    });
    expect([...pins]).toEqual([
      ["left-pad@1.3.0", ["sha512-pad"]],
      ["@scope/nested@2.0.0-next.1", ["sha1-old", "sha512-new"]],
    ]);
  });

  test("refuses a package that a manager would have to resolve itself", () => {
    const unpinned = [
      { version: "1.3.0" },
      { version: "^1.3.0", integrity: "sha512-pad" },
      { integrity: "sha512-pad" },
    ];
    for (const entry of unpinned) {
      expect(() => pinnedDigests({ packages: { "": {}, "node_modules/left-pad": entry } })).toThrow(
        "left-pad"
      );
    }
  });

  test("nests the tree under the package that ships it, fetched from the configured registry", () => {
    const shrinkwrap = {
      packages: {
        "": { name: "@coder/xum", version: "2.0.0", dependencies: { "left-pad": "1.3.0" } },
        "node_modules/left-pad": {
          version: "1.3.0",
          resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
          integrity: "sha512-pad",
        },
        "node_modules/left-pad/node_modules/other": {
          version: "1.0.0",
          resolved: "https://cdn.example.com/other-1.0.0.tgz",
          integrity: "sha512-other",
        },
      },
    };
    const nested = nestShrinkwrap(
      shrinkwrap,
      "@coder/xum",
      "file:/stage/xum-2.0.0.tgz",
      "https://mirror.example.com/npm"
    );
    expect(nested).toEqual({
      "node_modules/@coder/xum": {
        version: "2.0.0",
        resolved: "file:/stage/xum-2.0.0.tgz",
        dependencies: { "left-pad": "1.3.0" },
      },
      "node_modules/@coder/xum/node_modules/left-pad": {
        version: "1.3.0",
        resolved: "https://mirror.example.com/npm/left-pad/-/left-pad-1.3.0.tgz",
        integrity: "sha512-pad",
      },
      "node_modules/@coder/xum/node_modules/left-pad/node_modules/other":
        shrinkwrap.packages["node_modules/left-pad/node_modules/other"],
    });
  });
});
