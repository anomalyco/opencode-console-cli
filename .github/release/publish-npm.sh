#!/usr/bin/env bash
# publish-npm.sh <build dir> <binaries dir> [<signed dir>...]: publishes the platform packages @opencode/console-<target>
# (opencode-console-<target>-<version>.tgz: package/bin/opencode-console, and its .sig on Linux), then
# opencode-console-<version>.tgz (@opencode/console, the npx package), all with CONSOLE_NPM_TAG. Names, the version and
# the package set come from this script and the environment, never from the tarballs: each package.json is read as data
# and must match. Lifecycle scripts never run (--ignore-scripts). npm authenticates only with trusted publishing (OIDC),
# bound to .github/workflows/release.yml in environment release; there is no token, and an npm token in the
# environment fails the run. Every real publish carries --provenance, which npm accepts only from a public repository
# whose URL matches package.json's. A dry run (check) trades the job's OIDC token for each package's publish token as
# npm does, and fails unless npm grants it, but never makes a provenance statement or publishes. Ported from
# anomalyco/browse (publish-npm.sh, 2b6194cf).
. "$(dirname "$0")/lib.sh"

build_dir=$1 binaries_dir=$2
shift 2
signed=("$@")
[ -n "${CONSOLE_NPM_TAG:-}" ] || die "No npm dist-tag for channel ${CONSOLE_CHANNEL:-?}; only stable is published to npm"
[ "${CONSOLE_CHANNEL:-}" = stable ] || die "Only stable is published to npm, not ${CONSOLE_CHANNEL:-?}"
if [ -n "${NODE_AUTH_TOKEN:-}${NPM_TOKEN:-}" ]; then
  die "An npm token is set; this job publishes with trusted publishing only"
fi

check_package() { # <file> <name> [<os> <cpu> <libc or "">]
  local file=$1 name=$2 packed_name packed_version config scripts os cpu libc
  test -s "$file" || die "Missing $file"
  IFS=$'\t' read -r packed_name packed_version config scripts os cpu libc < <(tar -xzOf "$file" package/package.json |
    jq -r '[.name, .version, ((.publishConfig // {}) | keys - ["access"] | length > 0),
      ((.scripts // {}) | (has("preinstall") or has("install") or has("postinstall") or has("prepare"))),
      ((.os // []) | join(",")), ((.cpu // []) | join(",")), ((.libc // []) | join(","))] | @tsv')
  [ "$packed_name" = "$name" ] || die "$file is $packed_name, expected $name"
  [ "$packed_version" = "$CONSOLE_VERSION" ] || die "$file has version $packed_version, expected $CONSOLE_VERSION"
  [ "$config" = false ] || die "$file sets publishConfig beyond access"
  [ "$scripts" = false ] || die "$file has an install script"
  if [ $# -eq 2 ]; then return; fi
  [ "$os,$cpu,$libc" = "$3,$4,$5" ] || die "$file is for os $os cpu $cpu libc $libc, expected $3 $4 $5"
}

list=$(mktemp)
for target in $TARGETS; do
  IFS=- read -r os arch _ <<< "$target"
  executable=opencode-console libc=""
  case $os in
    windows) os=win32 executable=opencode-console.exe ;;
    linux) libc=glibc ;;
  esac
  if [[ "$target" == *-musl ]]; then libc=musl; fi
  file=$(target_file "$target" "$binaries_dir" "${signed[@]}")
  check_package "$file" "@opencode/console-$target" "$os" "$arch" "$libc"
  # Exactly the binary (executable), package.json and LICENSE, and a Linux binary's signature.
  entries=$(tar -tvzf "$file" | awk '{print $1, $NF}' | LC_ALL=C sort)
  expected=$(printf '%s\n' "-rw-r--r-- package/LICENSE" "-rw-r--r-- package/package.json" "-rwxr-xr-x package/bin/$executable" | LC_ALL=C sort)
  # Every run that reaches npm signed its Linux binaries with the release key, a check run's too.
  if [ "$os" = linux ]; then
    expected=$(printf '%s\n%s\n' "$expected" "-rw-r--r-- package/bin/opencode-console.sig" | LC_ALL=C sort)
  fi
  [ "$entries" = "$expected" ] || die "$file holds $entries"
  printf '%s\t%s\n' "@opencode/console-$target" "$file" >> "$list"
done
# @opencode/console goes last, once every binary of its version is on npm.
file="$build_dir/opencode-console-$CONSOLE_VERSION.tgz"
check_package "$file" @opencode/console
printf '%s\t%s\n' @opencode/console "$file" >> "$list"

# A clean directory and config, so nothing from an artifact can redirect the registry.
printf 'registry=https://registry.npmjs.org/\n' > "$RUNNER_TEMP/npmrc"
export NPM_CONFIG_USERCONFIG="$RUNNER_TEMP/npmrc"
cd "$(mktemp -d)" || exit

private=$(mktemp -d)
trap 'rm -rf "$private"' EXIT
# npm publish --dry-run goes on when its sign-in fails, so a dry run makes npm's own exchange here and fails without a
# token. The token it answers with publishes only that package, for minutes; it's checked for and deleted, never used.
trusted_publishing() { # <package name>
  local oidc status
  : "${ACTIONS_ID_TOKEN_REQUEST_URL:?Run in a GitHub Actions job with id-token: write}"
  : "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?Run in a GitHub Actions job with id-token: write}"
  oidc=$(curl -fsS --retry 3 -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
    "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=npm:registry.npmjs.org" | jq -er .value) ||
    die "Couldn't get a GitHub OIDC token for npm."
  printf '::add-mask::%s\n' "$oidc"
  printf 'header = "Authorization: Bearer %s"\n' "$oidc" > "$private/oidc.curl"
  status=$(curl -sS --retry 3 --config "$private/oidc.curl" -X POST -o "$private/exchange.json" -w '%{http_code}' \
    "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${1//\//%2f}") ||
    die "Couldn't reach npm to sign in for $1."
  case "$status" in
    2??) ;;
    *) die "npm trusted publishing refused this job for $1 (HTTP $status)." ;;
  esac
  jq -e '.token | type == "string" and length > 0' "$private/exchange.json" > /dev/null ||
    die "npm answered $1's sign-in without a token."
  rm -f "$private/oidc.curl" "$private/exchange.json"
  summary "npm trusted publishing admits this job for $1."
}

flags=(--tag "$CONSOLE_NPM_TAG" --access public --ignore-scripts)
if dry_run; then flags+=(--dry-run); else flags+=(--provenance); fi
while IFS=$'\t' read -r name file; do
  if dry_run; then trusted_publishing "$name"; fi
  # npm refuses a version it has, dry run or not. A rerun skips what it already published, but never different bytes
  # under the same version; a check run says so instead of stopping, since a release would bump the version first.
  published=$(npm view "$name@$CONSOLE_VERSION" dist.integrity 2> /dev/null || true)
  if [ -n "$published" ]; then
    if [ "$published" != "sha512-$(openssl dgst -sha512 -binary "$file" | openssl base64 -A)" ]; then
      message="$name@$CONSOLE_VERSION is on npm with other bytes ($published). Rerun the failed jobs of the original run, or bump the version."
      if ! dry_run; then die "$message"; fi
      echo "::warning::$message"
      summary "Would fail: $message"
      continue
    fi
    summary "$name@$CONSOLE_VERSION is already on npm; nothing to publish."
    continue
  fi
  npm publish "$file" "${flags[@]}"
  summary "$(dry_run && echo "Would publish" || echo "Published") $name@$CONSOLE_VERSION with dist-tag $CONSOLE_NPM_TAG."
done < "$list"
