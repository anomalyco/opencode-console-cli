import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import { InProcess } from "../src/in-process"
import { Instruction } from "../src/instruction"
import { Pi } from "../src/pi"
import { WorkspaceSnapshot } from "../src/snapshot"
import { WorkspaceSync } from "../src/workspace-sync"
import { fakeConsole, removeStores, save, server, signIn, temporaryStore, until } from "./support/console"

const homes: string[] = []
afterEach(() => {
  removeStores()
  homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true }))
})

const inference = "https://console.test/inference"
// Entries in the shape `GET /api/v1/models` serves (`OpenCodeConfig.models`): models.dev's v2 entry for each model,
// with `api` naming the Console URL that serves it in its protocol.
const entry = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  name: id,
  type: "chat",
  capabilities: { tools: { supported: true } },
  modalities: { input: ["text"], output: ["text"] },
  api: { messages: { base_url: `${inference}/anthropic/v1` } },
  ...fields,
})
const noBuiltins: Pi.Builtin = () => undefined

test("serves each provider's chat models to Pi in their own protocol at the gateway", () => {
  const providers = Pi.providers(
    {
      opencode: {
        name: "Acme / OpenCode",
        models: {
          "claude-sonnet-4-6": entry("claude-sonnet-4-6", { name: "Claude Sonnet 4.6" }),
          "omni-moderation-latest": entry("omni-moderation-latest", { capabilities: { tools: { supported: false } } }),
        },
      },
      "opencode-go": {
        name: "OpenCode Go",
        models: {
          "glm-5": entry("glm-5", { api: { "chat-completions": { base_url: `${inference}/go/v1` } } }),
          "realtime-1": entry("realtime-1", { api: { live: { base_url: `${inference}/openai/v1` } } }),
        },
      },
      "console-acme-openai": {
        name: "Acme / OpenAI",
        models: { "gpt-5.4": entry("gpt-5.4", { api: { responses: { base_url: `${inference}/custom/conn_1` } } }) },
      },
    },
    noBuiltins,
  )

  expect(
    providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map((model) => [model.id, model.name, model.api, model.baseUrl]),
    })),
  ).toEqual([
    {
      id: "opencode",
      name: "Acme / OpenCode",
      models: [["claude-sonnet-4-6", "Claude Sonnet 4.6", "anthropic-messages", `${inference}/anthropic`]],
    },
    {
      id: "opencode-go",
      name: "OpenCode Go",
      models: [["glm-5", "glm-5", "openai-completions", `${inference}/go/v1`]],
    },
    {
      id: "console-acme-openai",
      name: "Acme / OpenAI",
      models: [["gpt-5.4", "gpt-5.4", "openai-responses", `${inference}/custom/conn_1`]],
    },
  ])
})

test("reads a model's limits, price, images and reasoning from the Console's entry", () => {
  const [provider] = Pi.providers(
    {
      opencode: {
        models: {
          "kimi-k2.5": entry("kimi-k2.5", {
            limit: { context: 262_144, output: 32_768 },
            cost: { text: { input: { price: 0.6, cache: { read: 0.15 } }, output: { price: 2.5 } } },
            modalities: { input: ["text", "image/*"], output: ["text"] },
            capabilities: { tools: { supported: true }, reasoning: { supported: true } },
          }),
        },
      },
    },
    noBuiltins,
  )

  expect(provider?.models[0]).toMatchObject({
    contextWindow: 262_144,
    maxTokens: 32_768,
    cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
    input: ["text", "image"],
    reasoning: true,
  })
})

test("prices a cache write by its first retention, or by a request's own cache breakpoints", () => {
  const priced = (cache: Record<string, unknown>) =>
    Pi.providers(
      {
        opencode: {
          models: { a: entry("a", { cost: { text: { input: { price: 3, cache }, output: { price: 15 } } } }) },
        },
      },
      noBuiltins,
    )[0]?.models[0]?.cost.cacheWrite

  expect([priced({ read: 0.3, write: { "5m": 3.75, "1h": 6 } }), priced({ explicit: { write: 4 } })]).toEqual([3.75, 4])
})

