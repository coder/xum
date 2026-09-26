import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "../setup";
import { resolveOrpcClient } from "../helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("ProjectService IPC Handlers", () => {
  test.concurrent("should list projects including the created one", async () => {
    const env = await createTestEnvironment();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-service-test-"));
    const projectPath = path.join(tempDir, "test-project");

    // Setup a valid project
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(path.join(projectPath, ".git"));

    // Create the project first
    const client = resolveOrpcClient(env);
    await client.projects.create({ projectPath });

    const projects = await client.projects.list();
    const paths = projects.map((p: [string, unknown]) => p[0]);
    expect(paths).toContain(projectPath);

    await cleanupTestEnvironment(env);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test.concurrent("should list branches for a valid project", async () => {
    const env = await createTestEnvironment();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-service-test-"));
    const projectPath = path.join(tempDir, "test-project");

    // Setup a valid project
    await fs.mkdir(projectPath, { recursive: true });
    // We need to init git manually to have branches

    // Initialize git repo to have branches
    const execAsync = promisify(exec);

    await execAsync("git init", { cwd: projectPath });
    await execAsync("git config user.email 'test@example.com'", { cwd: projectPath });
    await execAsync("git config user.name 'Test User'", { cwd: projectPath });
    // Create initial commit to have a branch (usually main or master)
    await execAsync("touch README.md", { cwd: projectPath });
    await execAsync("git add README.md", { cwd: projectPath });
    await execAsync("git commit -m 'Initial commit'", { cwd: projectPath });
    // Create another branch
    await execAsync("git checkout -b feature-branch", { cwd: projectPath });

    // Project must be created in Mux to list branches via IPC?
    // The IPC PROJECT_LIST_BRANCHES takes a path, it doesn't strictly require the project to be in config,
    // but usually we operate on known projects. The implementation validates path.

    const client = resolveOrpcClient(env);
    const result = await client.projects.listBranches({ projectPath });
    // The current branch is feature-branch
    expect(result.branches).toContain("feature-branch");
    // The trunk branch inference might depend on available branches.
    expect(result.recommendedTrunk).toBeTruthy();

    await cleanupTestEnvironment(env);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test.concurrent("should handle secrets operations", async () => {
    const env = await createTestEnvironment();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-service-test-"));
    const projectPath = path.join(tempDir, "test-project");

    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(path.join(projectPath, ".git"));
    const client = resolveOrpcClient(env);
    await client.projects.create({ projectPath });

    const secrets = [
      { key: "API_KEY", value: "12345" },
      { key: "DB_URL", value: "postgres://localhost" },
    ];

    // Update secrets
    const updateResult = await client.projects.secrets.update({ projectPath, secrets });
    expect(updateResult.success).toBe(true);

    // Get secrets
    const fetchedSecrets = await client.projects.secrets.get({ projectPath });
    expect(fetchedSecrets).toHaveLength(2);
    expect(fetchedSecrets).toEqual(expect.arrayContaining(secrets));

    await cleanupTestEnvironment(env);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test.concurrent("should remove a project", async () => {
    const env = await createTestEnvironment();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-service-test-"));
    const projectPath = path.join(tempDir, "test-project");

    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(path.join(projectPath, ".git"));
    const client = resolveOrpcClient(env);
    await client.projects.create({ projectPath });

    const removeResult = await client.projects.remove({ projectPath });
    expect(removeResult.success).toBe(true);

    const projects = await client.projects.list();
    const paths = projects.map((p: [string, unknown]) => p[0]);
    expect(paths).not.toContain(projectPath);

    await cleanupTestEnvironment(env);
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
