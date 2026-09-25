// Shared fixtures for the workspaceService.*.test.ts suites (split from workspaceService.test.ts).
import { expect, mock } from "bun:test";
import { Err, Ok } from "@/common/types/result";
import { ContextManagementService } from "./contextManagement/contextManagementService";
import { WorkspaceService } from "./workspaceService";
import { createStreamLifecycleMocks } from "./agentSession.testHarness";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Config } from "@/node/config";
import { HistoryService } from "./historyService";
import type { AIService } from "./aiService";
import { InitStateManager } from "./initStateManager";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { BackgroundProcessManager } from "./backgroundProcessManager";
import { createTestHistoryService } from "./testHistoryService";
import { getPlanFilePath } from "@/common/utils/planStorage";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import type { GoalRecordV1 } from "@/common/types/goal";

// Policy fixtures do not run a session; runtime cancellation races use real session fixtures.
export function createCompactionAdmissionMocks() {
  return {
    captureCompactionAdmission: mock(() => () => false),
    beginResumeIntent: mock(() => ({
      signal: new AbortController().signal,
      [Symbol.dispose]: () => undefined,
    })),
  };
}

// Rename/archive gate tests hold these private in-progress sets open directly: a real rename or
// archive would release the gate before the guarded call could observe it. Element access keeps
// the member names and Set types checked by TypeScript (no `any`).
export function addToRenamingWorkspaces(service: WorkspaceService, workspaceId: string): void {
  // eslint-disable-next-line @typescript-eslint/dot-notation -- private member, typed access
  service["renamingWorkspaces"].add(workspaceId);
}

export function addToArchivingWorkspaces(service: WorkspaceService, workspaceId: string): void {
  // eslint-disable-next-line @typescript-eslint/dot-notation -- private member, typed access
  service["archivingWorkspaces"].add(workspaceId);
}

export async function withTempMuxRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const originalMuxRoot = process.env.MUX_ROOT;
  const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-plan-"));
  process.env.MUX_ROOT = tempRoot;

  try {
    return await fn(tempRoot);
  } finally {
    if (originalMuxRoot === undefined) {
      delete process.env.MUX_ROOT;
    } else {
      process.env.MUX_ROOT = originalMuxRoot;
    }
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
}