test("keeps Pi's protocol settings for a model Pi ships, with the Console's name, limits and endpoint", () => {
  const shipped: Model<Api> = {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5 (Zen)",
    api: "anthropic-messages",
    provider: "opencode",
    baseUrl: "https://opencode.ai/inference/anthropic",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200_000,
    maxTokens: 64_000,
    thinkingLevelMap: { off: null, xhigh: "xhigh" },
    compat: { forceAdaptiveThinking: true },
  }
  const [provider] = Pi.providers(
    {
      opencode: {
        models: {
          "claude-opus-5-5": entry("claude-opus-5-5", { name: "Claude Opus 5.5", limit: { context: 1_000_000 } }),
        },
      },
    },
    (id, model) => (id === "opencode" && model === "claude-opus-5-5" ? shipped : undefined),
  )

  expect(provider?.models[0]).toMatchObject({
    name: "Claude Opus 5.5",
    baseUrl: `${inference}/anthropic`,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    thinkingLevelMap: { off: null, xhigh: "xhigh" },
    compat: { forceAdaptiveThinking: true },
  })
})

test("starts new sessions on the newest Claude Sonnet the member may use, from a provider Pi can call", () => {
  const model = Pi.defaultModel({
    opencode: {
      models: {
        "claude-sonnet-5-0": entry("claude-sonnet-5-0", {
          release_date: "2026-10-01",
          api: { live: { base_url: inference } },
        }),
        "claude-sonnet-4-6": entry("claude-sonnet-4-6", { release_date: "2026-02-17" }),
        "claude-sonnet-4-5": entry("claude-sonnet-4-5", { release_date: "2025-09-29" }),
      },
    },
    "opencode-go": { models: { "glm-5": entry("glm-5") } },
  })

  expect(model).toEqual({ provider: "opencode", id: "claude-sonnet-4-6" })
})

test.each([
  ["bash", { command: "rm -rf build" }, { action: "shell", resources: ["rm -rf build"], shell: "bash" }],
  ["powershell", { command: "Remove-Item x" }, { action: "shell", resources: ["Remove-Item x"], shell: "pwsh" }],
  ["read", { path: "@src/a.ts" }, { action: "read", resources: ["src/a.ts"] }],
  ["write", { path: ".env", content: "x" }, { action: "edit", resources: [".env"] }],
  ["edit", { path: "/etc/hosts", edits: [] }, { action: "edit", resources: ["/etc/hosts"] }],
  ["ls", {}, { action: "read", resources: ["."] }],
  ["grep", { pattern: "TODO", path: "/tmp" }, { action: "grep", resources: ["TODO"], path: "/tmp" }],
  ["find", { pattern: "**/*.ts" }, { action: "glob", resources: ["**/*.ts"] }],
  ["read_mcp_resource", { server: "github", uri: "repo://x" }, { action: "mcp.use", resources: ["github"] }],
  ["codemode", { code: "1" }, { action: "codemode", resources: ["*"] }],
])("checks Pi's %s tool as OpenCode's matching permission", (toolName, input, expected) => {
  expect(Pi.checks({ toolName, input }, { cwd: "/work/app" })).toEqual([{ ...expected, directory: "/work/app" }])
})

test("checks an MCP tool against its server's mcp.use and the tool's own permission, `-` and `_` alike", () => {
  const named = Pi.checks({ toolName: "mcp__my_docs__search_pages", input: {} }, { cwd: "/w", server: "my-docs" })
  const unnamed = Pi.checks({ toolName: "mcp__github__create_issue", input: {} }, { cwd: "/w" })

  expect([named, unnamed]).toEqual([
    [
      { action: "mcp.use", resources: ["my-docs"], directory: "/w" },
      { action: "my-docs_search_pages", resources: ["*"], directory: "/w", folded: true },
    ],
    [
      { action: "mcp.use", resources: ["github"], directory: "/w", folded: true },
      { action: "github_create_issue", resources: ["*"], directory: "/w", folded: true },
    ],
  ])
})

