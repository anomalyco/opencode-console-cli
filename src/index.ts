import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import type { Effect } from "effect"
import type { ClaudeCodeHook } from "./claude-code-hook"
import type { DeepSeekHarness } from "./deepseek-harness"
import type { HttpClient } from "effect/http"
import type { PolicyEvaluator } from "./policy-evaluator"
import type { WorkspaceSnapshot } from "./snapshot"
import type { ConsoleStore } from "./store"
import { version } from "../package.json" with { type: "json" }

// Harness hooks run `check` before every tool call, so each command imports only what it needs.
const parsed = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    harness: { type: "string" },
    server: { type: "string" },
    json: { type: "boolean" },
    quiet: { type: "boolean" },
    remove: { type: "boolean" },
    "keep-provider": { type: "boolean" },
    profile: { type: "string" },
    listen: { type: "boolean" },
    "next-prompt": { type: "boolean" },
    "refresh-agents": { type: "boolean" },
    check: { type: "boolean" },
  },
})
const command = parsed.positionals[0]
const flags = parsed.values
let harness = flag("harness") ?? process.env.OPENCODE_CONSOLE_HARNESS
// Whether this run found the calling agent's hooks off, which its Console requests say (`checkHooks`).
let hooksOff = false
const NOT_SIGNED_IN = "Not signed in. Run `npx @opencode/console login` or set OPENCODE_API_KEY."
// The agents `setup` connects, and the ones whose hooks run `hook`; Pi and DeepSeek Harness check in their own process.
const AGENTS = ["claude-code", "pi", "codex", "deepseek-harness", "hermes"]
const HOOKS = ["claude-code", "codex", "hermes"]
// The agents that can keep their own sign-in and models with `--keep-provider`.
const VENDOR_SIGN_IN = ["claude-code", "codex", "hermes"]

const commands: Record<string, () => Promise<number>> = {
  check,
  hook,
  login,
  logout,
  // Started by setup's Hermes plugin, never by a person, so `--help` leaves it out.
  "mcp-env": mcpEnv,
  "mcp-headers": mcpHeaders,
  "mcp-watches": mcpWatches,
  "otel-headers": otelHeaders,
  // Started by Codex's usage hook, never by a person, so `--help` leaves it out.
  "report-codex-usage": reportCodexUsage,
  // Run by updates, never by a person, so `--help` leaves them out.
  "self-test": selfTest,
  "self-update": selfUpdate,
  setup,
  status,
  sync,
  token,
  update,
}
// The event a hook is answering, so a failure still blocks in that event's format.
let hookEvent: string | undefined

const run = command ? commands[command] : undefined
if (!run) {
  process.stdout.write(usage())
  process.exit(command && !["help", "--help", "-h"].includes(command) ? 1 : 0)
}
process.exitCode = await run().catch(async (error: unknown) => {
  // A policy check that crashed rather than decided counts against the build, which three in a row roll back.
  if (command === "hook" || command === "check") await crashed(error)
  if (command === "hook") return refuse(`opencode-console couldn't check this: ${message(error)}`)
  process.stderr.write(`${message(error)}\n`)
  if (command !== "check") return 1
  // A hook that can't decide must block: harnesses treat other failures as allow.
  return deny(`opencode-console couldn't check this call: ${message(error)}`)
})

/**
 * Counts a policy check that crashed against the installed build, unless the member's input, sign-in or computer
 * caused it, which no other build would fix: a tool call the hook can't read, a sign-in file to repair, or a system
 * error such as a full disk. Never changes the check's answer.
 */
async function crashed(error: unknown) {
  await Promise.resolve()
    .then(async () => {
      const { AutoUpdate } = await import("./update/auto-update")
      if (!(await AutoUpdate.buildFault(error))) return undefined
      const { ConsoleStore } = await import("./store")
      if ((await AutoUpdate.crashed(ConsoleStore.make(), { running: runningFile() })) === "rolled-back")
        process.stderr.write(
          "opencode-console rolled back to the last build that worked, after this one kept crashing\n",
        )
      return undefined
    })
    .catch(() => undefined)
}

/**
 * Reads `{ action, resources, directory?, path?, shell? }` from stdin and answers with the workspace policy's
 * decision: `{"effect":"allow"}` and exit code 0, or `{"effect":"deny","message":...}` and exit code 2.
 *
 * It decides from the stored workspace config and never calls the Console itself. A config older than a minute is
 * refreshed by a background `sync` for the next call; a sign-in with no config yet starts one and waits up to 3 seconds
 * for it. A signed-in workspace whose policy is still unknown after that is denied, so a Console outage never lifts
 * policy, and a refresh still in flight is never cut short.
 */
async function check() {
  const { Option, Schema } = await import("effect")
  const input = Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Struct({
        action: Schema.NonEmptyString,
        resources: Schema.NonEmptyArray(Schema.String),
        directory: Schema.optional(Schema.String),
        path: Schema.optional(Schema.String),
        shell: Schema.optional(Schema.String),
      }),
    ),
  )(await stdin())
  // Input this can't read is a harness or adapter bug; refusing the call keeps it from passing unchecked.
  if (Option.isNone(input)) {
    process.stderr.write('Expected JSON on stdin: {"action": "...", "resources": ["...", ...]}\n')
    return deny("opencode-console couldn't read this tool call, so it was blocked")
  }
  const [decision] = await decide([input.value])
  process.stdout.write(`${JSON.stringify(decision)}\n`)
  return decision?.effect === "deny" ? 2 : 0
}

/**
 * Answers a coding agent's hook. For Claude Code (`hook claude-code`) and Codex (`hook codex`) it reads the hook's JSON
 * on stdin, checks the tool call, prompt mentions or typed skill against the workspace's policies as `check` does, and
 * blocks a denied one in the agent's own format, with exit code 2 and the reason on stderr, which both agents read as
 * a block. Anything it can't read or decide is blocked too. At session start it refreshes the workspace's config in
 * the background and says when the sign-in needs the member.
 */
async function hook() {
  const target = parsed.positionals[1]
  if (!target || !HOOKS.includes(target)) {
    process.stderr.write(`Usage: opencode-console hook <${HOOKS.join("|")}>\n`)
    return 2
  }
  if (target === "hermes") return hermesHook(await stdin())
  const { Option } = await import("effect")
  const { ClaudeCodeHook } = await import("./claude-code-hook")
  const text = await stdin()
  hookEvent = ClaudeCodeHook.eventName(text)
  if (target === "codex" && hookEvent === "PostModelRequest") return codexUsage(text)
  if (target === "codex" && (flags.listen === true || ["PostToolUse", "Stop", "Interrupt"].includes(hookEvent ?? "")))
    return codexWatchHook(text)
  if (target === "claude-code" && ["PostToolUse", "Stop", "SessionEnd"].includes(hookEvent ?? ""))
    return claudeWatchHook(text)
  const claude = target === "claude-code" ? Option.getOrUndefined(ClaudeCodeHook.decode(text)) : undefined
  const checks =
    target === "codex"
      ? await codexChecks(text)
      : claude &&
        ClaudeCodeHook.checks(claude, {
          platform: process.platform,
          env: process.env,
          watchServer: await claudeWatchTool(claude),
        })
  if (checks === undefined) return refuse("opencode-console couldn't read this hook's input, so it was blocked")
  if (hookEvent === "SessionStart") return sessionStart()
  // Deciding even with nothing to check keeps the stored config fresh, and tells the Console the hooks still run.
  const denied = (await decide(checks)).find((decision) => decision.effect === "deny")
  if (denied?.effect === "deny") return refuse(denied.message)
  if (claude?.hook_event_name === "UserPromptSubmit") await claudePrompt(claude)
  if (target === "codex" && hookEvent === "UserPromptSubmit") await codexPrompt(text)
  return 0
}

/**
 * Answers setup's Hermes plugin (`HermesHook`): checks a tool call, or the skills a turn loads, and prints
 * `{"action":"block","message":...}` with exit code 2 for a denial, which the plugin hands Hermes as is. An allowed turn
 * prints the fingerprint of the gateway MCP servers' headers, so the plugin can have Hermes fetch them again once the
 * day's token changes. Anything it can't read is blocked.
 */
