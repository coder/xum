import { useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Input } from "@/browser/components/Input/Input";
import { useLiveAPI, type APIClient } from "@/browser/contexts/API";
import { DAYTONA_DEFAULT_API_URL } from "@/common/constants/daytona";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
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

/**
 * The saved public config (never the key itself), loaded each time the connection becomes live:
 * while Xum reconnects the last client may stay (and come back), and its calls fail at once.
 * `loads` counts the loads that succeeded: an action's error belongs to the load it ran under.
 */
function useDaytonaPublicConfig(liveApi: APIClient | null) {
  const [config, setConfig] = useState<DaytonaPublicConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    if (!liveApi) return;
    let active = true;
    liveApi.daytona
      .getConfig()
      .then((next) => {
        if (!active) return;
        setConfig(next);
        setLoadError(null);
        setLoads((previous) => previous + 1);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(`Could not load Daytona settings: ${getErrorMessage(error)}`);
      });
    return () => {
      active = false;
    };
  }, [liveApi]);
  return { config, setConfig, loadError, loads };
}

/** A result shown only while no reload superseded the load it ran under. */
interface ActionResult<T> {
  loads: number;
  value: T;
}

function currentResult<T>(result: ActionResult<T> | null, loads: number, fallback: T): T {
  return result !== null && result.loads === loads ? result.value : fallback;
}

const IDLE_TEST: TestState = { status: "idle" };

function useDaytonaConnectionTest(liveApi: APIClient | null, loads: number) {
  const [result, setResult] = useState<ActionResult<TestState> | null>(null);
  const runTest = async () => {
    if (!liveApi) return;
    const settle = (value: TestState) => setResult({ loads, value });
    settle({ status: "testing" });
    try {
      const outcome = await liveApi.daytona.testConnection();
      settle(outcome.ok ? { status: "ok" } : { status: "error", message: outcome.error });
    } catch (testError) {
      settle({ status: "error", message: getErrorMessage(testError) });
    }
  };
  return {
    test: currentResult(result, loads, IDLE_TEST),
    runTest,
    resetTest: () => setResult(null),
  };
}

/**
 * The saved config plus the save and test-connection calls, all on the live client: while Xum
 * reconnects, useAPI() keeps the last client, whose calls fail at once (ConnectionLostError).
 * An error such a call left goes with the reload that follows the reconnect.
 */
function useDaytonaAccess() {
  const liveApi = useLiveAPI();
  const { config, setConfig, loadError, loads } = useDaytonaPublicConfig(liveApi);
  const { test, runTest, resetTest } = useDaytonaConnectionTest(liveApi, loads);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ActionResult<string> | null>(null);

  /** Resolves true when the backend accepted the change. */
  const save = async (input: DaytonaAccessInput): Promise<boolean> => {
    if (!liveApi) return false;
    setSaving(true);
    setSaveError(null);
    resetTest();
    try {
      setConfig(await liveApi.daytona.setConfig(input));
      window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.DAYTONA_CONFIG_CHANGED));
      return true;
    } catch (error) {
      setSaveError({ loads, value: `Could not save Daytona settings: ${getErrorMessage(error)}` });
      return false;
    } finally {
      setSaving(false);
    }
  };

  return {
    loaded: config !== null,
    live: liveApi !== null,
    config,
    saving,
    error: currentResult(saveError, loads, null) ?? loadError,
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
  // An unedited URL may come from DAYTONA_API_URL or the default: saving it would pin it in
  // daytona.json, where it beats later changes to either. So only an edit is sent.
  const edited = (draft: string | null, savedValue: string) =>
    draft !== null && draft.trim() !== savedValue ? draft.trim() : undefined;
  const changes = {
    apiUrl: edited(apiUrlDraft, saved.apiUrl),
    target: edited(targetDraft, saved.target),
  };
  return { apiKey, apiUrl, target, changes, setApiKey, setApiUrl, setTarget, isDirty, reset };
}

/** A blank key field means "keep the saved key"; unedited fields are left out too. */
function toAccessInput(drafts: {
  apiKey: string;
  changes: { apiUrl?: string; target?: string };
}): DaytonaAccessInput {
  const apiKey = drafts.apiKey.trim();
  const { apiUrl, target } = drafts.changes;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(apiUrl !== undefined ? { apiUrl } : {}),
    ...(target !== undefined ? { target } : {}),
  };
}

function AccessField(props: {
  id: string;
  label: string;
  /** Shown beside the label, not inside it, so the field's name stays the label alone. */
  status?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  type?: "password";
}) {
  const statusId = `${props.id}-status`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-muted text-xs" htmlFor={props.id}>
          {props.label}
        </label>
        {props.status != null && (
          <span id={statusId} className="text-foreground text-xs">
            {props.status}
          </span>
        )}
      </div>
      <Input
        id={props.id}
        aria-describedby={props.status != null ? statusId : undefined}
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
  // Offline, edits stay on screen but Save and Test are disabled (as in Secrets): they could
  // not reach the server.
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
        label="API key"
        status={describeKey(access.config)}
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
        disabled={disabled || !access.live}
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
  const resources = useDaytonaResources({ loadSandboxes: false });
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