const acme = (policies: unknown[]) => {
  const console = fakeConsole()
  const store = temporaryStore()
  save(store, signIn(console, Number.MAX_SAFE_INTEGER))
  WorkspaceSnapshot.write(store, {
    owner: JSON.stringify([server, "usr_ada", "org_acme"]),
    organization: "Acme",
    fetched: Date.now(),
    config: { policies },
  })
  return InProcess.session({ store, fetch: console.fetch })
}
const deny = (resource: string) => ({ action: "tool.use", resource, effect: "deny" })
const blocked = { effect: "deny" as const, message: "Blocked by Acme's policy" }

test("denies an MCP tool by the rule Console writes for it, though Pi writes its `-` as `_`", async () => {
  const session = acme([deny("github_create-issue:*")])

  const decision = await InProcess.decide(
    session,
    Pi.checks({ toolName: "mcp__github__create_issue", input: {} }, { cwd: "/w", server: "github" }),
  )

  expect(decision).toEqual(blocked)
})

test("denies an MCP tool Pi shortened while a rule could deny one of its server's tools, and only then", async () => {
  const toolName = `mcp__github__${"x".repeat(42)}_1a2b3c4d`
  const call = Pi.checks({ toolName, input: {} }, { cwd: "/w", server: "github" })

  const ruled = await InProcess.decide(acme([deny("github_delete-repo:*")]), call)
  const unruled = await InProcess.decide(acme([deny("slack_post:*")]), call)

  expect([ruled, unruled]).toEqual([blocked, undefined])
})

test("checks mcp.use on the server Pi names for a tool it shortened, not the server its name suggests", () => {
  const checks = Pi.checks(
    { toolName: `mcp__my_docs__${"x".repeat(41)}_0f0f0f0f`, input: {} },
    { cwd: "/w", server: "my-docs" },
  )

  expect(checks).toEqual([
    { action: "mcp.use", resources: ["my-docs"], directory: "/w" },
    { action: "my-docs_", resources: ["*"], directory: "/w", truncated: true, folded: true },
  ])
})

test("denies a shortened tool of a server whose name Pi wrote with _ for -, by the server's rules", async () => {
  const call = Pi.checks({ toolName: `mcp__my_docs__${"x".repeat(41)}_0f0f0f0f`, input: {} }, { cwd: "/w" })

  expect(await InProcess.decide(acme([deny("my-docs_delete-page:*")]), call)).toEqual(blocked)
})

test("checks a resource listing against the server it names, or every server Pi knows", () => {
  const named = Pi.checks({ toolName: "list_mcp_resources", input: { server: "github" } }, { cwd: "/w" })
  const unnamed = Pi.checks(
    { toolName: "list_mcp_resource_templates", input: {} },
    { cwd: "/w", servers: ["github", "slack"] },
  )

  expect([named[0]?.resources, unnamed[0]?.resources]).toEqual([["github"], ["github", "slack"]])
})

test.each([
  ["a file:// URL", "file:///etc/hosts", "/etc/hosts"],
  ["an escaped file:// URL", "file:///work/app/%2eenv", "/work/app/.env"],
  ["a home path", "~/notes.md", "/home/ada/notes.md"],
  ["Unicode spaces", "@my\u00A0notes.md", "my notes.md"],
])("reads %s as Pi's file tools resolve it", (_name, input, expected) => {
  expect(Pi.checks({ toolName: "read", input: { path: input } }, { cwd: "/work/app", home: "/home/ada" })).toEqual([
    { action: "read", resources: [expected], directory: "/work/app" },
  ])
})

test("denies a read the policy denies when Pi would open it through a file:// URL", async () => {
  const decision = await InProcess.decide(
    acme([deny("read:.env")]),
    Pi.checks({ toolName: "read", input: { path: "file:///work/app/%2eenv" } }, { cwd: "/work/app" }),
  )

  expect(decision).toEqual(blocked)
})

test("blocks a file:// URL that names no local file", () => {
  expect(() => Pi.checks({ toolName: "read", input: { path: "file://server/share/a" } }, { cwd: "/w" })).toThrow()
})

