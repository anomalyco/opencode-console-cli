#!/usr/bin/env bash
# A smoke test against a real Console, opt-in and never run in CI: signs in with the caller's OPENCODE_API_KEY (a
# service account key for a test workspace) and runs `sync`, `status --json`, `token`, a policy `check` and
# `setup openclaw` from source.
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

# OpenClaw: setup writes the workspace's models into a scratch install, and `hook openclaw` decides a tool call the
# way setup's plugin asks it to. OpenClaw needn't be installed; setup says so and still writes its config. Every
# OPENCLAW_* variable is dropped first, so a shell inside a running Gateway can't point setup at that Gateway's config.
for name in $(env | sed -n 's/^\(OPENCLAW_[A-Z0-9_]*\)=.*/\1/p'); do unset "$name"; done
export OPENCLAW_STATE_DIR=$home/openclaw
cli setup openclaw > /dev/null
jq -e '.models.providers["opencode-console"].models | length > 0' "$OPENCLAW_STATE_DIR/openclaw.json" > /dev/null
echo "✓ setup openclaw wrote the workspace's models to openclaw.json"
if grep -q 'oc_sk_\|ocgw_' "$OPENCLAW_STATE_DIR/openclaw.json"; then echo "✗ openclaw.json holds a key or token" >&2; exit 1; fi
echo "✓ openclaw.json holds no key or gateway token"
answer=$(echo '{"hook_event_name":"before_tool_call","tool_name":"read","tool_input":{"path":"README.md"},"cwd":"'"$PWD"'"}' | cli hook openclaw) || [ $? -eq 2 ]
echo "$answer" | jq -e 'type == "object"' > /dev/null
echo "✓ hook openclaw decided a tool call: $answer"
cli setup openclaw --remove > /dev/null
[ ! -e "$OPENCLAW_STATE_DIR/openclaw.json" ]
echo "✓ setup openclaw --remove took out the openclaw.json it created"
