#!/usr/bin/env bash
# One disposable, mock-AI Xum dev server per checkout, for verification runs (see ../SKILL.md).
#
#   verify-xum.sh launch           start and seed a sandbox, print its state
#   verify-xum.sh doctor [RUN]     read-only health check of a run
#   verify-xum.sh env [RUN]        print the run's `export` lines (eval them)
#   verify-xum.sh capture NAME [RUN]  screenshot + ARIA snapshot + URL into the run's evidence
#   verify-xum.sh idle [RUN]       wait until the open transcript is quiet and no CSS transition runs
#   verify-xum.sh send-ready [RUN] wait until the composer's Send button is enabled
#   verify-xum.sh cleanup [RUN]    stop the run's processes, delete its XUM_ROOT, keep evidence
#
# RUN defaults to the newest launch: $VERIFY_XUM_HOME/current.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECKOUT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
VERIFY_XUM_HOME=${VERIFY_XUM_HOME:-${XUM_SCRATCH_DIR:-${TMPDIR:-/tmp}}/verify-xum}
# Per-worktree path inside the git dir: two dev servers in one checkout share dist/ and
# node_modules/.vite and corrupt each other, so launch refuses while this names a live group.
LOCK=$(git -C "$CHECKOUT" rev-parse --path-format=absolute --git-path verify-xum.lock)
READY_TIMEOUT=${VERIFY_XUM_READY_TIMEOUT:-300}

die() {
  echo "verify-xum: $*" >&2
  exit 1
}

need() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null || die "missing tool: $tool"
  done
}

group_alive() {
  kill -0 -- "-$1" 2>/dev/null
}

load_run() {
  local run=${1:-$VERIFY_XUM_HOME/current}
  [[ -f $run/state.env ]] || die "no run at $run (run: verify-xum.sh launch)"
  # shellcheck source=/dev/null
  source "$run/state.env"
}

api() {
  curl -fsS -X POST "$VERIFY_XUM_BACKEND/api/$1" -H 'content-type: application/json' -d "$2"
}

json_string() {
  node -p 'JSON.stringify(process.argv[1])' "$1"
}

# Prints field $2 (a dotted path) of the JSON file $1, or nothing.
json_field() {
  node -e '
    const fs = require("fs");
    try {
      let v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const k of process.argv[2].split(".")) v = v?.[k];
      if (v !== undefined && v !== null) console.log(String(v));
    } catch {}' "$1" "$2"
}

# The backend is ready once the server that nodemon restarted after the first watch build
# (dist/.main-build-complete, written in ms) owns server.lock and answers /health.
backend_ready() {
  node -e '
    const fs = require("fs");
    const [lock, stamp, t0] = process.argv.slice(1);
    try {
      const built = Number(fs.readFileSync(stamp, "utf8"));
      const started = Date.parse(JSON.parse(fs.readFileSync(lock, "utf8")).startedAt);
      process.exit(built >= Number(t0) * 1000 && started > built ? 0 : 1);
    } catch {
      process.exit(1);
    }' "$VERIFY_XUM_ROOT/server.lock" "$CHECKOUT/dist/.main-build-complete" "$1" \
    && curl -fsS -o /dev/null "$VERIFY_XUM_BACKEND/health"
}

write_state() {
  local name
  : >"$VERIFY_XUM_RUN/state.env"
  for name in VERIFY_XUM_RUN VERIFY_XUM_CHECKOUT VERIFY_XUM_COMMIT VERIFY_XUM_PGID VERIFY_XUM_ROOT \
    VERIFY_XUM_BACKEND VERIFY_XUM_URL VERIFY_XUM_PROJECT VERIFY_XUM_WORKSPACE_ID \
    VERIFY_XUM_WORKTREE VERIFY_XUM_EVIDENCE AGENT_BROWSER_SESSION; do
    printf 'export %s=%q\n' "$name" "${!name-}" >>"$VERIFY_XUM_RUN/state.env"
  done
}

check_bun() {
  local want have
  want=$(node -p 'require(process.argv[1]).packageManager.split("@")[1]' "$CHECKOUT/package.json")
  have=$(bun --version)
  [[ $have == "$want" ]] \
    || die "bun $have is first on PATH but package.json pins $want. Put Bun $want first on PATH (mise: PATH=\"\$(mise where bun@$want)/bin:\$PATH\")."
}

create_demo_repo() {
  local repo=$1
  mkdir -p "$repo/src"
  printf '# Demo app\n\nA throwaway project for verify-xum.\n' >"$repo/README.md"
  printf 'export function add(a: number, b: number): number {\n  return a + b;\n}\n' >"$repo/src/math.ts"
  git -C "$repo" init -q -b main
  git -C "$repo" add .
  git -C "$repo" -c user.name=verify-xum -c user.email=verify-xum@example.test \
    -c commit.gpgsign=false commit -qm init
}

