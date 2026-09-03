#!/usr/bin/env bash
# Open an installed BuncargoBar, clearing the quarantine flag first.
#
# The bundle is ad-hoc signed, so a copy that arrived through a browser or an
# archive carries a quarantine attribute Gatekeeper refuses to open silently.
set -euo pipefail
APP="/Applications/BuncargoBar.app"
[[ -d "$APP" ]] || APP="$HOME/Applications/BuncargoBar.app"
if [[ ! -d "$APP" ]]; then
  echo "BuncargoBar is not installed. Run: bunx buncargo bar install" >&2
  exit 1
fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
open "$APP"
