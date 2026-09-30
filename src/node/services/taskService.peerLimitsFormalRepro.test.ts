/**
 * Deterministic repros of counterexamples found by the TLA+ model in
 * formal/peer-limits/ (PeerLimits.tla; run formal/peer-limits/check.sh). Each
 * test asserts a documented peer-message bound (src/constants/agentMessaging.ts)
 * that the code broke before the fix (MC_*_fixed configs model the fixed code).
 *
 * Run: bun test ./src/node/services/taskService.peerLimitsFormalRepro.test.ts
 *
 * Gates are bounded (they give up after GATE_MS and continue): the fixed code
 * changes the call sequence, and a gate that is never released must not hang.
 */
import * as path from "path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import {
  MAX_QUEUED_PEER_MESSAGES_PER_TARGET,
  PEER_MESSAGE_RATE_LIMIT_MAX,
  PEER_MESSAGE_RATE_WINDOW_MS,
} from "@/constants/agentMessaging";
import { Err, Ok, type Result } from "@/common/types/result";
import type { AgentPeerMessageBroker } from "@/node/services/agentPeerMessageBroker";
import { createUnknownSendMessageError } from "@/node/services/utils/sendMessageError";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  projectWorkspace,
  saveWorkspacesWithCheckouts as saveWorkspaces,
  testTaskSettings,
  workspaceTurnManagerInternals,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  registerLiveWorkspaceTurnHandle,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

const GATE_MS = 2_000;

/** Wait for `signal`, but never longer than GATE_MS (see module doc). */
async function gate(signal: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    signal,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, GATE_MS);
    }),
  ]);
  clearTimeout(timer);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface SendInternal {
  preTurnMessages?: unknown[];
  queueDedupeKey?: string;
}

/** Whether a mocked sendMessage call carries the peer route's trigger. */
function isPeerRouteCall(internal: SendInternal | undefined): boolean {
  return internal?.queueDedupeKey?.startsWith("agent-msg:") === true;
}