seed() {
  local created status_file status i
  api splashScreens/markSplashScreenViewed '{"splashId":"onboarding-wizard-v1"}' >/dev/null
  # The composer refuses to send without a configured provider. The mock never calls it,
  # and port 9 on loopback keeps any stray call on the machine.
  api providers/setProviderConfig '{"provider":"anthropic","keyPath":["apiKey"],"value":"sk-ant-verify-xum-fake"}' >/dev/null
  api providers/setProviderConfig '{"provider":"anthropic","keyPath":["baseUrl"],"value":"http://127.0.0.1:9/v1"}' >/dev/null
  create_demo_repo "$VERIFY_XUM_PROJECT"
  api projects/create "{\"projectPath\":$(json_string "$VERIFY_XUM_PROJECT")}" >/dev/null
  api projects/setTrust "{\"projectPath\":$(json_string "$VERIFY_XUM_PROJECT"),\"trusted\":true}" >/dev/null
  created="$VERIFY_XUM_RUN/scratch/workspace-create.json"
  api workspace/create "{\"projectPath\":$(json_string "$VERIFY_XUM_PROJECT"),\"branchName\":\"verify-playground\",\"trunkBranch\":\"main\",\"title\":\"Verify playground\"}" >"$created"
  VERIFY_XUM_WORKSPACE_ID=$(json_field "$created" metadata.id)
  [[ -n $VERIFY_XUM_WORKSPACE_ID ]] || die "workspace/create returned no id: $(head -c 400 "$created")"
  status_file="$VERIFY_XUM_ROOT/sessions/$VERIFY_XUM_WORKSPACE_ID/init-status.json"
  for ((i = 0; i < 120; i++)); do
    status=$(json_field "$status_file" status)
    [[ $status == success ]] && break
    [[ $status == error ]] && die "workspace setup failed, see $status_file"
    sleep 0.5
  done
  [[ $status == success ]] || die "workspace setup did not finish in 60 s"
  VERIFY_XUM_WORKTREE="$VERIFY_XUM_ROOT/src/$(basename "$VERIFY_XUM_PROJECT")/verify-playground"
  [[ -d $VERIFY_XUM_WORKTREE ]] || die "no worktree at $VERIFY_XUM_WORKTREE"
}

launch_failed() {
  echo "verify-xum: launch failed. Server log tail ($VERIFY_XUM_RUN/server.log):" >&2
  tail -n 30 "$VERIFY_XUM_RUN/server.log" >&2 || true
  cmd_cleanup "$VERIFY_XUM_RUN" >&2 || true
}

