import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { HttpClient } from "effect/http"
import { parse, stringify } from "yaml"
import { Hermes } from "../src/hermes"
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
        limit: { context: 400000 },
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
 * A member of Acme signed in, and an empty Hermes home. `run` is setup's sync and refresh, `keep` setup with
 * `--keep-provider`, and `sync` a later sync's, against a Console serving `config`, the models, `instructions`,
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
  const home = mkdtempSync(path.join(os.tmpdir(), "opencode-console-hermes-"))
  homes.push(home)
  const paths = Hermes.paths({ env: {}, home, platform: "linux" })
  const synced = <A, E>(refresh: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    Effect.runPromise(WorkspaceSync.sync(store, { force: true }).pipe(Effect.andThen(refresh), against(console)))
  const setup = (target = paths, keepProvider = false) =>
    synced(
      Hermes.refresh(store, { paths: target, command, environment: {}, harness: "HermesAgent/0.23.0", keepProvider }),
    )
  return {
    store,
    home,
    paths,
    run: () => setup(),
    keep: () => setup(paths, true),
    setup,
    sync: (harness?: string) => synced(Hermes.refresh(store, undefined, harness)),
    remove: (target = paths) => Hermes.remove(store, target.home),
  }
}

const read = (file: string) => readFileSync(file, "utf8")
const yaml = (file: string) => parse(read(file))
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

// `HERMES_HOME` is how Hermes names the profile it runs to the helpers it starts.
const hooksOff = (
  hermes: { readonly store: Parameters<typeof Hermes.hooksOff>[0]; readonly paths: Hermes.Paths },
  env = {},
) => Hermes.hooksOff(hermes.store, { env: { HERMES_HOME: hermes.paths.home, ...env }, cwd: hermes.paths.home })

test("finds the plugin running once setup has enabled it", async () => {
  const hermes = member()
  await hermes.run()

  expect(hooksOff(hermes)).toBeUndefined()
})

test("says nothing about a Hermes that was never set up", () => {
  expect(hooksOff(member(), { HERMES_SAFE_MODE: "1" })).toBeUndefined()
})

test.each(["1", "true", "YES", "on"])(
  "finds hooks off with HERMES_SAFE_MODE=%s, which skips every plugin",
  async (value) => {
    const hermes = member()
    await hermes.run()

    expect(hooksOff(hermes, { HERMES_SAFE_MODE: value })).toEqual({
      reason: "HERMES_SAFE_MODE is set",
      fix: "Unset HERMES_SAFE_MODE",
    })
  },
)

test("leaves HERMES_SAFE_MODE=0 alone, which Hermes reads as off", async () => {
  const hermes = member()
  await hermes.run()

  expect(hooksOff(hermes, { HERMES_SAFE_MODE: "0" })).toBeUndefined()
})

test("finds hooks off when the plugin is taken out of plugins.enabled, and the next sync puts it back", async () => {
  const hermes = member()
  await hermes.run()
  write(hermes.paths.config, read(hermes.paths.config).replace("- opencode-console", "- something-else"))
  expect(hooksOff(hermes)).toEqual({ reason: `the opencode-console plugin isn't enabled in ${hermes.paths.config}` })

  await hermes.sync()

  expect(hooksOff(hermes)).toBeUndefined()
})

test("finds hooks off when the member lists the plugin in plugins.disabled", async () => {
  const hermes = member()
  await hermes.run()
  const config = yaml(hermes.paths.config)
  write(hermes.paths.config, stringify({ ...config, plugins: { ...config.plugins, disabled: ["opencode-console"] } }))

  expect(hooksOff(hermes)?.reason).toBe(`the opencode-console plugin isn't enabled in ${hermes.paths.config}`)
})

test("finds hooks off when the plugin's files are gone", async () => {
  const hermes = member()
  await hermes.run()
  rmSync(hermes.paths.plugin, { recursive: true })

  expect(hooksOff(hermes)?.reason).toBe(`the opencode-console plugin isn't enabled in ${hermes.paths.config}`)
})

