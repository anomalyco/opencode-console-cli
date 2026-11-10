#!/usr/bin/env bash
# End-to-end run of the compiled binary and its updater against local stand-ins (script/e2e/servers.ts). Run on a
# Linux x64 machine you don't mind compiling on, from the repository root:
#   bash script/e2e/run.sh
# Everything lives under one temporary root: HOME, XDG directories, release archives. Nothing touches real configs.
# Each check is a single-quoted command `check` evals later, so its variables expand then (SC2016, SC2034).
# shellcheck disable=SC2016,SC2034
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
ROOT=$(mktemp -d /tmp/console-e2e.XXXX)
export HOME=$ROOT/home XDG_DATA_HOME=$ROOT/data XDG_CACHE_HOME=$ROOT/cache XDG_CONFIG_HOME=$ROOT/config
mkdir -p "$HOME" "$ROOT/rel"
DATA=$XDG_DATA_HOME/opencode-console
PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
section() { echo; echo "== $1"; }
cp package.json "$ROOT/package.json.orig"
cp src/self-test.ts "$ROOT/self-test.ts.orig"
cp src/index.ts "$ROOT/index.ts.orig"
restore() { cp "$ROOT/package.json.orig" package.json; cp "$ROOT/self-test.ts.orig" src/self-test.ts; cp "$ROOT/index.ts.orig" src/index.ts; }
trap 'restore; kill $SERVERS 2>/dev/null' EXIT

version() { sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$1\"/" package.json; }
# compile <version> [broken-self-test|crashing-hooks]: one linux-x64 binary, packed as the release ships it.
compile() {
  restore
  version "$1"
  case "${2:-}" in
    broken-self-test) sed -i 's/decisions === "allow,deny,deny"/decisions === "e2e-broken"/' src/self-test.ts; grep -q e2e-broken src/self-test.ts || { echo "self-test breakage didn't apply"; exit 1; } ;;
    crashing-hooks) sed -i 's/^async function decide(inputs: readonly PolicyEvaluator.Input\[\]) {$/&\n  throw new Error("e2e crash")/' src/index.ts; grep -q "e2e crash" src/index.ts || { echo "crash breakage didn't apply"; exit 1; } ;;
  esac
  bun script/compile.ts linux-x64 >/dev/null || { echo "compile $1 failed"; exit 1; }
  bun script/pack.ts --out "$ROOT/rel/pack-$1" >/dev/null || { echo "pack $1 failed"; exit 1; }
  cp "$ROOT/rel/pack-$1"/*.tgz "$ROOT/rel/opencode-console-linux-x64-$1.tgz"
  restore
}
publish() { echo "$1 $ROOT/rel/opencode-console-linux-x64-$1.tgz" > "$ROOT/rel/dev.current"; }
settings() { cat "$HOME/.claude/settings.json"; }
# hook <command>: Claude Code's PreToolUse hook as setup registered it, for a Bash call. Prints "<exit> <ms>".
hook() {
  bun -e '
    const settings = JSON.parse(await Bun.file(process.env.HOME + "/.claude/settings.json").text())
    const handler = settings.hooks.PreToolUse.at(-1).hooks[0]
    const started = performance.now()
    const child = Bun.spawn([handler.command, ...(handler.args ?? [])], {
      env: { ...process.env, ...(process.env.HOOK_PATH ? { PATH: process.env.HOOK_PATH } : {}) },
      stdin: new Blob([JSON.stringify({ hook_event_name: "PreToolUse", cwd: "/tmp", tool_name: "Bash", tool_input: { command: process.argv[1] } })]),
      stdout: "pipe", stderr: "pipe",
    })
    const code = await child.exited
    console.log(code, Math.round(performance.now() - started))
  ' "$1"
}
receipt() { bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text())[process.argv[2]] ?? "")' "$DATA/cli/install.json" "$1" 2>/dev/null; }
until_true() { for _ in $(seq 1 "$2"); do eval "$1" && return 0; sleep 1; done; return 1; }

# Dev builds are the only ones that follow a release service on this computer, as the stand-in below is.
V0=0.1.8-dev.1 V1=0.1.9-dev.2 V2=0.1.10-dev.3 V3=0.1.11-dev.4 V4=0.1.12-dev.5
section "Build: npm bundle $V0, binaries $V1, $V2, $V3 (self-test broken), $V4 (hooks crash)"
version "$V0"
bun run build >/dev/null || { echo "npm build failed"; exit 1; }
cp -r dist/npm "$ROOT/npm"
compile "$V1"
compile "$V2"
compile "$V3" broken-self-test
compile "$V4" crashing-hooks
ls -la "$ROOT/rel"/*.tgz

bun script/e2e/servers.ts "$ROOT/rel" > "$ROOT/servers.log" 2>&1 &
SERVERS=$!
until_true 'grep -q RELEASE= "$ROOT/servers.log"' 20
eval "$(grep -E '^(CONSOLE|RELEASE)=' "$ROOT/servers.log")"
export OPENCODE_CONSOLE_RELEASE_SERVICE=$RELEASE
echo "console $CONSOLE, release $RELEASE"

section "Node fallback: setup claude-code from npm while the release service has no release"
node "$ROOT/npm/index.js" setup claude-code > "$ROOT/setup1.log" 2>&1; status=$?
sed 's/^/    /' "$ROOT/setup1.log"
check "setup exited 0" '[ $status -eq 0 ]'
check "receipt says npm-bundle $V0" '[ "$(receipt method) $(receipt version)" = "npm-bundle $V0" ]'
check "Claude Code's hook runs the Node copy" 'settings | grep -q "$DATA/cli/index.js"'
read -r code ms <<< "$(hook 'rm -rf ./probe')"
check "Node copy blocks rm -rf ./probe (exit $code, ${ms} ms)" '[ "$code" = 2 ]'
node "$ROOT/npm/index.js" setup hermes > "$ROOT/setup-hermes.log" 2>&1; status=$?
check "setup hermes from the Node copy exited 0" '[ $status -eq 0 ]'
check "Hermes's plugin runs the Node copy" 'grep -q "$DATA/cli/index.js" "$HOME/.hermes/plugins/opencode-console/__init__.py"'

section "Migration: setup pi from npm hands over to the $V1 binary, which moves Claude Code onto it"
publish $V1
node "$ROOT/npm/index.js" setup pi > "$ROOT/setup2.log" 2>&1; status=$?
sed 's/^/    /' "$ROOT/setup2.log"
check "setup exited 0" '[ $status -eq 0 ]'
check "receipt says direct $V1 with the archive's SHA-256" '[ "$(receipt method) $(receipt version) $(receipt target)" = "direct $V1 linux-x64" ] && [ "$(receipt sha256)" = "$(sha256sum "$ROOT/rel/opencode-console-linux-x64-$V1.tgz" | cut -d" " -f1)" ]'
check "the Node copy's files are gone, its entry now running the binary" 'grep -q "Runs the installed opencode-console binary" "$DATA/cli/index.js" && ! ls "$DATA/cli" | grep -q chunk-'
check "the binary wrote pi-extension.js and dsh-plugin.js beside itself" '[ -s "$DATA/cli/pi-extension.js" ] && [ -s "$DATA/cli/dsh-plugin.js" ]'
check "Pi lists the installed extension" 'grep -q "$DATA/cli/pi-extension.js" "$HOME/.pi/agent/settings.json"'
check "pi-extension.js parses under Node" 'node --check "$DATA/cli/pi-extension.js"'
check "dsh-plugin.js loads under Node and exports apply" '[ "$(node -e "import(process.argv[1]).then((m) => console.log(typeof m.apply))" "$DATA/cli/dsh-plugin.js")" = function ]'
check "Claude Code's hook now runs the binary" 'settings | grep -q "\"command\": \"$DATA/cli/opencode-console\"" || settings | grep -q "\"command\":\"$DATA/cli/opencode-console\""'
check "Claude Code's header names $V1" 'settings | grep -q "opencode-console/$V1"'
check "Hermes's plugin now runs the binary" 'grep -q "\"$DATA/cli/opencode-console\"" "$HOME/.hermes/plugins/opencode-console/__init__.py" && ! grep -q "index.js" "$HOME/.hermes/plugins/opencode-console/__init__.py"'
echo '{"action":"shell","resources":["rm -rf ./probe"],"shell":"bash"}' | node "$DATA/cli/index.js" check > "$ROOT/shim.log"; status=$?
check "a session still running the Node copy's entry gets the binary's decision (exit $status)" '[ $status -eq 2 ] && grep -q deny "$ROOT/shim.log"'

section "Hook decisions from the binary"
read -r code ms <<< "$(hook 'echo ok && rm -rf ./probe')"
check "blocks echo ok && rm -rf ./probe (exit $code, ${ms} ms)" '[ "$code" = 2 ]'
read -r code ms <<< "$(hook 'ls')"
check "allows ls (exit $code, ${ms} ms)" '[ "$code" = 0 ]'
read -r code ms <<< "$(HOOK_PATH=/var/empty hook 'ls')"
check "allows ls with nothing on PATH, so no Node (exit $code, ${ms} ms)" '[ "$code" = 0 ]'
times=""
for _ in 1 2 3 4 5 6 7 8 9; do read -r code ms <<< "$(hook 'ls')"; times="$times$ms "; done
echo "    hook times (ms): $times"

section "Update $V1 → $V2 from a session start, in the background"
publish $V2
echo '{"hook_event_name":"SessionStart","session_id":"s1","cwd":"/tmp"}' | "$DATA/cli/opencode-console" hook claude-code >/dev/null
check "the receipt reaches $V2 within 60 s" 'until_true "[ \"\$(receipt version)\" = $V2 ]" 60'
check "$V1 is kept for a rollback" '[ "$(bun -e "console.log(JSON.parse(await Bun.file(process.argv[1]).text()).version)" "$DATA/cli.prev/install.json")" = $V1 ]'
check "Claude Code's header now names $V2" 'until_true "settings | grep -q opencode-console/$V2" 30'
check "pi-extension.js is $V2's" 'until_true "grep -q $V2 \"$DATA/cli/pi-extension.js\"" 30'
check "the update asked with the protocol's User-Agent" 'grep -q "opencode-console/dev/$V1/cli" "$ROOT/servers.log"'
read -r code ms <<< "$(hook 'rm -rf ./probe')"
check "$V2 blocks rm -rf ./probe (exit $code, ${ms} ms)" '[ "$code" = 2 ]'
sed 's/^/    log: /' "$DATA/logs/auto-update.log"

section "A build that fails its self-test isn't installed"
publish $V3
"$DATA/cli/opencode-console" update > "$ROOT/update3.log" 2>&1; status=$?
sed 's/^/    /' "$ROOT/update3.log"
check "update exits 1" '[ $status -eq 1 ]'
check "the receipt stays $V2" '[ "$(receipt version)" = $V2 ]'
check "the binary is still $V2" '"$DATA/cli/opencode-console" help | head -1 | grep -q "$V2"'

section "A build whose hooks crash is rolled back after three in a row"
publish $V4
"$DATA/cli/opencode-console" update > "$ROOT/update4.log" 2>&1
sed 's/^/    /' "$ROOT/update4.log"
check "$V4 installed (its self-test passes)" '[ "$(receipt version)" = $V4 ]'
codes=""
read -r code ms <<< "$(hook 'ls')"; codes="$codes$code "
# A session start decides nothing, so it says nothing about the build and doesn't reset the count.
echo '{"hook_event_name":"SessionStart","session_id":"s1","cwd":"/tmp"}' | "$DATA/cli/opencode-console" hook claude-code >/dev/null; codes="${codes}start:$? "
for _ in 2 3; do read -r code ms <<< "$(hook 'ls')"; codes="$codes$code "; done
check "each crashing hook failed closed, a session start between them (exits: $codes)" '[ "$codes" = "2 start:0 2 2 " ]'
check "the install is back on $V2" '[ "$(receipt version)" = $V2 ]'
check "$V4 is blocked" 'grep -q $V4 "$DATA/auto-update.json"'
check "Claude Code's header names $V2 again" 'until_true "settings | grep -q opencode-console/$V2" 30'
read -r code ms <<< "$(hook 'ls')"
check "ls is allowed again (exit $code, ${ms} ms)" '[ "$code" = 0 ]'
"$DATA/cli/opencode-console" update --check > "$ROOT/update5.log" 2>&1
sed 's/^/    /' "$ROOT/update5.log"
check "a check reports the rolled-back build rather than offer it" 'grep -q "rolled back" "$ROOT/update5.log"'

section "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
