export * as PiExtension from "./pi-extension"

import { existsSync } from "node:fs"
import path from "node:path"
import {
  anthropicMessagesApi,
  createProvider,
  googleGenerativeAIApi,
  openAICompletionsApi,
  openAIResponsesApi,
  type ProviderHeaders,
  type ProviderStreams,
} from "@earendil-works/pi-ai/compat"
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all"
import { type ExtensionAPI, type ExtensionContext, VERSION } from "@earendil-works/pi-coding-agent"
import { Effect, Exit, Option, Schema, Scope } from "effect"
import { ConsoleClient } from "./console-client"
import { ConsoleCredentials } from "./credentials"
import { InProcess } from "./in-process"
import { Instruction } from "./instruction"
import { McpWatches } from "./mcp-watches"
import { Pi } from "./pi"
import { WorkspaceSnapshot } from "./snapshot"
import { ConsoleWatches } from "./watches"

/**
 * The OpenCode Console extension for Pi (pi.dev/docs/latest/extensions). In the Pi process it serves the workspace's
 * models as Pi providers through the gateway, signs their requests with the member's Console sign-in, checks every
 * tool call, `!command` and `/skill:` against the workspace's policies, hides providers the policies deny, connects
 * the workspace's MCP servers and adds its instructions and skills, and wakes the session when a Slack thread or GitHub
 * work it watches changes. `setup pi` lists it in Pi's settings.
 */
// oxlint-disable-next-line import/no-default-export -- Pi loads an extension from its module's default export
export default async function (pi: ExtensionAPI) {
  await install(pi, InProcess.session({ harness: `pi/${VERSION}` }))
}

/**
 * A model Pi ships with the same ID and protocol, whose protocol settings (thinking levels, compatibility flags) the
 * gateway's copy keeps: the provider's own first (Pi ships `opencode` and `opencode-go`), then Zen's, then any other,
 * so a connection's `claude-sonnet-5-5` thinks the way Pi's `anthropic` one does.
 */
const builtin: Pi.Builtin = (provider, id, api) => {
  const providers = getBuiltinProviders()
  const ordered = [
    ...providers.filter((item) => item === provider),
    ...providers.filter((item) => item === "opencode" && item !== provider),
    ...providers.filter((item) => item !== provider && item !== "opencode"),
  ]
  return ordered.flatMap((item) => getBuiltinModels(item).filter((model) => model.id === id && model.api === api)).at(0)
}

const SECTION = "opencode_workspace_instructions"

