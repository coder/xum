import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathOfNearest } from "./sandboxPaths";

describe("realpathOfNearest", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-paths-")));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // Seatbelt matches real paths only: a rule for a folder that does not exist yet, under a link
  // such as /tmp, must name the link's target or it matches nothing once the folder exists.
  test("a path that does not exist yet takes the real path of its nearest existing ancestor", async () => {
    const real = path.join(root, "real");
    await fs.mkdir(real);
    await fs.symlink(real, path.join(root, "link"));

    expect(realpathOfNearest(path.join(root, "link", "new", "file"))).toBe(
      path.join(real, "new", "file")
    );
  });
});
