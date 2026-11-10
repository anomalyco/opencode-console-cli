#!/usr/bin/env bash
# publish-release-service.sh <binaries dir> [<signed dir>...]: publishes this run's eleven binaries to Anomaly's release
# service, https://anoma.ly/release, as app opencode-console, artifact cli,
# through its shared client: a one-hour publish session from the job's GitHub OIDC token (no secrets),
# content-addressed uploads, retries, and a check of every published file (--verify-downloads). The service admits
# this workflow in environment release: refs/heads/dev for channel dev, refs/heads/production for stable and beta
# (the service's registry entry for opencode-console names this repository, workflow and environment).
#
# A signed tarball (sign-macos.sh, sign-windows, sign-linux.sh) replaces the build's own of the same name. Publishing
# the version the channel already has succeeds only when the service has exactly these files, so a rerun is safe. A dry
# run prints what it would publish. Ported from anomalyco/browse (publish-release-service.sh, 2b6194cf).
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

if dry_run; then
  summary "### Release service (dry run)" "" \
    "Would publish $CONSOLE_VERSION to $release/opencode-console/cli/$CONSOLE_CHANNEL.json (rollout $rollout%, required $required):"
  for target in $TARGETS; do
    summary "- $(service_target "$target") $(target_file "$target" "$binaries_dir" "${signed[@]}" | sed "s|^$RUNNER_TEMP/in/||")"
  done
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL --retry 5 --retry-all-errors "$release/client.sh" -o "$work/client.sh"
# npm's copy is recorded once it's on npm (publish-npm.sh); dev builds aren't published there.
distributions='[{"kind":"direct"}]'
if [ "$CONSOLE_CHANNEL" != dev ]; then
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
