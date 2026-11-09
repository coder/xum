#!/usr/bin/env bash
# One download attempt, for scripts/retry.sh.
#
# Usage: scripts/ci/fetch-once.sh <url> <dest>
#
# Exit 0: the file is in <dest>. Exit 1: a failure that another try can fix (a network error,
# a timeout, HTTP 408, 429 or 5xx: the 504s of a GitHub outage). Exit 64: an answer that
# another try will not change (any other HTTP status, such as a 404 for a version that no
# longer exists), so retry.sh runs with --fatal-status 64 and gives up at once.
set -uo pipefail

if (($# != 2)); then
  echo "usage: fetch-once.sh <url> <dest>" >&2
  exit 2
fi
url=$1
dest=$2

# No -f: -w reports the status of an error page too.
if ! status=$(curl -sSL --connect-timeout 30 --max-time 300 -o "$dest" -w '%{http_code}' "$url"); then
  exit 1
fi
case "$status" in
  2??) exit 0 ;;
  408 | 429 | 5??)
    echo "fetch-once.sh: $url answered HTTP $status" >&2
    exit 1
    ;;
  *)
    echo "fetch-once.sh: $url answered HTTP $status, and another try will not change that" >&2
    exit 64
    ;;
esac
