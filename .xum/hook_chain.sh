# shellcheck shell=bash
# Sourced by .xum/tool_pre and .xum/tool_post. Xum runs a project hook instead
# of the user's hook of the same name in the Xum home, because the first hook
# file found wins. So these hooks run the user's hook last, through exec: its
# output, exit code, env and cwd pass through unchanged, and a user tool_pre
# that blocks still blocks.
# Only bash builtins up to the exec: the hooks run around every tool call.

# The Xum home in the order getXumHome() and the runtimes use: XUM_ROOT or
# MUX_ROOT, a Docker workspace's /var/mux, then ~/.xum if it has entries, the
# leftover home its .legacy-fallback marker names, ~/.xum, ~/.mux, ~/.cmux
# (-dev variants under a development server). An SSH workspace uses ~/.mux, and
# this finds it unless the remote host also has a ~/.xum.
xum_home() {
  local root=${XUM_ROOT:-${MUX_ROOT:-}} suffix="" marker entry
  if [[ -n "$root" ]]; then
    printf '%s' "$root"
    return
  fi
  if [[ -d /var/mux ]]; then
    printf '%s' /var/mux
    return
  fi
  [[ "${NODE_ENV:-}" == "development" ]] && suffix=-dev
  local canonical=$HOME/.xum$suffix
  if [[ -d "$canonical" ]]; then
    for entry in "$canonical"/* "$canonical"/.[!.]* "$canonical"/..?*; do
      if [[ -e "$entry" || -L "$entry" ]]; then
        printf '%s' "$canonical"
        return
      fi
    done
  fi
  if [[ -f "$canonical.legacy-fallback" ]]; then
    marker=$(<"$canonical.legacy-fallback")
    marker=${marker//[[:space:]]/}
    if [[ ("$marker" == ".mux$suffix" || ("$marker" == ".cmux" && -z "$suffix")) && -d "$HOME/$marker" ]]; then
      printf '%s' "$HOME/$marker"
      return
    fi
  fi
  for entry in "$canonical" "$HOME/.mux$suffix"; do
    if [[ -d "$entry" ]]; then
      printf '%s' "$entry"
      return
    fi
  done
  if [[ -z "$suffix" && -d "$HOME/.cmux" ]]; then
    printf '%s' "$HOME/.cmux"
    return
  fi
  printf '%s' "$canonical"
}

exec_user_hook() {
  local hook
  hook=$(xum_home)/$1
  # A project checked out at the Xum home would run this same file again.
  [[ -f "$hook" && -x "$hook" && ! "$hook" -ef "$0" ]] || return 0
  exec "$hook"
}
