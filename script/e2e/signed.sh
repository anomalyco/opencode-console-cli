#!/usr/bin/env bash
# End-to-end run of signed releases against local stand-ins. Run on Linux x64 from the repository root:
#   bash script/e2e/signed.sh
# A test key made for this run stands in for Anomaly's release key: this copy of the repo trusts it (linux-signing.pub,
# signature.ts, install), and .github/release/sign-linux.sh signs with it. No release run uses such a key. This copy also lets stable builds follow the stand-in
# release service on 127.0.0.1, which only dev builds may do. Both patches are undone on exit. Isolated HOME and XDG.
# Each check is a single-quoted command `check` evals later, so its variables expand then (SC2016, SC2034).
# shellcheck disable=SC2016,SC2034
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
CLI=$PWD
REPO=$(pwd)
ROOT=$(mktemp -d /tmp/console-signed.XXXX)
export HOME=$ROOT/home XDG_DATA_HOME=$ROOT/data XDG_CACHE_HOME=$ROOT/cache XDG_CONFIG_HOME=$ROOT/config
mkdir -p "$HOME" "$ROOT/rel" "$ROOT/keys"
DATA=$XDG_DATA_HOME/opencode-console
PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
section() { echo; echo "== $1"; }

patched="package.json src/update/signature.ts src/update/release-service.ts install"
for file in $patched; do cp "$file" "$ROOT/$(basename "$file").orig"; done
cp "$REPO/.github/release/linux-signing.pub" "$ROOT/linux-signing.pub.orig"
restore() {
  for file in $patched; do cp "$ROOT/$(basename "$file").orig" "$file"; done
  cp "$ROOT/linux-signing.pub.orig" "$REPO/.github/release/linux-signing.pub"
}
trap 'restore; kill $SERVERS 2>/dev/null' EXIT

openssl genpkey -algorithm Ed25519 -out "$ROOT/keys/release.pem" 2>/dev/null
openssl pkey -in "$ROOT/keys/release.pem" -pubout -out "$ROOT/keys/release.pub"
openssl genpkey -algorithm Ed25519 -out "$ROOT/keys/other.pem" 2>/dev/null
trust() {
  cp "$ROOT/keys/release.pub" "$REPO/.github/release/linux-signing.pub"
  bun -e '
    const [file, key] = process.argv.slice(1)
    const text = await Bun.file(file).text()
    const pem = (await Bun.file(key).text()).trim()
    const swapped = text.replace(/-----BEGIN PUBLIC KEY-----\n[^\n]+\n-----END PUBLIC KEY-----/, pem)
    if (swapped === text) throw new Error(`no key in ${file}`)
    await Bun.write(file, swapped)
  ' "$1" "$ROOT/keys/release.pub"
}
patch() {
  trust src/update/signature.ts
  trust install
  sed -i 's/(devBuild(version) \&\& loopback(named))/loopback(named)/' src/update/release-service.ts
  grep -q '|| loopback(named)' src/update/release-service.ts || { echo "release-service patch didn't apply"; exit 1; }
  sed -i 's/\[ "\$channel" = dev \] || fail "a release service on this computer serves dev builds only" ;;/;;/' install
  grep -q 'serves dev builds only' install && { echo "installer patch didn't apply"; exit 1; }
}
version() { sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$1\"/" package.json; }
compile() { # <version>: packs/<version>/opencode-console-linux-x64-<version>.tgz, unsigned
  version "$1"
  bun script/compile.ts linux-x64 >/dev/null || { echo "compile $1 failed"; exit 1; }
  bun script/pack.ts --out "$ROOT/rel/packs/$1" >/dev/null || { echo "pack $1 failed"; exit 1; }
}
sign() { # <version>: the real sign-linux.sh, with the test key, for the one target built here
  CONSOLE_TARGETS=linux-x64 CONSOLE_VERSION=$1 CONSOLE_CLI_RELEASE_SIGNING_KEY=$(cat "$ROOT/keys/release.pem") \
    bash "$REPO/.github/release/sign-linux.sh" "$ROOT/rel/packs/$1" "$ROOT/rel/signed/$1" >/dev/null
}
# publish <version> <file>: the stable channel's current build
publish() { cp "$2" "$ROOT/rel/$(basename "$2" .tgz)-$3.tgz"; echo "$1 $ROOT/rel/$(basename "$2" .tgz)-$3.tgz" > "$ROOT/rel/stable.current"; }
receipt() { bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text())[process.argv[2]] ?? "")' "$DATA/cli/install.json" "$1" 2>/dev/null; }
hook() {
  bun -e '
    const settings = JSON.parse(await Bun.file(process.env.HOME + "/.claude/settings.json").text())
    const handler = settings.hooks.PreToolUse.at(-1).hooks[0]
    const child = Bun.spawn([handler.command, ...(handler.args ?? [])], {
      stdin: new Blob([JSON.stringify({ hook_event_name: "PreToolUse", cwd: "/tmp", tool_name: "Bash", tool_input: { command: process.argv[1] } })]),
      stdout: "pipe", stderr: "pipe",
    })
    console.log(await child.exited)
  ' "$1"
}
# repack_as <dir with package/> <out> <target> [signed]: lib.sh's repack, with the target's fixed members
repack_as() { (. "$REPO/.github/release/lib.sh"; read -ra files <<< "$(members "$3" "${4:-}")"; repack "$1" "$2" "${files[@]}"); }

