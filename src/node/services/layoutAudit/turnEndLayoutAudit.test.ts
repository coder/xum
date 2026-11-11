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
import { layoutAuditLastStartedAtMs, startLayoutAudit } from "./layoutFingerprints";
import {
  TURN_END_AUDIT_MAX_PAGES,
  hasNewLayoutIssueAtTurnEnd,
  pagesDueForAudit,
  workspaceHasNewLayoutIssueAtTurnEnd,
  type TurnEndArtifactListing,
  type TurnEndLayoutAuditDeps,
} from "./turnEndLayoutAudit";

// The latest publish of every page in the unit tests below.
const PUBLISHED_AT = 1_000_000;

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
  publishedPaths = entries.map((entry) => entry.path),
  publishedAtMs = PUBLISHED_AT
): TurnEndArtifactListing => ({
  entries,
  published: publishedPaths.map((relPath) => ({ path: relPath, publishedAtMs })),
});

const never = () => undefined;

describe("pagesDueForAudit", () => {
  test("a published HTML page modified after its publish, with no audit of its own, is due", () => {
    expect(pagesDueForAudit(listingOf([page("a.html", PUBLISHED_AT + 1)]), never)).toEqual([
      "a.html",
    ]);
  });

  test("a page that did not change since its publish is not due, so a restart audits nothing the publish checked", () => {
    expect(pagesDueForAudit(listingOf([page("a.html", PUBLISHED_AT - 1)]), never)).toEqual([]);
  });

  test("a write at the very time of the publish still counts as a change", () => {
    expect(pagesDueForAudit(listingOf([page("a.html", PUBLISHED_AT)]), never)).toEqual(["a.html"]);
  });

  test("each page has its own publish time", () => {
    const listing: TurnEndArtifactListing = {
      entries: [page("old.html", PUBLISHED_AT + 5), page("new.html", PUBLISHED_AT + 5)],
      published: [
        { path: "old.html", publishedAtMs: PUBLISHED_AT },
        { path: "new.html", publishedAtMs: PUBLISHED_AT + 10 },
      ],
    };
    expect(pagesDueForAudit(listing, never)).toEqual(["old.html"]);
  });

  test("a file with no publish record, and a published file that is not HTML, are not due", () => {
    const entries = [
      page("scratch.html", PUBLISHED_AT + 1),
      page("notes.md", PUBLISHED_AT + 1, "markdown"),
    ];
    expect(pagesDueForAudit(listingOf(entries, ["notes.md"]), never)).toEqual([]);
  });

  test("an audit time does not make an unpublished page due", () => {
    const listing = listingOf([page("scratch.html", PUBLISHED_AT + 1)], []);
    expect(pagesDueForAudit(listing, () => PUBLISHED_AT)).toEqual([]);
  });

  test("a page whose last audit ran after its last write is not due again", () => {
    const audited = new Map([["a.html", PUBLISHED_AT + 100]]);
    const listing = listingOf([
      page("a.html", PUBLISHED_AT + 99),
      page("b.html", PUBLISHED_AT + 99),
    ]);
    expect(pagesDueForAudit(listing, (p) => audited.get(p))).toEqual(["b.html"]);
  });

  test("a write at the very start of the last audit still counts as a change", () => {
    const listing = listingOf([page("a.html", PUBLISHED_AT + 100)]);
    expect(pagesDueForAudit(listing, () => PUBLISHED_AT + 100)).toEqual(["a.html"]);
  });

  test("the last audit replaces the publish time as the bar, even when it is older than the publish", () => {
    // An edit, then a publish whose own audit a Stop cancelled: the page keeps the older audit's bar.
    const listing = listingOf([page("a.html", PUBLISHED_AT - 50)]);
    expect(pagesDueForAudit(listing, () => PUBLISHED_AT - 100)).toEqual(["a.html"]);
    expect(pagesDueForAudit(listing, () => PUBLISHED_AT - 10)).toEqual([]);
  });

  test("the pages come newest first", () => {
    const entries = [2, 4, 1, 3].map((n) => page(`p${n}.html`, PUBLISHED_AT + n));
    expect(pagesDueForAudit(listingOf(entries), never)).toEqual([
      "p4.html",
      "p3.html",
      "p2.html",
      "p1.html",
    ]);
  });
});

