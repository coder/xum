# The bug-bash sandbox image (#5714): tools only. The app (dist), node_modules and the tests come
# from the checkout at run time, read-only. Build it with build.sh only: it passes the build args,
# an empty build context, and no cache.
#
# The image is published by the main branch only (.github/workflows/bugbash-sandbox-image.yml),
# and runners pull it by the digest in image.json. The base images are pinned by digest. The
# Debian apt mirror and the Playwright download CDN are not pinned: the build trusts them, and
# the published digest fixes the bytes after the build.
FROM oven/bun:1.3.12-slim@sha256:d3c7094c144dd3975d183a4dbc4ec0a764223995bff73290d983edb47043a75f AS bun

FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
# The playwright-core version of the checkout's @e2e-dev/web (build.sh reads it from bun.lock).
ARG PLAYWRIGHT_CORE_VERSION
# The inputs key (build.sh --key). The runner refuses an image whose label differs from the
# key of its checkout.
ARG INPUTS_SHA256
LABEL org.xum.bugbash.inputs=$INPUTS_SHA256 \
      org.xum.bugbash.playwright-core=$PLAYWRIGHT_CORE_VERSION \
      org.opencontainers.image.source=https://github.com/coder/xum
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright NPM_CONFIG_UPDATE_NOTIFIER=false
# git: startApp.ts seeds a git repo for the demo project.
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# The Chromium build that this playwright-core drives. e2e looks for both the full browser and
# the headless shell, and `install chromium` gets both.
RUN test -n "$PLAYWRIGHT_CORE_VERSION" && test -n "$INPUTS_SHA256" \
 && npx -y "playwright-core@${PLAYWRIGHT_CORE_VERSION}" install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache && chmod -R a+rX /ms-playwright
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
