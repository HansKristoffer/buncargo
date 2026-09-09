#!/usr/bin/env bash
# Caddy owns renewal. Only copy the apex certificate; frps does not need the wildcard key.
set -euo pipefail

state=/var/lib/buncargo-connect
cert=$(find "$state/caddy" -type f -name connect.hanskristoffer.dk.crt -print -quit)
[[ -n "$cert" ]] || exit 1
key=${cert%.crt}.key
openssl x509 -checkend 86400 -noout -in "$cert"

install -d -m 750 -o buncargo-connect -g buncargo-connect "$state/frps-tls"
if ! cmp -s "$cert" "$state/frps-tls/cert.pem" || ! cmp -s "$key" "$state/frps-tls/key.pem"; then
  install -m 600 -o buncargo-connect -g buncargo-connect "$key" "$state/frps-tls/key.pem.new"
  install -m 600 -o buncargo-connect -g buncargo-connect "$cert" "$state/frps-tls/cert.pem.new"
  mv "$state/frps-tls/key.pem.new" "$state/frps-tls/key.pem"
  mv "$state/frps-tls/cert.pem.new" "$state/frps-tls/cert.pem"
  systemctl try-restart buncargo-frps.service
fi
