import { describe, expect, it } from "bun:test";
import type { RuntimeConfig } from "@/common/types/runtime";
import {
  getSideChatCreationRefusal,
  SIDE_CHAT_SYSTEM_INSTRUCTIONS,
  withSideChatInstructions,
} from "./sideChat";

const LOCAL: RuntimeConfig = { type: "local" };
const WORKTREE: RuntimeConfig = { type: "worktree", srcBaseDir: "/tmp/src" };

describe("getSideChatCreationRefusal", () => {
  it("allows runtimes whose checkout a side chat can share", () => {
    expect(getSideChatCreationRefusal({ runtimeConfig: LOCAL })).toBeNull();
    expect(getSideChatCreationRefusal({ runtimeConfig: WORKTREE })).toBeNull();
    expect(
      getSideChatCreationRefusal({
        runtimeConfig: { type: "ssh", host: "example", srcBaseDir: "/src" },
      })
    ).toBeNull();
  });

  it("refuses nesting, scratch chats, multi-project and container runtimes", () => {
    expect(
      getSideChatCreationRefusal({ runtimeConfig: LOCAL, sideChatParentWorkspaceId: "main" })
    ).not.toBeNull();
    expect(getSideChatCreationRefusal({ runtimeConfig: LOCAL, kind: "scratch" })).not.toBeNull();
    expect(
      getSideChatCreationRefusal({
        runtimeConfig: WORKTREE,
        projects: [
          { projectPath: "/a", projectName: "a" },
          { projectPath: "/b", projectName: "b" },
        ],
      })
    ).not.toBeNull();
    expect(
      getSideChatCreationRefusal({ runtimeConfig: { type: "docker", image: "node:22" } })
    ).not.toBeNull();
  });
});

describe("withSideChatInstructions", () => {
  it("leaves other chats' instructions unchanged", () => {
    expect(withSideChatInstructions({}, undefined)).toBeUndefined();
    expect(withSideChatInstructions({}, "be terse")).toBe("be terse");
  });

  it("adds the side-chat guardrails while keeping the chat's own instructions", () => {
    const sideChat = { sideChatParentWorkspaceId: "main" };
    expect(withSideChatInstructions(sideChat, undefined)).toBe(SIDE_CHAT_SYSTEM_INSTRUCTIONS);
    const merged = withSideChatInstructions(sideChat, "be terse");
    expect(merged?.startsWith("be terse")).toBe(true);
    expect(merged?.endsWith(SIDE_CHAT_SYSTEM_INSTRUCTIONS)).toBe(true);
  });
});
