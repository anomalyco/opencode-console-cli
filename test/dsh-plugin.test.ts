import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import {
  type Agents,
  type FileSystem,
  handlers,
  type LiveAgent,
  type Notice,
  type ToolExecution,
  type ToolOutcome,
  type WorkingDirectory,
} from "../src/dsh-plugin"
import { InProcess } from "../src/in-process"
import { WorkspaceSnapshot } from "../src/snapshot"
import { ConsoleWatches } from "../src/watches"
import { WorkspaceSync } from "../src/workspace-sync"
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

// The plugin's listeners, guard and services against a stand-in Console, run as DeepSeek Harness's tool pipeline, model
// streaming and agent steps run them.
const folders: string[] = []
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  // Last in, first out: the plugin closes its event connection before the Console it streams from stops.
  for (const item of cleanup.splice(0).reverse()) await item()
  removeStores()
  folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true }))
})

/**
 * DeepSeek Harness's local filesystem as the plugin sees it: a path resolves from the session's directory to its real
 * path, missing files under their real directory (`@deepseek-ai/dsh-fs-local`, `resolveLocalTarget`).
 */
const fs: FileSystem = {
  resolve: async (input, options) => {
    const absolute = path.resolve(options.cwd ?? "/", input)
    const missing: string[] = []
    let existing = absolute
    for (; !existsSync(existing); existing = path.dirname(existing)) missing.unshift(path.basename(existing))
    return path.join(realpathSync(existing), ...missing)
  },
  processPath: (target) => String(target),
}

/**
 * The plugin for a member of Acme whose synced workspace config is `config`, against a Console that serves `config` and
 * `instructions`; `sync` fetches them again.
 */
function harness(
  config: Record<string, unknown>,
  options: { readonly cwd?: string; readonly instructions?: readonly unknown[] } = {},
) {
  const console = fakeConsole({
    config: () => Response.json(config),
    instructions: () => Response.json({ instructions: options.instructions ?? [] }),
  })
  const store = temporaryStore()
  save(store, signIn(console, Number.MAX_SAFE_INTEGER))
  WorkspaceSnapshot.write(store, {
    owner: JSON.stringify([server, "usr_ada", "org_acme"]),
    organization: "Acme",
    fetched: Date.now(),
    config,
  })
  const cwd = options.cwd
  const working: WorkingDirectory = { ensure: async () => cwd ?? process.cwd() }
  function get(name: "fs"): FileSystem | undefined
  function get(name: "workingDirectory"): WorkingDirectory | undefined
  function get(name: "systemPrompt"): undefined
  function get(name: "agents"): undefined
  function get(name: string) {
    if (cwd === undefined) return undefined
    return name === "fs" ? fs : name === "workingDirectory" ? working : undefined
  }
  const session = InProcess.session({ store, fetch: console.fetch })
  const plugin = handlers({ get }, session)
  return {
    console,
    store,
    plugin,
    sync: () => session.run(WorkspaceSync.sync(store, { force: true })),
    /** A tool call through the pre-execute policy and then the guard, as DeepSeek Harness's pipeline runs them. */
    call: async (name: string, input: unknown) => {
      const execution = {
        name,
        arguments: input,
        token: Symbol(name),
        signal: new AbortController().signal,
        ...(cwd === undefined ? {} : { agent: { id: "ses_1", session: { header: { cwd } } } }),
      }
      const decision = await plugin.preExecute(execution, async () => ({ kind: "allow" }))
      if (decision.kind !== "allow") return decision
      const denied = plugin.guard(execution)
      return denied === undefined ? decision : { kind: "deny", reason: denied }
    },
    stream: async (provider: string) => {
      const chunks: unknown[] = []
      for await (const chunk of plugin.stream({ provider }, async function* () {
        yield "sent"
      }))
        chunks.push(chunk)
      return chunks
    },
    step: (text: string) =>
      plugin.preStep(
        { agent: { id: "ses_1" }, messages: [{ source: { kind: "user" }, content: [{ type: "text", text }] }] },
        async () => ({ kind: "enter" }),
      ),
  }
}

