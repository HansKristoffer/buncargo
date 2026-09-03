#!/usr/bin/env bash
# Build BuncargoBar from source, install it, and open it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/scripts/package.sh" --install --open
