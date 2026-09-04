import { useEffect, type ReactNode } from "react";
import { AlertCircle, Loader2, MonitorOff } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { assertNever } from "@/common/utils/assertNever";
import { useDesktopConnection, type UseDesktopConnectionResult } from "./useDesktopConnection";

interface StatusPresentation {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}

function getStatusPresentation(desktop: UseDesktopConnectionResult): StatusPresentation {
  switch (desktop.state) {
    case "checking":
      return {
        icon: <Loader2 aria-hidden className="h-5 w-5 animate-spin" />,
        title: "Checking desktop availability",
        description: "Starting desktop session…",
      };
    case "connecting":
      return {
        icon: <Loader2 aria-hidden className="h-5 w-5 animate-spin" />,
        title: "Connecting to desktop",
        description: "Establishing the live desktop stream…",
      };
    case "unavailable":
      return {
        icon: <MonitorOff aria-hidden className="h-8 w-8" />,
        title: "Desktop unavailable",
        description: desktop.reason ?? "Desktop sessions are unavailable for this workspace.",
      };
    case "disconnected":
      return {
        icon: <Loader2 aria-hidden className="h-5 w-5 animate-spin" />,
        title: "Reconnecting…",
        description: "Refreshing the desktop connection with a new session token.",
      };
    case "error":
      return {
        icon: <AlertCircle aria-hidden className="text-destructive h-8 w-8" />,
        title: "Desktop connection failed",
        description: desktop.reason ?? "An unexpected desktop connection error occurred.",
        action: (
          <Button onClick={desktop.connect} size="sm" variant="outline">
            Retry
          </Button>
        ),
      };
    case "idle":
      return {
        icon: <Loader2 aria-hidden className="h-5 w-5 animate-spin" />,
        title: "Preparing desktop",
        description: "Waiting to connect to the live desktop.",
      };
    case "connected":
      return {
        icon: null,
        title: "",
        description: "",
      };
    default:
      return assertNever(desktop.state);
  }
}

function StatusOverlay(props: { desktop: UseDesktopConnectionResult }) {
  const presentation = getStatusPresentation(props.desktop);

  return (
    <div className="bg-background text-foreground flex h-full flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      {presentation.icon}
      <div className="space-y-1">
        <p className="text-sm font-medium">{presentation.title}</p>
        <p className="text-muted-foreground text-sm">{presentation.description}</p>
      </div>
      {presentation.action}
    </div>
  );
}

export function DesktopPanel(props: { workspaceId: string }) {
  // A workspace switch must dispose the old viewer, token, and shared-target label together.
  return <WorkspaceDesktopPanel key={props.workspaceId} workspaceId={props.workspaceId} />;
}

function WorkspaceDesktopPanel(props: { workspaceId: string }) {
  const desktop = useDesktopConnection(props.workspaceId);

  useEffect(() => {
    desktop.connect();
    // disconnect handled by hook's own cleanup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="bg-background flex h-full min-w-0 flex-col">
      {desktop.sharedDesktop && (
        <div className="text-muted-foreground border-border shrink-0 truncate border-b px-3 py-1.5 text-xs">
          Shared desktop · {desktop.sharedDesktop.ownerName}
        </div>
      )}
      {desktop.state === "connected" ? null : <StatusOverlay desktop={desktop} />}
      <div
        ref={desktop.containerRef}
        className="bg-background flex-1 overflow-hidden"
        style={{ display: desktop.state === "connected" ? "block" : "none" }}
      />
    </div>
  );
}
