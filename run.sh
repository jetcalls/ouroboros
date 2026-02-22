#!/usr/bin/env bash
# Ouroboros auto-restart wrapper.
# Restarts the agent after it exits (e.g., after self-modification).
# Exit code 42 = intentional stop (no restart).

set -e

cd "$(dirname "$0")"

while true; do
  echo "[runner] Starting Ouroboros..."
  npx tsx src/index.ts || EXIT_CODE=$?
  EXIT_CODE=${EXIT_CODE:-0}

  if [ "$EXIT_CODE" -eq 42 ]; then
    echo "[runner] Ouroboros exited with code 42 (intentional stop). Not restarting."
    exit 0
  fi

  echo "[runner] Ouroboros exited with code $EXIT_CODE. Restarting in 2s..."
  sleep 2
done
