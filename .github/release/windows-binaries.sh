#!/usr/bin/env bash
# windows-binaries.sh unpack <binaries dir> <work dir> | repack <work dir> <out dir>: takes the Windows binaries out of
# their tarballs as <work>/sign/opencode-console-<target>.exe for Azure Artifact Signing, then puts the signed ones back
# and repacks the tarballs. Runs in Git Bash on the Windows runner; the binaries are data.
. "$(dirname "$0")/lib.sh"

action=$1
for target in windows-x64 windows-x64-baseline; do
  read -ra files <<< "$(members "$target")"
  case "$action" in
    unpack)
      in=$(posix "$2") work=$(posix "$3")
      mkdir -p "$work/sign"
      unpack "$in/$(tarball_name "$target")" "$work/$target" "${files[@]}"
      cp "$work/$target/package/bin/opencode-console.exe" "$work/sign/opencode-console-$target.exe"
      ;;
    repack)
      work=$(posix "$2") out=$(posix "$3")
      mkdir -p "$out"
      cp "$work/sign/opencode-console-$target.exe" "$work/$target/package/bin/opencode-console.exe"
      repack "$work/$target" "$out/$(tarball_name "$target")" "${files[@]}"
      echo "Signed $(tarball_name "$target")."
      ;;
    *) die "Usage: windows-binaries.sh unpack <binaries> <work> | repack <work> <out>" ;;
  esac
done
