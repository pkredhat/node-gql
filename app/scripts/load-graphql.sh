#!/usr/bin/env bash

set -euo pipefail


if [[ -z "${GRAPHQL_URL:-}" ]]; then
  echo "GRAPHQL_URL environment variable must be set" >&2
  exit 1
fi

CONCURRENCY="${1:-10}"

if ! [[ "$CONCURRENCY" =~ ^[0-9]+$ ]] || [[ "$CONCURRENCY" -lt 1 ]]; then
  echo "Concurrency must be a positive integer" >&2
  exit 1
fi

QUERY='{"query":"{ authors { id firstname lastname books { id title } } }"}'

echo "Starting $CONCURRENCY request loops against $GRAPHQL_URL"
echo "Press Ctrl+C to stop."

pids=()

cleanup() {
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true;
  done
  wait >/dev/null 2>&1 || true
}

trap cleanup INT TERM

for _ in $(seq 1 "$CONCURRENCY"); do
  (
    while true; do
      curl -s -X POST "$GRAPHQL_URL" \
        -H 'content-type: application/json' \
        -d "$QUERY" \
        > /dev/null
    done
  ) &
  pids+=("$!")
done

wait