export async function writePlanFile(
  root: string,
  projectName: string,
  workspaceName: string
): Promise<string> {
  const planFile = getPlanFilePath(workspaceName, projectName, root);
  await fsPromises.mkdir(path.dirname(planFile), { recursive: true });
  await fsPromises.writeFile(planFile, "# Plan\n");
  return planFile;
}

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Real manager with no processes; its output dir is only created if a test spawns one. */
export function createTestBackgroundProcessManager(): BackgroundProcessManager {
  return new BackgroundProcessManager(
    path.join(tmpdir(), `xum-test-bg-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  );
}

export type WorkspaceServiceArgs = ConstructorParameters<typeof WorkspaceService>;

/**
 * AI-service fake with every member WorkspaceService and AgentSession call unconditionally:
 * no provider config, no experiments, and no workspace metadata (the real service's answer
 * for an unknown workspace). Tests override the members they drive.
 */
export function createMockAIService(overrides: Partial<AIService> = {}): AIService {
  return {
    on: mock(() => undefined),
    off: mock(() => undefined),
    ...createStreamLifecycleMocks(),
    getProvidersConfig: mock(() => null),
    isExperimentEnabled: mock(() => false),
    getWorkspaceMetadata: mock((workspaceId: string) =>
      Promise.resolve(Err(`Workspace metadata not found for ${workspaceId}`))
    ),
    ...overrides,
  } as unknown as AIService;
}

export interface WorkspaceServiceForTestOptions {
  config: Config;
  historyService?: HistoryService;
  aiService?: AIService;
  initStateManager?: InitStateManager;
  extensionMetadata?: ExtensionMetadataService;
  backgroundProcessManager?: BackgroundProcessManager;
  sessionUsageService?: WorkspaceServiceArgs[7];
  policyService?: WorkspaceServiceArgs[8];
  telemetryService?: WorkspaceServiceArgs[9];
  experimentsService?: WorkspaceServiceArgs[10];
  sessionTimingService?: WorkspaceServiceArgs[11];
  streamManager?: WorkspaceServiceArgs[12];
  secretsStore?: WorkspaceServiceArgs[13];
}

/**
 * Low-level constructor for tests that already own their Config. Omitted stores default to
 * real instances rooted in that Config. Prefer createWorkspaceServiceHarness, which also
 * owns the temp root and its cleanup.
 */
export function createWorkspaceServiceForTest(
  options: WorkspaceServiceForTestOptions
): WorkspaceService {
  const config = options.config;
  const historyService = options.historyService ?? new HistoryService(config);
  const aiService = options.aiService ?? createMockAIService();
  return new WorkspaceService(
    config,
    historyService,
    aiService,
    new ContextManagementService({
      config,
      historyService,
      aiService,
      sessionUsageService: options.sessionUsageService,
      telemetryService: options.telemetryService,
    }),
    options.initStateManager ?? new InitStateManager(config),
    options.extensionMetadata ??
      new ExtensionMetadataService(path.join(config.rootDir, "extensionMetadata.json")),
    options.backgroundProcessManager ?? createTestBackgroundProcessManager(),
    options.sessionUsageService,
    options.policyService,
    options.telemetryService,
    options.experimentsService,
    options.sessionTimingService,
    options.streamManager,
    options.secretsStore
  );
}

export type WorkspaceServiceHarnessOptions = Omit<
  WorkspaceServiceForTestOptions,
  "config" | "historyService"
> & {
  /**
   * Members layered over the default AI fake (ignored when `aiService` is passed). The
   * default answers getWorkspaceMetadata from the harness's real Config, as AIService does.
   */
  aiServiceOverrides?: Partial<AIService>;
};

export interface WorkspaceServiceHarness extends AsyncDisposable {
  service: WorkspaceService;
  config: Config;
  historyService: HistoryService;
  aiService: AIService;
  initStateManager: InitStateManager;
  extensionMetadata: ExtensionMetadataService;
  backgroundProcessManager: BackgroundProcessManager;
  /** Temp root that owns config.json, sessions/, and the managers' files. */
  rootDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Default WorkspaceService fixture. Every dependency is a real instance rooted in one
 * temp directory (Config, HistoryService, InitStateManager, ExtensionMetadataService,
 * BackgroundProcessManager) except the AI service, which is a stream-lifecycle fake
 * because a real one needs providers. Seed state through the real stores
 * (`config.editConfig`/`config.addWorkspace`, `historyService.appendToHistory`) and
 * assert against them instead of hand-written partial doubles.
 */
export async function createWorkspaceServiceHarness(
  options: WorkspaceServiceHarnessOptions = {}
): Promise<WorkspaceServiceHarness> {
  const { config, historyService, tempDir, cleanup } = await createTestHistoryService();
  const { aiServiceOverrides, ...serviceOptions } = options;
  const aiService =
    options.aiService ??
    createMockAIService({
      getWorkspaceMetadata: mock(async (workspaceId: string) => {
        const metadata = await config.getWorkspaceMetadataById(workspaceId);
        return metadata ? Ok(metadata) : Err(`Workspace metadata not found for ${workspaceId}`);
      }),
      ...aiServiceOverrides,
    });
  const initStateManager = options.initStateManager ?? new InitStateManager(config);
  const extensionMetadata =
    options.extensionMetadata ??
    new ExtensionMetadataService(path.join(tempDir, "extensionMetadata.json"));
  const ownedBackgroundProcessManager =
    options.backgroundProcessManager == null
      ? new BackgroundProcessManager(path.join(tempDir, "background-processes"))
      : undefined;
  const backgroundProcessManager =
    options.backgroundProcessManager ?? ownedBackgroundProcessManager!;
  const service = createWorkspaceServiceForTest({
    ...serviceOptions,
    config,
    historyService,
    aiService,
    initStateManager,
    extensionMetadata,
    backgroundProcessManager,
  });
  // Stop processes a test spawned through the owned manager before deleting the root that
  // holds their output files; a surviving child could outlive the test run.
  const disposeHarness = async () => {
    await ownedBackgroundProcessManager?.terminateAll();
    await cleanup();
  };
  return {
    service,
    config,
    historyService,
    aiService,
    initStateManager,
    extensionMetadata,
    backgroundProcessManager,
    rootDir: tempDir,
    cleanup: disposeHarness,
    [Symbol.asyncDispose]: disposeHarness,
  };
}

export async function setWorkspaceGoalOk(
  goalService: WorkspaceGoalService,
  input: Parameters<WorkspaceGoalService["setGoal"]>[0]
): Promise<GoalRecordV1> {
  const result = await goalService.setGoal(input);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(`Expected goal set to succeed, got ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

export function createFrontendWorkspaceMetadata(
  overrides: Partial<FrontendWorkspaceMetadata> & Pick<FrontendWorkspaceMetadata, "id" | "name">
): FrontendWorkspaceMetadata {
  return {
    ...overrides,
    id: overrides.id,
    name: overrides.name,
    projectName: overrides.projectName ?? "project",
    projectPath: overrides.projectPath ?? "/tmp/project",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    runtimeConfig: overrides.runtimeConfig ?? { type: "local" },
    namedWorkspacePath: overrides.namedWorkspacePath ?? `/tmp/${overrides.id}`,
  };
}