cmd_launch() {
  local old run_id t0 i backend_port vite_port log pidfile
  need git curl node bun make setsid ss agent-browser
  check_bun
  if [[ -f $LOCK ]]; then
    old=$(cat "$LOCK")
    if group_alive "$old"; then
      die "a verify-xum server already runs from this checkout (process group $old). Run verify-xum.sh cleanup first."
    fi
    rm -f "$LOCK"
  fi

  run_id="$(date -u +%Y%m%d-%H%M%S)-$$"
  VERIFY_XUM_RUN="$VERIFY_XUM_HOME/$run_id"
  VERIFY_XUM_EVIDENCE="$VERIFY_XUM_RUN/evidence"
  VERIFY_XUM_PROJECT="$VERIFY_XUM_RUN/scratch/demo-app"
  VERIFY_XUM_CHECKOUT=$CHECKOUT
  VERIFY_XUM_COMMIT=$(git -C "$CHECKOUT" rev-parse HEAD)
  AGENT_BROWSER_SESSION="verify-xum-$run_id"
  mkdir -p "$VERIFY_XUM_EVIDENCE" "$VERIFY_XUM_RUN/scratch"
  log="$VERIFY_XUM_RUN/server.log"
  pidfile="$VERIFY_XUM_RUN/scratch/pgid"
  t0=$(date +%s)

  # env -i: the agent's env carries the live Xum's PORT, auth token, proxy URIs and provider
  # keys. setsid: the server outlives this shell, and its process group is what cleanup kills.
  # The sh wrapper records that group: setsid forks when its caller already leads a group.
  # shellcheck disable=SC2016 # $$ and $@ belong to the inner sh.
  setsid sh -c 'echo "$$" >"$1"; shift; exec "$@"' sh "$pidfile" \
    env -i PATH="$PATH" HOME="$HOME" USER="${USER:-}" LANG="${LANG:-C.UTF-8}" TERM=dumb \
    TMPDIR="${TMPDIR:-/tmp}" XUM_MOCK_AI=1 XUM_DISABLE_TELEMETRY=1 \
    make -C "$CHECKOUT" dev-server-sandbox DEV_SERVER_SANDBOX_ARGS="--clean-providers --clean-projects" \
    >"$log" 2>&1 </dev/null &
  for ((i = 0; i < 50; i++)); do
    [[ -s $pidfile ]] && break
    sleep 0.1
  done
  VERIFY_XUM_PGID=$(cat "$pidfile")
  echo "$VERIFY_XUM_PGID" >"$LOCK"
  write_state
  ln -sfn "$VERIFY_XUM_RUN" "$VERIFY_XUM_HOME/current"
  trap launch_failed EXIT

  for ((i = 0; i < 120; i++)); do
    VERIFY_XUM_ROOT=$(sed -n 's/^  XUM_ROOT: *//p' "$log")
    backend_port=$(sed -n 's|^  Backend: *http://127.0.0.1:||p' "$log")
    vite_port=$(sed -n 's|^  Frontend: *http://localhost:||p' "$log")
    [[ -n $VERIFY_XUM_ROOT && -n $backend_port && -n $vite_port ]] && break
    group_alive "$VERIFY_XUM_PGID" || die "make dev-server-sandbox exited during startup"
    sleep 0.5
  done
  [[ -n $vite_port ]] || die "make dev-server-sandbox printed no XUM_ROOT and ports in 60 s"
  VERIFY_XUM_BACKEND="http://127.0.0.1:$backend_port"
  VERIFY_XUM_URL="http://127.0.0.1:$vite_port"
  write_state

  for ((i = 0; i < READY_TIMEOUT; i++)); do
    backend_ready "$t0" && curl -fsS -o /dev/null "$VERIFY_XUM_URL/" && break
    group_alive "$VERIFY_XUM_PGID" || die "the dev server exited before it was ready"
    sleep 1
  done
  ((i < READY_TIMEOUT)) || die "the dev server was not ready in $READY_TIMEOUT s"

  seed
  write_state
  trap - EXIT
  cat "$VERIFY_XUM_RUN/state.env"
  echo "ready: $VERIFY_XUM_URL/workspace/$VERIFY_XUM_WORKSPACE_ID"
}

serves_vite_ui() {
  curl -fsS "$1/" 2>/dev/null | grep -q '/@vite/client'
}

pid_in_group() {
  [[ -n $1 && $(ps -o pgid= -p "$1" 2>/dev/null | tr -d ' ') == "$2" ]]
}

