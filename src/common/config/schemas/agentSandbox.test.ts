import { describe, expect, it } from "bun:test";
import { DEFAULT_ALLOWED_HOSTS } from "@/common/constants/agentSandbox";
import {
  patchAgentSandbox,
  resolveAgentSandboxSettings,
  salvageAgentSandbox,
} from "./agentSandbox";

describe("resolveAgentSandboxSettings", () => {
  it("is off with the default network when nothing is set", () => {
    expect(resolveAgentSandboxSettings(undefined, undefined)).toEqual({
      enabled: false,
      network: "allowlist",
      allowedHosts: [...DEFAULT_ALLOWED_HOSTS],
      extraWritePaths: [],
      extraReadPaths: [],
    });
  });

  it("takes each field the project sets and the global value of the rest", () => {
    const global = {
      enabled: true,
      network: "open" as const,
      allowedHosts: ["a.example"],
      extraWritePaths: ["~/.gradle"],
    };

    expect(
      resolveAgentSandboxSettings(global, { enabled: false, allowedHosts: ["b.example"] })
    ).toEqual({
      enabled: false,
      network: "open",
      allowedHosts: ["b.example"],
      extraWritePaths: ["~/.gradle"],
      extraReadPaths: [],
    });
    // A project that only lists hosts keeps the global sandbox on.
    expect(resolveAgentSandboxSettings(global, { allowedHosts: [] }).enabled).toBe(true);
  });
});

describe("salvageAgentSandbox", () => {
  it("keeps the valid fields of a hand-edited value, so a typo never turns the sandbox off", () => {
    expect(
      salvageAgentSandbox({ enabled: true, network: "everything", allowedHosts: "github.com" })
    ).toEqual({ enabled: true });
  });

  it("drops a value with no valid field", () => {
    expect(salvageAgentSandbox({ network: 42 })).toBeUndefined();
    expect(salvageAgentSandbox(["enabled"])).toBeUndefined();
    expect(salvageAgentSandbox(null)).toBeUndefined();
  });
});

describe("patchAgentSandbox", () => {
  it("sets the fields with a value, removes the null ones, and keeps the rest", () => {
    const saved = { enabled: true, network: "open" as const, extraReadPaths: ["~/.npmrc"] };

    expect(
      patchAgentSandbox(saved, { network: null, allowedHosts: ["a.example"], enabled: undefined })
    ).toEqual({ enabled: true, extraReadPaths: ["~/.npmrc"], allowedHosts: ["a.example"] });
    expect(patchAgentSandbox({ enabled: true }, { enabled: null })).toBeUndefined();
  });
});
