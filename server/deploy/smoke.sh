#!/usr/bin/env bash
set -euo pipefail
curl --fail --silent --show-error --max-time 10 https://connect.hanskristoffer.dk/healthz | python3 -c 'import json,sys; assert json.load(sys.stdin)["ok"]'
# Check the actual certificate served by frps, with normal hostname and CA verification.
timeout 10 openssl s_client -connect connect.hanskristoffer.dk:7000 -servername connect.hanskristoffer.dk -verify_hostname connect.hanskristoffer.dk -verify_return_error </dev/null >/dev/null 2>&1
