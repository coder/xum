import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/browser/components/Dialog/Dialog";
import { Button } from "@/browser/components/Button/Button";
import { getBrowserBackendBaseUrl } from "@/browser/utils/backendBaseUrl";
import { getErrorMessage } from "@/common/utils/errors";
import { isAbortError } from "@/browser/utils/isAbortError";
import {
  readPersistedRawString,
  removePersistedStateKeys,
  writePersistedRawString,
} from "@/browser/hooks/usePersistedState";
import { AUTH_TOKEN_KEY } from "@/common/constants/storage";

interface AuthTokenModalProps {
  isOpen: boolean;
  onSubmit: (token: string) => void;
  onSessionAuthenticated?: () => void;
  error?: string | null;
}

interface ServerLoginOptionsResponse {
  githubDeviceFlowEnabled?: boolean;
}

interface GithubLoginStartResponse {
  flowId?: string;
  verificationUri?: string;
  userCode?: string;
  error?: string;
}

// Stored raw (not JSON-encoded): older builds read this key with a raw getItem, so a JSON-quoted
// token would break authentication after a downgrade.
export function getStoredAuthToken(): string | null {
  return readPersistedRawString(AUTH_TOKEN_KEY);
}

export function setStoredAuthToken(token: string): void {
  writePersistedRawString(AUTH_TOKEN_KEY, token);
}