async function hermesHook(text: string) {
  const { Option } = await import("effect")
  const { Hermes } = await import("./hermes")
  const { HermesHook } = await import("./hermes-hook")
  const { WorkspaceSnapshot } = await import("./snapshot")
  const { ConsoleStore } = await import("./store")
  const event = Option.getOrUndefined(HermesHook.decode(text))
  if (!event) return refuse("opencode-console couldn't read this hook's input, so it was blocked")
  const store = ConsoleStore.make()
  const checks = HermesHook.checks(event, {
    directory: event.cwd || process.cwd(),
    base: event.base || undefined,
    shell: event.shell_cwd || undefined,
    home: event.home_dir || undefined,
    servers: Object.keys(WorkspaceSnapshot.servers(WorkspaceSnapshot.read(store))),
    // The workspace's skills, and the profile's own, which Hermes seeds with its bundled ones.
    ...(event.home ? { skills: [Hermes.skillsDirectory(store, event.home), path.join(event.home, "skills")] } : {}),
  })
  // Deciding even with nothing to check keeps the stored config fresh for the next tool call.
  const denied = (await decide(checks)).find((decision) => decision.effect === "deny")
  if (denied?.effect === "deny") return refuse(denied.message)
  process.stdout.write(
    `${JSON.stringify(event.hook_event_name === "pre_llm_call" ? { mcp: Hermes.mcpEnvironment(WorkspaceSnapshot.read(store)).version } : {})}\n`,
  )
  return 0
}

/**
 * Before a Claude Code call to setup's `console_watch` server, records which session the Claude Code process runs, so
 * the server it started (`mcp-watches`) watches for that session; says whether the server is setup's.
 */
async function claudeWatchTool(event: ClaudeCodeHook.Event) {
  const { ClaudeCodeHook } = await import("./claude-code-hook")
  if (event.hook_event_name !== "PreToolUse" || !event.tool_name?.startsWith(`mcp__${ClaudeCodeHook.WATCH_SERVER}__`))
    return false
  const { ClaudeCode } = await import("./claude-code")
  const { ConsoleStore } = await import("./store")
  const { ConsoleWatches } = await import("./watches")
  const { Effect } = await import("effect")
  const store = ConsoleStore.make()
  if (!ClaudeCode.ownServers(store).watch) return false
  // Claude Code starts hooks and stdio servers itself, with no shell between, so both have its process as parent.
  if (event.session_id)
    await Effect.runPromise(ConsoleWatches.bindHostPid(store, process.ppid, event.session_id)).catch(() => undefined)
  return true
}

/**
 * Adds the event watch updates that waited for the user to the prompt they just sent, which also counts the
 * session's wakes from zero again. A failure adds nothing and never blocks the prompt.
 */
async function claudePrompt(event: ClaudeCodeHook.Event) {
  const { ConsoleStore } = await import("./store")
  const { ClaudeCodeWatches } = await import("./claude-code-watches")
  const context = await withConsole(ClaudeCodeWatches.promptSubmitted(ConsoleStore.make(), event)).catch(
    () => undefined,
  )
  if (context)
    process.stdout.write(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } })}\n`,
    )
}

/**
 * Claude Code's event watch hooks (`ClaudeCodeWatches`): `PostToolUse`, which tells Claude when Console refused a
 * watch, and `SessionEnd`, and `Stop`, which waits in the background for the session's next update and exits 2 with
 * it, which wakes Claude (`asyncRewake`). They never block or wake anything by failing: whatever goes wrong, they
 * print nothing and exit 0.
 */
async function claudeWatchHook(text: string): Promise<number> {
  const outcome = await Promise.resolve()
    .then(async () => {
      const { Effect, Option } = await import("effect")
      const { ClaudeCode } = await import("./claude-code")
      const { ClaudeCodeHook } = await import("./claude-code-hook")
      const { ClaudeCodeWatches } = await import("./claude-code-watches")
      const { ConsoleStore } = await import("./store")
      const event = Option.getOrUndefined(ClaudeCodeHook.decode(text))
      if (!event) return undefined
      const store = ConsoleStore.make()
      if (event.hook_event_name === "PostToolUse") {
        const context = await withConsole(
          ClaudeCodeWatches.postToolUse(store, event, ClaudeCode.ownServers(store).gateway),
        )
        // Claude Code hands a background hook's `additionalContext` to Claude on its next turn.
        if (context)
          await flush(
            process.stdout,
            JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }),
          )
        return undefined
      }
      if (event.hook_event_name === "SessionEnd") {
        await withConsole(ClaudeCodeWatches.sessionEnded(store, event))
        return undefined
      }
      // Claude Code starts the hook itself, so a new parent means it exited without ending the session.
      const parent = process.ppid
      return withConsole(
        ClaudeCodeWatches.stop(store, event, {
          alive: Effect.sync(() => process.ppid === parent),
          entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
          harness,
        }),
      )
    })
    .catch(() => undefined)
  // `asyncRewake` shows Claude the hook's stderr, or its stdout when stderr is empty. The text goes to both, so it
  // shows even if the runtime warns on stderr, and stdout isn't empty, which Claude Code reads as a hook that never
  // started when stderr mentions a missing file.
  if (outcome) await Promise.all([flush(process.stdout, outcome), flush(process.stderr, outcome)])
  // Exits at once, so no connection the runtime keeps open holds back the wake.
  return process.exit(outcome ? 2 : 0)
}

function flush(stream: NodeJS.WriteStream, text: string) {
  return new Promise<void>((resolve) => stream.write(`${text}\n`, () => resolve()))
}

// Codex starts its hooks in the session's directory, and names a workspace MCP server's tools by the server's name.
async function codexChecks(text: string) {
  const { Option } = await import("effect")
  const { CodexHook } = await import("./codex-hook")
  const { WorkspaceSnapshot } = await import("./snapshot")
  const { ConsoleStore } = await import("./store")
  const event = CodexHook.decode(text)
  if (Option.isNone(event)) return undefined
  const store = ConsoleStore.make()
  return CodexHook.checks(event.value, {
    directory: process.cwd(),
    platform: process.platform,
    servers: Object.keys(WorkspaceSnapshot.servers(WorkspaceSnapshot.read(store))),
    watchServer:
      event.value.tool_name?.startsWith(`mcp__${CodexHook.WATCH_SERVER}__`) === true &&
      (await import("./codex")).Codex.ownsWatchServer(store),
  })
}

/**
 * Adds the event watch updates that waited while the Codex session sat idle to the prompt the user just sent, and
 * starts the turn, which counts the session's wakes from zero again. A failure adds nothing and never blocks the prompt.
 */
async function codexPrompt(text: string) {
  const { Option } = await import("effect")
  const { CodexHook } = await import("./codex-hook")
  const { CodexWatches } = await import("./codex-watches")
  const { ConsoleStore } = await import("./store")
  const event = Option.getOrUndefined(CodexHook.decode(text))
  const context =
    event && (await withConsole(CodexWatches.promptSubmitted(ConsoleStore.make(), event)).catch(() => undefined))
  if (context)
    process.stdout.write(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } })}\n`,
    )
}

/**
 * Codex's event watch hooks (`CodexWatches`): `PostToolUse` and the background `UserPromptSubmit` (`--listen`), which
 * wait during the turn for the session's next update and print it for Codex's next model request; `Stop`, which
 * continues the turn with what arrived; and `Interrupt`. They never block anything by failing: whatever goes wrong,
 * they print nothing and exit 0.
 */
async function codexWatchHook(text: string): Promise<number> {
  const output = await Promise.resolve()
    .then(async () => {
      const { Effect, Option } = await import("effect")
      const { CodexHook } = await import("./codex-hook")
      const { CodexWatches } = await import("./codex-watches")
      const { ConsoleStore } = await import("./store")
      const event = Option.getOrUndefined(CodexHook.decode(text))
      if (!event) return undefined
      const store = ConsoleStore.make()
      if (event.hook_event_name === "Interrupt") {
        await withConsole(CodexWatches.interrupted(store, event))
        return undefined
      }
      if (event.hook_event_name === "Stop") {
        const reason = await withConsole(CodexWatches.stop(store, event))
        return reason === undefined ? undefined : { decision: "block", reason }
      }
      // Codex starts hooks through the shell, which a new parent means is gone; it ends their process group itself.
      const parent = process.ppid
      const host = { alive: Effect.sync(() => process.ppid === parent), harness }
      const context = await withConsole(
        event.hook_event_name === "PostToolUse"
          ? CodexWatches.postToolUse(store, event, host)
          : CodexWatches.duringTurn(store, event, host),
      )
      return context === undefined
        ? undefined
        : { hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: context } }
    })
    .catch(() => undefined)
  if (output) await flush(process.stdout, JSON.stringify(output))
  // Exits at once, so no connection the runtime keeps open holds the update back.
  return process.exit(0)
}

/**
 * Codex's `PostModelRequest` hook, which setup registers only while Codex keeps its own sign-in and there's a stats
 * target: reports the response's token counts with the stored workspace config's stats token, and nothing
 * else. The hook is synchronous, so it starts a process of its own to send the report and returns at once; whatever
 * happens it prints nothing and exits 0.
 */
