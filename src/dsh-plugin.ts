/**
 * The OpenCode Console plugin for DeepSeek Harness (github.com/deepseek-ai/deepseek-harness, a Cordis plugin, as
 * everything there is). `setup deepseek-harness` loads it from DeepSeek Harness's home patch layer, so every profile
 * runs it in its own process: it checks every tool call, `/skill` and model request against the workspace's policies,
 * answers the member's token to the workspace's model routes and the workspace's MCP servers their headers from memory,
 * adds the workspace's instructions to the system prompt, keeps the patch up to date with the workspace's config, and
 * wakes a session when a Slack thread or GitHub work it watches changes.
 */

import os from "node:os"
import path from "node:path"
import type { EventWatch } from "./event-watch"
import { Effect, Exit, Option, Schema, Scope } from "effect"
import { version } from "../package.json" with { type: "json" }
import { ConsoleCredentials } from "./credentials"
import { DeepSeekHarness } from "./deepseek-harness"
import { InProcess } from "./in-process"
import { Instruction } from "./instruction"
import { McpWatches } from "./mcp-watches"
import { SettingsFile } from "./settings-file"
import { WorkspaceSnapshot } from "./snapshot"
import { ConsoleStore } from "./store"
import { ConsoleWatches } from "./watches"
import { WorkspaceSync } from "./workspace-sync"

/** The parts of DeepSeek Harness's plugin context the plugin uses (`@deepseek-ai/cordis` and the harness's services). */
export interface Context {
  readonly tools: {
    guard(guard: (execution: ToolExecution) => string | undefined): () => void
    register(definition: ToolDefinition, options?: { readonly when?: () => boolean }): () => void
  }
  on(name: "tools/pre-execute", listener: PreExecute, prepend?: boolean): () => boolean
  on(name: "tools/result", listener: ToolResult): () => boolean
  on(name: "llm/stream", listener: Stream, prepend?: boolean): () => boolean
  on(name: "llm-pi-ai/request-headers", listener: RequestHeaders): () => boolean
  on(name: "agent/pre-step", listener: PreStep, prepend?: boolean): () => boolean
  on(name: "agent/created", listener: (payload: { readonly agent: LiveAgent }) => undefined): () => boolean
  provide(name: string, value: unknown): () => void
  get(name: "fs"): FileSystem | undefined
  get(name: "workingDirectory"): WorkingDirectory | undefined
  get(name: "systemPrompt"): SystemPrompt | undefined
  get(name: "agents"): Agents | undefined
  effect(execute: () => () => void, label?: string): () => void
}

export interface ToolExecution {
  readonly name: string
  readonly arguments: unknown
  readonly token: symbol
  readonly signal: AbortSignal
  readonly agent?: Agent | undefined
}
/** A session's agent; its ID is the session's. */
interface Agent {
  readonly id: string
  readonly session?:
    | {
        readonly header?:
          | {
              readonly cwd?: string | undefined
              /** The session that started this one, for a subagent's. */
              readonly parentSession?: string | undefined
            }
          | undefined
      }
    | undefined
}
/** A live agent, which takes input: `steer` starts a turn when idle, `inject` waits for the next one. */
export interface LiveAgent extends Agent {
  steer(message: Notice): void
  inject(message: Notice): void
}
/** The harness's live agents (`ctx.agents`), every session this process runs, by session ID. */
export interface Agents {
  get(id: string): LiveAgent | undefined
}
/**
 * Input as DeepSeek Harness's agents take it (`createUserMessage` in `@deepseek-ai/dsh-llm`): a user-role message from a
 * source of the plugin's own, which the transcript shows as a one-line notice.
 */
export interface Notice {
  readonly id: string
  readonly role: "user"
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
  readonly source: { readonly kind: string; readonly form: "notice"; readonly summary: string }
}
/** A tool as `tools.register` takes one (`ToolDefinition` in `@deepseek-ai/dsh-tools`). */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): Array<{ readonly type: "text"; readonly text: string }>
  }
  execute(args: unknown, execution: ToolExecution): Promise<unknown>
}
/** A tool call's final outcome, which `tools/result` observes once nothing can change it. */
export interface ToolOutcome {
  readonly isError: boolean
  readonly value?: unknown
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>
}
type ToolResult = (execution: ToolExecution, result: ToolOutcome) => undefined
type PreToolDecision =
  | { readonly kind: "allow" | "cancel" | "ask" }
  | { readonly kind: "deny"; readonly reason: string }
