import { describe, expect, it } from "bun:test";
import { SandboxApprovalManager } from "./sandboxApprovalManager";

describe("SandboxApprovalManager", () => {
  it("resolves a request with the user's answer, once", async () => {
    const manager = new SandboxApprovalManager();

    const approved = manager.request("ws", "call-1");
    expect(manager.answer("ws", "call-1", true)).toBe(true);
    expect(await approved).toBe("approved");
    // Answered: nothing is pending any more, so a late second answer changes nothing.
    expect(manager.answer("ws", "call-1", false)).toBe(false);

    const denied = manager.request("ws", "call-2");
    expect(manager.answer("ws", "call-2", false)).toBe(true);
    expect(await denied).toBe("denied");
  });

  it("remembers nothing: the same call id asks again after an approval", async () => {
    const manager = new SandboxApprovalManager();
    const first = manager.request("ws", "call");
    manager.answer("ws", "call", true);
    await first;

    let settled = false;
    const second = manager.request("ws", "call").finally(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    manager.answer("ws", "call", false);
    expect(await second).toBe("denied");
  });

  it("denies on Stop, also when the signal aborted before the request", async () => {
    const manager = new SandboxApprovalManager();
    const controller = new AbortController();

    const pending = manager.request("ws", "call", controller.signal);
    controller.abort();
    expect(await pending).toBe("denied");
    expect(manager.answer("ws", "call", true)).toBe(false);

    expect(await manager.request("ws", "late", controller.signal)).toBe("denied");
  });

  it("denies at once in a process that no user can answer", async () => {
    const manager = new SandboxApprovalManager();
    manager.denyAllRequests();

    expect(await manager.request("ws", "call")).toBe("denied");
    expect(manager.pendingEvents("ws")).toEqual([]);
  });

  it("answers only the request of the same workspace", async () => {
    const manager = new SandboxApprovalManager();
    const pending = manager.request("ws-a", "call");

    expect(manager.answer("ws-b", "call", true)).toBe(false);
    manager.answer("ws-a", "call", false);
    expect(await pending).toBe("denied");
  });
});
