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
for expected in "lullu/fix-login" "platform=ready" "api=starting" "worker=reused"; do
  if [[ "$OUTPUT" != *"$expected"* ]]; then
    echo "Expected --status output to contain '$expected'" >&2
    exit 1
  fi
done

HOME="$FAKE_HOME" "$BINARY" --selftest
"$BINARY" --tailnet-selftest "$ROOT/fixtures/tailnet.v1.json"

# A registry from a newer CLI must fail loudly rather than read as "nothing
# running" — that message is the only thing telling the user to update the app.
sed 's/"version": 1/"version": 99/' "$FIXTURE" > "$FAKE_HOME/.buncargo/runs.json"
if OUTPUT="$(HOME="$FAKE_HOME" "$BINARY" --status 2>&1)"; then
  echo "Expected --status to fail on an unsupported registry version" >&2
  exit 1
fi
if [[ "$OUTPUT" != *"buncargo now writes v99"* ]]; then
  echo "Expected an unsupported-version message, got: $OUTPUT" >&2
  exit 1
fi

# The number in Info.plist is what the CLI reads to decide the app is too old,
# so a bundle whose plist disagrees with its decoder is worse than useless.
if [[ -n "$BUNDLE" ]]; then
  STAMPED="$(plutil -extract BuncargoRegistryVersion raw "$BUNDLE/Contents/Info.plist")"
  if [[ "$STAMPED" != "1" ]]; then
    echo "Info.plist claims registry v$STAMPED, the decoder supports v1" >&2
    exit 1
  fi
fi

echo "Smoke test passed"