cmd_doctor() {
  load_run "${1:-}"
  local failed=0 backend_pid version vite_port vite_pid
  check() {
    local label=$1
    shift
    if "$@"; then
      echo "ok    $label"
    else
      echo "FAIL  $label"
      failed=1
    fi
  }

  check "process group $VERIFY_XUM_PGID is alive" group_alive "$VERIFY_XUM_PGID"
  check "checkout lock $LOCK names this run" test "$(cat "$LOCK" 2>/dev/null)" = "$VERIFY_XUM_PGID"
  backend_pid=$(json_field "$VERIFY_XUM_ROOT/server.lock" pid)
  check "backend pid ${backend_pid:-none} (server.lock in $VERIFY_XUM_ROOT) belongs to this run" \
    pid_in_group "$backend_pid" "$VERIFY_XUM_PGID"
  check "server.lock names $VERIFY_XUM_BACKEND" \
    test "$(json_field "$VERIFY_XUM_ROOT/server.lock" baseUrl)" = "$VERIFY_XUM_BACKEND"
  check "GET $VERIFY_XUM_BACKEND/health answers" curl -fsS -o /dev/null "$VERIFY_XUM_BACKEND/health"
  curl -fsS "$VERIFY_XUM_BACKEND/version" -o "$VERIFY_XUM_RUN/scratch/version.json" 2>/dev/null || true
  version=$(json_field "$VERIFY_XUM_RUN/scratch/version.json" git_commit)
  check "backend build ${version:-unknown} is the launch commit $VERIFY_XUM_COMMIT" \
    test -n "$version" -a "${VERIFY_XUM_COMMIT#"$version"}" != "$VERIFY_XUM_COMMIT"
  if [[ $(git -C "$VERIFY_XUM_CHECKOUT" rev-parse HEAD) != "$VERIFY_XUM_COMMIT" ]]; then
    echo "note  HEAD moved since launch. Source edits hot-reload, /version keeps the launch commit."
  fi
  check "backend env has XUM_MOCK_AI=1" grep -qszx 'XUM_MOCK_AI=1' "/proc/${backend_pid:-0}/environ"
  vite_port=${VERIFY_XUM_URL##*:}
  vite_pid=$(ss -Hltnp "sport = :$vite_port" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -n 1)
  check "app port $vite_port is owned by this run (pid ${vite_pid:-none})" pid_in_group "$vite_pid" "$VERIFY_XUM_PGID"
  check "$VERIFY_XUM_URL serves the Vite dev UI" serves_vite_ui "$VERIFY_XUM_URL"
  return "$failed"
}

cmd_env() {
  load_run "${1:-}"
  cat "$VERIFY_XUM_RUN/state.env"
}

cmd_capture() {
  local name=${1:-} base
  [[ $name =~ ^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$ ]] || die "capture NAME must look like <feature>/<step>, lowercase"
  load_run "${2:-}"
  base="$VERIFY_XUM_EVIDENCE/$name"
  mkdir -p "$(dirname "$base")"
  agent-browser --session "$AGENT_BROWSER_SESSION" get url >"$base.url.txt"
  agent-browser --session "$AGENT_BROWSER_SESSION" snapshot >"$base.aria.txt"
  agent-browser --session "$AGENT_BROWSER_SESSION" screenshot "$base.png" >/dev/null
  echo "$base.png $base.aria.txt $base.url.txt"
}

# A click during a CSS transition (the right sidebar slides open in about 250 ms) can land where
# the target was, so idle also waits for running transitions to end.
cmd_idle() {
  load_run "${1:-}"
  agent-browser --session "$AGENT_BROWSER_SESSION" wait --fn \
    "document.querySelector('[role=log][aria-label=\"Conversation transcript\"]')?.getAttribute('aria-busy') === 'false' && !document.getAnimations().some((a) => a instanceof CSSTransition)" >/dev/null
}

cmd_send_ready() {
  load_run "${1:-}"
  agent-browser --session "$AGENT_BROWSER_SESSION" wait --fn \
    "document.querySelector('[aria-label=\"Send message\"]')?.disabled === false" >/dev/null
}

cmd_cleanup() {
  load_run "${1:-}"
  local i
  # `close` on a session that does not exist starts a browser first.
  if agent-browser session list 2>/dev/null | grep -qF "$AGENT_BROWSER_SESSION"; then
    agent-browser --session "$AGENT_BROWSER_SESSION" close >/dev/null 2>&1 || true
  fi
  if group_alive "$VERIFY_XUM_PGID"; then
    kill -TERM -- "-$VERIFY_XUM_PGID" 2>/dev/null || true
    for ((i = 0; i < 20; i++)); do
      group_alive "$VERIFY_XUM_PGID" || break
      sleep 1
    done
    group_alive "$VERIFY_XUM_PGID" && kill -KILL -- "-$VERIFY_XUM_PGID" 2>/dev/null
  fi
  # make dev-server-sandbox deletes its own root on a clean exit. Only a root it created
  # (mux-dev-server-*) is removed here.
  if [[ -n $VERIFY_XUM_ROOT && -d $VERIFY_XUM_ROOT && $(basename "$VERIFY_XUM_ROOT") == mux-dev-server-* ]]; then
    rm -rf "$VERIFY_XUM_ROOT"
  fi
  rm -rf "$VERIFY_XUM_RUN/scratch"
  [[ $(cat "$LOCK" 2>/dev/null) == "$VERIFY_XUM_PGID" ]] && rm -f "$LOCK"
  [[ $(readlink "$VERIFY_XUM_HOME/current" 2>/dev/null) == "$VERIFY_XUM_RUN" ]] && rm -f "$VERIFY_XUM_HOME/current"
  echo "stopped group $VERIFY_XUM_PGID; evidence kept in $VERIFY_XUM_EVIDENCE ($(find "$VERIFY_XUM_EVIDENCE" -type f | wc -l | tr -d ' ') files) and $VERIFY_XUM_RUN/server.log"
}

case ${1:-} in
  launch) cmd_launch ;;
  doctor) cmd_doctor "${2:-}" ;;
  env) cmd_env "${2:-}" ;;
  capture) cmd_capture "${2:-}" "${3:-}" ;;
  idle) cmd_idle "${2:-}" ;;
  send-ready) cmd_send_ready "${2:-}" ;;
  cleanup) cmd_cleanup "${2:-}" ;;
  *) die "usage: verify-xum.sh launch | doctor [RUN] | env [RUN] | capture NAME [RUN] | idle [RUN] | send-ready [RUN] | cleanup [RUN]" ;;
esac
