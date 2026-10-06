# The bug-bash sandbox image (#5714): tools only. The app (dist), node_modules and the tests
# come from the checkout at run time, read-only. sandbox/launch.ts tags the image with a hash
# of this file and its build args, and builds it when that tag is missing.
ARG BUN_VERSION=1.3.12
FROM oven/bun:${BUN_VERSION}-slim AS bun

FROM node:22-slim
ARG PLAYWRIGHT_CORE_VERSION
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright NPM_CONFIG_UPDATE_NOTIFIER=false
# git: startApp.ts seeds a git repo for the demo project.
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# The Chromium build that the checkout's @e2e-dev/web expects (launch.ts passes its version).
# e2e looks for both the full browser and the headless shell.
RUN test -n "$PLAYWRIGHT_CORE_VERSION" \
 && npx -y "playwright-core@${PLAYWRIGHT_CORE_VERSION}" install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache && chmod -R a+rX /ms-playwright
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
