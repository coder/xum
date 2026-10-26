import React, { useState, useRef, useLayoutEffect, useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/common/lib/utils";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { isEditableElement, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";

// The bubble's secondary texts (step counter, body, Skip, opt-out). Plain text-muted on the modal
// background is below WCAG AA in dark (3.78) and flexoki-light (4.47); 30% of the text color
// clears it in all four themes (#6010). A class, not an inline style, so hover:text-foreground
// still wins on the buttons.
const TUTORIAL_MUTED_TEXT =
  "text-[color:color-mix(in_srgb,var(--color-muted),var(--color-text)_30%)]";

export interface TutorialStep {
  target: string; // data-tutorial attribute value
  title: string;
  content: React.ReactNode;
  position?: "top" | "bottom" | "left" | "right";
}

interface TutorialTooltipProps {
  step: TutorialStep;
  currentStep: number;
  totalSteps: number;
  onNext: () => void;
  onDismiss: () => void;
  onDisableTutorial: () => void;
}

interface TooltipPosition {
  top: number;
  left: number;
  arrowStyle: React.CSSProperties;
  actualPosition: "top" | "bottom" | "left" | "right";
}

/**
 * Whether something is drawn over the bubble: the full-screen Artifacts and App View panels
 * (z-1500, above the tutorial) are not modal, so they do not trap focus. A hit test needs no list
 * of such layers. An unknown result (no layout, or the center off screen) counts as uncovered.
 */
function isBubbleCovered(bubble: HTMLElement): boolean {
  const rect = bubble.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return hit != null && !bubble.contains(hit);
}

/**
 * Layers the user opened on purpose: a Radix popover, select or tooltip wrapper, a menu, a listbox
 * or a dialog. Focus inside one of them stays there, because Radix closes a popover or menu when
 * focus leaves it (#7452: the bubble closed the "Workspace actions" menu the user had just opened).
 */
const OPEN_LAYER_SELECTOR = [
  "[data-radix-popper-content-wrapper]",
  '[role="menu"]',
  '[role="listbox"]',
  '[role="dialog"]',
].join(",");

/** Whether the bubble may move focus from `active` without being asked (see useBubbleFocus). */
function mayTakeFocusFrom(active: Element | null): boolean {
  return !isEditableElement(active) && active?.closest(OPEN_LAYER_SELECTOR) == null;
}

function editableElement(element: Element | null): HTMLElement | null {
  return element instanceof HTMLElement && isEditableElement(element) ? element : null;
}

/** Tab or Shift+Tab with no other modifier, not yet handled by another listener. */
function isPlainTab(event: KeyboardEvent | React.KeyboardEvent, shift: boolean): boolean {
  const modified = event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented;
  return event.key === "Tab" && event.shiftKey === shift && !modified;
}

/**
 * Tab from the text field the bubble left focus in moves focus to the bubble (#7198). The listener
 * runs on window, after the document keydown listeners, so a composer suggestion list that takes
 * Tab (it calls preventDefault) keeps it. Returns the cleanup.
 */
function handOffTabToBubble(textField: HTMLElement | null, bubble: HTMLElement): () => void {
  if (!textField) return () => undefined;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== textField || !isPlainTab(event, false)) return;
    event.preventDefault();
    bubble.focus();
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}

/**
 * A covered bubble checks again on the next focus move outside it (#7198): both full-screen panels
 * move focus back to their own panel when they unpin. Once uncovered, the bubble takes focus under
 * the usual rules, and `onUncovered` gets the element it found focused. Returns the cleanup.
 */
function takeFocusWhenUncovered(
  covered: boolean,
  bubble: HTMLElement,
  onUncovered: (focused: Element) => void
): () => void {
  if (!covered) return () => undefined;
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof Element) || bubble.contains(target) || isBubbleCovered(bubble)) return;
    document.removeEventListener("focusin", onFocusIn);
    onUncovered(target);
    if (mayTakeFocusFrom(target)) bubble.focus();
  };
  document.addEventListener("focusin", onFocusIn);
  return () => document.removeEventListener("focusin", onFocusIn);
}

/** Shift+Tab from the bubble or its first button goes back to the text field (#7198). */
function handOffShiftTabBack(
  event: React.KeyboardEvent,
  bubble: HTMLElement | null,
  textField: HTMLElement | null
): void {
  const fromStart =
    bubble != null && (event.target === bubble || event.target === bubble.querySelector("button"));
  if (!fromStart || !textField?.isConnected || !isPlainTab(event, true)) return;
  event.preventDefault();
  textField.focus();
}

/** On close, focus left on the body or in the bubble goes back to where it was. */
function restoreFocus(bubble: HTMLElement, previous: Element | null): void {
  const active = document.activeElement;
  const focusLost = active === document.body || bubble.contains(active);
  if (focusLost && previous instanceof HTMLElement && previous.isConnected) previous.focus();
}

