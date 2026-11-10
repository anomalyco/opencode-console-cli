#!/usr/bin/env bash
# export-env.sh <name>...: appends each named variable of this step's environment to $GITHUB_ENV, multiline values
# included, so the job's later steps see it as the secrets manager's GitHub action would leave it. Unset or empty
# names are skipped, which the job's "Require" step reports. Prints nothing secret.
. "$(dirname "$0")/lib.sh"

for name in "$@"; do
  value=$(printenv "$name" || true)
  [ -n "$value" ] || continue
  delimiter="EOF_${RANDOM}${RANDOM}${RANDOM}${RANDOM}"
  case "$value" in *"$delimiter"*) die "$name contains its own delimiter." ;; esac
  printf '%s<<%s\n%s\n%s\n' "$name" "$delimiter" "$value" "$delimiter" >> "$GITHUB_ENV"
done
