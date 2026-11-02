/**
 * The deepest that (, [ and { may nest in an attribute value of a Mermaid diagram's SVG.
 * Chromium's CSS parser takes time that doubles with each color-mix() nested around an invalid
 * value, and DOMParser pays it while it builds the tree. Pele's own output nests 2 deep. At
 * MERMAID_MAX_ATTRIBUTE_NESTING, Chromium parses the slowest nested color-mix() in 0.2 ms.
 */
export const MERMAID_MAX_ATTRIBUTE_NESTING = 8;
