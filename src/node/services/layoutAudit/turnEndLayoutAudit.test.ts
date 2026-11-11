import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { LayoutAuditIssue, LayoutAuditReport } from "@/common/types/artifactLayoutAudit";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ArtifactKind } from "@/common/utils/artifactKind";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { getWorkspaceScratchDir } from "@/node/runtime/workspaceScratchDir";
import { Config } from "@/node/config";
import * as artifactsOperations from "@/node/services/artifactsOperations";
import { recordArtifactPublish } from "@/node/services/artifactRecordStore";
import * as checkArtifactLayoutModule from "./checkArtifactLayout";
import { installFakeAgentBrowser } from "./fakeAgentBrowser.testHarness";
import {
  isLayoutAuditDue,
  layoutAuditLastStartedAtMs,
  markLayoutAuditDue,
  startLayoutAudit,
} from "./layoutFingerprints";
import {
  TURN_END_AUDIT_MAX_PAGES,
  hasNewLayoutIssueAtTurnEnd,
  pagesDueForAudit,
  workspaceHasNewLayoutIssueAtTurnEnd,
  type TurnEndArtifactListing,
  type TurnEndLayoutAuditDeps,
} from "./turnEndLayoutAudit";

const STREAM_START = 1_000_000;

const issue = (persistent = false): LayoutAuditIssue => ({
  rule: "clipped-text",
  selector: "div.card > h2",
  viewport: 390,
  axis: "horizontal",
  overflowPx: 12,
  ...(persistent ? { persistent: true as const } : {}),
});

const report = (issues: LayoutAuditIssue[] = []): LayoutAuditReport => ({
  checked: true,
  issues,
  note: "ok",
});

const notChecked = (issues: LayoutAuditIssue[]): LayoutAuditReport => ({
  checked: false,
  notChecked: [{ viewport: 1440, reason: "timeout" }],
  issues,
  note: "partial",
});

const page = (name: string, modifiedMs: number, kind: ArtifactKind = "html") => ({
  path: name,
  kind,
  modifiedMs,
});

const listingOf = (
  entries: TurnEndArtifactListing["entries"],
  publishedPaths = entries.map((entry) => entry.path)
): TurnEndArtifactListing => ({ entries, publishedPaths });

const never = () => undefined;

/** The pages the modified-time rule alone picks: no earlier turn end left one due. */
const changedPages = (
  listing: TurnEndArtifactListing,
  streamStartedAtMs: number,
  lastAuditStartedAtMs: (relPath: string) => number | undefined
) => pagesDueForAudit(listing, streamStartedAtMs, lastAuditStartedAtMs, () => false);

