# Releasing

`.github/workflows/publish-console-cli.yml` builds the CLI and publishes eleven binaries to Anomaly's release service
(`https://anoma.ly/release/opencode-console/cli/<channel>.json`), which installed CLIs update from. For beta and stable
it also publishes the binaries to npm as `@opencode/console-<target>`, and the Node bundle as `@opencode/console`.

## Channels

| Channel | Runs on | Version | Publishes to |
| --- | --- | --- | --- |
| `dev` | every push to `dev`, or a dispatch on `dev` | `<version>-dev.<run>`, using the next patch version once `<version>` is on npm | the release service only, unsigned |
| `beta` | a dispatch on `production` | `<version>-beta.<run>` | the release service and npm `beta`, signed |
| `stable` | a dispatch on `production` | `package.json`'s version, which must be new to npm | the release service, npm `latest`, tag `v<version>` and a GitHub release, signed |
| `check` | a dispatch on any branch | `package.json`'s version | nothing: builds, signs with throwaway keys and dry-runs every publish step |

Only a repository admin or maintainer can dispatch beta or stable. Both take two inputs. `rollout_percent` (default
100) is the share of installs that move to the release. `required` moves every install regardless of
`rollout_percent`; use it for security fixes.

## Release a version

1. Bump `version` in `package.json` in a pull request and merge it into `dev`. The push publishes a dev build.
2. Try the dev build: `curl -fsSL https://raw.githubusercontent.com/anomalyco/opencode-console-cli/dev/install | sh -s -- --channel dev setup claude-code`.
3. Merge the open `dev` → `production` promotion pull request with a merge commit, never a squash.
4. Publish:

   ```sh
   gh workflow run publish-console-cli.yml -R anomalyco/opencode-console-cli --ref production -f channel=stable
   ```

   Add `-f rollout_percent=10` to stage it, or `-f channel=beta` for a prerelease.
5. Check that `https://anoma.ly/release/opencode-console/cli/stable.json` names the version for all eleven targets, and
   `npm view @opencode/console@<version> dist.attestations` shows its provenance.

## Halt or roll back

Halting a rollout, raising it, marking a release required and promoting an earlier build are release service actions.
The service accepts them only from a GitHub Actions job in environment `release`, signed in by OIDC as publishing is.
This workflow doesn't dispatch actions yet, so for now a maintainer of Anomaly's release service runs them. The job
downloads the service's client from `https://anoma.ly/release/client.sh` and runs:

```sh
bash client.sh action --app opencode-console --artifact cli --channel stable --action <action> [--body '<json>']
```

Installs move to whatever build the channel names, older or newer, so promoting the previous build rolls every install
back. On a member's machine, a build whose hooks crash three times in a row also rolls itself back without waiting.

## How the workflow keeps keys apart

- `build` and `build-binaries` run repository code (install, typecheck, tests, `script/compile.ts`) with no
  environment, secrets or OIDC token, and upload their output with a `SHA256SUMS` whose digest they report.
- Every later job checks out only `.github/release/`, checks each artifact against the digest of the job that made it,
  and treats artifacts as data. None of them runs repository code.
- For beta and stable, `sign-macos` runs in environment `signing-macos`, and `sign-windows` and `sign-linux` in
  environment `signing`, both `production` only. `sign-macos` has its own environment because AWS trusts it with
  Apple keys the whole organization shares, which a compromised dependency of the Windows or Linux signing steps
  mustn't reach. Dev builds ship unsigned, and check runs never sign in anywhere, so no push to `dev` reaches a signing
  key. The values live in:

  | Value | Where |
  | --- | --- |
  | `APPLE_SIGNING_CERTIFICATE` (a base64 .p12 with no password), `APPLE_NOTARY_KEY` | AWS Secrets Manager, `shared/APPLE_SIGNING_CERTIFICATE` and `shared/APPLE_NOTARY_KEY`, shared with `anomalyco/opencode` |
  | `APPLE_NOTARY_KEY_ID`, `APPLE_NOTARY_ISSUER_ID` | environment `signing-macos` variables |
  | `AZURE_*` | environment `signing` secrets |
  | `CONSOLE_CLI_RELEASE_SIGNING_KEY` | environment `signing` secret |

  Each job reads its secrets in one or two steps at its start: `sign-macos`'s `Configure AWS credentials` and `Read
  signing secrets`, the others' `Load signing secrets`.
- `sign-macos` signs in to AWS as role `arn:aws:iam::604439173067:role/github/opencode-console-cli-signing`, whose
  trust policy must admit issuer `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com` and
  subject `repo:anomalyco@66570915/opencode-console-cli@1452060248:environment:signing-macos`, and no other.
  `aws-actions/aws-secretsmanager-get-secrets` masks each value, every line of it included, before a later step can
  print it; a hand-written `aws secretsmanager get-secret-value` step wouldn't, and would need `::add-mask::`.
- Azure signs Windows binaries for a federated credential with issuer `https://token.actions.githubusercontent.com`,
  audience `api://AzureADTokenExchange` and subject
  `repo:anomalyco@66570915/opencode-console-cli@1452060248:environment:signing`. This repository uses immutable OIDC
  subjects, which name the owner's and repository's IDs, so the AWS role and the Azure credential survive a rename but
  not a recreated repo.
- `reserve-tag` claims `refs/tags/v<version>` at the run's commit before a stable release publishes anything, and fails
  if the tag already points elsewhere. `finish` releases that tag with `gh release create --verify-tag`.
- Jobs that publish download the release service's client and check it against `.github/release/client.sh.sha256`
  before running it. When the service ships a new client, a release fails until a pull request updates the pin:
  `curl -fsSL https://anoma.ly/release/client.sh | shasum -a 256`, after reading what changed.
- `publish-release-service` and `finish` run in environment `release` (`dev` and `production`, no secrets). The release
  service admits them by OIDC: `refs/heads/dev` for `dev`, `refs/heads/production` for beta and stable.
- `publish-npm` runs in environment `npm` (`production` only, no secrets), which every package's npm trusted publishing
  names, and publishes with `--provenance`. npm accepts provenance only from a public repository.
- Changes to `.github/` need a review from a code owner in `.github/CODEOWNERS` (the `code owners` ruleset, on `dev`
  and `production`). Repository admins may skip that review when they merge a pull request. Required `Checks` and the
  merge methods (squash into `dev`, a merge commit into `production`) apply to everyone, admins included.
- Only repository admins and maintainers may merge into `production`, so only they can merge the promotion pull
  request.
- The `.github maintainer-only` push ruleset only applies while the repository is private. GitHub turns push rulesets
  off when a repository becomes public, so don't count on it afterwards.
- Anyone with write access can rerun a run's failed jobs. A rerun keeps the run's commit, channel and inputs, so a
  writer can finish a release a maintainer dispatched, such as by rerunning `publish-npm` after a network failure, but
  can't start one or change what it publishes.

## The installers

`install` and `install.ps1` will be served at `https://opencode.ai/console/install` and
`https://opencode.ai/console/install.ps1` once Console's proxy for them ships, from this repository's `production`
branch. Until then, link to them on `raw.githubusercontent.com`, as the README does, and not to `opencode.ai`.

## If a publish fails partway

The release service accepts a rerun of the release it already has when the files are identical, and `publish-npm.sh`
skips a version npm already has. If a run failed without saying whether it reached npm, compare npm's integrity with the
`build` artifact's tarball before you rerun:

```sh
npm view @opencode/console@<version> dist.integrity
echo "sha512-$(openssl dgst -sha512 -binary opencode-console-<version>.tgz | openssl base64 -A)"
```
