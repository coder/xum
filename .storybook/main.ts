import type { StorybookConfig } from "@storybook/react-vite";
import { mergeConfig } from "vite";
import { readFileSync } from "fs";
import path from "path";

// The boot loader's CSS is inlined in index.html so the pre-JS placeholder paints styled, and
// LoadingScreen (plus the update restart overlay built on it) reuses those classes. Lift the same
// rules into the preview so stories render them faithfully without a second copy of the CSS.
function bootLoaderStyles(): string {
  const html = readFileSync(path.join(process.cwd(), "index.html"), "utf8");
  const start = html.indexOf(".boot-loader {");
  const end = html.indexOf("</style>", start);
  if (start === -1 || end === -1) {
    throw new Error("index.html no longer contains the inline .boot-loader styles");
  }
  return html.slice(start, end);
}

const config: StorybookConfig = {
  stories: [
    "../src/browser/stories/**/*.stories.@(ts|tsx)",
    "../src/browser/components/**/*.stories.@(ts|tsx)",
    "../src/browser/features/**/*.stories.@(ts|tsx)",
  ],
  addons: ["@storybook/addon-links", "@storybook/addon-docs"],
  previewHead: (head) => `${head ?? ""}<style>${bootLoaderStyles()}</style>`,
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  viteFinal: async (config) => {
    return mergeConfig(config, {
      // Inherit project aliases. Storybook also needs a stable VERSION module so
      // stories that render chrome-only components (for example the landing-page
      // PR badge path through TitleBar/AboutDialog) do not depend on generated
      // src/version.ts existing in the local workspace.
      resolve: {
        alias: [
          {
            find: "@novnc/novnc/lib/rfb",
            replacement: path.join(process.cwd(), "src/browser/stories/mocks/desktopRfb.ts"),
          },
          {
            find: "@/version",
            replacement: path.join(process.cwd(), "src/browser/stories/mocks/version.ts"),
          },
          {
            find: "@",
            replacement: path.join(process.cwd(), "src"),
          },
        ],
      },
      // Prevent Vite from discovering new deps mid-test and forcing a full reload (test-storybook
      // interprets reloads as navigations and flakes). Keep this list minimal.
      optimizeDeps: {
        // Storybook test runs can flake if Vite decides to prebundle newly-discovered deps mid-run,
        // because the preview reload is interpreted as a navigation.
        include: ["@radix-ui/react-checkbox", "shiki"],
      },
      server: {
        watch: {
          // Native file events are unreliable in this environment; force polling so
          // edits to large story files (e.g. LeftSidebar.stories.tsx) are detected.
          usePolling: true,
          interval: 100,
          awaitWriteFinish: {
            stabilityThreshold: 200,
            pollInterval: 100,
          },
        },
      },
    });
  },
};

export default config;
