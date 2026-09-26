import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "./setup";
import { resolveOrpcClient } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Window title IPC", () => {
  test("window.setTitle reaches the main window", async () => {
    const env = await createTestEnvironment();

    try {
      const client = resolveOrpcClient(env);
      await client.window.setTitle({ title: "test-workspace - test-project - mux" });

      expect(env.mockWindow.setTitle).toHaveBeenCalledWith("test-workspace - test-project - mux");
    } finally {
      await cleanupTestEnvironment(env);
    }
  }, 10000);
});