async function codexUsage(text: string) {
  await Promise.resolve()
    .then(async () => {
      const { CodexUsage } = await import("./codex-usage")
      CodexUsage.reportInBackground(text, await codexUsageStats(), {
        version: harness?.match(/^codex_cli_rs\/(.+)$/)?.[1],
        now: Date.now(),
        command: ownCommand(),
      })
    })
    .catch(() => undefined)
  return 0
}

/**
 * Posts one usage report the hook built, in a process of its own so the hook returns at once. Only `hook codex` starts
 * it: the OTLP body arrives on stdin and the stats target comes from the stored workspace config, so no token appears on a
 * command line `ps` would show. Whatever happens it prints nothing and exits 0.
 */
async function reportCodexUsage() {
  await Promise.resolve()
    .then(async () => {
      const { CodexUsage } = await import("./codex-usage")
      await CodexUsage.post(await stdin(), await codexUsageStats())
    })
    .catch(() => undefined)
  return 0
}

/** Where the stored workspace has this connector send usage metadata, or undefined while no such workspace is signed in. */
async function codexUsageStats() {
  const { ConsoleStore } = await import("./store")
  const { ConsoleCredentials } = await import("./credentials")
  const { WorkspaceSnapshot } = await import("./snapshot")
  const store = ConsoleStore.make()
  const credential = ConsoleCredentials.read(store)
  const snapshot = credential && WorkspaceSnapshot.read(store)
  if (!credential || snapshot?.owner !== ConsoleCredentials.owner(credential)) return undefined
  return snapshot.stats
}

async function sessionStart() {
  const { ConsoleStore } = await import("./store")
  const { ConsoleCredentials } = await import("./credentials")
  const { WorkspaceSync } = await import("./workspace-sync")
  const store = ConsoleStore.make()
  const credential = ConsoleCredentials.read(store)
  if (!credential) return 0
  await background({ always: true, force: true })
  const status = WorkspaceSync.current(store, ConsoleCredentials.owner(credential))?.status
  if (status)
    process.stdout.write(
      `${JSON.stringify({ systemMessage: `${status.message}${status.url ? `: ${status.url}` : ""}` })}\n`,
    )
  return 0
}

/**
 * Decides checks with the stored workspace config, never calling the Console itself. A config older than a minute is
 * refreshed by a background `sync` for the next call; a sign-in with no config yet starts one and waits up to 3 seconds
 * for it. A signed-in workspace whose policy is still unknown after that is denied, so a Console outage never lifts
 * policy, and a refresh still in flight is never cut short.
 */
async function decide(inputs: readonly PolicyEvaluator.Input[]) {
  const { Effect } = await import("effect")
  const { ConsoleStore } = await import("./store")
  const { ConsoleCredentials } = await import("./credentials")
  const { WorkspaceSnapshot } = await import("./snapshot")
  const { PolicyEvaluator } = await import("./policy-evaluator")
  const store = ConsoleStore.make()
  const credential = ConsoleCredentials.read(store)
  const owner = credential && ConsoleCredentials.owner(credential)
  const cached = credential ? WorkspaceSnapshot.read(store) : undefined
  const snapshot =
    owner && cached?.owner !== owner
      ? await (async () => {
          await background({ always: true })
          return waitFor(() => {
            const next = WorkspaceSnapshot.read(store)
            return next?.owner === owner ? next : undefined
          }, 3_000)
        })()
      : cached && WorkspaceSnapshot.stale(cached, Date.now())
        ? (await background(), cached)
        : cached
  const workspace = WorkspaceSnapshot.workspace(credential, snapshot)
  const decisions = await Effect.runPromise(Effect.forEach(inputs, (input) => PolicyEvaluator.check(workspace, input)))
  // Only a decision says the build works; a hook that checked nothing proves nothing.
  if (inputs.length > 0)
    await import("./update/auto-update").then(({ AutoUpdate }) => AutoUpdate.healthy(store)).catch(() => undefined)
  return decisions
}

async function login() {
  const credential = await signIn()
  if (!credential) return 1
  if (process.env.OPENCODE_API_KEY)
    process.stderr.write("OPENCODE_API_KEY is set, so opencode-console keeps using that key until it's unset\n")
  return 0
}

/** Runs the device sign-in, fetches the workspace's config, and says who signed in to what. */
async function signIn() {
  const { Effect } = await import("effect")
  const { openUrl } = await import("@opencode/util/open")
  const { ConsoleClient } = await import("./console-client")
  const { ConsoleStore } = await import("./store")
  const { ConsoleCredentials } = await import("./credentials")
  const { WorkspaceSync } = await import("./workspace-sync")
  const requested = flag("server") ?? process.env.OPENCODE_CONSOLE_SERVER ?? ConsoleClient.defaultServer
  const server = ConsoleClient.normalizeServer(requested)
  if (!server) {
    process.stderr.write(`Not a Console URL: ${requested}\n`)
    return undefined
  }
  const store = ConsoleStore.make()
  const credential = await withConsole(
    ConsoleCredentials.login(store, {
      server,
      prompt: (device) =>
        Effect.promise(async () => {
          process.stderr.write(`Open ${device.url} and confirm the code ${device.code}\n`)
          if (process.stdout.isTTY) await openUrl(device.url).catch(() => undefined)
        }),
    }),
  )
  const result = await withConsole(WorkspaceSync.sync(store, { force: true }))
  process.stdout.write(
    `Signed in to ${credential.orgName ?? "OpenCode Console"}${credential.email ? ` as ${credential.email}` : ""}\n`,
  )
  if (result.error)
    process.stderr.write(
      `Couldn't fetch the workspace config: ${message(result.error)}. Run the command again to retry.\n`,
    )
  return credential
}

/**
 * Connects a coding agent to the workspace in one step: signs in when needed, installs this CLI where the agent's
 * settings can always run it, and writes those settings. `--remove` undoes it.
 */
