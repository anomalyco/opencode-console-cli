# OpenCode Console CLI

`opencode-console`, published to npm as `@opencode/console`, connects Claude Code, Pi, Codex, DeepSeek Harness and
Hermes Agent to an OpenCode Console workspace and enforces its policies on their tool calls. It ships as a Node bundle
(`script/build.ts`) and as eleven signed standalone binaries (`script/compile.ts`). The default branch is `dev`, and
every push to it publishes a dev build. Beta and stable releases are dispatched from `production`.

## Where things are

- `src/index.ts`: the CLI's entry point, where every command starts.
- `src/console-client.ts`, `src/contract.ts`: Console's API. `contract.ts` holds every wire schema and header name
  the CLI reads or sends, published as `@opencode/console/contract`.
- `src/event-watch.ts`, `src/event-watch-tool.ts`: the event watch wire contract and which tool calls start a watch,
  published as subpaths too. Console's server builds on them, so they import nothing but `effect`.
- `src/watches.ts` and `src/*-watches.ts`: event watches for each agent.
- `src/policy-evaluator.ts`: policy decisions, made by `@opencode/core`'s engine, the same one OpenCode uses.
- `src/claude-code*.ts`, `src/codex*.ts`, `src/pi*.ts`, `src/deepseek-harness.ts`, `src/dsh-plugin.ts`,
  `src/hermes*.ts`: each agent's setup, hook or in-process plugin.
- `src/credentials.ts`, `src/store.ts`: the sign-in and the CLI's data directory.
- `src/install.ts`, `src/update/`: where setup installs the CLI, self-update, signature checks and rollback.
- `install`, `install.ps1`: the standalone installers served at `https://opencode.ai/console/install[.ps1]`.
- `.github/release/`: the release scripts. Jobs holding secrets run only these.
- `test/support/`: the stand-in Console and release service every test runs against.

## Invariants

- Hooks fail closed. Any error in a policy hook exits 2 and blocks the tool call; never let a crash allow one.
- No secret goes into an agent's config files. Agents get the CLI's absolute path and ask it for tokens (`token`,
  `mcp-headers`) at run time.
- The data directory is `0700` and the files the store writes `0600`. Token refreshes run under the store's
  cross-process lock (`ConsoleStore.locked`), since several hooks refresh at once.
- `@opencode/core` makes every policy decision. Don't add a second evaluator or special-case a rule here.
- The workspace config Console serves (`/api/v2/config`) is standard OpenCode config. Read it as that; never expect a
  Console-only key in it.
- Edits to an agent's JSON, TOML or YAML keep the user's comments, order and own keys, and `setup <agent> --remove`
  puts back exactly what was there.
- `src/contract.ts` and `src/event-watch.ts` change only in step with Console. Additive fields are safe, since the CLI
  reads leniently; renaming or retyping one breaks every install already out there.
- A stable or beta build follows only `https://anoma.ly/release` and runs only Anomaly-signed binaries.

## Style

- TypeScript on Effect 4. Run `bun run check` (oxfmt, oxlint, tsc) and `bun run test` before you commit.
- Commit messages and pull request titles use `type(scope): summary`; CONTRIBUTING.md lists the types.
- Each module exports its own namespace on its first line: `export * as ConsoleStore from "./store"`.
- No `any`, no aliased or star imports, no default exports. Prefer `const`, early returns and type inference.
- Comments explain constraints and surprises, not what the next line does.

## Tests

- `bun run test`. Tests live in `test/`, shared helpers in `test/support/`.
- Every test runs against `test/support/console.ts` and `test/support/release.ts` on `127.0.0.1` with a temporary
  `HOME`. Never reach a real Console or a real agent config.
- A test is done when it can fail: break the behavior it names, watch it go red, then restore the code.
- `script/e2e/run.sh` and `script/e2e/signed.sh` run the compiled binary end to end on Linux x64. Run them on a
  disposable machine before changing the updater, the installers or `.github/release/`.

## Releases

Pull requests squash-merge into `dev`, and every push to `dev` publishes a dev build. `dev` reaches `production`
through the promotion pull request, merged with a merge commit. Stable and beta are dispatched on `production`; see
`RELEASING.md`. Changes under `.github/` need a code owner's review.