section "Build: stable binaries 0.1.9, 0.1.10, 0.1.11, signed by the real sign-linux.sh with the test key"
patch
for v in 0.1.9 0.1.10 0.1.11; do compile "$v"; done
for v in 0.1.9 0.1.10 0.1.11; do sign "$v" || { echo "sign $v failed"; exit 1; }; done
check "sign-linux.sh wrote a 64-byte signature into the tarball" '[ "$(tar -xzOf "$ROOT/rel/signed/0.1.9/opencode-console-linux-x64-0.1.9.tgz" package/bin/opencode-console.sig | wc -c)" = 64 ]'
cp "$ROOT/keys/other.pem" "$ROOT/keys/wrong.pem"
check "sign-linux.sh refuses a key that isn't linux-signing.pub's" '! CONSOLE_TARGETS=linux-x64 CONSOLE_VERSION=0.1.11 CONSOLE_CLI_RELEASE_SIGNING_KEY="$(cat "$ROOT/keys/other.pem")" bash "$REPO/.github/release/sign-linux.sh" "$ROOT/rel/packs/0.1.11" "$ROOT/rel/wrong" 2>/dev/null'
# 0.1.11 signed by another key, and 0.1.11's binary carrying 0.1.10's signature.
mkdir -p "$ROOT/work/other" "$ROOT/work/swapped"
tar -xzf "$ROOT/rel/packs/0.1.11/opencode-console-linux-x64-0.1.11.tgz" -C "$ROOT/work/other"
printf 'anomaly.opencode-console.linux-artifact.v1\n%s\n' "$(sha256sum "$ROOT/work/other/package/bin/opencode-console" | cut -c1-64)" > "$ROOT/work/message"
openssl pkeyutl -sign -rawin -inkey "$ROOT/keys/other.pem" -in "$ROOT/work/message" -out "$ROOT/work/other/package/bin/opencode-console.sig"
repack_as "$ROOT/work/other" "$ROOT/rel/other-0.1.11.tgz" linux-x64 signed
tar -xzf "$ROOT/rel/packs/0.1.11/opencode-console-linux-x64-0.1.11.tgz" -C "$ROOT/work/swapped"
tar -xzOf "$ROOT/rel/signed/0.1.10/opencode-console-linux-x64-0.1.10.tgz" package/bin/opencode-console.sig > "$ROOT/work/swapped/package/bin/opencode-console.sig"
repack_as "$ROOT/work/swapped" "$ROOT/rel/swapped-0.1.11.tgz" linux-x64 signed
version 0.1.9
bun run build >/dev/null || { echo "npm build failed"; exit 1; }

bun script/e2e/servers.ts "$ROOT/rel" > "$ROOT/servers.log" 2>&1 &
SERVERS=$!
for _ in $(seq 1 20); do grep -q RELEASE= "$ROOT/servers.log" && break; sleep 1; done
eval "$(grep -E '^(CONSOLE|RELEASE)=' "$ROOT/servers.log")"
export OPENCODE_CONSOLE_RELEASE_SERVICE=$RELEASE

