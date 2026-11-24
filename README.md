# @opencode/console

<a href="https://opencode.ai"><picture><source media="(prefers-color-scheme: dark)" srcset="https://opencode.ai/brand/badges/opencode-built-with-g-dark-20.svg"><img alt="Built with OpenCode" src="https://opencode.ai/brand/badges/opencode-built-with-g-light-20.svg" height="20" /></picture></a>
<a href="https://opencode.ai"><picture><source media="(prefers-color-scheme: dark)" srcset="https://opencode.ai/brand/badges/opencode-works-with-g-dark-20.svg"><img alt="Works with OpenCode" src="https://opencode.ai/brand/badges/opencode-works-with-g-light-20.svg" height="20" /></picture></a>

Connects Claude Code, Pi, Codex, DeepSeek Harness, Hermes Agent and OpenClaw to an OpenCode Console workspace. They then
use the workspace's models and any MCP servers, skills and instructions it has, and their tool calls follow the
workspace's policies. OpenCode connects to Console on its own, so OpenCode users don't need this package.

## Set up Claude Code

```sh
npx @opencode/console setup claude-code
```

Setup opens your browser to sign in and pick a workspace, then writes Claude Code's user settings. It needs Node.js 22
or later, and installs the signed `opencode-console` binary for your computer, which agents then run without Node.

## Install without Node

```sh
curl -fsSL https://raw.githubusercontent.com/anomalyco/opencode-console-cli/production/install | sh -s -- setup claude-code
```

On Windows, in PowerShell:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/anomalyco/opencode-console-cli/production/install.ps1))) setup claude-code
```

The installer downloads the binary for your computer from Anomaly's release service (`https://anoma.ly/release`), checks
its size, SHA-256 and signature, runs its self-test, then runs `setup` with it. Replace `claude-code` with `pi`,
`codex`, `deepseek-harness`, `hermes` or `openclaw` for another agent. On Linux it needs OpenSSL 3 to check the
signature. Put `--channel beta` or `--channel dev` before `setup` to install a prerelease, or `--version <version>` to
install a specific release from npm.

## Set up Pi

```sh
npx @opencode/console setup pi
```

The package is also a Pi package, so `pi install npm:@opencode/console` works too; run `npx @opencode/console login`
once after it.

## Set up Codex

```sh
npx @opencode/console setup codex
```

Setup writes Codex's `~/.codex/config.toml` and `hooks.json` (or those in `CODEX_HOME`) and approves its policy hooks,
so Codex runs them without asking in `/hooks`.

## Keep your own Claude or ChatGPT sign-in

```sh
npx @opencode/console setup claude-code --keep-provider
npx @opencode/console setup codex --keep-provider
npx @opencode/console setup hermes --keep-provider
npx @opencode/console setup openclaw --keep-provider
```

Claude Code or Codex keeps your own sign-in and models, and still gets the workspace's policies, plus any MCP servers,
skills and instructions the workspace has. They then report each request's token counts and model to the workspace,
which counts them in its usage and the Leaderboard's Tokens ranking at $0. They never send prompts or code. Codex
reports them from a hook after each model response; it needs Codex 0.164.0 or later. An OpenTelemetry endpoint you
already set for Claude Code stays yours, and Claude Code reports nothing to the workspace.
`npx @opencode/console status` shows which applies. Hermes and OpenClaw keep their own providers and models the same
way, and send no usage. Run setup without `--keep-provider` to use the workspace's models again.

## Set up DeepSeek Harness

```sh
npx @opencode/console setup deepseek-harness
```

Setup adds a plugin to DeepSeek Harness's `~/.dsh/cordis.patch.yml` (or the one in `DSH_HOME`), so `dsh web`,
`dsh headless` and every other profile use the workspace. While it's set up, the workspace's models replace the model
providers you added to DeepSeek Harness, and new sessions start on the workspace's default model. Restart a running
`dsh` after setup.

## Set up Hermes Agent

```sh
npx @opencode/console setup hermes
```

