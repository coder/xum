#!/usr/bin/env bash
# One disposable, mock-AI Xum dev server per checkout, for verification runs (see ../SKILL.md).
#
#   verify-xum.sh launch           start and seed a sandbox, print its state
#   verify-xum.sh doctor [RUN]     read-only health check of a run
#   verify-xum.sh env [RUN]        print the run's `export` lines and put this script on PATH (eval them)
#   verify-xum.sh capture NAME [RUN]  screenshot + ARIA snapshot + URL into the run's evidence
#   verify-xum.sh idle [RUN]       wait until the page settles, exit 3 if a chunk failed to load
#   verify-xum.sh send-ready [RUN] wait until the composer's Send button is enabled
#   verify-xum.sh cleanup [RUN]    stop the run's processes, delete its XUM_ROOT, keep evidence
#
# RUN defaults to the newest launch from this checkout.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECKOUT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
# make -C runs the sandbox from the checkout, so a relative TMPDIR would resolve there.
[[ ${TMPDIR:-/tmp} == /* ]] || TMPDIR="$PWD/$TMPDIR"
VERIFY_XUM_HOME=${VERIFY_XUM_HOME:-${XUM_SCRATCH_DIR:-${TMPDIR:-/tmp}}/verify-xum}
# The run link in the git dir must point at an absolute path.
[[ $VERIFY_XUM_HOME == /* ]] || VERIFY_XUM_HOME="$PWD/$VERIFY_XUM_HOME"
CHECKOUT_GIT_DIR=$(git -C "$CHECKOUT" rev-parse --path-format=absolute --git-dir)
ONE_SERVER_PER_CHECKOUT_LOCK="$CHECKOUT_GIT_DIR/verify-xum.lock"
CURRENT_RUN_LINK="$CHECKOUT_GIT_DIR/verify-xum.current"
READY_TIMEOUT=${VERIFY_XUM_READY_TIMEOUT:-300}
DISCARD_BASE_URL=http://127.0.0.1:9/v1

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
  [[ -n $1 ]] && kill -0 -- "-$1" 2>/dev/null
}

# A process group belongs to this run only while one of its processes has
# VERIFY_XUM_SERVER_OF=<run id> in its env, so a group id reused after the run died is left alone.
# state.env never exports that name, so processes an agent starts after `eval "$(verify-xum.sh env)"`
# do not carry it. A live leader must also still be the `make dev-server-sandbox` that launch
# started. Linux reuses no pid while it names a process group, so a group whose leader exited
# keeps its id and stays ours. A zombie leader has an empty cmdline and counts as exited.
group_is_ours() {
  local pid leader_cmdline
  [[ -n $1 ]] || return 1
  if [[ -e /proc/$1 && $(ps -o stat= -p "$1" 2>/dev/null) != Z* ]]; then
    leader_cmdline=$(tr '\0' ' ' 2>/dev/null <"/proc/$1/cmdline" || true)
    [[ $leader_cmdline == *dev-server-sandbox* ]] || return 1
  fi
  for pid in $(ps -o pid= -g "$1" 2>/dev/null); do
    grep -qszx "VERIFY_XUM_SERVER_OF=$2" "/proc/$pid/environ" && return 0
  done
  return 1
}

# The kernel holds this flock while any process keeps fd 9 open: the launcher, and the server's
# `make` and `dev-server-sandbox.ts`, which inherit it at the spawn and live as long as the server.
# So the lock is held while a server from this checkout runs, at whatever point the launcher
# dies. The lock file only names the group, for doctor.
take_checkout_lock() {
  exec 9>"$ONE_SERVER_PER_CHECKOUT_LOCK.guard"
  flock -n 9 \
    || die "a verify-xum launch or server from this checkout holds $ONE_SERVER_PER_CHECKOUT_LOCK.guard, and two would share dist/ and node_modules/.vite. Run verify-xum.sh cleanup first. If it stays held, lsof that file to find the holder."
}

load_run() {
  local run=${1:-$CURRENT_RUN_LINK}
  [[ -f $run/state.env ]] || die "no run at $run (run: verify-xum.sh launch)"
  # shellcheck source=/dev/null
  source "$run/state.env"
  [[ $VERIFY_XUM_CHECKOUT == "$CHECKOUT" ]] \
    || die "run $run belongs to the checkout $VERIFY_XUM_CHECKOUT. Use that checkout's verify-xum.sh."
}

LAUNCH_DEADLINE=
before_launch_deadline() {
  ((SECONDS < LAUNCH_DEADLINE)) || die "launch did not finish in $READY_TIMEOUT s"
}

api() {
  before_launch_deadline
  curl -fsS --max-time $((LAUNCH_DEADLINE - SECONDS)) -X POST "$VERIFY_XUM_BACKEND/api/$1" \
    -H 'content-type: application/json' -d "$2"
}

json_string() {
  node -p 'JSON.stringify(process.argv[1])' "$1"
}

json_field_or_empty() {
  node -e '
    const fs = require("fs");
    try {
      let v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const k of process.argv[2].split(".")) v = v?.[k];
      if (v !== undefined && v !== null) console.log(String(v));
    } catch {}' "$1" "$2"
}

backend_ready() {
  node -e '
    const fs = require("fs");
    const [serverLock, buildStamp, launchSeconds] = process.argv.slice(1);
    try {
      const buildStampMs = Number(fs.readFileSync(buildStamp, "utf8"));
      const serverStartedMs = Date.parse(JSON.parse(fs.readFileSync(serverLock, "utf8")).startedAt);
      const builtSinceLaunch = buildStampMs >= Number(launchSeconds) * 1000;
      const serverRestartedAfterBuild = serverStartedMs > buildStampMs;
      process.exit(builtSinceLaunch && serverRestartedAfterBuild ? 0 : 1);
    } catch {
      process.exit(1);
    }' "$VERIFY_XUM_ROOT/server.lock" "$CHECKOUT/dist/.main-build-complete" "$1" \
    && curl -fs --max-time 5 -o /dev/null "$VERIFY_XUM_BACKEND/health"
}

write_state() {
  local name
  : >"$VERIFY_XUM_RUN/state.env"
  for name in VERIFY_XUM_RUN_ID VERIFY_XUM_RUN VERIFY_XUM_CHECKOUT VERIFY_XUM_COMMIT VERIFY_XUM_PGID VERIFY_XUM_ROOT \
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

seed_unreachable_fake_provider() {
  api providers/setProviderConfig '{"provider":"anthropic","keyPath":["apiKey"],"value":"sk-ant-verify-xum-fake"}' >/dev/null
  api providers/setProviderConfig "{\"provider\":\"anthropic\",\"keyPath\":[\"baseUrl\"],\"value\":\"$DISCARD_BASE_URL\"}" >/dev/null
}

seed() {
  local created status_file status
  api splashScreens/markSplashScreenViewed '{"splashId":"onboarding-wizard-v1"}' >/dev/null
  seed_unreachable_fake_provider
  create_demo_repo "$VERIFY_XUM_PROJECT"
  api projects/create "{\"projectPath\":$(json_string "$VERIFY_XUM_PROJECT")}" >/dev/null
  api projects/setTrust "{\"projectPath\":$(json_string "$VERIFY_XUM_PROJECT"),\"trusted\":true}" >/dev/null
  created="$VERIFY_XUM_RUN/scratch/workspace-create.json"
  api workspace/create "{\"projectPath\":$(json_string "$VERIFY_XUM_PROJECT"),\"branchName\":\"verify-playground\",\"trunkBranch\":\"main\",\"title\":\"Verify playground\"}" >"$created"
  VERIFY_XUM_WORKSPACE_ID=$(json_field_or_empty "$created" metadata.id)
  [[ -n $VERIFY_XUM_WORKSPACE_ID ]] || die "workspace/create returned no id: $(head -c 400 "$created")"
  status_file="$VERIFY_XUM_ROOT/sessions/$VERIFY_XUM_WORKSPACE_ID/init-status.json"
  while status=$(json_field_or_empty "$status_file" status); [[ $status != success ]]; do
    [[ $status == error ]] && die "workspace setup failed, see $status_file"
    before_launch_deadline
    sleep 0.5
  done
  VERIFY_XUM_WORKTREE="$VERIFY_XUM_ROOT/src/$(basename "$VERIFY_XUM_PROJECT")/verify-playground"
  [[ -d $VERIFY_XUM_WORKTREE ]] || die "no worktree at $VERIFY_XUM_WORKTREE"
}

launch_failed() {
  echo "verify-xum: launch failed. Server log tail ($VERIFY_XUM_RUN/server.log):" >&2
  tail -n 30 "$VERIFY_XUM_RUN/server.log" >&2 || true
  cmd_cleanup "$VERIFY_XUM_RUN" >&2 || true
}

cmd_launch() {
  local t0 i backend_port vite_port log pidfile
  need git curl node bun make setsid flock ss agent-browser
  check_bun
  take_checkout_lock

  VERIFY_XUM_RUN_ID="$(date -u +%Y%m%d-%H%M%S)-$$"
  VERIFY_XUM_RUN="$VERIFY_XUM_HOME/$VERIFY_XUM_RUN_ID"
  VERIFY_XUM_EVIDENCE="$VERIFY_XUM_RUN/evidence"
  VERIFY_XUM_PROJECT="$VERIFY_XUM_RUN/scratch/demo-app"
  VERIFY_XUM_CHECKOUT=$CHECKOUT
  VERIFY_XUM_COMMIT=$(git -C "$CHECKOUT" rev-parse HEAD)
  AGENT_BROWSER_SESSION="verify-xum-$VERIFY_XUM_RUN_ID"
  mkdir -p "$VERIFY_XUM_EVIDENCE" "$VERIFY_XUM_RUN/scratch"
  log="$VERIFY_XUM_RUN/server.log"
  pidfile="$VERIFY_XUM_RUN/scratch/pgid"
  t0=$(date +%s)
  LAUNCH_DEADLINE=$((SECONDS + READY_TIMEOUT))

  local env_without_live_xum=(env -i PATH="$PATH" HOME="$HOME" USER="${USER:-}" LANG="${LANG:-C.UTF-8}"
    TERM=dumb TMPDIR="${TMPDIR:-/tmp}" XUM_MOCK_AI=1 XUM_DISABLE_TELEMETRY=1
    VERIFY_XUM_SERVER_OF="$VERIFY_XUM_RUN_ID")
  # Saved before the spawn, so cleanup finds a launch killed at any point after it.
  write_state
  ln -sfn "$VERIFY_XUM_RUN" "$CURRENT_RUN_LINK"
  trap launch_failed EXIT
  # setsid(1) forks when its caller already leads a process group, so $! can miss the new
  # group. The inner sh records its own pid, which is the new group id.
  # shellcheck disable=SC2016
  setsid sh -c 'echo "$$" >"$1"; shift; exec "$@"' sh "$pidfile" "${env_without_live_xum[@]}" \
    make -C "$CHECKOUT" dev-server-sandbox DEV_SERVER_SANDBOX_ARGS="--clean-providers --clean-projects" \
    >"$log" 2>&1 </dev/null &
  for ((i = 0; i < 50; i++)); do
    [[ -s $pidfile ]] && break
    sleep 0.1
  done
  VERIFY_XUM_PGID=$(cat "$pidfile")
  echo "$VERIFY_XUM_PGID" >"$ONE_SERVER_PER_CHECKOUT_LOCK"
  write_state

  while true; do
    VERIFY_XUM_ROOT=$(sed -n 's/^  XUM_ROOT: *//p' "$log")
    backend_port=$(sed -n 's|^  Backend: *http://127.0.0.1:||p' "$log")
    vite_port=$(sed -n 's|^  Frontend: *http://localhost:||p' "$log")
    [[ -n $VERIFY_XUM_ROOT && -n $backend_port && -n $vite_port ]] && break
    group_alive "$VERIFY_XUM_PGID" || die "make dev-server-sandbox exited during startup"
    before_launch_deadline
    sleep 0.5
  done
  VERIFY_XUM_BACKEND="http://127.0.0.1:$backend_port"
  VERIFY_XUM_URL="http://127.0.0.1:$vite_port"
  write_state

  until backend_ready "$t0" && curl -fs --max-time 5 -o /dev/null "$VERIFY_XUM_URL/"; do
    before_launch_deadline
    group_alive "$VERIFY_XUM_PGID" || die "the dev server exited before it was ready"
    sleep 1
  done

  seed
  write_state
  trap - EXIT
  cat "$VERIFY_XUM_RUN/state.env"
  echo "ready: $VERIFY_XUM_URL/workspace/$VERIFY_XUM_WORKSPACE_ID"
}

serves_vite_ui() {
  curl -fs --max-time 5 "$1/" 2>/dev/null | grep -q '/@vite/client'
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

  check "process group $VERIFY_XUM_PGID is alive and carries this run's id" group_is_ours "$VERIFY_XUM_PGID" "$VERIFY_XUM_RUN_ID"
  check "checkout lock $ONE_SERVER_PER_CHECKOUT_LOCK names this run" test "$(cat "$ONE_SERVER_PER_CHECKOUT_LOCK" 2>/dev/null)" = "$VERIFY_XUM_PGID"
  backend_pid=$(json_field_or_empty "$VERIFY_XUM_ROOT/server.lock" pid)
  check "backend pid ${backend_pid:-none} (server.lock in $VERIFY_XUM_ROOT) belongs to this run" \
    pid_in_group "$backend_pid" "$VERIFY_XUM_PGID"
  check "server.lock names $VERIFY_XUM_BACKEND" \
    test "$(json_field_or_empty "$VERIFY_XUM_ROOT/server.lock" baseUrl)" = "$VERIFY_XUM_BACKEND"
  check "GET $VERIFY_XUM_BACKEND/health answers" curl -fs --max-time 5 -o /dev/null "$VERIFY_XUM_BACKEND/health"
  version=$(curl -fs --max-time 5 "$VERIFY_XUM_BACKEND/version" 2>/dev/null | json_field_or_empty /dev/stdin git_commit || true)
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
  # The feature recipes call the helper by its bare name. $PATH expands when the caller evals.
  # shellcheck disable=SC2016
  printf 'export PATH=%q:"$PATH"\n' "$SCRIPT_DIR"
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

CHUNK_LOAD_FAILED_JS="[...document.querySelectorAll('[role=\"alert\"]')].some((e) => e.textContent.includes(' failed to load.'))"
SETTLED_OR_CHUNK_FAILED_JS="(() => {
  if ($CHUNK_LOAD_FAILED_JS) return true;
  const log = document.querySelector('[role=\"log\"][aria-label=\"Conversation transcript\"]');
  if (location.pathname.startsWith('/workspace/') && log?.getAttribute('aria-busy') !== 'false') return false;
  return !document.getAnimations().some((a) => a instanceof CSSTransition);
})()"

