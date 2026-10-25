import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Input } from "@/browser/components/Input/Input";
import { useAPI } from "@/browser/contexts/API";
import type { DaytonaPublicConfig } from "@/common/orpc/schemas/daytona";
import { getErrorMessage } from "@/common/utils/errors";

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok" }
  | { status: "error"; message: string };

function describeKey(config: DaytonaPublicConfig | null): string {
  if (!config) return "Loading...";
  if (!config.apiKeySet) return "Not set";
  return config.apiKeySource === "env" ? "Key set (env)" : "Key set (settings)";
}

/** The saved public config (never the key itself) plus the save and test-connection calls. */
function useDaytonaAccess() {
  const { api } = useAPI();
  const [config, setConfig] = useState<DaytonaPublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  useEffect(() => {
    if (!api) return;
    let active = true;
    api.daytona
      .getConfig()
      .then((next) => {
        if (active) setConfig(next);
      })
      .catch((loadError: unknown) => {
        if (active) setError(`Could not load Daytona settings: ${getErrorMessage(loadError)}`);
      });
    return () => {
      active = false;
    };
  }, [api]);

  /** Resolves true when the backend accepted the key. */
  const save = async (apiKey: string): Promise<boolean> => {
    if (!api) return false;
    setSaving(true);
    setError(null);
    setTest({ status: "idle" });
    try {
      setConfig(await api.daytona.setConfig({ apiKey }));
      return true;
    } catch (saveError) {
      setError(`Could not save Daytona settings: ${getErrorMessage(saveError)}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (!api) return;
    setTest({ status: "testing" });
    try {
      const outcome = await api.daytona.testConnection();
      setTest(outcome.ok ? { status: "ok" } : { status: "error", message: outcome.error });
    } catch (testError) {
      setTest({ status: "error", message: getErrorMessage(testError) });
    }
  };

  return { api, config, saving, error, test, save, runTest };
}

function AccessMessages(props: { test: TestState; error: string | null }) {
  return (
    <>
      {props.test.status === "ok" && (
        <p role="status" className="text-success-text flex items-center gap-1.5 text-xs">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          Connected: the API key works.
        </p>
      )}
      {props.test.status === "error" && (
        <p role="alert" className="flex items-start gap-1.5 text-xs break-words text-red-500">
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {props.test.message}
        </p>
      )}
      {props.error && (
        <p role="alert" className="text-xs break-words text-red-500">
          {props.error}
        </p>
      )}
    </>
  );
}

/**
 * Daytona access for this Xum install (global scope). The key is write-only: the backend
 * never returns it, so the field only ever holds a new key the user is typing. Stored in its
 * own 0600 file, never in Secrets, which agent turns and terminals receive.
 */
export function DaytonaAccessForm() {
  const access = useDaytonaAccess();
  const [apiKey, setApiKey] = useState("");
  const disabled = !access.config || access.saving || !access.api;
  const keySet = access.config?.apiKeySet === true;

  const save = async (value: string) => {
    if (await access.save(value)) setApiKey("");
  };

  return (
    <div className="mt-3 flex max-w-[360px] flex-col gap-2" data-testid="daytona-access-form">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <label className="text-muted text-xs" htmlFor="daytona-api-key">
            API key
          </label>
          {/* Beside the label, not inside it, so the field's name stays the label alone. */}
          <span id="daytona-api-key-status" className="text-foreground text-xs">
            {describeKey(access.config)}
          </span>
        </div>
        <Input
          id="daytona-api-key"
          aria-describedby="daytona-api-key-status"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={keySet ? "Enter a new key to replace it" : "Paste a Daytona API key"}
          disabled={disabled}
          className="min-w-0"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => void save(apiKey.trim())}
          disabled={disabled || apiKey.trim() === ""}
        >
          {access.saving ? "Saving..." : "Save"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void access.runTest()}
          disabled={disabled || !keySet || access.test.status === "testing"}
        >
          {access.test.status === "testing" ? <Loader2 className="animate-spin" /> : null}
          Test connection
        </Button>
        {/* Only a key saved in Settings can be removed here; an env key is not Xum's to drop. */}
        {access.config?.apiKeySource === "settings" && (
          <Button size="sm" variant="ghost" onClick={() => void save("")} disabled={disabled}>
            Remove key
          </Button>
        )}
      </div>
      <AccessMessages test={access.test} error={access.error} />
      <p className="text-muted/70 text-[11px]">
        Without a key here, Xum uses DAYTONA_API_KEY from its own environment. DAYTONA_API_URL and
        DAYTONA_TARGET there pick a self-hosted deployment and a default region.
      </p>
    </div>
  );
}
