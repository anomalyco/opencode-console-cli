import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai"
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"
import { InProcess } from "../src/in-process"
import { PiExtension } from "../src/pi-extension"
import { WorkspaceSnapshot } from "../src/snapshot"
import { ConsoleStore } from "../src/store"
import { ConsoleWatches } from "../src/watches"
import { version } from "../package.json" with { type: "json" }
import {
  fakeConsole,
  inbox,
  removeStores,
  save,
  server,
  serveConsole,
  signIn,
  temporaryStore,
  until,
} from "./support/console"

// Pi's own agent session (its SDK), with this extension loaded as Pi loads it, against a stand-in Console. Pi's faux
// provider plays the model, so the tool calls are the ones Pi's tool loop runs.
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  // Last in, first out: a session shuts down before the Console it streams from stops.
  for (const item of cleanup.splice(0).reverse()) await item()
  removeStores()
})

type Mode = NonNullable<Parameters<AgentSession["bindExtensions"]>[0]["mode"]>
type Steps = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]

/**
 * A Pi session for a member of Acme whose synced workspace config is `config`. `signedIn: false` starts it signed
 * out, `synced: false` with no config fetched yet, `instructions` are the ones the Console serves, and `skill` adds a
 * skill of the member's own to Pi.
 */
async function pi(
  config: Record<string, unknown>,
  steps: Steps,
  options: {
    readonly models?: Record<string, unknown>
    readonly signedIn?: boolean
    readonly synced?: boolean
    readonly served?: () => Response
    readonly instructions?: readonly unknown[]
    readonly skill?: string
  } = {},
) {
  const console = fakeConsole({
    config: options.served ?? (() => Response.json(config)),
    models: () => Response.json(options.models ?? {}),
    instructions: () => Response.json({ instructions: options.instructions ?? [] }),
  })
  const store = temporaryStore()
  const configure = (value: Record<string, unknown>) =>
    WorkspaceSnapshot.write(store, {
      owner: JSON.stringify([server, "usr_ada", "org_acme"]),
      organization: "Acme",
      fetched: Date.now(),
      config: value,
    })
  const login = () => save(store, signIn(console, Number.MAX_SAFE_INTEGER))
  if (options.signedIn !== false) login()
  if (options.synced !== false && options.signedIn !== false) configure(config)
  const started = await launch(InProcess.session({ store, fetch: console.fetch }), steps, options)
  return { ...started, store, configure, login }
}

/**
 * Pi's agent session with the extension loaded for `state`, in Pi's `mode` (the SDK's `print` unless a test says), Pi's
 * faux provider answering with `steps`. `api` is the extension API Pi gave the session, for what only extensions see.
 */
async function launch(
  state: InProcess.Session,
  steps: Steps,
  options: { readonly skill?: string; readonly mode?: Mode } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-pi-session-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const agentDir = path.join(root, "agent")
  if (options.skill) {
    mkdirSync(path.join(agentDir, "skills", options.skill), { recursive: true })
    writeFileSync(
      path.join(agentDir, "skills", options.skill, "SKILL.md"),
      `---\nname: ${options.skill}\ndescription: The member's own ${options.skill} skill\n---\n\nSteps`,
    )
  }
  const faux = fauxProvider({ provider: "faux" })
  faux.setResponses(steps)
  const seen: { api?: ExtensionAPI } = {}
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    noExtensions: true,
    extensionFactories: [
      (api) => {
        seen.api = api
        api.registerProvider(faux.provider)
      },
      (api) => PiExtension.install(api, state),
    ],
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    model: faux.getModel(),
    resourceLoader,
    sessionManager: SessionManager.inMemory(root),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    // The extension's own tools, as Pi enables them when no `--tools` list names the tools.
    tools: ["bash", "console_watch_*"],
  })
  // As Pi's runtime ends a session: shutdown first, so the extension closes what it holds.
  cleanup.push(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })
    session.dispose()
  })
  await session.bindExtensions(options.mode ? { mode: options.mode } : {})
  return { session, faux, api: seen.api }
}

