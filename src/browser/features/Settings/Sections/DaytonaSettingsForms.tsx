import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Input } from "@/browser/components/Input/Input";
import { useAPI } from "@/browser/contexts/API";
import { DAYTONA_DEFAULT_API_URL } from "@/common/constants/daytona";
import type { DaytonaPublicConfig } from "@/common/orpc/schemas/daytona";
import { getErrorMessage } from "@/common/utils/errors";
import { DaytonaSandboxForm } from "@/browser/features/Runtime/DaytonaControls";
import { useDaytonaResources } from "@/browser/hooks/useDaytonaResources";
import {
  readDaytonaOptionDefaults,
  updateRuntimeOptionDefaults,
  useRuntimeOptionDefaults,
  writeDaytonaOptionDefaults,
} from "@/browser/utils/runtimeOptionDefaults";

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

/**
 * Daytona access for this Xum install (global scope). The key is write-only: the backend
 * never returns it, so the field only ever holds a new key the user is typing. Stored in its
 * own 0600 file, never in Secrets, which agent turns and terminals receive.
 */
export function DaytonaAccessForm() {
  const { api } = useAPI();
  const [config, setConfig] = useState<DaytonaPublicConfig | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  // null = untouched: the inputs show the saved values.
  const [apiUrlDraft, setApiUrlDraft] = useState<string | null>(null);
  const [targetDraft, setTargetDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const savedUrl = config?.apiUrl ?? DAYTONA_DEFAULT_API_URL;
  const savedTarget = config?.target ?? "";
  const apiUrlValue = apiUrlDraft ?? savedUrl;
  const targetValue = targetDraft ?? savedTarget;
  const isDirty =
    apiKeyDraft.trim() !== "" ||
    apiUrlValue.trim() !== savedUrl ||
    targetValue.trim() !== savedTarget;

  const save = async (input: { apiKey?: string; apiUrl?: string; target?: string }) => {
    if (!api) return;
    setSaving(true);
    setError(null);
    setTest({ status: "idle" });
    try {
      setConfig(await api.daytona.setConfig(input));
      setApiKeyDraft("");
      setApiUrlDraft(null);
      setTargetDraft(null);
    } catch (saveError) {
      setError(`Could not save Daytona settings: ${getErrorMessage(saveError)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    void save({
      ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft.trim() } : {}),
      apiUrl: apiUrlValue.trim(),
      target: targetValue.trim(),
    });
  };

  const handleTest = async () => {
    if (!api) return;
    setTest({ status: "testing" });
    try {
      const result = await api.daytona.testConnection();
      setTest(result.ok ? { status: "ok" } : { status: "error", message: result.error });
    } catch (testError) {
      setTest({ status: "error", message: getErrorMessage(testError) });
    }
  };

  const disabled = !api || config === null || saving;

  return (
    <div className="mt-3 flex max-w-[360px] flex-col gap-2" data-testid="daytona-access-form">
      <div className="flex flex-col gap-1">
        <label className="text-muted text-xs" htmlFor="daytona-api-key">
          API key <span className="text-foreground">{describeKey(config)}</span>
        </label>
        <Input
          id="daytona-api-key"
          type="password"
          autoComplete="off"
          value={apiKeyDraft}
          onChange={(event) => setApiKeyDraft(event.target.value)}
          placeholder={
            config?.apiKeySet ? "Enter a new key to replace it" : "Paste a Daytona API key"
          }
          disabled={disabled}
          className="min-w-0"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-muted text-xs" htmlFor="daytona-api-url">
          API URL
        </label>
        <Input
          id="daytona-api-url"
          value={apiUrlValue}
          onChange={(event) => setApiUrlDraft(event.target.value)}
          placeholder={DAYTONA_DEFAULT_API_URL}
          disabled={disabled}
          className="min-w-0"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-muted text-xs" htmlFor="daytona-target">
          Target (region, optional)
        </label>
        <Input
          id="daytona-target"
          value={targetValue}
          onChange={(event) => setTargetDraft(event.target.value)}
          placeholder="Daytona default"
          disabled={disabled}
          className="min-w-0"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={disabled || !isDirty}>
          {saving ? "Saving..." : "Save"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleTest()}
          disabled={disabled || config?.apiKeySet !== true || test.status === "testing"}
        >
          {test.status === "testing" ? <Loader2 className="animate-spin" /> : null}
          Test connection
        </Button>
        {config?.apiKeySource === "settings" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void save({ apiKey: "" })}
            disabled={disabled}
          >
            Remove key
          </Button>
        )}
      </div>
      {test.status === "ok" && (
        <p role="status" className="text-success-text flex items-center gap-1.5 text-xs">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          Connected: the API key works.
        </p>
      )}
      {test.status === "error" && (
        <p role="alert" className="flex items-start gap-1.5 text-xs break-words text-red-500">
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {test.message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs break-words text-red-500">
          {error}
        </p>
      )}
      <p className="text-muted/70 text-[11px]">
        Without a key here, Xum uses DAYTONA_API_KEY and DAYTONA_API_URL from its own environment.
      </p>
    </div>
  );
}

/**
 * Project defaults for new Daytona workspaces (snapshot and size), saved with the project's
 * other runtime option defaults so the creation controls start from them.
 */
export function DaytonaDefaultsForm(props: { projectPath: string; disabled?: boolean }) {
  const resources = useDaytonaResources({ enabled: true, loadSandboxes: false });
  const defaults = readDaytonaOptionDefaults(useRuntimeOptionDefaults(props.projectPath));
  return (
    <DaytonaSandboxForm
      className="mt-3 max-w-[360px]"
      config={defaults}
      onConfigChange={(next) =>
        updateRuntimeOptionDefaults(props.projectPath, (prev) =>
          writeDaytonaOptionDefaults(prev, next)
        )
      }
      resources={resources}
      allowExisting={false}
      disabled={props.disabled}
    />
  );
}
