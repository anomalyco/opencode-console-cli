#!/usr/bin/env bash
# plan-release.sh: decides the mode, version, channel and npm dist-tag from the event, the ref and the dispatch inputs
# (INPUT_CHANNEL, INPUT_REQUIRED, INPUT_ROLLOUT), and writes them to $GITHUB_OUTPUT. It reads package.json of the
# triggering commit through the API, as data; nothing here runs repository code. Ported from anomalyco/browse
# (.github/release/plan-release.sh, 2b6194cf).
#
#   push to dev, or dispatch dev on dev       dev     <version>-dev.<run>[.<attempt>]     the release service only;
#                                                     <next patch> once <version> is on npm
#   dispatch beta on production               beta    <version>-beta.<run>[.<attempt>]    release service, npm beta
#   dispatch stable on production             stable  package.json's x.y.z                release service, npm latest,
#                                                                                         tag v<version>
#   dispatch check, on any branch             check   package.json's x.y.z                builds, signs what it can,
#                                                                                         publishes nothing
# Stable and beta need a repository admin or maintainer.
. "$(dirname "$0")/lib.sh"

channel_input=${INPUT_CHANNEL:-check}
case "$GITHUB_EVENT_NAME:$GITHUB_REF:$channel_input" in
  push:refs/heads/dev:* | workflow_dispatch:refs/heads/dev:dev) mode=dev ;;
  workflow_dispatch:refs/heads/production:stable) mode=stable ;;
  workflow_dispatch:refs/heads/production:beta) mode=beta ;;
  workflow_dispatch:*:check) mode=check ;;
  *) die "$GITHUB_EVENT_NAME on $GITHUB_REF can't publish channel $channel_input: dev publishes from dev, stable and beta from production" ;;
esac

current=$(gh api -H "Accept: application/vnd.github.raw" "repos/$GITHUB_REPOSITORY/contents/package.json?ref=$GITHUB_SHA" | jq -r .version)
stable_version "$current" || die "package.json at $GITHUB_SHA has version $current, not a stable x.y.z"
IFS=. read -r major minor patch <<< "$current"
run=$GITHUB_RUN_NUMBER
if [ "${GITHUB_RUN_ATTEMPT:-1}" != 1 ]; then run="$run.$GITHUB_RUN_ATTEMPT"; fi

if [ "$mode" = stable ] || [ "$mode" = beta ]; then
  actor=${GITHUB_TRIGGERING_ACTOR:-${GITHUB_ACTOR:-}}
  [ -n "$actor" ] || die "Stable and beta releases can only be started by repository admins or maintainers; the triggering actor is unknown"
  role=$(gh api "repos/$GITHUB_REPOSITORY/collaborators/$actor/permission" --jq .role_name 2> /dev/null) || role=""
  case "$role" in
    admin | maintain) ;;
    *) die "Stable and beta releases can only be started by repository admins or maintainers; $actor has ${role:-no readable role}" ;;
  esac
fi

rollout=${INPUT_ROLLOUT:-100}
[[ "$rollout" =~ ^([0-9]|[1-9][0-9]|100)$ ]] || die "rollout_percent must be 0 to 100, not $rollout"
required=${INPUT_REQUIRED:-false}
[ "$required" = true ] || required=false

case "$mode" in
  dev)
    # A dev build precedes the release package.json names, until that's on npm, then the one after it.
    status=$(curl -sS -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/@opencode%2fconsole/$current")
    case "$status" in
      404) version="$current-dev.$run" ;;
      200) version="$major.$minor.$((patch + 1))-dev.$run" ;;
      *) die "npm answered $status for @opencode/console@$current, so it's unknown which release this dev build precedes" ;;
    esac
    channel=dev npm_tag="" dry_run=false rollout=100 required=false
    ;;
  beta)
    version="$current-beta.$run"
    channel=beta npm_tag=beta dry_run=false
    ;;
  stable)
    version=$current
    status=$(curl -sS -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/@opencode%2fconsole/$version")
    [ "$status" = 404 ] || die "@opencode/console@$version is already on npm (or npm answered $status). Bump package.json."
    channel=stable npm_tag=latest dry_run=false
    ;;
  check)
    version=$current
    channel=stable npm_tag=latest dry_run=true
    ;;
esac

{
  echo "mode=$mode"
  echo "version=$version"
  echo "channel=$channel"
  echo "npm_tag=$npm_tag"
  echo "dry_run=$dry_run"
  echo "rollout=$rollout"
  echo "required=$required"
} | tee -a "$GITHUB_OUTPUT"
summary "Console CLI $version ($mode: channel $channel, npm dist-tag ${npm_tag:-none}, rollout $rollout%, required $required, dry run $dry_run) from $GITHUB_SHA"
