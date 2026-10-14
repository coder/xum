# shellcheck shell=bash
# Sourced by .xum/tool_pre and .xum/tool_post. Xum runs a project hook instead
# of the user's hook of the same name in the Xum home, because the first hook
# file found wins. So these hooks run the user's hook last, through exec: its
# output, exit code, env and cwd pass through unchanged, and a user tool_pre
# that blocks still blocks.
# Only bash builtins up to the exec: the hooks run around every tool call.

# The Xum home the way the runtimes pick it: an absolute XUM_ROOT or MUX_ROOT,
# ~/.mux in an SSH workspace, /var/mux in a Docker one, ~/.xum in a
# devcontainer (XUM_RUNTIME says which), else ~/.xum (~/.xum-dev under a
# development server). Xum's leftover-home fallbacks (~/.mux, ~/.cmux and the
# .legacy-fallback marker) are not copied here: a user whose only home is a
# leftover one keeps today's behavior, and the project hook skips their hook.
# No home (a relative root, no HOME) prints nothing and fails.
xum_home() {
  local root=${XUM_ROOT:-${MUX_ROOT:-}}
  if [[ -n "$root" ]]; then
    [[ "$root" == /* ]] || return 1
    printf '%s' "$root"
    return
  fi
  [[ "${XUM_RUNTIME:-}" == "docker" ]] && printf '%s' /var/mux && return
  [[ "$HOME" == /?* ]] || return 1
  case ${XUM_RUNTIME:-} in
    ssh) printf '%s' "$HOME/.mux" ;;
    devcontainer) printf '%s' "$HOME/.xum" ;;
    *)
      if [[ "${NODE_ENV:-}" == "development" ]]; then
        printf '%s' "$HOME/.xum-dev"
      else
        printf '%s' "$HOME/.xum"
      fi
      ;;
  esac
}

exec_user_hook() {
  local home hook
  home=$(xum_home) || return 0
  hook=$home/$1
  # A project checked out at the Xum home would run this same file again.
  [[ -f "$hook" && -x "$hook" && ! "$hook" -ef "$0" ]] || return 0
  exec "$hook"
}
