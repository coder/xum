import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { stampForDist, stampServiceWorker } from "./stamp-service-worker";

const WORKER_SOURCE = fs.readFileSync(
  path.join(import.meta.dir, "../public/service-worker.js"),
  "utf-8"
);

let dist: string;
const write = (name: string, content: string) => fs.writeFileSync(path.join(dist, name), content);

/** A built dist: an entry chunk that imports a vendor chunk and lazy-loads another, CSS and a font. */
function writeBuild(entry = "main-AbCd1234.js") {
  write(
    "index.html",
    `<html><head><script type="module" crossorigin src="./${entry}"></script>` +
      `<link rel="stylesheet" crossorigin href="./main-CsSs1234.css"></head><body></body></html>`
  );
  write(
    entry,
    `import "./vendor-VeNd1234.js";\nconst lazy = () => import("./lazy-LaZy1234.js");\n`
  );
  write("vendor-VeNd1234.js", "export const v = 1;\n");
  write("lazy-LaZy1234.js", "export const l = 1;\n");
  write(
    "main-CsSs1234.css",
    `@font-face{font-family:"Geist";src:url(./Geist-FoNt1234.woff2) format("woff2")}`
  );
  write("Geist-FoNt1234.woff2", "font");
}

beforeEach(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-sw-"));
});
afterEach(() => {
  fs.rmSync(dist, { recursive: true, force: true });
});

describe("stampForDist (#6867)", () => {
  test("lists the first-load graph, the stylesheets and the first-view font, not lazy chunks", () => {
    writeBuild();
    const stamp = stampForDist(dist);
    expect(stamp.entryFile).toBe("main-AbCd1234.js");
    expect(stamp.precache).toEqual(
      ["Geist-FoNt1234.woff2", "main-AbCd1234.js", "main-CsSs1234.css", "vendor-VeNd1234.js"].sort()
    );
    expect(stamp.buildId).toMatch(/^[0-9a-f]{12}$/);
  });

  test("the build id changes with the built index.html and only with it", () => {
    writeBuild();
    const first = stampForDist(dist).buildId;
    write("lazy-LaZy1234.js", "export const l = 2;\n");
    expect(stampForDist(dist).buildId).toBe(first);
    writeBuild("main-NeWw1234.js");
    expect(stampForDist(dist).buildId).not.toBe(first);
  });

  test("fails the build when a first-load file is outside the hashed allow-list", () => {
    writeBuild();
    write("main-AbCd1234.js", `import "./config.js";\n`);
    write("config.js", "export const c = 1;\n");
    expect(() => stampForDist(dist)).toThrow("precache outside the hashed allow-list: config.js");
  });
});

describe("stampServiceWorker (#6867)", () => {
  const stamp = {
    buildId: "0123456789ab",
    entryFile: "main-AbCd1234.js",
    precache: ["main-AbCd1234.js"],
  };

  test("writes the values into the real worker and is idempotent", () => {
    const once = stampServiceWorker(WORKER_SOURCE, stamp);
    expect(once).toContain('const BUILD_ID = "0123456789ab";');
    expect(once).toContain('const PRECACHE = ["main-AbCd1234.js"];');
    expect(stampServiceWorker(once, stamp)).toBe(once);
  });

  test("fails when a marker is missing or repeated", () => {
    expect(() =>
      stampServiceWorker(WORKER_SOURCE.replace(/^const ENTRY_FILE = .*;$/m, ""), stamp)
    ).toThrow("exactly one entryFile marker, found 0");
    const twice = `${WORKER_SOURCE}\nconst BUILD_ID = "x";\n`;
    expect(() => stampServiceWorker(twice, stamp)).toThrow("exactly one buildId marker, found 2");
  });
});
