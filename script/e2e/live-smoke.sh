#!/usr/bin/env bash
# A smoke test against a real Console, opt-in and never run in CI: signs in with the caller's OPENCODE_API_KEY (a
# service account key for a test workspace) and runs `sync`, `status --json`, `token` and a policy `check` from source.
# OPENCODE_CONSOLE_SERVER picks the Console (https://opencode.ai/console by default). HOME is a temporary directory,
# so nothing touches your own sign-in or agent configs. From the repository root:
#   OPENCODE_API_KEY=... bash script/e2e/live-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/../.." || exit 1
[ -n "${OPENCODE_API_KEY:-}" ] || { echo "Set OPENCODE_API_KEY to a key for a test workspace." >&2; exit 1; }
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT
cli() { HOME=$home XDG_DATA_HOME=$home/data XDG_CACHE_HOME=$home/cache XDG_CONFIG_HOME=$home/config bun src/index.ts "$@"; }

cli sync > /dev/null
echo "✓ sync fetched the workspace config"
cli status --json | jq -e '.signedIn == true and .synced != null' > /dev/null
echo "✓ status --json says signed in and synced"
[ -n "$(cli token)" ]
echo "✓ token prints an access token"
decision=$(echo '{"action":"read","resources":["README.md"]}' | cli check) || [ $? -eq 2 ]
echo "$decision" | jq -e '.effect == "allow" or .effect == "deny"' > /dev/null
echo "✓ check decided a tool call: $decision"
