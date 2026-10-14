import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import {
  getUserPreferences,
  updateUserPreferences,
  useUserPreferences,
} from "@/browser/stores/AppConfigStore";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { matchesKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import {
  PowerModeEngine,
  type PowerModeBurstKind,
} from "@/browser/utils/powerMode/PowerModeEngine";
import { PowerModeOverlay } from "@/browser/features/PowerMode/PowerModeOverlay";

interface PowerModeContextValue {
  enabled: boolean;
  burstFromTextarea: (
    textarea: HTMLTextAreaElement,
    intensity?: number,
    kind?: PowerModeBurstKind,
    // Optional override so callers can defer measurement to `requestAnimationFrame()`
    // without losing per-keystroke caret alignment during fast typing.
    caretIndex?: number
  ) => void;
}

const PowerModeContext = createContext<PowerModeContextValue | null>(null);

export function usePowerMode(): PowerModeContextValue {
  const ctx = useContext(PowerModeContext);
  if (!ctx) {
    throw new Error("usePowerMode must be used within a PowerModeProvider");
  }
  return ctx;
}

interface MirrorState {
  el: HTMLDivElement;
  beforeTextNode: Text;
  caretSpan: HTMLSpanElement;
  afterTextNode: Text;

  lastStyleSignature: string | null;
  lineHeightPx: number;
  paddingLeftPx: number;
  paddingRightPx: number;
  paddingTopPx: number;
  paddingBottomPx: number;

  lastContentWidthPx: number | null;
  lastContentHeightPx: number | null;
  lastTopPx: number | null;
  lastLeftPx: number | null;
}

function getLineHeightPx(computed: CSSStyleDeclaration): number {
  const lineHeight = Number.parseFloat(computed.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) {
    return lineHeight;
  }

  const fontSize = Number.parseFloat(computed.fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.2 : 16;
}

function getPx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const MIRROR_STYLE_PROPS = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-transform",
  "text-align",
  "direction",
  "white-space",
  "word-break",
  "overflow-wrap",
  "tab-size",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  // Border widths only contribute to layout when border style is non-none.
  // Copy styles too so mirror geometry stays aligned with the textarea.
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
] as const;

function ensureMirror(mirrorRef: React.MutableRefObject<MirrorState | null>) {
  if (mirrorRef.current) {
    return mirrorRef.current;
  }

  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.position = "fixed";
  el.style.visibility = "hidden";
  el.style.pointerEvents = "none";
  el.style.whiteSpace = "pre-wrap";
  el.style.wordWrap = "break-word";
  el.style.overflowWrap = "break-word";
  el.style.overflow = "hidden";
  el.style.top = "0";
  el.style.left = "0";
  el.style.zIndex = "-1";

  const beforeTextNode = document.createTextNode("");

  // Use a marker span so measurement is accurate even when the caret is adjacent to newlines.
  const caretSpan = document.createElement("span");
  caretSpan.textContent = "\u200b";

  const afterTextNode = document.createTextNode("");

  el.appendChild(beforeTextNode);
  el.appendChild(caretSpan);
  el.appendChild(afterTextNode);

  document.body.appendChild(el);

  mirrorRef.current = {
    el,
    beforeTextNode,
    caretSpan,
    afterTextNode,
    lastStyleSignature: null,
    lineHeightPx: 16,
    paddingLeftPx: 0,
    paddingRightPx: 0,
    paddingTopPx: 0,
    paddingBottomPx: 0,
    lastContentWidthPx: null,
    lastContentHeightPx: null,
    lastTopPx: null,
    lastLeftPx: null,
  };

  return mirrorRef.current;
}

function syncMirrorStyles(
  textarea: HTMLTextAreaElement,
  mirror: MirrorState
): {
  lineHeightPx: number;
} {
  const computed = window.getComputedStyle(textarea);

  // Position/size must be recomputed as the textarea auto-resizes.
  const rect = textarea.getBoundingClientRect();

  if (mirror.lastTopPx !== rect.top) {
    mirror.el.style.top = `${rect.top}px`;
    mirror.lastTopPx = rect.top;
  }

  if (mirror.lastLeftPx !== rect.left) {
    mirror.el.style.left = `${rect.left}px`;
    mirror.lastLeftPx = rect.left;
  }

  const styleSignature = MIRROR_STYLE_PROPS.map((prop) => computed.getPropertyValue(prop)).join(
    "|"
  );

  if (mirror.lastStyleSignature !== styleSignature) {
    mirror.lastStyleSignature = styleSignature;

    // Typography + box model.
    // Use a content-box mirror so we can size it directly from textarea.clientWidth/clientHeight
    // (which account for scrollbars), and keep wrapping behavior consistent.
    mirror.el.style.boxSizing = "content-box";

    for (const prop of MIRROR_STYLE_PROPS) {
      mirror.el.style.setProperty(prop, computed.getPropertyValue(prop));
    }

    mirror.paddingLeftPx = getPx(computed.getPropertyValue("padding-left"));
    mirror.paddingRightPx = getPx(computed.getPropertyValue("padding-right"));
    mirror.paddingTopPx = getPx(computed.getPropertyValue("padding-top"));
    mirror.paddingBottomPx = getPx(computed.getPropertyValue("padding-bottom"));

    mirror.lineHeightPx = getLineHeightPx(computed);
  }

  // textarea.clientWidth/clientHeight exclude scrollbars, which helps avoid caret drift when the
  // textarea is at its max height and begins scrolling.
  const contentWidthPx = Math.max(
    0,
    textarea.clientWidth - mirror.paddingLeftPx - mirror.paddingRightPx
  );
  const contentHeightPx = Math.max(
    0,
    textarea.clientHeight - mirror.paddingTopPx - mirror.paddingBottomPx
  );

  if (mirror.lastContentWidthPx !== contentWidthPx) {
    mirror.el.style.width = `${contentWidthPx}px`;
    mirror.lastContentWidthPx = contentWidthPx;
  }

  if (mirror.lastContentHeightPx !== contentHeightPx) {
    mirror.el.style.height = `${contentHeightPx}px`;
    mirror.lastContentHeightPx = contentHeightPx;
  }

  return { lineHeightPx: mirror.lineHeightPx };
}

function getCaretViewportPosition(
  textarea: HTMLTextAreaElement,
  mirror: MirrorState,
  caretIndex?: number
): {
  x: number;
  y: number;
} | null {
  try {
    const rawCaret = caretIndex ?? textarea.selectionStart ?? textarea.value.length;
    const caret = Number.isFinite(rawCaret)
      ? Math.max(0, Math.min(textarea.value.length, rawCaret))
      : textarea.value.length;

    const { lineHeightPx } = syncMirrorStyles(textarea, mirror);

    mirror.beforeTextNode.textContent = textarea.value.slice(0, caret);
    mirror.afterTextNode.textContent = textarea.value.slice(caret);

    const spanRect = mirror.caretSpan.getBoundingClientRect();

    // Mirror is unscrolled; subtract textarea scroll offsets to match the visible caret.
    const x = spanRect.left - textarea.scrollLeft;
    const y = spanRect.top - textarea.scrollTop + lineHeightPx / 2;

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    return { x, y };
  } catch {
    return null;
  }
}

export function PowerModeProvider(props: { children: ReactNode }) {
  const enabled =
    useUserPreferences((preferences) => preferences.appearance?.powerModeEnabled) ?? false;

  const engineRef = useRef(new PowerModeEngine());
  const mirrorRef = useRef<MirrorState | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (!matchesKeybind(e, KEYBINDS.TOGGLE_POWER_MODE)) return;

      e.preventDefault();
      stopKeyboardPropagation(e);
      const wasEnabled = getUserPreferences().appearance?.powerModeEnabled ?? false;
      updateUserPreferences({ appearance: { powerModeEnabled: !wasEnabled } });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    const engine = engineRef.current;

    return () => {
      mirrorRef.current?.el.remove();
      mirrorRef.current = null;

      engine.stop();
    };
  }, []);

  const burstFromTextarea = useCallback<PowerModeContextValue["burstFromTextarea"]>(
    (textarea, intensity = 1, kind: PowerModeBurstKind = "insert", caretIndex) => {
      if (!enabled) return;

      const engine = engineRef.current;

      const rect = textarea.getBoundingClientRect();
      const fallback = {
        x: rect.left + rect.width - 12,
        y: rect.top + rect.height - 12,
      };

      const mirror = ensureMirror(mirrorRef);
      const caretPos = getCaretViewportPosition(textarea, mirror, caretIndex) ?? fallback;

      engine.burst(caretPos.x, caretPos.y, intensity, { kind });
    },
    [enabled]
  );

  const value = useMemo<PowerModeContextValue>(
    () => ({
      enabled,
      burstFromTextarea,
    }),
    [enabled, burstFromTextarea]
  );

  return (
    <PowerModeContext.Provider value={value}>
      {props.children}
      {enabled && <PowerModeOverlay engine={engineRef.current} />}
    </PowerModeContext.Provider>
  );
}
