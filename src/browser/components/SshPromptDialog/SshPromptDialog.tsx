import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  WarningBox,
  WarningTitle,
  WarningText,
} from "@/browser/components/Dialog/Dialog";
import { Button } from "@/browser/components/Button/Button";
import { Input } from "@/browser/components/Input/Input";
import type { SshPromptEvent, SshPromptRequest } from "@/common/orpc/schemas/ssh";

export function SshPromptDialog() {
  const { api } = useAPI();
  const [pendingQueue, setPendingQueue] = useState<SshPromptRequest[]>([]);
  const pending = pendingQueue[0] ?? null;
  const [responding, setResponding] = useState(false);
  const [credentialInput, setCredentialInput] = useState("");
  // Error reported by the backend for an answer attempt, bound to the request it answered: the
  // prompt can be removed (timeout/another subscriber) while respond() is in flight, and a late
  // failure must not surface on the next queued prompt.
  const [respondFailure, setRespondFailure] = useState<{
    requestId: string;
    message: string;
  } | null>(null);
  const respondError =
    pending && respondFailure?.requestId === pending.requestId ? respondFailure.message : null;

  useEffect(() => {
    if (!api) {
      setPendingQueue([]);
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    // Track the async iterator so we can explicitly close it on cleanup.
    // Some oRPC iterators don't reliably terminate on abort alone;
    // calling return() ensures the backend subscription finally block runs,
    // which releases the responder lease and listener state.
    let iteratorRef: AsyncIterator<SshPromptEvent> | undefined;

    // Global subscription: backend can request SSH host-key or credential prompts at any time.
    // Queue pending requests so concurrent prompts are handled FIFO without drops.
    (async () => {
      try {
        const iterable = await api.ssh.prompt.subscribe(undefined, { signal });
        // Consume and cleanup the same iterator instance —
        // for-await-of would call [Symbol.asyncIterator]() again,
        // creating a second iterator that cleanup can't reach.
        const iterator = iterable[Symbol.asyncIterator]();

        // If cleanup ran while subscribe() was in-flight, close the late
        // iterator now — nobody else will call return() on it.
        if (signal.aborted) {
          void iterator.return?.(undefined);
          return;
        }

        iteratorRef = iterator;

        while (!signal.aborted) {
          const { value: event, done } = await iterator.next();
          if (done) {
            break;
          }

          if (event.type === "removed") {
            // Backend finalized this request (timeout or another subscriber responded).
            setPendingQueue((prev) => prev.filter((item) => item.requestId !== event.requestId));
          } else {
            const { type: _type, ...request } = event;
            setPendingQueue((prev) =>
              prev.some((item) => item.requestId === request.requestId) ? prev : [...prev, request]
            );
          }
        }
      } catch {
        // Subscription closed (cleanup/reconnect): no-op
      }
    })();

    return () => {
      controller.abort();
      void iteratorRef?.return?.(undefined);
      setPendingQueue([]); // Drop stale prompts; reconnect delivers fresh snapshot
    };
  }, [api]);

  useEffect(() => {
    // Each prompt request needs a fresh credential field; carry-over risks sending stale secrets.
    setCredentialInput("");
  }, [pending?.requestId]);

  const respond = async (response: string) => {
    if (!api || !pending || responding) {
      return;
    }

    const requestId = pending.requestId;
    setResponding(true);
    setRespondFailure(null);

    try {
      const result = await api.ssh.prompt.respond({ requestId, response });
      if (!result.success) {
        // An error Result means the backend did not accept the answer: keep the
        // prompt open and show why, so the user can retry instead of losing it.
        setRespondFailure({ requestId, message: result.error });
        return;
      }
      // Dequeue only on success — RPC failure keeps prompt visible for retry.
      setPendingQueue((prev) => prev.filter((item) => item.requestId !== requestId));
    } catch {
      // Transport/RPC failure: keep current request in queue so user can retry.
    } finally {
      setResponding(false);
    }
  };

  // role="alert" announces the failure: focus stays on the clicked button, so a silent notice
  // would make the failed answer look like nothing happened to screen-reader users.
  const respondErrorNotice = respondError ? (
    <div role="alert">
      <WarningBox>
        <WarningTitle>Response failed</WarningTitle>
        <WarningText>{respondError}</WarningText>
      </WarningBox>
    </div>
  ) : null;

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (open || responding || !pending) {
          return;
        }

        // Treat dismiss/escape as an explicit answer so backend unblocks promptly.
        void respond(pending.kind === "host-key" ? "no" : "");
      }}
    >
      <DialogContent maxWidth="500px" showCloseButton={false}>
        {pending?.kind === "host-key" ? (
          <>
            <DialogHeader>
              <DialogTitle>Unknown SSH Host</DialogTitle>
              <DialogDescription>
                {pending.prompt ?? (
                  <>
                    The authenticity of host{" "}
                    <code className="text-foreground font-semibold">{pending.host}</code> cannot be
                    established.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="bg-background-secondary border-border rounded p-3 font-mono text-sm">
              <div className="text-muted">{pending.keyType} key fingerprint:</div>
              <div className="text-foreground mt-1 break-all select-all">{pending.fingerprint}</div>
            </div>

            <WarningBox>
              <WarningTitle>Host Key Verification</WarningTitle>
              <WarningText>Accepting will add the host to your known_hosts file.</WarningText>
            </WarningBox>

            {respondErrorNotice}

            <DialogFooter className="justify-center">
              <Button
                variant="secondary"
                disabled={responding}
                onClick={() => {
                  void respond("no");
                }}
              >
                Reject
              </Button>
              <Button
                variant="default"
                disabled={responding}
                onClick={() => {
                  void respond("yes");
                }}
              >
                {responding ? "Connecting..." : "Accept & Connect"}
              </Button>
            </DialogFooter>
          </>
        ) : pending?.kind === "credential" ? (
          <>
            <DialogHeader>
              <DialogTitle>SSH Authentication Required</DialogTitle>
              <DialogDescription>{pending.prompt}</DialogDescription>
            </DialogHeader>

            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void respond(credentialInput);
              }}
            >
              <Input
                autoFocus
                type={pending.secret ? "password" : "text"}
                value={credentialInput}
                disabled={responding}
                onChange={(event) => {
                  setCredentialInput(event.target.value);
                }}
              />

              {respondErrorNotice}

              <DialogFooter className="justify-center">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={responding}
                  onClick={() => {
                    void respond("");
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="default" disabled={responding}>
                  {responding ? "Submitting..." : "Submit"}
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