type PreExecute = (execution: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>
type Stream = (options: { readonly provider: string }, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>
type RequestHeaders = (
  request: { readonly provider: string; readonly sessionId?: string | undefined },
  headers: Headers,
  next: () => Headers,
) => Headers
type PreStepDecision = { readonly kind: "reject" | "enter" }
type PreStep = (
  payload: {
    readonly agent: Agent
    readonly messages: ReadonlyArray<{ readonly source?: unknown; readonly content?: unknown }>
  },
  next: () => Promise<PreStepDecision>,
) => Promise<PreStepDecision>
export interface FileSystem {
  resolve(input: string, options: { readonly cwd?: string; readonly signal?: AbortSignal }): Promise<unknown>
  processPath(target: unknown): string
}
export interface WorkingDirectory {
  ensure(agent: Agent, signal?: AbortSignal): Promise<string>
}
interface SystemPrompt {
  section(section: {
    readonly name: string
    readonly order: number
    readonly text: () => string
    readonly interpolate: false
  }): () => void
  getSectionOrder(name: string): number
}

export const name = "opencode-console"
export const inject = ["tools", "llm"]

/** Wires the plugin into DeepSeek Harness. Anything it can't wire throws, which keeps the agent loop from starting. */
export function apply(ctx: Context) {
  if (typeof ctx.tools?.guard !== "function")
    throw new Error(
      "opencode-console needs a newer DeepSeek Harness (tools.guard). Upgrade dsh, or run `npx @opencode/console setup deepseek-harness --remove`.",
    )
  const harness = harnessName(ConsoleStore.make())
  const state = InProcess.session(harness ? { harness } : {})
  install(ctx, state)
}

/**
 * What the plugin registers, against `state`: its listeners, its guard and the services its rows read. Kept apart from
 * `install` so tests run each one as DeepSeek Harness would.
 */
export function handlers(ctx: Pick<Context, "get">, state: InProcess.Session) {
  const checked = new WeakSet<ToolExecution>()
  const servers = () => {
    return WorkspaceSnapshot.servers(workspaceSnapshot(state))
  }
  const watches = watching(ctx, state)
  const preExecute: PreExecute = async (execution, next) => {
    const decision = await toolChecks(ctx, state, execution)
      .then((inputs) => InProcess.decide(state, inputs))
      .catch((error: unknown) => failed(execution.name, error))
    if (decision?.effect === "deny") return { kind: "deny", reason: decision.message }
    checked.add(execution)
    return next()
  }
  const guard = (execution: ToolExecution) => {
    if (checked.delete(execution)) return undefined
    return `opencode-console didn't check ${execution.name}, so it was blocked`
  }
  const stream: Stream = (options, next) =>
    (async function* () {
      const decision = await InProcess.decide(state, [
        { action: "provider.use", resources: providers(options.provider) },
      ]).catch((error: unknown) => failed(options.provider, error))
      if (decision?.effect === "deny") throw new Error(decision.message)
      yield* next()
    })()
  const requestHeaders: RequestHeaders = (request, headers, next) => {
    if (request.sessionId && headers.has("x-opencode-plugin")) headers.set("x-opencode-session", request.sessionId)
    return next()
  }
  const preStep: PreStep = async (payload, next) => {
    // A person writing counts the session's wakes from zero again.
    if (payload.messages.some((message) => SettingsFile.record(message.source).kind === "user"))
      await watches.prompted(payload.agent.id)
    const names = DeepSeekHarness.invokedSkills(payload.messages)
    if (names.length === 0) return next()
    const decision = await InProcess.decide(
      state,
      names.map((skill) => ({ action: "skill", resources: [skill] })),
    ).catch((error: unknown) => failed(`/${names.join(", /")}`, error))
    if (decision?.effect !== "deny") return next()
    throw new Error(decision.message)
  }
  return {
    preExecute,
    guard,
    stream,
    requestHeaders,
    preStep,
    credentials: credentials(state),
    /** The workspace's MCP servers as their rows connect to them, headers included, read when a row starts. */
    mcp: { server: (name: string) => DeepSeekHarness.mcpConfig(name, servers()[name]) },
    servers,
    instructions: () => {
      return Instruction.prompt(WorkspaceSnapshot.instructions(workspaceSnapshot(state))) ?? ""
    },
    watches,
  }
}

/** Registers the plugin's listeners and services with DeepSeek Harness. */
export function install(ctx: Context, state: InProcess.Session) {
  const plugin = handlers(ctx, state)
  ctx.provide("credentials", plugin.credentials)
  // The agent loop waits for this service (setup's patch), so no agent runs unless the plugin is wired.
  ctx.provide(DeepSeekHarness.SERVICE, { version })
  // First in line, so a call the policy denies is refused before any other listener asks the member to approve it.
  ctx.on("tools/pre-execute", plugin.preExecute, true)
  // A guard can only deny, after every listener, so a call another listener let through before this plugin's listener
  // ran is still refused.
  ctx.tools.guard(plugin.guard)
  // Every model request is checked against the policy as it is now, so a session on a provider the workspace stops
  // allowing is stopped before it sends.
  ctx.on("llm/stream", plugin.stream, true)
  // The gateway keeps a conversation on one upstream for prompt caching by `x-opencode-session`.
  ctx.on("llm-pi-ai/request-headers", plugin.requestHeaders)
  // A `/name` skill a member types is loaded without a tool call, so it's checked before the step starts. A denial
  // fails the step with the policy's message, which DeepSeek Harness shows the member.
  ctx.on("agent/pre-step", plugin.preStep, true)
  // Event watches: the `console_watch` tools while the workspace offers them, the updates a resumed session missed,
  // and watches on what a finished tool call started.
  plugin.watches.tools.forEach((tool) => ctx.tools.register(tool, { when: plugin.watches.offered }))
  ctx.on("agent/created", plugin.watches.created)
  ctx.on("tools/result", plugin.watches.result)

  const prompt = ctx.get("systemPrompt")
  if (prompt)
    prompt.section({
      name: "opencode_workspace_instructions",
      order: prompt.getSectionOrder("MCP_SERVERS") + 50,
      interpolate: false,
      text: plugin.instructions,
    })

  // The workspace's MCP server rows read their config from this service when they start. It's provided again when a
  // server's URL or headers change, such as the gateway's daily token, which restarts them.
  const offered = {
    servers: JSON.stringify(plugin.servers()),
    dispose: ctx.provide(DeepSeekHarness.MCP_SERVICE, plugin.mcp),
  }

  // Keeps the config fresh, and brings the patch (models, MCP servers), skills and the event connection up to date after
  // each new one.
  const reconciled: { fetched?: number | undefined } = {}
  const tick = async () => {
    const snapshot = signedIn(state) ? await InProcess.config(state) : undefined
    await plugin.watches.sync(snapshot)
    if (snapshot === undefined || snapshot.fetched === reconciled.fetched) return
    reconciled.fetched = snapshot.fetched
    await state.run(DeepSeekHarness.refresh(state.store))
    const current = JSON.stringify(plugin.servers())
    if (current === offered.servers) return
    offered.dispose()
    offered.servers = current
    offered.dispose = ctx.provide(DeepSeekHarness.MCP_SERVICE, plugin.mcp)
  }
  ctx.effect(() => {
    void tick().catch(() => undefined)
    const timer = setInterval(() => void tick().catch(() => undefined), 60_000)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      void plugin.watches.stop()
    }
  }, "opencode-console sync")
}

/** The custom message source a watched update arrives from, in the transcript and the session log. */
const WATCH_SOURCE = "opencode-console-watch"
/** How long a notice's one-line summary may be (`CONTEXT_SUMMARY_MAX_CHARS` in `@deepseek-ai/dsh-llm`). */
const SUMMARY_LIMIT = 120

const shells = new Set(["bash", "pwsh"])
const decodeShellArgs = Schema.decodeUnknownOption(Schema.Struct({ command: Schema.String }))
// DeepSeek Harness's shell tools answer a finished command with its exit code and both streams; `git push` writes to
// stderr.
const decodeShellValue = Schema.decodeUnknownOption(
  Schema.Struct({
    kind: Schema.Literal("foreground"),
    exitCode: Schema.NullOr(Schema.Number),
    stdout: Schema.Struct({ text: Schema.String }),
    stderr: Schema.Struct({ text: Schema.String }),
  }),
)

/**
 * The member's event watches while the workspace offers them (`WorkspaceSnapshot.watches`): one event connection for
 * every session this process runs, the `console_watch` tools, and watches on what tool calls start. Without them there
 * is nothing: no connection, no tools and no requests. Each update goes to its session's agent when this process runs
 * it, and waits on the Console for the process that does otherwise. Watches outlive their session, so a resumed one
 * still gets what came meanwhile.
 */
function watching(ctx: Pick<Context, "get">, state: InProcess.Session) {
  const current: { scope?: Scope.Closeable | undefined; connection?: ConsoleWatches.Connection | undefined } = {}

  /** Hands each session this process runs its own updates, and answers the IDs it handed over. */
  const deliver: ConsoleWatches.Deliver = (events) =>
    Effect.forEach(
      Map.groupBy(events, (event) => event.sessionID),
      ([sessionID, mine]) => {
        const agent = ctx.get("agents")?.get(sessionID)
        if (agent === undefined) return Effect.succeed([])
        return ConsoleWatches.recordWake(state.store, sessionID, mine).pipe(
          // Past the loop guard's limits the update waits for the user's next prompt, so two agents can't loop.
          Effect.flatMap((wake) =>
            Effect.try(() => (wake === "held" ? agent.inject(notice(mine, wake)) : agent.steer(notice(mine, wake)))),
          ),
          Effect.as(mine.map((event) => event.id)),
          // An agent DeepSeek Harness already disposed takes nothing; its updates wait for the next connection.
          Effect.orElseSucceed(() => []),
        )
      },
    ).pipe(Effect.map((ids) => ids.flat()))

  const stop = async () => {
    const scope = current.scope
    current.scope = undefined
    current.connection = undefined
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
  }

  /** The tool `name` for the session whose agent called it. */
  const tool = (definition: (typeof McpWatches.tools)[number]): ToolDefinition => ({
    name: `console_watch_${definition.name}`,
    description: definition.description,
    parameters: definition.inputSchema,
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      render: (_args, value) => [
        { type: "text", text: Option.getOrElse(decodeText(value), () => ({ text: "" })).text },
      ],
    },
    execute: async (args, execution) => {
      const sessionID = execution.agent && conversation(execution.agent)
      // A failed call answers the agent why, as an error result.
      if (sessionID === undefined) throw new Error("opencode-console doesn't know which session called this")
      const done = await state
        .run(McpWatches.run(state.store, sessionID, definition.name, SettingsFile.record(args)))
        .catch((error: unknown) => Promise.reject(new Error(McpWatches.failureText(error))))
      return { text: done.text, result: done.structured }
    },
  })

  /**
   * The conversation an agent works in: a subagent's root session, which the user talks to, so what a subagent starts
   * wakes the conversation it works for; else the agent's own. A parent this process no longer runs ends the walk.
   */
  const conversation = (agent: Agent): string => {
    const parent = agent.session?.header?.parentSession
    if (parent === undefined) return agent.id
    const live = ctx.get("agents")?.get(parent)
    return live ? conversation(live) : parent
  }

  /** Watches `target` for the session whose tool call started it; it runs beside the call, which never waits on it. */
  const watch = (sessionID: string, target: string | EventWatch.Target, mode?: "once") =>
    void state.run(ConsoleWatches.create(state.store, sessionID, target, mode)).catch(() => undefined)

  return {
    /** Holds the event connection while `snapshot` offers event watches, and closes it once not. */
    sync: async (snapshot: WorkspaceSnapshot.Info | undefined) => {
      if (!WorkspaceSnapshot.watches(snapshot)) return stop()
      if (current.scope) return
      const scope = Effect.runSync(Scope.make())
      current.scope = scope
      const harness = harnessName(state.store)
      const connection = await state
        .run(
          ConsoleWatches.connect({ store: state.store, deliver, ...(harness ? { harness } : {}) }).pipe(
            Scope.provide(scope),
          ),
        )
        .catch(() => stop().then(() => undefined))
      // Watches may have turned off again meanwhile, which closed this connection.
      if (current.scope === scope) current.connection = connection
    },
    stop,
    /** Whether the workspace offers event watches now, which offers the tools for the next step. */
    offered: () => WorkspaceSnapshot.watches(workspaceSnapshot(state)),
    tools: McpWatches.tools.map(tool),
    /** Hands a session DeepSeek Harness resumes the updates that came for it before it ran here. */
    created: (payload: { readonly agent: LiveAgent }) => {
      const connection = current.connection
      if (connection) void state.run(connection.drain(payload.agent.id)).catch(() => undefined)
      return undefined
    },
    /** Counts the session's wakes from zero again, when the user prompts. */
    prompted: async (sessionID: string) => {
      if (!current.scope) return
      await Effect.runPromise(ConsoleWatches.resetStreak(state.store, sessionID)).catch(() => undefined)
    },
    /**
     * Watches what a finished tool call started: the pull request `gh pr create` printed, the branch `git push`
     * updated, and the Slack thread or GitHub work a gateway server's write tool made, since DeepSeek Harness's MCP
     * calls don't name their session to the gateway. What a subagent starts is watched for its root conversation.
     */
    result: (execution: ToolExecution, outcome: ToolOutcome) => {
      const sessionID = execution.agent && conversation(execution.agent)
      if (!current.scope || sessionID === undefined || outcome.isError) return undefined
      const command = Option.getOrUndefined(decodeShellArgs(execution.arguments))?.command
      const shell = Option.getOrUndefined(decodeShellValue(outcome.value))
      if (shells.has(execution.name) && command !== undefined && shell !== undefined) {
        const target = ConsoleWatches.shellTarget(command, {
          exit: shell.exitCode ?? undefined,
          output: `${shell.stdout.text}\n${shell.stderr.text}`,
        })
        if (target !== undefined) watch(sessionID, target)
        return undefined
      }
      const tool = gatewayTool(execution.name, WorkspaceSnapshot.servers(workspaceSnapshot(state)))
      if (tool === undefined) return undefined
      const texts = outcome.content.flatMap((block) =>
        block.type === "text" && block.text !== undefined ? [block.text] : [],
      )
      ConsoleWatches.toolTargets(tool, execution.arguments, texts).forEach((item) =>
        watch(sessionID, item.target, item.mode),
      )
      return undefined
    },
  }
}

