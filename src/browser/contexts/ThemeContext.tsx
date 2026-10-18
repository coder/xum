import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { updateUserPreferences, useAppConfig } from "@/browser/stores/AppConfigStore";
import { ThemePreferenceSchema } from "@/common/config/schemas/userPreferences";
import { UI_THEME_KEY } from "@/common/constants/storage";
import { CHROME_COLORS } from "@/common/constants/chromeColors";
import { isLightThemeMode } from "@/browser/utils/highlighting/shiki-shared";

export type ThemeMode = "light" | "dark" | "flexoki-light" | "flexoki-dark";
export type ThemePreference = ThemeMode | "auto";

export const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "flexoki-light", label: "Flexoki Light" },
  { value: "flexoki-dark", label: "Flexoki Dark" },
];

const MANUAL_THEME_VALUES: ThemeMode[] = ["light", "dark", "flexoki-light", "flexoki-dark"];

/** The paint cache that index.html reads before React loads; config.json holds the preference. */
function readCachedThemePreference(): ThemePreference {
  const parsed = ThemePreferenceSchema.safeParse(readPersistedState<unknown>(UI_THEME_KEY, null));
  return parsed.success ? parsed.data : "auto";
}

function setTheme(themePreference: ThemePreference): void {
  updateUserPreferences({ appearance: { theme: themePreference } });
}

interface ThemeContextValue {
  /** Concrete theme consumed by existing components (`auto` resolves to light/dark). */
  theme: ThemeMode;
  /** Persisted user preference shown in settings/selector (includes explicit `auto`). */
  themePreference: ThemePreference;
  setTheme: (themePreference: ThemePreference) => void;
  toggleTheme: () => void;
  /** True if this provider has a forcedTheme - nested providers should not override */
  isForced: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const THEME_COLORS: Record<ThemeMode, string> = CHROME_COLORS;

// Keep hrefs relative so a server-injected <base> preserves path-app prefixes.
const FAVICON_BY_SCHEME: Record<"light" | "dark", string> = {
  light: "favicon.ico",
  dark: "favicon-dark.ico",
};

/** Map theme mode to CSS color-scheme value */
function getColorScheme(theme: ThemeMode): "light" | "dark" {
  // Reuse the shared `-light` suffix convention so we have one source of truth for the light/dark mapping.
  return isLightThemeMode(theme) ? "light" : "dark";
}

function applyThemeFavicon(theme: ThemeMode) {
  if (typeof document === "undefined") {
    return;
  }

  const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"][data-theme-icon]');
  if (!favicon) {
    return;
  }

  const scheme = getColorScheme(theme);
  const nextHref = FAVICON_BY_SCHEME[scheme];
  if (favicon.getAttribute("href") !== nextHref) {
    favicon.setAttribute("href", nextHref);
  }
}

function resolveSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined" || !window.matchMedia) {
    return "dark";
  }

  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyThemeToDocument(theme: ThemeMode) {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = getColorScheme(theme);

  const themeColor = THEME_COLORS[theme];
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", themeColor);
  }

  const body = document.body;
  if (body) {
    body.style.backgroundColor = "var(--color-surface-primary)";
  }

  applyThemeFavicon(theme);
}

export function ThemeProvider({
  children,
  forcedTheme,
}: {
  children: ReactNode;
  forcedTheme?: ThemeMode;
}) {
  // Check if we're nested inside a forced theme provider
  const parentContext = useContext(ThemeContext);
  const isNestedUnderForcedProvider = parentContext?.isForced ?? false;

  // undefined until the store's first snapshot, the only time the paint cache is read.
  const serverThemePreference = useAppConfig(
    (config) => config.userPreferences && (config.userPreferences.appearance?.theme ?? "auto")
  );
  const normalizedThemePreference = serverThemePreference ?? readCachedThemePreference();

  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() => resolveSystemTheme());

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !window.matchMedia ||
      forcedTheme !== undefined ||
      isNestedUnderForcedProvider ||
      normalizedThemePreference !== "auto"
    ) {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    setSystemTheme(mediaQuery.matches ? "light" : "dark");

    const handleChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? "light" : "dark");
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => {
        mediaQuery.removeEventListener("change", handleChange);
      };
    }

    mediaQuery.addListener(handleChange);
    return () => {
      mediaQuery.removeListener(handleChange);
    };
  }, [forcedTheme, isNestedUnderForcedProvider, normalizedThemePreference]);

  const resolvedPersistedTheme =
    normalizedThemePreference === "auto"
      ? // Resolve directly from matchMedia so manual -> auto reads the current OS theme in the same render.
        typeof window !== "undefined"
        ? resolveSystemTheme()
        : systemTheme
      : normalizedThemePreference;

  // If nested under a forced provider, use parent's resolved theme
  // Otherwise, use forcedTheme (if provided) or resolved persisted theme
  const theme =
    isNestedUnderForcedProvider && parentContext
      ? parentContext.theme
      : (forcedTheme ?? resolvedPersistedTheme);

  const themePreference =
    isNestedUnderForcedProvider && parentContext
      ? parentContext.themePreference
      : normalizedThemePreference;

  const isForced = forcedTheme !== undefined || isNestedUnderForcedProvider;

  // Only apply to document if we're the authoritative provider
  useLayoutEffect(() => {
    if (isNestedUnderForcedProvider) {
      return;
    }

    applyThemeToDocument(theme);
  }, [isNestedUnderForcedProvider, theme]);

  useEffect(() => {
    if (serverThemePreference !== undefined) {
      updatePersistedState(UI_THEME_KEY, serverThemePreference);
    }
  }, [serverThemePreference]);

  const toggleTheme = useCallback(() => {
    if (!isNestedUnderForcedProvider) {
      const currentTheme = themePreference === "auto" ? theme : themePreference;
      const currentIndex = MANUAL_THEME_VALUES.indexOf(currentTheme);
      const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = (safeCurrentIndex + 1) % MANUAL_THEME_VALUES.length;
      setTheme(MANUAL_THEME_VALUES[nextIndex]);
    }
  }, [isNestedUnderForcedProvider, theme, themePreference]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      themePreference,
      setTheme,
      toggleTheme,
      isForced,
    }),
    [isForced, theme, themePreference, toggleTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
