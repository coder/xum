import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { formatToolInputIssues, isToolInputIssueArray } from "./formatToolInputIssues";
import { TOOL_DEFINITIONS } from "./toolDefinitions";

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

  test("skips the received suffix for a string issue that is not about size", () => {
    const input = { question: "bbb" };
    const schema = z.object({ question: z.string().regex(/^a/) });

    expect(formatToolInputIssues(issuesFor(schema, input), input)).toBe(
      "question: Invalid string: must match pattern /^a/"
    );
  });

  test("labels a root-level issue as the whole input", () => {
    const message = formatToolInputIssues(issuesFor(z.object({ a: z.string() }), "oops"), "oops");

    expect(message).toStartWith("input: ");
    expect(message).not.toContain("Received");
  });

  test("skips the received suffix when the value at the path is not a string", () => {
    const issues = [{ path: ["question"], message: "Too big", code: "too_big", origin: "string" }];

    expect(formatToolInputIssues(issues, { question: 42 })).toBe("question: Too big");
    expect(formatToolInputIssues(issues, null)).toBe("question: Too big");
  });
});

describe("formatToolInputIssues received arguments", () => {
  const aliasSchema = z.preprocess(
    (value) => {
      const { command, ...rest } = value as Record<string, unknown>;
      return command === undefined ? rest : { script: command, ...rest };
    },
    z.object({ script: z.string(), timeout_secs: z.number() })
  );

  test("shows an aliased key as it arrived when the preprocess left the canonical one unset", () => {
    const input = { command: 5, display_name: "List scratch dirs", timeout_secs: 1 };

    expect(formatToolInputIssues(issuesFor(aliasSchema, input), input)).toBe(
      "script: Invalid input: expected string, received number. Received arguments: command=number, display_name=string(17 chars), timeout_secs=number"
    );
  });

  test("adds nothing when the property is present but has the wrong type", () => {
    const input = { script: 5, timeout_secs: 1 };

    expect(formatToolInputIssues(issuesFor(aliasSchema, input), input)).toBe(
      "script: Invalid input: expected string, received number"
    );
  });

  test("never echoes an argument value", () => {
    const secret = "ghp_0123456789abcdefSECRET";
    const input = { cmd: `curl -H "Authorization: ${secret}"`, token: secret, retries: 31337 };

    const message = formatToolInputIssues(issuesFor(aliasSchema, input), input);

    expect(message).toEndWith(
      `Received arguments: cmd=string(${input.cmd.length} chars), token=string(26 chars), retries=number`
    );
    expect(message).not.toContain("SECRET");
    expect(message).not.toContain("31337");
  });

  test("hides data-shaped keys and counts them", () => {
    const input = {
      ghp_ABCdef123456SECRET: "x",
      AKIAIOSFODNN7EXAMPLE: "x",
      "token=ghp_live_zzzzzzz": "x",
      "user@example.com /home/mike/.netrc": 1,
      'two\nlines"': 1,
    };

    const message = formatToolInputIssues(issuesFor(aliasSchema, input), input);

    expect(message).toEndWith("Received arguments: 5 keys not shown");
    expect(message).not.toMatch(/SECRET|EXAMPLE|ghp_live|netrc|example|two/);
  });

  test("shows a key of up to 40 identifier characters, including a truncated real key", () => {
    const at40 = `a${"b".repeat(39)}`;
    const input = { comm: "cd", command: 1, [at40]: 2, [`${at40}c`]: 3 };

    expect(formatToolInputIssues(issuesFor(aliasSchema, input), input)).toEndWith(
      `Received arguments: comm=string(2 chars), command=number, ${at40}=number (1 key not shown)`
    );
  });

  test("describes other values by type", () => {
    const input = { nothing: null, list: [1, 2], nested: { a: 1 }, absent: undefined };

    expect(formatToolInputIssues(issuesFor(aliasSchema, input), input)).toEndWith(
      "Received arguments: nothing=null, list=array(2 items), nested=object, absent=undefined"
    );
  });

  test("caps the number of listed arguments", () => {
    const keys = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`key_${"abcdefghijkl"[index]}`, index])
      );

    expect(formatToolInputIssues(issuesFor(aliasSchema, keys(11)), keys(11))).toEndWith(
      "key_j=number (+1 more)"
    );
    expect(formatToolInputIssues(issuesFor(aliasSchema, keys(10)), keys(10))).toEndWith(
      "key_j=number"
    );
    const mixed = { ...keys(12), "x.y": 1, "a=b": 2 };
    expect(formatToolInputIssues(issuesFor(aliasSchema, mixed), mixed)).toEndWith(
      "key_j=number (+2 more) (2 keys not shown)"
    );
  });

  test("says so when no named arguments arrived", () => {
    const issues = [{ path: ["script"], message: "Required", code: "invalid_type" }];

    expect(formatToolInputIssues(issues, {})).toBe(
      "script: Required. Received arguments: no arguments"
    );
    expect(formatToolInputIssues(issues, null)).toBe(
      "script: Required. Received arguments: no named arguments"
    );
    expect(formatToolInputIssues(issues, ["cd"])).toEndWith("no named arguments");
  });
});