/**
 * Moves focus into the bubble once it is on screen (a hidden element cannot take focus), so
 * Escape, Skip and Next work from the keyboard (#5701). Later steps keep focus on the control that
 * advanced them. When the bubble closes and leaves focus on the body, focus goes back to where it
 * was. An open modal dialog traps focus, so the bubble cannot take it from one.
 *
 * It leaves focus alone in a text field, where the user may be typing (keys such as Escape would
 * otherwise skip a tutorial they never chose to act on), inside an open layer (OPEN_LAYER_SELECTOR),
 * and under a layer that covers the bubble, where Escape would skip a tutorial the user cannot see
 * (#7114). The bubble stays clickable. A covered bubble takes focus once it is uncovered
 * (takeFocusWhenUncovered). From the text field it left focus in, Tab reaches the bubble and
 * Shift+Tab from the bubble goes back: the bubble never takes a text field's focus on its own
 * (#7120). Every listener goes away when the bubble closes.
 *
 * Returns the bubble's keydown handler for that Shift+Tab.
 */
function useBubbleFocus(
  tooltipRef: React.RefObject<HTMLDivElement | null>,
  isPositioned: boolean
): (event: React.KeyboardEvent) => void {
  const textFieldRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const bubble = tooltipRef.current;
    if (!isPositioned || !bubble) return;
    let previous = document.activeElement;
    const covered = isBubbleCovered(bubble);
    if (!covered && mayTakeFocusFrom(previous)) bubble.focus();
    // The text field the bubble left focus in, for the Tab hand-over.
    const textField = covered ? null : editableElement(previous);
    textFieldRef.current = textField;
    const stopTab = handOffTabToBubble(textField, bubble);
    const stopWaiting = takeFocusWhenUncovered(covered, bubble, (focused) => (previous = focused));
    // The restore runs even when the bubble left focus alone: a click on Skip or Next still moves
    // focus into the bubble, and it must go back to the composer when the bubble closes.
    return () => {
      stopTab();
      stopWaiting();
      textFieldRef.current = null;
      restoreFocus(bubble, previous);
    };
  }, [tooltipRef, isPositioned]);

  return (event) => handOffShiftTabBack(event, tooltipRef.current, textFieldRef.current);
}

/**
 * Escape on the bubble counts as Skip. Only keys sent to the bubble reach this handler, so an open
 * popover, menu, dialog or editor keeps its own Escape: #5670 took every Escape with a window
 * listener.
 */
function dismissOnEscape(e: React.KeyboardEvent, onDismiss: () => void): void {
  // A layer that already handled this Escape marks it with preventDefault.
  if (!matchesKeybind(e, KEYBINDS.CANCEL) || e.defaultPrevented) return;
  e.preventDefault();
  // The window's stream-interrupt listener must not also act on this Escape.
  stopKeyboardPropagation(e);
  onDismiss();
}