test("checks reading a workspace skill's file as running the skill, which external_directory doesn't stop", async () => {
  const skills = "/data/opencode-console/pi/skills"
  const read = (file: string) => Pi.checks({ toolName: "read", input: { path: file } }, { cwd: "/work/app", skills })

  const skill = await InProcess.decide(acme([deny("external_directory:*")]), read(`${skills}/deploy/SKILL.md`))
  const outside = await InProcess.decide(acme([deny("external_directory:*")]), read("/etc/hosts"))
  const denied = await InProcess.decide(
    acme([{ action: "skill.use", resource: "deploy", effect: "deny" }]),
    read(`${skills}/deploy/scripts/run.sh`),
  )
  const written = Pi.checks({ toolName: "write", input: { path: `${skills}/deploy/SKILL.md` } }, { cwd: "/w", skills })

  expect([skill, outside, denied, written[0]?.action]).toEqual([undefined, blocked, blocked, "edit"])
})

test("refuses to guess at a tool call missing the input it's checked by", () => {
  expect(() => Pi.checks({ toolName: "bash", input: { timeout: 5 } }, { cwd: "/w" })).toThrow(Pi.Unreadable)
})

test("reads the skill a prompt runs, and nothing from a prompt that runs none", () => {
  expect([Pi.skillCommand("/skill:deploy staging"), Pi.skillCommand("deploy /skill:x")]).toEqual(["deploy", undefined])
})

/** A member signed in to Acme with a synced config, and an empty Pi agent directory. */
function member(config: Record<string, unknown> = {}, models: Record<string, unknown> = {}) {
  const console = fakeConsole({ config: () => Response.json(config), models: () => Response.json(models) })
  const store = temporaryStore()
  save(store, signIn(console, Number.MAX_SAFE_INTEGER))
  const snapshot = (fetched: number, value: Record<string, unknown>) =>
    WorkspaceSnapshot.write(store, {
      owner: JSON.stringify([server, "usr_ada", "org_acme"]),
      organization: "Acme",
      fetched,
      config: value,
    })
  snapshot(Date.now(), config)
  const home = mkdtempSync(path.join(os.tmpdir(), "opencode-console-pi-"))
  homes.push(home)
  const paths = Pi.paths({}, home)
  return { console, store, paths, snapshot, session: InProcess.session({ store, fetch: console.fetch }) }
}

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"))
const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2))
}

test("finds Pi's settings in PI_CODING_AGENT_DIR, else ~/.pi/agent", () => {
  expect([Pi.paths({ PI_CODING_AGENT_DIR: "~/agents/pi" }, "/home/ada"), Pi.paths({}, "/home/ada")]).toEqual([
    { agent: "/home/ada/agents/pi", settings: "/home/ada/agents/pi/settings.json" },
    { agent: "/home/ada/.pi/agent", settings: "/home/ada/.pi/agent/settings.json" },
  ])
})

test("lists the extension beside the member's own and starts new sessions on the workspace's model", () => {
  const pi = member()
  write(pi.paths.settings, {
    theme: "dark",
    extensions: ["/mine/guard.ts"],
    defaultModel: "gpt-5",
    defaultProvider: "openai",
  })

  Pi.setup(pi.store, {
    paths: pi.paths,
    extension: "/data/cli/pi-extension.js",
    model: { provider: "opencode", id: "claude-sonnet-4-6" },
  })

  expect(json(pi.paths.settings)).toEqual({
    theme: "dark",
    extensions: ["/mine/guard.ts", "/data/cli/pi-extension.js"],
    defaultModel: "claude-sonnet-4-6",
    defaultProvider: "opencode",
  })
})

test("replaces the extension an earlier setup listed rather than add a second", () => {
  const pi = member()
  Pi.setup(pi.store, { paths: pi.paths, extension: "/old/cli/pi-extension.js" })

  Pi.setup(pi.store, { paths: pi.paths, extension: "/new/cli/pi-extension.js" })

  expect(json(pi.paths.settings).extensions).toEqual(["/new/cli/pi-extension.js"])
})