describe("formatToolInputIssues path labels", () => {
  const recordSchema = z.object({ answers: z.record(z.string(), z.string()) });
  const withKey = (key: string) => {
    const input = { answers: { [key]: 5 } };
    return formatToolInputIssues(issuesFor(recordSchema, input), input);
  };

  test.each([
    ["semicolon", "safe; ghp_x", "answers.safe%3B ghp_x"],
    ["colon", "evil: ghp_x", "answers.evil%3A ghp_x"],
    ["bare separators", "a;b:c", "answers.a%3Bb%3Ac"],
    ["newline", "a\nb", "answers.a%0Ab"],
    ["carriage return", "a\rb", "answers.a%0Db"],
    ["an escape already in the key", "%3B", "answers.%253B"],
    ["a dot", "happy.path", "answers.happy.path"],
  ])("escapes structure characters in a record key: %s", (_name, key, label) => {
    expect(withKey(key)).toBe(`${label}: Invalid input: expected string, received number`);
  });

  test("leaves parameter names and array indices as they are", () => {
    const issues = [{ path: ["questions", 0, "header"], message: "Required" }];

    expect(formatToolInputIssues(issues, {})).toBe("questions.0.header: Required");
  });

  test("a record key cannot add an issue clause or end the label early", () => {
    const summary = withKey("a; b: c");
    const clauses = summary.split("; ");

    expect(clauses).toHaveLength(1);
    expect(clauses[0].slice(0, clauses[0].indexOf(": "))).toBe("answers.a%3B b%3A c");
  });
});

describe("formatToolInputIssues unrecognized keys", () => {
  const strictSchema = TOOL_DEFINITIONS.desktop_click.schema;
  const unrecognized = (extra: Record<string, unknown>) => {
    const input = { x: 1, y: 2, ...extra };
    return formatToolInputIssues(issuesFor(strictSchema, input), input);
  };

  test("shows parameter-shaped keys and counts the others", () => {
    const message = unrecognized({ ghp_ABCdef123456SECRETxyz: 1, badKey: 2 });

    expect(message).toBe("input: unrecognized keys: badKey (1 key not shown)");
  });

  test("shows only a count when no key is parameter-shaped", () => {
    const message = unrecognized({ ghp_ABCdef123456SECRETxyz: 1, "user@example.com": 2 });

    expect(message).toBe("input: 2 unrecognized keys not shown");
    expect(unrecognized({ AKIAIOSFODNN7EXAMPLE: 1 })).toBe("input: 1 unrecognized key not shown");
  });

  test("lists displayable keys without a count suffix", () => {
    expect(unrecognized({ badKey: 1 })).toBe("input: unrecognized key: badKey");
    expect(unrecognized({ badKey: 1, other_key: 2 })).toBe(
      "input: unrecognized keys: badKey, other_key"
    );
  });

  test("caps the number of listed keys", () => {
    const extra = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`key_${"abcdefghijkl"[index]}`, index])
    );

    expect(unrecognized({ ...extra, "a=b": 1 })).toBe(
      "input: unrecognized keys: key_a, key_b, key_c, key_d, key_e, key_f, key_g, key_h, key_i, key_j (+2 more) (1 key not shown)"
    );
  });
});

function parameterNames(node: unknown, names: Set<string>): void {
  if (node === null || typeof node !== "object") return;
  const properties = (node as { properties?: object }).properties ?? {};
  Object.keys(properties).forEach((name) => names.add(name));
  Object.values(node).forEach((child) => parameterNames(child, names));
}

test("shows every tool parameter name as a received key", () => {
  const names = new Set<string>();
  for (const { schema } of Object.values(TOOL_DEFINITIONS)) {
    parameterNames(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }), names);
  }
  const issues = [{ path: ["missing"], message: "Required", code: "invalid_type" }];
  const hidden = [...names].filter(
    (name) => !formatToolInputIssues(issues, { [name]: 1 }).endsWith(`: ${name}=number`)
  );

  expect(names.size).toBeGreaterThan(100);
  expect(hidden).toEqual([]);
});

describe("isToolInputIssueArray", () => {
  test("accepts zod issues and rejects other shapes", () => {
    expect(isToolInputIssueArray(issuesFor(z.string(), 1))).toBe(true);
    expect(isToolInputIssueArray([{ path: "question", message: "x" }])).toBe(false);
    expect(isToolInputIssueArray([{ path: [], message: 1 }])).toBe(false);
    expect(isToolInputIssueArray("issues")).toBe(false);
  });
});
