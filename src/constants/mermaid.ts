/**
 * The deepest that (, [ and { may nest in an attribute value of a Mermaid diagram's SVG.
 * Chromium's CSS parser takes time that doubles with each color-mix() nested around an invalid
 * value, and DOMParser pays it while it builds the tree. Pele's own output nests 2 deep. At
 * MERMAID_MAX_ATTRIBUTE_NESTING, Chromium parses the slowest nested color-mix() in 0.2 ms.
 */
export const MERMAID_MAX_ATTRIBUTE_NESTING = 8;

/**
 * A Mermaid diagram's frame on the page. The expand dialog draws its own copy in a
 * `.mermaid-modal` frame, which the paint check and the story helpers leave out.
 * Mermaid shows this frame with a "Rendering diagram..." placeholder before it draws.
 */
export const MERMAID_PAGE_FRAME_SELECTOR = ".mermaid-container:not(.mermaid-modal)";

/**
 * The drawing a frame holds once it has rendered. The test runner (.storybook/test-runner.ts)
 * and the stories import this one selector, so they all agree on what counts as a diagram.
 */
export const MERMAID_PAGE_DIAGRAM_SELECTOR = `${MERMAID_PAGE_FRAME_SELECTOR} > svg`;
