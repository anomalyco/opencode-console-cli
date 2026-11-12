#!/usr/bin/env bash
# sign-linux.sh <binaries dir> <out dir>: signs each Linux binary inside its tarball with Anomaly's ed25519 release key,
# CONSOLE_CLI_RELEASE_SIGNING_KEY (PEM, from with-secrets.sh), writing the raw 64-byte signature beside it as package/bin/opencode-console.sig,
# and writes the repacked tarballs to <out dir>. The signed message is
#   "anomaly.opencode-console.linux-artifact.v1\n<sha256 of the binary>\n"
# The updater (src/update/signature.ts) verifies it with the public key in linux-signing.pub, which this
# script checks every signature against first, so a mismatched key fails the run before anything publishes. Ported
# from anomalyco/hex (.github/release/sign-linux.sh, a65a5e37).
. "$(dirname "$0")/lib.sh"

in=$(posix "$1") out=$(posix "$2")
release=$(cd "$(dirname "$0")" && pwd)
: "${CONSOLE_VERSION:?Set CONSOLE_VERSION}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"
public="$release/linux-signing.pub"
if dry_run; then
  # A check run has no secrets: it signs with a throwaway key, so everything after signing still runs.
  openssl genpkey -algorithm Ed25519 -out "$work/key.pem" 2> /dev/null
  openssl pkey -in "$work/key.pem" -pubout -out "$work/key.pub"
  public="$work/key.pub"
  echo "Dry run: signing with a throwaway key, not CONSOLE_CLI_RELEASE_SIGNING_KEY."
else
  : "${CONSOLE_CLI_RELEASE_SIGNING_KEY:?Set CONSOLE_CLI_RELEASE_SIGNING_KEY}"
  (umask 077 && printf '%s\n' "$CONSOLE_CLI_RELEASE_SIGNING_KEY" > "$work/key.pem")
fi
for target in $TARGETS; do
  case "$target" in linux-*) ;; *) continue ;; esac
  file="$in/$(tarball_name "$target")"
  test -s "$file" || die "Missing $file"
  read -ra unsigned <<< "$(members "$target")"
  unpack "$file" "$work/$target" "${unsigned[@]}"
  bin="$work/$target/package/bin/opencode-console"
  sha=$(sha256 "$bin" | cut -c1-64)
  printf 'anomaly.opencode-console.linux-artifact.v1\n%s\n' "$sha" > "$work/message"
  openssl pkeyutl -sign -rawin -inkey "$work/key.pem" -in "$work/message" -out "$bin.sig" ||
    die "Could not sign $target with CONSOLE_CLI_RELEASE_SIGNING_KEY."
  [ "$(wc -c < "$bin.sig" | tr -d ' ')" = 64 ] || die "The signature of $target is not 64 bytes."
  openssl pkeyutl -verify -rawin -pubin -inkey "$public" \
    -in "$work/message" -sigfile "$bin.sig" > /dev/null ||
    die "CONSOLE_CLI_RELEASE_SIGNING_KEY does not match linux-signing.pub, the key the updater trusts."
  read -ra signed <<< "$(members "$target" signed)"
  repack "$work/$target" "$out/$(tarball_name "$target")" "${signed[@]}"
  echo "Signed $target ($sha)."
done
