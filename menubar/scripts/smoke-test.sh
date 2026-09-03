#!/usr/bin/env bash
# Run the app's --status mode against a fixture registry.
#
# The fixture is the runs.json schema contract. The TypeScript side validates
# the same file, so a change that breaks one decoder fails a test on both.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$ROOT/fixtures/runs.v1.json"
BUNDLE="${BUNDLE:-}"

if [[ -n "$BUNDLE" ]]; then
  BINARY="$BUNDLE/Contents/MacOS/BuncargoBar"
else
  BINARY="$(cd "$ROOT" && swift build -c release --arch arm64 --show-bin-path)/BuncargoBar"
fi

if [[ ! -x "$BINARY" ]]; then
  echo "No BuncargoBar binary at $BINARY" >&2
  exit 1
fi

# A throwaway HOME so the app reads the fixture instead of the real registry.
FAKE_HOME="$(mktemp -d)"
trap 'rm -rf "$FAKE_HOME"' EXIT
mkdir -p "$FAKE_HOME/.buncargo"
cp "$FIXTURE" "$FAKE_HOME/.buncargo/runs.json"

OUTPUT="$(HOME="$FAKE_HOME" "$BINARY" --status)"
echo "$OUTPUT"

# pid 1 is always alive, so the fixture's run must survive the liveness filter
# and every app state must decode.
for expected in "lullu/t3code-f003056f" "platform=ready" "api=starting" "worker=reused"; do
  if [[ "$OUTPUT" != *"$expected"* ]]; then
    echo "Expected --status output to contain '$expected'" >&2
    exit 1
  fi
done

echo "Smoke test passed"