const decodeText = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }))

/** A watched update for one session, as its agent takes it. */
function notice(events: ReadonlyArray<ConsoleWatches.WatchEvent>, wake: ConsoleWatches.Wake): Notice {
  const summary = ConsoleWatches.summary(events)
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: [{ type: "text", text: ConsoleWatches.wakeText(events, wake) }],
    source: {
      kind: WATCH_SOURCE,
      form: "notice",
      summary: summary.length <= SUMMARY_LIMIT ? summary : `${summary.slice(0, SUMMARY_LIMIT - 1)}…`,
    },
  }
}

/**
 * The server's own name for a tool of one of the workspace's gateway servers (the ones with headers, which only the
 * gateway's carry), from DeepSeek Harness's `mcp__<server>__<tool>`, by the longest server name it starts with, since a
 * server's name can hold `__` itself; nothing for any other tool. A server of the member's or workspace's own may name
 * its tools as GitHub's do, which `toolTargets` would take for GitHub writes.
 */
function gatewayTool(name: string, servers: ReturnType<typeof WorkspaceSnapshot.servers>) {
  const server = Object.entries(servers)
    .filter(([key, item]) => item.headers !== undefined && name.startsWith(`mcp__${key}__`))
    .map(([key]) => key)
    .toSorted((a, b) => b.length - a.length)[0]
  return server === undefined ? undefined : name.slice(`mcp__${server}__`.length)
}

