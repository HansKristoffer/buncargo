#!/usr/bin/env bash
# Build BuncargoBar and lay it out as a .app bundle.
#
# VERSION/BUILD_NUMBER come from the environment so the release workflow can
# stamp the released version; local builds default to version.txt, which
# Release Please bumps.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="BuncargoBar"
APP_BUNDLE="$ROOT/$APP_NAME.app"
VERSION="${VERSION:-$(tr -d "[:space:]" < "$ROOT/version.txt")}"
BUILD_NUMBER="${BUILD_NUMBER:-1}"
# Which runs.json schema this build can decode, taken from the fixture both
# test suites already validate — so the number in the bundle and the number the
# Swift decoder enforces cannot drift apart. `buncargo dev` reads it back out of
# Info.plist to decide whether an installed app is too old for the CLI.
REGISTRY_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' \
  "$ROOT/fixtures/runs.v1.json" | head -1)"
if [[ -z "$REGISTRY_VERSION" ]]; then
  echo "Could not read the registry version from fixtures/runs.v1.json" >&2
  exit 1
fi
# Universal by default: Intel Macs still exist and the target is small enough
# that a second slice costs seconds. Override with ARCHS="--arch arm64".
ARCHS="${ARCHS:---arch arm64 --arch x86_64}"

cd "$ROOT"

echo "Building $APP_NAME $VERSION..."
# shellcheck disable=SC2086
swift build -c release $ARCHS

BINARY="$(swift build -c release $ARCHS --show-bin-path)/$APP_NAME"
if [[ ! -f "$BINARY" ]]; then
  echo "Build produced no binary at $BINARY" >&2
  exit 1
fi

echo "Creating app bundle..."
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"
cp "$BINARY" "$APP_BUNDLE/Contents/MacOS/$APP_NAME"

cat > "$APP_BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>$APP_NAME</string>
    <key>CFBundleIdentifier</key>
    <string>dev.buncargo.bar</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${BUILD_NUMBER}</string>
    <key>BuncargoRegistryVersion</key>
    <integer>${REGISTRY_VERSION}</integer>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

echo "Signing app bundle..."
xattr -cr "$APP_BUNDLE" 2>/dev/null || true
codesign --force --deep --sign - "$APP_BUNDLE"

echo "Built $APP_BUNDLE"

if [[ "${1:-}" == "--install" ]]; then
  DEST="/Applications/$APP_NAME.app"
  if ! [[ -w /Applications ]]; then DEST="$HOME/Applications/$APP_NAME.app"; fi
  mkdir -p "$(dirname "$DEST")"
  rm -rf "$DEST"
  ditto "$APP_BUNDLE" "$DEST"
  echo "Installed $DEST"
  if [[ "${2:-}" == "--open" ]]; then open "$DEST"; fi
fi