describe("pagesDueForAudit", () => {
  test("a published HTML page modified in this stream, with no audit of its own, is audited", () => {
    const pages = changedPages(listingOf([page("a.html", STREAM_START + 1)]), STREAM_START, never);
    expect(pages).toEqual(["a.html"]);
  });

  test("a page that did not change in this stream is not audited, so a restart audits nothing old", () => {
    expect(
      changedPages(listingOf([page("a.html", STREAM_START - 1)]), STREAM_START, never)
    ).toEqual([]);
  });

  test("a file with no publish record, and a published file that is not HTML, are not audited", () => {
    const entries = [
      page("scratch.html", STREAM_START + 1),
      page("notes.md", STREAM_START + 1, "markdown"),
    ];
    expect(changedPages(listingOf(entries, ["notes.md"]), STREAM_START, never)).toEqual([]);
  });

  test("a page whose last audit ran after its last write is not audited again", () => {
    const audited = new Map([["a.html", STREAM_START + 100]]);
    const listing = listingOf([
      page("a.html", STREAM_START + 99),
      page("b.html", STREAM_START + 99),
    ]);
    expect(changedPages(listing, STREAM_START, (p) => audited.get(p))).toEqual(["b.html"]);
  });

  test("a write at the very start of the last audit still counts as a change", () => {
    const listing = listingOf([page("a.html", STREAM_START + 100)]);
    expect(changedPages(listing, STREAM_START, () => STREAM_START + 100)).toEqual(["a.html"]);
  });

  test("the last audit replaces the stream start as the bar, even when it is older than the stream", () => {
    const listing = listingOf([page("a.html", STREAM_START - 50)]);
    expect(changedPages(listing, STREAM_START, () => STREAM_START - 100)).toEqual(["a.html"]);
    expect(changedPages(listing, STREAM_START, () => STREAM_START - 10)).toEqual([]);
  });

  test("the pages come newest first", () => {
    const entries = [2, 4, 1, 3].map((n) => page(`p${n}.html`, STREAM_START + n));
    expect(changedPages(listingOf(entries), STREAM_START, never)).toEqual([
      "p4.html",
      "p3.html",
      "p2.html",
      "p1.html",
    ]);
  });

  test("a page an earlier turn end left due is picked again, although it did not change in this stream", () => {
    // After a restart the page has no audit time, so the bar is the start of the ending stream,
    // which has moved past the write: only the due mark keeps the page.
    const listing = listingOf([
      page("a.html", STREAM_START - 900),
      page("b.html", STREAM_START - 900),
    ]);
    expect(pagesDueForAudit(listing, STREAM_START, never, (p) => p === "a.html")).toEqual([
      "a.html",
    ]);
  });

  test("a due mark does not pick a file that is not a published HTML page", () => {
    const entries = [
      page("scratch.html", STREAM_START + 1),
      page("notes.md", STREAM_START + 1, "markdown"),
    ];
    expect(
      pagesDueForAudit(listingOf(entries, ["notes.md"]), STREAM_START, never, () => true)
    ).toEqual([]);
  });
});

