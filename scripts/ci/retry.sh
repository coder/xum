#!/usr/bin/env bash
# Run a command, and run it again with exponential backoff until it succeeds or the time
# budget runs out.
#
# Usage: scripts/ci/retry.sh <budget-seconds> <command> [args...]
#
# Why: github.com release downloads answered 504 for more than 7 minutes on 2026-11-08 and
# failed CI on two PRs. `curl --retry 5` waits about 30 seconds in total, so a fixed retry
# count cannot outlast an outage like that. The wait starts at RETRY_INITIAL_DELAY_SECS,
# doubles after each failure and stops growing at RETRY_MAX_DELAY_SECS. The script gives up
# when the next wait would end after the budget. It then exits with the command's last status.
# No -e: the loop reads each failed status itself.
set -uo pipefail

if (($# < 2)) || ! [[ "$1" =~ ^[0-9]+$ ]]; then
  echo "usage: retry.sh <budget-seconds> <command> [args...]" >&2
  exit 2
fi
budget=$1
shift

delay=${RETRY_INITIAL_DELAY_SECS:-2}
max_delay=${RETRY_MAX_DELAY_SECS:-60}
if ! [[ "$delay" =~ ^[0-9]+$ && "$max_delay" =~ ^[0-9]+$ ]]; then
  echo "retry.sh: RETRY_INITIAL_DELAY_SECS and RETRY_MAX_DELAY_SECS must be whole seconds" >&2
  exit 2
fi

start=$SECONDS
attempt=1
while true; do
  if "$@"; then
    exit 0
  else
    status=$?
  fi
  elapsed=$((SECONDS - start))
  if ((elapsed + delay > budget)); then
    echo "retry.sh: attempt $attempt failed with exit $status after ${elapsed}s; the ${budget}s budget is spent" >&2
    exit "$status"
  fi
  echo "retry.sh: attempt $attempt failed with exit $status after ${elapsed}s; retrying in ${delay}s (budget ${budget}s)" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
  delay=$((delay * 2))
  if ((delay > max_delay)); then
    delay=$max_delay
  fi
done