describe("peer-message limits (formal/peer-limits repros)", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    setSystemTime();
    await removeTaskServiceTestRoot(rootDir);
  });

  async function siblingTree() {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "sib-a", "sib-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );
    return config;
  }

  // Model: MC_peer_fail_after_rows, PairRate/TargetRate. The peer route charged the
  // rate slot only after a successful sendMessage. A delivery can persist its payload
  // row and still fail — the family route documents and tests exactly this ("failed
  // family deliveries still consume the rate limit") — so a task_send_message loop
  // against such a target landed rows without limit. Fixed: it charges at admission.
  test("a failing task_send_message delivery that persisted its row consumes the pair rate limit", async () => {
    const config = await siblingTree();
    let rowsLanded = 0;
    const sendMessage = mock(
      (_id: string, _text: string, _options: unknown, internal?: SendInternal) => {
        rowsLanded += internal?.preTurnMessages?.length ?? 0; // persisted, then failure
        return Promise.resolve(
          Err(createUnknownSendMessageError("goal sync failed after persistence"))
        );
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    setSystemTime(new Date(Date.now())); // One rate window for the whole loop.
    for (let i = 0; i < PEER_MESSAGE_RATE_LIMIT_MAX + 3; i++) {
      await taskService.sendAgentTreeMessage("sib-a", "sib-b", `status ${i}`);
    }
    // Bound (agentMessaging.ts:10-11): at most PEER_MESSAGE_RATE_LIMIT_MAX payloads per pair
    // per window reach the target.
    expect(rowsLanded).toBeLessThanOrEqual(PEER_MESSAGE_RATE_LIMIT_MAX);
  });

  // Model: MC_cross_route, PairRate (also TargetRate, Dedupe, QueueCap). The family route
  // admitted under broker.withDeliveryLock but the peer route only under workspaceEventLocks,
  // and the peer route charged only after its sendMessage returned. A family send admitted in
  // that window saw the in-flight peer send's slot as free. Fixed: both routes share
  // withPeerAdmissionLock and charge at admission.
  test("task_send_message and task_message_sibling cannot together exceed the pair rate limit", async () => {
    const config = await siblingTree();
    const peerInFlight = deferred();
    const familyAdmitted = deferred();
    let peerCalls = 0;
    let rowsLanded = 0;
    const sendMessage = mock(
      async (
        _id: string,
        _text: string,
        _options: unknown,
        internal?: SendInternal
      ): Promise<Result<void>> => {
        rowsLanded += internal?.preTurnMessages?.length ?? 0;
        if (isPeerRouteCall(internal)) {
          peerCalls++;
          if (peerCalls === PEER_MESSAGE_RATE_LIMIT_MAX) {
            // The last in-budget peer send is past admission, not yet charged.
            peerInFlight.resolve();
            await gate(familyAdmitted.promise);
          }
        }
        return Ok(undefined);
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const broker = (taskService as unknown as { agentPeerMessageBroker: AgentPeerMessageBroker })
      .agentPeerMessageBroker;
    setSystemTime(new Date(Date.now()));
    for (let i = 0; i < PEER_MESSAGE_RATE_LIMIT_MAX - 1; i++) {
      expect((await taskService.sendAgentTreeMessage("sib-a", "sib-b", `peer ${i}`)).success).toBe(
        true
      );
    }
    const lastPeer = taskService.sendAgentTreeMessage("sib-a", "sib-b", "peer last");
    await gate(peerInFlight.promise);
    // Before the fix the in-flight peer send had not charged yet, so the next charge is the
    // family route's, made right after its admission check.
    const charge = spyOn(broker, "recordPeerAttempt").mockImplementation(
      (sender: string, target: string) => {
        charge.mockRestore();
        broker.recordPeerAttempt(sender, target);
        familyAdmitted.resolve();
      }
    );
    const family = taskService.sendMessageToSiblingAgentTask(
      "sib-a",
      "sib-b",
      "family extra",
      "tool-end"
    );
    await Promise.all([lastPeer, family]);
    // Bound (agentMessaging.ts:10-11) across both routes that share it.
    expect(rowsLanded).toBeLessThanOrEqual(PEER_MESSAGE_RATE_LIMIT_MAX);
  });

  // Model: MC_cross_route, Dedupe. Charging at admission alone closes the rate gap above; the
  // duplicate check (and the queue cap) also needs both routes to hold one lock from admission
  // until the delivery is recorded. A family send admitted while an identical peer send is in
  // flight passed the duplicate check.
  test("task_send_message and task_message_sibling cannot both deliver one duplicate", async () => {
    const config = await siblingTree();
    const peerInFlight = deferred();
    const familyAdmitted = deferred();
    let rowsLanded = 0;
    const sendMessage = mock(
      async (
        _id: string,
        _text: string,
        _options: unknown,
        internal?: SendInternal
      ): Promise<Result<void>> => {
        rowsLanded += internal?.preTurnMessages?.length ?? 0;
        if (isPeerRouteCall(internal)) {
          peerInFlight.resolve();
          await gate(familyAdmitted.promise);
        }
        return Ok(undefined);
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const broker = (taskService as unknown as { agentPeerMessageBroker: AgentPeerMessageBroker })
      .agentPeerMessageBroker;
    const peer = taskService.sendAgentTreeMessage("sib-a", "sib-b", "same text");
    await gate(peerInFlight.promise);
    // The next admission check is the family route's.
    const check = spyOn(broker, "checkPeerAdmission").mockImplementation(
      (sender: string, target: string, message: string) => {
        check.mockRestore();
        const verdict = broker.checkPeerAdmission(sender, target, message);
        familyAdmitted.resolve();
        return verdict;
      }
    );
    const family = taskService.sendMessageToSiblingAgentTask(
      "sib-a",
      "sib-b",
      "same text",
      "tool-end"
    );
    await Promise.all([peer, family]);
    // Bound (agentMessaging.ts:17-18) across both routes.
    expect(rowsLanded).toBe(1);
  });

  // Model: MC_peer_delegated, QueueCap. flushParkedPeerSends shifted the next waiting message
  // before its retry took the target's lock, and the retry skips admission. A fresh send holding
  // the lock meanwhile counted one message too few (queued + parked) and was admitted past the
  // cap. Fixed: the retry leaves the parked list only under the target's admission lock.
  test("messages that waited for a delegated turn never push the target's queue past the cap", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const senders = ["sender-1", "sender-2", "sender-3"];
    await saveWorkspaces(
      config,
      projectPath,
      [
        ...senders.map((id) => projectWorkspace(projectPath, id, id)),
        projectWorkspace(projectPath, "target", "target", {
          agentId: "exec",
          unrelatedWorkspaceConsent: "consent",
        }),
      ],
      testTaskSettings()
    );
    // The target is busy with its own turn, so every delivered peer message stays queued.
    let queued = 0;
    let maxQueued = 0;
    const sendMessage = mock(() => {
      queued++;
      maxQueued = Math.max(maxQueued, queued);
      return Promise.resolve(Ok(undefined));
    });
    const countQueuedAgentPeerMessages = mock(() => queued);
    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage,
      countQueuedAgentPeerMessages,
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    await registerLiveWorkspaceTurnHandle(
      taskService,
      "target",
      "wst_foreign",
      "owner",
      "accepted"
    );

    let now = Date.now();
    setSystemTime(new Date(now));
    // Fill the cap with messages waiting for the delegated turn (two senders, within both
    // rate limits).
    for (let i = 0; i < MAX_QUEUED_PEER_MESSAGES_PER_TARGET; i++) {
      const sender = senders[i % 2];
      expect(await taskService.sendAgentTreeMessage(sender, "target", `wait ${i}`)).toEqual(
        Ok({ delivery: "queued", relation: "target_unrelated", awaitsDelegatedTurn: true })
      );
    }
    // The rate windows pass while the turn runs; only the cap still binds.
    now += PEER_MESSAGE_RATE_WINDOW_MS + 1;
    setSystemTime(new Date(now));

    // A fresh send claims the target's event lock first, then the delegated turn ends and
    // the drain's first retry queues on the lock behind it.
    const fresh = taskService.sendAgentTreeMessage("sender-3", "target", "fresh");
    workspaceTurnManagerInternals(taskService).activeWorkspaceTurnHandleByWorkspaceId.delete(
      "target"
    );
    await fresh;
    // Let the drain deliver every waiting message (it unregisters the list once empty).
    const parkedByTarget = (
      taskService as unknown as { parkedPeerSendsByTarget: Map<string, unknown> }
    ).parkedPeerSendsByTarget;
    for (let spin = 0; spin < 200 && parkedByTarget.has("target"); spin++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Bound (agentMessaging.ts:20-21).
    expect(maxQueued).toBeLessThanOrEqual(MAX_QUEUED_PEER_MESSAGES_PER_TARGET);
  });
});
