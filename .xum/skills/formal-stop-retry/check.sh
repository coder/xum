#!/usr/bin/env bash
# Model-check StopRetry.tla with TLC: one run per config, each compared with expected_for below.
#
# Usage: .xum/skills/formal-stop-retry/check.sh [config...]   (default: every config in ORDER)
# Env:   FORMAL_OUT       folder for the TLC logs (default: a new temp folder, kept so the
#                         counterexample traces stay readable after the run)
#        TLA2TOOLS_CACHE  folder for the pinned tla2tools.jar (default: <repo>/build/tla, git-ignored)
# Exit:  0 when every result matches expected_for, 1 on a mismatch or an unknown config,
#        2 when Java or the jar is unavailable.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../../.." && pwd)

# TLA+ tools 1.7.4, the last stable release (1.8.0 is a prerelease that is republished about
# daily). GitHub shows no digest for the 1.7.4 assets, which predate digests: the pin is the
# sha256 of our own download, and the pstack statechart skill pins the same value.
TLA_VERSION=1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
TLA_URL="https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar"

# Expected verdict per config: "holds", or the invariant that must be violated.
# A case, not an associative array: macOS ships Bash 3.2, which has none.
ORDER=(reachability ui api task turn timeout)
expected_for() {
  case $1 in
    reachability) echo NoRetryEverResumes ;;
    ui | api | task | turn | timeout) echo holds ;;
    *) echo "" ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    # macOS ships shasum but not always coreutils sha256sum.
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

if ! command -v java >/dev/null 2>&1; then
  echo "formal-stop-retry: java not found (TLC needs Java 11 or newer)" >&2
  exit 2
fi

cache=${TLA2TOOLS_CACHE:-$root/build/tla}
jar="$cache/tla2tools-${TLA_VERSION}.jar"
if [[ ! -f $jar ]]; then
  mkdir -p "$cache"
  echo "downloading tla2tools ${TLA_VERSION} to $jar"
  if ! curl -sSfL -o "$jar.part" "$TLA_URL"; then
    echo "formal-stop-retry: download failed: $TLA_URL" >&2
    exit 2
  fi
  mv "$jar.part" "$jar"
fi
actual=$(sha256_of "$jar")
if [[ $actual != "$TLA_SHA256" ]]; then
  echo "formal-stop-retry: $jar has sha256 $actual, expected $TLA_SHA256; delete it to download again" >&2
  exit 2
fi

out=${FORMAL_OUT:-$(mktemp -d)}
mkdir -p "$out"
out=$(cd "$out" && pwd)

configs=("$@")
[[ ${#configs[@]} -gt 0 ]] || configs=("${ORDER[@]}")

echo "TLC logs in $out"
printf '%-13s %-20s %-20s %9s %9s %6s\n' config result expected distinct generated secs
matched=0
for name in "${configs[@]}"; do
  expected=$(expected_for "$name")
  if [[ -z $expected || ! -f $here/$name.cfg ]]; then
    echo "formal-stop-retry: unknown config '$name' (known: ${ORDER[*]})" >&2
    exit 1
  fi
  log="$out/$name.log"
  start=$SECONDS
  status=0
  (cd "$here" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 1 \
    -metadir "$out/$name.states" -config "$name.cfg" StopRetry.tla) >"$log" 2>&1 || status=$?
  secs=$((SECONDS - start))
  if [[ $status -eq 0 ]] && grep -q '^Model checking completed. No error has been found.' "$log"; then
    result=holds
  elif [[ $status -eq 12 ]] && violated=$(grep -oE '^Error: Invariant [A-Za-z0-9_]+ is violated' "$log"); then
    result=$(awk '{print $3}' <<<"$violated" | head -1)
  else
    result="error(exit $status)"
  fi
  read -r generated distinct < <(sed -nE 's/^([0-9]+) states generated, ([0-9]+) distinct states found.*/\1 \2/p' "$log" | tail -1) || true
  printf '%-13s %-20s %-20s %9s %9s %6s\n' "$name" "$result" "$expected" "${distinct:--}" "${generated:--}" "$secs"
  if [[ $result == "$expected" ]]; then
    matched=$((matched + 1))
  else
    echo "  see $log"
  fi
done
echo "formal-stop-retry: $matched of ${#configs[@]} configs as expected"
[[ $matched -eq ${#configs[@]} ]]
