# Releasing

`.github/workflows/release.yml` builds the CLI and publishes eleven binaries to Anomaly's release service
(`https://anoma.ly/release/opencode-console/cli/<channel>.json`), which installed CLIs update from. For stable it also
publishes the binaries to npm as `@opencode/console-<target>`, and the Node bundle as `@opencode/console`.

## Channels

Every version counts from `<latest>`, the newest `vX.Y.Z` tag. `package.json`'s version isn't read: the build stamps the
planned version into its checkout, and nothing commits a version back.

| Channel | Runs on | Version | Publishes to |
| --- | --- | --- | --- |
| `dev` | every push to `dev`, or a dispatch on `dev` | `<latest + patch>-dev.<run>` | the release service only, unsigned |
| `beta` | a dispatch on `dev` | `<latest + bump>-beta.<run>` | the release service only, signed |
| `stable` | a dispatch on `dev` | `<latest + bump>`, which must be new to npm | the release service and npm `latest`, signed; then tag `v<version>` and a GitHub release |
| `check` | a dispatch on `dev` | `<latest + bump>` | nothing: builds and signs as stable does, with the real keys, signs in to the release service and npm, and dry-runs every publish step; never tags |

`bump` is `patch` (the default), `minor` or `major`. A rerun adds its attempt to `<run>` (`0.1.11-dev.142.2`). Until the
first `vX.Y.Z` tag exists, npm's latest `@opencode/console` stands in for `<latest>`.

Beta and stable take two more inputs. `rollout_percent` (default 100) is the share of installs that move to the
release. `required` moves every install regardless of `rollout_percent`; use it for security fixes.

## Release a version

1. Merge the change into `dev`. The push publishes a dev build.
2. Try the dev build: `curl -fsSL https://raw.githubusercontent.com/anomalyco/opencode-console-cli/dev/install | sh -s -- --channel dev setup claude-code`.
3. Publish from `dev`:

   ```sh
   gh workflow run release.yml -R anomalyco/opencode-console-cli --ref dev -f channel=stable
   ```

   Add `-f bump=minor` or `-f bump=major` for a bigger step, `-f rollout_percent=10` to stage it, or `-f channel=beta`
   for a prerelease. `-f channel=check` first shows the version it would publish: it signs and notarizes with the real
   credentials and proves the release service and npm admit the run, but publishes and tags nothing.
4. Check that `https://anoma.ly/release/opencode-console/cli/stable.json` names the version for all eleven targets,
   `npm view @opencode/console@<version> dist.attestations` shows its provenance, and tag `v<version>` exists.

