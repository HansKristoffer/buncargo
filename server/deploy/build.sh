#!/usr/bin/env bash
# Build once in CI; deploy the checksummed bytes rather than rebuilding on Hetzner.
set -euo pipefail

[[ "$(uname -s)-$(uname -m)" == Linux-x86_64 ]] || {
  echo 'Build on Linux x64 to match the relay host' >&2
  exit 1
}

artifact=${1:?output directory required}
mkdir -p "$artifact"
artifact=$(cd "$artifact" && pwd)

bun build --compile --target=bun-linux-x64-baseline server/connect/main.ts --outfile "$artifact/directory"
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go run github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.5 build v2.11.4 --with github.com/caddy-dns/cloudflare@v0.2.4 --output "$artifact/caddy"
bun -e 'import {installFrp} from "./src/core/connect/binary"; await Bun.write(process.argv[1],Bun.file(await installFrp("frps")));' "$artifact/frps"

chmod 755 "$artifact/frps" "$artifact/caddy" "$artifact/directory"
cp server/deploy/{Caddyfile,frps.json,activate.sh,cert-sync.sh,backup.sh,smoke.sh} "$artifact/"

printf '%s\n' "$(git rev-parse HEAD)" >"$artifact/commit"
(cd "$artifact" && sha256sum directory caddy frps Caddyfile frps.json activate.sh cert-sync.sh backup.sh smoke.sh commit >SHA256SUMS)
