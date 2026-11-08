#!/usr/bin/env bash
# Retry a command with backoff between attempts.
# Usage: scripts/retry.sh [options] <max_attempts> <backoff_secs> <command...>
#
# max_attempts is the number of tries (0 means no limit, which needs --budget-secs).
# backoff_secs is the wait between tries. Options come before max_attempts:
#   --max-backoff-secs <n>  Double the wait after each failure, up to n seconds. Without
#                           this option every wait is backoff_secs.
#   --budget-secs <n>       Give up when the next wait would end more than n seconds after
#                           the first try started, and cut a running try off when the budget
#                           ends (with GNU `timeout`, or `gtimeout`; a host with neither, such
#                           as stock macOS, lets a try run to its own end). A fixed count of
#                           tries cannot outlast an outage: github.com release downloads
#                           answered 504 for more than 7 minutes on 2026-11-08, and
#                           `curl --retry 5` waits about 30 s.
#   --fatal-status <n>      Give up at once when the command exits with n (repeatable), for
#                           a failure that another try cannot change, such as an HTTP 404.
# Exit status: 0 when the command succeeded, 1 when the retries ended.
#
# Designed for CI (GitHub Actions): uses ::group:: markers for log folding
# and ::error:: annotations on final failure. Runs under macOS's bash 3.2 too.
set -euo pipefail

usage() {
  echo "Usage: retry.sh [--max-backoff-secs <n>] [--budget-secs <n>] [--fatal-status <n>]... <max_attempts> <backoff_secs> <command...>" >&2
  exit 2
}

whole_number() {
  [[ "$1" =~ ^[0-9]+$ ]] || usage
}

max_backoff=""
budget=""
fatal_statuses=()
while [[ "${1:-}" == --* ]]; do
  [[ $# -ge 2 ]] || usage
  whole_number "$2"
  case "$1" in
    --max-backoff-secs) max_backoff=$2 ;;
    --budget-secs) budget=$2 ;;
    --fatal-status) fatal_statuses+=("$2") ;;
    *) usage ;;
  esac
  shift 2
done

[[ $# -ge 3 ]] || usage
max_attempts=$1
backoff_secs=$2
shift 2
whole_number "$max_attempts"
whole_number "$backoff_secs"
if [[ "$max_attempts" -eq 0 && -z "$budget" ]]; then
  echo "retry.sh: max_attempts 0 (no limit) needs --budget-secs" >&2
  exit 2
fi

# The command that cuts a try off at the budget, if the host has one.
cutoff=""
if [[ -n "$budget" ]]; then
  for candidate in timeout gtimeout; do
    if command -v "$candidate" >/dev/null 2>&1; then
      cutoff=$candidate
      break
    fi
  done
fi

start=$SECONDS
wait_secs=$backoff_secs
attempt=0
while true; do
  attempt=$((attempt + 1))
  if [[ "$max_attempts" -eq 0 ]]; then
    echo "::group::Attempt $attempt"
  else
    echo "::group::Attempt $attempt of $max_attempts"
  fi
  run=("$@")
  if [[ -n "$cutoff" ]]; then
    remaining=$((budget - (SECONDS - start)))
    if [[ "$remaining" -lt 1 ]]; then
      remaining=1
    fi
    # -k: a command that ignores the TERM at the budget is killed 5 s later.
    run=("$cutoff" -k 5 "$remaining" "$@")
  fi
  if "${run[@]}"; then
    echo "::endgroup::"
    exit 0
  else
    status=$?
  fi
  echo "::endgroup::"

  # ${arr[@]+...}: an empty array is an unbound variable under `set -u` in bash 3.2.
  for fatal in ${fatal_statuses[@]+"${fatal_statuses[@]}"}; do
    if [[ "$status" -eq "$fatal" ]]; then
      echo "::error::Attempt $attempt failed with exit $status, which retrying cannot change"
      exit 1
    fi
  done
  if [[ "$max_attempts" -ne 0 && "$attempt" -ge "$max_attempts" ]]; then
    echo "::error::All $max_attempts attempts failed (last exit $status)"
    exit 1
  fi
  elapsed=$((SECONDS - start))
  if [[ -n "$budget" && $((elapsed + wait_secs)) -gt "$budget" ]]; then
    echo "::error::Attempt $attempt failed (exit $status) after ${elapsed}s, and the ${budget}s budget is spent"
    exit 1
  fi

  echo "⚠️ Attempt $attempt failed (exit $status) after ${elapsed}s — retrying in ${wait_secs}s..."
  sleep "$wait_secs"
  if [[ -n "$max_backoff" ]]; then
    wait_secs=$((wait_secs * 2))
    if [[ "$wait_secs" -gt "$max_backoff" ]]; then
      wait_secs=$max_backoff
    fi
  fi
done
