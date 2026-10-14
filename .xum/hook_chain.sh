# shellcheck shell=bash
# Sourced by .xum/tool_pre and .xum/tool_post. Xum runs a project hook instead
# of the user's hook of the same name in the Xum home (~/.xum), because the
# first hook file found wins. So these hooks run the user's hook last, through
# exec: its output, exit code, env and cwd pass through unchanged, and a user
# tool_pre that blocks still blocks.
# Only bash builtins up to the exec: the hooks run around every tool call.
exec_user_hook() {
  local home=${XUM_ROOT:-${MUX_ROOT:-}} suffix=""
  if [[ -z "$home" ]]; then
    # Close to Xum's getXumHome(): ~/.xum, else a leftover ~/.mux, with -dev
    # under a development server.
    [[ "${NODE_ENV:-}" == "development" ]] && suffix=-dev
    home=$HOME/.xum$suffix
    [[ -d "$home" ]] || home=$HOME/.mux$suffix
  fi
  local hook=$home/$1
  # A project checked out at the Xum home would run this same file again.
  [[ -f "$hook" && -x "$hook" && ! "$hook" -ef "$0" ]] || return 0
  exec "$hook"
}
