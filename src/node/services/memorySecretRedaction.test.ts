import { describe, expect, it } from "bun:test";

import { containsSecretLike, redactSecretLike } from "./memorySecretRedaction";

describe("redactSecretLike", () => {
  const FAKE = {
    github: `gho_${"Q7w3".repeat(9)}`,
    pat: `github_pat_${"A1b2".repeat(8)}`,
    slack: "xoxb-1234567890-abcdefghij",
    aws: "AKIAABCDEFGHIJKLMNOP",
    openai: `sk-${"k3J9".repeat(6)}`,
    bearer: "tok_live_abcdefghijklmnop",
    jwt: `eyJ${"h".repeat(12)}.eyJ${"p".repeat(12)}.${"s".repeat(12)}`,
  };

  it.each([
    ["a GitHub OAuth token", `token in env: ${FAKE.github}`, FAKE.github],
    ["a fine-grained GitHub token", `using ${FAKE.pat}`, FAKE.pat],
    ["a Slack token", `slack ${FAKE.slack}`, FAKE.slack],
    ["an AWS access key id", `id ${FAKE.aws}`, FAKE.aws],
    ["an OpenAI-style key", `key ${FAKE.openai}`, FAKE.openai],
    ["a bearer header", `Authorization: Bearer ${FAKE.bearer}`, FAKE.bearer],
    ["a JWT", `jwt ${FAKE.jwt}`, FAKE.jwt],
    ["an env assignment", "DB_PASSWORD=hunter2 npm start", "hunter2"],
    ["a quoted JSON pair with spaces", '{"client_secret": "two words here"}', "two words"],
    [
      "a JSON pair inside an escaped string",
      String.raw`{"out":"{\"api_key\": \"abc123xyz\"}"}`,
      "abc123xyz",
    ],
    ["a YAML pair", "password: s3cret-value\nname: demo", "s3cret-value"],
    ["a basic auth header", "authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
    [
      "a PEM private key",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabcdef\n-----END RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA",
    ],
    [
      "an unterminated PEM private key",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg",
      "MIIEvQIBADANBg",
    ],
    [
      "an unterminated quoted value",
      '{"password": "unterminated-secret-va',
      "unterminated-secret-va",
    ],
  ])("redacts %s", (_label, text, secret) => {
    const redacted = redactSecretLike(text);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[redacted]");
  });

  it("leaves ordinary text and token counts readable", () => {
    const text = "max_tokens: 4096, input_tokens=120, ran 3 tests in the task-runner, name: demo";
    expect(redactSecretLike(text)).toBe(text);
  });

  // The guard scans text a model supplied, so a hostile 100 KB write must not stall the process.
  // Each shape repeats a keyword with nothing after it, which made the open-ended name suffix and
  // JWT segment rescan to the end of the text from every occurrence (seconds per input).
  it.each([
    ["token", "token".repeat(20_000)],
    ["secret-", "secret-".repeat(14_000)],
    ["authorization", "authorization".repeat(7_700)],
    ["credential_", "credential_".repeat(9_000)],
    ["api_key", "api_key".repeat(14_000)],
    ["a JWT header after a dash", "eyJ-".repeat(25_000)],
    ["a keyword followed by whitespace", `token${" ".repeat(100_000)}x`],
  ])("scans %s in linear time", (_label, text) => {
    redactSecretLike("warm up token: abc"); // keep a cold regex compile out of the timing
    const started = performance.now();
    redactSecretLike(text);
    containsSecretLike(text);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("containsSecretLike", () => {
  it("flags a credential shape and passes ordinary prose about tokens", () => {
    expect(containsSecretLike("DB_PASSWORD=hunter2 npm start")).toBe(true);
    expect(containsSecretLike(`key sk-${"k3J9".repeat(6)}`)).toBe(true);
    expect(containsSecretLike("The token budget resets each turn; max_tokens: 4096.")).toBe(false);
    expect(containsSecretLike("Auth uses a password manager and a bearer scheme.")).toBe(false);
  });
});
