import { describe, it, expect } from "@jest/globals";
import {
  buildRuntimeString,
  CODER_RUNTIME_PLACEHOLDER,
  parseRuntimeModeAndHost,
  RUNTIME_MODE,
  runtimeModeSupportsSharedTaskWorkspace,
} from "./runtime";

describe("runtimeModeSupportsSharedTaskWorkspace", () => {
  it("is true only for worktree and ssh (runtimes whose fork creates a separate checkout)", () => {
    expect(runtimeModeSupportsSharedTaskWorkspace(RUNTIME_MODE.WORKTREE)).toBe(true);
    expect(runtimeModeSupportsSharedTaskWorkspace(RUNTIME_MODE.SSH)).toBe(true);
  });

  it("is false for local (already shares its dir) and container runtimes", () => {
    expect(runtimeModeSupportsSharedTaskWorkspace(RUNTIME_MODE.LOCAL)).toBe(false);
    expect(runtimeModeSupportsSharedTaskWorkspace(RUNTIME_MODE.DOCKER)).toBe(false);
    expect(runtimeModeSupportsSharedTaskWorkspace(RUNTIME_MODE.DEVCONTAINER)).toBe(false);
    expect(runtimeModeSupportsSharedTaskWorkspace(undefined)).toBe(false);
  });
});

describe("parseRuntimeModeAndHost", () => {
  it("parses SSH mode with host", () => {
    expect(parseRuntimeModeAndHost("ssh user@host")).toEqual({
      mode: "ssh",
      host: "user@host",
    });
  });

  it("returns null for SSH mode without host", () => {
    expect(parseRuntimeModeAndHost("ssh")).toBeNull();
  });

  it("returns null for SSH with trailing space but no host", () => {
    expect(parseRuntimeModeAndHost("ssh ")).toBeNull();
  });

  it("parses Docker mode with image", () => {
    expect(parseRuntimeModeAndHost("docker ubuntu:22.04")).toEqual({
      mode: "docker",
      image: "ubuntu:22.04",
    });
  });

  it("returns null for Docker mode without image", () => {
    expect(parseRuntimeModeAndHost("docker")).toBeNull();
  });

  it("parses local mode", () => {
    expect(parseRuntimeModeAndHost("local")).toEqual({
      mode: "local",
    });
  });

  it("parses worktree mode", () => {
    expect(parseRuntimeModeAndHost("worktree")).toEqual({
      mode: "worktree",
    });
  });

  it("defaults to worktree for undefined", () => {
    expect(parseRuntimeModeAndHost(undefined)).toEqual({
      mode: "worktree",
    });
  });

  it("defaults to worktree for null", () => {
    expect(parseRuntimeModeAndHost(null)).toEqual({
      mode: "worktree",
    });
  });

  it("returns null for unrecognized runtime", () => {
    expect(parseRuntimeModeAndHost("unknown")).toBeNull();
  });
});

describe("buildRuntimeString", () => {
  it("builds SSH string with host", () => {
    expect(buildRuntimeString({ mode: "ssh", host: "user@host" })).toBe("ssh user@host");
  });

  it("builds Docker string with image", () => {
    expect(buildRuntimeString({ mode: "docker", image: "ubuntu:22.04" })).toBe(
      "docker ubuntu:22.04"
    );
  });

  it("returns 'local' for local mode", () => {
    expect(buildRuntimeString({ mode: "local" })).toBe("local");
  });

  it("returns undefined for worktree mode (default)", () => {
    expect(buildRuntimeString({ mode: "worktree" })).toBeUndefined();
  });
});

describe("round-trip parsing and building", () => {
  it("preserves SSH mode with host", () => {
    const built = buildRuntimeString({ mode: "ssh", host: "user@host" });
    const parsed = parseRuntimeModeAndHost(built);
    expect(parsed).toEqual({ mode: "ssh", host: "user@host" });
  });

  it("preserves Docker mode with image", () => {
    const built = buildRuntimeString({ mode: "docker", image: "node:20" });
    const parsed = parseRuntimeModeAndHost(built);
    expect(parsed).toEqual({ mode: "docker", image: "node:20" });
  });

  it("preserves local mode", () => {
    const built = buildRuntimeString({ mode: "local" });
    const parsed = parseRuntimeModeAndHost(built);
    expect(parsed).toEqual({ mode: "local" });
  });

  it("preserves worktree mode", () => {
    const built = buildRuntimeString({ mode: "worktree" });
    const parsed = parseRuntimeModeAndHost(built);
    expect(parsed).toEqual({ mode: "worktree" });
  });

  it("preserves SSH mode with Coder placeholder", () => {
    // Coder SSH runtimes use placeholder host when no explicit SSH host is set
    const built = buildRuntimeString({ mode: "ssh", host: CODER_RUNTIME_PLACEHOLDER });
    const parsed = parseRuntimeModeAndHost(built);
    expect(parsed).toEqual({ mode: "ssh", host: CODER_RUNTIME_PLACEHOLDER });
  });
});
