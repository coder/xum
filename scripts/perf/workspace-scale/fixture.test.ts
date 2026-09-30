import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorkspaceArchived } from "../../../src/common/utils/archive";
import { buildFixture, generateFixture, type FixtureOptions } from "./generate-fixture";
import { copyFixture, readFixture, summarize } from "./common";
import { parseStartup, parseHousekeepingSettled, runLaunches } from "./run-server-bench";

const options: FixtureOptions = {
  workspaces: 1801,
  projects: 41,
  archived: 0.7,
  profile: "realistic",
  seed: 42,
};

test("fixture distribution is deterministic, schema-valid, and has bounded realistic blobs", () => {
  const config = buildFixture("/tmp/fixture", options);
  expect(config).toEqual(buildFixture("/tmp/fixture", options));
  expect(config).not.toEqual(buildFixture("/tmp/fixture", { ...options, seed: 43 }));
  const projects = config.projects ?? [];
  const workspaces = projects.flatMap(([, project]) => project.workspaces);
  expect(projects).toHaveLength(41);
  expect(workspaces).toHaveLength(1801);
  expect(new Set(workspaces.map((w) => w.id)).size).toBe(1801);
  const archived = workspaces.filter((w) => isWorkspaceArchived(w.archivedAt, w.unarchivedAt));
  expect(archived).toHaveLength(Math.round(1801 * 0.7));
  expect(workspaces.every((w) => /^[a-f0-9]{10}$/.test(w.id ?? ""))).toBe(true);
  const fraction = (predicate: (w: (typeof workspaces)[number]) => boolean) =>
    workspaces.filter(predicate).length / workspaces.length;
  expect(fraction((w) => !!w.aiSettingsByAgent)).toBeGreaterThan(0.97);
  expect(fraction((w) => !!w.taskModelString)).toBeGreaterThan(0.3);
  expect(fraction((w) => !!w.taskModelString)).toBeLessThan(0.4);
  expect(fraction((w) => !!w.parentWorkspaceId)).toBeGreaterThan(0.35);
  expect(fraction((w) => !!w.parentWorkspaceId)).toBeLessThan(0.45);
  expect(fraction((w) => !!w.taskLaunchError)).toBeGreaterThan(0.025);
  expect(fraction((w) => !!w.taskLaunchError)).toBeLessThan(0.06);
  expect(
    archived.filter((w) => w.worktreeArchiveSnapshot).length / archived.length
  ).toBeGreaterThan(0.3);
  for (const [, project] of projects) {
    for (const workspace of project.workspaces) {
      if (workspace.parentWorkspaceId)
        expect(
          project.workspaces.some(
            (parent) => parent.id === workspace.parentWorkspaceId && !parent.parentWorkspaceId
          )
        ).toBe(true);
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(config, null, 2));
  expect(bytes).toBeGreaterThan(2_500_000);
  expect(bytes).toBeLessThan(3_500_000);
});

test("minimal fixture omits blobs and endpoints honor zero/all archived", () => {
  for (const archived of [0, 1]) {
    const config = buildFixture("/tmp/minimal", {
      ...options,
      workspaces: 12,
      projects: 3,
      profile: "minimal",
      archived,
    });
    const workspaces = (config.projects ?? []).flatMap(([, project]) => project.workspaces);
    expect(
      workspaces.filter((w) => isWorkspaceArchived(w.archivedAt, w.unarchivedAt))
    ).toHaveLength(archived * 12);
    expect(
      workspaces.every(
        (w) =>
          !w.aiSettingsByAgent &&
          !w.taskLaunchError &&
          !w.parentWorkspaceId &&
          !w.worktreeArchiveSnapshot
      )
    ).toBe(true);
  }
});

test("isolated copies preserve empty sessions and only active checkouts; existing roots are untouched", async () => {
  const container = await mkdtemp(join(tmpdir(), "xum-fixture-test-"));
  const root = join(container, "fixture");
  try {
    await generateFixture(root, { ...options, workspaces: 12, projects: 3 });
    const pristine = await readFile(join(root, "config.json"), "utf8");
    const error: unknown = await generateFixture(root, options).catch(
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(Error);
    expect(await readFile(join(root, "config.json"), "utf8")).toBe(pristine);
    await using copy = await copyFixture(root);
    const fixture = await readFixture(copy.root);
    expect(fixture.source.includes(root)).toBe(false);
    for (const workspace of fixture.workspaces) {
      expect(workspace.path.startsWith(copy.root + "/")).toBe(true);
      const exists = await access(workspace.path).then(
        () => true,
        () => false
      );
      expect(exists).toBe(!isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt));
      expect(await readdir(join(copy.root, "sessions", workspace.id!))).toEqual([]);
    }
    await writeFile(join(copy.root, "config.json"), "changed");
    expect(await readFile(join(root, "config.json"), "utf8")).toBe(pristine);
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

test("launches retain artifacts sequentially within each fresh repetition", async () => {
  const container = await mkdtemp(join(tmpdir(), "xum-restart-test-"));
  const template = join(container, "fixture");
  const roots: string[] = [];
  try {
    await generateFixture(template, { ...options, workspaces: 3, projects: 1 });
    for (let repetition = 0; repetition < 2; repetition++) {
      const runs = await runLaunches(template, 2, async (root, launch) => {
        roots.push(root);
        const artifact = join(root, "patch-artifact");
        const previous = await readFile(artifact, "utf8").catch(() => "missing");
        expect(previous).toBe(launch === 1 ? "missing" : "1");
        await writeFile(artifact, String(launch));
        return launch;
      });
      expect(runs).toEqual([1, 2]);
    }
    expect(roots[0]).toBe(roots[1]);
    expect(roots[2]).toBe(roots[3]);
    expect(roots[0]).not.toBe(roots[2]);
    for (const root of new Set(roots)) {
      expect(
        await access(root).then(
          () => true,
          () => false
        )
      ).toBe(false);
    }
    expect(await readdir(template)).not.toContain("patch-artifact");
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

test("median handles even samples without mutating order and rejects invalid data", () => {
  const samples = [10, 1, 3, 2];
  expect(summarize(samples).median).toBe(2.5);
  expect(samples).toEqual([10, 1, 3, 2]);
  expect(summarize([100, 1, 2]).median).toBe(2);
  expect(() => summarize([])).toThrow();
  expect(() => summarize([NaN])).toThrow();
});

test("startup parser distinguishes unrelated logs and validates timing payloads", () => {
  expect(parseStartup("[startup] unrelated")).toBeUndefined();
  expect(
    parseStartup(
      'INFO [startup] ServiceContainer.initialize completed {"totalMs":123,"stepDurationsMs":{"core":40,"workspaces":80}}'
    )
  ).toEqual({ totalMs: 123, stepDurationsMs: { core: 40, workspaces: 80 } });
  expect(() =>
    parseStartup('[startup] ServiceContainer.initialize completed {"totalMs":"bad"}')
  ).toThrow();
});

test("settled parser does not treat recovery completion as retention cleanup completion", () => {
  expect(
    parseHousekeepingSettled(
      '[startup] ServiceContainer.initialize completed {"totalMs":1,"stepDurationsMs":{}}'
    )
  ).toBeUndefined();
  expect(
    parseHousekeepingSettled('[startup] ServiceContainer housekeeping settled {"durationMs":12}')
  ).toEqual({ durationMs: 12 });
  expect(() =>
    parseHousekeepingSettled('[startup] ServiceContainer housekeeping settled {"durationMs":"bad"}')
  ).toThrow();
});