async function setup() {
  const target = parsed.positionals[1]
  if (!target || !AGENTS.includes(target)) {
    process.stderr.write(
      `Usage: opencode-console setup <${AGENTS.join("|")}> [--keep-provider] [--profile <name>] [--remove]\n`,
    )
    return 1
  }
  const keepProvider = flags["keep-provider"] === true
  if (keepProvider && !VENDOR_SIGN_IN.includes(target)) {
    process.stderr.write("--keep-provider works with claude-code, codex and hermes\n")
    return 1
  }
  const pi = target === "pi"
  const codex = target === "codex"
  const dsh = target === "deepseek-harness"
  const hermes = target === "hermes"
  if (flag("profile") !== undefined && !hermes) {
    process.stderr.write("--profile works with hermes\n")
    return 1
  }
  const name = pi ? "Pi" : codex ? "Codex" : dsh ? "DeepSeek Harness" : hermes ? "Hermes Agent" : "Claude Code"
  const { ConsoleStore } = await import("./store")
  const { ConsoleCredentials } = await import("./credentials")
  const { CliInstall } = await import("./install")
  const { WorkspaceSync } = await import("./workspace-sync")
  const store = ConsoleStore.make()
  if (flags.remove === true) {
    const { Effect } = await import("effect")
    const { ClaudeCode } = await import("./claude-code")
    const { Codex } = await import("./codex")
    const { Pi } = await import("./pi")
    const { DeepSeekHarness } = await import("./deepseek-harness")
    const { Hermes } = await import("./hermes")
    const removed = await Effect.runPromise(
      ConsoleStore.locked(
        store,
        Effect.sync(() => {
          const done = pi
            ? Pi.remove(store)
            : codex
              ? Codex.remove(store)
              : dsh
                ? DeepSeekHarness.remove(store)
                : hermes
                  ? Hermes.remove(store, Hermes.paths({ profile: flag("profile") }).home)
                  : ClaudeCode.remove(store)
          // The installed copy stays while another agent's settings still run it.
          const used = [
            ClaudeCode.manifestFile(store),
            Pi.manifestFile(store),
            Codex.manifestFile(store),
            DeepSeekHarness.manifestFile(store),
            Hermes.manifestFile(store),
          ].some((file) => ConsoleStore.read(file) !== undefined)
          if (!used) CliInstall.uninstall(store)
          return done
        }),
      ),
    )
    process.stdout.write(
      removed
        ? `Removed OpenCode Console from ${name} and restored its settings. You're still signed in; \`npx @opencode/console logout\` signs out.\n`
        : `${name} wasn't set up with OpenCode Console\n`,
    )
    return 0
  }
  // From npm, setup installs the release binary for this computer and hands over to it, so hooks start fast, don't
  // depend on this Node, and update themselves. Where none fits, or the release service has none yet, it copies this
  // Node bundle, which follows npm instead.
  if (!compiled() && CliInstall.fromNpm(process.argv[1])) {
    const handed = await handOff()
    if (handed !== undefined) return handed
  }
  const { ConsoleClient } = await import("./console-client")
  // Asked first, so the very first config fetch names the agent to the Console, by the product token it sends itself.
  // Hermes's version can carry git build metadata (`0.23.0+12.ge075441`), which its own requests leave out.
  const found = await agentVersion(pi ? "pi" : codex ? "codex" : dsh ? "dsh" : hermes ? "hermes" : "claude")
  const agent = hermes ? found?.replace(/\+.*$/, "") : found
  if (agent)
    harness = pi
      ? `pi/${agent}`
      : codex
        ? `codex_cli_rs/${agent}`
        : dsh
          ? `deepseek-harness/${agent}`
          : hermes
            ? `HermesAgent/${agent}`
            : `claude-cli/${agent}`
  const signedIn = ConsoleCredentials.read(store)
  const requested = flag("server")
  if (!signedIn || (requested !== undefined && signedIn.server !== ConsoleClient.normalizeServer(requested)))
    if (!(await signIn())) return 1
  if (process.env.OPENCODE_API_KEY)
    process.stderr.write(
      `OPENCODE_API_KEY is set, so setup used that key, and ${name} will use it instead of your sign-in wherever it's set.\n`,
    )
  const synced = await withConsole(WorkspaceSync.sync(store, { force: true }))
  if (!synced.snapshot?.config) {
    process.stderr.write(
      `Couldn't fetch the workspace config${synced.error ? `: ${message(synced.error)}` : ""}. Run setup again.\n`,
    )
    return 1
  }
  const { Effect } = await import("effect")
  const command = await Effect.runPromise(
    ConsoleStore.locked(
      store,
      Effect.sync(() =>
        CliInstall.install(store, {
          execPath: process.execPath,
          entry: compiled() ? undefined : process.argv[1],
          path: process.env.PATH,
          sha256: compiled() ? process.env.OPENCODE_CONSOLE_RELEASE_SHA256 : undefined,
        }),
      ),
      "update",
    ),
  )
  // What's installed may be another build now, so the next check reads the channel rather than trust a 304.
  const { AutoUpdate } = await import("./update/auto-update")
  AutoUpdate.update(store, ({ etag: _etag, ...state }) => state)
  // Agents set up before by a copy of another shape, such as the Node bundle this binary replaced, run this one now.
  if (CliInstall.retarget(store, command).length > 0) await refreshAgents(store, true)
  if (codex) return setupCodex(store, command, synced.snapshot, agent, keepProvider)
  if (hermes) return setupHermes(store, command, synced.snapshot, agent, keepProvider)
  if (dsh) {
    const { DeepSeekHarness } = await import("./deepseek-harness")
    // The plugin sits beside the entry: the `dsh-plugin.js` the binary wrote or the npm bundle has, which DeepSeek
    // Harness loads with Node, or a source checkout's TypeScript.
    const entry = command.at(-1)!
    const applied = await withConsole(
      DeepSeekHarness.refresh(store, {
        paths: DeepSeekHarness.paths(),
        plugin: path.join(path.dirname(entry), `dsh-plugin${compiled() ? ".js" : path.extname(entry)}`),
        ...(harness ? { harness } : {}),
      }),
    )
    return applied ? reportDsh(applied, synced.snapshot, agent) : 1
  }
  return pi
    ? setupPi(store, command, synced.snapshot, agent)
    : setupClaude(store, command, synced.snapshot, agent, keepProvider)
}

async function reportDsh(
  applied: DeepSeekHarness.Applied,
  snapshot: WorkspaceSnapshot.Info,
  agent: string | undefined,
) {
  const { WorkspaceSnapshot } = await import("./snapshot")
  const routes = Object.values(applied.routes)
  const lines = [
    connected("DeepSeek Harness", snapshot.organization ?? "your workspace", Boolean(applied.model)),
    "",
    applied.model
      ? `  Models     ${count(routes.flatMap((route) => route.models).length, "model", "models")} from ${count(routes.length, "provider", "providers")}; new sessions start on ${applied.model.provider}/${applied.model.model}`
      : "  Models     none from the workspace, so DeepSeek Harness keeps its own providers",
    `  Policies   ${count(WorkspaceSnapshot.policies(snapshot)?.length ?? 0, "rule", "rules")}, checked before every tool call, /skill and model request`,
    ...(applied.servers.length > 0 ? [`  MCP        ${applied.servers.join(", ")}`] : []),
    ...instructionsAndSkills(
      applied.instructions,
      applied.skills.map((slug) => `/${slug}`),
    ),
  ]
  process.stdout.write(`${lines.join("\n")}\n`)
  if (applied.skipped.length > 0)
    process.stderr.write(`\nKept your own ${applied.skipped.join(", ")}, so the workspace's weren't added.\n`)
  if (applied.shadowed.length > 0)
    process.stderr.write(
      `\nThe model providers you added in the ${applied.shadowed.join(", ")} profile${applied.shadowed.length === 1 ? "" : "s"} are replaced by the workspace's while DeepSeek Harness is connected; --remove brings them back.\n`,
    )
  if (!agent) process.stderr.write("\nDeepSeek Harness isn't on your PATH yet; this applies once it's installed.\n")
  process.stdout.write("\nRun dsh web (or restart a running one) to start.\n")
  return 0
}

async function setupClaude(
  store: ConsoleStore.Info,
  command: readonly string[],
  snapshot: WorkspaceSnapshot.Info,
  claude: string | undefined,
  keepProvider: boolean,
) {
  const { ClaudeCode } = await import("./claude-code")
  const { WorkspaceSnapshot } = await import("./snapshot")
  const policies = WorkspaceSnapshot.policies(snapshot)
  const applied = await withConsole(
    ClaudeCode.refresh(store, {
      paths: ClaudeCode.paths(),
      command,
      harness: claude ? `claude-cli/${claude}` : undefined,
      keepProvider,
    }),
  )
  if (!applied) {
    process.stderr.write("Couldn't read the workspace config. Run setup again.\n")
    return 1
  }
  const workspace = snapshot.organization ?? "your workspace"
  const { ClaudeCodeHook } = await import("./claude-code-hook")
  const mcp = applied.servers.filter((name) => name !== ClaudeCodeHook.WATCH_SERVER)
  const lines = [
    connected("Claude Code", workspace, Boolean(applied.models)),
    "",
    ...(applied.models
      ? [
          `  Models     ${count(applied.models.options.length, "model", "models")} in /model; opus is ${applied.models.tiers.opus}, sonnet ${applied.models.tiers.sonnet}, haiku ${applied.models.tiers.haiku}`,
        ]
      : applied.keepProvider
        ? ["  Models     Claude Code keeps its own sign-in and models"]
        : ["  Models     none from the workspace, so Claude Code keeps its own sign-in"]),
    `  Policies   ${count(policies?.length ?? 0, "rule", "rules")}, checked before every tool call`,
    ...(mcp.length > 0 ? [`  MCP        ${mcp.join(", ")}`] : []),
    ...instructionsAndSkills(
      applied.instructions,
      applied.skills.map((slug) => `/${slug}`),
    ),
    ...(applied.watches
      ? ["  Watches    sessions wake when a Slack thread or GitHub pull request they work on changes"]
      : []),
    ...usageLine(applied.usage, workspace),
  ]
  process.stdout.write(`${lines.join("\n")}\n`)
  if (applied.skipped.length > 0)
    process.stderr.write(
      `\nKept your own ${applied.skipped.join(", ")}, so the workspace's of the same name weren't added.\n`,
    )
  if (applied.hooksTurnedOn) hooksTurnedOn("Turned off disableAllHooks", applied.hooksTurnedOn)
  if (applied.usage === "kept") process.stderr.write(`\n${keptOtel(["Claude Code"])}\n`)
  if (!claude) process.stderr.write("\nClaude Code isn't on your PATH yet; these settings apply once it's installed.\n")
  const overriding = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"].filter((name) => process.env[name])
  if (applied.models && overriding.length > 0)
    process.stderr.write(
      `\n${overriding.join(" and ")} ${overriding.length === 1 ? "is" : "are"} set in your shell and Claude Code would use ${overriding.length === 1 ? "it" : "them"} instead of the workspace. Unset ${overriding.length === 1 ? "it" : "them"} before running claude.\n`,
    )
  process.stdout.write("\nRun claude to start.\n")
  return 0
}

/**
 * Lists the Pi extension, from the installed copy, in Pi's settings, and starts new Pi sessions on the workspace's
 * default model. The extension does the rest in Pi's own process each time Pi starts.
 */