export const TutorialTooltip: React.FC<TutorialTooltipProps> = ({
  step,
  currentStep,
  totalSteps,
  onNext,
  onDismiss,
  onDisableTutorial,
}) => {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const isPositioned = position !== null;

  useLayoutEffect(() => {
    const targetEl = document.querySelector(`[data-tutorial="${step.target}"]`);
    if (!targetEl || !tooltipRef.current) {
      return;
    }

    const calculatePosition = () => {
      const target = targetEl.getBoundingClientRect();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
      const tooltip = tooltipRef.current!.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const gap = 12;

      const preferredPosition = step.position ?? "bottom";
      let actualPosition = preferredPosition;
      let top: number;
      let left: number;

      // Try preferred position, flip if it doesn't fit
      if (preferredPosition === "bottom" || preferredPosition === "top") {
        if (preferredPosition === "bottom") {
          top = target.bottom + gap;
          if (top + tooltip.height > viewportHeight) {
            actualPosition = "top";
            top = target.top - tooltip.height - gap;
          }
        } else {
          top = target.top - tooltip.height - gap;
          if (top < 0) {
            actualPosition = "bottom";
            top = target.bottom + gap;
          }
        }
        // Center horizontally relative to target
        left = target.left + target.width / 2 - tooltip.width / 2;
      } else {
        // left or right
        if (preferredPosition === "right") {
          left = target.right + gap;
          if (left + tooltip.width > viewportWidth) {
            actualPosition = "left";
            left = target.left - tooltip.width - gap;
          }
        } else {
          left = target.left - tooltip.width - gap;
          if (left < 0) {
            actualPosition = "right";
            left = target.right + gap;
          }
        }
        // Center vertically relative to target
        top = target.top + target.height / 2 - tooltip.height / 2;
      }

      // Clamp to viewport bounds
      const minMargin = 8;
      left = Math.max(minMargin, Math.min(viewportWidth - tooltip.width - minMargin, left));
      top = Math.max(minMargin, Math.min(viewportHeight - tooltip.height - minMargin, top));

      // Calculate arrow position
      const arrowStyle: React.CSSProperties = {};
      if (actualPosition === "bottom" || actualPosition === "top") {
        const arrowLeft = target.left + target.width / 2 - left;
        arrowStyle.left = `${Math.max(12, Math.min(tooltip.width - 12, arrowLeft))}px`;
        if (actualPosition === "bottom") {
          arrowStyle.top = "-6px";
          arrowStyle.borderWidth = "0 6px 6px 6px";
          arrowStyle.borderColor = "transparent transparent var(--color-accent) transparent";
        } else {
          arrowStyle.bottom = "-6px";
          arrowStyle.borderWidth = "6px 6px 0 6px";
          arrowStyle.borderColor = "var(--color-accent) transparent transparent transparent";
        }
      } else {
        const arrowTop = target.top + target.height / 2 - top;
        arrowStyle.top = `${Math.max(12, Math.min(tooltip.height - 12, arrowTop))}px`;
        if (actualPosition === "right") {
          arrowStyle.left = "-6px";
          arrowStyle.borderWidth = "6px 6px 6px 0";
          arrowStyle.borderColor = "transparent var(--color-accent) transparent transparent";
        } else {
          arrowStyle.right = "-6px";
          arrowStyle.borderWidth = "6px 0 6px 6px";
          arrowStyle.borderColor = "transparent transparent transparent var(--color-accent)";
        }
      }

      setPosition({ top, left, arrowStyle, actualPosition });
    };

    calculatePosition();

    // Recalculate on resize
    window.addEventListener("resize", calculatePosition);
    return () => window.removeEventListener("resize", calculatePosition);
  }, [step.target, step.position]);

  // Add highlight to target element
  useLayoutEffect(() => {
    const targetEl = document.querySelector(`[data-tutorial="${step.target}"]`);
    if (!targetEl) return;

    targetEl.classList.add("tutorial-highlight");
    return () => {
      targetEl.classList.remove("tutorial-highlight");
    };
  }, [step.target]);

  const handOffShiftTab = useBubbleFocus(tooltipRef, isPositioned);

  const isLastStep = currentStep === totalSteps;

  // Stacking (#5701): the highlight (.tutorial-highlight, 1497), this backdrop (1498) and the
  // bubble (1499) sit just under the shared Dialog layer (1500). Every layer the user opens on
  // purpose (dialogs such as Settings, popovers, selects, the command palette) draws over the
  // tutorial and keeps its keys, and everything the tutorial covered before stays covered.
  return createPortal(
    <>
      {/* Backdrop - subtle overlay */}
      <div
        // Dim painted on a pseudo-element so iOS/iPadOS 26 WebKit's status-bar edge
        // sampler ignores this fixed overlay (same pattern as Dialog/LeftSidebar).
        className="fixed inset-0 z-[1498] before:absolute before:inset-0 before:bg-black/20"
        data-testid="tutorial-backdrop"
        onClick={onDismiss}
      />
      {/* Tooltip */}
      {/* A group, not a dialog: role="dialog" would count as an open dialog portal in shared
          key and focus checks (isEventFromDialogPortal, the Backup section's topmost dialog). */}
      <div
        ref={tooltipRef}
        role="group"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(e) => {
          handOffShiftTab(e);
          dismissOnEscape(e, onDismiss);
        }}
        style={{
          position: "fixed",
          top: position?.top ?? -9999,
          left: position?.left ?? -9999,
          visibility: position ? "visible" : "hidden",
        }}
        className={cn(
          "z-[1499] w-72 rounded-lg border-2 border-accent bg-modal-bg p-4 shadow-lg outline-none",
          "text-foreground"
        )}
      >
        {/* Arrow */}
        <div className="absolute h-0 w-0 border-solid" style={position?.arrowStyle} />

        {/* Header */}
        <div className="mb-2 flex items-start justify-between">
          <h3 id={titleId} className="text-sm font-semibold">
            {step.title}
          </h3>
          <span className={cn(TUTORIAL_MUTED_TEXT, "text-xs")}>
            {currentStep}/{totalSteps}
          </span>
        </div>

        {/* Content */}
        <p className={cn(TUTORIAL_MUTED_TEXT, "mb-4 text-xs leading-relaxed")}>{step.content}</p>

        {/* Actions */}
        <div className="flex items-center justify-between">
          {/* Skip ends this tutorial only. The opt-out is its own control so a second tap on
              Skip can never turn off every tutorial. */}
          <div className="flex items-center gap-3">
            <button
              onClick={onDismiss}
              className={cn(TUTORIAL_MUTED_TEXT, "hover:text-foreground text-xs transition-colors")}
            >
              Skip
            </button>
            <button
              onClick={onDisableTutorial}
              className={cn(
                TUTORIAL_MUTED_TEXT,
                "hover:text-foreground text-[10px] underline transition-colors"
              )}
            >
              Don&apos;t show tutorials again
            </button>
          </div>
          <button
            onClick={isLastStep ? onDismiss : onNext}
            className="bg-accent text-accent-foreground hover:bg-accent-button-hover rounded px-3 py-1.5 text-xs font-medium transition-colors"
          >
            {isLastStep ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </>,
    document.body
  );
};
