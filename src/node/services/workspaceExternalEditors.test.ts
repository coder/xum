import { describe, expect, mock, test } from "bun:test";
import * as path from "path";
import type { ProjectsConfig } from "@/common/types/project";
import { Err, Ok, type Result } from "@/common/types/result";
import {
  createMemoryHost,
  MEMORY_XUM_HOME,
} from "@/node/services/hostFiles/memoryHostFiles.testHarness";
import { WorkspaceExternalEditors } from "@/node/services/workspaceExternalEditors";
import { WorkspaceLifecycleGates } from "@/node/services/workspaceLifecycleGates";

// WorkspaceExternalEditors without a WorkspaceService: a memory host stands in for the disk and a
// recorded hold() for the cross-process leases. The facade-level behavior (archive gating,
// renderer tokens, tombstones) is covered through WorkspaceService in
// workspaceService.archive.test.ts and workspaceService.mutationGate.test.ts.

const SESSIONS_DIR = path.join(MEMORY_XUM_HOME, "sessions");
const WORKSPACE_ID = "ws1";
const MARKER_PATH = path.join(SESSIONS_DIR, WORKSPACE_ID, "external-editor-opened");

function createEditors() {
  const host = createMemoryHost();
  const gates = new WorkspaceLifecycleGates();
  const released = mock(() => Promise.resolve());
  const hold = mock(() => Promise.resolve({ release: released }));
  const projects: ProjectsConfig = {
    projects: new Map([
      ["/repo", { workspaces: [{ id: WORKSPACE_ID, name: WORKSPACE_ID, path: "/repo/ws1" }] }],
    ]),
  };
  const editors = new WorkspaceExternalEditors({
    config: { sessionsDir: SESSIONS_DIR, loadConfigOrDefault: () => projects },
    files: host.files,
    leases: { hold },
    gates,
  });
  const markerExists = () =>
    host.files.promises.access(MARKER_PATH).then(
      () => true,
      () => false
    );
  return { editors, gates, hold, markerExists };
}

describe("WorkspaceExternalEditors", () => {
  test("a launch counts as pending until it settles, and a failed one leaves no marker", async () => {
    const { editors, markerExists } = createEditors();
    const launch = Promise.withResolvers<Result<void>>();

    const opened = editors.launchExternalEditor(WORKSPACE_ID, () => launch.promise);
    // Counted before the first await, so a gate in the same tick already sees the open.
    expect(editors.hasPendingExternalEditorOpen(WORKSPACE_ID)).toBe(true);
    expect(await editors.hasExternalEditorOpen(WORKSPACE_ID)).toBe(true);

    launch.resolve(Err("spawn failed"));
    expect(await opened).toEqual(Err("spawn failed"));
    expect(editors.hasPendingExternalEditorOpen(WORKSPACE_ID)).toBe(false);
    expect(await markerExists()).toBe(false);
    expect(await editors.hasExternalEditorOpen(WORKSPACE_ID)).toBe(false);
  });

  test("a successful launch keeps the marker and one use lease", async () => {
    const { editors, hold, markerExists } = createEditors();

    expect(
      await editors.launchExternalEditor(WORKSPACE_ID, () => Promise.resolve(Ok(undefined)))
    ).toEqual(Ok(undefined));
    expect(
      await editors.launchExternalEditor(WORKSPACE_ID, () => Promise.resolve(Ok(undefined)))
    ).toEqual(Ok(undefined));

    expect(await markerExists()).toBe(true);
    expect(await editors.hasExternalEditorOpen(WORKSPACE_ID)).toBe(true);
    // Each open takes a share, but the backend keeps only the first one.
    expect(hold).toHaveBeenCalledTimes(2);
    expect(editors.takeExternalEditorUseLease(WORKSPACE_ID)).toBeDefined();
    expect(editors.takeExternalEditorUseLease(WORKSPACE_ID)).toBeUndefined();
  });

  test("an archive in the shared gates refuses the open before any lease or marker", async () => {
    const { editors, gates, hold, markerExists } = createEditors();
    const launch = mock(() => Promise.resolve(Ok(undefined)));
    gates.archiving.add(WORKSPACE_ID);

    const result = await editors.launchExternalEditor(WORKSPACE_ID, launch);

    expect(result.success).toBe(false);
    expect(launch).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    expect(await markerExists()).toBe(false);
  });
});
