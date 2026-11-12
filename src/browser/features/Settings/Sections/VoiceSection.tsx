import { Download, Trash2 } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { useVoiceModel } from "@/browser/hooks/useVoiceModel";
import { localVoiceStore, supportsLocalVoice } from "@/browser/stores/LocalVoiceStore";
import {
  LOCAL_VOICE_MODELS,
  LOCAL_VOICE_MODEL_IDS,
  LOCAL_VOICE_MAX_SECONDS,
} from "@/common/constants/localVoiceModels";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { getErrorMessage } from "@/common/utils/errors";
import { useState } from "react";

export function VoiceSection() {
  const { model, setModel, state } = useVoiceModel();
  const { setActiveSection } = useSettings();
  const [error, setError] = useState<string | null>(null);
  const supported = supportsLocalVoice();

  const run = (operation: Promise<void>) => {
    setError(null);
    operation.catch((cause: unknown) => setError(getErrorMessage(cause)));
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div>
        <h3 className="text-foreground mb-2 text-sm font-medium">Voice input</h3>
        <p className="text-muted text-xs">
          Choose local speech recognition or OpenAI cloud transcription. This choice applies to this
          device.
        </p>
        <p className="text-muted mobile-hide-shortcut-hints mt-2 text-xs">
          Press {formatKeybind(KEYBINDS.TOGGLE_VOICE_INPUT)} to start or stop dictation.
        </p>
      </div>
      {(error ?? state.error) && (
        <p role="alert" className="text-error text-xs">
          {error ?? state.error}
        </p>
      )}
      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="text-foreground mb-2 text-sm font-medium">On this device</legend>
        <p className="text-muted text-xs">
          Download a model once. Audio stays on this device, including when you connect to a remote
          Xum server. Local mode never falls back to OpenAI. Models need several GB of free memory.
          Recordings can last up to {LOCAL_VOICE_MAX_SECONDS} seconds.
        </p>
        <p className="text-muted text-xs">
          Downloads use Hugging Face. Your browser or app profile stores the models. Clearing site
          data removes them.
        </p>
        {!supported && (
          <p role="status" className="text-warning text-xs">
            Local models require a browser with WebAssembly, storage, and workers. Use HTTPS or
            localhost.
          </p>
        )}
        {LOCAL_VOICE_MODEL_IDS.map((id) => {
          const entry = LOCAL_VOICE_MODELS[id];
          const ready = state.downloaded.includes(id);
          const operation = state.operation?.id === id ? state.operation : null;
          const total = entry.files.reduce((sum, file) => sum + file.bytes, 0);
          return (
            <div
              key={id}
              className="border-border-light flex min-w-0 flex-wrap items-center gap-3 rounded-md border p-3"
            >
              <label className="flex min-w-0 flex-1 basis-48 items-start gap-3">
                <input
                  type="radio"
                  name="voice-model"
                  value={id}
                  checked={model === id}
                  disabled={!supported || !ready || !!state.operation}
                  onChange={() => setModel(id)}
                  className="accent-accent mt-1"
                />
                <span className="min-w-0 text-sm">
                  {entry.name}
                  <span className="text-muted mt-1 block text-xs">
                    {entry.languages} · {Math.round(total / 1_000_000)} MB
                  </span>
                  <a
                    className="text-muted mt-1 block text-xs underline"
                    href={`https://huggingface.co/${entry.repo}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    NVIDIA model · CC BY 4.0
                  </a>
                </span>
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {operation?.kind === "download" ? (
                  <>
                    <span role="status" className="text-muted counter-nums text-xs">
                      {Math.floor((operation.bytes / total) * 100)}%
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => localVoiceStore.cancelDownload()}
                    >
                      Cancel download
                    </Button>
                  </>
                ) : ready ? (
                  <>
                    <span className="text-muted text-xs">
                      {model === id ? "Selected" : "Downloaded"}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`Remove ${entry.name}`}
                      disabled={!!state.operation}
                      onClick={() => run(localVoiceStore.remove(id))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!supported || state.loading || !!state.operation}
                    aria-label={`Download ${entry.name}`}
                    onClick={() => run(localVoiceStore.download(id))}
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {model !== "openai" && !state.loading && (!model || !state.downloaded.includes(model)) && (
          <p role="status" className="text-warning text-xs">
            Download and select a local model, or select OpenAI to enable voice input.
          </p>
        )}
      </fieldset>
      <fieldset className="min-w-0">
        <legend className="text-foreground mb-2 text-sm font-medium">Cloud</legend>
        <label className="border-border-light flex items-start gap-3 rounded-md border p-3">
          <input
            type="radio"
            name="voice-model"
            value="openai"
            checked={model === "openai"}
            onChange={() => setModel("openai")}
            className="accent-accent mt-1"
          />
          <span className="text-sm">
            OpenAI Whisper
            <span className="text-muted mt-1 block text-xs">
              Sends audio to your configured OpenAI provider. Requires an API key. Provider charges
              apply.
            </span>
          </span>
        </label>
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => setActiveSection("providers")}
        >
          Open provider settings
        </Button>
      </fieldset>
    </div>
  );
}