const results = (messages: AgentSession["messages"]) =>
  messages.flatMap((message) =>
    message.role === "toolResult"
      ? [
          {
            tool: message.toolName,
            isError: message.isError,
            text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
          },
        ]
      : [],
  )

// The system prompt each model request carried, for a step that answers it.
const prompted =
  (prompts: string[]): FauxResponseFactory =>
  (context) => {
    prompts.push(getCurrentSystemPrompt(context.messages) ?? "")
    return fauxAssistantMessage("ok")
  }

const deny = (action: string, resource: string) => ({ action, resource, effect: "deny" })

/** A gateway on this machine that records each request's headers and refuses it. */
function gateway() {
  const seen: Headers[] = []
  const served = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      seen.push(request.headers)
      return Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "stop" } },
        { status: 400 },
      )
    },
  })
  cleanup.push(() => served.stop(true))
  return {
    seen,
    models: {
      "console-acme": {
        models: {
          "claude-haiku-4-5": {
            name: "Claude Haiku 4.5",
            api: { messages: { base_url: `http://127.0.0.1:${served.port}/inference/custom/conn_1` } },
          },
        },
      },
    },
  }
}

test("blocks a tool call the workspace's policy denies, and runs one it allows", async () => {
  const { session } = await pi({ policies: [deny("tool.use", "shell:rm *")] }, [
    fauxAssistantMessage(
      [fauxToolCall("bash", { command: "rm -rf probe" }), fauxToolCall("bash", { command: "echo ok" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ])

  await session.prompt("clean up")

  expect(results(session.messages)).toEqual([
    { tool: "bash", isError: true, text: "Blocked by Acme's policy" },
    { tool: "bash", isError: false, text: "ok\n" },
  ])
})

test("gives the model the workspace's instructions once the member signs in while Pi runs", async () => {
  const prompts: string[] = []
  const { session, login } = await pi({}, [prompted(prompts)], {
    signedIn: false,
    instructions: [{ id: "ins_1", name: "Security", content: "Never log secrets." }],
  })

  login()
  await session.prompt("hi")

  expect(prompts[0]).toContain("Never log secrets.")
})

test("stops a /skill: the workspace's policy denies before the model sees it", async () => {
  const { session, faux } = await pi({ policies: [deny("skill.use", "deploy")] }, [fauxAssistantMessage("deployed")])

  await session.prompt("/skill:deploy staging")

  expect([faux.state.callCount, session.messages.length]).toEqual([0, 0])
})

test("gives the model the workspace's instructions as a section of its system prompt", async () => {
  const prompts: string[] = []
  const { session } = await pi({}, [prompted(prompts)], {
    synced: false,
    instructions: [{ id: "ins_1", name: "Security", content: "Never log secrets." }],
  })

  await session.prompt("hi")

  expect(prompts[0]).toContain("<opencode_workspace_instructions>\n## Security\n\nNever log secrets.")
})

test("takes the instructions and every skill out of the prompt when the policy can't be checked", async () => {
  const prompts: string[] = []
  const { session, store } = await pi({}, [prompted(prompts), prompted(prompts)], {
    synced: false,
    instructions: [{ id: "ins_1", name: "Security", content: "Never log secrets." }],
    skill: "notes",
  })
  await session.prompt("hi")

  ConsoleStore.write(ConsoleStore.credentialFile(store), "{ not json")
  await session.prompt("again")

  expect(prompts.map((prompt) => [prompt.includes("Never log secrets."), prompt.includes("notes")])).toEqual([
    [true, true],
    [false, false],
  ])
})

test("serves the workspace's models as Pi providers and empties a provider the policy denies", async () => {
  const { session } = await pi(
    { providers: { opencode: {} }, policies: [deny("provider.use", "anthropic"), deny("provider.use", "typesafe")] },
    [],
    {
      models: {
        opencode: {
          name: "Acme / OpenCode",
          models: {
            "claude-sonnet-4-6": {
              name: "Claude Sonnet 4.6",
              api: { messages: { base_url: "https://console.test/inference/anthropic/v1" } },
            },
          },
        },
      },
    },
  )

  const models = session.modelRuntime.getModels()

  expect(models.filter((model) => model.provider === "opencode").map((model) => [model.id, model.baseUrl])).toEqual([
    ["claude-sonnet-4-6", "https://console.test/inference/anthropic"],
  ])
  expect(models.some((model) => model.provider === "anthropic")).toBe(false)
  expect(models.some((model) => model.provider === "openai")).toBe(true)
  // A provider with no chat models, which Pi's chat model list never shows, is emptied too.
  expect(session.modelRuntime.getAllModels("typesafe")).toEqual([])
})

test("empties every other provider when the policy can't be checked", async () => {
  const { session, store } = await pi({}, [], { signedIn: false })
  ConsoleStore.write(ConsoleStore.credentialFile(store), "{ not json")

  await session.bindExtensions({})

  expect(session.modelRuntime.getModels("anthropic")).toEqual([])
})

test("empties Pi's own OpenCode Go provider when the workspace serves no Go models", async () => {
  const { session } = await pi({ providers: {} }, [])

  expect([session.modelRuntime.getModels("opencode-go"), session.modelRuntime.getModels("opencode")]).toEqual([[], []])
})

test("gives back a provider emptied while the policy loaded once the policy allows it", async () => {
  const { session, configure } = await pi({}, [fauxAssistantMessage("ok")], {
    synced: false,
    served: () => new Response("unavailable", { status: 503 }),
  })
  const pending = session.modelRuntime.getModels("anthropic").length

  configure({ policies: [] })
  await session.prompt("hi")

  expect([pending, session.modelRuntime.getModels("anthropic").length > 0]).toEqual([0, true])
})

test("stops a request to a provider the policy stops allowing while Pi runs", async () => {
  const served = gateway()
  const { session, configure } = await pi({ providers: { "console-acme": {} } }, [], { models: served.models })
  const model = session.modelRuntime.getModel("console-acme", "claude-haiku-4-5")
  if (model) await session.setModel(model)

  configure({ providers: { "console-acme": {} }, policies: [deny("provider.use", "console-acme")] })
  await session.prompt("hi")

  expect(served.seen).toEqual([])
})

test("gives a connection's model the protocol settings Pi ships for the same model", async () => {
  const { session } = await pi({ providers: { "console-anthropic": {} } }, [], {
    models: {
      "console-anthropic": {
        name: "Acme / Anthropic",
        models: {
          "claude-sonnet-5-5": {
            name: "Claude Sonnet 5.5",
            api: { messages: { base_url: "https://console.test/inference/custom/conn_1" } },
          },
        },
      },
    },
  })

  const model = session.modelRuntime.getModel("console-anthropic", "claude-sonnet-5-5")

  // Claude Sonnet 5.5 refuses the thinking budget Pi sends a model it knows nothing about.
  expect(model?.compat).toMatchObject({ forceAdaptiveThinking: true })
})

test("sends a workspace model's requests with the member's token and the headers that name the extension", async () => {
  const served = gateway()
  const { session } = await pi({ providers: { "console-acme": {} } }, [], { models: served.models })
  const model = session.modelRuntime.getModel("console-acme", "claude-haiku-4-5")
  if (model) await session.setModel(model)

  await session.prompt("hi")

  expect({
    key: served.seen[0]?.get("x-api-key"),
    plugin: served.seen[0]?.get("x-opencode-plugin"),
    session: served.seen[0]?.get("x-opencode-session") === session.sessionId,
  }).toEqual({ key: "access-1", plugin: `opencode-console/${version}`, session: true })
})

/**
 * A Pi session in Pi's interactive mode for a member of Acme, against a Console on this machine over real HTTP and
 * WebSockets whose synced config offers event watches unless `watches: false`. Each event connection's socket arrives
 * in `sockets`.
 */
async function watching(
  steps: Steps,
  options: {
    readonly watches?: boolean
    readonly config?: Record<string, unknown>
    readonly listed?: ReadonlyArray<Record<string, unknown>>
    /** Answers each new watch, as `serveConsole`'s `create` does. */
    readonly create?: () => Response
  } = {},
) {
  const sockets = inbox<{ send: (frame: string) => void }>()
  const console = serveConsole(
    { watches: { watches: options.listed ?? [], ...(options.create ? { create: options.create } : {}) } },
    { open: (socket) => sockets.push(socket) },
  )
  cleanup.push(console.stop)
  const store = temporaryStore()
  save(store, signIn(console, Number.MAX_SAFE_INTEGER, console.url))
  WorkspaceSnapshot.write(store, {
    owner: JSON.stringify([console.url, "usr_ada", "org_acme"]),
    organization: "Acme",
    fetched: Date.now(),
    config: options.config ?? {},
    ...(options.watches === false ? {} : { watches: true }),
  })
  const started = await launch(InProcess.session({ store }), steps, { mode: "tui" })
  return { ...started, console, store, sockets }
}

/** A comment from someone else on a pull request, for the session `sessionID`, as Console's stream sends it. */
const comment = (id: string, sessionID: string) => ({
  id,
  watchID: "ew_1",
  sessionID,
  source: "github",
  routingKey: "github:acme/app#7",
  kind: "comment",
  actor: { id: "301", login: "octocat", bot: false, self: false },
  title: "acme/app#7",
  body: "Looks good",
  url: "https://github.com/acme/app/pull/7",
  status: null,
  terminal: false,
  occurredAt: "2026-11-07T12:00:00.000Z",
})

const events = (...items: ReturnType<typeof comment>[]) => JSON.stringify({ type: "events", events: items })

// The watched updates each model request carried, for a step that answers it.
const woken =
  (texts: string[]): FauxResponseFactory =>
  (context) => {
    texts.push(
      context.messages
        .flatMap((message) =>
          message.role !== "user"
            ? []
            : typeof message.content === "string"
              ? [message.content]
              : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
        )
        .filter((text) => text.includes("OpenCode Console changed"))
        .join("\n"),
    )
    return fauxAssistantMessage("ok")
  }

test("offers no watch tools and opens no event connection while the workspace has no event watches", async () => {
  const { session, console } = await watching([fauxAssistantMessage("ok")], { watches: false })

  await session.prompt("hi")

  expect({
    tools: session.getAllTools().filter((tool) => tool.name.startsWith("console_watch")),
    requests: console.state.requests.filter((request) => new URL(request.url).pathname.includes("/event-watches")),
  }).toEqual({ tools: [], requests: [] })
})

test("names the session to the gateway's MCP servers, and to no other server", async () => {
  const { session, api } = await watching([], {
    config: {
      mcp: {
        servers: {
          github: {
            type: "remote",
            url: "https://console.test/console/mcp/github",
            headers: { authorization: "Bearer mcp-1" },
          },
          docs: { type: "remote", url: "https://docs.example.com/mcp" },
        },
      },
    },
  })

  const headers = Object.fromEntries(
    (api?.getMcpServers() ?? []).map((item) => [item.name, "headers" in item.config ? item.config.headers : undefined]),
  )

  expect(headers).toEqual({
    github: { authorization: "Bearer mcp-1", "x-opencode-watch-session": session.sessionId },
    docs: undefined,
  })
})

test("wakes an idle session with an update for it, and acknowledges only that one", async () => {
  const texts: string[] = []
  const { session, faux, console, sockets } = await watching([woken(texts)])
  const socket = await sockets.at(0)

  socket.send(events(comment("ev_here", session.sessionId), comment("ev_elsewhere", "ses_elsewhere")))
  const acked = await console.state.acked.at(0)
  await until(() => faux.state.callCount === 1)
  await session.waitForIdle()

  expect({ acked, woke: texts[0]?.includes("octocat commented on acme/app#7") }).toEqual({
    acked: ["ev_here"],
    woke: true,
  })
})

test("holds an update for the next prompt, starting no turn, once five wakes ran without the user", async () => {
  const texts: string[] = []
  const { session, faux, console, sockets, store } = await watching([woken(texts)])
  await Effect.runPromise(Effect.repeat(ConsoleWatches.recordWake(store, session.sessionId), { times: 4 }))
  const socket = await sockets.at(0)

  socket.send(events(comment("ev_6", session.sessionId)))
  await console.state.acked.at(0)
  await session.prompt("next")

  expect({ calls: faux.state.callCount, woke: texts[0]?.includes("octocat commented on acme/app#7") }).toEqual({
    calls: 1,
    woke: true,
  })
})

test("wakes the session again once the user prompts after five unattended wakes", async () => {
  const { session, faux, sockets, store } = await watching([fauxAssistantMessage("hi"), fauxAssistantMessage("ok")])
  await Effect.runPromise(Effect.repeat(ConsoleWatches.recordWake(store, session.sessionId), { times: 4 }))
  await session.prompt("hi")
  const socket = await sockets.at(0)

  socket.send(events(comment("ev_after_user", session.sessionId)))
  await until(() => faux.state.callCount === 2)

  expect(faux.state.callCount).toBe(2)
})

test("watches the pull request a bash command's `gh pr create` printed, for the session", async () => {
  const { session, console } = await watching([
    fauxAssistantMessage(
      [fauxToolCall("bash", { command: "printf 'https://github.com/acme/app/pull/7\\n' || gh pr create --fill" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("opened"),
  ])

  await session.prompt("open a pull request")
  await until(() => console.state.created.length === 1)

  expect(console.state.created).toEqual([
    { sessionID: session.sessionId, target: "https://github.com/acme/app/pull/7" },
  ])
})

test("tells the agent why Console refused to watch the pull request a bash command's `gh pr create` printed", async () => {
  const texts: string[] = []
  const { session, console } = await watching(
    [
      fauxAssistantMessage(
        [fauxToolCall("bash", { command: "printf 'https://github.com/acme/app/pull/7\\n' || gh pr create --fill" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("opened"),
      (context) => {
        texts.push(
          ...context.messages.flatMap((message) =>
            message.role !== "user"
              ? []
              : typeof message.content === "string"
                ? [message.content]
                : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
          ),
        )
        return fauxAssistantMessage("ok")
      },
    ],
    {
      create: () =>
        Response.json(
          { _tag: "WatchRefused", message: "GitHub isn't available to your account in this workspace." },
          { status: 403 },
        ),
    },
  )

  await session.prompt("open a pull request")
  await until(() => console.state.created.length === 1)
  await until(() => session.messages.some((message) => message.role === "custom"))
  await session.prompt("next")

  expect(texts).toContain(
    "OpenCode Console can't watch this, so changes to it won't wake this session. Tell the user why: GitHub isn't available to your account in this workspace.",
  )
})

test("the watch tool watches its target for the session that called it", async () => {
  const { session, console } = await watching([
    fauxAssistantMessage([fauxToolCall("console_watch_watch", { target: "acme/app#7" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("watching"),
  ])

  await session.prompt("watch acme/app#7")

  expect({ created: console.state.created, results: results(session.messages) }).toEqual({
    created: [{ sessionID: session.sessionId, target: "acme/app#7" }],
    results: [
      {
        tool: "console_watch_watch",
        isError: false,
        text: "Watching github:acme/app#7 until 2026-11-10T12:00:00.000Z (ew_1). This session wakes when it changes.",
      },
    ],
  })
})