const deny = (resource: string) => ({ action: "tool.use", resource, effect: "deny" })

test("refuses a tool call the workspace's policy denies, and lets the rest through", async () => {
  const dsh = harness({ policies: [deny("shell:rm *")] })

  const denied = await dsh.call("bash", { description: "x", command: "ls && rm -rf ./probe" })
  const allowed = await dsh.call("bash", { description: "x", command: "ls" })

  expect([denied, allowed]).toEqual([{ kind: "deny", reason: "Blocked by Acme's policy" }, { kind: "allow" }])
})

test("refuses a tool call it can't read, naming what's missing", async () => {
  const dsh = harness({ policies: [] })

  expect(await dsh.call("bash", { description: "no command" })).toEqual({
    kind: "deny",
    reason: "opencode-console couldn't check bash: bash's input has no command",
  })
})

test("blocks a call another listener let through before the plugin checked it", () => {
  const dsh = harness({ policies: [] })

  expect(
    dsh.plugin.guard({ name: "write", arguments: {}, token: Symbol("write"), signal: new AbortController().signal }),
  ).toBe("opencode-console didn't check write, so it was blocked")
})

test("stops a model request to a provider the policy denies before it sends, DeepSeek's own routes included", async () => {
  const dsh = harness({ policies: [{ action: "provider.use", resource: "deepseek", effect: "deny" }] })

  expect(dsh.stream("deepseek-official")).rejects.toThrow("Blocked by Acme's policy")
  expect(await dsh.stream("opencode")).toEqual(["sent"])
})

test("fails a step that runs a skill the policy denies, and starts one that runs none", async () => {
  const dsh = harness({ policies: [{ action: "skill.use", resource: "deploy", effect: "deny" }] })

  expect(dsh.step("/deploy staging")).rejects.toThrow("Blocked by Acme's policy")
  expect(await dsh.step("deploy staging")).toEqual({ kind: "enter" })
})

test("answers the workspace's model routes with the member's current token, and nothing else", async () => {
  const dsh = harness({})
  const credentials = dsh.plugin.credentials

  expect([
    (await credentials.resolve("OPENCODE_CONSOLE_TOKEN"))?.value,
    await credentials.resolve("OPENAI_API_KEY"),
  ]).toEqual([dsh.console.state.access, undefined])
})

test("gives a workspace MCP server row its URL and headers from memory", () => {
  const dsh = harness({
    mcp: {
      servers: {
        github: { type: "remote", url: "https://console.test/mcp/github", headers: { Authorization: "Bearer ocgw_1" } },
      },
    },
  })
  const mcp = dsh.plugin.mcp

  expect(mcp.server("github")).toEqual({
    serverName: "github",
    transport: "streamable-http",
    url: "https://console.test/mcp/github",
    headers: { Authorization: "Bearer ocgw_1" },
  })
  expect(() => mcp.server("slack")).toThrow("doesn't offer the MCP server slack")
})

test("decides files in a project under a symlink by the real paths DeepSeek Harness's tools resolve", async () => {
  const real = mkdtempSync(path.join(os.tmpdir(), "opencode-console-dsh-project-"))
  const link = `${real}-link`
  folders.push(real, link)
  mkdirSync(path.join(real, "src"))
  symlinkSync(real, link)
  const dsh = harness({ policies: [deny("read:.env"), deny("external_directory:*")] }, { cwd: link })

  expect([await dsh.call("read", { file_path: ".env" }), await dsh.call("read", { file_path: "src/a.ts" })]).toEqual([
    { kind: "deny", reason: "Blocked by Acme's policy" },
    { kind: "allow" },
  ])
})

