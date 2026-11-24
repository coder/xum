/**
 * The deepest that (, [ and { may nest in an attribute value of a Mermaid diagram's SVG.
 * Chromium's CSS parser takes time that doubles with each color-mix() nested around an invalid
 * value, and DOMParser pays it while it builds the tree. Pele's own output nests 2 deep. At
 * MERMAID_MAX_ATTRIBUTE_NESTING, Chromium parses the slowest nested color-mix() in 0.2 ms.
 */
export const MERMAID_MAX_ATTRIBUTE_NESTING = 8;

/** A diagram's frame on the page. It exists, with a placeholder, before Mermaid draws into it. */
export const MERMAID_PAGE_FRAME_SELECTOR = ".mermaid-container:not(.mermaid-modal)";

export const MERMAID_PAGE_DIAGRAM_SELECTOR = `${MERMAID_PAGE_FRAME_SELECTOR} > svg`;

/** Set on the error block that a diagram shows, in place of its frame, when it fails to render. */
export const MERMAID_ERROR_ATTRIBUTE = "data-mermaid-error";
export const MERMAID_ERROR_SELECTOR = `[${MERMAID_ERROR_ATTRIBUTE}]`;

/**
 * Dispatched on the page's window when the Storybook test runner (.storybook/test-runner.ts)
 * starts to wait for a diagram. Only the paint-check fixture that mounts its diagram late listens.
 */
export const PAINT_CHECK_WAIT_EVENT = "paint-check-wait-started";

/**
 * Names the env var, in milliseconds, that shortens how long the Storybook test runner waits for
 * its diagrams to render. Only scripts/check-paint-check-fixtures.ts sets it, so the fixture whose
 * second diagram never draws does not wait the runner's whole default.
 */
export const PAINT_CHECK_RENDER_TIMEOUT_ENV = "PAINT_CHECK_RENDER_TIMEOUT_MS";