/** Wires the extension into Pi. */
export async function install(pi: ExtensionAPI, state: InProcess.Session) {
  // Providers the extension serves or replaces, and the ones it emptied because the workspace's policy denies them.
  const served = new Set<string>()
  // Each emptied provider, with what gives it back: unregistering a built-in one, or registering again another
  // extension's provider that emptying replaced.
  const hidden = new Map<string, () => void>()
  const offered = new Map<string, string>()
  const startup = signedIn(state)
  const document = startup ? await Pi.models(state).catch(() => undefined) : undefined
  Pi.providers(document ?? {}, builtin).forEach((provider) => {
    served.add(provider.id)
    pi.registerProvider(
      createProvider({
        id: provider.id,
        name: provider.name,
        auth: { apiKey: { name: "OpenCode Console", resolve: () => resolveToken(state) } },
        models: provider.models,
        api: {
          "anthropic-messages": withSession(anthropicMessagesApi()),
          "openai-responses": withSession(openAIResponsesApi()),
          "openai-completions": withSession(openAICompletionsApi()),
          "google-generative-ai": withSession(googleGenerativeAIApi()),
        },
      }),
    )
  })
  // With the workspace's config, OpenCode's providers are the workspace's alone: Pi's own catalog of them points at
  // OpenCode's public Zen, so whichever the workspace doesn't serve is emptied.
  if (startup && (await InProcess.config(state).catch(() => undefined))?.config)
    ["opencode", "opencode-go"]
      .filter((id) => !served.has(id))
      .forEach((id) => {
        served.add(id)
        pi.registerProvider(id, { models: [] })
      })
  // With event watches, the gateway's servers name the session, which only `session_start` knows, so they register
  // there; registering them now too would connect each one twice.
  if (startup && !WorkspaceSnapshot.watches(await InProcess.config(state).catch(() => undefined)))
    await registerServers(pi, state, offered, undefined).catch(() => undefined)
  const watches = watching(pi, state)
  const fallback = document && Pi.defaultModel(document)
  // When the config the providers were last reconciled with was fetched, so a newer one reconciles them again.
  const reconciled: { fetched?: number | undefined } = {}

  /**
   * Empties every other provider Pi knows that the workspace's `provider.use` statements deny, and gives back one it
   * emptied that they allow again, such as one emptied while the policy was still loading. A provider can't be
   * removed, since unregistering a built-in one brings it back, so it's registered with no models. A decision that
   * fails denies.
   */
  const reconcile = async (ctx: ExtensionContext) => {
    const known = [
      ...ctx.modelRegistry.getAll().map((model) => model.provider),
      ...getBuiltinProviders(),
      ...ctx.modelRegistry.getRegisteredProviderIds(),
      ...hidden.keys(),
    ]
    const others = [...new Set(known)].filter((id) => !served.has(id))
    const decided = await InProcess.decisions(
      state,
      others.map((id) => ({ action: "provider.use", resources: [id] })),
    ).catch(() => undefined)
    others.forEach((id, index) => {
      const deny = decided?.[index]?.effect !== "allow"
      if (deny && !hidden.has(id)) {
        // Another extension's provider in Pi's older config form isn't given back; Pi's own and complete providers are.
        const native = ctx.modelRegistry.getRegisteredNativeProvider(id)
        hidden.set(id, () => {
          pi.unregisterProvider(id)
          if (native) pi.registerProvider(native)
        })
        pi.registerProvider(id, { models: [] })
      }
      const restore = deny ? undefined : hidden.get(id)
      if (restore) {
        hidden.delete(id)
        restore()
      }
    })
    reconciled.fetched = (await InProcess.config(state).catch(() => undefined))?.fetched
    const current = ctx.model
    const model = fallback && ctx.modelRegistry.find(fallback.provider, fallback.id)
    if (model && (!current || hidden.has(current.provider))) await pi.setModel(model)
  }
  // Reconciles again once a newer config arrives.
  const reconcileChanged = async (ctx: ExtensionContext) => {
    const snapshot = await InProcess.config(state)
    if (snapshot?.fetched !== reconciled.fetched) await reconcile(ctx)
    return snapshot
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!signedIn(state)) {
      notify(ctx, "OpenCode Console isn't signed in. Run `npx @opencode/console login`.", "warning")
      return
    }
    const snapshot = await InProcess.config(state).catch(() => undefined)
    if (snapshot?.status)
      notify(ctx, `${snapshot.status.message}${snapshot.status.url ? `: ${snapshot.status.url}` : ""}`, "warning")
    await reconcile(ctx)
    await registerServers(pi, state, offered, ctx.sessionManager.getSessionId()).catch(() => undefined)
    await watches.sync(ctx).catch(() => undefined)
  })

  pi.on("session_shutdown", () => watches.stop())

  pi.on("resources_discover", async () => {
    if (!signedIn(state)) return
    const folder = await Pi.skills(state).catch(() => skillsFolder(state))
    return existsSync(folder) ? { skillPaths: [folder] } : undefined
  })

  // Pi carries on when this handler fails, so a failure takes the workspace's instructions and every skill out.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!signedIn(state)) return
    const options = event.systemPromptOptions
    const loaded = options.skills ?? []
    const shown = await (async () => {
      const snapshot = await reconcileChanged(ctx)
      const decided = await InProcess.decisions(
        state,
        loaded.map((skill) => ({ action: "skill", resources: [skill.name] })),
      )
      return {
        text: Instruction.prompt(WorkspaceSnapshot.instructions(snapshot)),
        skills: loaded.filter((_skill, index) => decided[index]?.effect === "allow"),
      }
    })().catch(() => ({ text: undefined, skills: [] }))
    // Pi builds the options afresh for each run, so a section left out is gone.
    if (shown.text) options.sections = { ...options.sections, [SECTION]: shown.text }
    options.skills = shown.skills
  })

  // An error here blocks the call (pi.dev/docs/latest/extensions, "Error Handling").
  pi.on("tool_call", async (event, ctx) => {
    const tools = pi.getAllTools()
    const server = tools.find((tool) => tool.name === event.toolName)?.namespace?.aliases?.[0]
    const servers = [
      ...new Set([
        ...tools.flatMap((tool) => tool.namespace?.aliases?.slice(0, 1) ?? []),
        ...pi.getMcpServers().map((item) => item.name),
      ]),
    ]
    const decision = await InProcess.decide(
      state,
      Pi.checks(event, { cwd: ctx.cwd, server, servers, skills: skillsFolder(state) }),
    )
    return decision?.effect === "deny" ? { block: true, reason: decision.message } : undefined
  })

  // An error here blocks the command too.
  pi.on("user_bash", async (event, ctx) => {
    const decision = await InProcess.decide(state, [Pi.userBash(event)])
    if (decision?.effect !== "deny") return undefined
    notify(ctx, decision.message, "error")
    return { result: { output: `${decision.message}\n`, exitCode: 1, cancelled: false, truncated: false } }
  })

  // Pi lets an input continue when its handler fails, so a skill this can't decide is stopped here. Inputs come before
  // Pi checks the session's model, so a provider emptied while the policy loaded is given back here first.
  pi.on("input", async (event, ctx) => {
    if (signedIn(state)) await reconcileChanged(ctx).catch(() => undefined)
    // A person writing counts the session's wakes from zero again; a message an extension sends doesn't.
    if (event.source !== "extension") await watches.prompted(ctx).catch(() => undefined)
    const skill = Pi.skillCommand(event.text)
    if (!skill) return { action: "continue" as const }
    const decision = await InProcess.decide(state, [{ action: "skill", resources: [skill] }]).catch((error: unknown) =>
      failed(`/skill:${skill}`, error),
    )
    if (decision?.effect !== "deny") return { action: "continue" as const }
    notify(ctx, decision.message, "error")
    return { action: "handled" as const }
  })

  // Every request is checked against the policy as it is now, so a session on a provider the workspace stops allowing,
  // or one resumed from before the policy, is stopped before it sends. Pi carries on when this fails, so a failure
  // stops the request too.
  pi.on("before_provider_request", async (_event, ctx) => {
    const decision = await providerDecision(state, ctx)
    if (decision?.effect !== "deny") return undefined
    notify(ctx, decision.message, "error")
    ctx.abort()
    return undefined
  })

  // Keeping a denied provider's prompt cache warm would send it requests the policy denies.
  pi.on("cache_warming_decision", async (_event, ctx) =>
    (await providerDecision(state, ctx))?.effect === "deny" ? { action: "stop" as const } : undefined,
  )

  // The gateway's MCP token changes daily, and the workspace may add or drop servers, or turn event watches on or off,
  // while Pi runs.
  pi.on("turn_start", (_event, ctx) => {
    if (!signedIn(state)) return
    void registerServers(pi, state, offered, ctx.sessionManager.getSessionId()).catch(() => undefined)
    void watches.sync(ctx).catch(() => undefined)
  })

  // What a shell command started is watched once it finishes; the end event doesn't carry the command.
  const commands = new Map<string, string>()
  pi.on("tool_execution_start", (event) => {
    const command = Option.getOrUndefined(decodeShellArgs(event.args))?.command
    if (shells.has(event.toolName) && command !== undefined) commands.set(event.toolCallId, command)
  })
  pi.on("tool_execution_end", (event, ctx) => {
    const command = commands.get(event.toolCallId)
    commands.delete(event.toolCallId)
    if (command !== undefined) watches.shell(ctx, command, event.result)
  })
}