/**
 * The credential store only the workspace's model routes read (their `isolate` label): the member's current token, read
 * for each request. Nothing else resolves, nothing is ever stored, and a token that can't be read resolves to nothing,
 * which fails the request.
 */
function credentials(state: InProcess.Session) {
  const resolve = async (ref: string) => {
    if (ref === DeepSeekHarness.TOKEN) {
      const credential = await state.run(ConsoleCredentials.fresh(state.store))
      if (!credential) return undefined
      return { value: credential.type === "key" ? credential.key : credential.access, source: "OpenCode Console" }
    }
    return undefined
  }
  const readOnly = () => Promise.reject(new Error("OpenCode Console's credentials are read-only"))
  return {
    resolve,
    describe: async (ref: string) => ({ configured: (await resolve(ref)) !== undefined, writable: false }),
    set: readOnly,
    unset: readOnly,
    readRecord: () => Promise.resolve(undefined),
    describeRecord: () => Promise.resolve({ configured: false, writable: false }),
    listRecords: () => Promise.resolve([]),
    modifyRecord: readOnly,
    deleteRecord: () => Promise.resolve(),
  }
}

/** The checks a tool call needs, with paths resolved by DeepSeek Harness's own filesystem from the session's cwd. */
async function toolChecks(ctx: Pick<Context, "get">, state: InProcess.Session, execution: ToolExecution) {
  const agent = execution.agent
  const working = ctx.get("workingDirectory")
  const fs = ctx.get("fs")
  // Paths are named as DeepSeek Harness's filesystem names them, by their real paths, the session's project and
  // current directory included, so a project under a symlink holds the files the tools resolve inside it.
  const canonical = async (input: string, from: string) =>
    fs
      ? fs.processPath(await fs.resolve(input, { cwd: from, signal: execution.signal }))
      : path.resolve(from, input.replace(/^~(?=$|[\\/])/, os.homedir()))
  const project = agent?.session?.header?.cwd ?? process.cwd()
  const current = agent && working ? await working.ensure(agent, execution.signal) : project
  const directory = await canonical(project, project)
  const cwd = await canonical(current, current)
  const snapshot = workspaceSnapshot(state)
  const skills = DeepSeekHarness.manifest(state.store)?.paths.skills
  return DeepSeekHarness.checks(
    { name: execution.name, input: execution.arguments },
    {
      directory,
      cwd,
      resolve: (input) => canonical(input, cwd),
      servers: Object.keys(WorkspaceSnapshot.servers(snapshot)),
      ...(skills ? { skills: await canonical(skills, skills) } : {}),
    },
  )
}

