import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  createAgentSessionHarness,
  createStartedTurnHandle,
  type AgentSessionHarness,
} from "./agentSession.testHarness";
import { Ok } from "@/common/types/result";
import assert from "@/common/utils/assert";
import type { ContinuousCompactor } from "./continuousCompactor";

const harnesses: AgentSessionHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.reverse()) await h.session.dispose();
  for (const h of harnesses) await h.cleanup();
  harnesses.length = 0;
  mock.restore();
});

test("sessions sharing app dependencies keep strategy state and resets workspace-local", async () => {
  const continuous = await createAgentSessionHarness({ workspaceId: "continuous" });
  harnesses.push(continuous);
  const budget = await createAgentSessionHarness({
    workspaceId: "budget",
    config: continuous.config,
    historyService: continuous.historyService,
    aiService: continuous.aiService,
    aiEmitter: continuous.aiEmitter,
  });
  harnesses.push(budget);
  spyOn(continuous.aiService, "isExperimentEnabled").mockImplementation(
    (id) => id === EXPERIMENT_IDS.TOKEN_BUDGET
  );
  // The default single-session harness closes handles with its first session's signal.
  // Shared AI dependencies must instead retain each workspace's physical stream lifetime.
  const owners = new Map([
    ["continuous", continuous],
    ["budget", budget],
  ]);
  const stream = spyOn(continuous.aiService, "streamMessage").mockImplementation((request) => {
    const owner = owners.get(request.workspaceId);
    assert(owner, "Every request must have a session owner");
    return Promise.resolve(
      Ok(createStartedTurnHandle(owner.session.closingSignal, `assistant-${request.workspaceId}`))
    );
  });
  const continuousState = continuous.session as unknown as {
    continuousCompactor: ContinuousCompactor;
  };
  const budgetState = budget.session as unknown as {
    contextBudgetGeneration: number;
    contextBudgetWarningClaimed: boolean;
  };
  continuous.session.setAutoCompactionThreshold(0.6);
  budget.session.setAutoCompactionThreshold(0.7);
  const model = "openai:gpt-4o";
  expect(
    (
      await continuous.session.sendMessage("Continuous workspace task", {
        model,
        agentId: "exec",
        experiments: { continuousCompaction: true },
      })
    ).success
  ).toBe(true);
  expect(
    (
      await budget.session.sendMessage("Budget workspace task", {
        model,
        agentId: "exec",
        experiments: { continuousCompaction: false },
      })
    ).success
  ).toBe(true);
  expect(stream).toHaveBeenCalledTimes(2);
  expect(stream.mock.calls[0][0].onStepSettled).toBeUndefined();
  const settle = stream.mock.calls[1][0].onStepSettled;
  expect(settle).toBeDefined();
  expect(
    await settle?.({
      model,
      usage: { inputTokens: 85_000, outputTokens: 10, totalTokens: 85_010 },
      toolResultChars: 0,
      imageParts: 0,
      sessionHistoryAvailable: true,
      memoryWritable: true,
    })
  ).toBe("warn");
  expect(budgetState.contextBudgetWarningClaimed).toBe(true);

  const budgetGeneration = budgetState.contextBudgetGeneration;
  continuous.session.setAutoCompactionThreshold(0.8);
  expect(budgetState.contextBudgetGeneration).toBe(budgetGeneration);
  expect(budgetState.contextBudgetWarningClaimed).toBe(true);
  const continuousGeneration: unknown = Reflect.get(
    continuousState.continuousCompactor,
    "generation"
  );
  assert(typeof continuousGeneration === "number", "The compactor must have a generation fence");
  expect((await budget.session.interruptStream({ abandonPartial: true })).success).toBe(true);
  expect(budgetState.contextBudgetWarningClaimed).toBe(false);
  expect(Reflect.get(continuousState.continuousCompactor, "generation")).toBe(continuousGeneration);

  for (const id of ["continuous", "budget"]) {
    const history = await continuous.historyService.getHistoryFromLatestBoundary(id);
    expect(history.success).toBe(true);
    if (!history.success) throw new Error(history.error);
    expect(
      history.data.some((row) =>
        row.parts.some(
          (part) =>
            part.type === "text" &&
            part.text ===
              (id === "continuous" ? "Continuous workspace task" : "Budget workspace task")
        )
      )
    ).toBe(true);
    expect(
      history.data.some((row) =>
        row.parts.some(
          (part) =>
            part.type === "text" &&
            part.text ===
              (id === "continuous" ? "Budget workspace task" : "Continuous workspace task")
        )
      )
    ).toBe(false);
  }
});
