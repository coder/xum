import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_APPROVED_COPIES_FILE_BYTES,
  getApprovedCopiesPath,
  nextApprovedCopies,
  readApprovedCopies,
  updateApprovedCopies,
  type ApprovedCopies,
  type ApprovedCopiesSource,
} from "./approvedCopies";
import { noComponentConsent } from "./componentConsent";
import { computePluginInstanceId } from "./mcpConfig";

const skill = (fingerprint: string, content = `content ${fingerprint}`) => ({
  fingerprint,
  relativeDir: "skills/x",
  content,
});
const script = (fingerprint: string) => ({ fingerprint, source: `source ${fingerprint}` });

describe("nextApprovedCopies", () => {
  test("refreshes approved live components, keeps an approved copy of a changed one, drops the rest", () => {
    const previous: ApprovedCopies = {
      skills: {
        refreshed: skill("R1", "old bytes of the same approved version"),
        changed: skill("R2"),
        stale: skill("old"),
        removed: skill("R6"),
        unselected: skill("R4"),
      },
      workflows: { "run.js": script("W1"), "gone.js": script("W2") },
    };
    const live: ApprovedCopies = {
      skills: {
        refreshed: skill("R1"),
        changed: skill("new"),
        stale: skill("newer"),
        unselected: skill("R4"),
        unrecorded: skill("R5"),
      },
      workflows: { "run.js": script("edited") },
    };
    const consent = {
      ...noComponentConsent(),
      skills: { refreshed: "R1", changed: "R2", stale: "R3", removed: "R6", unselected: "R4" },
      workflows: { "run.js": "W1", "gone.js": "W2" },
    };
    const selection = {
      skills: ["refreshed", "changed", "stale", "removed", "unrecorded"],
      mcpServers: [],
    };

    expect(nextApprovedCopies({ previous, consent, selection, live })).toEqual({
      skills: { refreshed: live.skills.refreshed, changed: previous.skills.changed },
      workflows: { "run.js": previous.workflows["run.js"] },
    });
    // An install from before #6498 has no records, so nothing is approved and nothing is kept.
    expect(nextApprovedCopies({ previous, consent: undefined, selection, live })).toEqual({
      skills: {},
      workflows: {},
    });
  });
});

describe("approved copies store", () => {
  let xumHome: string;
  const source = (installedAt = "2026-01-01T00:00:00.000Z"): ApprovedCopiesSource => ({
    xumHome,
    pluginName: "demo",
    installedAt,
  });
  const file = () =>
    getApprovedCopiesPath(xumHome, computePluginInstanceId(path.join(xumHome, "plugins", "demo")));
  const consent = {
    ...noComponentConsent(),
    skills: { greet: "S1" },
    workflows: { "run.js": "W1" },
  };
  const live: ApprovedCopies = {
    skills: { greet: skill("S1") },
    workflows: { "run.js": script("W1") },
  };
  const save = () =>
    updateApprovedCopies({ source: source(), consent, selection: undefined, live });

  beforeEach(async () => {
    xumHome = await fsPromises.mkdtemp(path.join(os.tmpdir(), "xum-approved-copies-"));
  });
  afterEach(async () => {
    await fsPromises.rm(xumHome, { recursive: true, force: true });
  });

  test("reads back the copies of this install only", async () => {
    await save();
    expect(await readApprovedCopies(source())).toEqual(live);
    // A reinstall under the same name has another install time: it inherits nothing.
    expect(await readApprovedCopies(source("2026-02-01T00:00:00.000Z"))).toEqual({
      skills: {},
      workflows: {},
    });
  });

  test("a malformed entry drops only itself", async () => {
    await save();
    const document = JSON.parse(await fsPromises.readFile(file(), "utf8")) as {
      skills: Record<string, unknown>;
    };
    document.skills.broken = { fingerprint: 1 };
    await fsPromises.writeFile(file(), JSON.stringify(document));
    expect(await readApprovedCopies(source())).toEqual(live);
  });

  test.each([
    ["malformed JSON", (target: string) => fsPromises.writeFile(target, "{ not json")],
    [
      "an oversized file",
      (target: string) => fsPromises.truncate(target, MAX_APPROVED_COPIES_FILE_BYTES + 1),
    ],
    [
      "a directory",
      async (target: string) => {
        await fsPromises.rm(target);
        await fsPromises.mkdir(target);
      },
    ],
    // A FIFO must not hang the read (O_NONBLOCK).
    [
      "a FIFO",
      async (target: string) => {
        await fsPromises.rm(target);
        execFileSync("mkfifo", [target]);
      },
    ],
  ])("%s reads as no copies", async (_name, corrupt) => {
    await save();
    await corrupt(file());
    expect(await readApprovedCopies(source())).toEqual({ skills: {}, workflows: {} });
    // The next sweep replaces the corrupted file.
    await save();
    expect(await readApprovedCopies(source())).toEqual(live);
  });

  test("a file a newer Xum wrote is neither read nor overwritten", async () => {
    const newer = JSON.stringify({ version: 2, installedAt: source().installedAt, skills: {} });
    await fsPromises.mkdir(path.dirname(file()), { recursive: true });
    await fsPromises.writeFile(file(), newer);
    await save();
    expect(await fsPromises.readFile(file(), "utf8")).toBe(newer);
    expect(await readApprovedCopies(source())).toEqual({ skills: {}, workflows: {} });
  });
});
