#!/usr/bin/env bash
# plan-release.sh: decides the mode, version, channel and npm dist-tag from the event, the ref, the dispatch inputs
# (INPUT_CHANNEL, INPUT_BUMP, INPUT_REQUIRED, INPUT_ROLLOUT) and the latest vX.Y.Z tag, and writes them to
# $GITHUB_OUTPUT. Nothing here reads repository files or runs repository code; package.json's version is ignored and
# the build stamps the planned one. Ported from anomalyco/browse (.github/release/plan-release.sh, 2b6194cf) and
# anomalyco/opencode (.github/release/plan-release.sh).
#
#   push to dev, or dispatch dev on dev    dev     <latest + patch>-dev.<run>[.<attempt>]    the release service only
#   dispatch beta on dev                   beta    <latest + bump>-beta.<run>[.<attempt>]    the release service only
#   dispatch stable on dev                 stable  <latest + bump>                           release service, npm latest,
#                                                                                            then tag v<version>
#   dispatch check, on any branch          check   <latest + bump>                           builds, signs with throwaway
#                                                                                            keys, publishes nothing
# <latest> is the highest vX.Y.Z tag, and bump is patch (the default), minor or major. Until the first tag exists, npm's
# latest @opencode/console stands in for it.
. "$(dirname "$0")/lib.sh"

channel_input=${INPUT_CHANNEL:-check}
case "$GITHUB_EVENT_NAME:$GITHUB_REF:$channel_input" in
  push:refs/heads/dev:* | workflow_dispatch:refs/heads/dev:dev) mode=dev ;;
  workflow_dispatch:refs/heads/dev:stable) mode=stable ;;
  workflow_dispatch:refs/heads/dev:beta) mode=beta ;;
  workflow_dispatch:*:check) mode=check ;;
  *) die "$GITHUB_EVENT_NAME on $GITHUB_REF can't publish channel $channel_input: dev, beta and stable publish from dev only" ;;
esac

bump=${INPUT_BUMP:-patch}
case "$bump" in
  patch | minor | major) ;;
  *) die "bump must be patch, minor or major, not $bump" ;;
esac

refs=$(gh api --paginate "repos/$GITHUB_REPOSITORY/git/matching-refs/tags/v" --jq '.[].ref')
tags=""
while IFS= read -r ref; do
  if stable_version "${ref#refs/tags/v}" && [ "$ref" = "refs/tags/v${ref#refs/tags/v}" ]; then
    tags="$tags${ref#refs/tags/v}"$'\n'
  fi
done <<< "$refs"
latest=$(printf '%s' "$tags" | LC_ALL=C sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
if [ -z "$latest" ]; then
  latest=$(curl -fsS --retry 3 https://registry.npmjs.org/-/package/@opencode%2fconsole/dist-tags | jq -r .latest)
  stable_version "$latest" || die "No vX.Y.Z tag, and npm's latest @opencode/console is $latest, not a stable x.y.z"
  summary "No vX.Y.Z tag yet: counting from npm's latest @opencode/console, $latest."
fi
IFS=. read -r major minor patch <<< "$latest"
case "$bump" in
  major) next="$((major + 1)).0.0" ;;
  minor) next="$major.$((minor + 1)).0" ;;
  patch) next="$major.$minor.$((patch + 1))" ;;
esac
run=$GITHUB_RUN_NUMBER
if [ "${GITHUB_RUN_ATTEMPT:-1}" != 1 ]; then run="$run.$GITHUB_RUN_ATTEMPT"; fi

rollout=${INPUT_ROLLOUT:-100}
[[ "$rollout" =~ ^([0-9]|[1-9][0-9]|100)$ ]] || die "rollout_percent must be 0 to 100, not $rollout"
required=${INPUT_REQUIRED:-false}
[ "$required" = true ] || required=false

case "$mode" in
  dev)
    # Dev builds always precede the next patch, so a dispatch's bump can't put one ahead of the pushes after it.
    version="$major.$minor.$((patch + 1))-dev.$run"
    channel=dev npm_tag="" dry_run=false rollout=100 required=false
    ;;
  beta)
    version="$next-beta.$run"
    channel=beta npm_tag="" dry_run=false
    ;;
  stable)
    version=$next
    status=$(curl -sS -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/@opencode%2fconsole/$version")
    [ "$status" = 404 ] || die "@opencode/console@$version is already on npm (or npm answered $status), but v$version isn't tagged. Rerun the failed jobs of the run that published it."
    channel=stable npm_tag=latest dry_run=false
    ;;
  check)
    version=$next
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
summary "Console CLI $version ($mode from v$latest, bump $bump: channel $channel, npm dist-tag ${npm_tag:-none}, rollout $rollout%, required $required, dry run $dry_run) from $GITHUB_SHA"
