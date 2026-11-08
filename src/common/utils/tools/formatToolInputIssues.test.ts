import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { formatToolInputIssues, isToolInputIssueArray } from "./formatToolInputIssues";

function issuesFor(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  if (result.success) {
    throw new Error("expected schema to reject value");
  }
  return result.error.issues;
}

describe("formatToolInputIssues", () => {
  test("appends the received length for a string max violation without echoing the value", () => {
    const input = { question: "x".repeat(2100) };
    const schema = z.object({ question: z.string().max(2000) });

    const message = formatToolInputIssues(issuesFor(schema, input), input);

    expect(message).toBe(
      "question: Too big: expected string to have <=2000 characters (received 2100 characters)"
    );
    expect(message).not.toContain("xxx");
  });

  test("appends the received length for a string min violation", () => {
    const input = { question: "ab" };
    const schema = z.object({ question: z.string().min(5) });

    expect(formatToolInputIssues(issuesFor(schema, input), input)).toEndWith(
      "(received 2 characters)"
    );
  });

  test("joins multiple issues and only annotates string-origin size issues", () => {
    const input = { question: "x".repeat(2100), tags: ["a", "b"], nested: { count: 1 } };
    const schema = z.object({
      question: z.string().max(2000),
      tags: z.array(z.string()).max(1),
      nested: z.object({ count: z.number().min(2) }),
    });

    const message = formatToolInputIssues(issuesFor(schema, input), input);
    const parts = message.split("; ");

    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain("received 2100 characters");
    expect(parts[1]).toStartWith("tags: ");
    expect(parts[1]).not.toContain("received");
    expect(parts[2]).toStartWith("nested.count: ");
    expect(parts[2]).not.toContain("received");
  });

  test("labels a root-level issue as the whole input", () => {
    const message = formatToolInputIssues(issuesFor(z.object({ a: z.string() }), "oops"), "oops");

    expect(message).toStartWith("input: ");
  });

  test("skips the received suffix when the value at the path is not a string", () => {
    const issues = [{ path: ["question"], message: "Too big", code: "too_big", origin: "string" }];

    expect(formatToolInputIssues(issues, { question: 42 })).toBe("question: Too big");
    expect(formatToolInputIssues(issues, null)).toBe("question: Too big");
  });

  test("lists the received keys once when required fields are missing, never their values", () => {
    const schema = z.object({ script: z.string(), display_name: z.string() });
    const input = { agent_report: "<parameter=secret", ["k".repeat(100)]: 1 };

    const message = formatToolInputIssues(issuesFor(schema, input), input);

    // Two missing-field issues, then one listing of the keys that arrived.
    expect(message.split("; ")).toHaveLength(3);
    expect(message.split("agent_report")).toHaveLength(2);
    expect(message).toContain("k".repeat(40));
    expect(message).not.toContain("k".repeat(41));
    expect(message).not.toContain("secret");
    // An empty object still gets the note, so the model learns it sent nothing.
    expect(formatToolInputIssues(issuesFor(schema, {}), {}).split("; ")).toHaveLength(3);
  });

  test("does not list keys for a present field of the wrong type or another issue", () => {
    const schema = z.object({ script: z.string(), count: z.number().max(1) });

    for (const { input, unlistedKey } of [
      { input: { script: 5, count: 0 }, unlistedKey: "count" },
      { input: { script: "ls", count: 2 }, unlistedKey: "script" },
    ]) {
      expect(formatToolInputIssues(issuesFor(schema, input), input)).not.toContain(unlistedKey);
    }
  });
});

describe("isToolInputIssueArray", () => {
  test("accepts zod issues and rejects other shapes", () => {
    expect(isToolInputIssueArray(issuesFor(z.string(), 1))).toBe(true);
    expect(isToolInputIssueArray([{ path: "question", message: "x" }])).toBe(false);
    expect(isToolInputIssueArray([{ path: [], message: 1 }])).toBe(false);
    expect(isToolInputIssueArray("issues")).toBe(false);
  });
});
