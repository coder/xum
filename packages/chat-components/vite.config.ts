import { defineConfig } from "vite";
import { resolve } from "path";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true,
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "MuxChatComponents",
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime"],
      output: {
        globals: {
          react: "React",
          "react-dom": "ReactDOM",
        },
      },
    },
    sourcemap: true,
    minify: false, // Keep readable for debugging
  },
  worker: {
    // Required because Mux uses Vite workers (Shiki highlighting).
    // 'iife' is incompatible with code-splitting builds.
    format: "es",
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "../../src"),
      // Node-only SDK; see the stub for why browser bundles never load it.
      "@ai-sdk/google-vertex": resolve(__dirname, "../../src/common/mocks/googleVertexStub.ts"),
    },
  },
});
