#!/usr/bin/env bash
# Shape check for the GraphQL replies that the PR gate scripts read.
#
# GitHub's schema makes the `nodes` of a connection a list of objects, and an author login and a
# body strings. When jq fails on a value of another type, it quotes the start of that value
# (`Cannot iterate over string ("abc...")`). A reply outside the schema could so carry text that a
# PR author wrote into a gate's stderr, so a gate stops on fixed text instead.

# Usage: nodes=$(reply_connection_nodes "$reply" <connection>) || return 1
# Prints the compact `nodes` of the pullRequest connection `<connection>` (comments, reviews,
# reviewThreads or reactions) in `$reply`: an empty list when the connection has none. Prints fixed
# text on stderr and returns 1 for a reply of any other shape.
reply_connection_nodes() {
  local reply="$1"
  local name="$2"
  local nodes

  # jq fails on a node that is no object (a null node passes, as it always did). Its own messages are
  # dropped (2>/dev/null): any failure here means "wrong shape".
  # shellcheck disable=SC2016 # jq variables, not shell variables.
  if ! nodes=$(printf '%s' "$reply" | jq -ce --arg name "$name" '
    def text_ok: (((.author.login // "") | type) == "string") and (((.body // "") | type) == "string");
    def list_of(f): type == "array" and all(.[]; f);
    (.data.repository.pullRequest[$name].nodes // [])
    | select(list_of(text_ok and ((.comments.nodes // []) | list_of(text_ok))))
  ' 2>/dev/null) || [[ -z "$nodes" ]]; then
    echo "❌ The $name in the GitHub reply are not a list of objects with text fields." >&2
    return 1
  fi
  printf '%s\n' "$nodes"
}
