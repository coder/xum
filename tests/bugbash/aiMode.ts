/**
 * Bug-bash AI mode: does the app under test talk to a real AI provider, or to the mock?
 *
 * BUGBASH_AI picks the mode:
 * - `auto` (default): real when the app model's provider has a key and answers a 1-token probe,
 *   otherwise the mock. Only a missing key or an unreachable or overloaded upstream falls back. A
 *   rejected key or a bad model fails the run, so a broken setup never passes as a mock run.
 * - `real`: real or fail; no fallback.
 * - `mock`: XUM_MOCK_AI (canned replies, `[mock:...]` scripted flows).
 *
 * BUGBASH_APP_MODEL (`<provider>:<model>`, default Haiku 4.5) is the app's model. Its provider
 * reads the standard variables (ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL, OPENAI_API_KEY and
 * OPENAI_BASE_URL); base URLs include `/v1`.
 *
 * The probe runs once: run.ts and the Makefile resolve the mode, then pass the result to every app
 * start as BUGBASH_AI_RESOLVED (`real` or `mock`) and BUGBASH_AI_REASON, so one run never mixes
 * modes by accident.
 */

export type AiMode =
  | { mode: "mock"; reason: string }
  | {
      mode: "real";
      reason: string;
      provider: "anthropic" | "openai";
      /** Full model string as Xum takes it, for example `anthropic:claude-haiku-4-5`. */
      model: string;
      apiKey: string;
      baseUrl: string;
    };

export const DEFAULT_APP_MODEL = "anthropic:claude-haiku-4-5";
const PROBE_TIMEOUT_MS = 10_000;

const PROVIDERS = {
  anthropic: {
    keyVar: "ANTHROPIC_API_KEY",
    urlVar: "ANTHROPIC_BASE_URL",
    url: "https://api.anthropic.com/v1",
  },
  openai: { keyVar: "OPENAI_API_KEY", urlVar: "OPENAI_BASE_URL", url: "https://api.openai.com/v1" },
} as const;

type Env = Record<string, string | undefined>;
type RealSettings = Omit<Extract<AiMode, { mode: "real" }>, "mode" | "reason">;

/** Thrown when the requested mode cannot run: the run must stop, not fall back. */
export class AiModeError extends Error {}

function appSettings(env: Env): RealSettings | { missing: string } {
  const model = env.BUGBASH_APP_MODEL ?? DEFAULT_APP_MODEL;
  const separator = model.indexOf(":");
  const provider = model.slice(0, separator);
  if (separator <= 0 || model.length === separator + 1 || !(provider in PROVIDERS)) {
    throw new AiModeError(
      `BUGBASH_APP_MODEL must be anthropic:<model> or openai:<model>, got "${model}"`
    );
  }
  const spec = PROVIDERS[provider as keyof typeof PROVIDERS];
  const apiKey = env[spec.keyVar];
  if (apiKey == null || apiKey === "") return { missing: spec.keyVar };
  const baseUrl = (env[spec.urlVar] ?? spec.url).replace(/\/+$/, "");
  return { provider: provider as keyof typeof PROVIDERS, model, apiKey, baseUrl };
}

type ProbeResult = { ok: true } | { ok: false; unavailable: boolean; detail: string };

/** One smallest-possible request: does the key work and is the upstream up? */
async function probe(settings: RealSettings): Promise<ProbeResult> {
  const modelId = settings.model.slice(settings.model.indexOf(":") + 1);
  const request =
    settings.provider === "anthropic"
      ? {
          url: `${settings.baseUrl}/messages`,
          headers: {
            "content-type": "application/json",
            "x-api-key": settings.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: { model: modelId, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
        }
      : {
          url: `${settings.baseUrl}/chat/completions`,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${settings.apiKey}`,
          },
          body: {
            model: modelId,
            max_completion_tokens: 16,
            messages: [{ role: "user", content: "ping" }],
          },
        };
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) return { ok: true };
    const text = (await response.text()).slice(0, 200).replace(/\s+/g, " ");
    // Overloaded, rate limited or down: the upstream is unavailable. Anything else (401, 403,
    // 404, 400) is a setup error that a mock run would only hide.
    const unavailable = response.status === 429 || response.status >= 500;
    return {
      ok: false,
      unavailable,
      detail: `HTTP ${response.status} from ${request.url}: ${text}`,
    };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, unavailable: true, detail: `${request.url} unreachable (${detail})` };
  }
}

/** Resolves the mode once; throws AiModeError when the run must stop. */
export async function resolveAiMode(env: Env = process.env): Promise<AiMode> {
  const resolved = env.BUGBASH_AI_RESOLVED;
  if (resolved != null) {
    const reason = env.BUGBASH_AI_REASON ?? "resolved by the caller";
    if (resolved === "mock") return { mode: "mock", reason };
    if (resolved !== "real")
      throw new AiModeError(`BUGBASH_AI_RESOLVED must be real or mock, got "${resolved}"`);
    const settings = appSettings(env);
    if ("missing" in settings)
      throw new AiModeError(`BUGBASH_AI_RESOLVED=real but ${settings.missing} is not set`);
    return { mode: "real", reason, ...settings };
  }

  const requested = env.BUGBASH_AI ?? "auto";
  if (requested === "mock") return { mode: "mock", reason: "BUGBASH_AI=mock" };
  if (requested !== "auto" && requested !== "real") {
    throw new AiModeError(`BUGBASH_AI must be auto, real or mock, got "${requested}"`);
  }
  const settings = appSettings(env);
  if ("missing" in settings) {
    if (requested === "real")
      throw new AiModeError(`BUGBASH_AI=real but ${settings.missing} is not set`);
    return { mode: "mock", reason: `${settings.missing} is not set` };
  }
  const result = await probe(settings);
  if (result.ok)
    return { mode: "real", reason: `${settings.model} answered the probe`, ...settings };
  if (requested === "auto" && result.unavailable) {
    return { mode: "mock", reason: `upstream unavailable: ${result.detail}` };
  }
  throw new AiModeError(
    `${settings.model} probe failed: ${result.detail}. Fix the key or base URL, or set BUGBASH_AI=mock.`
  );
}

/** The environment that hands a resolved mode to app starts (startApp.ts). */
export function aiModeEnv(mode: AiMode): {
  BUGBASH_AI_RESOLVED: string;
  BUGBASH_AI_REASON: string;
} {
  return { BUGBASH_AI_RESOLVED: mode.mode, BUGBASH_AI_REASON: mode.reason };
}

// `bun tests/bugbash/aiMode.ts` prints shell exports for one resolved mode (the Makefile uses it
// so a repro run probes once). The mode and reason go to stderr for the log.
if (import.meta.main) {
  try {
    const mode = await resolveAiMode();
    console.error(`[bugbash] app AI: ${mode.mode} (${mode.reason})`);
    const vars = aiModeEnv(mode);
    for (const [name, value] of Object.entries(vars)) {
      console.log(`export ${name}='${value.replace(/'/g, "'\\''")}'`);
    }
  } catch (error) {
    console.error(`[bugbash] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