test("moves Pi to the installed extension after an update, keeping the member's model and extensions", () => {
  const pi = member()
  write(pi.paths.settings, { extensions: ["/mine/guard.ts"] })
  Pi.setup(pi.store, { paths: pi.paths, extension: "/old/cli/pi-extension.js" })
  write(pi.paths.settings, { ...json(pi.paths.settings), defaultModel: "gpt-5", defaultProvider: "openai" })

  expect(Pi.refresh(pi.store, "/data/cli/pi-extension.js")).toBe(true)

  expect(json(pi.paths.settings)).toEqual({
    extensions: ["/mine/guard.ts", "/data/cli/pi-extension.js"],
    defaultModel: "gpt-5",
    defaultProvider: "openai",
  })
  expect(Pi.manifest(pi.store)?.extension).toBe("/data/cli/pi-extension.js")
})

test("leaves Pi alone after an update when it already loads the installed extension, or was never set up", () => {
  const pi = member()
  expect(Pi.refresh(pi.store, "/data/cli/pi-extension.js")).toBe(false)
  Pi.setup(pi.store, { paths: pi.paths, extension: "/data/cli/pi-extension.js" })

  expect(Pi.refresh(pi.store, "/data/cli/pi-extension.js")).toBe(false)
})

test("puts Pi's settings back as they were on removal", () => {
  const pi = member()
  const before = { theme: "dark", extensions: ["/mine/guard.ts"], defaultModel: "gpt-5", defaultProvider: "openai" }
  write(pi.paths.settings, before)
  Pi.setup(pi.store, {
    paths: pi.paths,
    extension: "/data/cli/pi-extension.js",
    model: { provider: "opencode", id: "claude-sonnet-4-6" },
  })

  Pi.remove(pi.store)

  expect(json(pi.paths.settings)).toEqual(before)
  expect(existsSync(`${pi.paths.settings}.opencode-console.bak`)).toBe(false)
})

test("keeps a default model the member picked after setup on removal, and deletes a settings file it created", () => {
  const picked = member()
  Pi.setup(picked.store, { paths: picked.paths, extension: "/x.js", model: { provider: "opencode", id: "a" } })
  write(picked.paths.settings, { ...json(picked.paths.settings), defaultProvider: "anthropic", defaultModel: "b" })
  const created = member()
  Pi.setup(created.store, { paths: created.paths, extension: "/x.js", model: { provider: "opencode", id: "a" } })

  Pi.remove(picked.store)
  Pi.remove(created.store)

  expect(json(picked.paths.settings)).toEqual({ defaultProvider: "anthropic", defaultModel: "b" })
  expect(existsSync(created.paths.settings)).toBe(false)
})

test("never writes over Pi settings that aren't JSON", () => {
  const pi = member()
  write(pi.paths.settings, "{ theme: dark")

  expect(() => Pi.setup(pi.store, { paths: pi.paths, extension: "/x.js" })).toThrow("isn't valid JSON")
  expect(readFileSync(pi.paths.settings, "utf8")).toBe("{ theme: dark")
})

test("refuses to run over a record of a previous setup it can't read", () => {
  const pi = member()
  write(pi.paths.settings, { theme: "dark" })
  writeFileSync(Pi.manifestFile(pi.store), "{ broken")

  expect(() => Pi.setup(pi.store, { paths: pi.paths, extension: "/x.js" })).toThrow("can't be read")
  expect(json(pi.paths.settings)).toEqual({ theme: "dark" })
})

test("backs up the member's settings readable only by them", () => {
  const pi = member()
  write(pi.paths.settings, { theme: "dark" })

  Pi.setup(pi.store, { paths: pi.paths, extension: "/x.js" })

  expect(json(`${pi.paths.settings}.opencode-console.bak`)).toEqual({ theme: "dark" })
  expect(statSync(`${pi.paths.settings}.opencode-console.bak`).mode & 0o777).toBe(0o600)
})

const policies = [{ action: "tool.use", resource: "shell:rm *", effect: "deny" }]

