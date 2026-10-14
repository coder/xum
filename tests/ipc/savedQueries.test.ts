import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "./setup";
import { resolveOrpcClient } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Wiring only: each analytics saved-query route reaches the store. Behavior (ordering,
// partial updates, missing ids, corrupt files) is owned by
// src/node/services/analytics/savedQueries.test.ts.
describeIntegration("Saved Queries IPC", () => {
  test("save, update, list and delete round-trip through IPC", async () => {
    const env = await createTestEnvironment();

    try {
      const client = resolveOrpcClient(env);
      const saved = await client.analytics.saveQuery({
        label: "Test Query",
        sql: "SELECT 1",
        chartType: "bar",
      });
      const updated = await client.analytics.updateSavedQuery({ id: saved.id, chartType: "line" });
      expect(updated).toMatchObject({ id: saved.id, label: "Test Query", chartType: "line" });

      const listed = await client.analytics.getSavedQueries();
      expect(listed.queries.map((query) => [query.id, query.chartType])).toEqual([
        [saved.id, "line"],
      ]);

      expect(await client.analytics.deleteSavedQuery({ id: saved.id })).toMatchObject({
        success: true,
      });
      expect((await client.analytics.getSavedQueries()).queries).toEqual([]);
    } finally {
      await cleanupTestEnvironment(env);
    }
  }, 10000);
});
