// Browser bundles (renderer, Storybook, VS Code webview, chat-components) alias
// @ai-sdk/google-vertex to this module. The real SDK depends on google-auth-library,
// which needs Node built-ins and breaks browser builds. Only the backend creates Vertex
// models; browser code reads the provider's metadata and never calls its import().
export function createVertex(): never {
  throw new Error("@ai-sdk/google-vertex is Node-only and is not bundled for the browser");
}