async function setupPi(
  store: ConsoleStore.Info,
  command: readonly string[],
  snapshot: WorkspaceSnapshot.Info,
  agent: string | undefined,
) {
  const { Pi } = await import("./pi")
  const { InProcess } = await import("./in-process")
  const { WorkspaceSnapshot } = await import("./snapshot")
  const entry = command.at(-1)!
  // The extension sits beside the entry: the `pi-extension.js` the binary wrote or the npm bundle has, or a source
  // checkout's TypeScript.
  const extension = path.join(path.dirname(entry), `pi-extension${compiled() ? ".js" : path.extname(entry)}`)
  const session = InProcess.session({ store, ...(harness ? { harness } : {}) })
  const document = await Pi.models(session)
  const model = document && Pi.defaultModel(document)
  // Pi downloads the workspace's skills again when it starts, so a failure here doesn't stop setup.
  await Pi.skills(session).catch((error: unknown) => {
    process.stderr.write(
      `Couldn't download the workspace's skills yet (${message(error)}); Pi tries again when it starts.\n`,
    )
    return undefined
  })
  const { Effect } = await import("effect")
  const { ConsoleStore } = await import("./store")
  await Effect.runPromise(
    ConsoleStore.locked(
      store,
      Effect.sync(() => Pi.setup(store, { paths: Pi.paths(), extension, ...(model ? { model } : {}) })),
    ),
  )
  const listed = document ? Pi.providers(document, () => undefined).flatMap((item) => item.models) : []
  const servers = Object.keys(WorkspaceSnapshot.servers(snapshot))
  const lines = [
    connected("Pi", snapshot.organization ?? "your workspace", Boolean(model)),
    "",
    model
      ? `  Models     ${count(listed.length, "model", "models")} in /model; new sessions start on ${model.provider}/${model.id}`
      : "  Models     none from the workspace, so Pi keeps its own providers",
    `  Policies   ${count(WorkspaceSnapshot.policies(snapshot)?.length ?? 0, "rule", "rules")}, checked before every tool call and !command`,
    ...(servers.length > 0 ? [`  MCP        ${servers.join(", ")}`] : []),
    ...instructionsAndSkills(
      WorkspaceSnapshot.instructions(snapshot).length,
      WorkspaceSnapshot.skills(snapshot).map((skill) => `/skill:${skill.slug}`),
    ),
  ]
  process.stdout.write(`${lines.join("\n")}\n`)
  if (!agent) process.stderr.write("\nPi isn't on your PATH yet; this applies once it's installed.\n")
  process.stdout.write("\nRun pi to start.\n")
  return 0
}

/**
 * Points Codex at the workspace: its models through the gateway, the policy hooks, approved as `/hooks` would, command
 * rules for literal shell denies, the workspace's MCP servers, and its instructions and skills.
 */
