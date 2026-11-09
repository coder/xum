#!/usr/bin/env bash
# Shape check for the GraphQL replies that the PR gate scripts read.
#
# GitHub's schema makes the `nodes` of a connection a list of objects, and an author login and a
# body strings. When jq fails on a value of another type, it quotes the start of that value
# (`Cannot iterate over string ("abc...")`). A reply outside the schema could so carry text that a
# PR author wrote into a gate's stderr, so a gate stops on fixed text instead.

# Usage: nodes=$(reply_connection_nodes "$reply" <connection>) || return 1
# Prints the compact `nodes` of the pullRequest connection `<connection>` (comments, reviews,
# reviewThreads or reactions) in `$reply`: an empty list when the connection has none (null or
# missing nodes). Prints fixed text on stderr and returns 1 for a reply of any other shape: nodes
# that are not a list, an author login or a body that is not a string, or a createdAt or
# submittedAt that is not a UTC timestamp. The scripts print those times (the approval time, the
# request time), so a time with a line break and a forged line in it must stop here.
reply_connection_nodes() {
  local reply="$1"
  local name="$2"
  local nodes

  # jq fails on a node that is no object (a null node passes, as it always did). Its own messages are
  # dropped (2>/dev/null): any failure here means "wrong shape". `// []` would turn `false` into an
  # empty list, so only null stands for "no nodes".
  # shellcheck disable=SC2016 # jq variables, not shell variables.
  if ! nodes=$(printf '%s' "$reply" | jq -ce --arg name "$name" '
    def text: . == null or type == "string";
    def time: . == null or (type == "string" and test("\\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\\z"));
    def node_ok: (.author.login | text) and (.body | text) and (.createdAt | time) and (.submittedAt | time);
    def list_of(f): type == "array" and all(.[]; f);
    def nodes_of: if . == null then [] else . end;
    (.data.repository.pullRequest[$name].nodes | nodes_of)
    | select(list_of(node_ok and ((.comments.nodes | nodes_of) | list_of(node_ok))))
  ' 2>/dev/null) || [[ -z "$nodes" ]]; then
    echo "❌ The $name in the GitHub reply are not a list of objects with text fields and timestamps." >&2
    return 1
  fi
  printf '%s\n' "$nodes"
}
