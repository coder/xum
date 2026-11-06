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
#   verify-xum.sh webkit-capture PATH NAME [RUN]  phone-width WebKit screenshot + report of PATH
#   verify-xum.sh idle [RUN]       wait until the page settles, exit 3 if a chunk failed to load
#   verify-xum.sh send-ready [RUN] wait until the composer's Send button is enabled
#   verify-xum.sh cleanup [RUN]    stop the run's processes, delete its XUM_ROOT, keep evidence
#   verify-xum.sh cli ARGS...      run `xum api ARGS` against the newest run, once its TCP port is
#                                  the run's backend
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
READY_TIMEOUT=${VERIFY_XUM_READY_TIMEOUT:-600}
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

# ": <fix>" with @DIR@ replaced by the folder, quoted so the command can be copied as printed (a
# folder can hold spaces, glob characters, & or \). Nothing without a fix. The fix is split at
# @DIR@ instead of ${1//@DIR@/...}: bash 5.2's patsub_replacement reads & and \ in that
# replacement again and undoes the quoting.
refusal_fix() { # refusal_fix <fix> <folder>
  [[ -n $1 ]] || return 0
  if [[ $1 == *@DIR@* ]]; then printf ': %s%q%s' "${1%%@DIR@*}" "$2" "${1#*@DIR@}"; else printf ': %s' "$1"; fi
}