/**
 * The stored workspace config, instructions and skills for the current sign-in, or nothing when there's no sign-in, it
 * can't be read, or they were fetched for another member or workspace.
 */
function workspaceSnapshot(state: InProcess.Session) {
  return Effect.runSync(
    Effect.try(() => {
      const credential = ConsoleCredentials.read(state.store)
      return credential ? WorkspaceSync.current(state.store, ConsoleCredentials.owner(credential)) : undefined
    }).pipe(Effect.orElseSucceed(() => undefined)),
  )
}

/**
 * The providers a model route stands for: its own name, and for DeepSeek's own routes (`deepseek-official`,
 * `deepseek-account`) DeepSeek's provider ID as OpenCode names it, so a rule naming either applies.
 */
function providers(route: string) {
  return route.startsWith("deepseek-") ? [route, "deepseek"] : [route]
}

/**
 * Whether the member is signed in, read on every check so signing in or out while DeepSeek Harness runs takes effect.
 * A sign-in that can't be read counts as signed in: every check then fails, and denies.
 */
function signedIn(state: InProcess.Session) {
  return Effect.runSync(
    Effect.try(() => ConsoleCredentials.read(state.store) !== undefined).pipe(Effect.orElseSucceed(() => true)),
  )
}

function failed(subject: string, error: unknown) {
  return {
    effect: "deny" as const,
    message: `opencode-console couldn't check ${subject}: ${error instanceof Error ? error.message : String(error)}`,
  }
}

// DeepSeek Harness's product token as setup recorded it, which names it to the Console.
function harnessName(store: ConsoleStore.Info) {
  return Effect.runSync(
    Effect.try(() => DeepSeekHarness.manifest(store)?.harness).pipe(Effect.orElseSucceed(() => undefined)),
  )
}