async function setupCodex(
  store: ConsoleStore.Info,
  command: readonly string[],
  snapshot: WorkspaceSnapshot.Info,
  agent: string | undefined,
  keepProvider: boolean,
) {
  const { Codex } = await import("./codex")
  const { WorkspaceSnapshot } = await import("./snapshot")
  // Codex runs the MCP header helper with a cleared environment, so it's given where the sign-in is and which Console
  // it's for. `OPENCODE_API_KEY` is a secret and never goes in Codex's config.
  const environment = Object.fromEntries(
    ["XDG_DATA_HOME", "XDG_CACHE_HOME", "OPENCODE_CONSOLE_SERVER"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  )
  const applied = await withConsole(
    Codex.refresh(store, {
      paths: Codex.paths(),
      command,
      harness: agent ? `codex_cli_rs/${agent}` : undefined,
      environment,
      keepProvider,
    }),
  )
  if (!applied) {
    process.stderr.write("Couldn't read the workspace config. Run setup again.\n")
    return 1
  }
  const policies = WorkspaceSnapshot.policies(snapshot)?.length ?? 0
  const workspace = snapshot.organization ?? "your workspace"
  const lines = [
    connected("Codex", workspace, Boolean(applied.models)),
    "",
    applied.models
      ? `  Models     ${count(applied.models.count, "model", "models")} in /model; new sessions start on ${applied.models.model}`
      : applied.keepProvider
        ? "  Models     Codex keeps its own sign-in and models"
        : "  Models     none from the workspace, so Codex keeps its own sign-in",
    `  Policies   ${count(policies, "rule", "rules")}, checked before every tool call${applied.rules > 0 ? `; Codex also enforces ${count(applied.rules, "shell rule", "shell rules")} itself` : ""}`,
    ...(applied.searchOff ? ["  Search     Codex's web search is off, since the workspace's policy limits it"] : []),
    ...(applied.servers.length > 0 ? [`  MCP        ${applied.servers.join(", ")}`] : []),
    ...instructionsAndSkills(
      applied.instructions,
      applied.skills.map((slug) => `$${slug}`),
    ),
    ...(applied.watches
      ? ["  Watches    Slack and GitHub updates reach a session during a turn, or with your next prompt"]
      : []),
    ...usageLine(applied.usage, workspace),
  ]
  process.stdout.write(`${lines.join("\n")}\n`)
  if (applied.skipped.length > 0)
    process.stderr.write(
      `\nKept your own ${applied.skipped.join(", ")}, so the workspace's of the same name weren't added.\n`,
    )
  if (applied.hooksTurnedOn) hooksTurnedOn("Turned on features.hooks", applied.hooksTurnedOn)
  const gateway = Object.entries(WorkspaceSnapshot.servers(snapshot))
    .filter(([name, server]) => server.headers !== undefined && applied.servers.includes(name))
    .map(([name]) => name)
  if (process.env.OPENCODE_API_KEY && gateway.length > 0)
    process.stderr.write(
      `\nCodex connects to ${gateway.join(", ")} without your shell's environment, so ${gateway.length === 1 ? "it" : "they"} can't use OPENCODE_API_KEY. Run \`npx @opencode/console login\` to connect ${gateway.length === 1 ? "it" : "them"}.\n`,
    )
  if (!agent) process.stderr.write("\nCodex isn't on your PATH yet; these settings apply once it's installed.\n")
  process.stdout.write("\nRun codex to start.\n")
  return 0
}

/**
 * Connects a Hermes Agent profile: the workspace's models through the gateway, the plugin that checks every tool call
 * and `/skill` turn, the workspace's MCP servers, and its instructions and skills.
 */
async function setupHermes(
  store: ConsoleStore.Info,
  command: readonly string[],
  snapshot: WorkspaceSnapshot.Info,
  agent: string | undefined,
  keepProvider: boolean,
) {
  const { Hermes } = await import("./hermes")
  const { WorkspaceSnapshot } = await import("./snapshot")
  // Hermes runs the plugin's and key_cmd's commands in its own environment, so they're given where the sign-in is and
  // which Console it's for. `OPENCODE_API_KEY` is a secret and never goes in Hermes's files.
  const environment = Object.fromEntries(
    ["XDG_DATA_HOME", "XDG_CACHE_HOME", "OPENCODE_CONSOLE_SERVER"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  )
  const paths = Hermes.paths({ profile: flag("profile") })
  const applied = await withConsole(
    Hermes.refresh(store, {
      paths,
      command,
      environment,
      harness: agent ? `HermesAgent/${agent}` : undefined,
      keepProvider,
    }),
  )
  if (!applied) {
    process.stderr.write("Couldn't read the workspace config. Run setup again.\n")
    return 1
  }
  const workspace = snapshot.organization ?? "your workspace"
  const lines = [
    connected("Hermes Agent", workspace, Boolean(applied.models)),
    "",
    `  Profile    ${paths.home}`,
    applied.models
      ? `  Models     ${count(Object.keys(applied.models.models).length, "model", "models")} in /model; new sessions start on ${applied.models.model}`
      : applied.keepProvider
        ? "  Models     Hermes keeps its own providers and models"
        : "  Models     none from the workspace, so Hermes keeps its own providers",
    `  Policies   ${count(WorkspaceSnapshot.policies(snapshot)?.length ?? 0, "rule", "rules")}, checked before every tool call and /skill, in chat, the messaging gateway and cron alike`,
    ...(applied.servers.length > 0 ? [`  MCP        ${applied.servers.join(", ")}`] : []),
    ...instructionsAndSkills(
      applied.instructions,
      applied.skills.map((slug) => `/${slug}`),
    ),
  ]
  process.stdout.write(`${lines.join("\n")}\n`)
  if (applied.skipped.length > 0)
    process.stderr.write(
      `\nKept your own ${applied.skipped.join(", ")}, so the workspace's of the same name weren't added.\n`,
    )
  if (!agent) process.stderr.write("\nHermes Agent isn't on your PATH yet; this applies once it's installed.\n")
  process.stdout.write(
    "\nRun hermes to start. Hermes loads plugins when its gateway starts, so restart a running one with hermes gateway restart.\n",
  )
  return 0
}

// The switch setup flipped governs the member's own hooks as well as setup's, so setup says so.
function hooksTurnedOn(change: string, file: string) {
  const home = `${os.homedir()}${path.sep}`
  process.stderr.write(
    `\n${change} in ${file.startsWith(home) ? path.join("~", file.slice(home.length)) : file}, so your other hooks run again too.\n`,
  )
}

// Setup's first line: an agent that runs the workspace's models "uses" it, one that keeps its own sign-in is only
// connected to it, so the line never suggests its inference moved.
function connected(agent: string, workspace: string, workspaceModels: boolean) {
  return workspaceModels
    ? `${agent} now uses ${workspace} through OpenCode Console.`
    : `${agent} is connected to ${workspace}.`
}

// What a harness that keeps its own sign-in shares with the workspace, in setup's and status's words.
function sharedUsage(workspace: string) {
  return `token counts and model names shared with ${workspace} (prompts and code never sent)`
}

function usageLine(usage: "shared" | "kept" | undefined, workspace: string) {
  return usage === "shared" ? [`  Usage      ${sharedUsage(workspace)}`] : []
}

function keptOtel(agents: readonly string[]) {
  return `Kept your own OpenTelemetry setup in ${agents.join(" and ")}, so ${agents.length === 1 ? "it shares" : "they share"} no usage metadata with the workspace.`
}

function instructionsAndSkills(instructions: number, skills: readonly string[]) {
  if (instructions + skills.length === 0) return []
  return [
    `  Extensions ${[...(instructions > 0 ? [count(instructions, "instruction", "instructions")] : []), ...(skills.length > 0 ? [skills.join(", ")] : [])].join(", ")}`,
  ]
}

/** Prints the headers a workspace MCP server needs, for Claude Code's `headersHelper`. */
async function mcpHeaders() {
  const name = parsed.positionals[1]
  if (!name) {
    process.stderr.write("Usage: opencode-console mcp-headers <server>\n")
    return 1
  }
  const { Option, Schema } = await import("effect")
  const { ConsoleStore } = await import("./store")
  const { WorkspaceSync } = await import("./workspace-sync")
  await noticeHooks()
  const { snapshot } = await withConsole(WorkspaceSync.sync(ConsoleStore.make()))
  if (!snapshot) {
    process.stderr.write(`${NOT_SIGNED_IN}\n`)
    return 1
  }
  const servers = Schema.decodeUnknownOption(
    Schema.Struct({
      servers: Schema.Record(
        Schema.String,
        Schema.Struct({ headers: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
      ),
    }),
  )(snapshot.config?.mcp)
  const server = Option.getOrUndefined(servers)?.servers[name]
  if (!server) {
    process.stderr.write(`The workspace doesn't offer the MCP server ${name} anymore\n`)
    return 1
  }
  process.stdout.write(`${JSON.stringify(server.headers ?? {})}\n`)
  return 0
}

/**
 * Serves the `watch`, `unwatch`, `watches` and `events` tools over stdio MCP, one JSON-RPC message per line, until the
 * harness closes stdin. Messages are answered in order; stdout carries nothing else.
 */
async function mcpWatches() {
  const { createInterface } = await import("node:readline")
  const { ConsoleStore } = await import("./store")
  const { McpWatches } = await import("./mcp-watches")
  const store = ConsoleStore.make()
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    const response = await withConsole(
      McpWatches.handle({ store, hostPid: process.ppid, nextPrompt: flags["next-prompt"] === true }, line),
    )
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
  }
  return 0
}

/**
 * Prints the headers Claude Code's usage export sends, for its `otelHeadersHelper`, from the stored workspace config.
 * Claude Code's hooks keep that fresh while it runs (every session start, and each minute it's in use), and the
 * Console's token stays valid for weeks, so this asks the Console itself only when there's no stored config for the
 * sign-in or it's a day old. Claude Code shows a warning when the helper fails, so signed out, offline with no stored
 * config, or with no stats target, it prints `{}` and still exits 0.
 */
async function otelHeaders() {
  const { ConsoleStore } = await import("./store")
  const { ConsoleCredentials } = await import("./credentials")
  const { WorkspaceSync } = await import("./workspace-sync")
  const headers = await Promise.resolve()
    .then(async () => {
      const store = ConsoleStore.make()
      const credential = ConsoleCredentials.read(store)
      if (!credential) return undefined
      await noticeHooks()
      const stored = WorkspaceSync.current(store, ConsoleCredentials.owner(credential))
      if (stored && Date.now() - stored.fetched < 86_400_000) return stored.stats?.headers
      return (await withConsole(WorkspaceSync.sync(store))).snapshot?.stats?.headers
    })
    .catch(() => undefined)
  process.stdout.write(`${JSON.stringify(headers ?? {})}\n`)
  return 0
}

async function logout() {
  const { ConsoleStore } = await import("./store")
  const { ConsoleCredentials } = await import("./credentials")
  const signedOut = await withConsole(ConsoleCredentials.logout(ConsoleStore.make()))
  process.stdout.write(signedOut ? "Signed out of OpenCode Console\n" : "Not signed in\n")
  if (process.env.OPENCODE_API_KEY)
    process.stdout.write("OPENCODE_API_KEY is still set, so opencode-console keeps using that key\n")
  return 0
}

async function status() {
  const { ConsoleStore } = await import("./store")
  const { ConsoleCredentials } = await import("./credentials")
  const { WorkspaceSnapshot } = await import("./snapshot")
  const { WorkspaceSync } = await import("./workspace-sync")
  const { ClaudeCode } = await import("./claude-code")
  const { Codex } = await import("./codex")
  const { HooksCheck } = await import("./hooks-check")
  const store = ConsoleStore.make()
  const credential = ConsoleCredentials.read(store)
  const snapshot = credential ? (await withConsole(WorkspaceSync.sync(store))).snapshot : undefined
  const policies = WorkspaceSnapshot.policies(snapshot)
  // What the last setup or sync wrote decides whether a harness exports usage metadata now.
  const usage = [
    { agent: "claude-code", name: "Claude Code", usage: ClaudeCode.manifest(store)?.usage },
    { agent: "codex", name: "Codex", usage: Codex.manifest(store)?.usage },
  ]
  const info = credential && {
    server: credential.server,
    credential: credential.type === "key" ? ("OPENCODE_API_KEY" as const) : ("device" as const),
    email: credential.type === "oauth" ? credential.email : undefined,
    workspace: snapshot?.organization ?? ConsoleCredentials.organization(credential),
    synced: policies && snapshot ? new Date(snapshot.fetched).toISOString() : undefined,
    policies: policies?.length,
    models: WorkspaceSnapshot.models(snapshot),
    usageMetadata: {
      shared: usage.filter((item) => item.usage === "shared").map((item) => item.agent),
      kept: usage.filter((item) => item.usage === "kept").map((item) => item.agent),
    },
    hooksOff: HooksCheck.all(store),
    needs: snapshot?.status,
  }
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify({ signedIn: Boolean(info), ...info })}\n`)
    return 0
  }
  if (!info) {
    process.stdout.write(`${NOT_SIGNED_IN}\n`)
    return 0
  }
  // A key's workspace name isn't known to the CLI, so its line is left out.
  const lines = [
    ["Signed in", info.credential === "OPENCODE_API_KEY" ? "with OPENCODE_API_KEY" : (info.email ?? "yes")],
    ...(info.workspace ? [["Workspace", info.workspace]] : []),
    ["Console", info.server],
    [
      "Policies",
      info.synced
        ? `${count(info.policies ?? 0, "policy", "policies")}, synced at ${new Date(info.synced).toLocaleTimeString()}`
        : "not loaded yet, so tool calls are blocked",
    ],
    ["Models", info.models ? `${info.models} from the workspace` : "none from the workspace"],
  ]
  process.stdout.write(lines.map(([label, value]) => `${label?.padEnd(10)} ${value}\n`).join(""))
  const kept = usage.filter((item) => item.usage === "kept").map((item) => item.name)
  const usageLines = [
    ...(info.usageMetadata.shared.length > 0
      ? [`Usage metadata: ${sharedUsage(info.workspace ?? "your workspace")}`]
      : []),
    ...(kept.length > 0 ? [keptOtel(kept)] : []),
  ]
  if (usageLines.length > 0) process.stdout.write(`\n${usageLines.join("\n")}\n`)
  if (info.hooksOff.length > 0)
    process.stdout.write(`\n${info.hooksOff.map((found) => HooksCheck.message(found)).join("\n")}\n`)
  if (info.needs) process.stdout.write(`\n${info.needs.message}${info.needs.url ? `: ${info.needs.url}` : ""}\n`)
  return 0
}

/**
 * Fetches the workspace config now, and brings a coding agent set up with `setup` up to date with it. `--quiet` is how
 * hooks run it in the background, only when it's stale.
 */
async function sync() {
  const { ConsoleStore } = await import("./store")
  const { WorkspaceSnapshot } = await import("./snapshot")
  const { WorkspaceSync } = await import("./workspace-sync")
  const store = ConsoleStore.make()
  const before = WorkspaceSnapshot.read(store)?.fetched
  await checkHooks()
  // After an update or a rollback, the build now installed writes what it gives every agent, config fetched or not.
  // Its own extension and plugin go first, since nothing about them needs the Console.
  const agents = flags["refresh-agents"] === true
  if (agents) await materialize(store)
  const result = await withConsole(
    WorkspaceSync.sync(store, { force: flags.quiet !== true || process.env.OPENCODE_CONSOLE_FORCE === "1" }),
  )
  // Only a config fetched now can change what the agent was given, unless the CLI itself changed.
  if (agents || (result.snapshot?.config && !result.error && result.snapshot.fetched !== before))
    await refreshAgents(store, flags.quiet === true)
  if (!agents) await checkForUpdate(store, process.env.OPENCODE_CONSOLE_FORCE === "1")
  if (flags.quiet === true) return result.error ? 1 : 0
  if (!result.snapshot && !result.error) {
    process.stderr.write(`${NOT_SIGNED_IN}\n`)
    return 1
  }
  if (result.error) {
    const kept = WorkspaceSnapshot.policies(result.snapshot) ? "\nPolicies from the last sync still apply." : ""
    process.stderr.write(`Couldn't sync: ${message(result.error)}${kept}\n`)
    return 1
  }
  const organization = result.snapshot?.organization
  const policies = WorkspaceSnapshot.policies(result.snapshot)?.length ?? 0
  process.stdout.write(
    `Synced ${organization ? `${organization}'s` : "the workspace"} config (${count(policies, "policy", "policies")})\n`,
  )
  return 0
}

/**
 * Brings every agent setup connected up to date with the stored config and this build: their settings, hooks and
 * plugin files. A compiled binary first writes the Pi extension and DeepSeek Harness plugin it carries beside itself.
 */
async function refreshAgents(store: ConsoleStore.Info, quiet: boolean) {
  const { ClaudeCode } = await import("./claude-code")
  const { Codex } = await import("./codex")
  const { DeepSeekHarness } = await import("./deepseek-harness")
  const { Hermes } = await import("./hermes")
  const failed = (agent: string) => (error: unknown) => {
    if (!quiet) process.stderr.write(`Couldn't update ${agent}: ${message(error)}\n`)
  }
  await materialize(store)
  await withConsole(ClaudeCode.refresh(store)).catch(failed("Claude Code"))
  await withConsole(Codex.refresh(store)).catch(failed("Codex"))
  await withConsole(DeepSeekHarness.refresh(store)).catch(failed("DeepSeek Harness"))
  await withConsole(Hermes.refresh(store, undefined, harness)).catch(failed("Hermes Agent"))
}

/** Writes the extension and plugin a compiled binary carries beside the install, and keeps Pi loading the installed one. */
async function materialize(store: ConsoleStore.Info) {
  const { CliInstall } = await import("./install")
  const { Pi } = await import("./pi")
  if (!compiled() || CliInstall.receipt(store) === undefined) return
  CliInstall.materialize(store)
  Pi.refresh(store, path.join(CliInstall.directory(store), "pi-extension.js"))
}

/** Starts a background update when one is due, for an install that updates itself. Never fails the caller. */
async function checkForUpdate(store: ConsoleStore.Info, session: boolean) {
  await Promise.resolve()
    .then(async () => {
      const { AutoUpdate } = await import("./update/auto-update")
      AutoUpdate.start(store, { running: runningFile(), session })
    })
    .catch(() => undefined)
}

/** `self-test`: whether this build decides policy and loads every agent's code, before an update installs it. */
async function selfTest() {
  const { SelfTest } = await import("./self-test")
  return SelfTest.run()
}

/** `self-update`: the background update a hook starts when one is due. Its output goes to `logs/auto-update.log`. */
async function selfUpdate() {
  const { ConsoleStore } = await import("./store")
  const { AutoUpdate } = await import("./update/auto-update")
  const { SelfUpdate } = await import("./update/self-update")
  const store = ConsoleStore.make()
  if (!AutoUpdate.managed(store, runningFile())) {
    process.stderr.write("self-update: this copy of opencode-console isn't one setup installed\n")
    return 2
  }
  const outcome = await SelfUpdate.run(store)
  process.stdout.write(`${new Date().toISOString()} ${JSON.stringify(outcome)}\n`)
  return outcome.status === "failed" ? 1 : 0
}

/** `update [--check]`: checks the install's release channel now, and installs its current build unless `--check`. */
async function update() {
  const { ConsoleStore } = await import("./store")
  const { AutoUpdate } = await import("./update/auto-update")
  const { SelfUpdate } = await import("./update/self-update")
  const store = ConsoleStore.make()
  if (!AutoUpdate.managed(store, runningFile())) {
    process.stderr.write(
      "This copy of opencode-console doesn't update itself. Run `npx @opencode/console setup <agent>` to install one that does, or update it the way it was installed.\n",
    )
    return 1
  }
  // Asked for by the member, so a build rolled back after crashing installs again.
  const outcome = await SelfUpdate.run(store, { check: flags.check === true, force: flags.check !== true })
  if (outcome.status === "failed") {
    process.stderr.write(`Couldn't update: ${outcome.message}\n`)
    return 1
  }
  process.stdout.write(
    `${
      outcome.status === "up-to-date"
        ? `Up to date: ${outcome.version}${outcome.detail ? ` (${outcome.detail})` : ""}`
        : outcome.status === "available"
          ? `${outcome.to} is available (you have ${outcome.from}). Run \`opencode-console update\` to install it.`
          : outcome.status === "installed"
            ? `Updated ${outcome.from} to ${outcome.to}.${outcome.refreshed ? "" : " Some agents' settings weren't updated; run `opencode-console sync --refresh-agents`."}`
            : outcome.status === "blocked"
              ? `${outcome.version} was rolled back after it kept crashing, so it isn't installed again.`
              : "This copy of opencode-console doesn't update itself."
    }\n`,
  )
  return 0
}

/**
 * `setup` run from npm: downloads, verifies and self-tests the release binary for this computer, then runs the same
 * setup with it, which installs it. Undefined, so the Node bundle is installed instead, where there's no binary to use.
 */
async function handOff() {
  const { CliInstall } = await import("./install")
  const { ConsoleStore } = await import("./store")
  const { SelfUpdate } = await import("./update/self-update")
  const store = ConsoleStore.make()
  // A binary already installed on this channel sets up the next agent itself, and updates as it would anyway, so
  // setup never brings back a build that was rolled back.
  const installed = CliInstall.receipt(store)
  if (
    installed?.method === "direct" &&
    installed.channel === CliInstall.channelOf(version) &&
    existsSync(CliInstall.binary(store))
  )
    return launch(CliInstall.binary(store), {})
  const staged = await SelfUpdate.stageForSetup({ version }).catch((error: unknown) => {
    process.stderr.write(`Couldn't use the release binary (${message(error)}), so setup installs the Node package.\n`)
    return undefined
  })
  if (!staged) return undefined
  const code = await launch(staged.binary, { OPENCODE_CONSOLE_RELEASE_SHA256: staged.sha256 })
  staged.cleanup()
  return code

  function launch(binary: string, env: Record<string, string>) {
    return new Promise<number | undefined>((resolve) =>
      spawn(binary, process.argv.slice(2), { stdio: "inherit", env: { ...process.env, ...env } })
        .on("error", () => resolve(undefined))
        .on("exit", (exit) => resolve(exit ?? 1)),
    )
  }
}