cmd_idle() {
  load_run "${1:-}"
  agent-browser --session "$AGENT_BROWSER_SESSION" wait --fn "$SETTLED_OR_CHUNK_FAILED_JS" >/dev/null
  if [[ $(agent-browser --session "$AGENT_BROWSER_SESSION" eval "$CHUNK_LOAD_FAILED_JS") == true ]]; then
    echo "verify-xum: the page shows '<name> failed to load.': a module fetch from Vite failed. Run agent-browser reload, then repeat the step." >&2
    exit 3
  fi
}

cmd_send_ready() {
  load_run "${1:-}"
  agent-browser --session "$AGENT_BROWSER_SESSION" wait --fn \
    "document.querySelector('[aria-label=\"Send message\"]')?.disabled === false" >/dev/null
}

is_dev_server_sandbox_root() {
  [[ -n $1 && -d $1 && $(basename "$1") == mux-dev-server-* ]]
}

cmd_cleanup() {
  load_run "${1:-}"
  local i
  # A launch killed before it saved these left them only in the pidfile and the server log.
  [[ -n $VERIFY_XUM_PGID ]] || VERIFY_XUM_PGID=$(cat "$VERIFY_XUM_RUN/scratch/pgid" 2>/dev/null || true)
  [[ -n $VERIFY_XUM_ROOT ]] || VERIFY_XUM_ROOT=$(sed -n 's/^  XUM_ROOT: *//p' "$VERIFY_XUM_RUN/server.log" 2>/dev/null || true)
  # agent-browser `close` on a session that does not exist starts that session first.
  if agent-browser session list 2>/dev/null | grep -qF "$AGENT_BROWSER_SESSION"; then
    agent-browser --session "$AGENT_BROWSER_SESSION" close >/dev/null 2>&1 || true
  fi
  if group_is_ours "$VERIFY_XUM_PGID" "$VERIFY_XUM_RUN_ID"; then
    kill -TERM -- "-$VERIFY_XUM_PGID" 2>/dev/null || true
    for ((i = 0; i < 20; i++)); do
      group_alive "$VERIFY_XUM_PGID" || break
      sleep 1
    done
    if group_is_ours "$VERIFY_XUM_PGID" "$VERIFY_XUM_RUN_ID"; then
      kill -KILL -- "-$VERIFY_XUM_PGID" 2>/dev/null || true
    fi
  elif group_alive "$VERIFY_XUM_PGID"; then
    echo "verify-xum: process group $VERIFY_XUM_PGID is not this run's dev server. Not signaling it." >&2
  fi
  if is_dev_server_sandbox_root "$VERIFY_XUM_ROOT"; then
    rm -rf "$VERIFY_XUM_ROOT"
  fi
  rm -rf "$VERIFY_XUM_RUN/scratch"
  [[ $(cat "$ONE_SERVER_PER_CHECKOUT_LOCK" 2>/dev/null) == "$VERIFY_XUM_PGID" ]] && rm -f "$ONE_SERVER_PER_CHECKOUT_LOCK"
  [[ $(readlink "$CURRENT_RUN_LINK" 2>/dev/null) == "$VERIFY_XUM_RUN" ]] && rm -f "$CURRENT_RUN_LINK"
  VERIFY_XUM_PGID=
  write_state
  echo "cleaned up run $VERIFY_XUM_RUN_ID; evidence kept in $VERIFY_XUM_EVIDENCE ($(find "$VERIFY_XUM_EVIDENCE" -type f | wc -l | tr -d ' ') files) and $VERIFY_XUM_RUN/server.log"
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
