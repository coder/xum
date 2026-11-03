---
name: dev-server-sandbox
description: Run multiple isolated xum dev-server instances (temp XUM_ROOT + free ports)
---

# `dev-server` sandbox instances

`make dev-server` starts the xum backend server, which uses a lockfile at:

- `<XUM_ROOT>/server.lock` (defaults to `~/.xum-dev/server.lock` in development)

This means you can only run **one** dev server per xum root directory.

This skill documents the repo workflow for starting **multiple** dev-server instances in parallel (including from different git worktrees) by giving each instance its own temporary `XUM_ROOT`.

## Quick start

```bash
make dev-server-sandbox
```

## What it does

- Creates a fresh temporary `XUM_ROOT` directory
- Copies these files into the sandbox if present (unless disabled by flags):
  - `providers.jsonc` (provider config)
  - `config.json` (project list)
  - Each file is seeded independently from the first root that has it
    (`$XUM_ROOT`, then leftover `$MUX_ROOT`, then `~/.xum[-dev]`, then
    leftover `~/.mux[-dev]` / `~/.cmux`), so a root with only `config.json`
    doesn't drop provider config
- Provider credential env vars are stripped from the server's env when they
  could silently override or mismatch the intended setup: all of them with
  `--clean-providers` (including Bedrock's `AWS_REGION` and
  `AWS_BEARER_TOKEN_BEDROCK`; shared AWS credentials like `AWS_PROFILE` are
  kept); otherwise only `*_BASE_URL` env vars that would shadow a seeded
  `providers.jsonc` entry that has an `apiKey` but no explicit `baseUrl`
  (API key env vars are always kept so env-key fallback still works)
- Picks free ports (`BACKEND_PORT`, `VITE_PORT`)
- Disables tutorials by default inside the sandbox (`XUM_ENABLE_TUTORIALS_IN_SANDBOX=1` opts back in)
- Makes Vite accept loopback Host headers only (`localhost` and IPs). On a Coder workspace it also accepts the one port-forward host for the sandbox's Vite port, built from `XUM_PROXY_URI`, else `VSCODE_PROXY_URI`. The startup banner prints an `Allowed hosts:` line
- Runs `make dev-server` with those env overrides

## Agent usage with `bash.monitor`

When you need the sandbox to keep running while you continue or end the turn, start it as a monitored background bash. The monitor wakes the workspace on useful server output; call `task_await` only if you need surrounding logs.

```ts
bash({
  script: "make dev-server-sandbox",
  display_name: "Dev Server Sandbox",
  run_in_background: true,
  timeout_secs: 1800,
  monitor: {
    filter: "ready|listening|localhost|ERROR|EADDRINUSE|failed|Failed",
    cooldown_ms: 1000,
    max_events: 3,
  },
});
```

Use this for line-oriented server readiness/errors. For external status polling (PR checks, deployment health, remote CI), use a background task/workflow monitor instead.

## Options

```bash
# Start with a clean instance (do not copy providers or projects)
make dev-server-sandbox DEV_SERVER_SANDBOX_ARGS="--clean-providers --clean-projects"

# Skip copying providers.jsonc
make dev-server-sandbox DEV_SERVER_SANDBOX_ARGS="--clean-providers"

# Clear projects from config.json (preserves other config)
make dev-server-sandbox DEV_SERVER_SANDBOX_ARGS="--clean-projects"

# Use a specific root to seed from (default: per-file from $XUM_ROOT, leftover $MUX_ROOT, ~/.xum[-dev], leftover ~/.mux[-dev] / ~/.cmux)
SEED_XUM_ROOT=~/.xum-dev make dev-server-sandbox

# Keep the sandbox root directory after exit (useful for debugging)
KEEP_SANDBOX=1 make dev-server-sandbox

# Pin ports (must be different)
BACKEND_PORT=3001 VITE_PORT=5174 make dev-server-sandbox

# Re-enable tutorials for sandbox dogfooding
XUM_ENABLE_TUTORIALS_IN_SANDBOX=1 make dev-server-sandbox

# Override which make binary to use
MAKE=gmake make dev-server-sandbox
```

## Security notes

- The sandbox backend runs with `--no-auth`, and Vite proxies `/api`, `/orpc` and `/auth` to it. Any Host header Vite accepts therefore reaches an unauthenticated backend and the checkout's source. A web page that rebinds its DNS to this machine can use `Host: <its own name>` for that. So the sandbox never defaults to `all`.
- For another remote or proxy host, opt in with `XUM_VITE_ALLOWED_HOSTS=<host>[,<host>]` (the unprefixed `VITE_ALLOWED_HOSTS` also works). A Vite `403 Blocked request. This host ("...") is not allowed` means the Host is missing from that list. Use `all` only on a machine that no other user or browser can reach.
- `providers.jsonc` may contain API keys.
- The sandbox root directory is created on disk (usually under your system temp dir).
- This flow intentionally **does not** copy `secrets.json`.
