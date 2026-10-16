/**
 * The static workspace view (T3 #5971, Option C step 4): on a phone, `xum server` paints a static
 * copy of /workspace/<id> in this element before the app JS runs, and the app removes it once the
 * live chat view of that workspace replaces it (workspaceViewHandoff.tsx).
 */
export const WORKSPACE_VIEW_ID = "xum-pre-ws";
/** The view's workspace id. The early script sets it; only that workspace's chat view hands off. */
export const WORKSPACE_VIEW_WORKSPACE_ATTR = "data-workspace-id";
