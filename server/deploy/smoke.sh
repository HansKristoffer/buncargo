#!/usr/bin/env bash
set -euo pipefail
curl --fail --silent --show-error --max-time 10 https://connect.hanskristoffer.dk/healthz | python3 -c 'import json,sys; assert json.load(sys.stdin)["ok"]'
# Verify the handshake, then close: s_client can wait for application traffic
# indefinitely after a valid handshake, turning a healthy relay into a timeout.
python3 - <<'PY'
import socket
import ssl

host = 'connect.hanskristoffer.dk'
with socket.create_connection((host, 7000), timeout=10) as connection:
    with ssl.create_default_context().wrap_socket(connection, server_hostname=host):
        pass
PY