section "The installer: curl | sh's script, from the stand-in"
publish 0.1.11 "$ROOT/rel/packs/0.1.11/opencode-console-linux-x64-0.1.11.tgz" unsigned
sh install setup claude-code > "$ROOT/install-unsigned.log" 2>&1; status=$?
sed 's/^/    /' "$ROOT/install-unsigned.log"
check "refuses an unsigned stable build (exit $status), installing nothing" '[ $status -ne 0 ] && grep -q "isn.t signed" "$ROOT/install-unsigned.log" && [ ! -e "$DATA/cli" ]'
publish 0.1.11 "$ROOT/rel/other-0.1.11.tgz" other
sh install setup claude-code > "$ROOT/install-other.log" 2>&1; status=$?
check "refuses a build signed by another key (exit $status)" '[ $status -ne 0 ] && grep -q "signature isn.t" "$ROOT/install-other.log" && [ ! -e "$DATA/cli" ]'
publish 0.1.9 "$ROOT/rel/signed/0.1.9/opencode-console-linux-x64-0.1.9.tgz" signed
sh install setup claude-code > "$ROOT/install.log" 2>&1; status=$?
sed 's/^/    /' "$ROOT/install.log"
check "installs a signed 0.1.9 and sets up Claude Code (exit $status)" '[ $status -eq 0 ] && [ "$(receipt version) $(receipt method) $(receipt channel)" = "0.1.9 direct stable" ]'
check "the receipt names the archive the installer checked" '[ "$(receipt sha256)" = "$(sha256sum "$ROOT/rel/opencode-console-linux-x64-0.1.9-signed.tgz" | cut -c1-64)" ]'
check "the installed hook blocks rm -rf ./probe" '[ "$(hook "rm -rf ./probe")" = 2 ]'

section "Updates, checked against the release key before they run"
publish 0.1.10 "$ROOT/rel/signed/0.1.10/opencode-console-linux-x64-0.1.10.tgz" signed
"$DATA/cli/opencode-console" update > "$ROOT/update1.log" 2>&1; status=$?
sed 's/^/    /' "$ROOT/update1.log"
check "installs the signed 0.1.10 (exit $status)" '[ $status -eq 0 ] && [ "$(receipt version)" = 0.1.10 ]'
for variant in "unsigned:$ROOT/rel/packs/0.1.11/opencode-console-linux-x64-0.1.11.tgz:isn't signed" \
  "other:$ROOT/rel/other-0.1.11.tgz:signature isn't" "swapped:$ROOT/rel/swapped-0.1.11.tgz:signature isn't"; do
  IFS=: read -r name file expected <<< "$variant"
  publish 0.1.11 "$file" "$name"
  "$DATA/cli/opencode-console" update > "$ROOT/update-$name.log" 2>&1; status=$?
  sed 's/^/    /' "$ROOT/update-$name.log"
  check "refuses 0.1.11 $name (exit $status), keeping 0.1.10" '[ $status -eq 1 ] && grep -q "$expected" "$ROOT/update-$name.log" && [ "$(receipt version)" = 0.1.10 ] && "$DATA/cli/opencode-console" help | head -1 | grep -q 0.1.10'
done
check "the refusals back the next attempt off" 'grep -q "\"attempts\": 3" "$DATA/auto-update.json"'
check "the hook still blocks rm -rf ./probe on 0.1.10" '[ "$(hook "rm -rf ./probe")" = 2 ]'

