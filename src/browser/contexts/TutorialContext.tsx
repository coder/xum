import React, { createContext, useContext, useState, useCallback } from "react";
import {
  TutorialTooltip,
  type TutorialStep,
} from "@/browser/components/TutorialTooltip/TutorialTooltip";
import { useIsSplashScreenActive } from "@/browser/features/SplashScreens/SplashScreenProvider";
import { updateUserPreferences, useUserPreferences } from "@/browser/stores/AppConfigStore";

type TutorialSequence = "creation" | "workspace" | "review";

// Tutorial step definitions for each sequence
const TUTORIAL_SEQUENCES: Record<TutorialSequence, TutorialStep[]> = {
  creation: [
    {
      target: "model-selector",
      title: "Choose Your Model",
      content:
        "Select which AI model to use. Different models have different capabilities and costs.",
      position: "bottom",
    },
    {
      target: "mode-selector",
      title: "Exec vs Plan Mode",
      content:
        "Exec mode lets the AI edit files and run commands. Plan mode is read-only - use it to scope the agent's implementation.",
      position: "top",
    },
    {
      target: "trunk-branch",
      title: "Branch From",
      content: "Choose which branch to create your workspace from.",
      position: "top",
    },
    {
      target: "runtime-selector",
      title: "Runtime Environment",
      content:
        "Run locally using git worktrees, or connect via SSH to setup the worktree on a remote machine in an isolated environment.",
      position: "top",
    },
  ],
  workspace: [
    {
      target: "terminal-button",
      title: "Terminal Access",
      content: "Open a terminal window in your workspace.",
      position: "bottom",
    },
  ],
  review: [
    {
      target: "immersive-review",
      title: "Immersive Review",
      content: "Try our new immersive keyboard-driven code review experience.",
      position: "bottom",
    },
  ],
};

interface TutorialContextValue {
  startSequence: (sequence: TutorialSequence) => void;
  isSequenceCompleted: (sequence: TutorialSequence) => boolean;
  isTutorialDisabled: () => boolean;
}

const TutorialContext = createContext<TutorialContextValue | null>(null);

export function useTutorial(): TutorialContextValue {
  const context = useContext(TutorialContext);
  if (!context) {
    throw new Error("useTutorial must be used within a TutorialProvider");
  }
  return context;
}

interface TutorialSandboxTransportState {
  preloadEnableTutorialsInSandbox?: boolean;
  browserEnableTutorialsInSandbox?: boolean | null | undefined;
}

export function resolveTutorialSandboxOptIn(
  transportState: TutorialSandboxTransportState
): boolean | undefined {
  if (transportState.preloadEnableTutorialsInSandbox != null) {
    return transportState.preloadEnableTutorialsInSandbox;
  }

  if (transportState.browserEnableTutorialsInSandbox != null) {
    return transportState.browserEnableTutorialsInSandbox;
  }

  return undefined;
}

function getTutorialSandboxOptIn(): boolean | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  return resolveTutorialSandboxOptIn({
    preloadEnableTutorialsInSandbox: window.api?.enableTutorialsInSandbox,
    browserEnableTutorialsInSandbox: globalThis.__MUX_ENABLE_TUTORIALS_IN_SANDBOX__,
  });
}

interface TutorialProviderProps {
  children: React.ReactNode;
}

export function TutorialProvider({ children }: TutorialProviderProps) {
  const tutorialDisabled =
    useUserPreferences((preferences) => preferences.ui?.tutorialState?.disabled) ?? false;
  const completed = useUserPreferences((preferences) => preferences.ui?.tutorialState?.completed);
  const isSplashScreenActive = useIsSplashScreenActive();
  const [activeSequence, setActiveSequence] = useState<TutorialSequence | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const sandboxTutorialOptIn = getTutorialSandboxOptIn();
  // Keep sandbox suppression runtime-only so a default sandbox launch cannot poison
  // later opt-in runs that reuse the same browser origin or Electron userData profile.
  const effectiveTutorialsDisabled = tutorialDisabled || sandboxTutorialOptIn === false;

  const isSequenceCompleted = useCallback(
    (sequence: TutorialSequence): boolean => {
      return completed?.[sequence] === true;
    },
    [completed]
  );

  const isTutorialDisabled = useCallback((): boolean => {
    return effectiveTutorialsDisabled;
  }, [effectiveTutorialsDisabled]);

  const startSequence = useCallback(
    (sequence: TutorialSequence) => {
      // Don't start if disabled or already completed
      if (effectiveTutorialsDisabled || completed?.[sequence]) {
        return;
      }
      // Don't start if another sequence is active
      if (activeSequence !== null) {
        return;
      }
      setActiveSequence(sequence);
      setCurrentStepIndex(0);
    },
    [effectiveTutorialsDisabled, completed, activeSequence]
  );

  const handleNext = useCallback(() => {
    if (activeSequence === null) return;

    const steps = TUTORIAL_SEQUENCES[activeSequence];
    if (currentStepIndex < steps.length - 1) {
      setCurrentStepIndex((prev) => prev + 1);
    } else {
      updateUserPreferences({ ui: { tutorialState: { completed: { [activeSequence]: true } } } });
      setActiveSequence(null);
      setCurrentStepIndex(0);
    }
  }, [activeSequence, currentStepIndex]);

  const handleDismiss = useCallback(() => {
    if (activeSequence === null) return;

    // Mark as completed when dismissed
    updateUserPreferences({ ui: { tutorialState: { completed: { [activeSequence]: true } } } });
    setActiveSequence(null);
    setCurrentStepIndex(0);
  }, [activeSequence]);

  const handleDisableTutorial = useCallback(() => {
    updateUserPreferences({ ui: { tutorialState: { disabled: true } } });
    setActiveSequence(null);
    setCurrentStepIndex(0);
  }, []);

  const contextValue: TutorialContextValue = {
    startSequence,
    isSequenceCompleted,
    isTutorialDisabled,
  };

  const activeSteps = activeSequence ? TUTORIAL_SEQUENCES[activeSequence] : null;
  const currentStep = activeSteps?.[currentStepIndex];

  return (
    <TutorialContext.Provider value={contextValue}>
      {children}
      {!isSplashScreenActive && !effectiveTutorialsDisabled && currentStep && activeSteps && (
        <TutorialTooltip
          step={currentStep}
          currentStep={currentStepIndex + 1}
          totalSteps={activeSteps.length}
          onNext={handleNext}
          onDismiss={handleDismiss}
          onDisableTutorial={handleDisableTutorial}
        />
      )}
    </TutorialContext.Provider>
  );
}
