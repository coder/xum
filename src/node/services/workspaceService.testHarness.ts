// Shared fixtures for the workspaceService.*.test.ts suites (split from workspaceService.test.ts).
import { expect, mock } from "bun:test";
import { ContextManagementService } from "./contextManagement/contextManagementService";
import { WorkspaceService } from "./workspaceService";
import { createStreamLifecycleMocks } from "./agentSession.testHarness";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Config, SecretsStore } from "@/node/config";
import type { HistoryService } from "./historyService";
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

// Helper to access private renamingWorkspaces set
export function addToRenamingWorkspaces(service: WorkspaceService, workspaceId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  (service as any).renamingWorkspaces.add(workspaceId);
}

// Helper to access private archivingWorkspaces set
export function addToArchivingWorkspaces(service: WorkspaceService, workspaceId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  (service as any).archivingWorkspaces.add(workspaceId);
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

// NOTE: This test file uses bun:test mocks (not Jest).

export const mockInitStateManager: Partial<InitStateManager> = {
  on: mock(() => undefined as unknown as InitStateManager),
  off: mock(() => undefined as unknown as InitStateManager),
  getInitState: mock(() => undefined),
  waitForInit: mock(() => Promise.resolve()),
  clearInMemoryState: mock(() => undefined),
};

export const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {
  isWorkspaceDeleted: mock(() => false),
  clearTombstonesForRegisteredIds: mock(() => undefined),
  getTombstonedIds: mock((): ReadonlyMap<string, number> => new Map()),
  setTombstoneClearedListener: mock(() => undefined),
  setStreaming: mock(() =>
    Promise.resolve({
      recency: Date.now(),
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
      agentStatus: null,
    })
  ),
  updateRecency: mock(() =>
    Promise.resolve({
      recency: Date.now(),
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
      agentStatus: null,
    })
  ),
};

export const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
  cleanup: mock(() => Promise.resolve()),
  hasRunningBackgroundProcesses: mock(() => false),
  hasOrphanedRunningBackgroundProcesses: mock(() => Promise.resolve(false)),
};

export type WorkspaceServiceArgs = ConstructorParameters<typeof WorkspaceService>;

export type MockWorkspaceConfig = Partial<Config> & {
  getEffectiveSecrets?: SecretsStore["getEffectiveSecrets"];
};

export function createMockAIService(overrides: Partial<AIService> = {}): AIService {
  return {
    on: mock(() => undefined),
    off: mock(() => undefined),
    ...createStreamLifecycleMocks(),
    ...overrides,
  } as unknown as AIService;
}

export interface WorkspaceServiceForTestOptions {
  config:
    | (Partial<Config> & { getEffectiveSecrets?: SecretsStore["getEffectiveSecrets"] })
    | Config;
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
 * Low-level constructor for tests that already own their stores. Prefer
 * createWorkspaceServiceHarness, which also owns a real Config and HistoryService.
 */
export function createWorkspaceServiceForTest(
  options: WorkspaceServiceForTestOptions
): WorkspaceService {
  // Test helpers often don't exercise HistoryService; use a narrow stub for those cases.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const defaultHistoryService: HistoryService = {} as HistoryService;
  const config = options.config as Config;
  const historyService = options.historyService ?? defaultHistoryService;
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
    options.initStateManager ?? (mockInitStateManager as InitStateManager),
    options.extensionMetadata ?? (mockExtensionMetadataService as ExtensionMetadataService),
    options.backgroundProcessManager ?? (mockBackgroundProcessManager as BackgroundProcessManager),
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
>;

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
  const aiService = options.aiService ?? createMockAIService();
  const initStateManager = options.initStateManager ?? new InitStateManager(config);
  const extensionMetadata =
    options.extensionMetadata ??
    new ExtensionMetadataService(path.join(tempDir, "extensionMetadata.json"));
  const backgroundProcessManager =
    options.backgroundProcessManager ??
    new BackgroundProcessManager(path.join(tempDir, "background-processes"));
  const service = createWorkspaceServiceForTest({
    ...options,
    config,
    historyService,
    aiService,
    initStateManager,
    extensionMetadata,
    backgroundProcessManager,
  });
  return {
    service,
    config,
    historyService,
    aiService,
    initStateManager,
    extensionMetadata,
    backgroundProcessManager,
    rootDir: tempDir,
    cleanup,
    [Symbol.asyncDispose]: cleanup,
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
