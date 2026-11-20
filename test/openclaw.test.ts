import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { HttpClient } from "effect/http"
import { parse } from "jsonc-parser/lib/esm/main.js"
import { OpenClaw } from "../src/openclaw"
import { WorkspaceSync } from "../src/workspace-sync"
import { version } from "../package.json" with { type: "json" }
import { against, fakeConsole, removeStores, save, signIn, temporaryStore } from "./support/console"

const homes: string[] = []
afterEach(() => {
  removeStores()
  homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true }))
})

const command = ["/opt/node/bin/node", "/data/opencode-console/cli/index.js"]
// `GET /api/v1/models`: Zen's models on the gateway's protocol paths, and one of Go's.
const workspaceModels = {
  opencode: {
    name: "OpenCode",
    models: {
      "gpt-5.2": {
        id: "gpt-5.2",
        name: "GPT-5.2",
        limit: { context: 400000, output: 128000 },
        modalities: { input: ["text", "image/png", "image/jpeg"], output: ["text"] },
        api: { responses: { base_url: "https://console.test/inference/openai/v1" } },
      },
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        release_date: "2026-02-01",
        api: { messages: { base_url: "https://console.test/inference/anthropic/v1" } },
      },
    },
  },
  "opencode-go": {
    name: "OpenCode Go",
    models: {
      "kimi-k2.5": {
        id: "kimi-k2.5",
        name: "Kimi K2.5",
        api: { "chat-completions": { base_url: "https://console.test/inference/go/v1" } },
      },
    },
  },
}
const gateway = {
  web_search: {
    type: "remote",
    url: "https://console.test/console/api/integration-gateway/web_search/mcp",
    headers: { Authorization: "Bearer ocgw_secret" },
  },
  console: { type: "remote", url: "https://console.test/console/mcp" },
}

/**
 * A member of Acme signed in, and an empty OpenClaw state directory. `run` is setup's sync and refresh, `keep` setup
 * with `--keep-provider`, and `sync` a later sync's, against a Console serving `config`, the models, `instructions`,
 * `skills` and their `bundles`.
 */