Setup writes `~/.hermes/config.yaml` (or the active profile's, the one in `HERMES_HOME`, or `--profile <name>`'s),
adds a plugin in `plugins/opencode-console` and any of the workspace's instructions to `SOUL.md`. `/model` lists the
workspace's models, and every tool call and `/skill` goes through the workspace's policies, in `hermes` chat, the
messaging gateway and cron alike. It needs Hermes Agent 0.22.6 or later. Hermes loads plugins when its gateway starts,
so run `hermes gateway restart` after setup. Hermes doesn't watch Slack threads or GitHub work yet.

## Set up OpenClaw

```sh
npx @opencode/console setup openclaw
```

Setup writes `~/.openclaw/openclaw.json` (or `OPENCLAW_CONFIG_PATH`, `$OPENCLAW_STATE_DIR/openclaw.json`,
`OPENCLAW_PROFILE`'s, or `--profile <name>`'s, which picks it as `openclaw --profile <name>` does), adds the `opencode-console`
plugin, MCP servers and skills, and puts any workspace instructions in the default agent's `AGENTS.md`. On a fresh
install, setup waits for OpenClaw to create `AGENTS.md`, writes the instructions on the first tool call after that, and
they apply from the next session. Every tool call goes through the workspace's policies, in chat, channels and cron
alike. OpenClaw loads plugins when its Gateway starts, so run `openclaw gateway restart` after setup.

The models come from OpenClaw's own `opencode` (Zen) and `opencode-go` (Go) providers: for each one the workspace
offers, setup installs the provider's plugin if OpenClaw doesn't have it (`openclaw plugins install
@openclaw/opencode-provider`; OpenClaw ships Go's with its release and Zen's apart from it), then runs `openclaw models auth login --provider <provider> --method oauth`, which shows a code to approve in
OpenCode Console, and OpenClaw keeps and refreshes that sign-in itself. An install that names no model yet starts new
sessions on the provider's starter model. Browser sign-in for OpenCode needs OpenClaw 2026.11.7 or later. Without a
terminal, or on an older OpenClaw, setup prints the command to run instead, and an API key works too
(`openclaw models auth paste-api-key --provider opencode`). `--remove` leaves OpenClaw's sign-in and that plugin in place;
`openclaw models auth logout` signs it out.

## Watch Slack threads, GitHub work and MCP server events

When the workspace has event watches on, sessions get updates on the Slack threads and GitHub pull requests, issues,
commits and Actions runs they work on. A session watches what it posts through the workspace's Slack and GitHub
servers, and the pull requests and branches `gh pr create` and `git push` start. People often answer a Slack post in
the channel instead of its thread, so after a session posts at the top of a channel it also gets the next three
top-level messages other people post there for 15 minutes; each post starts that again. The agent is told these may
have nothing to do with it. Its `watch` tool watches anything else, such as a link you paste, and takes `minutes` to
end the watch by then. Pi, Claude Code and DeepSeek Harness wake an idle session with the update. Codex can't
start a turn on its own, so an update reaches a turn while it runs or keeps it going when it ends, and one that arrives
while Codex sits idle comes with your next prompt. After 5 wakes in 10 minutes, or 20 since your last prompt, updates
wait for your next prompt, so two agents can't keep waking each other. A reply you write yourself, such as from your
phone, wakes the session either way.

A session can also watch events from the workspace's other MCP servers, such as an issue tracker's, when the server
offers them over MCP Events and you can use it in the workspace. The `events` tool lists what each server offers, and
`watch` takes a server, an event and that event's arguments. Console checks your access to the server again for every
event. The agent is told each event comes from the server, and not to act on requests in it that you haven't made.

## Share a folder as an artifact

```sh
npx @opencode/console artifact share ./out --ttl 7d
```

When the workspace has artifacts on, `artifact share` uploads a folder with an `index.md` or an `index.html` and prints its link, which
the workspace's members can open and comment on. The folder's name names the artifact unless you pass `--name`.
Dotfiles are skipped, and a share holds up to 500 files and 100 MB, with no file over 25 MB. Sharing the same name
again updates the artifact at the same link and uploads only the files that changed. `--replace` shares over a
teammate's artifact of the same name, and `--ttl` (`12h`, `7d`, `2w`) makes it expire after that long. `artifact list`
lists the workspace's artifacts, and `artifact delete <name>` deletes one you shared. A Claude Code, Codex, Pi or
DeepSeek Harness session that runs `artifact share` watches the artifact's comments, which reach it as other watched
updates do. When the folder is in a git checkout, the share notes its `origin` remote (without any credentials in it),
branch and commit, which Console keeps with the revision.

