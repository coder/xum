import { useEffect, useState, type ReactNode } from "react";
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

interface DaytonaAccessInput {
  apiKey?: string;
  apiUrl?: string;
  target?: string;
}

function describeKey(config: DaytonaPublicConfig | null): string {
  if (!config) return "Loading...";
  if (!config.apiKeySet) return "Not set";
  return config.apiKeySource === "env" ? "Key set (env)" : "Key set (settings)";
}

type DaytonaApi = NonNullable<ReturnType<typeof useAPI>["api"]>;

/** The saved public config (never the key itself), loaded once per API connection. */
function useDaytonaPublicConfig(api: DaytonaApi | null) {
  const [config, setConfig] = useState<DaytonaPublicConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return;
    let active = true;
    api.daytona
      .getConfig()
      .then((next) => {
        if (active) setConfig(next);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(`Could not load Daytona settings: ${getErrorMessage(error)}`);
      });
    return () => {
      active = false;
    };
  }, [api]);
  return { config, setConfig, loadError };
}

function useDaytonaConnectionTest(api: DaytonaApi | null) {
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const runTest = async () => {
    if (!api) return;
    setTest({ status: "testing" });
    try {
      const result = await api.daytona.testConnection();
      setTest(result.ok ? { status: "ok" } : { status: "error", message: result.error });
    } catch (testError) {
      setTest({ status: "error", message: getErrorMessage(testError) });
    }
  };
  return { test, runTest, resetTest: () => setTest({ status: "idle" }) };
}

/** The saved config plus the save and test-connection calls. */
function useDaytonaAccess() {
  const { api } = useAPI();
  const { config, setConfig, loadError } = useDaytonaPublicConfig(api);
  const { test, runTest, resetTest } = useDaytonaConnectionTest(api);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /** Resolves true when the backend accepted the change. */
  const save = async (input: DaytonaAccessInput): Promise<boolean> => {
    if (!api) return false;
    setSaving(true);
    setSaveError(null);
    resetTest();
    try {
      setConfig(await api.daytona.setConfig(input));
      return true;
    } catch (error) {
      setSaveError(`Could not save Daytona settings: ${getErrorMessage(error)}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return {
    loaded: api != null && config !== null,
    config,
    saving,
    error: saveError ?? loadError,
    test,
    save,
    runTest,
  };
}

/** What the URL and target inputs show while untouched. */
function savedAccessValues(config: DaytonaPublicConfig | null) {
  return { apiUrl: config?.apiUrl ?? DAYTONA_DEFAULT_API_URL, target: config?.target ?? "" };
}

/** Unsaved edits. null = untouched: the URL and target inputs show the saved values. */
function useDaytonaAccessDrafts(config: DaytonaPublicConfig | null) {
  const [apiKey, setApiKey] = useState("");
  const [apiUrlDraft, setApiUrl] = useState<string | null>(null);
  const [targetDraft, setTarget] = useState<string | null>(null);
  const saved = savedAccessValues(config);
  const apiUrl = apiUrlDraft ?? saved.apiUrl;
  const target = targetDraft ?? saved.target;
  const isDirty =
    apiKey.trim() !== "" || apiUrl.trim() !== saved.apiUrl || target.trim() !== saved.target;
  const reset = () => {
    setApiKey("");
    setApiUrl(null);
    setTarget(null);
  };
  return { apiKey, apiUrl, target, setApiKey, setApiUrl, setTarget, isDirty, reset };
}

/** A blank key field means "keep the saved key", so it is left out of the update. */
function toAccessInput(drafts: { apiKey: string; apiUrl: string; target: string }) {
  const apiKey = drafts.apiKey.trim();
  return {
    ...(apiKey ? { apiKey } : {}),
    apiUrl: drafts.apiUrl.trim(),
    target: drafts.target.trim(),
  };
}

function AccessField(props: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  type?: "password";
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-muted text-xs" htmlFor={props.id}>
        {props.label}
      </label>
      <Input
        id={props.id}
        type={props.type}
        autoComplete="off"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        disabled={props.disabled}
        className="min-w-0"
      />
    </div>
  );
}

function AccessActions(props: {
  disabled: boolean;
  dirty: boolean;
  saving: boolean;
  keySet: boolean;
  /** Only a key saved in Settings can be removed here; an env key is not Xum's to drop. */
  canRemoveKey: boolean;
  testing: boolean;
  onSave: () => void;
  onTest: () => void;
  onRemoveKey: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={props.onSave} disabled={props.disabled || !props.dirty}>
        {props.saving ? "Saving..." : "Save"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={props.onTest}
        disabled={props.disabled || !props.keySet || props.testing}
      >
        {props.testing ? <Loader2 className="animate-spin" /> : null}
        Test connection
      </Button>
      {props.canRemoveKey && (
        <Button size="sm" variant="ghost" onClick={props.onRemoveKey} disabled={props.disabled}>
          Remove key
        </Button>
      )}
    </div>
  );
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
  const drafts = useDaytonaAccessDrafts(access.config);
  const disabled = !access.loaded || access.saving;
  const keySet = access.config?.apiKeySet === true;

  const save = async (input: DaytonaAccessInput) => {
    if (await access.save(input)) drafts.reset();
  };

  return (
    <div className="mt-3 flex max-w-[360px] flex-col gap-2" data-testid="daytona-access-form">
      <AccessField
        id="daytona-api-key"
        type="password"
        label={
          <>
            API key <span className="text-foreground">{describeKey(access.config)}</span>
          </>
        }
        value={drafts.apiKey}
        onChange={drafts.setApiKey}
        placeholder={keySet ? "Enter a new key to replace it" : "Paste a Daytona API key"}
        disabled={disabled}
      />
      <AccessField
        id="daytona-api-url"
        label="API URL"
        value={drafts.apiUrl}
        onChange={drafts.setApiUrl}
        placeholder={DAYTONA_DEFAULT_API_URL}
        disabled={disabled}
      />
      <AccessField
        id="daytona-target"
        label="Target (region, optional)"
        value={drafts.target}
        onChange={drafts.setTarget}
        placeholder="Daytona default"
        disabled={disabled}
      />
      <AccessActions
        disabled={disabled}
        keySet={keySet}
        canRemoveKey={access.config?.apiKeySource === "settings"}
        dirty={drafts.isDirty}
        saving={access.saving}
        testing={access.test.status === "testing"}
        onSave={() => void save(toAccessInput(drafts))}
        onTest={() => void access.runTest()}
        onRemoveKey={() => void save({ apiKey: "" })}
      />
      <AccessMessages test={access.test} error={access.error} />
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

/** The Daytona row's body: access in the global scope, defaults in a project scope. */
export function DaytonaRuntimeSettings(props: {
  projectPath: string | null;
  enabled: boolean;
  disabled: boolean;
}) {
  if (!props.projectPath) return <DaytonaAccessForm />;
  if (!props.enabled) return null;
  return (
    <DaytonaDefaultsForm
      key={props.projectPath}
      projectPath={props.projectPath}
      disabled={props.disabled}
    />
  );
}