/**
 * Prints an access token valid for at least five minutes, for harness auth helpers such as Claude Code's
 * `apiKeyHelper`. With `--json`, `{"access_token":"…","expires_in":<seconds>}`, for helpers that cache a token as long
 * as it says it lasts, as Hermes's `key_cmd` does (a key has no expiry, so it says none).
 */
async function token() {
  const { ConsoleStore } = await import("./store")
  const { ConsoleCredentials } = await import("./credentials")
  const credential = await withConsole(ConsoleCredentials.fresh(ConsoleStore.make()))
  if (!credential) {
    process.stderr.write(`${NOT_SIGNED_IN}\n`)
    return 1
  }
  await noticeHooks()
  const access = credential.type === "key" ? credential.key : credential.access
  process.stdout.write(
    flags.json === true
      ? `${JSON.stringify({
          access_token: access,
          ...(credential.type === "key" ? {} : { expires_in: Math.floor((credential.expires - Date.now()) / 1000) }),
        })}\n`
      : `${access}\n`,
  )
  return 0
}

/**
 * Prints the gateway MCP servers' headers as `{"env":{"OPENCODE_CONSOLE_MCP_<SERVER>_<HEADER>":"…"},"version":"…"}`,
 * for the secret source of setup's Hermes plugin, which supplies them to the `\${…}` names `config.yaml` gives them.
 * The gateway's token lasts two days or more, so a stored config up to 12 hours old serves; an older one, or none, is
 * fetched first.
 */
