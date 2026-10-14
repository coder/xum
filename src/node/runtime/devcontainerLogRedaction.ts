const SENSITIVE_REMOTE_ENV_KEYS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "CODER_AGENT_TOKEN",
]);

export function redactDevcontainerArgsForLog(args: readonly string[]): string[] {
  const redacted = [...args];

  for (let i = 0; i < redacted.length - 1; i += 1) {
    if (redacted[i] !== "--remote-env") continue;

    const entry = redacted[i + 1] ?? "";
    const [key] = entry.split("=");
    if (SENSITIVE_REMOTE_ENV_KEYS.has(key)) {
      redacted[i + 1] = `${key}=<redacted>`;
    }
  }

  return redacted;
}
