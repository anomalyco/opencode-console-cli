export * as McpWatches from "./mcp-watches"

import { EventWatch } from "./event-watch"
import { Effect, Option, Schema } from "effect"
import { version } from "../package.json" with { type: "json" }
import { ConsoleClient } from "./console-client"
import type { ConsoleStore } from "./store"
import { ConsoleWatches } from "./watches"

// `opencode-console mcp-watches`: the `watch`, `unwatch`, `watches` and `events` tools OpenCode has built in, as a local
// stdio MCP server for harnesses that load tools only over MCP (Claude Code, Codex). It answers one JSON-RPC message at
// a time, for the session each call names in its `_meta`, or else the session the harness process that started this
// server last said it runs (`ConsoleWatches.bindHostPid`). With `nextPrompt`, for a harness that can't start a turn on
// its own (Codex), the tools say an idle session gets updates with the user's next prompt instead of waking.

/** The most of an event type's description `events` shows. */
const MAX_DESCRIPTION = 300

/** The MCP versions this server speaks, newest first; it answers a client's own version when it's one of them. */
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

const watched =
  "a Slack thread or a GitHub pull request, issue, commit or Actions run gets a reply or changes status, or one of the workspace's MCP servers sends an event `events` lists"

const watching =
  "Slack and GitHub writes through OpenCode Console, `gh pr create` and `git push` are watched automatically when Console lets this account watch them, so don't watch what you just made. Use it for anything else, such as `gh workflow run` or a link the user shared. People often answer a Slack post in the channel rather than its thread, so after each top-level post the channel's new top-level messages are watched for 15 minutes too."

/** The tools, as MCP lists them; the Pi extension registers the same ones. */
export const tools = [
  {
    name: "watch",
    description: `Wake this session when ${watched}. ${watching} The session wakes with the update, so don't poll.`,
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            "A Slack message or thread link, a GitHub pull request, issue, commit or Actions run link, owner/repo#123, or owner/repo@<full commit SHA>",
        },
        server: { type: "string", description: "Instead of target: the server of an event type `events` lists" },
        event: { type: "string", description: "The event type's name, with server" },
        arguments: { type: "object", description: "The event type's arguments, as its input schema describes" },
        minutes: {
          type: "integer",
          minimum: 1,
          maximum: 20160,
          description: "How long to watch from now, in minutes; the event type's own default otherwise",
        },
      },
    },
  },
  {
    name: "unwatch",
    description:
      "Stop a watch this session keeps, by the ID `watches` lists, when the user asks. Watches end on their own and finished pull requests wind down by themselves, so don't unwatch to tidy up or quiet updates.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "watches",
    description: "List what this session watches, with each watch's ID and when it ends.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "events",
    description:
      "List the event types `watch` can follow on the workspace's MCP servers, with each one's server, name, description and input schema.",
    inputSchema: { type: "object", properties: {} },
  },
]

// Codex can't start a turn on its own (developers.openai.com/codex/hooks, "How background hooks run").
const nextPromptTools = tools.map((tool) =>
  tool.name === "watch"
    ? {
        ...tool,
        description: `Get updates when ${watched}. ${watching} Updates arrive during a turn, or when it ends, and continue it. This session can't wake on its own: an update that arrives while it's idle waits for the user's next prompt. Don't poll or wait for one.`,
      }
    : tool,
)

const Message = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.String,
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
const Call = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message))
const decodeCall = Schema.decodeUnknownOption(Call)
const decodeSession = Schema.decodeUnknownOption(EventWatch.SessionID)
const decodeCodexTurn = Schema.decodeUnknownOption(Schema.Struct({ session_id: EventWatch.SessionID }))
const decodeString = Schema.decodeUnknownOption(Schema.String)
const Minutes = Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20160 })))
// A link or shorthand, or one event type of a server with its arguments; never both.
const decodeWatched = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ target: Schema.String, server: Schema.optional(Schema.Undefined), minutes: Minutes }),
    Schema.Struct({
      target: Schema.optional(Schema.Undefined),
      server: Schema.String,
      event: Schema.String,
      arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      minutes: Minutes,
    }),
  ]),
)

