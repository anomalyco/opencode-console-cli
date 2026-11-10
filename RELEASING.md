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
2. Try the dev build: `curl -fsSL https://opencode.ai/console/install | sh -s -- --channel dev setup claude-code`.
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
- `sign-macos`, `sign-windows` and `sign-linux` run in environment `signing` (`production` only) for beta and stable.
  Each reads its values in one `Load signing secrets` step, the only step a move to a secrets manager changes. Dev
  builds ship unsigned, so no push to `dev` reaches a signing key.
- `publish-release-service` and `finish` run in environment `release` (`dev` and `production`, no secrets). The release
  service admits them by OIDC: `refs/heads/dev` for `dev`, `refs/heads/production` for beta and stable.
- `publish-npm` runs in environment `npm` (`production` only, no secrets), which every package's npm trusted publishing
  names, and publishes with `--provenance`. npm accepts provenance only from a public repository.
- Changes to `.github/` need a review from `.github/CODEOWNERS`.

## If a publish fails partway

The release service accepts a rerun of the release it already has when the files are identical, and `publish-npm.sh`
skips a version npm already has. If a run failed without saying whether it reached npm, compare npm's integrity with the
`build` artifact's tarball before you rerun:

```sh
npm view @opencode/console@<version> dist.integrity
echo "sha512-$(openssl dgst -sha512 -binary opencode-console-<version>.tgz | openssl base64 -A)"
```