`production` doesn't take part in releases. It holds the installers `raw.githubusercontent.com` serves (see
[The installers](#the-installers)), and reaches `dev` through the promotion pull request.

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
- Every signing and publishing job (`sign-macos`, `sign-windows`, `sign-linux`, `publish-release-service`,
  `publish-npm`, `finish`) always runs in environment `release`, which only `dev` may use and which holds no secrets;
  no job picks its environment at run time. A check run signs exactly as beta and stable do, with the same AWS role,
  secrets, Azure account and Developer ID, and notarizes; the release key in `linux-signing.pub` is the only one
  `sign-linux.sh` signs with. Its publish jobs sign in by OIDC (a release service publish session, an npm trusted
  publishing token for every package) and then stop: `dry_run` only guards publishing and tagging, and every artifact
  is still checked against its producer's digest. Dev builds ship unsigned. The values live in:

  | Value | Where |
  | --- | --- |
  | `APPLE_SIGNING_CERTIFICATE` (a base64 .p12 with no password), `APPLE_NOTARY_KEY` | AWS Secrets Manager, `shared/APPLE_SIGNING_CERTIFICATE` and `shared/APPLE_NOTARY_KEY`, shared with `anomalyco/opencode` |
  | `CONSOLE_CLI_RELEASE_SIGNING_KEY` | AWS Secrets Manager, `opencode-console-cli/release/CONSOLE_CLI_RELEASE_SIGNING_KEY` |
  | `APPLE_NOTARY_KEY_ID`, `APPLE_NOTARY_ISSUER_ID` | variables |
  | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`, `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE` | variables |

- `sign-macos` and `sign-linux` sign in to AWS as role
  `arn:aws:iam::604439173067:role/github/opencode-console-cli-release`, which may read only those three secrets. Its
  trust policy must admit issuer `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`, subject
  `repo:anomalyco@66570915/opencode-console-cli@1452060248:environment:release` and `job_workflow_ref`
  `anomalyco/opencode-console-cli/.github/workflows/release.yml@refs/heads/dev`, and no other.
  `configure-aws-credentials` runs with `output-env-credentials: false`, so its credentials are step outputs, passed
  only to the signing step. That step runs `with-secrets.sh`, which reads its secrets, masks every line of them and
  runs the signing script with them and without the AWS credentials. Nothing goes to `$GITHUB_ENV`.
- Azure signs Windows binaries for a federated credential with issuer `https://token.actions.githubusercontent.com`,
  audience `api://AzureADTokenExchange` and subject
  `repo:anomalyco@66570915/opencode-console-cli@1452060248:environment:release`. This repository uses immutable OIDC
  subjects, which name the owner's and repository's IDs, so the AWS role and the Azure credential survive a rename but
  not a recreated repo.
- `finish` tags `v<version>` at the run's commit only once npm has the release, so a failed run never spends a version,
  and fails if the tag already points elsewhere. It then releases that tag with `gh release create --verify-tag`. A
  check run never reaches `finish`, and `tag-release.sh` refuses a dry run anyway.
- Jobs that publish download the release service's client and check it against `.github/release/client.sh.sha256`
  before running it. When the service ships a new client, a release fails until a pull request updates the pin:
  `curl -fsSL https://anoma.ly/release/client.sh | shasum -a 256`, after reading what changed.
- The release service admits `publish-release-service` and `finish` by OIDC: its registry entry for
  `opencode-console` names this repository, `.github/workflows/release.yml`, `refs/heads/dev` and environment
  `release`.
- `publish-npm` publishes with npm trusted publishing only, which every package names for `release.yml` and
  environment `release`, and with `--provenance`. There is no npm token, and the script fails if one is set. npm accepts
  provenance only from a public repository.
- Changes to `.github/` need a review from a code owner in `.github/CODEOWNERS` (the `code owners` ruleset, on `dev`
  and `production`). Repository admins may skip that review when they merge a pull request. Required `Checks` and the
  merge methods (squash into `dev`, a merge commit into `production`) apply to everyone, admins included.
- The `.github maintainer-only` push ruleset only applies while the repository is private. GitHub turns push rulesets
  off when a repository becomes public, so don't count on it afterwards.
- Anyone who can dispatch workflows can release the commit on `dev`. Anyone with write access can rerun a run's
  failed jobs; a rerun keeps the run's commit, channel and inputs, so it can finish a release, such as by rerunning
  `publish-npm` after a network failure, but can't change what it publishes.

## The installers

`install` and `install.ps1` will be served at `https://opencode.ai/console/install` and
`https://opencode.ai/console/install.ps1` once Console's proxy for them ships, from this repository's `production`
branch. Until then, link to them on `raw.githubusercontent.com`, as the README does, and not to `opencode.ai`.

## If a publish fails partway

Rerun the failed jobs of that run rather than dispatching again: the run keeps its version, and a new dispatch would
build different bytes for the same version, which the release service and npm refuse. The release service accepts a
rerun of the release it already has when the files are identical, and `publish-npm.sh` skips a version npm already
has. If a run failed without saying whether it reached npm, compare npm's integrity with the
`build` artifact's tarball before you rerun:

```sh
npm view @opencode/console@<version> dist.integrity
echo "sha512-$(openssl dgst -sha512 -binary opencode-console-<version>.tgz | openssl base64 -A)"
```
