import { useEffect } from "react";
import {
  Blocks,
  Brain,
  Settings,
  Key,
  Cpu,
  X,
  FlaskConical,
  Bot,
  Keyboard,
  Layout,
  Container,
  Shield,
  ShieldCheck,
  Server,
  Monitor,
  Lock,
  ArchiveRestore,
  ScrollText,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/browser/components/Dialog/Dialog";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useOnboardingPause } from "@/browser/features/SplashScreens/SplashScreenProvider";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { useModalFocusReturn } from "@/browser/hooks/useModalFocusReturn";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { GeneralSection } from "./Sections/GeneralSection";
import { TasksSection } from "./Sections/TasksSection";
import { ProvidersSection } from "./Sections/ProvidersSection";
import { ModelsSection } from "./Sections/ModelsSection";
import { GovernorSection } from "./Sections/GovernorSection";
import { MemorySection } from "./Sections/MemorySection";
import { Button } from "@/browser/components/Button/Button";
import { MCPSettingsSection } from "./Sections/MCPSettingsSection";
import { PluginsSettingsSection } from "./Sections/PluginsSettingsSection";
import { SecretsSection } from "./Sections/SecretsSection";
import { InstructionsSection } from "./Sections/InstructionsSection";
import { LayoutsSection } from "./Sections/LayoutsSection";
import { RuntimesSection } from "./Sections/RuntimesSection";
import { ExperimentsSection } from "./Sections/ExperimentsSection";
import { ServerAccessSection } from "./Sections/ServerAccessSection";
import { RemoteConnectionSection } from "./Sections/RemoteConnectionSection";
import { KeybindsSection } from "./Sections/KeybindsSection";
import { SecuritySection } from "./Sections/SecuritySection";
import { BackupSection } from "./Sections/BackupSection";
import type { SettingsSection } from "./types";

const LEGACY_EXPERIMENT_SETTINGS_SECTION_IDS = new Set(["goals", "heartbeat"]);

const BASE_SECTIONS: SettingsSection[] = [
  {
    id: "general",
    label: "General",
    icon: <Settings className="h-4 w-4" />,
    component: GeneralSection,
  },
  {
    id: "tasks",
    label: "Agents",
    icon: <Bot className="h-4 w-4" />,
    component: TasksSection,
  },
  {
    id: "instructions",
    label: "Instructions",
    icon: <ScrollText className="h-4 w-4" />,
    component: InstructionsSection,
  },
  {
    id: "providers",
    label: "Providers",
    icon: <Key className="h-4 w-4" />,
    component: ProvidersSection,
  },
  {
    id: "models",
    label: "Models",
    icon: <Cpu className="h-4 w-4" />,
    component: ModelsSection,
  },
  {
    id: "mcp",
    label: "MCP",
    icon: <Server className="h-4 w-4" />,
    component: MCPSettingsSection,
  },
  {
    id: "secrets",
    label: "Secrets",
    icon: <Lock className="h-4 w-4" />,
    component: SecretsSection,
  },
  {
    id: "security",
    label: "Security",
    icon: <ShieldCheck className="h-4 w-4" />,
    component: SecuritySection,
  },
  {
    id: "server-access",
    label: "Server Access",
    icon: <Shield className="h-4 w-4" />,
    component: ServerAccessSection,
  },
  {
    id: "layouts",
    label: "Layouts",
    icon: <Layout className="h-4 w-4" />,
    component: LayoutsSection,
  },
  {
    id: "runtimes",
    label: "Runtimes",
    icon: <Container className="h-4 w-4" />,
    component: RuntimesSection,
  },
  {
    id: "experiments",
    label: "Experiments",
    icon: <FlaskConical className="h-4 w-4" />,
    component: ExperimentsSection,
  },
  {
    id: "keybinds",
    label: "Keybinds",
    icon: <Keyboard className="h-4 w-4" />,
    component: KeybindsSection,
  },
];

interface SettingsSectionRedirect {
  section: string;
  replace?: boolean;
}

export function getSettingsSections(
  governorEnabled: boolean,
  memoryEnabled: boolean,
  agentPluginsEnabled: boolean,
  remoteConnectionAvailable = false
): SettingsSection[] {
  const sections = [...BASE_SECTIONS];
  if (remoteConnectionAvailable) {
    const serverAccessIndex = sections.findIndex((section) => section.id === "server-access");
    sections.splice(serverAccessIndex + 1, 0, {
      id: "remote-connection",
      label: "Remote Connection",
      icon: <Monitor className="h-4 w-4 shrink-0" />,
      component: RemoteConnectionSection,
    });
  }
  if (agentPluginsEnabled) {
    // Next to MCP: plugins contribute skills + MCP servers.
    const mcpIndex = sections.findIndex((section) => section.id === "mcp");
    sections.splice(mcpIndex + 1, 0, {
      id: "plugins",
      label: "Plugins",
      icon: <Blocks className="h-4 w-4" />,
      component: PluginsSettingsSection,
      experimental: true,
    });
  }
  if (memoryEnabled) {
    sections.push({
      id: "memory",
      label: "Memory",
      icon: <Brain className="h-4 w-4" />,
      component: MemorySection,
    });
  }
  sections.push({
    id: "backup",
    label: "Backup",
    icon: <ArchiveRestore className="h-4 w-4" />,
    component: BackupSection,
    experimental: true,
  });
  if (governorEnabled) {
    sections.push({
      id: "governor",
      label: "Governor",
      icon: <ShieldCheck className="h-4 w-4" />,
      component: GovernorSection,
    });
  }
  return sections;
}

export function getSettingsSectionRedirect(
  activeSection: string,
  governorEnabled: boolean,
  memoryEnabled: boolean,
  agentPluginsEnabled: boolean,
  remoteConnectionAvailable = false
): SettingsSectionRedirect | null {
  if (LEGACY_EXPERIMENT_SETTINGS_SECTION_IDS.has(activeSection)) {
    return { section: "experiments", replace: true };
  }

  if (!governorEnabled && activeSection === "governor") {
    return { section: BASE_SECTIONS[0]?.id ?? "general" };
  }

  if (!memoryEnabled && activeSection === "memory") {
    return { section: BASE_SECTIONS[0]?.id ?? "general" };
  }

  if (!agentPluginsEnabled && activeSection === "plugins") {
    return { section: BASE_SECTIONS[0]?.id ?? "general" };
  }

  if (!remoteConnectionAvailable && activeSection === "remote-connection") {
    return { section: BASE_SECTIONS[0]?.id ?? "general" };
  }

  return null;
}

export function SettingsPage() {
  const { isOpen, close, activeSection, setActiveSection } = useSettings();
  const onboardingPause = useOnboardingPause();
  const governorEnabled = useExperimentValue(EXPERIMENT_IDS.MUX_GOVERNOR);
  const memoryEnabled = useExperimentValue(EXPERIMENT_IDS.MEMORY);
  const agentPluginsEnabled = useExperimentValue(EXPERIMENT_IDS.AGENT_PLUGINS);
  const remoteConnectionAvailable = window.api?.remoteConnection != null;
  const focusReturn = useModalFocusReturn(isOpen);

  // Redirect restored links when an experiment or desktop bridge is unavailable.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const redirect = getSettingsSectionRedirect(
      activeSection,
      governorEnabled,
      memoryEnabled,
      agentPluginsEnabled,
      remoteConnectionAvailable
    );
    if (!redirect) {
      return;
    }

    if (redirect.replace) {
      setActiveSection(redirect.section, { replace: true });
      return;
    }

    setActiveSection(redirect.section);
  }, [
    isOpen,
    activeSection,
    setActiveSection,
    governorEnabled,
    memoryEnabled,
    agentPluginsEnabled,
    remoteConnectionAvailable,
  ]);

  const sections = getSettingsSections(
    governorEnabled,
    memoryEnabled,
    agentPluginsEnabled,
    remoteConnectionAvailable
  );
  const currentSection = sections.find((section) => section.id === activeSection) ?? sections[0];
  const SectionComponent = currentSection.component;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      {/* Phone widths get a full-screen sheet; md+ gets a large centered dialog. */}
      <DialogContent
        showCloseButton={false}
        allowEditableEscape
        aria-describedby={undefined}
        onOpenAutoFocus={focusReturn.onOpenAutoFocus}
        onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        className="top-0 left-0 flex h-full w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] md:top-[50%] md:left-[50%] md:h-[min(880px,88vh)] md:w-[min(1100px,92vw)] md:translate-x-[-50%] md:translate-y-[-50%] md:flex-row md:rounded-lg md:border"
      >
        <div className="border-border-medium flex min-w-0 shrink-0 flex-col border-b md:w-48 md:border-r md:border-b-0">
          <div className="border-border-medium flex h-12 shrink-0 items-center border-b px-4">
            <DialogTitle className="text-sm leading-normal tracking-normal">Settings</DialogTitle>
          </div>
          <nav className="flex gap-1 overflow-x-auto p-2 md:flex-1 md:flex-col md:overflow-x-hidden md:overflow-y-auto">
            {sections.map((section) => (
              <Button
                key={section.id}
                variant="ghost"
                onClick={() => setActiveSection(section.id)}
                className={`flex h-auto shrink-0 items-center justify-start gap-2 rounded-md px-3 py-2 text-left text-sm whitespace-nowrap md:w-full ${
                  activeSection === section.id
                    ? "bg-accent/20 text-accent hover:bg-accent/20 hover:text-accent"
                    : "text-muted hover:bg-hover hover:text-foreground"
                }`}
              >
                {section.icon}
                {section.label}
                {section.experimental && (
                  <FlaskConical aria-hidden="true" className="text-warning h-3 w-3 shrink-0" />
                )}
              </Button>
            ))}
          </nav>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="border-border-medium hidden h-12 shrink-0 items-center border-b px-6 md:flex">
            <span className="text-foreground text-sm font-medium">{currentSection.label}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4 md:p-6">
            {/* Keep settings content width bounded so long forms remain readable on wide screens.
                min-h-full + flex-col lets full-height sections (Settings → Memory editor) grow to
                the bottom via flex-1 while content-sized sections keep their natural height. */}
            <div className="flex min-h-full w-full max-w-4xl flex-col">
              {onboardingPause.paused && (
                <div className="bg-accent/10 border-accent/30 text-foreground mb-3 flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span>Setup is paused while you configure providers.</span>
                  <Button variant="secondary" size="sm" onClick={close}>
                    Return to setup
                  </Button>
                </div>
              )}
              <SectionComponent />
            </div>
          </div>
        </div>

        {/* One close button for both layouts: it sits in the top-right header row either way. */}
        <Button
          variant="ghost"
          size="icon"
          onClick={close}
          className="absolute top-[calc(env(safe-area-inset-top)+0.75rem)] right-4 h-6 w-6 md:right-6"
          aria-label="Close settings"
        >
          <X className="h-4 w-4" />
        </Button>
      </DialogContent>
    </Dialog>
  );
}