/** The answer to one line of JSON-RPC, or undefined for a notification, which gets none. */
export const handle = Effect.fnUntraced(function* (
  input: { readonly store: ConsoleStore.Info; readonly hostPid: number; readonly nextPrompt?: boolean },
  line: string,
) {
  const message = Option.getOrUndefined(decodeMessage(line))
  if (message === undefined) return failure(null, -32700, "Not a JSON-RPC message")
  if (message.id === undefined) return undefined
  const id = message.id
  if (message.method === "initialize") {
    const requested = message.params?.protocolVersion
    return answer(id, {
      protocolVersion: typeof requested === "string" && VERSIONS.includes(requested) ? requested : VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: "opencode-console-watches", version },
    })
  }
  if (message.method === "ping") return answer(id, {})
  if (message.method === "tools/list") return answer(id, { tools: input.nextPrompt ? nextPromptTools : tools })
  if (message.method !== "tools/call") return failure(id, -32601, `No method ${message.method}`)
  const call = Option.getOrUndefined(decodeCall(message.params))
  if (call === undefined) return failure(id, -32602, "tools/call needs a tool name")
  const result = yield* Effect.gen(function* () {
    const sessionID = sessionOf(call._meta) ?? (yield* ConsoleWatches.sessionForHostPid(input.store, input.hostPid))
    if (sessionID === undefined)
      return yield* new ConsoleWatches.Failed({
        message:
          "opencode-console doesn't know which session this is yet. Try again after the session's next tool call.",
      })
    return yield* run(input.store, sessionID, call.name, call.arguments ?? {}, { nextPrompt: input.nextPrompt })
  }).pipe(
    Effect.map((done) => ({ content: [{ type: "text", text: done.text }], structuredContent: done.structured })),
    Effect.catch((error) => Effect.succeed({ content: [{ type: "text", text: failureText(error) }], isError: true })),
  )
  return answer(id, result)
})

/** What the agent reads when a tool call fails: why, when Console or the sign-in said, else that Console didn't answer. */
export function failureText(error: unknown) {
  return error instanceof ConsoleWatches.Failed ||
    error instanceof ConsoleClient.SignedOut ||
    error instanceof ConsoleClient.SsoRequired
    ? error.message
    : "OpenCode Console didn't answer"
}

/**
 * Runs the tool `name` for `sessionID`, answering the text the agent reads and the structured result; `nextPrompt` as
 * for `handle`.
 */
export const run = Effect.fnUntraced(function* (
  store: ConsoleStore.Info,
  sessionID: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
  options: { readonly nextPrompt?: boolean | undefined } = {},
) {
  if (name === "watch") {
    const input = Option.getOrUndefined(decodeWatched(args))
    if (input === undefined)
      return yield* new ConsoleWatches.Failed({
        message: "watch takes a target, or a server and event with the event's arguments as an object, not both",
      })
    const watch = yield* ConsoleWatches.create(
      store,
      sessionID,
      input.server === undefined ? input.target : input,
      undefined,
      input.minutes,
    )
    // A session that keeps a watch here gets its events here.
    yield* ConsoleWatches.touchSession(store, sessionID)
    return result(
      `Watching ${ConsoleWatches.label(watch)} until ${watch.expiresAt} (${watch.id}). ${options.nextPrompt ? "Updates arrive during a turn, or with the user's next prompt while this session is idle." : "This session wakes when it changes."}`,
      watch,
    )
  }
  if (name === "events") {
    // Each on one line, with what `watch` needs; a server's description is cut short.
    const types = (yield* ConsoleWatches.types(store)).map((type) => {
      const description = type.description?.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION)
      return {
        server: type.server,
        name: type.name,
        ...(description ? { description } : {}),
        inputSchema: type.inputSchema,
      }
    })
    return result(
      types.length === 0
        ? "No event types to watch: connect a server that offers them in Extensions."
        : types
            .map(
              (type) =>
                `${type.server} ${type.name}${type.description ? `: ${type.description}` : ""} Arguments: ${JSON.stringify(type.inputSchema)}`,
            )
            .join("\n"),
      { types },
    )
  }
  if (name === "unwatch") {
    const id = Option.getOrUndefined(decodeString(args.id))
    if (id === undefined) return yield* new ConsoleWatches.Failed({ message: "unwatch needs a watch ID" })
    const owned = (yield* ConsoleWatches.list(store)).some((watch) => watch.id === id && watch.sessionID === sessionID)
    if (!owned) return yield* new ConsoleWatches.Failed({ message: `This session has no watch ${id}` })
    yield* ConsoleWatches.cancel(store, id)
    return result(`Stopped watch ${id}.`, { id, removed: true })
  }
  if (name === "watches") {
    const watches = (yield* ConsoleWatches.list(store)).filter((watch) => watch.sessionID === sessionID)
    return result(
      watches.length === 0
        ? "This session watches nothing."
        : watches.map((watch) => `${watch.id}: ${ConsoleWatches.label(watch)} until ${watch.expiresAt}`).join("\n"),
      { watches },
    )
  }
  return yield* new ConsoleWatches.Failed({ message: `No tool ${name}` })
})

/**
 * The session a call names: Codex's root thread on every call (`x-codex-turn-metadata`, the same ID its hooks get),
 * then its thread on a manual call, then OpenCode's.
 */
function sessionOf(meta: Readonly<Record<string, unknown>> | undefined) {
  if (meta === undefined) return undefined
  return [
    Option.getOrUndefined(decodeCodexTurn(meta["x-codex-turn-metadata"]))?.session_id,
    Option.getOrUndefined(decodeSession(meta.threadId)),
    Option.getOrUndefined(decodeSession(meta["ai.opencode/sessionID"])),
  ].find((sessionID) => sessionID !== undefined)
}

function result(text: string, structured: object) {
  return { text, structured }
}

function answer(id: string | number | null, value: unknown) {
  return { jsonrpc: "2.0", id, result: value }
}

function failure(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } }
}