describe("hasNewLayoutIssueAtTurnEnd", () => {
  const controller = new AbortController();
  const changed = listingOf([page("a.html", PUBLISHED_AT + 1)]);

  function deps(overrides: Partial<TurnEndLayoutAuditDeps> = {}): TurnEndLayoutAuditDeps {
    return {
      abortSignal: controller.signal,
      list: () => Promise.resolve(changed),
      lastAuditStartedAtMs: never,
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
          Promise.resolve(listingOf(Object.keys(audits).map((n) => page(n, PUBLISHED_AT + 1)))),
        audit: (relPath) => Promise.resolve(audits[relPath]),
      })
    );
    expect(found).toBe(true);
  });

  test("no due page means no audit", async () => {
    let audits = 0;
    const found = await hasNewLayoutIssueAtTurnEnd(
      deps({
        list: () => Promise.resolve(listingOf([page("a.html", PUBLISHED_AT - 1)])),
        audit: () => {
          audits++;
          return Promise.resolve(report([issue()]));
        },
      })
    );
    expect([found, audits]).toEqual([false, 0]);
  });

  test("the pages of one turn end are audited at the same time, three at most", async () => {
    const started: string[] = [];
    const release = Promise.withResolvers<void>();
    expect(TURN_END_AUDIT_MAX_PAGES).toBe(3);
    const run = hasNewLayoutIssueAtTurnEnd(
      deps({
        list: () =>
          Promise.resolve(listingOf([1, 2, 3, 4].map((n) => page(`p${n}.html`, PUBLISHED_AT + n)))),
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
    release.resolve();
    expect(await run).toBe(true);
  });

  // The audits of these tests settle a page the way a real audit does: they record their start.
  describe("across turn ends", () => {
    const pages = [1, 2, 3, 4].map((n) => page(`p${n}.html`, PUBLISHED_AT + n));
    let settledAt: Map<string, number>;
    let audited: string[];

    beforeEach(() => {
      settledAt = new Map();
      audited = [];
    });

    const turnEnd = (settles: (relPath: string) => boolean = () => true) =>
      hasNewLayoutIssueAtTurnEnd(
        deps({
          list: () => Promise.resolve(listingOf(pages)),
          lastAuditStartedAtMs: (relPath) => settledAt.get(relPath),
          audit: (relPath) => {
            audited.push(relPath);
            if (settles(relPath)) settledAt.set(relPath, PUBLISHED_AT + 100);
            return Promise.resolve(report());
          },
        })
      );

    test("the page past the cap is audited at a later turn end, once the newer pages are settled", async () => {
      await turnEnd();
      expect(audited).toEqual(["p4.html", "p3.html", "p2.html"]);
      await turnEnd();
      expect(audited.slice(3)).toEqual(["p1.html"]);
      await turnEnd();
      expect(audited).toHaveLength(4);
    });

    test("a page whose audit did not settle it, as after a Stop, a failure or an issue the agent was not shown, is audited again, changed or not", async () => {
      await turnEnd((relPath) => relPath !== "p3.html");
      expect(audited).toEqual(["p4.html", "p3.html", "p2.html"]);
      await turnEnd();
      expect(audited.slice(3)).toEqual(["p3.html", "p1.html"]);
    });
  });

  test("an audit that fails is no finding, and the other pages still count", async () => {
    const found = await hasNewLayoutIssueAtTurnEnd(
      deps({
        list: () =>
          Promise.resolve(
            listingOf([page("a.html", PUBLISHED_AT + 2), page("b.html", PUBLISHED_AT + 1)])
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
  });

  afterEach(async () => {
    mock.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** Writes and publishes a page. By default it was edited after its publish, a minute ago. */
  const publishedPage = async (
    name: string,
    publishedAtMs = Date.now() - 60_000,
    modifiedMs = publishedAtMs + 1_000
  ) => {
    const file = path.join(artifactsDir, name);
    await fs.writeFile(file, "<h1>hi</h1>");
    await fs.utimes(file, modifiedMs / 1000, modifiedMs / 1000);
    await recordArtifactPublish({ sessionDir, relPath: name, title: name, nowMs: publishedAtMs });
  };

  const run = (overrides: { abortSignal?: AbortSignal } = {}) =>
    workspaceHasNewLayoutIssueAtTurnEnd({
      workspaceId,
      metadata,
      config,
      runtime,
      cwd: tempDir,
      abortSignal: new AbortController().signal,
      ...overrides,
    });

  test("audits a published page edited after its publish like a publish does, and leaves the fix-loop memory alone", async () => {
    // Xum holds no audit of the page, as after a restart: its latest publish is the bar.
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

  test("does not audit a page that has not changed since its publish", async () => {
    const publishedAtMs = Date.now() - 60_000;
    await publishedPage("report.html", publishedAtMs, publishedAtMs - 1_000);
    expect(await run()).toBe(false);
    expect(audits).toEqual([]);
  });

  test("does not audit a page an audit settled after its last write", async () => {
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

  test("a page whose issue the agent was not shown is audited at the next turn end too, although it did not change since", async () => {
    // The mocked audit settles nothing, like a turn-end audit that found a new issue: the bar
    // stays where it was, and the rule alone keeps the page due.
    await publishedPage("report.html");
    expect(await run()).toBe(true);
    expect(await run()).toBe(true);
    expect(audits).toHaveLength(2);
  });

  test("a side chat is not audited", async () => {
    await publishedPage("report.html");
    metadata = { ...metadata, sideChatParentWorkspaceId: "ws-main" };
    expect(await run()).toBe(false);
    expect(audits).toEqual([]);
  });

  test("lists and audits nothing when the Artifacts location is unavailable", async () => {
    spyOn(artifactsOperations, "resolveArtifactsLocation").mockResolvedValue({
      kind: "unavailable",
      reason: "no scratch dir",
    });
    await publishedPage("report.html");
    expect(await run()).toBe(false);
    expect(audits).toEqual([]);
  });

  test("looks nothing up when nothing is published", async () => {
    await fs.writeFile(path.join(artifactsDir, "scratch.html"), "<h1>hi</h1>");
    const location = spyOn(artifactsOperations, "resolveArtifactsLocation");
    const list = spyOn(artifactsOperations, "listArtifactsAtLocation");
    expect(await run()).toBe(false);
    expect([location, list].map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
    expect(audits).toEqual([]);
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

  async function setup(script: Parameters<typeof installFakeAgentBrowser>[1]) {
    const artifactsDir = path.join(tempDir, "scratch", "artifacts");
    await fs.mkdir(artifactsDir, { recursive: true });
    await installFakeAgentBrowser(tempDir, script);
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
    // The page was published, then edited: a publish a second before the write, which is a second
    // before now (a write in the very millisecond an audit starts counts as a change).
    const state = { modifiedMs: Date.now() - 1_000, turnEndAudits: 0 };
    const atTurnEnd = (stop = new AbortController(), stopDuringAudit = false) =>
      hasNewLayoutIssueAtTurnEnd({
        abortSignal: stop.signal,
        list: () =>
          Promise.resolve(
            listingOf(
              [page("chart.html", state.modifiedMs)],
              ["chart.html"],
              state.modifiedMs - 1_000
            )
          ),
        lastAuditStartedAtMs: (relPath) => layoutAuditLastStartedAtMs(input.sessionDir, relPath),
        audit: (relPath, abortSignal) => {
          state.turnEndAudits += 1;
          if (stopDuringAudit) stop.abort();
          return checkArtifactLayoutModule.checkArtifactLayout({
            ...input,
            relPath,
            abortSignal,
            remember: false,
          });
        },
      });
    return { input, state, atTurnEnd };
  }

  // Every audit runs a fake CLI through a dozen shells, and a loaded host is slow.
  test("tells about an issue no publish listed at every turn end, adds nothing to the fix-loop memory, and goes silent once a publish listed it", async () => {
    const { input, state, atTurnEnd } = await setup({
      eval: {
        390: {
          kind: "pass",
          findings: [
            { rule: "clipped-text", selector: "div.card > h2", axis: "horizontal", overflowPx: 12 },
          ],
        },
      },
    });

    // The page has no audit of its own yet (as after a restart) and was edited after its publish.
    expect(await atTurnEnd()).toBe(true);
    // New input or a Stop can win over the continuation, so the agent may not have been told:
    // the unchanged page is audited, and found, again.
    expect(await atTurnEnd()).toBe(true);
    // A Stop ends the audit: nothing is reported, and the page is audited again at the next turn end.
    expect(await atTurnEnd(new AbortController(), true)).toBe(false);
    expect(layoutAuditLastStartedAtMs(input.sessionDir, "chart.html")).toBeUndefined();
    expect(await atTurnEnd()).toBe(true);
    expect(state.turnEndAudits).toBe(4);
    // The agent has been shown nothing: the publish lists the issue as new, and commits it.
    expect(
      (await checkArtifactLayoutModule.checkArtifactLayout(input))?.issues[0]
    ).not.toHaveProperty("persistent");
    // A publish audited the page after its last write: the next turn end does not audit it.
    expect(await atTurnEnd()).toBe(false);
    expect(state.turnEndAudits).toBe(4);
    // The page changes and keeps the issue the publish listed: audited, with nothing new to say,
    // and settled by that audit. The write comes right after the publish's audit started.
    state.modifiedMs = (layoutAuditLastStartedAtMs(input.sessionDir, "chart.html") ?? 0) + 1;
    expect(await atTurnEnd()).toBe(false);
    expect(state.turnEndAudits).toBe(5);
    expect(await atTurnEnd()).toBe(false);
    expect(state.turnEndAudits).toBe(5);
  }, 300_000);

  test("a workspace without agent-browser has its due page audited once: the audit reports it could not check, and that settles the page", async () => {
    const { state, atTurnEnd } = await setup({ missing: true });

    expect(await atTurnEnd()).toBe(false);
    expect(await atTurnEnd()).toBe(false);
    expect(state.turnEndAudits).toBe(1);
  }, 120_000);
});
