#!/usr/bin/env bash
# tag-release.sh: tags refs/tags/v$CONSOLE_VERSION at $SHA once a stable release has published, so a failed run never
# spends a version. Creates it through the API; when it already exists, resolves it, peeling annotated tags, and fails
# unless it's $SHA. A rerun of the same run finds its own tag and goes on.
#
# Environment: CONSOLE_VERSION, SHA, GH_REPO, GH_TOKEN (contents: write).
. "$(dirname "$0")/lib.sh"

: "${CONSOLE_VERSION:?Set CONSOLE_VERSION}" "${SHA:?Set SHA}" "${GH_REPO:?Set GH_REPO}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "SHA must be a full commit SHA, not $SHA"
tag="v$CONSOLE_VERSION"

if gh api -X POST "repos/$GH_REPO/git/refs" -f "ref=refs/tags/$tag" -f "sha=$SHA" > /dev/null 2>&1; then
  summary "Tagged $tag at $SHA."
  exit 0
fi

# It exists, or the API refused for another reason, which reading it back tells apart.
ref=$(gh api "repos/$GH_REPO/git/ref/tags/$tag") || die "Couldn't create $tag, and it doesn't exist."
type=$(jq -r .object.type <<< "$ref") object=$(jq -r .object.sha <<< "$ref")
for _ in 1 2 3 4 5 6 7 8; do
  [ "$type" = tag ] || break
  peeled=$(gh api "repos/$GH_REPO/git/tags/$object")
  type=$(jq -r .object.type <<< "$peeled") object=$(jq -r .object.sha <<< "$peeled")
done
[ "$type" = commit ] || die "$tag points at a $type, not a commit."
[ "$object" = "$SHA" ] || die "$tag already points at $object, not this run's $SHA, though this run published $CONSOLE_VERSION. Delete the tag if it was made by mistake and rerun this job."
summary "$tag is already at $SHA; this run goes on."