test("gives the model the workspace's instructions as one system prompt section", async () => {
  const dsh = harness({}, { instructions: [{ id: "ins_1", name: "Style", content: "Use tabs." }] })

  await dsh.sync()

  expect(dsh.plugin.instructions()).toBe("## Style\n\nUse tabs.")
})

test("reads nothing stored for another member or workspace", async () => {
  const dsh = harness(
    { mcp: { servers: { github: { type: "remote", url: "https://console.test/mcp/github" } } } },
    { instructions: [{ id: "ins_1", name: "Style", content: "Use tabs." }] },
  )
  await dsh.sync()

  save(dsh.store, { ...signIn(dsh.console, Number.MAX_SAFE_INTEGER), accountID: "usr_bob", orgID: "org_other" })

  expect(dsh.plugin.instructions()).toBe("")
  expect(() => dsh.plugin.mcp.server("github")).toThrow("doesn't offer the MCP server github")
})

/**
 * The plugin for a member of Acme against a Console on this machine over real HTTP and WebSockets, whose synced config
 * (`config`) offers event watches unless `watches: false`; `listed` are the member's live watches. DeepSeek Harness's
 * live agents are the ones `resident` adds. Each event connection's socket arrives in `sockets`, and the index of each
 * one the plugin closed in `closed`. `sync` runs what the plugin's config sync does with the stored config.
 */
