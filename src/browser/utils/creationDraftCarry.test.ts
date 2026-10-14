import { afterEach, describe, expect, test } from "bun:test";
import type { ParsedRuntime } from "@/common/types/runtime";
import {
  clearCreationRuntimeHandOff,
  handOffCreationRuntime,
  peekCreationRuntimeHandOff,
} from "./creationDraftCarry";

const DRAFT_SCOPE_ID = "__draft__//repo/b/draft-1";

describe("handOffCreationRuntime", () => {
  afterEach(() => clearCreationRuntimeHandOff(DRAFT_SCOPE_ID));

  // SECURITY: a host or container picked for one project must not get another project's source
  // (or the user's shared credentials) without a pick in that project.
  const picks: Array<[string, ParsedRuntime, boolean]> = [
    ["Local", { mode: "local" }, true],
    ["Worktree", { mode: "worktree" }, true],
    ["SSH", { mode: "ssh", host: "dev@host" }, false],
    ["Docker", { mode: "docker", image: "ubuntu:22.04" }, false],
    [
      "Docker with shared credentials",
      { mode: "docker", image: "node", shareCredentials: true },
      false,
    ],
    [
      "Dev container",
      { mode: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
      false,
    ],
  ];
  for (const [label, runtime, moves] of picks) {
    test(`an explicit ${label} pick ${moves ? "moves to another project" : "stays behind"}`, () => {
      handOffCreationRuntime({
        sourceProjectPath: "/repo/a",
        destProjectPath: "/repo/b",
        draftScopeId: DRAFT_SCOPE_ID,
        runtime,
      });

      expect(peekCreationRuntimeHandOff(DRAFT_SCOPE_ID)).toEqual(moves ? runtime : null);
    });
  }
});
