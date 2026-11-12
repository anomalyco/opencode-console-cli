#!/usr/bin/env bash
# with-secrets.sh NAME=secret-id... -- <command>...: reads each named secret from AWS Secrets Manager with this step's
# AWS_* credentials, masks every line of it, and runs <command> with the secrets in its environment and the AWS
# credentials removed. The values never reach another step or $GITHUB_ENV. Every run that signs, a check run included,
# reads the real secrets. Ported from anomalyco/opencode (.github/release/with-secrets.sh).
. "$(dirname "$0")/lib.sh"
set +x
while [[ $# -gt 0 && $1 != -- ]]; do
  name=${1%%=*} id=${1#*=}
  [[ $name =~ ^[A-Z][A-Z0-9_]*$ && $id != "$1" && -n $id ]] || die 'Expected NAME=secret-id'
  value=$(aws secretsmanager get-secret-value --region us-east-1 --secret-id "$id" --query SecretString --output text)
  [[ -n $value && $value != None ]] || die "Empty secret: $id"
  while IFS= read -r line; do
    [[ -z $line ]] || printf '::add-mask::%s\n' "${line//%/%25}"
  done <<< "$value"
  export "$name=$value"
  shift
done
[[ ${1:-} == -- && $# -gt 1 ]] || die 'Expected -- command'
shift
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN value line
exec "$@"