async function watching(
  options: {
    readonly watches?: boolean
    readonly config?: Record<string, unknown>
    readonly listed?: ReadonlyArray<Record<string, unknown>>
    /** Answers each new watch, as `serveConsole`'s `create` does. */
    readonly create?: () => Response
  } = {},
) {
  const sockets = inbox<{ send: (frame: string) => void }>()
  const closed = inbox<number>()
  const console = serveConsole(
    { watches: { watches: options.listed ?? [], ...(options.create ? { create: options.create } : {}) } },
    { open: (socket) => sockets.push(socket), close: (index) => closed.push(index) },
  )
  cleanup.push(console.stop)
  const store = temporaryStore()
  save(store, signIn(console, Number.MAX_SAFE_INTEGER, console.url))
  const owner = JSON.stringify([console.url, "usr_ada", "org_acme"])
  const configure = (watches: boolean) =>
    WorkspaceSnapshot.write(store, {
      owner,
      organization: "Acme",
      fetched: Date.now(),
      config: options.config ?? {},
      ...(watches ? { watches: true } : {}),
    })
  configure(options.watches !== false)
  const live = new Map<string, LiveAgent>()
  const agents: Agents = { get: (id) => live.get(id) }
  function get(name: "fs" | "workingDirectory" | "systemPrompt"): undefined
  function get(name: "agents"): Agents
  function get(name: string) {
    return name === "agents" ? agents : undefined
  }
  const plugin = handlers({ get }, InProcess.session({ store }))
  cleanup.push(() => plugin.watches.stop())
  return {
    console,
    store,
    plugin,
    sockets,
    closed,
    configure,
    sync: () => plugin.watches.sync(WorkspaceSync.current(store, owner)),
    /**
     * A live agent for the session `id`, a subagent of `parent`'s when given, recording what it was steered with and
     * what was injected for later.
     */
    resident: (id: string, parent?: string) => {
      const steered = inbox<Notice>()
      const injected = inbox<Notice>()
      const agent: LiveAgent = {
        id,
        ...(parent === undefined ? {} : { session: { header: { parentSession: parent } } }),
        steer: steered.push,
        inject: injected.push,
      }
      live.set(id, agent)
      return { agent, steered, injected }
    },
  }
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

const text = (notice: Notice) => notice.content.map((block) => block.text).join("")

/** A tool call the session `sessionID`'s agent made, as DeepSeek Harness's tool pipeline hands it to listeners. */
const execution = (name: string, input: unknown, sessionID: string): ToolExecution => ({
  name,
  arguments: input,
  token: Symbol(name),
  signal: new AbortController().signal,
  agent: { id: sessionID },
})

/** A finished bash command's outcome, as DeepSeek Harness's bash tool answers one. */
const shell = (stdout: string, stderr: string): ToolOutcome => ({
  isError: false,
  value: { kind: "foreground", exitCode: 0, stdout: { text: stdout }, stderr: { text: stderr } },
  content: [{ type: "text", text: `${stdout}${stderr}` }],
})

/** Runs the plugin's watch tool `name` for the session `sessionID` as DeepSeek Harness does, answering what the model reads. */
async function tool(dsh: Awaited<ReturnType<typeof watching>>, name: string, input: unknown, sessionID: string) {
  const found = dsh.plugin.watches.tools.find((item) => item.name === name)
  if (found === undefined) throw new Error(`No tool ${name}`)
  const value = await found.execute(input, execution(name, input, sessionID))
  return found.output.render(input, value)
}

test("offers no watch tools while the workspace has no event watches", async () => {
  const dsh = await watching({ watches: false })

  expect(dsh.plugin.watches.offered()).toBe(false)
})

test("offers the watch tools while the workspace has event watches", async () => {
  const dsh = await watching()

  expect(dsh.plugin.watches.offered()).toBe(true)
})

test("closes the event connection once the workspace stops offering event watches", async () => {
  const dsh = await watching()
  await dsh.sync()
  await dsh.sockets.at(0)

  dsh.configure(false)
  await dsh.sync()

  expect(await dsh.closed.at(0)).toBe(0)
})

test("steers each session this process runs with its own update over one connection, acknowledging only theirs", async () => {
  const dsh = await watching()
  const a = dsh.resident("ses_a")
  const b = dsh.resident("ses_b")
  await dsh.sync()
  await dsh.sync()
  const socket = await dsh.sockets.at(0)

  socket.send(events(comment("ev_a", "ses_a"), comment("ev_b", "ses_b"), comment("ev_elsewhere", "ses_elsewhere")))
  const acked = await dsh.console.state.acked.at(0)
  const steered = await a.steered.at(0)

  expect({
    acked,
    connections: dsh.console.upgrades.count,
    source: steered.source,
    a: text(steered).includes("octocat commented on acme/app#7"),
    b: b.steered.items.length,
  }).toEqual({
    acked: ["ev_a", "ev_b"],
    connections: 1,
    source: { kind: "opencode-console-watch", form: "notice", summary: "acme/app#7 on GitHub" },
    a: true,
    b: 1,
  })
})

test("holds an update for the session's next turn, without waking it, once five wakes ran in 10 minutes", async () => {
  const dsh = await watching()
  const a = dsh.resident("ses_a")
  await Effect.runPromise(Effect.repeat(ConsoleWatches.recordWake(dsh.store, "ses_a"), { times: 4 }))
  await dsh.sync()
  const socket = await dsh.sockets.at(0)

  socket.send(events(comment("ev_6", "ses_a")))
  await dsh.console.state.acked.at(0)

  expect({
    steered: a.steered.items.length,
    injected: a.injected.items.map((notice) => text(notice).split("\n\n").at(-1)),
  }).toEqual({ steered: 0, injected: ["Further updates wait for the user's next prompt."] })
})

test("wakes the session again once the user's own message starts a step after five unattended wakes", async () => {
  const dsh = await watching()
  const a = dsh.resident("ses_a")
  await Effect.runPromise(Effect.repeat(ConsoleWatches.recordWake(dsh.store, "ses_a"), { times: 4 }))
  await dsh.sync()
  const socket = await dsh.sockets.at(0)

  await dsh.plugin.preStep(
    { agent: { id: "ses_a" }, messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "hi" }] }] },
    async () => ({ kind: "enter" }),
  )
  socket.send(events(comment("ev_after_user", "ses_a")))
  await dsh.console.state.acked.at(0)

  expect({ steered: a.steered.items.length, injected: a.injected.items.length }).toEqual({ steered: 1, injected: 0 })
})

