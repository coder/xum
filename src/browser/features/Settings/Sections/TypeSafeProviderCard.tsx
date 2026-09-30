import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "@/browser/components/Button/Button";
import { Input } from "@/browser/components/Input/Input";
import { ProviderIcon } from "@/browser/components/ProviderIcon/ProviderIcon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/browser/components/Tooltip/Tooltip";
import { useAPI } from "@/browser/contexts/API";
import { useAutoModelRouting } from "@/browser/hooks/useAutoModelRouting";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import {
  splitAutoModelRoutingEvaluationModel,
  type AutoModelRoutingEvaluationStatus,
} from "@/common/types/autoModelRouting";
import { getErrorMessage } from "@/common/utils/errors";
import {
  DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
  TYPESAFE_API_KEY_ENV_VARS,
  TYPESAFE_PROVIDER_KEY,
} from "@/constants/autoModelRouting";

interface TypeSafeProviderCardProps {
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Providers-section row for the TypeSafe evaluation credential. TypeSafe serves no chat
 * models, so it stays out of PROVIDER_DEFINITIONS and the generic provider rows; the
 * auto-model-routing experiment only reads the key that is managed here.
 */
export function TypeSafeProviderCard(props: TypeSafeProviderCardProps) {
  const { api } = useAPI();
  const { config: providersConfig } = useProvidersConfig();
  const { config: routingConfig } = useAutoModelRouting();
  const [status, setStatus] = useState<AutoModelRoutingEvaluationStatus | null>(null);
  // Bumped after a key write so the status re-checks without waiting for a config event.
  const [statusRefresh, setStatusRefresh] = useState(0);
  // The write and its outcome live here, not in the editor: collapsing the card mid-write
  // unmounts the editor, and a rejection must still be visible on the next expand.
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const writeKey = async (value: string): Promise<boolean> => {
    if (!api) return false;
    setKeyBusy(true);
    setKeyError(null);
    try {
      const result = await api.providers.setProviderConfig({
        provider: TYPESAFE_PROVIDER_KEY,
        keyPath: ["apiKey"],
        value,
      });
      if (!result.success) {
        setKeyError(result.error);
        return false;
      }
      setStatusRefresh((count) => count + 1);
      return true;
    } catch (error) {
      setKeyError(getErrorMessage(error));
      return false;
    } finally {
      setKeyBusy(false);
    }
  };

  // Probe the TypeSafe evaluator the user actually saved: an enforced policy can allow that
  // model while denying the default one, and the credential is usable either way.
  const probeModel =
    splitAutoModelRoutingEvaluationModel(routingConfig.evaluationModel).provider ===
    TYPESAFE_PROVIDER_KEY
      ? routingConfig.evaluationModel
      : DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL;

  // The backend resolves the key from providers.jsonc, the key file, or env vars, so the
  // evaluator status is the one source of truth for "configured".
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.config
      .getAutoModelRoutingEvaluationStatus({ evaluationModel: probeModel })
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, probeModel, statusRefresh, providersConfig]);

  const configured = status?.available === true;
  const statusTitle = status == null ? "Checking" : configured ? "Configured" : "Not configured";

  return (
    <div
      className="border-border-medium bg-background-secondary overflow-hidden rounded-md border"
      data-typesafe-provider
    >
      <Button
        variant="ghost"
        onClick={props.onToggle}
        className="flex h-auto w-full items-center justify-between rounded-none px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3">
          {props.expanded ? (
            <ChevronDown className="text-muted h-4 w-4" />
          ) : (
            <ChevronRight className="text-muted h-4 w-4" />
          )}
          <span className="text-foreground inline-flex items-center gap-1 text-sm font-medium whitespace-nowrap">
            <ProviderIcon provider={TYPESAFE_PROVIDER_KEY} />
            <span>TypeSafe</span>
          </span>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className={`h-2 w-2 rounded-full ${configured ? "bg-success" : "bg-border-medium"}`}
              />
            </TooltipTrigger>
            <TooltipContent side="bottom">{statusTitle}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </Button>

      {props.expanded && (
        <TypeSafeKeyEditor status={status} busy={keyBusy} error={keyError} onWrite={writeKey} />
      )}
    </div>
  );
}

/**
 * Mounted only while the card is expanded so that collapsing it (or opening another
 * provider) discards an unsaved key instead of restoring it on the next expand.
 */
function TypeSafeKeyEditor(props: {
  status: AutoModelRoutingEvaluationStatus | null;
  busy: boolean;
  error: string | null;
  onWrite: (value: string) => Promise<boolean>;
}) {
  const [keyDraft, setKeyDraft] = useState("");

  const writeKey = async (value: string) => {
    if (await props.onWrite(value)) setKeyDraft("");
  };

  const configured = props.status?.available === true;

  return (
    <div className="border-border-medium space-y-3 border-t px-4 py-3">
      <div className="text-muted text-xs">
        Evaluation-only credential for Auto model and thinking routing. Also read from{" "}
        {TYPESAFE_API_KEY_ENV_VARS.join(", ")}.
      </div>
      <div className="space-y-1">
        <label className="text-foreground block text-xs font-medium" htmlFor="typesafe-api-key">
          API Key
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            id="typesafe-api-key"
            type="password"
            autoComplete="off"
            value={keyDraft}
            placeholder="Enter API key"
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              setKeyDraft(event.target.value)
            }
            onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
              if (event.key === "Enter" && keyDraft.trim().length > 0) {
                void writeKey(keyDraft.trim());
              }
            }}
            className="border-border-medium bg-modal-bg h-9 min-w-0 flex-1"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={props.busy || keyDraft.trim().length === 0}
              onClick={() => void writeKey(keyDraft.trim())}
            >
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={props.busy}
              onClick={() => void writeKey("")}
            >
              Clear
            </Button>
          </div>
        </div>
        <div
          className={
            configured || props.status == null ? "text-muted text-xs" : "text-danger-light text-xs"
          }
          data-typesafe-provider-status
        >
          {props.status == null
            ? "Checking..."
            : configured
              ? "Configured"
              : (props.status.reason ?? "Not configured")}
        </div>
        {props.error ? <div className="text-danger-light text-xs">{props.error}</div> : null}
      </div>
    </div>
  );
}
