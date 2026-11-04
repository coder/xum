#!/usr/bin/env bash
# One disposable, mock-AI Xum dev server per checkout, for verification runs (see ../SKILL.md).
#
#   verify-xum.sh launch           start and seed a sandbox, print its state
#   verify-xum.sh doctor [RUN]     read-only health check of a run
#   verify-xum.sh env [RUN]        print the run's `export` lines, put this script on PATH, clear git's
#                                  repo variables (eval them)
#   verify-xum.sh open PATH [RUN]  open PATH of the run's UI in its browser session, token in no argv
#   verify-xum.sh workspace-field NAME FIELD [RUN]  print FIELD of workspace NAME from config.json
#   verify-xum.sh capture NAME [RUN]  screenshot + ARIA snapshot + URL into the run's evidence
#   verify-xum.sh idle [RUN]       wait until the page settles, exit 3 if a chunk failed to load
#   verify-xum.sh send-ready [RUN] wait until the composer's Send button is enabled
#   verify-xum.sh cleanup [RUN]    stop the run's processes, delete its XUM_ROOT, keep evidence
#
# RUN defaults to the newest launch from this checkout.
set -euo pipefail

# Git variables that point git at another repository (a hook's GIT_INDEX_FILE, an exported
# GIT_DIR, config from GIT_CONFIG_*) would make the checkout lookups and the demo repo's
# `git -C` commands below act on that repository: `git add .` would replace its index. This
# script clears them, and the `env` output clears them for the recipes' git commands too. The
# list is `git rev-parse --local-env-vars` plus the discovery and config variables.
# shellcheck disable=SC2046,SC2086 # lists of variable names
{
  GIT_REPO_ENV="GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_IMPLICIT_WORK_TREE GIT_GRAFT_FILE
    GIT_NO_REPLACE_OBJECTS GIT_REPLACE_REF_BASE GIT_SHALLOW_FILE GIT_PREFIX GIT_NAMESPACE
    GIT_CEILING_DIRECTORIES GIT_DISCOVERY_ACROSS_FILESYSTEM ${!GIT_CONFIG*}"
  unset $GIT_REPO_ENV
  # Names a newer git adds to its own list.
  GIT_REPO_ENV=$(printf '%s\n' $GIT_REPO_ENV $(git rev-parse --local-env-vars) | sort -u | tr '\n' ' ')
  unset $GIT_REPO_ENV
}

# With CDPATH set, `cd` to a relative folder can pick another folder and print its name, which
# the command substitutions below would capture.
unset CDPATH
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECKOUT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
# Never a shared TMPDIR: another local account could create the folder first and swap a run's
# state.env, which this script sources (see require_private_dir).
VERIFY_XUM_HOME=${VERIFY_XUM_HOME:-${XUM_SCRATCH_DIR:+$XUM_SCRATCH_DIR/verify-xum}}
VERIFY_XUM_HOME=${VERIFY_XUM_HOME:-${XDG_RUNTIME_DIR:+$XDG_RUNTIME_DIR/verify-xum}}
VERIFY_XUM_HOME=${VERIFY_XUM_HOME:-$HOME/.cache/verify-xum}
# The run link in the git dir must point at an absolute path.
[[ $VERIFY_XUM_HOME == /* ]] || VERIFY_XUM_HOME="$PWD/$VERIFY_XUM_HOME"
CHECKOUT_GIT_DIR=$(git -C "$CHECKOUT" rev-parse --path-format=absolute --git-dir)
LAUNCH_GUARD="$CHECKOUT_GIT_DIR/verify-xum.lock.guard"
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

# A run's state.env is sourced, so the run folder and the home above it must be real folders (no
# symlinks), owned by this user and writable by nobody else.
require_private_dir() {
  local dir=$1 mode
  [[ -d $dir && ! -L $dir ]] || die "$dir is not a real folder"
  [[ $(stat -c %u "$dir") == "$(id -u)" ]] || die "$dir is not owned by user $(id -u)"
  mode=$(stat -c %a "$dir")
  (((8#$mode & 8#022) == 0)) || die "$dir is writable by group or others (mode $mode)"
}

# Every folder above a run home must be owned by root or this user and writable by nobody else,
# unless it is sticky like /tmp (as ssh's StrictModes checks): another account could otherwise
# rename the checked home away and put its own state.env in its place. Takes a physical path.
require_safe_ancestors() {
  local dir=$1 owner mode
  while [[ $dir != / ]]; do
    dir=$(dirname "$dir")
    owner=$(stat -c %u "$dir")
    mode=$(stat -c %a "$dir")
    [[ $owner == 0 || $owner == "$(id -u)" ]] || die "$dir, above the run home, is owned by user $owner"
    (((8#$mode & 8#022) == 0 || (8#$mode & 8#1000) != 0)) \
      || die "$dir, above the run home, is writable by group or others and not sticky (mode $mode)"
  done
}

# A path without its trailing slashes: `-L dir/` follows the link, so `link//` would pass as a
# real folder.
without_trailing_slashes() {
  local path=$1
  while [[ $path == ?*/ ]]; do path=${path%/}; done
  echo "$path"
}