test("hands a session DeepSeek Harness resumes the update that came before it ran here", async () => {
  const dsh = await watching()
  dsh.resident("ses_a")
  await dsh.sync()
  const socket = await dsh.sockets.at(0)
  socket.send(events(comment("ev_a", "ses_a"), comment("ev_later", "ses_later")))
  await dsh.console.state.acked.at(0)

  const later = dsh.resident("ses_later")
  dsh.plugin.watches.created({ agent: later.agent })

  expect({ acked: await dsh.console.state.acked.at(1), steered: later.steered.items.length }).toEqual({
    acked: ["ev_later"],
    steered: 1,
  })
})

test("watches the pull request a bash command's `gh pr create` printed, for the session that ran it", async () => {
  const dsh = await watching()
  await dsh.sync()

  dsh.plugin.watches.result(
    execution("bash", { command: "gh pr create --fill" }, "ses_a"),
    shell("https://github.com/acme/app/pull/7\n", ""),
  )
  await until(() => dsh.console.state.created.length === 1)

  expect(dsh.console.state.created).toEqual([{ sessionID: "ses_a", target: "https://github.com/acme/app/pull/7" }])
})

test("tells the session's agent why Console refused to watch what its bash command started", async () => {
  const dsh = await watching({
    create: () =>
      Response.json(
        { _tag: "WatchRefused", message: "GitHub isn't available to your account in this workspace." },
        { status: 403 },
      ),
  })
  await dsh.sync()
  const a = dsh.resident("ses_a")

  dsh.plugin.watches.result(
    execution("bash", { command: "gh pr create --fill" }, "ses_a"),
    shell("https://github.com/acme/app/pull/7\n", ""),
  )

  expect(text(await a.injected.at(0))).toBe(
    "OpenCode Console can't watch this, so changes to it won't wake this session. Tell the user why: GitHub isn't available to your account in this workspace.",
  )
})

test("watches the branch a bash command's `git push` updated, which git reports on stderr", async () => {
  const dsh = await watching()
  await dsh.sync()

  dsh.plugin.watches.result(
    execution("bash", { command: "git push" }, "ses_a"),
    shell("", "To github.com:acme/app.git\n   abc1234..def5678  fix-login -> fix-login\n"),
  )
  await until(() => dsh.console.state.created.length === 1)

  expect(dsh.console.state.created).toEqual([
    { sessionID: "ses_a", target: { _tag: "GitHubBranch", repo: "acme/app", branch: "fix-login" } },
  ])
})

test("watches the Slack thread a message through the workspace's gateway started, and the channel's top level, for the session that sent it", async () => {
  const dsh = await watching({
    config: {
      mcp: {
        servers: {
          slack: { type: "remote", url: "https://console.test/mcp/slack", headers: { authorization: "Bearer mcp-1" } },
        },
      },
    },
  })
  await dsh.sync()

  dsh.plugin.watches.result(
    execution("mcp__slack__slack_send_message", { channel_id: "C0123", message: "Up" }, "ses_a"),
    {
      isError: false,
      content: [{ type: "text", text: JSON.stringify({ ok: true, channel: "C0123", ts: "1731000000.000100" }) }],
    },
  )
  await until(() => dsh.console.state.created.length === 2)

  expect(dsh.console.state.created).toEqual([
    { sessionID: "ses_a", target: { _tag: "SlackThread", channelID: "C0123", threadTs: "1731000000.000100" } },
    { sessionID: "ses_a", target: { _tag: "SlackChannelTop", channelID: "C0123" } },
  ])
})

