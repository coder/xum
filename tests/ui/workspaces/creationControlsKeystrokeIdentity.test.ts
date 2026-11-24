/**
 * Typing in the New Workspace composer keeps the callbacks that CreationControls receives (#6843).
 *
 * React Compiler retains the CreationControls tree only while its props keep their identity.
 * ChatInput and useCreationWorkspace are not compiled, so a callback defined inline there changes
 * on every keystroke, and the nightly "perf: type in the New Workspace composer" counted 163
 * CreationControls renders for one typed sentence.
 *
 * Bun loads sources without React Compiler. So this test swaps in the compiled builds of the hooks
 * that create these callbacks, and runs ChatInput and useCreationWorkspace uncompiled, as in
 * production.
 */

import "../dom";
import * as path from "path";
import { fireEvent, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
} from "../../ipc/sendMessageTestHelpers";
import { renderApp } from "../renderReviewPanel";
import {
  addProjectViaUI,
  cleanupView,
  getWorkspaceDraftIds,
  openProjectCreationView,
  setupTestDom,
} from "../helpers";
import { loadReactCompiledModule } from "../reactCompiledModule";

import * as CreationControlsModule from "@/browser/features/ChatInput/CreationControls";
import * as ProjectChangeModule from "@/browser/features/ChatInput/useCreationProjectChangeHandler";
import * as WorkspaceNameModule from "@/browser/hooks/useWorkspaceName";
import { getCreationDraftStore } from "@/browser/stores/CreationDraftStore";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;
const SRC_DIR = path.join(__dirname, "../../../src");

type CreationControlsProps = ComponentProps<typeof CreationControlsModule.CreationControls>;

function loadCompiledExport<T>(relativePath: string, exportName: string): T {
  const value = loadReactCompiledModule(path.join(SRC_DIR, relativePath))[exportName];
  if (typeof value !== "function") throw new Error(`${relativePath} must export ${exportName}`);
  return value as T;
}

function messageTextarea(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  if (!textarea) throw new Error("Message textarea not found");
  return textarea;
}

describeIntegration("New Workspace composer typing", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("keeps the CreationControls callbacks across keystrokes", async () => {
    const renderedProps: CreationControlsProps[] = [];
    const renderCreationControls = CreationControlsModule.CreationControls;
    const spies = [
      jest
        .spyOn(WorkspaceNameModule, "useWorkspaceName")
        .mockImplementation(
          loadCompiledExport<typeof WorkspaceNameModule.useWorkspaceName>(
            "browser/hooks/useWorkspaceName.ts",
            "useWorkspaceName"
          )
        ),
      jest
        .spyOn(ProjectChangeModule, "useCreationProjectChangeHandler")
        .mockImplementation(
          loadCompiledExport<typeof ProjectChangeModule.useCreationProjectChangeHandler>(
            "browser/features/ChatInput/useCreationProjectChangeHandler.ts",
            "useCreationProjectChangeHandler"
          )
        ),
      jest.spyOn(CreationControlsModule, "CreationControls").mockImplementation((props) => {
        renderedProps.push(props);
        return renderCreationControls(props);
      }),
    ];
    const env = getSharedEnv();
    const cleanupDom = setupTestDom();
    const view = renderApp({ apiClient: env.orpc });
    try {
      const projectPath = await addProjectViaUI(view, getSharedRepoPath());
      await openProjectCreationView(view, projectPath);
      const editor = messageTextarea(view.container);
      fireEvent.change(editor, { target: { value: "D" } });
      // The first keystroke creates the draft that the callbacks write to.
      await waitFor(() => {
        const store = getCreationDraftStore();
        const typed = getWorkspaceDraftIds(projectPath).some(
          (id) => store.getView(id).draft?.text === "D"
        );
        if (!typed) throw new Error("Typed draft not listed yet");
      });
      const settledIndex = renderedProps.length - 1;
      const settled = renderedProps[settledIndex];

      for (const text of ["De", "Deb", "Debu", "Debug"]) {
        const before = renderedProps.length;
        fireEvent.change(editor, { target: { value: text } });
        // Each keystroke re-renders the uncompiled composer, so CreationControls gets new props.
        await waitFor(() => expect(renderedProps.length).toBeGreaterThan(before));
      }

      for (const props of renderedProps.slice(settledIndex + 1)) {
        expect(props.onSelectedProjectPathChange).toBe(settled.onSelectedProjectPathChange);
        expect(props.nameState.setName).toBe(settled.nameState.setName);
        expect(props.nameState.setAutoGenerate).toBe(settled.nameState.setAutoGenerate);
      }
    } finally {
      await cleanupView(view, cleanupDom);
      for (const spy of spies) spy.mockRestore();
    }
  }, 60_000);
});