export function clearStoredAuthToken(): void {
  try {
    removePersistedStateKeys([AUTH_TOKEN_KEY]);
  } catch {
    // Ignore storage errors
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function AuthTokenModal(props: AuthTokenModalProps) {
  const [token, setToken] = useState("");
  const [githubDeviceFlowEnabled, setGithubDeviceFlowEnabled] = useState(false);
  const [githubOptionsLoading, setGithubOptionsLoading] = useState(true);

  const [githubLoginStatus, setGithubLoginStatus] = useState<
    "idle" | "starting" | "waiting" | "error"
  >("idle");
  const [githubLoginError, setGithubLoginError] = useState<string | null>(null);
  const [githubUserCode, setGithubUserCode] = useState<string | null>(null);
  const [githubVerificationUri, setGithubVerificationUri] = useState<string | null>(null);

  const waitAbortControllerRef = useRef<AbortController | null>(null);

  const { onSubmit } = props;

  const clearGithubLoginUi = useCallback(() => {
    setGithubLoginStatus("idle");
    setGithubLoginError(null);
    setGithubUserCode(null);
    setGithubVerificationUri(null);

    waitAbortControllerRef.current?.abort();
    waitAbortControllerRef.current = null;
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (token.trim()) {
        setStoredAuthToken(token.trim());
        onSubmit(token.trim());
      }
    },
    [token, onSubmit]
  );

  useEffect(() => {
    if (!props.isOpen) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    setGithubOptionsLoading(true);

    void fetch(`${getBrowserBackendBaseUrl()}/auth/server-login/options`, {
      method: "GET",
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (cancelled) {
          return;
        }

        if (!response.ok) {
          setGithubDeviceFlowEnabled(false);
          setGithubOptionsLoading(false);
          return;
        }

        const payload = await parseJsonResponse<ServerLoginOptionsResponse>(response);
        setGithubDeviceFlowEnabled(payload?.githubDeviceFlowEnabled === true);
        setGithubOptionsLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        if (!isAbortError(error)) {
          setGithubDeviceFlowEnabled(false);
          setGithubOptionsLoading(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [props.isOpen]);

  useEffect(() => {
    return () => {
      waitAbortControllerRef.current?.abort();
    };
  }, []);

  const startGithubLogin = useCallback(async () => {
    clearGithubLoginUi();
    setGithubLoginStatus("starting");

    try {
      const startResponse = await fetch(
        `${getBrowserBackendBaseUrl()}/auth/server-login/github/start`,
        {
          method: "POST",
          credentials: "include",
        }
      );

      const startPayload = await parseJsonResponse<GithubLoginStartResponse>(startResponse);

      if (!startResponse.ok) {
        setGithubLoginStatus("error");
        setGithubLoginError(startPayload?.error ?? "Failed to start GitHub login");
        return;
      }

      const flowId = startPayload?.flowId?.trim();
      const verificationUri = startPayload?.verificationUri?.trim();
      const userCode = startPayload?.userCode?.trim();

      if (!flowId || !verificationUri || !userCode) {
        setGithubLoginStatus("error");
        setGithubLoginError("Server returned an invalid GitHub login response");
        return;
      }

      setGithubLoginStatus("waiting");
      setGithubVerificationUri(verificationUri);
      setGithubUserCode(userCode);

      const waitController = new AbortController();
      waitAbortControllerRef.current = waitController;

      try {
        const waitResponse = await fetch(
          `${getBrowserBackendBaseUrl()}/auth/server-login/github/wait`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            credentials: "include",
            body: JSON.stringify({ flowId }),
            signal: waitController.signal,
          }
        );

        const waitPayload = await parseJsonResponse<{ ok?: boolean; error?: string }>(waitResponse);

        if (!waitResponse.ok || waitPayload?.ok !== true) {
          setGithubLoginStatus("error");
          setGithubLoginError(waitPayload?.error ?? "GitHub login failed");
          return;
        }

        clearStoredAuthToken();
        props.onSessionAuthenticated?.();
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }

        const message = getErrorMessage(error);
        setGithubLoginStatus("error");
        setGithubLoginError(message);
      } finally {
        if (waitAbortControllerRef.current === waitController) {
          waitAbortControllerRef.current = null;
        }
      }
    } catch (error) {
      const message = getErrorMessage(error);
      setGithubLoginStatus("error");
      setGithubLoginError(message);
    }
  }, [clearGithubLoginUi, props]);

  // This modal cannot be dismissed without providing a token/session.
  const handleOpenChange = useCallback(() => {
    // Do nothing - modal cannot be closed without submitting
  }, []);

  return (
    <Dialog open={props.isOpen} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Authentication Required</DialogTitle>
          <DialogDescription>
            This server requires authentication. Enter the token provided at startup, or sign in
            with GitHub when enabled.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {props.error && (
            <div className="bg-error-bg text-error rounded p-2 px-3 text-[13px]">{props.error}</div>
          )}

          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Enter auth token"
            autoFocus
            className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-muted text-foreground rounded border px-3 py-2.5 text-sm focus:outline-none"
          />

          <DialogFooter className="pt-0">
            <Button type="submit" disabled={!token.trim()} className="w-full">
              Connect with token
            </Button>
          </DialogFooter>
        </form>

        {githubOptionsLoading ? null : githubDeviceFlowEnabled ? (
          <div className="border-border-medium space-y-3 border-t pt-3">
            <div className="text-foreground text-sm font-medium">Or login with GitHub</div>

            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  void startGithubLogin();
                }}
                disabled={githubLoginStatus === "starting" || githubLoginStatus === "waiting"}
                className="w-full"
              >
                {githubLoginStatus === "waiting"
                  ? "Waiting for GitHub authorization..."
                  : githubLoginStatus === "starting"
                    ? "Starting GitHub login..."
                    : githubLoginStatus === "error"
                      ? "Retry GitHub login"
                      : "Login with GitHub"}
              </Button>
            </div>

            {githubLoginStatus === "waiting" && githubUserCode ? (
              <div className="bg-background-tertiary space-y-2 rounded-md p-3">
                <p className="text-muted text-xs">Enter this code on GitHub:</p>
                <div className="flex items-center gap-2">
                  <code className="text-foreground text-lg font-bold tracking-widest">
                    {githubUserCode}
                  </code>
                  <Button
                    size="sm"
                    aria-label="Copy and open GitHub verification page"
                    onClick={() => {
                      if (!githubVerificationUri) {
                        return;
                      }

                      const clipboard = navigator.clipboard;
                      if (clipboard?.writeText) {
                        try {
                          void clipboard.writeText(githubUserCode).catch(() => {
                            // Ignore clipboard write failures so login can continue.
                          });
                        } catch {
                          // Ignore clipboard access failures so login can continue.
                        }
                      }

                      window.open(githubVerificationUri, "_blank", "noopener");
                    }}
                    className="h-8 px-3 text-xs"
                    disabled={!githubVerificationUri}
                  >
                    Copy & Open GitHub
                  </Button>
                </div>
                <p className="text-muted inline-flex items-center gap-2 text-xs">
                  <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                  Waiting for authorization...
                </p>
              </div>
            ) : null}

            {githubLoginError ? (
              <p className="text-destructive text-xs">GitHub login failed: {githubLoginError}</p>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
