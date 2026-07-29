export const LEFT_SIDEBAR_DEFAULT_WIDTH_PX = 288;
export const LEFT_SIDEBAR_MIN_WIDTH_PX = 200;
export const LEFT_SIDEBAR_MAX_WIDTH_PX = 600;
export const LEFT_SIDEBAR_COLLAPSED_WIDTH_PX = 20;

// When the left sidebar is collapsed, WorkspaceMenuBar still needs extra room for the
// floating reopen affordance so the header content doesn't sit underneath it.
export const WORKSPACE_MENU_BAR_LEFT_SIDEBAR_COLLAPSED_PADDING_PX = 60;
export const CREATION_COLUMN_MAX_WIDTH_CLASS = "max-w-[67rem]";

// The composer dock cancels the transcript scrollport's padding to paint full-bleed, so surfaces
// inside it re-apply this gutter to land on the same edges as transcript rows. Tailwind scans source
// text, so this has to stay a literal class string.
export const CHAT_DOCK_GUTTER_CLASS = "px-[15px]";

// The viewport/pointer combination that gates Mux's mobile affordances. Must stay in sync with the
// matching `@media` block in globals.css: the renderer branches on this same environment through
// `window.matchMedia`, so a per-callsite copy of the literal can silently desync JS from CSS.
export const MOBILE_TOUCH_MEDIA_QUERY = "(max-width: 768px) and (pointer: coarse)";

// Minimum height globals.css gives touch targets on coarse-pointer viewports. Shared so tests can
// reproduce that environment, which Storybook and Pixel cannot: neither emulates `pointer: coarse`.
export const MOBILE_TOUCH_TARGET_PX = 44;

// Width at or below which the app switches to its narrow layout (overlaying sidebar, PR badge in the
// workspace header instead of the footer info bar). Tailwind arbitrary variants cannot read a TS
// constant, so `[@media(max-width:768px)]` class strings repeat this literal.
export const NARROW_VIEWPORT_MAX_WIDTH_PX = 768;

// Keep composer controls aligned without relying on individual component defaults. This is a floor,
// not a fixed height: mobile raises touch targets to MOBILE_TOUCH_TARGET_PX, and a pill that caps
// its height would clip the controls inside it instead of growing with them.
export const COMPOSER_CONTROL_HEIGHT_CLASS = "min-h-6";

// The composer control row sheds detail in container-query stages as it narrows, widest threshold
// first. Keeping the ladder here rather than inline is what stops two controls in the row from
// disagreeing about when they collapse.
//
// These are tuned so a label only disappears once the row genuinely lacks the space for it. The
// model pill is content-sized (see ChatInput's ModelSelector className), so an over-long model name
// still truncates inside its own 8rem cap rather than forcing these labels out early.
export const COMPOSER_COMPACT_HIDE_CLASS = "[@container(max-width:500px)]:hidden";
export const COMPOSER_ICON_ONLY_HIDE_CLASS = "[@container(max-width:360px)]:hidden";
export const COMPOSER_PRO_HIDE_CLASS = "[@container(max-width:340px)]:hidden";

// Workspace rows also carry the context pill, so the agent label needs more room here than on the
// creation row. A container query cannot measure sibling text, so this is set for the widest
// realistic content (a long agent name next to a long model name at XHIGH) rather than the
// narrowest: the agent label does not shrink, so a threshold set too low shows a label that then
// squeezes its neighbours instead of hiding.
export const COMPOSER_WORKSPACE_ICON_ONLY_HIDE_CLASS = "[@container(max-width:450px)]:hidden";