describe("hasNewLayoutIssueAtTurnEnd", () => {
  const controller = new AbortController();
  const changed = listingOf([page("a.html", STREAM_START + 1)]);

  function deps(overrides: Partial<TurnEndLayoutAuditDeps> = {}): TurnEndLayoutAuditDeps {
    return {
      streamStartedAtMs: STREAM_START,
      abortSignal: controller.signal,
      list: () => Promise.resolve(changed),
      lastAuditStartedAtMs: never,
      isDue: () => false,
      markDue: () => undefined,
      audit: () => Promise.resolve(report()),
      ...overrides,
    };
  }

  test("a new issue on a changed page is a finding, and the audit gets the page and the signal", async () => {
    const calls: Array<[string, AbortSignal]> = [];
    const found = await hasNewLayoutIssueAtTurnEnd(
      deps({
        audit: (relPath, signal) => {
          calls.push([relPath, signal]);
          return Promise.resolve(report([issue()]));
        },
      })
    );
    expect(found).toBe(true);
    expect(calls.map(([relPath]) => relPath)).toEqual(["a.html"]);
    // Identity, not structure: two AbortSignals match each other structurally.
    expect(calls[0]?.[1]).toBe(controller.signal);
  });

  test.each([
    { name: "a clean page", audited: report() },
    { name: "an issue the agent was already shown", audited: report([issue(true)]) },
    { name: "a page with a width that was not checked", audited: notChecked([]) },
    {
      name: "a page with a width that was not checked and an issue the agent was shown",
      audited: notChecked([issue(true)]),
    },
    { name: "a page with nothing to report", audited: undefined },
  ])("$name is not a finding", async ({ audited }) => {
    expect(await hasNewLayoutIssueAtTurnEnd(deps({ audit: () => Promise.resolve(audited) }))).toBe(
      false
    );
  });

  test("a new issue at a width that completed is a finding, even when another width was not checked", async () => {
    expect(
      await hasNewLayoutIssueAtTurnEnd(
        deps({ audit: () => Promise.resolve(notChecked([issue()])) })
      )
    ).toBe(true);
  });

  test("one page with a new issue is enough, next to a clean page and a shown one", async () => {
    const audits: Record<string, LayoutAuditReport> = {
      "a.html": report(),
      "b.html": report([issue(true)]),
      "c.html": report([issue(true), issue()]),
    };
    const found = await hasNewLayoutIssueAtTurnEnd(
      deps({
        list: () =>
          Promise.resolve(listingOf(Object.keys(audits).map((n) => page(n, STREAM_START + 1)))),
        audit: (relPath) => Promise.resolve(audits[relPath]),
      })
    );
    expect(found).toBe(true);
  });

  test("no changed page means no audit", async () => {
    let audits = 0;
    const found = await hasNewLayoutIssueAtTurnEnd(
      deps({
        list: () => Promise.resolve(listingOf([page("a.html", STREAM_START - 1)])),
        audit: () => {
          audits++;
          return Promise.resolve(report([issue()]));
        },
      })
    );
    expect([found, audits]).toEqual([false, 0]);
  });

  test("the pages of one turn end are audited at the same time, three at most, and every picked page is left due", async () => {
    const started: string[] = [];
    const due: string[] = [];
    const release = Promise.withResolvers<void>();
    expect(TURN_END_AUDIT_MAX_PAGES).toBe(3);
    const run = hasNewLayoutIssueAtTurnEnd(
      deps({
        list: () =>
          Promise.resolve(listingOf([1, 2, 3, 4].map((n) => page(`p${n}.html`, STREAM_START + n)))),
        markDue: (relPath) => due.push(relPath),
        audit: async (relPath) => {
          started.push(relPath);
          await release.promise;
          return report([issue()]);
        },
      })
    );
    // Every audit has started while none has finished: a serial run would show one.
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["p4.html", "p3.html", "p2.html"]);
    // The page past the cap is due as well: a later turn end audits it, changed or not. So is a
    // page whose audit a Stop ends: the marks are set before the first audit starts.
    expect(due).toEqual(["p4.html", "p3.html", "p2.html", "p1.html"]);
    release.resolve();
    expect(await run).toBe(true);
  });

  test("an audit that fails is no finding, and the other pages still count", async () => {
    const found = await hasNewLayoutIssueAtTurnEnd(
      deps({
        list: () =>
          Promise.resolve(
            listingOf([page("a.html", STREAM_START + 2), page("b.html", STREAM_START + 1)])
          ),
        audit: (relPath) =>
          relPath === "a.html"
            ? Promise.reject(new Error("browser died"))
            : Promise.resolve(report([issue()])),
      })
    );
    expect(found).toBe(true);
  });

  test("a listing that fails is no finding and audits nothing", async () => {
    let audits = 0;
    const found = await hasNewLayoutIssueAtTurnEnd(
      deps({
        list: () => Promise.reject(new Error("runtime unreachable")),
        audit: () => {
          audits++;
          return Promise.resolve(report([issue()]));
        },
      })
    );
    expect([found, audits]).toEqual([false, 0]);
  });

  test("a Stop before the audit lists nothing and finds nothing", async () => {
    let listed = 0;
    const found = await hasNewLayoutIssueAtTurnEnd(
      deps({
        abortSignal: AbortSignal.abort(),
        list: () => {
          listed++;
          return Promise.resolve(changed);
        },
      })
    );
    expect([found, listed]).toEqual([false, 0]);
  });

  test("a Stop while the audit runs finds nothing, even when the page has an issue", async () => {
    const stop = new AbortController();
    const found = await hasNewLayoutIssueAtTurnEnd(
      deps({
        abortSignal: stop.signal,
        audit: () => {
          stop.abort();
          return Promise.resolve(report([issue()]));
        },
      })
    );
    expect(found).toBe(false);
  });
});

