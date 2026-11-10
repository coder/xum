import { describe, expect, it } from "bun:test";
import type { RuntimeConfig } from "@/common/types/runtime";
import {
  isWorkspaceDirTrustedBy,
  normalizeTrustedSshDirectories,
  withSshDirectoryTrust,
} from "./sshDirectoryTrust";

const sshNone = (
  overrides: Partial<Extract<RuntimeConfig, { type: "ssh" }>> = {}
): RuntimeConfig => ({
  type: "ssh",
  host: "dev@box",
  srcBaseDir: "~/xum",
  workspaceIsolation: "none",
  projectDir: "/srv/app",
  ...overrides,
});

describe("isWorkspaceDirTrustedBy", () => {
  it("covers runtimes whose checkout the project owns without any entry", () => {
    expect(isWorkspaceDirTrustedBy(undefined, undefined)).toBe(true);
    expect(isWorkspaceDirTrustedBy(undefined, { type: "local" })).toBe(true);
    expect(
      isWorkspaceDirTrustedBy(undefined, { type: "ssh", host: "dev@box", srcBaseDir: "~/xum" })
    ).toBe(true);
  });

  it("trusts an SSH+None directory only on an exact host, port and projectDir match", () => {
    const trusted = [{ host: "dev@box", projectDir: "/srv/app" }];
    expect(isWorkspaceDirTrustedBy(undefined, sshNone())).toBe(false);
    expect(isWorkspaceDirTrustedBy(trusted, sshNone())).toBe(true);
    expect(isWorkspaceDirTrustedBy(trusted, sshNone({ host: "other@box" }))).toBe(false);
    expect(isWorkspaceDirTrustedBy(trusted, sshNone({ projectDir: "/srv/app/" }))).toBe(false);
    // An absent port matches only an absent port: 22 is not assumed.
    expect(isWorkspaceDirTrustedBy(trusted, sshNone({ port: 22 }))).toBe(false);
    expect(
      isWorkspaceDirTrustedBy(
        [{ host: "dev@box", port: 2222, projectDir: "/srv/app" }],
        sshNone({ port: 2222 })
      )
    ).toBe(true);
  });

  it("never trusts an SSH+None runtime without a projectDir", () => {
    expect(
      isWorkspaceDirTrustedBy(
        [{ host: "dev@box", projectDir: "" }],
        sshNone({ projectDir: undefined })
      )
    ).toBe(false);
  });
});

describe("normalizeTrustedSshDirectories", () => {
  it("drops malformed entries and duplicates, and returns undefined when none remain", () => {
    expect(normalizeTrustedSshDirectories(undefined)).toBeUndefined();
    expect(normalizeTrustedSshDirectories("nope")).toBeUndefined();
    expect(
      normalizeTrustedSshDirectories([null, 1, { host: "", projectDir: "/a" }])
    ).toBeUndefined();
    expect(
      normalizeTrustedSshDirectories([
        { host: "h", projectDir: "/a" },
        { host: "h", projectDir: "/a" },
        { host: "h", port: 0, projectDir: "/a" },
        { host: "h", port: "22", projectDir: "/a" },
        { host: "h", port: 2222, projectDir: "/a", extra: true },
        { host: "h", projectDir: 5 },
      ])
    ).toEqual([
      { host: "h", projectDir: "/a" },
      { host: "h", port: 2222, projectDir: "/a" },
    ]);
  });
});

describe("withSshDirectoryTrust", () => {
  const dir = { host: "h", projectDir: "/a" };

  it("adds once, removes, and stays sparse", () => {
    const once = withSshDirectoryTrust(undefined, dir, true);
    expect(once).toEqual([dir]);
    expect(withSshDirectoryTrust(once, dir, true)).toEqual([dir]);
    expect(withSshDirectoryTrust(once, dir, false)).toBeUndefined();
    expect(withSshDirectoryTrust(undefined, dir, false)).toBeUndefined();
  });
});
