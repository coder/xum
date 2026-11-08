import { describe, expect, it } from "bun:test";

import { redactSecretLike } from "./memorySecretRedaction";

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
    signature: "Zk3%2Bq9Lw%2FPd7%3D",
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
    [
      "an Azure SAS signature",
      `https://acct.blob.core.windows.net/c/b?sv=2022-11-02&se=2030-01-01&sig=${FAKE.signature}&sp=r`,
      FAKE.signature,
    ],
    [
      "a signature parameter",
      `https://files.example.com/d?expires=99&signature=${FAKE.signature}`,
      FAKE.signature,
    ],
    [
      "an AWS presigned URL signature",
      `https://b.s3.amazonaws.com/k?X-Amz-Expires=60&X-Amz-Signature=${FAKE.signature}`,
      FAKE.signature,
    ],
    [
      "a Google signed URL signature",
      `https://storage.googleapis.com/b/o?X-Goog-Expires=60&X-Goog-Signature=${FAKE.signature}`,
      FAKE.signature,
    ],
    [
      "a signature parameter in any letter case",
      `https://h.example.com/p?SIG=${FAKE.signature}`,
      FAKE.signature,
    ],
    [
      "a signature parameter after an XML-escaped ampersand",
      `<Url>https://h.example.com/p?se=1&amp;sig=${FAKE.signature}&amp;sp=r</Url>`,
      FAKE.signature,
    ],
    [
      "a signed URL inside a JSON-escaped string",
      JSON.stringify({ url: `https://h.example.com/p?a=1&sig=${FAKE.signature}` }),
      FAKE.signature,
    ],
  ])("redacts %s", (_label, text, secret) => {
    const redacted = redactSecretLike(text);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[redacted]");
  });

  // The value's escaped quote is not its end: what follows it was leaking to the harvest model.
  // Each input is the form `JSON.stringify` makes, once for a tool value and once more for a tool
  // that printed JSON.
  it.each([
    [
      "a JSON-stringified quote",
      JSON.stringify({ password: 'abc"DEF-SUFFIX' }),
      String.raw`{"password":[redacted]}`,
    ],
    [
      "an escaped backslash before the closing quote",
      JSON.stringify({ password: "abc\\", user: "alice" }),
      String.raw`{"password":[redacted],"user":"alice"}`,
    ],
    [
      "an escaped quote and the keys after it",
      JSON.stringify({ password: 'a"b"c', user: "alice" }),
      String.raw`{"password":[redacted],"user":"alice"}`,
    ],
    [
      "a quote inside JSON printed by a tool",
      JSON.stringify({ out: JSON.stringify({ password: 'abc"DEF-SUFFIX', user: "alice" }) }),
      String.raw`{"out":"{\"password\":[redacted],\"user\":\"alice\"}"}`,
    ],
    [
      "an escaped backslash inside JSON printed by a tool",
      JSON.stringify({ out: JSON.stringify({ password: "abc\\", user: "alice" }) }),
      String.raw`{"out":"{\"password\":[redacted],\"user\":\"alice\"}"}`,
    ],
    [
      "a backslash and a quote inside JSON printed by a tool",
      JSON.stringify({ out: JSON.stringify({ password: 'a\\"b', user: "alice" }) }),
      String.raw`{"out":"{\"password\":[redacted],\"user\":\"alice\"}"}`,
    ],
    [
      "an escaped apostrophe",
      String.raw`password = 'it\'s-secret' next`,
      "password = [redacted] next",
    ],
    ["a Windows path", String.raw`password: "C:\Users\me" next`, "password: [redacted] next"],
    [
      "an unterminated value that ends in an escaped quote",
      String.raw`{"password":"abc\"DEF`,
      '{"password":[redacted]',
    ],
    [
      "an unterminated value that ends in a backslash",
      `{"password": "abc${"\\"}`,
      '{"password": [redacted]',
    ],
  ])("redacts the whole value with %s", (_label, text, expected) => {
    expect(redactSecretLike(text)).toBe(expected);
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

  it("redacts only a signature's value and keeps the rest of the URL readable", () => {
    expect(
      redactSecretLike("https://h.example.com/p?sv=1&sig=abc%2Bdef%3D&sp=r#frag (see ?signature=x1)")
    ).toBe("https://h.example.com/p?sv=1&sig=[redacted]&sp=r#frag (see ?signature=[redacted])");
  });

  // `signature` is not a secret name: the memory-write guard reuses this detector, and a note
  // about a function signature or a signed commit must stay writable.
  it("leaves a signature or sig that is not a URL query parameter readable", () => {
    const text = [
      "signature: foo(a, b)",
      "def verify(signature=None, sig=b'')",
      "sig: 12 bytes, signature = checked",
      "git commit --signature=abc123",
      "see the signature=value form in the docs",
      "https://h.example.com/p?design=1&signed=yes&sigma=3",
    ].join("\n");
    expect(redactSecretLike(text)).toBe(text);
  });

  it("keeps the userinfo's host readable", () => {
    expect(redactSecretLike("https://deploy:pw@git.example.com/org/repo")).toBe(
      "https://[redacted]@git.example.com/org/repo"
    );
  });

  // Tool output is text a repository or a web page controls, so a hostile 100 KB result must not
  // stall the process.
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
    ["a quoted value of backslashes", `token:"${"\\".repeat(100_000)}`],
    ["a quoted value of escaped quotes", `token:"${'\\"'.repeat(50_000)}`],
    [
      "an escaped quoted value of backslash runs",
      String.raw`token:\"` + String.raw`\\\"`.repeat(25_000),
    ],
    ["a quoted value that ends in a backslash run", `token:"a${"\\".repeat(100_000)}`],
    ["many opening quotes", 'token:"a'.repeat(12_000)],
    ["a signature parameter with a long value", `?sig=${"a".repeat(100_000)}`],
    ["signature parameters with no value", "?sig=&signature=".repeat(20_000)],
    ["a signature name with no equals sign", "&X-Amz-Signature".repeat(20_000)],
    ["stacked signature prefixes", "?&amp;sig=".repeat(20_000)],
  ])("scans %s in linear time", (_label, text) => {
    redactSecretLike("warm up token: abc"); // keep a cold regex compile out of the timing
    const started = performance.now();
    redactSecretLike(text);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