test("watches what a subagent's subagent started for the root conversation the user is in", async () => {
  const dsh = await watching()
  dsh.resident("ses_root")
  dsh.resident("ses_lead", "ses_root")
  await dsh.sync()

  dsh.plugin.watches.result(
    {
      ...execution("bash", { command: "gh pr create --fill" }, "ses_worker"),
      agent: { id: "ses_worker", session: { header: { parentSession: "ses_lead" } } },
    },
    shell("https://github.com/acme/app/pull/7\n", ""),
  )
  await until(() => dsh.console.state.created.length === 1)

  expect(dsh.console.state.created).toEqual([{ sessionID: "ses_root", target: "https://github.com/acme/app/pull/7" }])
})

test("watches nothing a GitHub-named tool on a server outside the gateway wrote", async () => {
  const dsh = await watching({
    config: {
      mcp: {
        servers: {
          github: {
            type: "remote",
            url: "https://console.test/mcp/github",
            headers: { authorization: "Bearer mcp-1" },
          },
          tracker: { type: "remote", url: "https://tracker.example.com/mcp" },
        },
      },
    },
  })
  await dsh.sync()
  const opened = (number: number): ToolOutcome => ({
    isError: false,
    content: [{ type: "text", text: JSON.stringify({ number }) }],
  })

  dsh.plugin.watches.result(
    execution("mcp__tracker__create_pull_request", { owner: "acme", repo: "app", title: "Ours" }, "ses_a"),
    opened(3),
  )
  // A gateway write after it, whose watch arrives once the other's would have.
  dsh.plugin.watches.result(
    execution("mcp__github__create_pull_request", { owner: "acme", repo: "app", title: "Fix" }, "ses_a"),
    opened(12),
  )
  await until(() => dsh.console.state.created.length >= 1)

  expect(dsh.console.state.created).toEqual([
    { sessionID: "ses_a", target: { _tag: "GitHubIssue", repo: "acme/app", number: 12 } },
  ])
})

test("the watch tool watches for the root conversation when a subagent calls it", async () => {
  const dsh = await watching()
  dsh.resident("ses_root")
  const found = dsh.plugin.watches.tools.find((item) => item.name === "console_watch_watch")

  await found?.execute(
    { target: "acme/app#7" },
    {
      ...execution("console_watch_watch", { target: "acme/app#7" }, "ses_sub"),
      agent: { id: "ses_sub", session: { header: { parentSession: "ses_root" } } },
    },
  )

  expect(dsh.console.state.created).toEqual([{ sessionID: "ses_root", target: "acme/app#7" }])
})

test("the watch tool watches its target for the session whose agent called it", async () => {
  const dsh = await watching()

  const answer = await tool(dsh, "console_watch_watch", { target: "acme/app#7" }, "ses_a")

  expect({ created: dsh.console.state.created, answer }).toEqual({
    created: [{ sessionID: "ses_a", target: "acme/app#7" }],
    answer: [
      {
        type: "text",
        text: "Watching github:acme/app#7 until 2026-11-10T12:00:00.000Z (ew_1). This session wakes when it changes.",
      },
    ],
  })
})

/** A live watch of the session `sessionID`'s, as Console lists it. */
const listed = (id: string, sessionID: string) => ({
  id,
  sessionID,
  routingKey: `github:acme/app#${id.slice(3)}`,
  mode: "sliding",
  expiresAt: "2026-11-10T12:00:00.000Z",
})

test("the watches tool lists only what the calling session watches", async () => {
  const dsh = await watching({ listed: [listed("ew_7", "ses_a"), listed("ew_8", "ses_b")] })

  expect(await tool(dsh, "console_watch_watches", {}, "ses_a")).toEqual([
    { type: "text", text: "ew_7: github:acme/app#7 until 2026-11-10T12:00:00.000Z" },
  ])
})

test("the unwatch tool refuses to stop another session's watch", async () => {
  const dsh = await watching({ listed: [listed("ew_8", "ses_b")] })

  await expect(tool(dsh, "console_watch_unwatch", { id: "ew_8" }, "ses_a")).rejects.toThrow(
    "This session has no watch ew_8",
  )
  expect(dsh.console.state.cancelled).toEqual([])
})