describe("workspaceHasNewLayoutIssueAtTurnEnd", () => {
  const workspaceId = "ws-turn-end-audit";
  let tempDir: string;
  let config: Config;
  let artifactsDir: string;
  let sessionDir: string;
  let metadata: FrontendWorkspaceMetadata;
  let audits: Array<Parameters<typeof checkArtifactLayoutModule.checkArtifactLayout>[0]>;
  let auditReport: LayoutAuditReport | undefined;
  let probe: ReturnType<
    typeof spyOn<typeof artifactsOperations, "getWorkspaceArtifactCapabilities">
  >;
  const runtime = new LocalRuntime("/tmp");

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "turn-end-layout-audit-"));
    config = new Config(tempDir);
    sessionDir = path.join(config.sessionsDir, workspaceId);
    artifactsDir = path.join(getWorkspaceScratchDir(config.sessionsDir, workspaceId), "artifacts");
    await fs.mkdir(artifactsDir, { recursive: true });
    metadata = {
      id: workspaceId,
      name: workspaceId,
      projectName: "project",
      projectPath: tempDir,
      namedWorkspacePath: tempDir,
      runtimeConfig: { type: "local" },
    };
    audits = [];
    auditReport = report([issue()]);
    spyOn(checkArtifactLayoutModule, "checkArtifactLayout").mockImplementation((input) => {
      audits.push(input);
      return Promise.resolve(auditReport);
    });
    probe = spyOn(artifactsOperations, "getWorkspaceArtifactCapabilities").mockResolvedValue({
      agentBrowserAvailable: true,
    });
  });

  afterEach(async () => {
    mock.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const publishedPage = async (name: string) => {
    await fs.writeFile(path.join(artifactsDir, name), "<h1>hi</h1>");
    await recordArtifactPublish({ sessionDir, relPath: name, title: name });
  };

  const run = (overrides: { streamStartedAtMs?: number; abortSignal?: AbortSignal } = {}) =>
    workspaceHasNewLayoutIssueAtTurnEnd({
      workspaceId,
      metadata,
      config,
      runtime,
      cwd: tempDir,
      streamStartedAtMs: Date.now() - 60_000,
      abortSignal: new AbortController().signal,
      ...overrides,
    });

  test("audits a changed published page like a publish does, and leaves the fix-loop memory alone", async () => {
    await publishedPage("report.html");
    const stop = new AbortController();
    expect(await run({ abortSignal: stop.signal })).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      kind: "html",
      relPath: "report.html",
      sessionDir,
      cwd: tempDir,
      remember: false,
      location: { kind: "host", dir: artifactsDir },
    });
    expect(audits[0]?.runtime).toBe(runtime);
    // Identity, not structure: two AbortSignals match each other structurally.
    expect(audits[0]?.abortSignal).toBe(stop.signal);
  });

  test("does not audit a page a publish audited after its last write", async () => {
    await publishedPage("report.html");
    const { mtimeMs } = await fs.stat(path.join(artifactsDir, "report.html"));
    startLayoutAudit(sessionDir, "report.html", mtimeMs + 1).finish(
      () => ({ report: undefined, next: {} }),
      false
    );
    expect(layoutAuditLastStartedAtMs(sessionDir, "report.html")).toBe(mtimeMs + 1);
    expect(await run()).toBe(false);
    expect(audits).toEqual([]);
  });

  test("a page whose issue the agent was not shown is audited at the next turn end too, although it did not change in that stream", async () => {
    // The mocked audit settles nothing, like a turn-end audit that found a new issue. The page
    // has no audit time of its own (as after a restart), so only its due mark keeps it.
    await publishedPage("report.html");
    expect(await run()).toBe(true);
    expect(await run({ streamStartedAtMs: Date.now() + 60_000 })).toBe(true);
    expect(audits).toHaveLength(2);
  });

  test("a side chat is not audited", async () => {
    await publishedPage("report.html");
    metadata = { ...metadata, sideChatParentWorkspaceId: "ws-main" };
    expect(await run()).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  test("lists and audits nothing when the Artifacts location is unavailable", async () => {
    spyOn(artifactsOperations, "resolveArtifactsLocation").mockResolvedValue({
      kind: "unavailable",
      reason: "no scratch dir",
    });
    await publishedPage("report.html");
    expect(await run()).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  test("looks nothing up when nothing is published", async () => {
    await fs.writeFile(path.join(artifactsDir, "scratch.html"), "<h1>hi</h1>");
    const location = spyOn(artifactsOperations, "resolveArtifactsLocation");
    const list = spyOn(artifactsOperations, "listArtifactsAtLocation");
    expect(await run()).toBe(false);
    expect([location, probe, list].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    expect(audits).toEqual([]);
  });

  test("lists and audits nothing when the probe says agent-browser is missing", async () => {
    probe.mockResolvedValue({ agentBrowserAvailable: false });
    const list = spyOn(artifactsOperations, "listArtifactsAtLocation");
    await publishedPage("report.html");
    expect(await run()).toBe(false);
    expect(list).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  test("an unknown probe answer still audits: the audit reports what it could not check", async () => {
    probe.mockResolvedValue({ agentBrowserAvailable: null });
    await publishedPage("report.html");
    expect(await run()).toBe(true);
  });
});

describe("a turn-end audit through the real layout audit", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "turn-end-real-audit-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Every audit runs a fake CLI through a dozen shells, and a loaded host is slow.
  test("tells about an issue no publish listed at every turn end, adds nothing to the fix-loop memory, and goes silent once a publish listed it", async () => {
    const artifactsDir = path.join(tempDir, "scratch", "artifacts");
    await fs.mkdir(artifactsDir, { recursive: true });
    await installFakeAgentBrowser(tempDir, {
      eval: {
        390: {
          kind: "pass",
          findings: [
            { rule: "clipped-text", selector: "div.card > h2", axis: "horizontal", overflowPx: 12 },
          ],
        },
      },
    });
    const input = {
      kind: "html",
      runtime: new LocalRuntime(tempDir),
      cwd: tempDir,
      trusted: true,
      location: { kind: "host", dir: artifactsDir },
      relPath: "chart.html",
      sessionDir: path.join(tempDir, "session"),
      budgetMs: 20_000,
    } as const;
    let modifiedMs = Date.now();
    let turnEndAudits = 0;
    // Each turn end belongs to a later stream, as in a real chat.
    const atTurnEnd = (streamStartedAtMs = Date.now()) =>
      hasNewLayoutIssueAtTurnEnd({
        streamStartedAtMs,
        abortSignal: new AbortController().signal,
        list: () => Promise.resolve(listingOf([page("chart.html", modifiedMs)])),
        lastAuditStartedAtMs: (relPath) => layoutAuditLastStartedAtMs(input.sessionDir, relPath),
        isDue: (relPath) => isLayoutAuditDue(input.sessionDir, relPath),
        markDue: (relPath) => markLayoutAuditDue(input.sessionDir, relPath),
        audit: (relPath, abortSignal) => {
          turnEndAudits += 1;
          return checkArtifactLayoutModule.checkArtifactLayout({
            ...input,
            relPath,
            abortSignal,
            remember: false,
          });
        },
      });

    // The page has no audit of its own yet (as after a restart) and changed in this stream.
    expect(await atTurnEnd(modifiedMs - 1)).toBe(true);
    // New input or a Stop can win over the continuation, so the agent may not have been told:
    // the unchanged page is audited, and found, again, in a stream that started after the write.
    expect(await atTurnEnd()).toBe(true);
    // The agent has been shown nothing: the publish lists the issue as new, and commits it.
    expect(
      (await checkArtifactLayoutModule.checkArtifactLayout(input))?.issues[0]
    ).not.toHaveProperty("persistent");
    // A publish audited the page after its last write: the next turn end does not audit it.
    expect(await atTurnEnd()).toBe(false);
    expect(turnEndAudits).toBe(2);
    // The page changes and keeps the issue the publish listed: audited, with nothing new to say.
    modifiedMs = Date.now();
    expect(await atTurnEnd(modifiedMs - 1)).toBe(false);
    expect(turnEndAudits).toBe(3);
    expect(isLayoutAuditDue(input.sessionDir, "chart.html")).toBe(false);
  }, 300_000);
});