test("sends model requests to the gateway's Responses API with a token minted for each, starting on Claude Sonnet", async () => {
  const hermes = member()

  await hermes.run()

  expect(yaml(hermes.paths.config).model).toEqual({ provider: "custom:opencode-console", default: "claude-sonnet-4-6" })
  expect(yaml(hermes.paths.config).providers["opencode-console"]).toEqual({
    name: "OpenCode Console",
    api: "https://console.test/inference/openai/v1",
    transport: "codex_responses",
    key_cmd: "/opt/node/bin/node /data/opencode-console/cli/index.js token --json --harness HermesAgent/0.23.0",
    discover_models: false,
    session_affinity_header: "x-opencode-session",
    extra_headers: { "x-opencode-plugin": `opencode-console/${version}`, "User-Agent": "HermesAgent/0.23.0" },
    default_model: "claude-sonnet-4-6",
    models: { "gpt-5.2": { context_length: 400000 }, "claude-sonnet-4-6": {}, "opencode-go/kimi-k2.5": {} },
  })
})

test("names the release of the Hermes that last synced, so an upgraded Hermes says so on its next request", async () => {
  const hermes = member()
  await hermes.run()

  await hermes.sync("HermesAgent/0.24.0")

  expect(yaml(hermes.paths.config).providers["opencode-console"].extra_headers["User-Agent"]).toBe("HermesAgent/0.24.0")
})

test("keeps the member's own settings and comments in config.yaml as they wrote them", async () => {
  const hermes = member()
  write(
    hermes.paths.config,
    "# my settings\nagent:\n  max_turns: 90 # plenty\nmodel:\n  provider: openrouter\n  default: x\n",
  )

  await hermes.run()

  expect(read(hermes.paths.config)).toStartWith("# my settings\nagent:\n  max_turns: 90 # plenty\n")
  expect(yaml(hermes.paths.config).model).toEqual({ provider: "custom:opencode-console", default: "claude-sonnet-4-6" })
})

test("puts config.yaml back as the member wrote it on --remove", async () => {
  const hermes = member({ config: { providers: { opencode: {} }, mcp: { servers: gateway } } })
  const before =
    "# mine\nmodel:\n  provider: openrouter # theirs\n  default: x\nplugins:\n  enabled:\n    - my-plugin\n"
  write(hermes.paths.config, before)
  await hermes.run()

  expect(hermes.remove()).toBe(true)

  expect(read(hermes.paths.config)).toBe(before)
  expect(existsSync(hermes.paths.plugin)).toBe(false)
  expect(existsSync(Hermes.manifestFile(hermes.store))).toBe(false)
})

test("leaves a model the member picked since setup when it's removed", async () => {
  const hermes = member()
  await hermes.run()
  write(hermes.paths.config, read(hermes.paths.config).replace("default: claude-sonnet-4-6", "default: gpt-5.2"))

  hermes.remove()

  expect(yaml(hermes.paths.config)?.model).toEqual({ default: "gpt-5.2" })
})

test("leaves Hermes as it is when the member has a model provider of the same name", async () => {
  const hermes = member()
  const theirs = "providers:\n  opencode-console:\n    api: http://localhost:8080/v1\n"
  write(hermes.paths.config, theirs)

  await expect(hermes.run()).rejects.toThrow("already has a model provider named opencode-console")
  expect(read(hermes.paths.config)).toBe(theirs)
})

test("keeps the member's own providers and models with --keep-provider, and still loads the plugin", async () => {
  const hermes = member()
  write(hermes.paths.config, "model:\n  provider: nous\n  default: hermes-5\n")

  const applied = await hermes.keep()

  expect(applied?.models).toBeUndefined()
  expect(yaml(hermes.paths.config).model).toEqual({ provider: "nous", default: "hermes-5" })
  expect(yaml(hermes.paths.config).providers).toBeUndefined()
  expect(yaml(hermes.paths.config).plugins.enabled).toEqual(["opencode-console"])
})

test("names gateway MCP headers by variables the plugin supplies, so no token is written to config.yaml", async () => {
  const hermes = member({ config: { providers: { opencode: {} }, mcp: { servers: gateway } } })

  await hermes.run()

  expect(yaml(hermes.paths.config).mcp_servers).toEqual({
    web_search: {
      url: "https://console.test/console/api/integration-gateway/web_search/mcp",
      headers: { Authorization: "${OPENCODE_CONSOLE_MCP_WEB_SEARCH_AUTHORIZATION}" },
    },
    console: { url: "https://console.test/console/mcp", auth: "oauth" },
  })
  expect(read(hermes.paths.config)).not.toContain("ocgw_")
  // Hermes runs a secret source only while it's enabled in `secrets`.
  expect(yaml(hermes.paths.config).secrets).toEqual({ opencode_console: { enabled: true } })
})