# The folder Vite allows by default (server.fs.allow): the workspace root it finds at or above the
# checkout, which can be a parent folder (one whose package.json declares workspaces, for example).
# The checkout's own vite computes it from the physical checkout, as `vite` started there does, so
# this check cannot drift from Vite's rules. Fails closed: without an answer, no home is safe.
vite_workspace_root() {
  local root
  if root=$(cd -P -- "$CHECKOUT" && node --input-type=module -e '
    import { createRequire } from "node:module";
    import { pathToFileURL } from "node:url";
    const vite = createRequire(process.cwd() + "/package.json").resolve("vite");
    console.log((await import(pathToFileURL(vite).href)).searchForWorkspaceRoot(process.cwd()));
  ') && [[ $root == /* && $root != *$'\n'* ]]; then
    echo "$root"
  else
    die "the checkout's vite did not report its workspace root, so the run home cannot be checked against the folders Vite serves. Run \`bun install\` in $CHECKOUT."
  fi
}

# Vite serves every file under the checkout to whoever reaches its port (vite.config.ts denies only
# a few names), so a run home there would publish the run's token copy, its evidence and its
# sandbox. Refuses a home whose physical path (symlinks and .. resolved, even for parts that do
# not exist yet) is inside the checkout, inside the main worktree of a linked one, or inside
# Vite's workspace root.
require_home_outside_checkout() { # require_home_outside_checkout <home>
  local home top common vite_root
  home=$(realpath -m -- "$1")
  common=$(git -C "$CHECKOUT" rev-parse --path-format=absolute --git-common-dir)
  vite_root=$(vite_workspace_root) || exit 1
  for top in "$CHECKOUT" "$([[ $(basename "$common") == .git ]] && dirname "$common")" "$vite_root"; do
    [[ -n $top ]] || continue
    top=$(realpath -m -- "$top")
    if [[ $top == / || $home == "$top" || $home == "$top"/* ]]; then
      die "the run home $home is inside $top (the checkout, its main worktree or Vite's workspace root), where Vite serves every file to anyone who reaches its port (the run's token too). Set VERIFY_XUM_HOME to a folder outside it."
    fi
  done
}

# The physical path of a run home, after checking it and every folder above it. Later reads use
# that path, so no symlink above the home is followed again.
checked_home() {
  local home
  home=$(without_trailing_slashes "$1")
  [[ -d $home && ! -L $home ]] || die "$home is not a real folder"
  home=$(cd -P -- "$home" && pwd -P)
  require_home_outside_checkout "$home"
  require_private_dir "$home"
  require_safe_ancestors "$home"
  echo "$home"
}

# The run folder of a run argument, or behind the newest-run link (the one symlink allowed),
# checked before its state.env is read.
private_run_dir() {
  local run home
  run=$(without_trailing_slashes "$1")
  [[ $run == "$CURRENT_RUN_LINK" ]] && run=$(readlink "$run")
  home=$(checked_home "$(dirname "$run")") || exit 1
  run="$home/$(basename "$run")"
  require_private_dir "$run"
  echo "$run"
}

# Opens the launch guard on fd 9 for flock. It sits in the checkout's git dir, which another
# account can write in a shared repository: a symlink planted there made `9>` truncate its target.
# The guard is created with O_EXCL (noclobber), which never follows a symlink, and opened read
# only, which can neither create nor truncate anything (flock needs no write access). Then fd 9
# must be the regular file of this user that the path names.
open_launch_guard() {
  [[ -e $LAUNCH_GUARD || -L $LAUNCH_GUARD ]] || (set -C && : >"$LAUNCH_GUARD") 2>/dev/null || true
  [[ -f $LAUNCH_GUARD && ! -L $LAUNCH_GUARD ]] || die "$LAUNCH_GUARD is not a regular file (a symlink?). Remove it."
  exec 9<"$LAUNCH_GUARD"
  [[ $(stat -L -c '%d:%i:%u' /proc/self/fd/9) == "$(stat -c '%d:%i' -- "$LAUNCH_GUARD"):$(id -u)" ]] \
    || die "$LAUNCH_GUARD is not owned by user $(id -u), or it changed while it was opened. Remove it."
}

# One server per checkout: two would share dist/ and node_modules/.vite. The guard is the newest
# run's process group, which records its own id in that run's state.env before it starts the
# server. The flock keeps two launches from passing the check at once, and it also covers the
# moment between the spawn and that record: the new group holds the flock until it has written
# its id, wherever the launcher dies. The server does not inherit it.
refuse_while_checkout_server_runs() {
  open_launch_guard
  # Part of the launch deadline: a short VERIFY_XUM_READY_TIMEOUT also bounds this wait.
  flock -w "$(launch_seconds_left)" 9 || die "another verify-xum launch from this checkout holds $LAUNCH_GUARD"
  [[ -f $CURRENT_RUN_LINK/state.env ]] || return 0
  local run
  run=$(private_run_dir "$CURRENT_RUN_LINK") || exit 1
  (
    # shellcheck source=/dev/null
    source "$run/state.env"
    ! group_is_ours "$VERIFY_XUM_PGID" "$VERIFY_XUM_RUN_ID"
  ) || die "the verify-xum run $(readlink "$CURRENT_RUN_LINK") still runs from this checkout. Run verify-xum.sh cleanup first."
}

load_run() {
  local run=${1:-$CURRENT_RUN_LINK}
  [[ -f $run/state.env ]] || die "no run at $run (run: verify-xum.sh launch)"
  run=$(private_run_dir "$run") || exit 1
  # shellcheck source=/dev/null
  source "$run/state.env"
  [[ $VERIFY_XUM_CHECKOUT == "$CHECKOUT" ]] \
    || die "run $run belongs to the checkout $VERIFY_XUM_CHECKOUT. Use that checkout's verify-xum.sh."
}

LAUNCH_DEADLINE=
before_launch_deadline() {
  ((SECONDS < LAUNCH_DEADLINE)) || die "launch did not finish in $READY_TIMEOUT s"
}

# Seconds left before the launch deadline, at least 1: curl reads `--max-time 0` as no limit.
launch_seconds_left() {
  local left=$((LAUNCH_DEADLINE - SECONDS))
  ((left > 0)) || left=1
  echo "$left"
}

# A readiness probe that gives up at the launch deadline.
probe_before_launch_deadline() {
  before_launch_deadline
  curl -fs --max-time "$(launch_seconds_left)" -o /dev/null "$1"
}

# A backend started with auth (#7904's `make dev-server`) records its token in server.lock. The
# header goes to curl on stdin, so the token stays out of every process's argv.
backend_curl() {
  local token
  token=$(json_field_or_empty "$VERIFY_XUM_ROOT/server.lock" token)
  if [[ -n $token ]]; then
    printf 'Authorization: Bearer %s\n' "$token" | curl -H @- "$@"
  else
    curl "$@"
  fi
}

api() {
  before_launch_deadline
  backend_curl -fsS --max-time "$(launch_seconds_left)" -X POST "$VERIFY_XUM_BACKEND/api/$1" \
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
    const [serverLock, buildStamp, launchMs] = process.argv.slice(1);
    try {
      const buildStampMs = Number(fs.readFileSync(buildStamp, "utf8"));
      const serverStartedMs = Date.parse(JSON.parse(fs.readFileSync(serverLock, "utf8")).startedAt);
      const builtSinceLaunch = buildStampMs >= Number(launchMs);
      const serverRestartedAfterBuild = serverStartedMs > buildStampMs;
      process.exit(builtSinceLaunch && serverRestartedAfterBuild ? 0 : 1);
    } catch {
      process.exit(1);
    }' "$VERIFY_XUM_ROOT/server.lock" "$CHECKOUT/dist/.main-build-complete" "$1" \
    && probe_before_launch_deadline "$VERIFY_XUM_BACKEND/health"
}

write_state() {
  local name
  for name in VERIFY_XUM_RUN_ID VERIFY_XUM_RUN VERIFY_XUM_CHECKOUT VERIFY_XUM_COMMIT VERIFY_XUM_PGID VERIFY_XUM_ROOT \
    VERIFY_XUM_BACKEND VERIFY_XUM_URL VERIFY_XUM_PROJECT VERIFY_XUM_WORKSPACE_ID \
    VERIFY_XUM_WORKTREE VERIFY_XUM_EVIDENCE AGENT_BROWSER_SESSION; do
    printf 'export %s=%q\n' "$name" "${!name-}"
  done >"$VERIFY_XUM_RUN/state.env.tmp"
  mv -f "$VERIFY_XUM_RUN/state.env.tmp" "$VERIFY_XUM_RUN/state.env"
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
    -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -qm init
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

# nodemon waits for a file change after the backend crashes, and none comes during a launch. A
# crash before the first rebuild is expected (a stale dist/): the rebuild restarts it.
backend_crashed_after_rebuild() {
  sed 's/\x1b\[[0-9;]*m//g' "$1" | awk '
    /\[nodemon\] starting `.*dist\/cli\/index\.js server/ && prefix == "" { prefix = $1 }
    prefix != "" && $1 == prefix && /\[nodemon\] restarting due to changes/ { rebuilt = 1; crashed = 0 }
    prefix != "" && $1 == prefix && /\[nodemon\] app crashed/ { crashed = rebuilt }
    END { exit !crashed }'
}

launch_failed() {
  echo "verify-xum: launch failed. Server log tail ($VERIFY_XUM_RUN/server.log):" >&2
  tail -n 30 "$VERIFY_XUM_RUN/server.log" >&2 || true
  if [[ -z $VERIFY_XUM_PGID ]]; then
    # A signal can stop the launcher after the spawn and before the new group records its id.
    # That group holds the launch flock until it has written the id or died, so take the flock
    # anew and let cleanup read the id. Without it cleanup would drop the newest-run link while
    # the server starts, and the next launch would start a second one.
    exec 9>&-
    open_launch_guard
    if ! flock -w 10 9; then
      echo "verify-xum: the new process group did not record its id in 10 s. The newest-run link stays: run verify-xum.sh cleanup." >&2
      return 0
    fi
  fi
  cmd_cleanup "$VERIFY_XUM_RUN" >&2 || true
}

cmd_launch() {
  local t0 backend_port vite_port log token
  need git curl node bun make setsid flock ss realpath agent-browser
  check_bun
  LAUNCH_DEADLINE=$((SECONDS + READY_TIMEOUT))
  refuse_while_checkout_server_runs

  # Before any folder is made: a refused home creates nothing.
  require_home_outside_checkout "$VERIFY_XUM_HOME"
  if [[ ! -e $VERIFY_XUM_HOME ]]; then
    # Parents this creates are private too, whatever the caller's umask.
    (umask 077 && mkdir -p "$(dirname "$VERIFY_XUM_HOME")")
    # Check the folders above before the home is made in them (the home itself does not exist yet).
    require_safe_ancestors "$(cd -P -- "$(dirname "$VERIFY_XUM_HOME")" && pwd -P)/home"
    mkdir -m 700 "$VERIFY_XUM_HOME"
  fi
  VERIFY_XUM_HOME=$(checked_home "$VERIFY_XUM_HOME") || exit 1
  VERIFY_XUM_RUN_ID="$(date -u +%Y%m%d-%H%M%S)-$$"
  VERIFY_XUM_RUN="$VERIFY_XUM_HOME/$VERIFY_XUM_RUN_ID"
  VERIFY_XUM_EVIDENCE="$VERIFY_XUM_RUN/evidence"
  VERIFY_XUM_PROJECT="$VERIFY_XUM_RUN/scratch/demo-app"
  VERIFY_XUM_CHECKOUT=$CHECKOUT
  VERIFY_XUM_COMMIT=$(git -C "$CHECKOUT" rev-parse HEAD)
  AGENT_BROWSER_SESSION="verify-xum-$VERIFY_XUM_RUN_ID"
  mkdir -m 700 "$VERIFY_XUM_RUN"
  mkdir -p "$VERIFY_XUM_EVIDENCE" "$VERIFY_XUM_RUN/scratch"
  # The server tree's TMPDIR is a folder of this run, never the caller's: the sandbox makes its
  # XUM_ROOT there, and the backend writes server.lock with the token into it. In a shared TMPDIR
  # another account could swap that folder before the backend writes.
  mkdir -m 700 "$VERIFY_XUM_RUN/tmp"
  require_private_dir "$VERIFY_XUM_RUN/tmp"
  log="$VERIFY_XUM_RUN/server.log"
  # Milliseconds: a stamp from earlier in the launch's own second is a stale build.
  t0=$(date +%s%3N)

  local env_without_live_xum=(env -i PATH="$PATH" HOME="$HOME" USER="${USER:-}" LANG="${LANG:-C.UTF-8}"
    TERM=dumb TMPDIR="$VERIFY_XUM_RUN/tmp" XUM_MOCK_AI=1 XUM_DISABLE_TELEMETRY=1
    VERIFY_XUM_SERVER_OF="$VERIFY_XUM_RUN_ID")
  # A shell that ran `eval "$(verify-xum.sh env)"` still exports the previous run's values.
  VERIFY_XUM_PGID='' VERIFY_XUM_ROOT='' VERIFY_XUM_BACKEND='' VERIFY_XUM_URL=''
  VERIFY_XUM_WORKSPACE_ID='' VERIFY_XUM_WORKTREE=''
  write_state
  ln -sfn "$VERIFY_XUM_RUN" "$CURRENT_RUN_LINK"
  trap launch_failed EXIT
  # The new group's leader appends its pid, which is the group id, to state.env before it starts
  # make. From then on the launch guard and cleanup find the group, wherever the launcher dies.
  # The leader carries VERIFY_XUM_SERVER_OF from its start, so group_is_ours matches it as soon
  # as the id is written. It holds the launch flock (fd 9) until then and closes it before make.
  # (setsid(1) forks when its caller already leads a process group, so $! can miss the group.)
  # shellcheck disable=SC2016
  VERIFY_XUM_SERVER_OF="$VERIFY_XUM_RUN_ID" setsid sh -c 'printf "export VERIFY_XUM_PGID=%s\n" "$$" >>"$1"; exec 9>&-; shift; exec "$@"' sh \
    "$VERIFY_XUM_RUN/state.env" "${env_without_live_xum[@]}" \
    make -C "$CHECKOUT" dev-server-sandbox DEV_SERVER_SANDBOX_ARGS="--clean-providers --clean-projects" \
    >"$log" 2>&1 </dev/null &
  until VERIFY_XUM_PGID=$(sed -n 's/^export VERIFY_XUM_PGID=\([0-9][0-9]*\)$/\1/p' "$VERIFY_XUM_RUN/state.env" | tail -n 1)
    [[ -n $VERIFY_XUM_PGID ]]; do
    before_launch_deadline
    sleep 0.1
  done
  exec 9>&-
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
  # The recipes assume default preferences. With both --clean flags the sandbox copies no config.
  grep -q '^  Seed config: *(none)$' "$log" || die "the sandbox copied a config.json, so the run would not start from default preferences"
  VERIFY_XUM_BACKEND="http://127.0.0.1:$backend_port"
  VERIFY_XUM_URL="http://127.0.0.1:$vite_port"
  write_state

  until backend_ready "$t0" && probe_before_launch_deadline "$VERIFY_XUM_URL/"; do
    before_launch_deadline
    group_alive "$VERIFY_XUM_PGID" || die "the dev server exited before it was ready"
    backend_crashed_after_rebuild "$log" && die "the backend crashed after its rebuild (nodemon waits for a file change)"
    sleep 1
  done
  # Keep the token for redaction (run_token) while server.lock is gone. The run folder is 0700,
  # and the file is 0600.
  token=$(json_field_or_empty "$VERIFY_XUM_ROOT/server.lock" token)
  [[ -z $token ]] || (umask 077 && printf '%s' "$token" >"$VERIFY_XUM_RUN/token")

  seed
  write_state
  trap - EXIT
  cat "$VERIFY_XUM_RUN/state.env"
  echo "ready: $VERIFY_XUM_URL/workspace/$VERIFY_XUM_WORKSPACE_ID"
}

serves_vite_ui() {
  # Not `curl | grep -q`: grep exits at the match, and under pipefail curl's SIGPIPE fails the check.
  [[ $(curl -fs --max-time 5 "$1/" 2>/dev/null) == *"/@vite/client"* ]]
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
  check "this checkout's newest run ($CURRENT_RUN_LINK) is this run" test "$(readlink "$CURRENT_RUN_LINK" 2>/dev/null)" = "$VERIFY_XUM_RUN"
  backend_pid=$(json_field_or_empty "$VERIFY_XUM_ROOT/server.lock" pid)
  check "backend pid ${backend_pid:-none} (server.lock in $VERIFY_XUM_ROOT) belongs to this run" \
    pid_in_group "$backend_pid" "$VERIFY_XUM_PGID"
  check "server.lock names $VERIFY_XUM_BACKEND" \
    test "$(json_field_or_empty "$VERIFY_XUM_ROOT/server.lock" baseUrl)" = "$VERIFY_XUM_BACKEND"
  check "GET $VERIFY_XUM_BACKEND/health answers" backend_curl -fs --max-time 5 -o /dev/null "$VERIFY_XUM_BACKEND/health"
  version=$(backend_curl -fs --max-time 5 "$VERIFY_XUM_BACKEND/version" 2>/dev/null | json_field_or_empty /dev/stdin git_commit || true)
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
  echo "unset $GIT_REPO_ENV"
}

# Opens PATH of the run's UI in the run's browser session. When the backend has an auth token, the
# URL carries `?token=` (the app keeps the token and strips it from the address bar). node reads
# the token from server.lock and pipes the command to `agent-browser batch` on stdin, so the token
# is in no process's argv or environment: every local account can read argv.
cmd_open() {
  local path=${1:-} out
  [[ $path == /* ]] || die "open PATH must start with / (for example /workspace/<id>)"
  load_run "${2:-}"
  # Checked before agent-browser runs. A PATH like //host, /\host or /<tab>/host resolves to
  # another origin: never send the token there. One that normalizes to //... (/..//host) stays on
  # the origin, but the app cannot strip ?token= from such an address, so the token stays in it.
  node -e '
    const [base, path] = process.argv.slice(1);
    const url = new URL(path, base);
    if (url.origin !== new URL(base).origin || url.pathname.startsWith("//")) {
      process.stderr.write("verify-xum: open PATH must stay on " + base + " and must not start with // once normalized\n");
      process.exit(1);
    }' "$VERIFY_XUM_URL" "$path" || exit 1
  # agent-browser serves each session's screen and input as a WebSocket on 127.0.0.1 that every
  # local account can connect to, and a new daemon starts it on its own (no setting keeps it
  # off). Turn it off before the token reaches the browser, on every open because a restarted
  # daemon starts it again. `stream disable` also drops connected clients, and starts the daemon
  # when none runs: the browser it launches later keeps the stream off.
  agent-browser --session "$AGENT_BROWSER_SESSION" stream disable >/dev/null 2>&1 || true
  stream_is_off || die "agent-browser's stream for session $AGENT_BROWSER_SESSION is still on. Not opening the page with the token."
  # shellcheck disable=SC2001 # sed's character class; bash patterns have none
  out=$(node -e '
    const fs = require("fs");
    const [serverLock, base, path] = process.argv.slice(1);
    let token = "";
    try {
      token = JSON.parse(fs.readFileSync(serverLock, "utf8")).token ?? "";
    } catch {}
    const url = new URL(path, base);
    if (token) url.searchParams.set("token", token);
    process.stdout.write(JSON.stringify([["open", url.href]]));' \
    "$VERIFY_XUM_ROOT/server.lock" "$VERIFY_XUM_URL" "$path" \
    | agent-browser --session "$AGENT_BROWSER_SESSION" batch --bail 2>&1) \
    || die "agent-browser could not open $path: $(sed 's/token=[^&[:space:]]*/token=<redacted>/g' <<<"$out")"
  # The success output repeats the URL with the token: it is not printed.
  if ! stream_is_off; then
    agent-browser --session "$AGENT_BROWSER_SESSION" close >/dev/null 2>&1 || true
    die "agent-browser's stream for session $AGENT_BROWSER_SESSION came on during the open. Closed the session."
  fi
}

# True when the session's agent-browser stream (see cmd_open) is off.
stream_is_off() {
  [[ $(agent-browser --session "$AGENT_BROWSER_SESSION" stream status --json 2>/dev/null \
    | node -e 'try { console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).data.enabled === false) } catch { console.log(false) }') == true ]]
}

# Prints FIELD (id, archivedAt, ...) of the workspace named NAME in the run's config.json, or
# nothing when that field is unset. Exits 1 unless exactly one workspace has that name. The
# recipes read ids with it: the app makes them up at create time.
cmd_workspace_field() {
  local name=${1:-} field=${2:-}
  [[ -n $name && -n $field ]] || die "usage: verify-xum.sh workspace-field NAME FIELD [RUN]"
  load_run "${3:-}"
  node -e '
    const fs = require("fs");
    const [configPath, name, field] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const matches = config.projects.flatMap(([, project]) => project.workspaces ?? []).filter((w) => w.name === name);
    if (matches.length !== 1) {
      process.stderr.write("verify-xum: " + matches.length + " workspaces are named " + name + " in " + configPath + "\n");
      process.exit(1);
    }
    const value = matches[0][field];
    if (value !== undefined && value !== null) console.log(String(value));' \
    "$VERIFY_XUM_ROOT/config.json" "$name" "$field"
}

# The backend's token: server.lock's, else the copy launch keeps in the private run folder. A
# restarting backend deletes server.lock for a moment, and a stopped one for good.
run_token() {
  local token
  token=$(json_field_or_empty "$VERIFY_XUM_ROOT/server.lock" token)
  [[ -n $token || ! -f $VERIFY_XUM_RUN/token ]] || token=$(<"$VERIFY_XUM_RUN/token")
  printf '%s' "$token"
}

# Evidence is meant to be shared, so no text in it may keep the backend's token: the page keeps
# ?token= in its URL when the app fails before it strips it. This replaces the token (raw, and
# URL-encoded as a path part and as a form value) and the value of any token= query parameter
# with <redacted>. With no PATH it filters stdin to stdout. With PATHs it rewrites each text file
# under them in place, skipping binary files and symlinks. The token is $REDACT_TOKEN when set
# (cleanup reads it before the sandbox deletes server.lock), else server.lock's. node gets it on
# fd 3, never in argv.
REDACT_TOKEN=
redact_token() { # redact_token [PATH...]
  local token=$REDACT_TOKEN
  [[ -n $token ]] || token=$(run_token)
  # shellcheck disable=SC2016 # $1 is the regex group, for node
  node -e '
    const fs = require("fs");
    const path = require("path");
    const token = fs.readFileSync(3, "utf8");
    const forms = [...new Set([token, encodeURIComponent(token), new URLSearchParams({ t: token }).toString().slice(2)])].filter(Boolean);
    const redact = (text) => {
      for (const form of forms) text = text.split(form).join("<redacted>");
      // A value of at least one character: an empty ?token= and a placeholder such as
      // ?token=<token> (the Makefile banner in server.log) stay as they are.
      return text.replace(/([?&]token=)[^&#\s"\x27<>]+/g, "$1<redacted>");
    };
    const filesUnder = (p) => {
      const st = fs.lstatSync(p);
      if (st.isDirectory()) return fs.readdirSync(p).flatMap((name) => filesUnder(path.join(p, name)));
      return st.isFile() ? [p] : [];
    };
    const paths = process.argv.slice(1);
    if (paths.length === 0) {
      process.stdout.write(redact(fs.readFileSync(0, "utf8")));
      process.exit(0);
    }
    for (const file of paths.filter((p) => fs.existsSync(p)).flatMap(filesUnder)) {
      const data = fs.readFileSync(file);
      if (data.subarray(0, 8192).includes(0)) continue;
      const text = data.toString("utf8");
      const clean = redact(text);
      if (clean !== text) fs.writeFileSync(file, clean);
    }' "$@" 3< <(printf %s "$token")
}

cmd_capture() {
  local name=${1:-} base
  [[ $name =~ ^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$ ]] || die "capture NAME must look like <feature>/<step>, lowercase"
  load_run "${2:-}"
  base="$VERIFY_XUM_EVIDENCE/$name"
  mkdir -p "$(dirname "$base")"
  agent-browser --session "$AGENT_BROWSER_SESSION" get url | redact_token >"$base.url.txt"
  agent-browser --session "$AGENT_BROWSER_SESSION" snapshot | redact_token >"$base.aria.txt"
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
  # Read the token before the group stops: the backend then deletes server.lock.
  REDACT_TOKEN=$(run_token)
  # agent-browser `close` on a session that does not exist starts that session first.
  if [[ $(agent-browser session list 2>/dev/null) == *"$AGENT_BROWSER_SESSION"* ]]; then
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
  # Text you saved by hand is evidence too.
  redact_token "$VERIFY_XUM_EVIDENCE" "$VERIFY_XUM_RUN/server.log" || true
  if is_dev_server_sandbox_root "$VERIFY_XUM_ROOT"; then
    rm -rf "$VERIFY_XUM_ROOT"
  fi
  rm -rf "$VERIFY_XUM_RUN/scratch" "$VERIFY_XUM_RUN/tmp"
  [[ $(readlink "$CURRENT_RUN_LINK" 2>/dev/null) == "$VERIFY_XUM_RUN" ]] && rm -f "$CURRENT_RUN_LINK"
  VERIFY_XUM_PGID=
  write_state
  # Last: the redaction above used it.
  rm -f "$VERIFY_XUM_RUN/token"
  echo "cleaned up run $VERIFY_XUM_RUN_ID; evidence kept in $VERIFY_XUM_EVIDENCE ($(find "$VERIFY_XUM_EVIDENCE" -type f | wc -l | tr -d ' ') files) and $VERIFY_XUM_RUN/server.log"
}

case ${1:-} in
  launch) cmd_launch ;;
  doctor) cmd_doctor "${2:-}" ;;
  env) cmd_env "${2:-}" ;;
  open) cmd_open "${2:-}" "${3:-}" ;;
  workspace-field) cmd_workspace_field "${2:-}" "${3:-}" "${4:-}" ;;
  capture) cmd_capture "${2:-}" "${3:-}" ;;
  idle) cmd_idle "${2:-}" ;;
  send-ready) cmd_send_ready "${2:-}" ;;
  cleanup) cmd_cleanup "${2:-}" ;;
  *) die "usage: verify-xum.sh launch | doctor [RUN] | env [RUN] | open PATH [RUN] | workspace-field NAME FIELD [RUN] | capture NAME [RUN] | idle [RUN] | send-ready [RUN] | cleanup [RUN]" ;;
esac
