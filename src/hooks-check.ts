export * as HooksCheck from "./hooks-check"

import { writeFileSync } from "node:fs"
import { Option, Schema } from "effect"
import { ClaudeCode } from "./claude-code"
import { Codex } from "./codex"
import { Hermes } from "./hermes"
import { ConsoleStore } from "./store"

/** What keeps an agent's policy hooks from running, and what puts them back when that's something other than setup. */
export interface Off {
  readonly reason: string
  readonly fix?: string
}

export interface Input {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
}

export interface Found extends Off {
  readonly agent: Agent
}

// Each agent whose policy hooks its own settings can switch off, by the product token that names it to the Console.
// Pi's extension and DeepSeek Harness's plugin run inside the agent and carry its models and token themselves, so an
// agent that stops loading them stops using the workspace's models too, and there's nothing else to read.
const agents = {
  "claude-code": { name: "Claude Code", token: "claude-cli/", check: ClaudeCode.hooksOff },
  codex: { name: "Codex", token: "codex_cli_rs/", check: Codex.hooksOff },
  hermes: { name: "Hermes Agent", token: "HermesAgent/", check: Hermes.hooksOff },
}
const names = ["claude-code", "codex", "hermes"] as const satisfies ReadonlyArray<keyof typeof agents>
export type Agent = (typeof names)[number]

// A warning or report at most this often. Warnings are per session, keyed by the process that ran the helper; the
// floor keeps an agent that runs helpers through a throwaway shell from warning on every token. Console records a
// client at most hourly (`MemberClient.WRITE_INTERVAL_MS`), so a report any sooner would be dropped.
const NOTICE_INTERVAL_MS = 60 * 60 * 1000

const defaults = (): Input => ({ env: process.env, cwd: process.cwd() })

const check = (store: ConsoleStore.Info, agent: Agent, input: Input): Found | undefined => {
  // A settings file that can't be read says nothing either way, and a check must never stop the helper it runs in.
  try {
    const off = agents[agent].check(store, input)
    return off && { ...off, agent }
  } catch {
    return undefined
  }
}

/** Whether the agent `harness` names, the one running this process, has its policy hooks off. */
export function find(store: ConsoleStore.Info, harness: string | undefined, input = defaults()) {
  const agent = names.find((name) => harness?.startsWith(agents[name].token))
  return agent && check(store, agent, input)
}

/** Every agent set up on this machine whose policy hooks are off, for `status`. */
export function all(store: ConsoleStore.Info, input = defaults()) {
  return names.flatMap((agent) => check(store, agent, input) ?? [])
}

/** The one line that tells a developer their hooks are off and how to put them back. */
export function message(found: Found) {
  return `OpenCode Console: policy hooks are off in ${agents[found.agent].name} (${found.reason}), so your workspace's rules aren't enforced and its admins can see that. ${found.fix ?? `Run npx @opencode/console setup ${found.agent}`}.`
}

const Notice = Schema.Struct({
  warned: Schema.Number,
  reported: Schema.Number,
  sessions: Schema.Array(Schema.Number),
})
const decodeNotice = Schema.decodeUnknownOption(Schema.fromJsonString(Notice))

/**
 * Whether to warn this session, and report to the Console, about hooks found off, recording that this run does. Reading
 * the state and writing it aren't atomic: two helpers starting at once can both warn, which is harmless.
 */
export function due(store: ConsoleStore.Info, agent: Agent, input: { readonly now: number; readonly session: number }) {
  const file = ConsoleStore.hooksNoticeFile(store, agent)
  const last = Option.getOrUndefined(decodeNotice(ConsoleStore.read(file) ?? ""))
  const warn = !last?.sessions.includes(input.session) && input.now - (last?.warned ?? 0) >= NOTICE_INTERVAL_MS
  const report = input.now - (last?.reported ?? 0) >= NOTICE_INTERVAL_MS
  if (warn || report)
    ConsoleStore.write(
      file,
      JSON.stringify({
        warned: warn ? input.now : (last?.warned ?? 0),
        reported: report ? input.now : (last?.reported ?? 0),
        // Only the most recent sessions, since a process ID is reused eventually.
        sessions: warn ? [...(last?.sessions ?? []), input.session].slice(-16) : (last?.sessions ?? []),
      }),
    )
  return { warn, report }
}

/**
 * Says `text` where the developer can see it. An agent reads a helper's stdout and throws its stderr away when the
 * helper succeeds, so the line also goes to the terminal directly; there may be none, as in CI or a messaging gateway.
 */
export function warn(
  text: string,
  output: { readonly stderr?: Pick<NodeJS.WriteStream, "isTTY" | "write">; readonly tty?: string } = {},
) {
  const stderr = output.stderr ?? process.stderr
  stderr.write(`${text}\n`)
  if (stderr.isTTY) return
  try {
    writeFileSync(output.tty ?? "/dev/tty", `\r\n${text}\r\n`)
  } catch {
    return
  }
}