# A run's state.env is sourced, so the run folder and the home above it must be real folders (no
# symlinks), owned by this user and writable by nobody else.
require_private_dir() { # require_private_dir <dir> [<fix for a writable folder; @DIR@ names it>]
  local dir=$1 fix=${2:-} mode
  [[ -d $dir && ! -L $dir ]] || die "$dir is not a real folder"
  [[ $(stat -c %u "$dir") == "$(id -u)" ]] || die "$dir is not owned by user $(id -u)"
  mode=$(stat -c %a "$dir")
  (((8#$mode & 8#022) == 0)) || die "$dir is writable by group or others (mode $mode)$(refusal_fix "$fix" "$dir")"
}

# Every folder above a run home (or a git dir) must be owned by root or this user and writable by
# nobody else, unless it is sticky like /tmp (as ssh's StrictModes checks): another account could
# otherwise rename the checked folder away and put its own in its place. Takes a physical path.
require_safe_ancestors() { # require_safe_ancestors <path> [<what it is, for messages>] [<fix>]
  local dir=$1 what=${2:-the run home} fix=${3:-} owner mode
  while [[ $dir != / ]]; do
    dir=$(dirname "$dir")
    owner=$(stat -c %u "$dir")
    mode=$(stat -c %a "$dir")
    [[ $owner == 0 || $owner == "$(id -u)" ]] || die "$dir, above $what, is owned by user $owner"
    if ! (((8#$mode & 8#022) == 0 || (8#$mode & 8#1000) != 0)); then
      # Only the owner can chmod it: for a root-owned folder (a group-writable /usr/local, for
      # example) the fix is to move the checkout.
      [[ $owner == "$(id -u)" || -z $fix ]] || fix="use a checkout under folders you own"
      die "$dir, above $what, is writable by group or others and not sticky (mode $mode)$(refusal_fix "$fix" "$dir")"
    fi
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

# Opens the launch guard on fd 9 for flock. It sits in the checkout's git dir, which no other
# account can write (require_private_git_dirs). These checks are a second line: a symlink there
# made `9>` truncate its target. The guard is created with O_EXCL (noclobber), which never follows a symlink, and opened read
# only, which can neither create nor truncate anything (flock needs no write access). Then fd 9
# must be the regular file of this user that the path names. Its mode is 0600: another account
# that can read it can flock it and block every launch. A guard from an older version is 0644,
# so the mode is set on the open file too.
open_launch_guard() {
  [[ -e $LAUNCH_GUARD || -L $LAUNCH_GUARD ]] || (umask 077 && set -C && : >"$LAUNCH_GUARD") 2>/dev/null || true
  [[ -f $LAUNCH_GUARD && ! -L $LAUNCH_GUARD ]] || die "$LAUNCH_GUARD is not a regular file (a symlink?). Remove it."
  exec 9<"$LAUNCH_GUARD"
  [[ $(stat -L -c '%d:%i:%u' /proc/self/fd/9) == "$(stat -c '%d:%i' -- "$LAUNCH_GUARD"):$(id -u)" ]] \
    || die "$LAUNCH_GUARD is not owned by user $(id -u), or it changed while it was opened. Remove it."
  chmod 600 /proc/self/fd/9
}

# The rule for the newest-run link: every read-compare-write or unlink of verify-xum.current, in
# launch, cleanup and the failure cleanup, runs while this process holds the launch guard's flock
# on fd 9. Only the two helpers below change the link. Launch holds the guard from its stale-run
# check until the new group has recorded its id, so no cleanup can drop the link of a launch in
# that window, and no launch can replace the link between a cleanup's compare and its unlink.
LAUNCH_GUARD_HELD=
hold_launch_guard() { # hold_launch_guard <seconds to wait>
  [[ -z $LAUNCH_GUARD_HELD ]] || return 0
  open_launch_guard
  flock -w "$1" 9 || return 1
  LAUNCH_GUARD_HELD=1
}

release_launch_guard() {
  exec 9>&-
  LAUNCH_GUARD_HELD=
}

point_current_run_link_at() { # point_current_run_link_at <run>
  [[ -n $LAUNCH_GUARD_HELD ]] || die "internal error: the newest-run link changed without the launch guard"
  # -T: a folder at the link path fails the launch instead of getting the link inside it.
  ln -sfnT "$1" "$CURRENT_RUN_LINK"
}

drop_current_run_link_if() { # drop_current_run_link_if <run>: unlink it when it names <run>
  if ! hold_launch_guard 60; then
    echo "verify-xum: a launch from this checkout held $LAUNCH_GUARD for 60 s. Left the newest-run link." >&2
    return 0
  fi
  if [[ $(readlink "$CURRENT_RUN_LINK" 2>/dev/null) == "$1" ]]; then
    rm -f "$CURRENT_RUN_LINK"
  fi
}

# One server per checkout: two would share dist/ and node_modules/.vite. The guard is the newest
# run's process group, which records its own id in that run's state.env before it starts the
# server. The flock keeps two launches from passing the check at once, and it also covers the
# moment between the spawn and that record: the new group holds the flock until it has written
# its id, wherever the launcher dies. The server does not inherit it.
refuse_while_checkout_server_runs() {
  # Part of the launch deadline: a short VERIFY_XUM_READY_TIMEOUT also bounds this wait.
  hold_launch_guard "$(launch_seconds_left)" || die "another verify-xum launch from this checkout holds $LAUNCH_GUARD"
  # Only a symlink belongs there: with a folder in its place, the next launch would not see this
  # one's run and would start a second server.
  [[ ! -e $CURRENT_RUN_LINK || -L $CURRENT_RUN_LINK ]] \
    || die "$CURRENT_RUN_LINK is not a symlink (a folder?). Remove it, then launch again."
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

# The Unix socket that the backend listens on next to its TCP port (the Makefile's
# XUM_BACKEND_SOCKET) must sit in a folder that only this user can write, with no folder above it
# that another account could rename (require_safe_ancestors): no one else can then create a socket
# at that name.
require_private_socket() {
  local dir
  # Unset in the state.env of a run that an older verify-xum.sh launched.
  [[ ${VERIFY_XUM_BACKEND_SOCKET-} == /* ]] \
    || die "run $VERIFY_XUM_RUN names no Unix socket for the backend (an older verify-xum.sh launched it). Run verify-xum.sh cleanup, then launch again."
  dir=$(dirname "$VERIFY_XUM_BACKEND_SOCKET")
  require_private_dir "$dir"
  require_safe_ancestors "$(cd -P -- "$dir" && pwd -P)" "the backend's socket"
}

# Sends a request with the run's token to the backend over its Unix socket, never its TCP port. A
# starting backend listens on the port before it writes server.lock, and a stopping one deletes
# server.lock before it closes the port, so the port can be free for another local account to bind
# while server.lock is missing or names a dead backend (a stop, or a nodemon restart). Only this
# user can create the socket (require_private_socket), so the run's token copy is safe to send
# too. The token goes to curl on stdin, so it is in no process's argv. Callers pass the TCP URL:
# curl takes the path and the Host header from it. A `return` and not set -e: doctor calls this
# inside `if` and reports the FAIL.
backend_curl() {
  local token
  require_private_socket
  token=$(required_run_token) || return 1
  printf 'Authorization: Bearer %s\n' "$token" | curl --unix-socket "$VERIFY_XUM_BACKEND_SOCKET" -H @- "$@"
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
    VERIFY_XUM_BACKEND VERIFY_XUM_BACKEND_SOCKET VERIFY_XUM_URL VERIFY_XUM_PROJECT \
    VERIFY_XUM_WORKSPACE_ID VERIFY_XUM_WORKTREE VERIFY_XUM_EVIDENCE AGENT_BROWSER_SESSION; do
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

# The seed's git commands. The real HOME stays (see SKILL.md), so your global git config applies:
# an init.templateDir, a core.attributesFile or the system attributes could run a clean filter on
# `git add`, and a hook or an fsmonitor could run on any command. None of them runs here, and each
# command stops at the launch deadline.
demo_git() {
  GIT_ATTR_NOSYSTEM=1 timeout "$(launch_seconds_left)" git -c core.attributesFile=/dev/null \
    -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"
}

create_demo_repo() {
  local repo=$1
  mkdir -p "$repo/src"
  printf '# Demo app\n\nA throwaway project for verify-xum.\n' >"$repo/README.md"
  printf 'export function add(a: number, b: number): number {\n  return a + b;\n}\n' >"$repo/src/math.ts"
  # --template= copies no template: no hooks and no info/attributes.
  demo_git -C "$repo" init -q -b main --template=
  demo_git -C "$repo" add .
  demo_git -C "$repo" -c user.name=verify-xum -c user.email=verify-xum@example.test \
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

# Vite transforms a module on its first request, on one thread, and a cold first page load asks for
# about 900 of them: about 45 CPU seconds, most of it in Babel, where React Compiler runs. That
# outlasts `idle`'s 25 s wait, so the page stays on "Loading Xum". For that whole time Chrome also
# holds dozens of queued module requests, and a host network change fails them (ERR_NETWORK_CHANGED,
# then "<name> failed to load." or a page that stays on "Loading Xum"). Walking the module graph
# here, over HTTP and before `ready`, moves that cost into the launch, so the first `open` gets
# cached modules. The walk prints to stderr: stdout stays the run's `export` lines. env -i keeps
# the live Xum's token out of its environment.
warm_vite_modules() {
  before_launch_deadline
  env -i PATH="$PATH" HOME="$HOME" bun "$CHECKOUT/scripts/warmViteModules.ts" \
    "$VERIFY_XUM_URL" "$(launch_seconds_left)" >&2 \
    || die "the module walk failed (reason above), so the first page load would not be reliable"
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
  # Take the guard anew (the link rule above). A signal can stop the launcher after the spawn and
  # before the new group records its id. That group shares this launcher's guard fd and holds
  # the flock until it has written the id or died, so cleanup then reads the id. Without the
  # wait, cleanup would drop the newest-run link while the server starts, and the next launch
  # would start a second one.
  release_launch_guard
  if ! hold_launch_guard 10; then
    echo "verify-xum: could not take $LAUNCH_GUARD in 10 s (the new group has not recorded its id). The newest-run link stays: run verify-xum.sh cleanup." >&2
    return 0
  fi
  cmd_cleanup "$VERIFY_XUM_RUN" >&2 || true
}

# Refuses when a socket that listens on PORT is not on a loopback address. A .env line such as
# XUM_VITE_HOST=0.0.0.0 makes a server listen on every interface, and Vite then answers
# http://<this machine's IP>:<port>/ (an IP-address Host passes its check). Launch runs it while
# it waits for readiness too: a server on one non-loopback address never answers the loopback
# probes, and launch would otherwise wait for its deadline. Returns 1 when nothing listens on
# PORT. With "ready" it refuses then instead: the server answered a probe there, so ss cannot see
# its sockets.
refuse_off_loopback_listener() { # refuse_off_loopback_listener <port> <what listens there> [ready]
  local addr addrs
  addrs=$(ss -Hltn "sport = :$1" 2>/dev/null) || die "ss failed, so launch cannot check which addresses $2 listens on"
  addrs=$(awk '{print $4}' <<<"$addrs")
  [[ -n $addrs || ${3-} != ready ]] || die "ss shows nothing listening on $2's port $1, so launch cannot check that only loopback reaches it"
  while read -r addr; do
    [[ -z $addr || $addr == 127.*:"$1" || $addr == "[::1]:$1" ]] \
      || die "$2 listens on $addr, not only on loopback, so other machines can reach it. A .env file in $CHECKOUT sets its host (XUM_VITE_HOST, MUX_VITE_HOST, VITE_HOST, XUM_BACKEND_HOST, MUX_BACKEND_HOST or BACKEND_HOST): remove that line."
  done <<<"$addrs"
  [[ -n $addrs ]]
}

# The checks that need a ready backend: its listeners and the token in its server.lock. Sets
# token. A nodemon restart kills the backend, and the next one writes its own lock once it listens
# (see run_token), replacing the dead one's. So a missing lock, a lock that changed while the
# checks ran, or a /health that stopped answering means a restart: return 1, and launch waits for
# readiness again. Refuse only what one backend showed throughout.
backend_checks_after_ready() {
  local before after listening=yes
  before=$(cat "$VERIFY_XUM_ROOT/server.lock" 2>/dev/null) || return 1
  refuse_off_loopback_listener "$backend_port" "the backend" || listening=no
  backend_ready "$t0" || return 1
  after=$(cat "$VERIFY_XUM_ROOT/server.lock" 2>/dev/null) || return 1
  [[ $after == "$before" ]] || return 1
  [[ $listening == yes ]] \
    || die "ss shows nothing listening on the backend's port $backend_port, so launch cannot check that only loopback reaches it"
  # env -i drops XUM_DEV_SERVER_NO_AUTH, but Bun loads the checkout's .env files into the sandbox
  # script, and a line there can set it again. The backend's TCP port has no Host check, so without
  # a token any local account, and a web page that rebinds its DNS name to this machine, can
  # call its API.
  token=$(json_field_or_empty /dev/stdin token <<<"$after")
  [[ -n $token ]] \
    || die "the backend has no auth token, so any local account can control it. A .env file in $CHECKOUT sets XUM_DEV_SERVER_NO_AUTH=1: remove that line."
}

# The process group id that the new group's leader appended to state.env, if it has.
recorded_pgid() {
  sed -n 's/^export VERIFY_XUM_PGID=\([0-9][0-9]*\)$/\1/p' "$VERIFY_XUM_RUN/state.env" | tail -n 1
}

cmd_launch() {
  local t0 backend_port vite_port allowed_hosts log existing token leader
  need git curl node bun make setsid flock ss realpath agent-browser
  check_bun
  LAUNCH_DEADLINE=$((SECONDS + READY_TIMEOUT))
  refuse_while_checkout_server_runs

  # Before any folder is made: a refused home creates nothing.
  require_home_outside_checkout "$VERIFY_XUM_HOME"
  if [[ ! -e $VERIFY_XUM_HOME ]]; then
    # Check the nearest existing folder above the home, and every folder above it, before any
    # folder is made: a refused launch creates nothing. The folders it then makes are private,
    # whatever the caller's umask.
    existing=$(dirname "$VERIFY_XUM_HOME")
    while [[ ! -e $existing ]]; do existing=$(dirname "$existing"); done
    [[ -d $existing ]] || die "$existing, above the run home, is not a folder"
    require_safe_ancestors "$(cd -P -- "$existing" && pwd -P)/home"
    (umask 077 && mkdir -p "$(dirname "$VERIFY_XUM_HOME")")
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
  # Milliseconds: a stamp from earlier in the launch's own second is a stale build. From node,
  # like the stamp itself (scripts/build-main-watch.js writes Date.now()): uutils date 0.8 ignores
  # the width in %3N and prints nanoseconds, so no stamp would ever be newer.
  t0=$(node -p 'Date.now()')

  local env_without_live_xum=(env -i PATH="$PATH" HOME="$HOME" USER="${USER:-}" LANG="${LANG:-C.UTF-8}"
    TERM=dumb TMPDIR="$VERIFY_XUM_RUN/tmp" XUM_MOCK_AI=1 XUM_DISABLE_TELEMETRY=1
    VERIFY_XUM_SERVER_OF="$VERIFY_XUM_RUN_ID")
  # A shell that ran `eval "$(verify-xum.sh env)"` still exports the previous run's values.
  VERIFY_XUM_PGID='' VERIFY_XUM_ROOT='' VERIFY_XUM_BACKEND='' VERIFY_XUM_URL=''
  VERIFY_XUM_WORKSPACE_ID='' VERIFY_XUM_WORKTREE=''
  write_state
  point_current_run_link_at "$VERIFY_XUM_RUN"
  trap launch_failed EXIT
  # The new group's leader appends its pid, which is the group id, to state.env before it starts
  # make. From then on the launch guard and cleanup find the group, wherever the launcher dies.
  # The leader carries VERIFY_XUM_SERVER_OF from its start, so group_is_ours matches it as soon
  # as the id is written. It holds the launch flock (fd 9) until then and closes it before make.
  # A failed write (read-only file, full disk) ends the leader before it closes the flock or starts
  # make: a server whose group nobody recorded is one that cleanup cannot stop, and once cleanup
  # drops the newest-run link, the next launch would start a second server next to it.
  # (setsid(1) forks when its caller already leads a process group, so $! can miss the group.)
  # shellcheck disable=SC2016
  VERIFY_XUM_SERVER_OF="$VERIFY_XUM_RUN_ID" setsid sh -c 'printf "export VERIFY_XUM_PGID=%s\n" "$$" >>"$1" || exit 1; exec 9>&- && shift && exec "$@"' sh \
    "$VERIFY_XUM_RUN/state.env" "${env_without_live_xum[@]}" \
    make -C "$CHECKOUT" dev-server-sandbox DEV_SERVER_SANDBOX_ARGS="--clean-providers --clean-projects" \
    >"$log" 2>&1 </dev/null &
  leader=$!
  until VERIFY_XUM_PGID=$(recorded_pgid); [[ -n $VERIFY_XUM_PGID ]]; do
    before_launch_deadline
    # A leader that could not write its id exits before make: stop at once instead of waiting
    # for the deadline. $! is the leader, or a setsid that forked it and exited. The leader
    # carries this run's id in its environment from its start. Read the id once more: the leader
    # can have written it just before it went away.
    if ! kill -0 "$leader" 2>/dev/null && ! grep -qszx "VERIFY_XUM_SERVER_OF=$VERIFY_XUM_RUN_ID" /proc/[0-9]*/environ; then
      VERIFY_XUM_PGID=$(recorded_pgid)
      [[ -n $VERIFY_XUM_PGID ]] && break
      die "the server's process group exited before it wrote its id to $VERIFY_XUM_RUN/state.env (a read-only file or a full disk?)"
    fi
    sleep 0.1
  done
  release_launch_guard
  write_state

  while true; do
    VERIFY_XUM_ROOT=$(sed -n 's/^  XUM_ROOT: *//p' "$log")
    backend_port=$(sed -n 's|^  Backend: *http://127.0.0.1:||p' "$log")
    vite_port=$(sed -n 's|^  Frontend: *http://localhost:||p' "$log")
    allowed_hosts=$(sed -n 's/^  Allowed hosts: *//p' "$log")
    [[ -n $VERIFY_XUM_ROOT && -n $backend_port && -n $vite_port && -n $allowed_hosts ]] && break
    group_alive "$VERIFY_XUM_PGID" || die "make dev-server-sandbox exited during startup"
    before_launch_deadline
    sleep 0.5
  done
  # The recipes assume default preferences. With both --clean flags the sandbox copies no config.
  grep -q '^  Seed config: *(none)$' "$log" || die "the sandbox copied a config.json, so the run would not start from default preferences"
  # Vite's Host check is the DNS-rebinding guard. env -i drops VITE_ALLOWED_HOSTS and the
  # port-forward proxy variables, but Bun loads the checkout's .env files (.env, .env.local,
  # .env.development, .env.development.local) into the sandbox script, and they can set them again.
  [[ $allowed_hosts == "loopback only" ]] \
    || die "the sandbox allows the Host headers '$allowed_hosts' besides loopback, so a web page that rebinds its DNS name to this machine could read the app. A .env file in $CHECKOUT sets VITE_ALLOWED_HOSTS or a proxy URI: remove that line."
  VERIFY_XUM_BACKEND="http://127.0.0.1:$backend_port"
  VERIFY_XUM_URL="http://127.0.0.1:$vite_port"
  write_state

  until backend_ready "$t0" && probe_before_launch_deadline "$VERIFY_XUM_URL/" \
    && refuse_off_loopback_listener "$vite_port" Vite ready && backend_checks_after_ready; do
    before_launch_deadline
    group_alive "$VERIFY_XUM_PGID" || die "the dev server exited before it was ready"
    backend_crashed_after_rebuild "$log" && die "the backend crashed after its rebuild (nodemon waits for a file change)"
    refuse_off_loopback_listener "$vite_port" Vite || true
    refuse_off_loopback_listener "$backend_port" "the backend" || true
    sleep 1
  done
  # Keep the token for redaction (run_token) while server.lock is gone. The run folder is 0700,
  # and the file is 0600.
  (umask 077 && printf '%s' "$token" >"$VERIFY_XUM_RUN/token")
  # The make banner names the backend's Unix socket: the seed's API calls, and doctor's, send the
  # token there (backend_curl).
  VERIFY_XUM_BACKEND_SOCKET=$(sed -n 's/^  Vite -> backend: *Unix socket //p' "$log" | head -n 1)
  [[ -n $VERIFY_XUM_BACKEND_SOCKET ]] \
    || die "the sandbox printed no 'Vite -> backend: Unix socket' line, so launch has no private way to send the backend its token"
  require_private_socket
  write_state

  seed
  warm_vite_modules
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
  # /health needs no token, so it goes to the TCP port that the CLI uses. /version goes over the
  # socket, with the token, as the seed's API calls do.
  check "GET $VERIFY_XUM_BACKEND/health answers" curl -fs --max-time 5 -o /dev/null "$VERIFY_XUM_BACKEND/health"
  version=$(backend_curl -fs --max-time 5 "$VERIFY_XUM_BACKEND/version" | json_field_or_empty /dev/stdin git_commit || true)
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

# Opens PATH of the run's UI in the run's browser session. The URL carries `?token=` (the app keeps
# the token and strips it from the address bar). node gets the run's token on fd 3 and pipes the
# command to `agent-browser batch` on stdin, so the token is in no process's argv or environment:
# every local account can read argv.
# Checked before a browser gets the token. A PATH like //host, /\host or /<tab>/host resolves to
# another origin: never send the token there. One that normalizes to //... (/..//host) stays on
# the origin, but the app cannot strip ?token= from such an address, so the token stays in it.
require_path_on_run_origin() { # require_path_on_run_origin <path>: after load_run
  node -e '
    const [base, path] = process.argv.slice(1);
    const url = new URL(path, base);
    if (url.origin !== new URL(base).origin || url.pathname.startsWith("//")) {
      process.stderr.write("verify-xum: PATH must stay on " + base + " and must not start with // once normalized\n");
      process.exit(1);
    }' "$VERIFY_XUM_URL" "$1" || exit 1
}

cmd_open() {
  local path=${1:-} out token
  [[ $path == /* ]] || die "open PATH must start with / (for example /workspace/<id>)"
  load_run "${2:-}"
  require_path_on_run_origin "$path"
  # agent-browser serves each session's screen and input as a WebSocket on 127.0.0.1 that every
  # local account can connect to, and a new daemon starts it on its own (no setting keeps it
  # off). Turn it off before the token reaches the browser, on every open because a restarted
  # daemon starts it again. `stream disable` also drops connected clients, and starts the daemon
  # when none runs: the browser it launches later keeps the stream off.
  agent-browser --session "$AGENT_BROWSER_SESSION" stream disable >/dev/null 2>&1 || true
  stream_is_off || die "agent-browser's stream for session $AGENT_BROWSER_SESSION is still on. Not opening the page with the token."
  # The run's token (run_token: server.lock is gone for a moment while nodemon restarts the
  # backend). node gets it on fd 3, never in argv.
  token=$(required_run_token)
  # shellcheck disable=SC2001 # sed's character class; bash patterns have none
  out=$(node -e '
    const fs = require("fs");
    const [base, path] = process.argv.slice(1);
    const token = fs.readFileSync(3, "utf8");
    const url = new URL(path, base);
    url.searchParams.set("token", token);
    process.stdout.write(JSON.stringify([["open", url.href]]));' \
    "$VERIFY_XUM_URL" "$path" 3< <(printf %s "$token") \
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
# stopped backend deletes server.lock for good. A nodemon restart replaces it: the old backend
# dies on SIGUSR2 and leaves its lock, which names a dead pid until the next one writes its own,
# with the same token, once it listens (ServerLockfile.read ignores a stale lock and never
# deletes it).
run_token() {
  local token
  token=$(json_field_or_empty "$VERIFY_XUM_ROOT/server.lock" token)
  [[ -n $token || ! -f $VERIFY_XUM_RUN/token ]] || token=$(<"$VERIFY_XUM_RUN/token")
  printf '%s' "$token"
}

# run_token, or exit 1 when it is empty. Launch refuses a backend without a token and keeps the
# copy before it seeds, so every run it accepts has one. An empty one means a changed run folder,
# or a run that a verify-xum.sh from before #7927 launched from a checkout from before #7904 (its
# backend had no token): going on would open the app's token prompt or send requests that fail.
required_run_token() {
  local token
  token=$(run_token)
  [[ -n $token ]] || die "run $VERIFY_XUM_RUN has no auth token (server.lock and its token copy have none). Run verify-xum.sh cleanup, then launch again."
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

require_evidence_name() { # require_evidence_name <name>
  [[ $1 =~ ^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$ ]] || die "NAME must look like <feature>/<step>, lowercase"
}

cmd_capture() {
  local name=${1:-} base
  require_evidence_name "$name"
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
  # A failed module of the first-load graph leaves the boot screen up with no message, so the wait
  # times out. Say what to try, because the bare "Wait timed out" does not.
  agent-browser --session "$AGENT_BROWSER_SESSION" wait --fn "$SETTLED_OR_CHUNK_FAILED_JS" >/dev/null || {
    echo "verify-xum: the page did not settle. If it shows only 'Loading Xum', a module request failed: run agent-browser reload (SKILL.md Gotchas)." >&2
    exit 1
  }
  if [[ $(agent-browser --session "$AGENT_BROWSER_SESSION" eval "$CHUNK_LOAD_FAILED_JS") == true ]]; then
    echo "verify-xum: the page shows '<name> failed to load.': a module fetch failed (usually a host network change). Run agent-browser reload, then repeat the step." >&2
    exit 3
  fi
}

cmd_send_ready() {
  load_run "${1:-}"
  agent-browser --session "$AGENT_BROWSER_SESSION" wait --fn \
    "document.querySelector('[aria-label=\"Send message\"]')?.disabled === false" >/dev/null
}

# webkit-capture opens the page in Playwright WebKit, the engine of phone users' Safari. agent-browser
# drives Chromium, which lays some pages out differently. Playwright is the checkout's locked
# playwright-core. WebKit needs GTK and GStreamer libraries that many hosts lack, so the helper
# runs on the host when WebKit launches there, and otherwise in this image. Its browsers are the
# ones its Playwright version drives, so that version must be the one in package.json: the test
# scripts/verifyXumWebkit.test.ts and webkit_in_docker check the version. Nothing offline ties a
# digest to a version. To bump, run `docker pull mcr.microsoft.com/playwright:v<version>-noble`,
# then `docker image inspect --format '{{index .RepoDigests 0}}'` on it, and set both constants.
WEBKIT_IMAGE_PLAYWRIGHT_CORE=1.64.1
WEBKIT_IMAGE=mcr.microsoft.com/playwright@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f
WEBKIT_HELPER=$SCRIPT_DIR/webkit-capture.mjs
WEBKIT_NOT_LAUNCHED=4 # the helper's exit code when WebKit does not launch

# The helper on the host, with the token on stdin and an allowlisted environment: the bash tool's
# own carries the live Xum's auth token and provider keys.
webkit_on_host() { # webkit_on_host <token> <helper args...>
  local token=$1 host_env
  shift
  host_env=(PATH="$PATH" HOME="$HOME" LANG="${LANG:-C.UTF-8}" TMPDIR="$VERIFY_XUM_RUN/tmp")
  [[ -z ${PLAYWRIGHT_BROWSERS_PATH:-} ]] || host_env+=(PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH")
  printf %s "$token" | timeout -k 10 240 env -i "${host_env[@]}" node "$WEBKIT_HELPER" --mode host "$@"
}

# True when $1 holds a C0 or C1 control character or DEL (a C1 character is 0xC2 0x80-0x9F in UTF-8),
# or is not well-formed UTF-8. Docker echoes a mount path in some errors, and a control character in
# it could drive your terminal.
has_control_char() { # has_control_char <string>
  local LC_ALL=C text=$1 cont=[$'\x80'-$'\xbf']
  [[ $text == *[[:cntrl:]]* || $text == *$'\xc2'[$'\x80'-$'\x9f']* ]] && return 0
  # Each well-formed sequence (RFC 3629: no overlong form, no surrogate, nothing above U+10FFFF)
  # becomes an ASCII "x", so its neighbours cannot join into a new sequence. A byte left is malformed.
  text=${text//[$'\xc2'-$'\xdf']$cont/x}
  text=${text//$'\xe0'[$'\xa0'-$'\xbf']$cont/x}
  text=${text//[$'\xe1'-$'\xec'$'\xee'$'\xef']$cont$cont/x}
  text=${text//$'\xed'[$'\x80'-$'\x9f']$cont/x}
  text=${text//$'\xf0'[$'\x90'-$'\xbf']$cont$cont/x}
  text=${text//[$'\xf1'-$'\xf3']$cont$cont$cont/x}
  text=${text//$'\xf4'[$'\x80'-$'\x8f']$cont$cont/x}
  [[ $text == *[$'\x80'-$'\xff']* ]]
}

# The helper in the pinned image. Trust boundary: --network host lets the container reach every
# loopback port of this host, the sandbox's backend and its token included. It gets the token on
# stdin only, runs one file of this repo from a digest-pinned image as your uid with no
# capabilities and a read-only root, and sees only node_modules (read-only), that file (read-only)
# and the step's <feature> evidence folder. Returns 125 with WEBKIT_DOCKER_REASON set (the caller declares
# it) when Docker cannot run it: the code docker itself uses for that.
webkit_in_docker() { # webkit_in_docker <token> <evidence folder> <helper args...>
  local token=$1 out_dir=$2 endpoint installed config docker_cli rc=0
  shift 2
  local handed_over
  for handed_over in "$CHECKOUT" "$WEBKIT_HELPER" "$out_dir" "$VERIFY_XUM_RUN"; do
    if has_control_char "$handed_over"; then
      WEBKIT_DOCKER_REASON="a folder or file handed to Docker has a control character in its path (not printed: it could drive your terminal)"
      return 125
    fi
  done
  command -v docker >/dev/null || { WEBKIT_DOCKER_REASON="docker is not installed"; return 125; }
  # The user's endpoint, resolved once, then an empty private client config: the CLI copies the
  # `proxies` of its config into every container's environment. A remote endpoint is refused:
  # --network host would name another machine's network and the token would travel to it.
  endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null) || endpoint=
  if has_control_char "$endpoint"; then
    WEBKIT_DOCKER_REASON="the Docker endpoint has a control character (not printed: it could drive your terminal)"
    return 125
  fi
  [[ $endpoint == unix:///?* ]] || { WEBKIT_DOCKER_REASON="the Docker endpoint '${endpoint:-unknown}' is not a local socket"; return 125; }
  installed=$(node -p 'require(process.argv[1]).version' "$CHECKOUT/node_modules/playwright-core/package.json" 2>/dev/null) || installed=
  if has_control_char "$installed"; then
    installed="a version with a control character (not printed: it could drive your terminal)"
  fi
  if [[ $installed != "$WEBKIT_IMAGE_PLAYWRIGHT_CORE" ]]; then
    WEBKIT_DOCKER_REASON="node_modules holds playwright-core ${installed:-none}, the image carries ${WEBKIT_IMAGE_PLAYWRIGHT_CORE}: run bun install, or bump WEBKIT_IMAGE in verify-xum.sh"
    return 125
  fi
  # Not a command that can fail quietly: this function runs in a || list, where errexit is off, and
  # a Docker run without the private config would pass the user's proxies on.
  config=$(mktemp -d "$VERIFY_XUM_RUN/tmp/docker-config.XXXXXX") || { WEBKIT_DOCKER_REASON="cannot make a folder in $VERIFY_XUM_RUN/tmp"; return 125; }
  docker_cli=(env -i PATH="$PATH" DOCKER_HOST="$endpoint" DOCKER_CONFIG="$config" docker)
  if [[ $("${docker_cli[@]}" version --format '{{.Server.Os}}' 2>/dev/null) != linux ]]; then
    rm -rf "$config"
    WEBKIT_DOCKER_REASON="no Linux Docker daemon answers at $endpoint"
    return 125
  fi
  # The pull has its own, longer limit: the first one fetches about 2 GB, and the run's limit would
  # call it a hung capture.
  if ! "${docker_cli[@]}" image inspect "$WEBKIT_IMAGE" >/dev/null 2>&1 \
    && { echo "verify-xum: pulling $WEBKIT_IMAGE (about 2 GB, once)." >&2; ! timeout -k 10 1800 "${docker_cli[@]}" pull "$WEBKIT_IMAGE" >&2; }; then
    rm -rf "$config"
    WEBKIT_DOCKER_REASON="docker could not pull $WEBKIT_IMAGE"
    return 125
  fi
  printf %s "$token" | timeout -k 10 300 "${docker_cli[@]}" run --rm -i --init \
    --name "verify-xum-webkit-$VERIFY_XUM_RUN_ID-$$" --network host --user "$(id -u):$(id -g)" \
    --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,size=512m \
    -e HOME=/tmp -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    -v "$CHECKOUT/node_modules:$CHECKOUT/node_modules:ro" \
    -v "$WEBKIT_HELPER:/verify-xum/webkit-capture.mjs:ro" \
    -v "$out_dir:$out_dir" \
    "$WEBKIT_IMAGE" node /verify-xum/webkit-capture.mjs --mode docker "$@" || rc=$?
  rm -rf "$config"
  return "$rc"
}

webkit_report() { # webkit_report <evidence base>
  redact_token "$1.txt"
  cat "$1.txt"
  echo "$1.png $1.txt"
}

cmd_webkit_capture() {
  local path=${1:-} name=${2:-} mode=${VERIFY_XUM_WEBKIT:-auto} base token output rc=0
  local host_reason='' WEBKIT_DOCKER_REASON=''
  [[ $path == /* ]] || die "webkit-capture PATH must start with / (for example /workspace/<id>)"
  ! has_control_char "$path" || die "webkit-capture PATH must not hold a control character"
  [[ $mode == auto || $mode == host || $mode == docker ]] || die "VERIFY_XUM_WEBKIT must be auto, host or docker"
  require_evidence_name "$name"
  # Docker mounts the folder of the name's last slash, so a name with no folder would mount every file of the evidence.
  [[ $name == */* ]] || die "webkit-capture NAME must look like <feature>/<step>, lowercase (the container writes into the <feature> folder)"
  load_run "${3:-}"
  require_path_on_run_origin "$path"
  need node timeout
  [[ -d $VERIFY_XUM_RUN/tmp ]] || die "the run was cleaned up ($VERIFY_XUM_RUN/tmp is gone)"
  base="$VERIFY_XUM_EVIDENCE/$name-webkit"
  mkdir -p "$(dirname "$base")"
  # A failed capture must not leave the last one's files behind as if they were its result. The
  # .tmp files are the helper's staged names, left only by a helper that was killed.
  rm -f "$base".{png,txt}{,.tmp}
  token=$(run_token)
  local helper_args=(--checkout "$CHECKOUT" --base "$VERIFY_XUM_URL" --path "$path" --out "$base.png"
    --settled-js "$SETTLED_OR_CHUNK_FAILED_JS" --chunk-failed-js "$CHUNK_LOAD_FAILED_JS")

  if [[ $mode != docker ]]; then
    output=$(webkit_on_host "$token" "${helper_args[@]}" 2>&1) || rc=$?
    case $rc in
      0) webkit_report "$base"; return 0 ;;
      "$WEBKIT_NOT_LAUNCHED") host_reason=${output#webkit-capture: } ;;
      124) die "webkit-capture timed out on the host" ;;
      *) printf '%s\n' "$output" | redact_token >&2; exit "$rc" ;;
    esac
  fi
  if [[ $mode != host ]]; then
    [[ $mode == docker ]] || echo "verify-xum: WebKit did not launch on this host (${host_reason:0:120}...). Running it in Docker." >&2
    rc=0
    webkit_in_docker "$token" "$(dirname "$base")" "${helper_args[@]}" || rc=$?
    case $rc in
      0) webkit_report "$base"; return 0 ;;
      "$WEBKIT_NOT_LAUNCHED" | 125 | 126 | 127) WEBKIT_DOCKER_REASON=${WEBKIT_DOCKER_REASON:-docker run exited $rc (its output is above)} ;;
      124) die "webkit-capture timed out in Docker" ;;
      *) exit "$rc" ;;
    esac
  fi
  die "WebKit did not run.
  Host:   ${host_reason:-not tried (VERIFY_XUM_WEBKIT=docker)}
  Docker: ${WEBKIT_DOCKER_REASON:-not tried (VERIFY_XUM_WEBKIT=host)}
Make one of them work:
  1. Host: run node_modules/.bin/playwright install --with-deps webkit (the locked Playwright; it installs the GTK and GStreamer packages with apt).
  2. Docker: run a local Docker daemon. It pulls $WEBKIT_IMAGE (Playwright $WEBKIT_IMAGE_PLAYWRIGHT_CORE)."
}

is_dev_server_sandbox_root() {
  [[ -n $1 && -d $1 && $(basename "$1") == mux-dev-server-* ]]
}

# Runs the xum CLI (dist/cli/api.mjs) against the newest run, under env -i: the live Xum's server
# URL and token are in the caller's env under XUM_* and MUX_* names, and the CLI reads either. The
# CLI speaks only TCP and reads server.lock itself, so this first checks that the backend that
# server.lock names carries this run's id and is what listens on its port. The port can be free
# otherwise (see backend_curl), and the CLI would send the token to whoever bound it. The CLI's own
# read of server.lock ignores a lock whose pid has died (ServerLockfile.read), so a restart after
# this check is caught there. What is left is the moment between that read and the CLI's connect.
cmd_cli() {
  load_run ""
  local lock pid port listeners
  lock=$(cat "$VERIFY_XUM_ROOT/server.lock" 2>/dev/null) \
    || die "$VERIFY_XUM_ROOT/server.lock is gone (the backend stopped or is restarting). Try again."
  pid=$(json_field_or_empty /dev/stdin pid <<<"$lock")
  [[ $pid =~ ^[0-9]+$ ]] || die "server.lock names no backend pid"
  grep -qszx "VERIFY_XUM_SERVER_OF=$VERIFY_XUM_RUN_ID" "/proc/$pid/environ" \
    || die "the backend that server.lock names (pid $pid) is not a running process of this run, so the CLI does not get its token"
  [[ $(json_field_or_empty /dev/stdin baseUrl <<<"$lock") == "$VERIFY_XUM_BACKEND" ]] \
    || die "server.lock does not name $VERIFY_XUM_BACKEND"
  port=${VERIFY_XUM_BACKEND##*:}
  listeners=$(ss -Hltnp "sport = :$port" 2>/dev/null) || die "ss failed, so verify-xum cannot check who listens on the backend's port $port"
  if [[ -z $listeners ]] || grep -qvF "pid=$pid," <<<"$listeners"; then
    die "the backend's port $port is not held by pid $pid alone, so the CLI does not get its token"
  fi
  exec env -i PATH="$PATH" HOME="$HOME" XUM_ROOT="$VERIFY_XUM_ROOT" node "$CHECKOUT/dist/cli/api.mjs" "$@"
}

cmd_cleanup() {
  load_run "${1:-}"
  local i
  # Read the token before the group stops: the backend then deletes server.lock.
  REDACT_TOKEN=$(run_token)
  # agent-browser `close` on a session that does not exist starts that session first. From
  # launch_failed this runs with the launch guard on fd 9: an agent-browser daemon started here
  # must not inherit it, or it holds the flock and blocks every later launch.
  if [[ $(agent-browser session list 2>/dev/null 9>&-) == *"$AGENT_BROWSER_SESSION"* ]]; then
    agent-browser --session "$AGENT_BROWSER_SESSION" close >/dev/null 2>&1 9>&- || true
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
  drop_current_run_link_if "$VERIFY_XUM_RUN"
  VERIFY_XUM_PGID=
  write_state
  # Last: the redaction above used it.
  rm -f "$VERIFY_XUM_RUN/token"
  echo "cleaned up run $VERIFY_XUM_RUN_ID; evidence kept in $VERIFY_XUM_EVIDENCE ($(find "$VERIFY_XUM_EVIDENCE" -type f | wc -l | tr -d ' ') files) and $VERIFY_XUM_RUN/server.log"
}

# The newest-run link and the launch guard live in the checkout's git dir. Another account that
# could write there could swap either between a check and its use (a symlink, a FIFO, a folder),
# so every command refuses a git dir, or a worktree's common git dir, that is not a real folder
# of this user or that group or others can write: the rule for the run home and the folders
# above it. A writable folder above would let another account rename the whole git dir away and
# put its own in its place. The checks on the guard's open fd stay as a second line.
# Under umask 002 (the default for Debian's and Ubuntu's per-user groups) git makes a clone's
# folder, .git and .git/worktrees/<name> 0775, so the refusal says how to fix the folder it names.
GIT_DIR_FIX="run chmod g-w,o-w @DIR@ (git makes its folders group-writable under umask 002), or use a checkout made under umask 022"
require_private_git_dirs() {
  local dir
  for dir in "$CHECKOUT_GIT_DIR" "$(git -C "$CHECKOUT" rev-parse --path-format=absolute --git-common-dir)"; do
    dir=$(cd -P -- "$dir" && pwd -P)
    require_private_dir "$dir" "$GIT_DIR_FIX"
    require_safe_ancestors "$dir" "the git dir $dir" "$GIT_DIR_FIX"
  done
}
require_private_git_dirs

case ${1:-} in
  launch) cmd_launch ;;
  doctor) cmd_doctor "${2:-}" ;;
  env) cmd_env "${2:-}" ;;
  open) cmd_open "${2:-}" "${3:-}" ;;
  workspace-field) cmd_workspace_field "${2:-}" "${3:-}" "${4:-}" ;;
  capture) cmd_capture "${2:-}" "${3:-}" ;;
  webkit-capture) cmd_webkit_capture "${2:-}" "${3:-}" "${4:-}" ;;
  idle) cmd_idle "${2:-}" ;;
  send-ready) cmd_send_ready "${2:-}" ;;
  cleanup) cmd_cleanup "${2:-}" ;;
  cli)
    shift
    cmd_cli "$@"
    ;;
  *) die "usage: verify-xum.sh launch | doctor [RUN] | env [RUN] | open PATH [RUN] | workspace-field NAME FIELD [RUN] | capture NAME [RUN] | webkit-capture PATH NAME [RUN] | idle [RUN] | send-ready [RUN] | cleanup [RUN] | cli ARGS..." ;;
esac