test("blocks a tool call the workspace's policy denies, naming the workspace", async () => {
  const pi = member({ policies })

  const denied = await InProcess.decide(
    pi.session,
    Pi.checks({ toolName: "bash", input: { command: "ls && rm -rf x" } }, { cwd: pi.paths.agent }),
  )
  const allowed = await InProcess.decide(
    pi.session,
    Pi.checks({ toolName: "bash", input: { command: "ls" } }, { cwd: pi.paths.agent }),
  )

  expect([denied, allowed]).toEqual([{ effect: "deny", message: "Blocked by Acme's policy" }, undefined])
})

test("decides from a stale config at once and refreshes it in the background for the next call", async () => {
  const pi = member({ policies: [] })
  pi.snapshot(Date.now() - 120_000, { policies })

  const denied = await InProcess.decide(pi.session, [Pi.userBash({ command: "rm -rf x", cwd: pi.paths.agent })])
  await until(() => WorkspaceSnapshot.policies(WorkspaceSnapshot.read(pi.store))?.length === 0)
  const allowed = await InProcess.decide(pi.session, [Pi.userBash({ command: "rm -rf x", cwd: pi.paths.agent })])

  expect([denied?.effect, allowed]).toEqual(["deny", undefined])
  expect(pi.console.state.configs).toBe(1)
})

test("refreshes a stale config in the background at most once every 30 seconds", async () => {
  const pi = member({ policies })
  pi.snapshot(Date.now() - 120_000, { policies })

  const started = [InProcess.refreshStale(pi.session), InProcess.refreshStale(pi.session)]

  expect(started).toEqual([true, false])
})

test("blocks everything while a signed-in workspace's policy can't be loaded", async () => {
  const console = fakeConsole({ config: () => new Response("unavailable", { status: 503 }) })
  const store = temporaryStore()
  save(store, signIn(console, Number.MAX_SAFE_INTEGER))

  const decision = await InProcess.decide(InProcess.session({ store, fetch: console.fetch }), [
    { action: "read", resources: ["a.md"] },
  ])

  expect(decision).toEqual({ effect: "deny", message: "Blocked until Acme's policy loads from OpenCode Console" })
})

test("asks the Console for models again only when the config's providers change", async () => {
  const pi = member({ providers: { opencode: {} } }, { opencode: { models: { a: entry("a") } } })

  await Pi.models(pi.session)
  await Pi.models(pi.session)
  const unchanged = pi.console.state.requests.filter((item) => item.url.endsWith("/api/v1/models")).length
  pi.snapshot(Date.now(), { providers: { opencode: {}, "opencode-go": {} } })
  await Pi.models(pi.session)

  expect([unchanged, pi.console.state.requests.filter((item) => item.url.endsWith("/api/v1/models")).length]).toEqual([
    1, 2,
  ])
})

test("writes the workspace's skills where Pi loads them, and deletes one the member can't use anymore", async () => {
  const offered = { skills: [{ slug: "deploy", version: "skl_1:1" }] }
  const console = fakeConsole({
    skills: () => Response.json(offered),
    bundles: {
      deploy: {
        format: 2,
        slug: "deploy",
        version: "skl_1:1",
        files: [
          { kind: "text", path: "SKILL.md", content: '---\nname: "Deploy"\ndescription: "Ship it"\n---\n\nSteps' },
        ],
      },
    },
  })
  const store = temporaryStore()
  save(store, signIn(console, Number.MAX_SAFE_INTEGER))
  const session = InProcess.session({ store, fetch: console.fetch })

  const folder = await Pi.skills(session)
  const written = readFileSync(path.join(folder, "deploy", "SKILL.md"), "utf8")
  offered.skills = []
  await session.run(WorkspaceSync.sync(store, { force: true }))
  await Pi.skills(session)

  expect(written).toBe('---\ndescription: "Ship it"\n---\n\nSteps')
  expect(existsSync(path.join(folder, "deploy"))).toBe(false)
})

test("joins the workspace's instructions into one section, and adds none without any", () => {
  expect([
    Instruction.prompt([
      { name: "Security", content: "Never log secrets.\n" },
      { name: "Style", content: "Use tabs." },
    ]),
    Instruction.prompt([]),
  ]).toEqual(["## Security\n\nNever log secrets.\n\n## Style\n\nUse tabs.", undefined])
})
