# shellcheck shell=bash
# Shared helpers for the Console CLI's release scripts. Sourced, never executed. Ported from anomalyco/browse
# (.github/release/lib.sh, 2b6194cf) and anomalyco/hex (a65a5e37).
#
# .github/release/ and .github/workflows/publish-console-cli.yml are the security boundary for releases. Jobs that hold
# a secret, an OIDC token or a write token check out only this directory and run only these scripts, on artifacts they
# verify against the digest of the job that made them and treat as data: they never install dependencies or execute
# repository code or artifact contents. Every value that names a destination comes from the environment the workflow
# sets (CONSOLE_VERSION, CONSOLE_CHANNEL, CONSOLE_NPM_TAG, CONSOLE_DRY_RUN, ...).

set -euo pipefail
# macOS /bin/bash (sign-macos.sh) is 3.2, which lacks inherit_errexit.
if [ "${BASH_VERSINFO[0]}" -gt 4 ] || { [ "${BASH_VERSINFO[0]}" = 4 ] && [ "${BASH_VERSINFO[1]}" -ge 4 ]; }; then
  shopt -s inherit_errexit
fi

die() {
  echo "::error::$*" >&2
  exit 1
}

dry_run() {
  [ "${CONSOLE_DRY_RUN:-false}" = true ]
}

sha256() {
  if command -v sha256sum > /dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

summary() {
  printf '%s\n' "$@"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; fi
}

# Windows runners pass D:\a\_temp style paths; Git Bash tools want /d/a/_temp.
posix() {
  if command -v cygpath > /dev/null; then cygpath -u "$1"; else printf '%s' "$1"; fi
}

# A stable release version: x.y.z.
stable_version() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
}

# The eleven targets script/compile.ts builds, as npm names them; the release service says macos for darwin.
# CONSOLE_TARGETS narrows them for a run outside the workflow, which never sets it.
# shellcheck disable=SC2034 # read by the scripts that source this file
TARGETS=${CONSOLE_TARGETS:-"linux-x64 linux-x64-baseline linux-arm64 linux-x64-musl linux-x64-baseline-musl linux-arm64-musl darwin-arm64 darwin-x64 darwin-x64-baseline windows-x64 windows-x64-baseline"}

service_target() {
  case "$1" in
    darwin-*) printf '%s' "macos-${1#darwin-}" ;;
    *) printf '%s' "$1" ;;
  esac
}

tarball_name() { # <target>
  printf '%s' "opencode-console-$1-$CONSOLE_VERSION.tgz"
}

# target_file <target> <binaries dir> [<signed dir>...]: the tarball to publish for a target: the last signed one,
# else the build's own. With CONSOLE_REQUIRE_SIGNED=true (every run but dev), only a signed one.
target_file() {
  local target=$1 file signed=false
  shift
  file="$1/$(tarball_name "$target")"
  shift
  for dir in "$@"; do
    if [ -n "$dir" ] && [ -f "$dir/$(tarball_name "$target")" ]; then file="$dir/$(tarball_name "$target")" signed=true; fi
  done
  if [ "${CONSOLE_REQUIRE_SIGNED:-false}" = true ] && [ "$signed" != true ]; then
    die "No signed $(tarball_name "$target"); this release can't fall back to the unsigned build"
  fi
  printf '%s' "$file"
}

# release_client <out>: downloads the release service's client (https://anoma.ly/release/client.sh) to <out> and checks
# it against the SHA-256 pinned in client.sh.sha256 before anything runs it, so a change to the served client can't run
# in a job holding an OIDC token until a reviewed change here pins it. RELEASING.md says how to move the pin.
release_client() {
  local out=$1 pinned actual
  pinned=$(tr -d ' \n' < "$(dirname "${BASH_SOURCE[0]}")/client.sh.sha256")
  curl -fsSL --retry 5 --retry-all-errors "${RELEASE_ORIGIN:-https://anoma.ly/release}/client.sh" -o "$out"
  actual=$(sha256 "$out" | cut -c1-64)
  [ "$actual" = "$pinned" ] || die "The release service's client.sh has SHA-256 $actual, not the pinned $pinned (.github/release/client.sh.sha256)."
}

# members <target> [signed]: the files a target's tarball holds, as npm pack lays them out and in the order repack writes
# them: LICENSE, the binary (opencode-console.exe on Windows), with "signed" the Linux binary's .sig, and package.json.
members() {
  local executable=opencode-console
  case "$1" in windows-*) executable=opencode-console.exe ;; esac
  if [ "${2:-}" = signed ]; then
    printf '%s' "package/LICENSE package/bin/$executable package/bin/$executable.sig package/package.json"
  else
    printf '%s' "package/LICENSE package/bin/$executable package/package.json"
  fi
}

# unpack <tarball> <dir> <member>...: extracts a tarball that holds exactly <member>..., each once and each a regular
# file, into <dir>. Anything else (a directory, a link, a duplicate, an extra entry, a name with a newline, which lists as
# two lines or escaped and so never matches) fails the run before a byte of it is written.
unpack() {
  local file=$1 dir=$2 names expected member
  shift 2
  names=$(tar -tzf "$file") || die "$file is not a gzipped tarball."
  expected=$(printf '%s\n' "$@" | LC_ALL=C sort)
  [ "$(printf '%s\n' "$names" | LC_ALL=C sort)" = "$expected" ] ||
    die "$file must hold exactly $*, and holds: $(printf '%s' "$names" | tr '\n' ' ')"
  # Every entry a regular file: GNU tar and bsdtar list one with a leading "-" and no "link to" or "->" after it.
  while IFS= read -r line; do
    case "$line" in -*) ;; *) die "$file has an entry that isn't a regular file: $line" ;; esac
    case "$line" in *" link to "* | *" -> "*) die "$file has a link: $line" ;; esac
  done < <(tar -tvzf "$file")
  mkdir -p "$dir"
  tar -xzf "$file" -C "$dir" -- "$@"
  for member in "$@"; do
    [ -f "$dir/$member" ] && [ ! -L "$dir/$member" ] || die "$file's $member didn't unpack as a regular file."
  done
}

# repack <work dir> <out tarball> <member>...: packs exactly <member>... from <work dir> as npm pack lays them out
# (files only, root-owned, fixed mtime, the binary 0755 and the rest 0644), so publish-npm.sh's listing check holds for
# a re-signed tarball. The names are the caller's fixed list, never read back from the unpacked tree.
repack() {
  local work=$1 out=$2 member
  shift 2
  for member in "$@"; do
    [ -f "$work/$member" ] && [ ! -L "$work/$member" ] || die "$work/$member is not a regular file."
    case "$member" in
      package/bin/*.sig | package/LICENSE | package/package.json) chmod 644 "$work/$member" ;;
      package/bin/*) chmod 755 "$work/$member" ;;
      *) die "repack doesn't pack $member." ;;
    esac
    touch -t 198001010000 "$work/$member"
  done
  if tar --version 2> /dev/null | grep -q GNU; then
    tar --owner 0 --group 0 --numeric-owner -czf "$out" -C "$work" -- "$@"
  else
    COPYFILE_DISABLE=1 tar --no-mac-metadata --uid 0 --gid 0 -czf "$out" -C "$work" -- "$@"
  fi
}
