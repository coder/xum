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
    stripeLive: `sk_live_${"4eC3".repeat(6)}`,
    stripeTest: `sk_test_${"9aZ1".repeat(6)}`,
    stripeRestricted: `rk_live_${"7qW2".repeat(6)}`,
    gitlab: `glpat-${"x9Y8".repeat(5)}`,
    google: `AIza${"Sy7_".repeat(8)}abc`,
    npm: `npm_${"Ab3d".repeat(9)}`,
    slackHook: `T${"0".repeat(8)}/B${"1".repeat(8)}/${"Xz9k".repeat(6)}`,
    urlPassword: "s3cr3t-pw",
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
      "a PGP private key block",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQdGBF4hBkcBEADdzx3k\n=AbCd\n-----END PGP PRIVATE KEY BLOCK-----",
      "lQdGBF4hBkcBEADdzx3k",
    ],
    [
      "an unterminated PGP private key block",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQdGBF4hBkcBEADdzx3k",
      "lQdGBF4hBkcBEADdzx3k",
    ],
    [
      "an Azure storage connection string",
      "DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=Eby8vdM02xNOcqFlqUwJ+PEx/3x==;EndpointSuffix=core.windows.net",
      "Eby8vdM02xNOcqFlqUwJ+PEx/3x==",
    ],
    ["an account key in a JSON pair", '{"accountKey": "Eby8vdM02xNOc"}', "Eby8vdM02xNOc"],
    ["a bearer assignment", "curl -d bearer=abc123def456 https://example.com", "abc123def456"],
    ["a bearer JSON pair", '{"bearer": "abc123def456"}', "abc123def456"],
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
    [
      "URL userinfo",
      `clone https://deploy:${FAKE.urlPassword}@git.example.com/org/repo.git`,
      FAKE.urlPassword,
    ],
    [
      "URL userinfo with an empty user",
      `redis://:${FAKE.urlPassword}@cache:6379/0`,
      FAKE.urlPassword,
    ],
    ["a live Stripe key", `STRIPE=${FAKE.stripeLive}`, FAKE.stripeLive],
    ["a test Stripe key", `using ${FAKE.stripeTest}`, FAKE.stripeTest],
    ["a restricted Stripe key", `using ${FAKE.stripeRestricted}`, FAKE.stripeRestricted],
    ["a GitLab token", `glab auth ${FAKE.gitlab}`, FAKE.gitlab],
    ["a Google API key", `maps ${FAKE.google}`, FAKE.google],
    ["an npm token", `//registry.npmjs.org/:_authToken ${FAKE.npm}`, FAKE.npm],
    [
      "a Slack webhook URL",
      `curl https://hooks.slack.com/services/${FAKE.slackHook}`,
      FAKE.slackHook,
    ],
    [
      "a bracketed environment assignment",
      'os.environ["API_KEY"] = "abc123xyz-value"',
      "abc123xyz-value",
    ],
    ["a bracketed single-quoted assignment", "env['DB_PASSWORD']= 'hunter2x'", "hunter2x"],
    [
      "a bracketed assignment in JSON-escaped text",
      String.raw`{"c":"cfg[\"token\"] = \"zz9plural\""}`,
      "zz9plural",
    ],
  ])("redacts %s", (_label, text, secret) => {
    const redacted = redactSecretLike(text);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[redacted]");
  });

  it("leaves ordinary text and token counts readable", () => {
    const text =
      "max_tokens: 4096, input_tokens=120, ran 3 tests in the task-runner, name: demo, bearer scheme, account name";
    expect(redactSecretLike(text)).toBe(text);
  });

  it("leaves URLs without a password, SSH remotes, npm variable names and index lookups readable", () => {
    const text = [
      "https://user@example.com/path and http://localhost:8080/api@v2",
      "git@github.com:org/repo.git",
      "npm_config_cache and npm_package_version",
      "seen[token] = true; tokens[id] = 1",
      "pk_live_publishable and sk_live_ is a prefix",
    ].join("\n");
    expect(redactSecretLike(text)).toBe(text);
  });

  it("keeps the userinfo's host readable", () => {
    expect(redactSecretLike("https://deploy:pw@git.example.com/org/repo")).toBe(
      "https://[redacted]@git.example.com/org/repo"
    );
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
    ["a bare bracket assignment", 'password"]'.repeat(10_000)],
    ["URL schemes with a short userinfo", "://a:".repeat(25_000)],
    ["a keyword followed by whitespace", `token${" ".repeat(100_000)}x`],
    ["account_key", "account_key".repeat(9_000)],
    ["bearer", "bearer".repeat(16_000)],
    ["a PGP key header", "-----BEGIN PGP PRIVATE KEY BLOCK-----".repeat(3_000)],
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