async function mcpEnv() {
  const { ConsoleStore } = await import("./store")
  const { ConsoleCredentials } = await import("./credentials")
  const { WorkspaceSync } = await import("./workspace-sync")
  const { Hermes } = await import("./hermes")
  const store = ConsoleStore.make()
  const credential = ConsoleCredentials.read(store)
  const stored = credential && WorkspaceSync.current(store, ConsoleCredentials.owner(credential))
  const snapshot =
    stored && Date.now() - stored.fetched < 12 * 3_600_000
      ? stored
      : credential && (await withConsole(WorkspaceSync.sync(store))).snapshot
  if (!snapshot) {
    process.stderr.write(`${NOT_SIGNED_IN}\n`)
    return 1
  }
  process.stdout.write(`${JSON.stringify(Hermes.mcpEnvironment(snapshot))}\n`)
  return 0
}

/** Finds the calling agent's hooks off or not, so this run's Console requests say which. Never fails its caller. */
async function checkHooks() {
  const { HooksCheck } = await import("./hooks-check")
  const { ConsoleStore } = await import("./store")
  const found = HooksCheck.find(ConsoleStore.make(), harness)
  hooksOff = found !== undefined
  return found
}

/**
 * With the calling agent's hooks off, no hook runs to tell anyone. The helpers it still calls for its token and headers
 * (`token`, `mcp-headers`, `otel-headers`) do: they warn the session once, and start a config fetch that names the hooks
 * as off, so admins see it. The hook that fetches the config says so too once it runs (`sync`).
 */
async function noticeHooks() {
  await Promise.resolve()
    .then(async () => {
      const found = await checkHooks()
      if (!found) return
      const { HooksCheck } = await import("./hooks-check")
      const { ConsoleStore } = await import("./store")
      const due = HooksCheck.due(ConsoleStore.make(), found.agent, { now: Date.now(), session: process.ppid })
      if (due.warn) HooksCheck.warn(HooksCheck.message(found))
      if (due.report) await background({ always: true, force: true })
    })
    .catch(() => undefined)
}

/** Runs a Console request with the CLI's and harness's identity on every call. */
async function withConsole<A, E>(body: Effect.Effect<A, E, HttpClient.HttpClient>) {
  const { Effect, Layer } = await import("effect")
  const { FetchHttpClient } = await import("effect/http")
  const { WorkspaceSync } = await import("./workspace-sync")
  return Effect.runPromise(
    body.pipe(
      Effect.provide(WorkspaceSync.identify({ version, harness, hooksOff }).pipe(Layer.provide(FetchHttpClient.layer))),
    ),
  )
}

// Detached, so a harness never waits on the Console and a refresh outlives the check that started it; the next check
// reads what it stored. At most one starts every 30 seconds, so a Console outage doesn't start a process on every tool
// call. A store or process failure here never stops the check from deciding.
async function background(options: { readonly always?: boolean; readonly force?: boolean } = {}) {
  const { ConsoleStore } = await import("./store")
  const claim = ConsoleStore.syncClaimFile(ConsoleStore.make())
  try {
    const claimed = ConsoleStore.modified(claim)
    if (!options.always && claimed !== undefined && Date.now() - claimed < 30_000) return
    ConsoleStore.write(claim, "")
    const [command, ...args] = ownCommand()
    spawn(command!, [...args, "sync", "--quiet", ...(harness ? ["--harness", harness] : [])], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...(options.force ? { OPENCODE_CONSOLE_FORCE: "1" } : {}) },
    })
      .on("error", () => undefined)
      .unref()
  } catch {
    return
  }
}

/** How this CLI runs itself again: the compiled binary, or the runtime and the entry of the npm bundle or a checkout. */
function ownCommand() {
  return compiled() ? [process.execPath] : [process.execPath, process.argv[1]!]
}

async function waitFor<A>(read: () => A | undefined, timeout: number) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = read()
    if (value !== undefined || Date.now() >= deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Blocks what a hook was asked about, in its event's format, with exit code 2. */
async function refuse(reason: string) {
  if (parsed.positionals[1] === "hermes") {
    process.stdout.write(`${JSON.stringify({ action: "block", message: reason })}\n`)
    process.stderr.write(`${reason}\n`)
    return 2
  }
  const { ClaudeCodeHook } = await import("./claude-code-hook")
  const answer = ClaudeCodeHook.denial(hookEvent, reason)
  process.stdout.write(answer.stdout)
  process.stderr.write(answer.stderr)
  return answer.code
}

// A coding agent's version, which names it to the Console, or undefined when it isn't installed.
async function agentVersion(binary: string) {
  const { exec } = await import("node:child_process")
  return new Promise<string | undefined>((resolve) =>
    // Through the shell, since npm installs an agent on Windows as a `.cmd` shim, which only a shell can start.
    exec(`${binary} --version`, { timeout: 10_000 }, (error, stdout) =>
      resolve(error ? undefined : stdout.match(/\d+\.\d+\.\d+\S*/)?.[0]),
    ),
  )
}

/** Answers a check with a denial: the decision on stdout, exit code 2. */
function deny(reason: string) {
  process.stdout.write(`${JSON.stringify({ effect: "deny", message: reason })}\n`)
  return 2
}

function count(value: number, one: string, many: string) {
  return `${value} ${value === 1 ? one : many}`
}

// A compiled binary runs its entry point from Bun's embedded filesystem.
function compiled() {
  return /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(process.argv[1] ?? "")
}

/** The file this process runs from: the binary itself, or the Node bundle's or a checkout's script. */
function runningFile() {
  return compiled() ? process.execPath : (process.argv[1] ?? process.execPath)
}

async function stdin() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function flag(name: string) {
  const value = flags[name]
  return typeof value === "string" ? value : undefined
}

function usage() {
  return `opencode-console ${version}
Connect coding agents to an OpenCode Console workspace: its models, MCP servers, instructions, skills and policies.

Usage: opencode-console <command> [options]

Commands:
  setup <claude-code|pi|codex|deepseek-harness|hermes>
                          Sign in if needed and set up Claude Code, Pi, Codex, DeepSeek Harness or
                          Hermes Agent to use the workspace (--remove undoes it). With
                          --keep-provider, Claude Code, Codex or Hermes keeps its own sign-in and
                          models; --profile <name> picks a Hermes profile
  login [--server <url>]  Sign in to OpenCode Console and pick a workspace
  logout                  Sign out and remove the stored workspace config
  status [--json]         Show the sign-in, workspace and config
  sync                    Fetch the workspace config now (--refresh-agents rewrites every agent's
                          settings too)
  update [--check]        Install the newest build on this install's release channel now (--check
                          only says whether there is one). Installs setup made update themselves
  token [--json]          Print an access token for auth helpers such as Claude Code's apiKeyHelper,
                          Codex's model provider auth and Hermes's key_cmd (--json adds its expiry)
  check                   Check a tool call against the workspace's policies. Reads
                          {"action": "...", "resources": [...]} on stdin, with optional
                          "directory", "path" and "shell"; exits 0 to allow, 2 to deny
  hook <claude-code|codex|hermes>
                          Answer a Claude Code, Codex or Hermes plugin hook (setup registers it)
  mcp-headers <server>    Print a workspace MCP server's headers (setup registers it)
  mcp-watches             Serve the watch, unwatch, watches and events tools over stdio MCP
                          (setup registers it). With --next-prompt, they say an idle session gets
                          updates with the next prompt
  otel-headers            Print the headers Claude Code's usage export sends (setup registers it)

Options:
  --server <url>            The Console to sign in to (or set OPENCODE_CONSOLE_SERVER)
  --harness <name/version>  Identify the calling agent to the Console, e.g. claude-cli/2.1.304
                            (or set OPENCODE_CONSOLE_HARNESS)

Set OPENCODE_API_KEY to use a personal or service account key instead of signing in.
Set OPENCODE_CONSOLE_SERVER to use a Console other than https://opencode.ai/console.
Set OPENCODE_CONSOLE_AUTO_UPDATE=off to stop installs from updating themselves.
`
}