const shells = new Set(["bash", "powershell"])
const decodeShellArgs = Schema.decodeUnknownOption(Schema.Struct({ command: Schema.String }))
// Pi's shell tools answer scripts with the whole output and exit code, failed or not.
const decodeShellResult = Schema.decodeUnknownOption(
  Schema.Struct({ structuredContent: Schema.Struct({ output: Schema.String, exit_code: Schema.Number }) }),
)

/** The custom message type a watched update arrives in, in the transcript and the session file. */
const WATCH_MESSAGE = "opencode-console-watch"

/**
 * The session's event watches while the workspace offers them (`WorkspaceSnapshot.watches`): the `console_watch`
 * tools, the event connection that wakes the session, and watches on what its shell commands start. Without them
 * there is nothing: no tools, no connection and no requests. Pi runs one session per extension instance, so the
 * session is the one Pi says it runs. Watches outlive the session, so `pi --resume` still gets what came meanwhile.
 */
function watching(pi: ExtensionAPI, state: InProcess.Session) {
  // `registered` is whether the tools are offered; Pi can't unregister a tool, so withdrawing them hides them.
  const current: { registered: boolean; connection?: Scope.Closeable | undefined } = { registered: false }

  /** Hands the session its own events, and leaves the rest for the member's other sessions to take. */
  const deliver = (sessionID: string) => (events: ReadonlyArray<ConsoleWatches.WatchEvent>) => {
    const mine = events.filter((event) => event.sessionID === sessionID)
    if (mine.length === 0) return Effect.succeed([])
    return ConsoleWatches.recordWake(state.store, sessionID, mine).pipe(
      Effect.flatMap((wake) =>
        Effect.try(() =>
          pi.sendMessage(
            {
              customType: WATCH_MESSAGE,
              content: ConsoleWatches.wakeText(mine, wake),
              display: true,
              details: { events: mine.map((event) => event.id) },
            },
            // Past the loop guard's limits the update waits for the user's next prompt, so two agents can't loop.
            wake === "held" ? { deliverAs: "nextTurn" } : { deliverAs: "steer", triggerTurn: true },
          ),
        ),
      ),
      Effect.as(mine.map((event) => event.id)),
      // A session Pi already tore down takes nothing; its events wait for the next connection.
      Effect.orElseSucceed(() => []),
    )
  }

  const stop = async () => {
    const connection = current.connection
    current.connection = undefined
    if (connection) await Effect.runPromise(Scope.close(connection, Exit.void))
  }

  const register = (exposure: "direct" | "hidden") =>
    McpWatches.tools.forEach((tool) =>
      pi.registerTool({
        name: `console_watch_${tool.name}`,
        label: `Console ${tool.name}`,
        description: tool.description,
        parameters: tool.inputSchema,
        namespace: {
          name: "console_watch",
          description:
            "Watch Slack threads, GitHub pull requests, issues, commits and Actions runs, and the workspace's MCP servers' events through OpenCode Console. The session wakes on its own when they change.",
        },
        exposure,
        execute: (_id, params, _signal, _update, ctx) =>
          state
            .run(
              McpWatches.run(state.store, ctx.sessionManager.getSessionId(), tool.name, record(params)).pipe(
                Effect.map((result) => ({
                  content: [{ type: "text" as const, text: result.text }],
                  details: result.structured,
                })),
              ),
            )
            .catch((error: unknown) => ({
              content: [{ type: "text" as const, text: McpWatches.failureText(error) }],
              details: undefined,
              isError: true,
            })),
      }),
    )

  return {
    /** Offers the tools and holds the connection while the workspace has event watches, and drops both once not. */
    sync: async (ctx: ExtensionContext) => {
      const on = signedIn(state) && WorkspaceSnapshot.watches(await InProcess.config(state))
      if (on !== current.registered) {
        register(on ? "direct" : "hidden")
        current.registered = on
      }
      // A one-shot run ends before an update could wake it, so it leaves the events for the next interactive session.
      const listen = on && ctx.mode !== "print" && ctx.mode !== "json"
      if (!listen) return stop()
      if (current.connection) return
      const scope = Effect.runSync(Scope.make())
      current.connection = scope
      await state
        .run(
          ConsoleWatches.connect({
            store: state.store,
            deliver: deliver(ctx.sessionManager.getSessionId()),
            harness: `pi/${VERSION}`,
          }).pipe(Scope.provide(scope)),
        )
        .catch(() => stop())
    },
    stop,
    /** Counts the session's wakes from zero again, when the user prompts. */
    prompted: async (ctx: ExtensionContext) => {
      if (!current.registered) return
      await Effect.runPromise(ConsoleWatches.resetStreak(state.store, ctx.sessionManager.getSessionId()))
    },
    /**
     * Watches what a finished shell command started, such as the pull request `gh pr create` printed or the branch
     * `git push` updated. It runs beside the tool call, which never waits on Console; a failure only skips the watch,
     * and a refusal tells the agent why (`ConsoleWatches.watchStarted`).
     */
    shell: (ctx: ExtensionContext, command: string, result: unknown) => {
      if (!current.registered) return
      const shell = Option.getOrUndefined(decodeShellResult(result))?.structuredContent
      const target = shell && ConsoleWatches.shellTarget(command, { exit: shell.exit_code, output: shell.output })
      if (target === undefined) return
      void state
        .run(ConsoleWatches.watchStarted(state.store, ctx.sessionManager.getSessionId(), target))
        .then((created) => {
          if (created.notice !== undefined)
            pi.sendMessage(
              { customType: WATCH_MESSAGE, content: created.notice, display: true },
              { deliverAs: "steer" },
            )
        })
        .catch(() => undefined)
    },
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {}
}

/**
 * Whether the member is signed in, read on every event so signing in or out while Pi runs takes effect. A sign-in
 * that can't be read counts as signed in: every check then fails, and denies.
 */
function signedIn(state: InProcess.Session) {
  return Effect.runSync(
    Effect.try(() => ConsoleCredentials.read(state.store) !== undefined).pipe(Effect.orElseSucceed(() => true)),
  )
}

// The policy's decision on the provider of the model Pi is about to call, or a denial when it can't be decided.
async function providerDecision(state: InProcess.Session, ctx: ExtensionContext) {
  const provider = ctx.model?.provider
  if (!provider || !signedIn(state)) return undefined
  return InProcess.decide(state, [{ action: "provider.use", resources: [provider] }]).catch((error: unknown) =>
    failed(provider, error),
  )
}

function failed(subject: string, error: unknown) {
  return {
    effect: "deny" as const,
    message: `opencode-console couldn't check ${subject}: ${error instanceof Error ? error.message : String(error)}`,
  }
}

const skillsFolder = (state: InProcess.Session) => path.join(Pi.directory(state.store), "skills")

/**
 * Registers the workspace's MCP servers that are new or changed since the last call, for the session Pi runs once it
 * says, and unregisters the ones it stopped offering. Registering a server again reconnects it, so an unchanged one is
 * left alone, and one Pi refuses doesn't keep the others from registering.
 */
async function registerServers(
  pi: ExtensionAPI,
  state: InProcess.Session,
  offered: Map<string, string>,
  sessionID: string | undefined,
) {
  const snapshot = await InProcess.config(state)
  const servers = WorkspaceSnapshot.servers(snapshot)
  // The gateway watches what a session's Slack and GitHub writes start when its servers name the session.
  const session =
    sessionID !== undefined && WorkspaceSnapshot.watches(snapshot)
      ? { [ConsoleClient.watchSessionHeader]: sessionID }
      : {}
  ;[...offered.keys()]
    .filter((name) => !(name in servers))
    .forEach((name) => {
      offered.delete(name)
      Effect.runSync(Effect.try(() => pi.unregisterMcpServer(name)).pipe(Effect.ignore))
    })
  Object.entries(servers).forEach(([name, server]) => {
    const registration = {
      url: server.url,
      // Only a gateway server, the one kind with headers, hears the session.
      ...(server.headers ? { headers: { ...server.headers, ...session } } : {}),
    }
    const key = JSON.stringify(registration)
    if (offered.get(name) === key) return
    // A server the member configured under the same name in mcp.json wins over this one in Pi.
    Effect.runSync(
      Effect.try(() => {
        pi.registerMcpServer(name, registration)
        offered.set(name, key)
      }).pipe(Effect.ignore),
    )
  })
}

async function resolveToken(state: InProcess.Session) {
  const credential = await state.run(ConsoleCredentials.fresh(state.store))
  if (!credential) return undefined
  return {
    auth: { apiKey: credential.type === "key" ? credential.key : credential.access },
    source: "OpenCode Console",
  }
}

// The gateway keeps a conversation on one upstream for prompt caching by `x-opencode-session`, as Pi's own OpenCode
// providers send it.
function withSession(streams: ProviderStreams): ProviderStreams {
  const session = <O extends { sessionId?: string | undefined; headers?: ProviderHeaders | undefined }>(
    options: O | undefined,
  ) =>
    options?.sessionId
      ? { ...options, headers: { ...options.headers, "x-opencode-session": options.sessionId } }
      : options
  return {
    ...streams,
    stream: (model, context, options) => streams.stream(model, context, session(options)),
    streamSimple: (model, context, options) => streams.streamSimple(model, context, session(options)),
  }
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") {
  if (ctx.hasUI) ctx.ui.notify(message, level)
}
