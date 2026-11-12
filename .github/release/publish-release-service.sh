#!/usr/bin/env bash
# publish-release-service.sh <binaries dir> [<signed dir>...]: publishes this run's eleven binaries to Anomaly's release
# service, https://anoma.ly/release, as app opencode-console, artifact cli,
# through its shared client: a one-hour publish session from the job's GitHub OIDC token (no secrets),
# content-addressed uploads, retries, and a check of every published file (--verify-downloads). The service admits
# this workflow in environment release at refs/heads/dev, for every channel (the service's registry entry for
# opencode-console names this repository, .github/workflows/release.yml, refs/heads/dev and environment release).
#
# A signed tarball (sign-macos.sh, sign-windows, sign-linux.sh) replaces the build's own of the same name. Publishing
# the version the channel already has succeeds only when the service has exactly these files, so a rerun is safe. A dry
# run (check) checks the pinned client, trades the job's OIDC token for a publish session as the client does, so the
# service's admission of this job is proven, and prints what it would publish: it uploads and publishes nothing. Ported
# from anomalyco/browse (publish-release-service.sh, 2b6194cf).
. "$(dirname "$0")/lib.sh"

release=${CONSOLE_RELEASE_SERVICE:-https://anoma.ly/release}
release=${release%/}
binaries_dir=$1
shift
signed=("$@")
: "${NOTES_URL:?Set NOTES_URL}"
case "$CONSOLE_CHANNEL" in
  dev | beta | stable) ;;
  *) die "Unknown channel $CONSOLE_CHANNEL" ;;
esac
[[ "$CONSOLE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "Not a release version: $CONSOLE_VERSION"
if [ "$CONSOLE_CHANNEL" = stable ]; then stable_version "$CONSOLE_VERSION" || die "Not a stable version: $CONSOLE_VERSION"; fi
rollout=${CONSOLE_ROLLOUT:-100}
required=${CONSOLE_REQUIRED:-false}

set --
for target in $TARGETS; do
  file=$(target_file "$target" "$binaries_dir" "${signed[@]}")
  test -s "$file" || die "Missing $file"
  set -- "$@" --target "$(service_target "$target")=$file"
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
RELEASE_ORIGIN=$release release_client "$work/client.sh"

if dry_run; then
  : "${ACTIONS_ID_TOKEN_REQUEST_URL:?Run in a GitHub Actions job with id-token: write}"
  : "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?Run in a GitHub Actions job with id-token: write}"
  # The tokens stay in a curl config file, never in argv or the log; the session is discarded unused.
  (
    umask 077
    oidc=$(curl -fsS --retry 3 -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
      "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$release" | jq -er .value) || die "Couldn't get a GitHub OIDC token for $release."
    printf '::add-mask::%s\n' "$oidc"
    printf 'header = "Authorization: Bearer %s"\n' "$oidc" > "$work/session.curl"
    status=$(curl -sS --retry 3 --config "$work/session.curl" -H 'content-type: application/json' -o "$work/session.json" \
      -w '%{http_code}' -d "$(jq -cn --arg channel "$CONSOLE_CHANNEL" '{artifact: "cli", channel: $channel}')" \
      "$release/opencode-console/sessions") || die "Couldn't reach $release for a publish session."
    case "$status" in 2??) ;; *) die "The release service refused this job a publish session (HTTP $status): $(head -c 300 "$work/session.json")" ;; esac
    jq -e '.token | type == "string" and length > 0' "$work/session.json" > /dev/null ||
      die "The release service answered without a publish session."
    rm -f "$work/session.curl" "$work/session.json"
  )
  summary "### Release service (dry run)" "" \
    "The service admits this job for opencode-console/cli/$CONSOLE_CHANNEL." \
    "Would publish $CONSOLE_VERSION to $release/opencode-console/cli/$CONSOLE_CHANNEL.json (rollout $rollout%, required $required):"
  for target in $TARGETS; do
    summary "- $(service_target "$target") $(target_file "$target" "$binaries_dir" "${signed[@]}" | sed "s|^$RUNNER_TEMP/in/||")"
  done
  exit 0
fi
# npm's copy is recorded once it's on npm (publish-npm.sh); only stable is published there.
distributions='[{"kind":"direct"}]'
if [ -n "${CONSOLE_NPM_TAG:-}" ]; then
  distributions='[{"kind":"direct"},{"kind":"npm","command":"npx @opencode/console@'"$CONSOLE_NPM_TAG"' setup <agent>"}]'
fi
jq -n --arg channel "$CONSOLE_CHANNEL" --arg version "$CONSOLE_VERSION" --arg notes_url "$NOTES_URL" \
  --argjson rollout "$rollout" --argjson required "$required" --argjson distributions "$distributions" \
  '{channel: $channel, version: $version, notes_url: $notes_url, rollout_percent: $rollout, required: $required,
    distributions: $distributions}' > "$work/release.json"
RELEASE=$release bash "$work/client.sh" publish --app opencode-console --artifact cli --release "$work/release.json" \
  "$@" --out "$work/manifest.json" --verify-downloads

summary "### Release service ($CONSOLE_CHANNEL)" "" "- $release/opencode-console/cli/$CONSOLE_CHANNEL.json" \
  '```json' "$(cat "$work/manifest.json")" '```'
