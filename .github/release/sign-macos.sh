#!/usr/bin/env bash
# sign-macos.sh <binaries dir> <out dir>: signs the three macOS binaries inside their tarballs with the Developer ID
# (hardened runtime, secure timestamp, entitlements/cli.plist: Bun's JIT needs allow-jit and unsigned executable
# memory, identifier anomaly.opencode-console), notarizes all three in one submission, checks each against
# macos-requirement.txt (the requirement the updater holds a stable update to) and writes the repacked tarballs to
# <out dir>. A bare Mach-O can't have a ticket stapled, so the final check asks Apple for the ticket online
# (--check-notarization), as the updater does. A dry run (check) signs ad hoc under the same identifier and stops before
# notarizing, so everything after signing still runs. The binaries are data here: they are never run.
#
# Ported from anomalyco/browse (sign-macos.sh, 2b6194cf) and anomalyco/hex (sign-macos.sh, a65a5e37). Environment:
# CONSOLE_VERSION, CONSOLE_SIGNING_IDENTITY, CONSOLE_KEYCHAIN, CONSOLE_NOTARY_KEY, CONSOLE_NOTARY_KEY_ID,
# CONSOLE_NOTARY_ISSUER (macos-credentials.sh).
. "$(dirname "$0")/lib.sh"

in=$1 out=$2
release=$(cd "$(dirname "$0")" && pwd)
requirement=$(cat "$release/macos-requirement.txt")
# Notarization comes after signing, so the first check leaves it out.
signed_requirement=${requirement% and notarized}
[ "$signed_requirement" != "$requirement" ] || die "macos-requirement.txt must end with 'and notarized'."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out" "$work/notarize"
export COPYFILE_DISABLE=1

for target in darwin-arm64 darwin-x64 darwin-x64-baseline; do
  file="$in/$(tarball_name "$target")"
  test -s "$file" || die "Missing $file"
  read -ra files <<< "$(members "$target")"
  unpack "$file" "$work/$target" "${files[@]}"
  bin="$work/$target/package/bin/opencode-console"
  file -b "$bin" | grep -q '^Mach-O' || die "$target is not a Mach-O binary"
  if dry_run; then
    codesign --force --options runtime --entitlements "$release/entitlements/cli.plist" \
      --identifier anomaly.opencode-console --sign - "$bin"
    codesign --verify --strict --verbose=2 -R='identifier "anomaly.opencode-console"' "$bin"
    repack "$work/$target" "$out/$(tarball_name "$target")" "${files[@]}"
    echo "Dry run: signed $(tarball_name "$target") ad hoc."
    continue
  fi
  codesign --force --timestamp --options runtime --entitlements "$release/entitlements/cli.plist" \
    --identifier anomaly.opencode-console --keychain "$CONSOLE_KEYCHAIN" --sign "$CONSOLE_SIGNING_IDENTITY" "$bin"
  codesign --verify --strict --verbose=2 -R="$signed_requirement" "$bin"
  cp "$bin" "$work/notarize/opencode-console-$target"
done
if dry_run; then exit 0; fi

/usr/bin/ditto -c -k --keepParent "$work/notarize" "$work/notarize.zip"
xcrun notarytool submit "$work/notarize.zip" --key "$CONSOLE_NOTARY_KEY" --key-id "$CONSOLE_NOTARY_KEY_ID" \
  --issuer "$CONSOLE_NOTARY_ISSUER" --wait --timeout 45m

for target in darwin-arm64 darwin-x64 darwin-x64-baseline; do
  bin="$work/$target/package/bin/opencode-console"
  # Apple may take a moment to serve a new ticket.
  for attempt in 1 2 3 4 5 6; do
    codesign --verify --strict --check-notarization --verbose=2 -R="$requirement" "$bin" && break
    [ "$attempt" -lt 6 ] || die "$target doesn't satisfy macos-requirement.txt after notarization."
    sleep 20
  done
  repack "$work/$target" "$out/$(tarball_name "$target")" "${files[@]}"
  echo "Signed and notarized $(tarball_name "$target")."
done