test("supplies each gateway MCP header under the variable config.yaml names it by", () => {
  expect(Hermes.mcpEnvironment({ owner: "x", fetched: 0, config: { mcp: { servers: gateway } } }).env).toEqual({
    OPENCODE_CONSOLE_MCP_WEB_SEARCH_AUTHORIZATION: "Bearer ocgw_secret",
  })
})

test("keeps an MCP server the member already has under the same name", async () => {
  const hermes = member({ config: { providers: { opencode: {} }, mcp: { servers: gateway } } })
  write(hermes.paths.config, "mcp_servers:\n  web_search:\n    url: https://mine.test/mcp\n")

  const applied = await hermes.run()

  expect(applied?.skipped).toEqual(["web_search"])
  expect(yaml(hermes.paths.config).mcp_servers.web_search).toEqual({ url: "https://mine.test/mcp" })
})

test("enables the plugin beside the member's own, even one they had turned off", async () => {
  const hermes = member()
  write(hermes.paths.config, "plugins:\n  enabled: [my-plugin]\n  disabled:\n    - opencode-console\n")

  await hermes.run()

  expect(yaml(hermes.paths.config).plugins).toEqual({ enabled: ["my-plugin", "opencode-console"], disabled: [] })
  expect(read(path.join(hermes.paths.plugin, "__init__.py"))).toContain(`COMMAND = ${JSON.stringify(command)}`)
})

test("writes a new config.yaml readable only by the member, since it names their helper commands", async () => {
  const hermes = member()

  await hermes.run()

  expect(statSync(hermes.paths.config).mode & 0o777).toBe(0o600)
})

test("adds the workspace's instructions to SOUL.md beside the member's own", async () => {
  const hermes = member({ instructions: [{ name: "Style", content: "Use tabs." }] })
  write(hermes.paths.soul, "You are Hermes Agent.\n")

  await hermes.run()

  expect(read(hermes.paths.soul)).toStartWith("You are Hermes Agent.\n\n<!-- opencode-console:start -->")
  expect(read(hermes.paths.soul)).toContain("## Style\n\nUse tabs.")
  hermes.remove()
  expect(read(hermes.paths.soul)).toBe("You are Hermes Agent.\n")
})

test("writes the workspace's skills to a folder Hermes reads after the profile's own, named as Hermes needs", async () => {
  const hermes = member({
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

  await hermes.run()

  const directory = Hermes.skillsDirectory(hermes.store, hermes.home + "/.hermes")
  expect(yaml(hermes.paths.config).skills.external_dirs).toEqual([directory])
  expect(read(path.join(directory, "deploy", "SKILL.md"))).toStartWith("---\nname: deploy\ndescription: deploy\n")
  hermes.remove()
  expect(existsSync(directory)).toBe(false)
})

test("updates every profile setup connected on sync, and --remove takes out only the one named", async () => {
  const hermes = member({ instructions: [{ name: "Style", content: "Use tabs." }] })
  const work = Hermes.paths({ profile: "work", env: {}, home: hermes.home, platform: "linux" })
  await hermes.run()
  await hermes.setup(work)
  rmSync(hermes.paths.soul)
  rmSync(work.soul)

  await hermes.sync()
  hermes.remove(work)

  expect(read(hermes.paths.soul)).toContain("Use tabs.")
  expect(existsSync(work.soul)).toBe(false)
  expect(Object.keys(Hermes.manifest(hermes.store)?.profiles ?? {})).toEqual([hermes.paths.home])
})

test("finds the profile Hermes would use: --profile, else HERMES_HOME, else the active profile, else ~/.hermes", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "opencode-console-hermes-paths-"))
  homes.push(home)
  write(path.join(home, ".hermes", "active_profile"), "work\n")
  const resolve = (input: Parameters<typeof Hermes.paths>[0]) =>
    Hermes.paths({ home, platform: "linux", env: {}, ...input }).home

  expect(resolve({ profile: "bot" })).toBe(path.join(home, ".hermes", "profiles", "bot"))
  expect(resolve({ env: { HERMES_HOME: "~/elsewhere" } })).toBe(path.join(home, "elsewhere"))
  expect(resolve({})).toBe(path.join(home, ".hermes", "profiles", "work"))
  expect(Hermes.paths({ home: "/nowhere", platform: "linux", env: {} }).home).toBe("/nowhere/.hermes")
  expect(() => resolve({ profile: "../x" })).toThrow("Not a Hermes profile name")
})
