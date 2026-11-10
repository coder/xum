import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { createMuxMessage } from "@/common/types/message";
import { createTestHistoryService } from "@/node/services/testHistoryService";

import {
  TASK_REPORT_WITHHELD_MESSAGE,
  applyTaskReportProvenance,
  workspaceHistoryCarriesProjectSkillContent,
} from "./taskReportProvenance";

describe("applyTaskReportProvenance", () => {
  const report = {
    reportMarkdown: "The skill says X",
    title: "Findings",
    structuredOutput: { x: 1 },
  };

  it("leaves a clean report alone, stamps a carrying one, withholds it when the turn excludes", () => {
    expect(applyTaskReportProvenance(report, { carries: false, excludes: true })).toBe(report);
    expect(applyTaskReportProvenance(report, { carries: true, excludes: false })).toEqual({
      ...report,
      carriesProjectSkillContent: true,
    });
    const withheld = applyTaskReportProvenance(report, { carries: true, excludes: true });
    expect(withheld.reportMarkdown).toBe(TASK_REPORT_WITHHELD_MESSAGE);
    expect(withheld.title).toBeUndefined();
    expect(withheld.structuredOutput).toBeUndefined();
    expect(withheld.carriesProjectSkillContent).toBeUndefined();
  });
});

describe("workspaceHistoryCarriesProjectSkillContent", () => {
  // The verdict reads the target workspace's real history (the repository's
  // testing contract for HistoryService): rows are appended through the
  // service, and the unreadable case is injected on the real method.
  let history: Awaited<ReturnType<typeof createTestHistoryService>>;
  beforeEach(async () => {
    history = await createTestHistoryService();
  });
  afterEach(async () => {
    await history.cleanup();
  });

  it("fails closed without history access, a workspace, or a readable history", async () => {
    expect(await workspaceHistoryCarriesProjectSkillContent({}, "ws")).toBe(true);
    expect(
      await workspaceHistoryCarriesProjectSkillContent(
        { historyService: history.historyService },
        undefined
      )
    ).toBe(true);
    const read = spyOn(history.historyService, "getHistoryFromLatestBoundary");
    read.mockResolvedValueOnce({ success: false, error: "gone" });
    expect(
      await workspaceHistoryCarriesProjectSkillContent(
        { historyService: history.historyService },
        "ws-unreadable"
      )
    ).toBe(true);
    read.mockRejectedValueOnce(new Error("disk gone"));
    expect(
      await workspaceHistoryCarriesProjectSkillContent(
        { historyService: history.historyService },
        "ws-unreadable"
      )
    ).toBe(true);
    read.mockRestore();
  });

  it("classifies the rows since the latest context boundary", async () => {
    const config = { historyService: history.historyService };
    expect(await workspaceHistoryCarriesProjectSkillContent(config, "ws-empty")).toBe(false);

    await history.historyService.appendToHistory(
      "ws-clean",
      createMuxMessage("u1", "user", "Map the tooling", { timestamp: 1 })
    );
    await history.historyService.appendToHistory(
      "ws-clean",
      createMuxMessage("a1", "assistant", "Mapped it", { timestamp: 2 })
    );
    expect(await workspaceHistoryCarriesProjectSkillContent(config, "ws-clean")).toBe(false);

    await history.historyService.appendToHistory(
      "ws-carrying",
      createMuxMessage("snap", "user", "PROJECT SKILL BODY", {
        timestamp: 1,
        synthetic: true,
        agentSkillSnapshot: { skillName: "done", scope: "project", sha256: "s" },
      })
    );
    expect(await workspaceHistoryCarriesProjectSkillContent(config, "ws-carrying")).toBe(true);

    // A summary row stamped as carrying is the content's only trace once the
    // rows it summarized are gone: the verdict follows the stamp.
    await history.historyService.appendToHistory(
      "ws-summary",
      createMuxMessage("summary-tainted", "assistant", "Summary quoting the skill", {
        timestamp: 3,
        compacted: "idle",
        carriesProjectSkillContent: true,
      })
    );
    expect(await workspaceHistoryCarriesProjectSkillContent(config, "ws-summary")).toBe(true);
  });
});
