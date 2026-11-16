#!/usr/bin/env bash
# verify-artifacts.sh <dir>: checks every artifact downloaded into <dir>/<name> against its SHA256SUMS, that it holds
# exactly the listed files, and that its SHA256SUMS has the digest the job that made it reported
# (CONSOLE_DIGESTS="name=digest ..."), so an artifact replaced after that job finished is rejected. Every name listed
# must carry a digest and must have downloaded, so a producer that reported nothing fails the run instead of being
# skipped; the workflow lists only the artifacts its run makes. A dry run checks exactly what a release does.
. "$(dirname "$0")/lib.sh"

for pair in ${CONSOLE_DIGESTS:-}; do
  [[ "$pair" =~ ^[a-z][a-z0-9-]*=[0-9a-f]{64}$ ]] || die "Not a name=digest pair from the job that made it: $pair"
done
found=false
for dir in "$1"/*/; do
  found=true
  name=$(basename "$dir")
  digest=""
  for pair in ${CONSOLE_DIGESTS:-}; do
    if [ "${pair%%=*}" = "$name" ]; then digest=${pair#*=}; fi
  done
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die "Missing digest for $name"
  (
    cd "$dir" || exit
    [ "$(sha256 SHA256SUMS | cut -c1-64)" = "$digest" ] || die "SHA256SUMS digest mismatch in $name"
    sha256 -c --quiet SHA256SUMS || die "Checksum mismatch in $name"
    diff <(find . -type f ! -name SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort) <(cut -c67- SHA256SUMS | LC_ALL=C sort) ||
      die "Unexpected files in $name"
  )
  echo "verified $name ($digest)"
done
[ "$found" = true ] || die "No artifacts in $1"
# Every artifact listed must have arrived, so a missing signed one can't fall back to unsigned.
for pair in ${CONSOLE_DIGESTS:-}; do
  [ -d "$1/${pair%%=*}" ] || die "${pair%%=*} has a digest but didn't download"
done
