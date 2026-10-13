import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import {
  SPLASH_REGISTRY,
  DISABLE_SPLASH_SCREENS,
  ONBOARDING_WIZARD_SPLASH_ID,
  type SplashConfig,
} from "./index";
import { useAPI } from "@/browser/contexts/API";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { FIRST_RUN_VIEW_ID } from "@/common/constants/firstRunView";

/** Removes the static first-run view. Callers do it whenever the live wizard will not replace it. */
export function removeFirstRunView(): void {
  document.getElementById(FIRST_RUN_VIEW_ID)?.remove();
}

const SplashScreenActiveContext = createContext(false);

interface PausedOnboardingState {
  stepIndex: number;
  reason: "providers-settings";
}

interface OnboardingPauseContextValue {
  paused: PausedOnboardingState | null;
  pause: (state: PausedOnboardingState) => void;
  resume: () => void;
}

const OnboardingPauseContext = createContext<OnboardingPauseContextValue | null>(null);

export function useIsSplashScreenActive(): boolean {
  return useContext(SplashScreenActiveContext);
}

export function useOnboardingPause(): OnboardingPauseContextValue {
  const ctx = useContext(OnboardingPauseContext);
  if (!ctx) throw new Error("useOnboardingPause must be used within SplashScreenProvider");
  return ctx;
}

export function SplashScreenProvider({ children }: { children: ReactNode }) {
  const { api } = useAPI();
  const { registerOnClose } = useSettings();
  const [queue, setQueue] = useState<SplashConfig[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pausedOnboarding, setPausedOnboarding] = useState<PausedOnboardingState | null>(null);
  const [onboardingPaused, setOnboardingPaused] = useState(false);

  // Load viewed splash screens from config on mount
  useEffect(() => {
    // Skip if disabled or API not ready
    if (DISABLE_SPLASH_SCREENS || !api) {
      setLoaded(true);
      return;
    }

    void (async () => {
      try {
        const viewedIds = await api.splashScreens.getViewedSplashScreens();

        // Filter registry to undismissed splashes, sorted by priority (highest number first)
        const activeQueue = SPLASH_REGISTRY.filter((splash) => {
          // Priority 0 = never show
          if (splash.priority === 0) return false;

          // Check if this splash has been viewed
          return !viewedIds.includes(splash.id);
        }).sort((a, b) => b.priority - a.priority); // Higher number = higher priority = shown first

        setQueue(activeQueue);
      } catch (error) {
        console.error("Failed to load viewed splash screens:", error);
        // On error, don't show any splash screens
        setQueue([]);
      } finally {
        setLoaded(true);
      }
    })();
  }, [api]);

  const pause = useCallback((state: PausedOnboardingState) => {
    setPausedOnboarding(state);
    setOnboardingPaused(true);
  }, []);

  const resume = useCallback(() => {
    setOnboardingPaused(false);
  }, []);

  useEffect(() => registerOnClose(() => resume()), [registerOnClose, resume]);

  const currentSplash = queue[0] ?? null;
  const isOnboardingSplash = currentSplash?.id === ONBOARDING_WIZARD_SPLASH_ID;
  const isPaused = isOnboardingSplash && onboardingPaused;

  useEffect(() => {
    if (!isOnboardingSplash || onboardingPaused || pausedOnboarding == null) {
      return;
    }

    // Keep the paused step long enough to seed onboarding state on resume, then clear it.
    setPausedOnboarding(null);
  }, [isOnboardingSplash, onboardingPaused, pausedOnboarding]);

  const dismiss = useCallback(async () => {
    if (!currentSplash || !api) return;

    setOnboardingPaused(false);
    setPausedOnboarding(null);

    // Mark as viewed in config
    try {
      await api.splashScreens.markSplashScreenViewed({ splashId: currentSplash.id });
    } catch (error) {
      console.error("Failed to mark splash screen as viewed:", error);
    }

    // Remove from queue, next one shows automatically
    setQueue((q) => q.slice(1));
  }, [currentSplash, api]);

  const onboardingPauseValue = useMemo<OnboardingPauseContextValue>(
    () => ({
      paused: pausedOnboarding,
      pause,
      resume,
    }),
    [pausedOnboarding, pause, resume]
  );

  const isSplashScreenActive = loaded && currentSplash !== null && !isPaused;

  return (
    <SplashScreenActiveContext.Provider value={isSplashScreenActive}>
      <OnboardingPauseContext.Provider value={onboardingPauseValue}>
        {children}
        {loaded && currentSplash && !isPaused && (
          <currentSplash.component onDismiss={() => void dismiss()} />
        )}
      </OnboardingPauseContext.Provider>
    </SplashScreenActiveContext.Provider>
  );
}