function member(
  input: {
    readonly config?: Record<string, unknown>
    readonly instructions?: readonly unknown[]
    readonly skills?: readonly unknown[]
    readonly bundles?: Record<string, unknown>
  } = {},
) {
  const console = fakeConsole({
    config: () => Response.json(input.config ?? { providers: { opencode: {} } }),
    models: () => Response.json(workspaceModels),
    instructions: () => Response.json({ instructions: input.instructions ?? [] }),
    skills: () => Response.json({ skills: input.skills ?? [] }),
    ...(input.bundles === undefined ? {} : { bundles: input.bundles }),
  })
  const store = temporaryStore()
  save(store, signIn(console, Number.MAX_SAFE_INTEGER))
  const home = mkdtempSync(path.join(os.tmpdir(), "opencode-console-openclaw-"))
  homes.push(home)
  const paths = OpenClaw.paths({ env: {}, home })
  const synced = <A, E>(refresh: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    Effect.runPromise(WorkspaceSync.sync(store, { force: true }).pipe(Effect.andThen(refresh), against(console)))
  const setup = (target = paths, keepProvider = false, cli = command) =>
    synced(
      OpenClaw.refresh(store, {
        paths: target,
        command: cli,
        environment: {},
        harness: "openclaw/2026.11.5",
        keepProvider,
      }),
    )
  return {
    store,
    home,
    paths,
    run: () => setup(),
    keep: () => setup(paths, true),
    setup,
    sync: (harness?: string) => synced(OpenClaw.refresh(store, undefined, harness)),
    remove: (target = paths) => OpenClaw.remove(store, target.config),
  }
}

const read = (file: string) => readFileSync(file, "utf8")
const json = (file: string) => parse(read(file))
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

// `OPENCLAW_CONFIG_PATH` is how a Gateway's service environment names the install the plugin's helpers run for.
const hooksOff = (openclaw: {
  readonly store: Parameters<typeof OpenClaw.hooksOff>[0]
  readonly paths: OpenClaw.Paths
}) =>
  OpenClaw.hooksOff(openclaw.store, {
    env: { OPENCLAW_STATE_DIR: openclaw.paths.state, OPENCLAW_CONFIG_PATH: openclaw.paths.config },
    cwd: openclaw.paths.state,
  })
const off = (openclaw: { readonly paths: OpenClaw.Paths }) => ({
  reason: `the opencode-console plugin isn't enabled in ${openclaw.paths.config}`,
})

test("finds the plugin running once setup has enabled it", async () => {
  const openclaw = member()
  await openclaw.run()

  expect(hooksOff(openclaw)).toBeUndefined()
})

test("says nothing about an OpenClaw that was never set up", () => {
  expect(hooksOff(member())).toBeUndefined()
})

test("finds hooks off when the plugin's entry is disabled, and the next sync turns it back on", async () => {
  const openclaw = member()
  await openclaw.run()
  const config = json(openclaw.paths.config)
  write(
    openclaw.paths.config,
    JSON.stringify({ ...config, plugins: { ...config.plugins, entries: { "opencode-console": { enabled: false } } } }),
  )
  expect(hooksOff(openclaw)).toEqual(off(openclaw))

  await openclaw.sync()

  expect(hooksOff(openclaw)).toBeUndefined()
})

test("finds hooks off when the member denies the plugin or keeps an allowlist without it", async () => {
  const openclaw = member()
  await openclaw.run()
  const config = json(openclaw.paths.config)
  write(
    openclaw.paths.config,
    JSON.stringify({ ...config, plugins: { ...config.plugins, deny: ["opencode-console"] } }),
  )
  expect(hooksOff(openclaw)).toEqual(off(openclaw))

  write(openclaw.paths.config, JSON.stringify({ ...config, plugins: { ...config.plugins, allow: ["mine"] } }))
  expect(hooksOff(openclaw)).toEqual(off(openclaw))
})

test("finds hooks off when the plugin's files are gone", async () => {
  const openclaw = member()
  await openclaw.run()
  rmSync(OpenClaw.pluginDirectory(openclaw.store, openclaw.paths.config), { recursive: true })

  expect(hooksOff(openclaw)).toEqual(off(openclaw))
})

test("sends model requests to the gateway's Responses API with a token the plugin swaps in, starting on Claude Sonnet", async () => {
  const openclaw = member()

  await openclaw.run()

  const config = json(openclaw.paths.config)
  expect(config.agents).toEqual({ defaults: { model: { primary: "opencode-console/claude-sonnet-4-6" } } })
  expect(config.models.providers["opencode-console"]).toEqual({
    name: "OpenCode Console",
    baseUrl: "https://console.test/inference/openai/v1",
    api: "openai-responses",
    apiKey: "opencode-console-cli",
    headers: { "x-opencode-plugin": `opencode-console/${version}`, "User-Agent": "openclaw/2026.11.5" },
    models: [
      { id: "gpt-5.2", name: "GPT-5.2", contextWindow: 400000, maxTokens: 128000, input: ["text", "image"] },
      { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
      { id: "opencode-go/kimi-k2.5", name: "Kimi K2.5 (OpenCode Go)" },
    ],
  })
})

test("names the release of the OpenClaw that last synced, so an upgraded OpenClaw says so on its next request", async () => {
  const openclaw = member()
  await openclaw.run()

  await openclaw.sync("openclaw/2026.12.1")

  expect(json(openclaw.paths.config).models.providers["opencode-console"].headers["User-Agent"]).toBe(
    "openclaw/2026.12.1",
  )
})

test("keeps the member's own settings and comments in openclaw.json as they wrote them", async () => {
  const openclaw = member()
  write(
    openclaw.paths.config,
    '{\n  // my settings\n  "gateway": { "port": 18789 }, // keep\n  "agents": { "defaults": { "model": "openai/gpt-5.5" } },\n}\n',
  )

  await openclaw.run()

  expect(read(openclaw.paths.config)).toStartWith('{\n  // my settings\n  "gateway": { "port": 18789 }, // keep\n')
  expect(json(openclaw.paths.config).agents.defaults.model).toEqual({ primary: "opencode-console/claude-sonnet-4-6" })
})

test("puts openclaw.json back byte for byte on --remove", async () => {
  const openclaw = member({ config: { providers: { opencode: {} }, mcp: { servers: gateway } } })
  const before =
    '{\n    // mine\n    "agents": { "defaults": { "model": { "primary": "openai/gpt-5.5" } } },\n    "plugins": { "load": { "paths": ["/srv/my-plugin"] } },\n    "skills": {},\n}\n'
  write(openclaw.paths.config, before)
  await openclaw.run()

  expect(openclaw.remove()).toBe(true)

  expect(read(openclaw.paths.config)).toBe(before)
  expect(existsSync(OpenClaw.directory(openclaw.store, openclaw.paths.config))).toBe(false)
  expect(existsSync(OpenClaw.manifestFile(openclaw.store))).toBe(false)
})

test("keeps what the member changed since setup when it's removed, and takes out only setup's own", async () => {
  const openclaw = member()
  write(openclaw.paths.config, '{ "agents": { "defaults": { "model": { "primary": "openai/gpt-5.5" } } } }\n')
  await openclaw.run()
  const config = json(openclaw.paths.config)
  write(
    openclaw.paths.config,
    JSON.stringify({
      ...config,
      gateway: { port: 1 },
      agents: { defaults: { model: { primary: "opencode-console/gpt-5.2" } } },
    }),
  )

  openclaw.remove()

  expect(json(openclaw.paths.config)).toEqual({
    agents: { defaults: { model: { primary: "opencode-console/gpt-5.2" } } },
    gateway: { port: 1 },
  })
})

test("leaves OpenClaw as it is when the member has a model provider of the same name", async () => {
  const openclaw = member()
  const theirs = '{ "models": { "providers": { "opencode-console": { "baseUrl": "http://localhost:8080/v1" } } } }\n'
  write(openclaw.paths.config, theirs)

  await expect(openclaw.run()).rejects.toThrow("already has a model provider named opencode-console")
  expect(read(openclaw.paths.config)).toBe(theirs)
})

test("leaves a JSON5 openclaw.json it can't edit safely as it is", async () => {
  const openclaw = member()
  const theirs = "{ gateway: { port: 18789 } }\n"
  write(openclaw.paths.config, theirs)

  await expect(openclaw.run()).rejects.toThrow("isn't JSON setup can edit")
  expect(read(openclaw.paths.config)).toBe(theirs)
})

test("keeps the member's own providers and models with --keep-provider, and still loads the plugin", async () => {
  const openclaw = member()
  write(openclaw.paths.config, '{ "agents": { "defaults": { "model": { "primary": "anthropic/claude-opus-5" } } } }\n')

  const applied = await openclaw.keep()

  const config = json(openclaw.paths.config)
  expect(applied?.models).toBeUndefined()
  expect(config.agents.defaults.model).toEqual({ primary: "anthropic/claude-opus-5" })
  expect(config.models).toBeUndefined()
  expect(config.plugins.entries).toEqual({ "opencode-console": { enabled: true } })
})

test("points gateway MCP servers at the plugin's in-memory auth profile, so no token is written to openclaw.json", async () => {
  const openclaw = member({ config: { providers: { opencode: {} }, mcp: { servers: gateway } } })

  await openclaw.run()

  expect(json(openclaw.paths.config).mcp.servers).toEqual({
    web_search: {
      url: "https://console.test/console/api/integration-gateway/web_search/mcp",
      transport: "streamable-http",
      auth: "oauth",
      oauth: { authProfileId: "opencode-console:web_search" },
    },
    console: { url: "https://console.test/console/mcp", transport: "streamable-http", auth: "oauth" },
  })
  expect(read(openclaw.paths.config)).not.toContain("ocgw_")
  const plugin = OpenClaw.pluginDirectory(openclaw.store, openclaw.paths.config)
  expect(read(path.join(plugin, "index.cjs"))).not.toContain("ocgw_")
  expect(JSON.parse(read(path.join(plugin, "openclaw.plugin.json"))).contracts).toEqual({
    externalAuthProviders: ["opencode-console"],
  })
})

test("leaves out an MCP server whose secret is in a header OpenClaw can't take from the plugin", async () => {
  const servers = { tracker: { type: "remote", url: "https://tracker.test/mcp", headers: { "X-Api-Key": "k_secret" } } }
  const openclaw = member({ config: { providers: { opencode: {} }, mcp: { servers } } })

  const applied = await openclaw.run()

  expect(applied?.skipped).toEqual(["tracker"])
  expect(json(openclaw.paths.config).mcp).toBeUndefined()
  expect(read(openclaw.paths.config)).not.toContain("k_secret")
})

test("keeps an MCP server the member already has under the same name", async () => {
  const openclaw = member({ config: { providers: { opencode: {} }, mcp: { servers: gateway } } })
  write(openclaw.paths.config, '{ "mcp": { "servers": { "web_search": { "url": "https://mine.test/mcp" } } } }\n')

  const applied = await openclaw.run()

  expect(applied?.skipped).toEqual(["web_search"])
  expect(json(openclaw.paths.config).mcp.servers.web_search).toEqual({ url: "https://mine.test/mcp" })
})

test("enables the plugin beside the member's own, even one they had turned off or left off their allowlist", async () => {
  const openclaw = member()
  write(
    openclaw.paths.config,
    '{ "plugins": { "allow": ["mine"], "deny": ["opencode-console"], "load": { "paths": ["/srv/mine"] }, "entries": { "opencode-console": { "enabled": false } } } }\n',
  )

  await openclaw.run()

  const plugin = OpenClaw.pluginDirectory(openclaw.store, openclaw.paths.config)
  expect(json(openclaw.paths.config).plugins).toEqual({
    allow: ["mine", "opencode-console"],
    deny: [],
    load: { paths: ["/srv/mine", plugin] },
    entries: { "opencode-console": { enabled: true } },
  })
  expect(read(path.join(plugin, "index.cjs"))).toContain(`const COMMAND = ${JSON.stringify(command)};`)
})

test("writes a new openclaw.json readable only by the member, since it names their helper commands", async () => {
  const openclaw = member()

  await openclaw.run()

  expect(statSync(openclaw.paths.config).mode & 0o777).toBe(0o600)
})

test("adds the workspace's instructions to the default agent's AGENTS.md beside the member's own", async () => {
  const openclaw = member({ instructions: [{ name: "Style", content: "Use tabs." }] })
  const workspace = path.join(openclaw.home, "work")
  write(openclaw.paths.config, JSON.stringify({ agents: { defaults: { workspace } } }))
  write(path.join(workspace, "AGENTS.md"), "You are OpenClaw.\n")

  const applied = await openclaw.run()

  const agents = path.join(workspace, "AGENTS.md")
  expect(applied?.agents).toBe(agents)
  expect(read(agents)).toStartWith("You are OpenClaw.\n\n<!-- opencode-console:start -->")
  expect(read(agents)).toContain("## Style\n\nUse tabs.")
  openclaw.remove()
  expect(read(agents)).toBe("You are OpenClaw.\n")
})

test("writes the workspace's skills to a folder OpenClaw scans after its own, named as OpenClaw needs", async () => {
  const openclaw = member({
    skills: [{ slug: "deploy", version: "v1" }],
    bundles: {
      deploy: {
        format: 2,
        slug: "deploy",
        version: "v1",
        files: [{ path: "SKILL.md", kind: "text", content: "---\ntitle: Deploy\n---\nShip it." }],
      },
    },
  })

  await openclaw.run()

  const directory = OpenClaw.skillsDirectory(openclaw.store, openclaw.paths.config)
  expect(json(openclaw.paths.config).skills.load.extraDirs).toEqual([directory])
  expect(read(path.join(directory, "deploy", "SKILL.md"))).toStartWith("---\nname: deploy\ndescription: deploy\n")
  openclaw.remove()
  expect(existsSync(directory)).toBe(false)
})

test("updates every install setup connected on sync, and --remove takes out only the one named", async () => {
  const openclaw = member({ instructions: [{ name: "Style", content: "Use tabs." }] })
  const work = OpenClaw.paths({ profile: "work", env: {}, home: openclaw.home })
  const agents = (target: OpenClaw.Paths) => path.join(target.workspace, "AGENTS.md")
  write(agents(openclaw.paths), "Mine.\n")
  write(agents(work), "Work.\n")
  await openclaw.run()
  await openclaw.setup(work)
  write(agents(openclaw.paths), "Mine.\n")
  write(agents(work), "Work.\n")

  await openclaw.sync()
  openclaw.remove(work)

  expect(read(agents(openclaw.paths))).toContain("Use tabs.")
  expect(read(agents(work))).toBe("Work.\n")
  expect(existsSync(work.config)).toBe(false)
  expect(Object.keys(OpenClaw.manifest(openclaw.store)?.profiles ?? {})).toEqual([openclaw.paths.config])
})

test("waits for OpenClaw to create AGENTS.md before adding instructions, so OpenClaw's own template isn't skipped", async () => {
  const openclaw = member({ instructions: [{ name: "Style", content: "Use tabs." }] })
  const agents = path.join(openclaw.paths.workspace, "AGENTS.md")

  const applied = await openclaw.run()

  expect(applied?.waiting).toBe(true)
  expect(existsSync(agents)).toBe(false)
  write(agents, "OpenClaw's template.\n")
  await openclaw.sync()
  expect(read(agents)).toStartWith("OpenClaw's template.\n\n<!-- opencode-console:start -->")
})

test("finds the install OpenClaw would use: --profile, else OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH, else OPENCLAW_PROFILE, else ~/.openclaw", () => {
  const home = "/home/ada"
  const resolve = (input: Parameters<typeof OpenClaw.paths>[0]) => OpenClaw.paths({ home, env: {}, ...input })

  expect(resolve({ profile: "bot" })).toEqual({
    state: "/home/ada/.openclaw-bot",
    config: "/home/ada/.openclaw-bot/openclaw.json",
    workspace: "/home/ada/.openclaw-bot/workspace",
  })
  expect(resolve({ profile: "bot", env: { OPENCLAW_STATE_DIR: "/srv/x" } }).state).toBe("/home/ada/.openclaw-bot")
  expect(resolve({ env: { OPENCLAW_STATE_DIR: "~/state", OPENCLAW_CONFIG_PATH: "/etc/openclaw.json" } })).toEqual({
    state: "/home/ada/state",
    config: "/etc/openclaw.json",
    workspace: "/home/ada/state/workspace",
  })
  expect(resolve({ env: { OPENCLAW_PROFILE: "work" } }).config).toBe("/home/ada/.openclaw-work/openclaw.json")
  expect(resolve({ env: { OPENCLAW_PROFILE: "default" } }).config).toBe("/home/ada/.openclaw/openclaw.json")
  expect(resolve({}).config).toBe("/home/ada/.openclaw/openclaw.json")
  expect(() => resolve({ profile: "../x" })).toThrow("Not an OpenClaw profile name")
})

type Hook = (event: unknown, ctx: unknown) => Promise<unknown>
type ProviderHooks = Record<string, (ctx: unknown) => unknown>

/**
 * Setup's plugin, loaded as OpenClaw loads it, against a stand-in for the CLI: a script that answers `hook openclaw`
 * with `hook` and `exit`, `token --json` with a token, and `mcp-env` with `mcp`, recording what it was asked.
 */
async function plugin(answers: {
  hook?: string
  exit?: number
  mcp?: Record<string, string>
  instructions?: readonly unknown[]
}) {
  const openclaw = member({
    config: { providers: { opencode: {} }, mcp: { servers: gateway } },
    ...(answers.instructions ? { instructions: answers.instructions } : {}),
  })
  const cli = path.join(openclaw.home, "cli.sh")
  const log = path.join(openclaw.home, "cli.log")
  write(
    cli,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$*" in
  *"hook openclaw"*) cat >> '${log}'; printf '%s' '${answers.hook ?? "{}"}'; exit ${answers.exit ?? 0} ;;
  *"token --json"*) printf '%s' '{"access_token":"tok_1","expires_in":600}' ;;
  *"mcp-env"*) printf '%s' '${JSON.stringify({ env: answers.mcp ?? {}, version: "v" })}' ;;
esac
`,
  )
  chmodSync(cli, 0o755)
  await openclaw.setup(openclaw.paths, false, [cli])
  const entry = path.join(OpenClaw.pluginDirectory(openclaw.store, openclaw.paths.config), "index.cjs")
  const loaded: { register: (api: unknown) => void } = createRequire(import.meta.url)(entry)
  const hooks: Record<string, Hook> = {}
  const registered: { provider?: ProviderHooks } = {}
  loaded.register({
    runtime: { version: "2026.11.5", agent: { resolveAgentWorkspaceDir: () => "/work/app" } },
    config: {},
    registerProvider: (provider: ProviderHooks) => (registered.provider = provider),
    on: (name: string, handler: Hook) => (hooks[name] = handler),
  })
  return { openclaw, hooks, provider: registered.provider!, log: () => (existsSync(log) ? read(log) : "") }
}

test("blocks a tool call the CLI denies, and one it can't get an answer for", async () => {
  const denied = await plugin({ hook: '{"action":"block","message":"Acme denies shell"}', exit: 2 })
  const failed = await plugin({ hook: "", exit: 1 })

  const call = { toolName: "exec", params: { command: "rm -rf /" } }
  const ctx = { agentId: "main", sessionId: "s1" }
  expect(await denied.hooks.before_tool_call!(call, ctx)).toEqual({ block: true, blockReason: "Acme denies shell" })
  expect(await failed.hooks.before_tool_call!(call, ctx)).toEqual({
    block: true,
    blockReason: "opencode-console couldn't check this, so it was blocked",
  })
  expect(denied.log()).toContain("--harness openclaw/2026.11.5 hook openclaw")
  expect(denied.log()).toContain('"tool_name":"exec","tool_input":{"command":"rm -rf /"}')
  expect(denied.log()).toContain('"cwd":"/work/app"')
})

test("lets an allowed tool call through, swaps in a request token, and serves gateway MCP bearers from memory", async () => {
  const allowed = await plugin({ mcp: { OPENCODE_CONSOLE_MCP_WEB_SEARCH_AUTHORIZATION: "Bearer ocgw_live" } })

  expect(await allowed.hooks.before_tool_call!({ toolName: "read", params: { path: "a" } }, {})).toBeUndefined()
  expect(await allowed.provider.prepareRuntimeAuthV2!({ capability: "chat" })).toMatchObject({ apiKey: "tok_1" })
  expect(allowed.provider.resolveTransportTurnState!({ sessionId: "s1", turnId: "t" })).toEqual({
    headers: { "x-opencode-session": "s1" },
  })
  expect(allowed.provider.resolveExternalAuthProfiles!({})).toMatchObject([
    {
      profileId: "opencode-console:web_search",
      persistence: "runtime-only",
      credential: { type: "oauth", provider: "opencode-console", access: "ocgw_live" },
    },
  ])
})

test("has the first tool call after OpenClaw creates AGENTS.md start a sync that writes the instructions", async () => {
  const waiting = await plugin({ instructions: [{ name: "Style", content: "Use tabs." }] })
  const call = () => waiting.hooks.before_tool_call!({ toolName: "read", params: { path: "a" } }, {})

  await call()
  expect(waiting.log()).not.toContain("--refresh-agents")
  write(path.join(waiting.openclaw.paths.workspace, "AGENTS.md"), "OpenClaw's template.\n")
  await call()
  for (let tries = 0; tries < 100 && !waiting.log().includes("--refresh-agents"); tries++) await Bun.sleep(20)

  expect(waiting.log()).toContain("sync --quiet --refresh-agents")
})