section "Release scripts as the workflow runs them, as dry runs"
export RUNNER_TEMP=$ROOT/runner GITHUB_STEP_SUMMARY=$ROOT/summary.md
mkdir -p "$RUNNER_TEMP/in/binaries" "$RUNNER_TEMP/in/build"
# The eleven platform tarballs: linux-x64's real one, and the rest with their real package.json shape.
cp "$ROOT/rel/packs/0.1.11/opencode-console-linux-x64-0.1.11.tgz" "$RUNNER_TEMP/in/binaries/"
. "$REPO/.github/release/lib.sh" 2>/dev/null; set +e
for target in $TARGETS; do
  [ "$target" = linux-x64 ] && continue
  dir=$(mktemp -d); mkdir -p "$dir/package/bin"
  IFS=- read -r os arch _ <<< "$target"
  exe=opencode-console; libc=; [ "$os" = windows ] && { os=win32; exe=opencode-console.exe; }
  [ "$os" = linux ] && libc=glibc; [[ "$target" == *-musl ]] && libc=musl
  printf 'binary' > "$dir/package/bin/$exe"; cp "$CLI/LICENSE" "$dir/package/LICENSE"
  [ "$os" = linux ] && head -c 64 /dev/zero > "$dir/package/bin/opencode-console.sig"
  jq -n --arg name "@opencode/console-$target" --arg os "$os" --arg cpu "$arch" --arg libc "$libc" \
    '{name: $name, version: "0.1.11", license: "MIT", os: [$os], cpu: [$cpu]} + (if $libc == "" then {} else {libc: [$libc]} end) + {publishConfig: {access: "public"}}' > "$dir/package/package.json"
  signed=; [ "$os" = linux ] && signed=signed
  repack_as "$dir" "$RUNNER_TEMP/in/binaries/opencode-console-$target-0.1.11.tgz" "$target" "$signed"
done
version 0.1.11 && bun run build >/dev/null && npm pack ./dist/npm --pack-destination "$RUNNER_TEMP/in/build" >/dev/null
digest=$(bash "$REPO/.github/release/write-checksums.sh" "$RUNNER_TEMP/in/binaries" 2>/dev/null)
bdigest=$(bash "$REPO/.github/release/write-checksums.sh" "$RUNNER_TEMP/in/build" 2>/dev/null)
check "verify-artifacts.sh accepts the artifacts by their job's digests" 'CONSOLE_DIGESTS="binaries=$digest build=$bdigest" bash "$REPO/.github/release/verify-artifacts.sh" "$RUNNER_TEMP/in" >/dev/null'
check "verify-artifacts.sh refuses another digest" '! CONSOLE_DIGESTS="binaries=$(printf %064d 0) build=$bdigest" bash "$REPO/.github/release/verify-artifacts.sh" "$RUNNER_TEMP/in" 2>/dev/null'
cp "$RUNNER_TEMP/in/binaries/SHA256SUMS" "$ROOT/sums"; printf 'x' >> "$RUNNER_TEMP/in/binaries/opencode-console-darwin-arm64-0.1.11.tgz"
check "verify-artifacts.sh refuses a tarball changed after its job" '! CONSOLE_DIGESTS="binaries=$digest build=$bdigest" bash "$REPO/.github/release/verify-artifacts.sh" "$RUNNER_TEMP/in" 2>/dev/null'
truncate -s -1 "$RUNNER_TEMP/in/binaries/opencode-console-darwin-arm64-0.1.11.tgz"
rm -f "$RUNNER_TEMP/in/binaries/SHA256SUMS" "$RUNNER_TEMP/in/build/SHA256SUMS"
check "verify-artifacts.sh refuses an artifact with a digest that didn't download" '! CONSOLE_DIGESTS="binaries=$digest build=$bdigest signed-linux=$digest" bash "$REPO/.github/release/verify-artifacts.sh" "$RUNNER_TEMP/in" 2>/dev/null'
mkdir -p "$RUNNER_TEMP/in/signed-linux"; cp "$ROOT/rel/signed/0.1.11/opencode-console-linux-x64-0.1.11.tgz" "$RUNNER_TEMP/in/signed-linux/"
# The publish scripts' dry runs sign in to the release service and npm with the job's OIDC token, which only a check
# run in environment release has, so only the refusals that come before signing in run here.
CONSOLE_VERSION=0.1.11 CONSOLE_CHANNEL=stable CONSOLE_DRY_RUN=true CONSOLE_REQUIRE_SIGNED=true NOTES_URL=https://example.test \
  bash "$REPO/.github/release/publish-release-service.sh" "$RUNNER_TEMP/in/binaries" "" "" "$RUNNER_TEMP/in/signed-linux" > "$ROOT/publish-unsigned.log" 2>&1; status=$?
check "a release that must be signed refuses to fall back to an unsigned tarball (exit $status)" '[ $status -ne 0 ] && grep -q "can.t fall back to the unsigned build" "$ROOT/publish-unsigned.log"'
CONSOLE_VERSION=0.1.11 CONSOLE_CHANNEL=dev CONSOLE_NPM_TAG='' CONSOLE_DRY_RUN=true \
  bash "$REPO/.github/release/publish-npm.sh" "$RUNNER_TEMP/in/build" "$RUNNER_TEMP/in/binaries" > /dev/null 2>&1; status=$?
