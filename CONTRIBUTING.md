# Contributing

Pull requests are welcome against `dev`. Bug fixes, compatibility updates for a new agent release, shell and path
edge cases, and docs can go straight to a pull request.

Open an issue first for a new agent integration or anything that changes what the CLI sends to or reads from Console
(`src/contract.ts`, `src/event-watch.ts`, `src/event-watch-tool.ts`). Console's own tests decode its responses with
these schemas, so a change there ships in step with Console.

## Setup

You need [Bun](https://bun.sh) 1.4.3 and Node.js 22 or later.

```sh
bun install
bun run check   # Format, lint and typecheck
bun run test    # Every test, against local stand-ins for Console and the release service
```

`bun run fmt` fixes the formatting errors `check` reports. Run the CLI from source with `bun src/index.ts <command>`, or
point it at a Console of your own with `--server <url>`.

## Tests

Every change comes with a test that fails without it. Before you open the pull request, break the behavior your test
covers, watch the test fail, then put it back.

Tests run against `test/support/console.ts` and `test/support/release.ts` on `127.0.0.1`, never a real Console, so they
need no account or network. Setup tests write into a temporary `HOME`; keep it that way, so no test touches your own
agent configs.

## What a pull request needs

- CI's `Checks` passing: format, lint, typecheck, tests, the packed npm package and a compiled linux-x64 binary.
- A title like `fix(codex): keep a model_provider set before setup`. Types are `feat`, `fix`, `docs`, `chore`,
  `refactor` and `test`.
- A maintainer's review. Changes under `.github/` (the release workflow and signing scripts) need a review from a
  code owner in `.github/CODEOWNERS`, which repository admins may skip when they merge.

Pull requests are squash-merged into `dev`. See [RELEASING.md](RELEASING.md) for how `dev` becomes a release.