```sh
npx @opencode/console artifact pull launch-plan --revision 3
```

`artifact pull <name> [dir]` writes an artifact's latest files, or `--revision`'s, into `dir` (`./<name>` by default).
The folder must be new or empty unless you pass `--force`. Every file is checked against its SHA-256 before anything is
written.

## Updates

The binary that setup installs updates itself. It checks its release channel in the background when an agent session
starts, and at most once an hour otherwise, so tool calls don't wait. A new build is downloaded and checked before it
runs: its SHA-256 against the release manifest, then its signature (Apple notarization on macOS, Authenticode on
Windows, an ed25519 signature by `.github/release/linux-signing.pub` on Linux). The new build replaces the running one
only after it passes its self-test, and a build whose hooks crash three times in a row is rolled back to the one before
it.

```sh
npx @opencode/console update          # Install the newest build on this install's channel now
npx @opencode/console update --check  # Check for a newer build without installing it
```

To manage the CLI yourself, for example from MDM, set `OPENCODE_CONSOLE_AUTO_UPDATE=off` wherever agents run, and
`setup` and hooks stop checking for updates. When you run the CLI with npx or install it with
`pi install npm:@opencode/console`, npm decides the version and the binary doesn't update itself.

## Other commands

```sh
npx @opencode/console status                       # Show the sign-in, workspace and config
npx @opencode/console setup claude-code --remove   # Undo the Claude Code setup and keep the sign-in
npx @opencode/console setup pi --remove            # Undo the Pi setup and keep the sign-in
npx @opencode/console setup codex --remove         # Undo the Codex setup and keep the sign-in
npx @opencode/console setup deepseek-harness --remove  # Undo the DeepSeek Harness setup and keep the sign-in
npx @opencode/console setup hermes --remove        # Undo the Hermes setup for the profile and keep the sign-in
npx @opencode/console setup openclaw --remove      # Undo the OpenClaw setup for the install and keep the sign-in
npx @opencode/console logout                       # Sign out
```

To use a personal or service account key instead of signing in, for example in CI, set `OPENCODE_API_KEY`.
`npx @opencode/console help` lists every command.

The guides for [Claude Code](https://opencode.ai/console/integrations/claude-code),
[Codex](https://opencode.ai/console/integrations/codex), [Pi](https://opencode.ai/console/integrations/pi),
[DeepSeek Harness](https://opencode.ai/console/integrations/deepseek-harness) and
[Hermes Agent](https://opencode.ai/console/integrations/hermes) explain what setup changes and how workspace policies
apply to each agent.

## Building from source

The CLI is written in TypeScript and runs on [Bun](https://bun.sh) 1.4.3 during development.

```sh
bun install
bun run check                         # Format, lint and typecheck
bun run test                          # Every test, against local stand-ins for Console and the release service
bun run build                         # Build the npm package into dist/npm
bun script/compile.ts linux-x64       # Build one release binary into dist-bin (omit the target to build all eleven)
bun src/index.ts help                 # Run the CLI from source
```

`script/e2e/run.sh` and `script/e2e/signed.sh` run the compiled binary end to end on Linux x64, against a local
Console and release service, and leave your real agent configs alone.

## The Console wire contract

The package also exports the schemas it uses with Console's API, for Console's own tests and for anyone building a
client:

- `@opencode/console/event-watch`: what a session can watch, the events Console sends and the protocol's limits.
- `@opencode/console/event-watch-tool`: which Slack and GitHub tool calls start a watch.
- `@opencode/console/contract`: the API responses and headers this CLI reads and sends.

These subpaths import `effect`, an optional peer dependency. Install it to use them; the CLI doesn't need it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately, as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