check "publish-npm.sh refuses a dev build (exit $status)" '[ $status -ne 0 ]'

# plan-release.sh with `gh` standing in for the GitHub API it lists the tags from. The newest release tag is v98.9.9
# among refs that aren't releases, so the stable it plans, 98.9.10, isn't on the real npm it asks, unless a check names
# v0.1.7, whose next patch is.
mkdir -p "$ROOT/bin"
cat > "$ROOT/bin/gh" <<'GH'
#!/bin/sh
case "$*" in
  *matching-refs/tags/v*) printf '%s\n' $GH_TAGS ;;
esac
GH
chmod +x "$ROOT/bin/gh"
plan() { # <event> <ref> <channel> [bump] [tags]
  GITHUB_OUTPUT=$ROOT/plan.out GITHUB_EVENT_NAME=$1 GITHUB_REF=$2 INPUT_CHANNEL=$3 INPUT_BUMP=${4:-patch} \
    GH_TAGS=${5-"refs/tags/v0.1.8 refs/tags/v98.9.9 refs/tags/v99.0.0-beta.1 refs/tags/v099.0.0 refs/tags/vnext"} \
    GITHUB_REPOSITORY=anomalyco/opencode-console-cli GITHUB_SHA=abc GITHUB_RUN_NUMBER=142 GITHUB_RUN_ATTEMPT=1 \
    PATH="$ROOT/bin:$PATH" bash "$REPO/.github/release/plan-release.sh" 2>&1 | grep -E '^(mode|version|channel|npm_tag|dry_run)=' | tr '\n' ' '
}
check "a push to dev plans the next patch after the newest tag, 98.9.10-dev.142, for the release service only" '[ "$(plan push refs/heads/dev "")" = "mode=dev version=98.9.10-dev.142 channel=dev npm_tag= dry_run=false " ]'
check "a dev dispatch ignores the bump" '[ "$(plan workflow_dispatch refs/heads/dev dev major)" = "mode=dev version=98.9.10-dev.142 channel=dev npm_tag= dry_run=false " ]'
check "stable on dev bumps the patch by default, for npm latest" '[ "$(plan workflow_dispatch refs/heads/dev stable)" = "mode=stable version=98.9.10 channel=stable npm_tag=latest dry_run=false " ]'
check "stable on dev bumps the minor" '[ "$(plan workflow_dispatch refs/heads/dev stable minor)" = "mode=stable version=98.10.0 channel=stable npm_tag=latest dry_run=false " ]'
check "stable on dev bumps the major" '[ "$(plan workflow_dispatch refs/heads/dev stable major)" = "mode=stable version=99.0.0 channel=stable npm_tag=latest dry_run=false " ]'
check "stable is refused for a version npm already has" '[ -z "$(plan workflow_dispatch refs/heads/dev stable patch refs/tags/v0.1.7)" ]'
check "beta on dev plans 98.9.10-beta.142 for the release service only" '[ "$(plan workflow_dispatch refs/heads/dev beta)" = "mode=beta version=98.9.10-beta.142 channel=beta npm_tag= dry_run=false " ]'
check "check on dev plans a dry run of the stable" '[ "$(plan workflow_dispatch refs/heads/dev check)" = "mode=check version=98.9.10 channel=stable npm_tag=latest dry_run=true " ]'
check "stable from production is refused" '[ -z "$(plan workflow_dispatch refs/heads/production stable)" ]'
check "beta or check from another branch is refused" '[ -z "$(plan workflow_dispatch refs/heads/feature beta)" ] && [ -z "$(plan workflow_dispatch refs/heads/feature check)" ]'
check "an unknown bump is refused" '[ -z "$(plan workflow_dispatch refs/heads/dev stable huge)" ]'
check "with no release tag yet, a push to dev counts from npm's latest" '[[ "$(plan push refs/heads/dev "" patch "")" =~ ^mode=dev\ version=[0-9]+\.[0-9]+\.[0-9]+-dev\.142\ channel=dev ]]'

section "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
