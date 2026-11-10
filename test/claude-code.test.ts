import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { HttpClient } from "effect/http"
import { ClaudeCode } from "../src/claude-code"
import { WorkspaceSync } from "../src/workspace-sync"
import { version } from "../package.json" with { type: "json" }
import { against, fakeConsole, removeStores, save, signIn, temporaryStore } from "./support/console"

const homes: string[] = []
afterEach(() => {
  removeStores()
  homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true }))
})

const command = ["/opt/node/bin/node", "/data/opencode-console/cli/index.js"]
const zen = "https://console.test/inference/anthropic/v1"
// Entries in the shape `GET /api/v1/models` serves (`OpenCodeConfig.models`): models.dev's v2 entry for each model,
// with `api` naming the Console URL that serves it.
const entry = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  name: id,
  type: "chat",
  capabilities: { tools: { supported: true } },
  modalities: { input: ["text"], output: ["text"] },
  api: { messages: { base_url: zen, sdk: { aisdk: "@ai-sdk/anthropic" } } },
  ...fields,
})
const claudeSonnet = entry("claude-sonnet-4-6", {
  name: "Claude Sonnet 4.6",
  family: "claude",
  release_date: "2026-02-17",
})
const workspaceModels = {
  opencode: { id: "opencode", name: "Acme / OpenCode", models: { "claude-sonnet-4-6": claudeSonnet } },
}

/**
 * A member of Acme signed in, and an empty home directory for Claude Code. `run` is setup's sync and refresh, and `sync`
 * a later sync's, both against a Console serving `config`, `models`, `instructions` and `skills`, with `bundles` as the
 * skills' files, and `telemetry` as where usage metadata goes. `configure`, `offer`, `serve` and `collect` change what
 * it serves.
 */
function member(input: {
  readonly config?: Record<string, unknown>
  readonly models?: Record<string, unknown>
  readonly instructions?: readonly unknown[]
  readonly skills?: readonly unknown[]
  readonly bundles?: Record<string, unknown>
  readonly blobs?: Record<string, Uint8Array>
  readonly telemetry?: unknown
  /** Whether the config answer says the member may keep event watches (`x-opencode-event-watches: 1`). */
  readonly watches?: boolean
}) {
  const served = {
    config: input.config ?? { providers: { opencode: {} } },
    models: input.models ?? workspaceModels,
    instructions: input.instructions ?? [],
    skills: input.skills ?? [],
    telemetry: input.telemetry,
    watches: input.watches ?? false,
  }
  const console = fakeConsole({
    config: () => Response.json(served.config, { headers: served.watches ? { "x-opencode-event-watches": "1" } : {} }),
    models: () => Response.json(served.models),
    instructions: () => Response.json({ instructions: served.instructions }),
    skills: () => Response.json({ skills: served.skills }),
    telemetry: () =>
      served.telemetry === undefined
        ? Response.json({ _tag: "NotFound" }, { status: 404 })
        : Response.json(served.telemetry),
    ...(input.bundles === undefined ? {} : { bundles: input.bundles }),
    ...(input.blobs === undefined ? {} : { blobs: input.blobs }),
  })
  const store = temporaryStore()
  save(store, signIn(console, Number.MAX_SAFE_INTEGER))
  const home = mkdtempSync(path.join(os.tmpdir(), "opencode-console-claude-"))
  homes.push(home)
  const paths = ClaudeCode.paths({}, home)
  const synced = <A, E>(refresh: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    Effect.runPromise(WorkspaceSync.sync(store, { force: true }).pipe(Effect.andThen(refresh), against(console)))
  return {
    store,
    paths,
    configure: (config: Record<string, unknown>) => {
      served.config = config
    },
    offer: (offered: { readonly instructions?: readonly unknown[]; readonly skills?: readonly unknown[] }) => {
      served.instructions = offered.instructions ?? served.instructions
      served.skills = offered.skills ?? served.skills
    },
    serve: (models: Record<string, unknown>) => {
      served.models = models
    },
    /** Whether the Console lets the member keep event watches. */
    allowWatches: (watches: boolean) => {
      served.watches = watches
    },
    /** Where the Console has the member send usage metadata; undefined answers 404, collecting none. */
    collect: (telemetry: unknown) => {
      served.telemetry = telemetry
    },
    /** Setup, with `--keep-provider` when `keepProvider`, from a shell with `shell` as its environment. */
    run: (options: { readonly keepProvider?: boolean; readonly shell?: Record<string, string> } = {}) =>
      synced(
        ClaudeCode.refresh(
          store,
          { paths, command, harness: "claude-cli/2.1.318", keepProvider: options.keepProvider },
          options.shell ?? {},
        ),
      ),
    sync: (shell: Record<string, string> = {}) => synced(ClaudeCode.refresh(store, undefined, shell)),
    remove: () => ClaudeCode.remove(store),
    /** How many times the Console was asked for the member's models. */
    modelFetches: () => console.state.requests.filter((request) => request.url.endsWith("/api/v1/models")).length,
  }
}

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"))
const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2))
}

// A project that isn't the home directory, whose settings are the user's own.
const project = (claude: { readonly paths: ClaudeCode.Paths }) =>
  path.join(path.dirname(claude.paths.config), "project")
const hooksOff = (claude: ReturnType<typeof member>, env: Record<string, string> = {}) =>
  ClaudeCode.hooksOff(claude.store, { env, cwd: project(claude) })

test("finds Claude Code's hooks running once setup has registered them", async () => {
  const claude = member({})
  await claude.run()

  expect(hooksOff(claude)).toBeUndefined()
})

test("says nothing about a Claude Code that was never set up", () => {
  const claude = member({})

  expect(hooksOff(claude)).toBeUndefined()
})

test("finds hooks off when the member sets disableAllHooks in their settings", async () => {
  const claude = member({})
  await claude.run()
  write(claude.paths.settings, { ...json(claude.paths.settings), disableAllHooks: true })

  expect(hooksOff(claude)).toEqual({ reason: `disableAllHooks is set in ${claude.paths.settings}` })
})

test("finds hooks off when the project's local settings set disableAllHooks, and names that file as the fix", async () => {
  const claude = member({})
  await claude.run()
  const local = path.join(project(claude), ".claude", "settings.local.json")
  write(local, { disableAllHooks: true })

  expect(hooksOff(claude)).toEqual({ reason: `disableAllHooks is set in ${local}`, fix: `Remove it from ${local}` })
})

test("finds hooks off in claude --bare, which runs no hooks", async () => {
  const claude = member({})
  await claude.run()

  expect(hooksOff(claude, { CLAUDE_CODE_SIMPLE: "1" })?.fix).toBe("Run claude without --bare")
})

test("finds setup's PreToolUse hook missing, and the next sync writes it back", async () => {
  const claude = member({})
  await claude.run()
  const settings = json(claude.paths.settings)
  write(claude.paths.settings, { ...settings, hooks: { ...settings.hooks, PreToolUse: [] } })
  expect(hooksOff(claude)).toEqual({ reason: `setup's PreToolUse hook is missing from ${claude.paths.settings}` })

  await claude.sync()

  expect(hooksOff(claude)).toBeUndefined()
})

test("a sync leaves the member's disableAllHooks alone", async () => {
  const claude = member({})
  await claude.run()
  write(claude.paths.settings, { ...json(claude.paths.settings), disableAllHooks: true })

  await claude.sync()

  expect(json(claude.paths.settings).disableAllHooks).toBe(true)
})

test("running setup turns hooks back on where the member had turned them off", async () => {
  const claude = member({})
  await claude.run()
  write(claude.paths.settings, { ...json(claude.paths.settings), disableAllHooks: true })

  const applied = await claude.run()

  expect(json(claude.paths.settings).disableAllHooks).toBe(false)
  expect(hooksOff(claude)).toBeUndefined()
  expect(applied?.hooksTurnedOn).toBe(claude.paths.settings)
})

test("setup says nothing about hooks when it had no switch to change", async () => {
  const claude = member({})

  const applied = await claude.run()

  expect(applied?.hooksTurnedOn).toBeUndefined()
  expect(json(claude.paths.settings).disableAllHooks).toBeUndefined()
})

// The member's switch, set before setup first ran and turned off by it.
async function turnedBackOn() {
  const claude = member({})
  write(claude.paths.settings, { disableAllHooks: true })
  await claude.run()
  return claude
}

test("--remove puts back the disableAllHooks setup turned off", async () => {
  const claude = await turnedBackOn()

  claude.remove()

  expect(json(claude.paths.settings).disableAllHooks).toBe(true)
})

test("a background sync keeps the disableAllHooks setup turned off", async () => {
  const claude = await turnedBackOn()

  await claude.sync()

  expect(json(claude.paths.settings).disableAllHooks).toBe(false)
})

test("--remove leaves disableAllHooks as the member changed it after setup", async () => {
  const claude = await turnedBackOn()
  const { disableAllHooks: _, ...rest } = json(claude.paths.settings)
  write(claude.paths.settings, rest)

  claude.remove()

  expect(json(claude.paths.settings).disableAllHooks).toBeUndefined()
})

test("a background sync leaves disableAllHooks the member turned on again after setup", async () => {
  const claude = await turnedBackOn()
  write(claude.paths.settings, { ...json(claude.paths.settings), disableAllHooks: true })

  await claude.sync()

  expect(json(claude.paths.settings).disableAllHooks).toBe(true)
})

test("setup claims no change for a project's disableAllHooks, and the warning names that file", async () => {
  const claude = member({})
  const local = path.join(project(claude), ".claude", "settings.local.json")
  write(local, { disableAllHooks: true })

  const applied = await claude.run()

  expect(applied?.hooksTurnedOn).toBeUndefined()
  expect(hooksOff(claude)?.fix).toBe(`Remove it from ${local}`)
})

test("lists every chat model that takes tools and answers in text without audio, by gateway ID", () => {
  const custom = "https://console.test/inference/custom/conn_1"
  const models = ClaudeCode.models({
    opencode: {
      name: "Acme / OpenCode",
      models: {
        "claude-sonnet-4-6": claudeSonnet,
        "omni-moderation-latest": entry("omni-moderation-latest", { capabilities: { tools: { supported: false } } }),
        "gpt-audio-1.5": entry("gpt-audio-1.5", { modalities: { input: ["audio"], output: ["audio"] } }),
        "gpt-4o-audio": entry("gpt-4o-audio", { modalities: { input: ["text", "audio"], output: ["text", "audio"] } }),
      },
    },
    "console-acme-openrouter": {
      name: "Acme / OpenRouter",
      models: {
        "moonshot/kimi-k2.5": entry("moonshot/kimi-k2.5", {
          name: "Kimi K2.5",
          api: { responses: { base_url: custom } },
        }),
      },
    },
    "opencode-go": { name: "OpenCode Go", models: { "glm-5": entry("glm-5", { name: "GLM 5" }) } },
  })

  expect(models?.baseURL).toBe("https://console.test/inference/anthropic")
  expect(models?.options).toEqual([
    { model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { model: "opencode-go/glm-5", label: "GLM 5", description: "OpenCode Go" },
    { model: "console-acme-openrouter/moonshot/kimi-k2.5", label: "Kimi K2.5", description: "Acme / OpenRouter" },
  ])
})

test("points each model alias at the newest Claude model of its family, else the nearest family", () => {
  const models = ClaudeCode.models({
    opencode: {
      models: {
        "gpt-5.4": entry("gpt-5.4", { release_date: "2026-03-01" }),
        "claude-opus-4-5": entry("claude-opus-4-5", { release_date: "2025-11-24" }),
        "Claude-Opus-4-6": entry("Claude-Opus-4-6", { release_date: "2026-02-05" }),
        "claude-sonnet-4-6": entry("claude-sonnet-4-6", { release_date: "2026-02-17" }),
      },
    },
  })

  expect(models?.tiers).toEqual({ opus: "Claude-Opus-4-6", sonnet: "claude-sonnet-4-6", haiku: "claude-sonnet-4-6" })
})

test("prefers OpenCode's own Claude model of a family to a newer one from Go or a connection", () => {
  const models = ClaudeCode.models({
    "console-anthropic": {
      models: { "claude-sonnet-5-5": entry("claude-sonnet-5-5", { release_date: "2026-10-01" }) },
    },
    "opencode-go": { models: { "claude-haiku-5-5": entry("claude-haiku-5-5", { release_date: "2026-10-01" }) } },
    opencode: { models: { "claude-haiku-4-5": entry("claude-haiku-4-5", { release_date: "2025-10-01" }) } },
  })

  expect(models?.tiers).toEqual({
    opus: "console-anthropic/claude-sonnet-5-5",
    sonnet: "console-anthropic/claude-sonnet-5-5",
    haiku: "claude-haiku-4-5",
  })
})

test("points every alias at the first model when the workspace has no Claude model", () => {
  const models = ClaudeCode.models({
    opencode: { models: { "gpt-5.4": entry("gpt-5.4") } },
    "opencode-go": { models: { "kimi-k2.5": entry("kimi-k2.5") } },
  })

  expect(models?.tiers).toEqual({ opus: "gpt-5.4", sonnet: "gpt-5.4", haiku: "gpt-5.4" })
})

test("sends model requests to the gateway with the member's token, keeping the member's other settings", async () => {
  const claude = member({})
  write(claude.paths.settings, { theme: "dark", env: { FOO: "1" } })

  await claude.run()

  expect(json(claude.paths.settings)).toMatchObject({
    theme: "dark",
    apiKeyHelper: "/opt/node/bin/node /data/opencode-console/cli/index.js token",
    env: {
      FOO: "1",
      ANTHROPIC_BASE_URL: "https://console.test/inference/anthropic",
      ANTHROPIC_CUSTOM_HEADERS: `x-opencode-plugin: opencode-console/${version}`,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-sonnet-4-6",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-4-6",
      OPENCODE_CONSOLE_HARNESS: "claude-cli/2.1.318",
    },
    modelPicker: { options: [{ model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }], replaceBuiltInOptions: true },
  })
})

test("checks every tool call and prompt with a hook that blocks when it fails, beside the member's own hooks", async () => {
  const claude = member({})
  const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }
  write(claude.paths.settings, { hooks: { PreToolUse: [theirs] } })

  await claude.run()

  const policy = { type: "command", command: command[0], args: [command[1], "hook", "claude-code"] }
  expect(json(claude.paths.settings).hooks).toEqual({
    PreToolUse: [theirs, { matcher: "*", hooks: [{ ...policy, timeout: 30, onFailure: "block" }] }],
    UserPromptSubmit: [{ hooks: [{ ...policy, timeout: 30, onFailure: "block" }] }],
    UserPromptExpansion: [{ hooks: [{ ...policy, timeout: 30, onFailure: "block" }] }],
    SessionStart: [{ hooks: [{ ...policy, timeout: 10 }] }],
  })
})

test("with event watches, adds the watch tools' server and hooks that watch, wake and stop waiting", async () => {
  const claude = member({
    watches: true,
    config: {
      mcp: {
        servers: {
          github: {
            type: "remote",
            url: "https://console.test/api/integration-gateway/github/mcp",
            headers: { authorization: "Bearer ocgw_1" },
          },
        },
      },
    },
  })

  await claude.run()

  const handler = { type: "command", command: command[0], args: [command[1], "hook", "claude-code"] }
  expect([json(claude.paths.global).mcpServers.console_watch, json(claude.paths.settings).hooks]).toMatchObject([
    { type: "stdio", command: command[0], args: [command[1], "mcp-watches"] },
    {
      PostToolUse: [{ matcher: "^(Bash|mcp__(github)__.+)$", hooks: [{ ...handler, async: true }] }],
      Stop: [{ hooks: [{ ...handler, asyncRewake: true, timeout: 28_800 }] }],
      SessionEnd: [{ hooks: [{ ...handler, timeout: 5 }] }],
    },
  ])
})

test("takes the watch tools' server and hooks out once the member can't keep event watches", async () => {
  const claude = member({ watches: true })
  await claude.run()

  claude.allowWatches(false)
  await claude.sync()

  expect([json(claude.paths.global).mcpServers, Object.keys(json(claude.paths.settings).hooks)]).toEqual([
    undefined,
    ["PreToolUse", "UserPromptSubmit", "UserPromptExpansion", "SessionStart"],
  ])
})

test("removes the watch tools' server and hooks on removal", async () => {
  const claude = member({ watches: true })
  write(claude.paths.global, { numStartups: 3 })
  write(claude.paths.settings, { theme: "dark" })
  await claude.run()

  claude.remove()

  expect([json(claude.paths.global), json(claude.paths.settings)]).toEqual([{ numStartups: 3 }, { theme: "dark" }])
})

test("leaves a console_watch server the member added alone, and adds no watch hooks without the watch tools", async () => {
  const claude = member({ watches: true })
  write(claude.paths.global, { mcpServers: { console_watch: { type: "stdio", command: "their-watch" } } })

  await claude.run()

  expect([json(claude.paths.global).mcpServers, Object.keys(json(claude.paths.settings).hooks)]).toEqual([
    { console_watch: { type: "stdio", command: "their-watch" } },
    ["PreToolUse", "UserPromptSubmit", "UserPromptExpansion", "SessionStart"],
  ])
})

test("writes the same settings when run again", async () => {
  const claude = member({})
  await claude.run()
  const first = readFileSync(claude.paths.settings, "utf8")

  await claude.run()

  expect(readFileSync(claude.paths.settings, "utf8")).toBe(first)
})

test("keeps the member's own custom headers beside the one that names the setup", async () => {
  const claude = member({})
  write(claude.paths.settings, { env: { ANTHROPIC_CUSTOM_HEADERS: "x-team: platform" } })

  await claude.run()

  expect(json(claude.paths.settings).env.ANTHROPIC_CUSTOM_HEADERS).toBe(
    `x-team: platform\nx-opencode-plugin: opencode-console/${version}`,
  )
})

test("restores the member's settings on removal", async () => {
  const claude = member({})
  const before = {
    theme: "dark",
    apiKeyHelper: "vault-token",
    hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] },
  }
  write(claude.paths.settings, before)
  await claude.run()

  claude.remove()

  expect(json(claude.paths.settings)).toEqual(before)
})

test("removes the settings file it created on removal", async () => {
  const claude = member({})
  await claude.run()

  claude.remove()

  expect(existsSync(claude.paths.settings)).toBe(false)
})

test("leaves a setting the member changed after setup as they set it on removal", async () => {
  const claude = member({})
  await claude.run()
  write(claude.paths.settings, { ...json(claude.paths.settings), apiKeyHelper: "my-own-helper" })

  claude.remove()

  expect(json(claude.paths.settings)).toEqual({ apiKeyHelper: "my-own-helper" })
})

test("leaves model settings alone when the workspace serves the member no models", async () => {
  const claude = member({ models: {} })
  write(claude.paths.settings, { apiKeyHelper: "vault-token" })

  await claude.run()

  const settings = json(claude.paths.settings)
  expect(settings.apiKeyHelper).toBe("vault-token")
  expect(settings).not.toHaveProperty("modelPicker")
  expect(settings.env).toEqual({ OPENCODE_CONSOLE_HARNESS: "claude-cli/2.1.318" })
})

test("gives the member's own model settings back once the workspace serves them no models", async () => {
  const claude = member({})
  write(claude.paths.settings, { apiKeyHelper: "vault-token" })
  await claude.run()

  claude.serve({})
  claude.configure({ providers: {} })
  await claude.sync()

  expect(json(claude.paths.settings)).toEqual({
    apiKeyHelper: "vault-token",
    env: { OPENCODE_CONSOLE_HARNESS: "claude-cli/2.1.318" },
    hooks: json(claude.paths.settings).hooks,
  })
})

test("never writes over a settings file that isn't JSON", async () => {
  const claude = member({})
  write(claude.paths.settings, "{ theme: dark")

  await expect(claude.run()).rejects.toThrow("isn't valid JSON")
  expect(readFileSync(claude.paths.settings, "utf8")).toBe("{ theme: dark")
})

test("adds the workspace's MCP servers, a gateway server asking the CLI for its token on each connection", async () => {
  const claude = member({
    config: {
      mcp: {
        servers: {
          github: {
            type: "remote",
            url: "https://console.test/api/integration-gateway/github/mcp",
            headers: { authorization: "Bearer ocgw_1" },
          },
          docs: { type: "remote", url: "https://docs.example.com/mcp" },
        },
      },
    },
  })
  write(claude.paths.global, { numStartups: 3 })

  await claude.run()

  expect(json(claude.paths.global)).toEqual({
    numStartups: 3,
    mcpServers: {
      github: {
        type: "http",
        url: "https://console.test/api/integration-gateway/github/mcp",
        headersHelper: "/opt/node/bin/node /data/opencode-console/cli/index.js mcp-headers github",
      },
      docs: { type: "http", url: "https://docs.example.com/mcp" },
    },
  })
})

test("keeps a server the member added under the same name, and drops one the workspace stops offering", async () => {
  const offered = (servers: Record<string, unknown>) => ({ mcp: { servers } })
  const claude = member({
    config: offered({
      github: { type: "remote", url: "https://console.test/api/integration-gateway/github/mcp" },
      linear: { type: "remote", url: "https://console.test/api/integration-gateway/linear/mcp" },
    }),
  })
  write(claude.paths.global, { mcpServers: { github: { type: "stdio", command: "gh-mcp" } } })
  await claude.run()

  claude.configure(
    offered({ github: { type: "remote", url: "https://console.test/api/integration-gateway/github/mcp" } }),
  )
  await claude.sync()

  expect(json(claude.paths.global).mcpServers).toEqual({ github: { type: "stdio", command: "gh-mcp" } })
})

test("writes the workspace's skills as Claude Code reads them, and deletes one the member can't use anymore", async () => {
  const image = new Uint8Array([137, 80, 78, 71])
  const markdown =
    '---\nname: "Release notes"\ndescription: "Write release notes"\nmetadata:\n  "opencode/autoinvoke": false\n---\n\nSteps'
  const claude = member({
    skills: [{ slug: "release-notes", version: "skl_1:2" }],
    bundles: {
      "release-notes": {
        format: 2,
        slug: "release-notes",
        version: "skl_1:2",
        files: [
          { kind: "text", path: "SKILL.md", content: markdown },
          { kind: "blob", path: "assets/logo.png", sha256: "a".repeat(64), bytes: 4, mediaType: "image/png" },
        ],
      },
    },
    blobs: { ["a".repeat(64)]: image },
  })
  await claude.run()
  const skill = path.join(claude.paths.skills, "release-notes")
  const written = [
    readFileSync(path.join(skill, "SKILL.md"), "utf8"),
    [...readFileSync(path.join(skill, "assets/logo.png"))],
  ]

  claude.offer({ skills: [] })
  await claude.sync()

  expect(written).toEqual([
    '---\ndescription: "Write release notes"\ndisable-model-invocation: true\n---\n\nSteps',
    [137, 80, 78, 71],
  ])
  expect(existsSync(skill)).toBe(false)
})

test("leaves a skill the member wrote under a workspace skill's slug untouched", async () => {
  const claude = member({ skills: [{ slug: "deploy", version: "skl_2:1" }] })
  write(path.join(claude.paths.skills, "deploy", "SKILL.md"), "mine")

  const applied = await claude.run()
  claude.remove()

  expect(applied?.skipped).toEqual(["/deploy"])
  expect(readFileSync(path.join(claude.paths.skills, "deploy", "SKILL.md"), "utf8")).toBe("mine")
})

test("adds the workspace's instructions to the member's CLAUDE.md and takes them out again", async () => {
  const instructions = [{ id: "ins_1", name: "Security", content: "Never log secrets." }]
  const claude = member({ instructions })
  write(claude.paths.memory, "# Mine\n\nUse tabs.\n")
  await claude.run()
  const added = readFileSync(claude.paths.memory, "utf8")

  claude.offer({ instructions: [] })
  await claude.sync()

  expect(added).toBe(
    "# Mine\n\nUse tabs.\n\n<!-- opencode-console:start -->\n\n# Workspace instructions from OpenCode Console\n\n## Security\n\nNever log secrets.\n\n<!-- opencode-console:end -->\n",
  )
  expect(readFileSync(claude.paths.memory, "utf8")).toBe("# Mine\n\nUse tabs.\n")
})

test("removes a CLAUDE.md it created for instructions once none are left", async () => {
  const claude = member({ instructions: [{ id: "ins_1", name: "Security", content: "x" }] })
  await claude.run()

  claude.remove()

  expect(existsSync(claude.paths.memory)).toBe(false)
})

test("takes out only its own servers on removal, keeping the member's", async () => {
  const claude = member({
    config: {
      mcp: { servers: { github: { type: "remote", url: "https://console.test/api/integration-gateway/github/mcp" } } },
    },
  })
  write(claude.paths.global, { mcpServers: { local: { type: "stdio", command: "my-mcp" } } })
  await claude.run()

  claude.remove()

  expect(json(claude.paths.global)).toEqual({ mcpServers: { local: { type: "stdio", command: "my-mcp" } } })
})

test("changes nothing when Claude Code's global config isn't JSON", async () => {
  const claude = member({})
  write(claude.paths.settings, { theme: "dark" })
  write(claude.paths.global, "{ broken")

  await expect(claude.run()).rejects.toThrow("isn't valid JSON")
  expect(readFileSync(claude.paths.settings, "utf8")).toBe(JSON.stringify({ theme: "dark" }, null, 2))
  expect(existsSync(`${claude.paths.settings}.opencode-console.bak`)).toBe(false)
})

test("refuses to run over a record of a previous setup it can't read", async () => {
  const claude = member({})
  write(claude.paths.settings, { theme: "dark" })
  writeFileSync(ClaudeCode.manifestFile(claude.store), "{ broken")

  await expect(claude.run()).rejects.toThrow("can't be read")
  expect(readFileSync(claude.paths.settings, "utf8")).toBe(JSON.stringify({ theme: "dark" }, null, 2))
})

test("keeps a backup it already has rather than write over it", async () => {
  const claude = member({})
  write(claude.paths.settings, { theme: "dark" })
  write(`${claude.paths.settings}.opencode-console.bak`, { theme: "light" })

  await claude.run()

  expect(json(`${claude.paths.settings}.opencode-console.bak`)).toEqual({ theme: "light" })
})

test("creates a new settings file readable only by the member", async () => {
  const claude = member({})

  await claude.run()

  expect(statSync(claude.paths.settings).mode & 0o777).toBe(0o600)
})

test("backs up the member's settings readable only by them", async () => {
  const claude = member({})
  write(claude.paths.settings, { theme: "dark" })

  await claude.run()

  expect(statSync(`${claude.paths.settings}.opencode-console.bak`).mode & 0o777).toBe(0o600)
})

test("leaves a model setting the member changed after setup on a background sync, and sets it again on setup", async () => {
  const claude = member({})
  await claude.run()
  write(claude.paths.settings, { ...json(claude.paths.settings), apiKeyHelper: "my-own-helper" })

  claude.configure({ providers: { opencode: {}, "opencode-go": {} } })
  await claude.sync()
  const synced = json(claude.paths.settings).apiKeyHelper
  await claude.run()

  expect(synced).toBe("my-own-helper")
  expect(json(claude.paths.settings).apiKeyHelper).toBe("/opt/node/bin/node /data/opencode-console/cli/index.js token")
})

test("keeps custom headers the member adds after setup, and takes out only its own line on removal", async () => {
  const claude = member({})
  await claude.run()
  const settings = json(claude.paths.settings)
  write(claude.paths.settings, {
    ...settings,
    env: { ...settings.env, ANTHROPIC_CUSTOM_HEADERS: `x-team: platform\n${settings.env.ANTHROPIC_CUSTOM_HEADERS}` },
  })

  claude.configure({ providers: { opencode: {}, "opencode-go": {} } })
  await claude.sync()
  const synced = json(claude.paths.settings).env.ANTHROPIC_CUSTOM_HEADERS
  claude.remove()

  expect(synced).toBe(`x-team: platform\nx-opencode-plugin: opencode-console/${version}`)
  expect(json(claude.paths.settings).env).toEqual({ ANTHROPIC_CUSTOM_HEADERS: "x-team: platform" })
})

test("asks the Console for models again only when the config's providers change", async () => {
  const claude = member({})
  await claude.run()

  claude.configure({ providers: { opencode: {} } })
  await claude.sync()
  const unchanged = claude.modelFetches()
  claude.configure({ providers: { opencode: {}, "opencode-go": {} } })
  await claude.sync()

  expect([unchanged, claude.modelFetches()]).toEqual([1, 2])
})

test("leaves a CLAUDE.md without its instructions exactly as the member wrote it", async () => {
  const claude = member({})
  write(claude.paths.memory, "# Mine\n\n\nUse tabs.   \n\n")

  await claude.run()

  expect(readFileSync(claude.paths.memory, "utf8")).toBe("# Mine\n\n\nUse tabs.   \n\n")
})

test("keeps an instruction that quotes the end marker inside its block", async () => {
  const quoting = { id: "ins_1", name: "Markers", content: "Never write <!-- opencode-console:end --> by hand." }
  const claude = member({ instructions: [quoting] })
  await claude.run()

  claude.offer({ instructions: [] })
  await claude.sync()

  expect(existsSync(claude.paths.memory)).toBe(false)
})

test("writes a skill without frontmatter when nothing is left in it, and skips a file outside the skill", async () => {
  const claude = member({
    skills: [{ slug: "notes", version: "skl_3:1" }],
    bundles: {
      notes: {
        format: 2,
        slug: "notes",
        version: "skl_3:1",
        files: [
          { kind: "text", path: "SKILL.md", content: '---\nname: "Notes"\n---\n\nTake notes' },
          { kind: "text", path: "../escape.md", content: "x" },
        ],
      },
    },
  })

  await claude.run()

  expect(readFileSync(path.join(claude.paths.skills, "notes", "SKILL.md"), "utf8")).toBe("Take notes")
  expect(existsSync(path.join(claude.paths.skills, "escape.md"))).toBe(false)
})

test("adds no server whose name couldn't go into a command safely", async () => {
  const claude = member({
    config: { mcp: { servers: { "x; rm -rf ~": { type: "remote", url: "https://x.test/mcp", headers: { a: "b" } } } } },
  })

  const applied = await claude.run()

  expect(applied?.servers).toEqual([])
  expect(existsSync(claude.paths.global)).toBe(false)
})

test("--keep-provider keeps the member's own sign-in while still adding hooks, servers, skills and instructions", async () => {
  const claude = member({
    config: {
      providers: { opencode: {} },
      mcp: { servers: { docs: { type: "remote", url: "https://docs.example.com/mcp" } } },
    },
    instructions: [{ id: "ins_1", name: "Security", content: "Never log secrets." }],
    skills: [{ slug: "notes", version: "skl_3:1" }],
    bundles: {
      notes: {
        format: 2,
        slug: "notes",
        version: "skl_3:1",
        files: [{ kind: "text", path: "SKILL.md", content: "Take notes" }],
      },
    },
  })
  write(claude.paths.settings, { apiKeyHelper: "vault-token" })

  await claude.run({ keepProvider: true })

  const settings = json(claude.paths.settings)
  expect([settings.apiKeyHelper, settings.modelPicker, settings.env]).toEqual([
    "vault-token",
    undefined,
    { OPENCODE_CONSOLE_HARNESS: "claude-cli/2.1.318" },
  ])
  expect(Object.keys(settings.hooks)).toEqual(["PreToolUse", "UserPromptSubmit", "UserPromptExpansion", "SessionStart"])
  expect(json(claude.paths.global).mcpServers).toEqual({ docs: { type: "http", url: "https://docs.example.com/mcp" } })
  expect(readFileSync(path.join(claude.paths.skills, "notes", "SKILL.md"), "utf8")).toBe("Take notes")
  expect(readFileSync(claude.paths.memory, "utf8")).toContain("Never log secrets.")
})

test("a background sync keeps the member's own sign-in after --keep-provider", async () => {
  const claude = member({})
  await claude.run({ keepProvider: true })

  claude.configure({ providers: { opencode: {}, "opencode-go": {} } })
  await claude.sync()

  expect(json(claude.paths.settings)).not.toHaveProperty("apiKeyHelper")
})

test("setup without --keep-provider moves to the gateway, and with it gives the member's sign-in back", async () => {
  const claude = member({})
  write(claude.paths.settings, { apiKeyHelper: "vault-token" })
  await claude.run({ keepProvider: true })

  await claude.run()
  const gateway = json(claude.paths.settings).apiKeyHelper
  await claude.run({ keepProvider: true })

  expect(gateway).toBe("/opt/node/bin/node /data/opencode-console/cli/index.js token")
  expect(json(claude.paths.settings)).toEqual({
    apiKeyHelper: "vault-token",
    env: { OPENCODE_CONSOLE_HARNESS: "claude-cli/2.1.318" },
    hooks: json(claude.paths.settings).hooks,
  })
})

// Where the Console has this connector send usage metadata (`GET /api/v2/telemetry`).
const telemetry = {
  otlpLogsUrl: "https://console.test/console/api/otel/v1/logs",
  headers: { authorization: "Bearer octel_1" },
}

test("sends usage metadata to the workspace while Claude Code keeps its own sign-in", async () => {
  const claude = member({ telemetry })

  const applied = await claude.run({ keepProvider: true })

  const settings = json(claude.paths.settings)
  expect(applied?.usage).toBe("shared")
  expect(settings.otelHeadersHelper).toBe("/opt/node/bin/node /data/opencode-console/cli/index.js otel-headers")
  expect(settings.env).toEqual({
    OPENCODE_CONSOLE_HARNESS: "claude-cli/2.1.318",
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://console.test/console/api/otel/v1/logs",
    OTEL_LOGS_EXPORT_INTERVAL: "30000",
    OTEL_LOG_USER_PROMPTS: "0",
    OTEL_LOG_ASSISTANT_RESPONSES: "0",
    OTEL_LOG_TOOL_DETAILS: "0",
    OTEL_LOG_RAW_API_BODIES: "0",
  })
})

test("keeps prompts out of the usage export though the member turned prompt logging on, and gives it back after", async () => {
  const claude = member({ config: {}, telemetry })
  write(claude.paths.settings, { env: { OTEL_LOG_USER_PROMPTS: "1" } })
  await claude.run({ keepProvider: true })
  const exporting = json(claude.paths.settings).env.OTEL_LOG_USER_PROMPTS

  claude.collect(undefined)
  await claude.sync()

  expect([exporting, json(claude.paths.settings).env.OTEL_LOG_USER_PROMPTS]).toEqual(["0", "1"])
})

test("sends no usage metadata from a Claude Code that uses the gateway, which counts its requests already", async () => {
  const claude = member({ telemetry })

  const applied = await claude.run()

  const settings = json(claude.paths.settings)
  expect([applied?.usage, settings.otelHeadersHelper, settings.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT]).toEqual([
    undefined,
    undefined,
    undefined,
  ])
})

test("keeps an OpenTelemetry endpoint the member set in Claude Code's settings, sending nothing to the workspace", async () => {
  const claude = member({ config: {}, telemetry })
  const before = { env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.acme.test" } }
  write(claude.paths.settings, before)

  const applied = await claude.run({ keepProvider: true })

  expect(applied?.usage).toBe("kept")
  expect(json(claude.paths.settings).env).toEqual({ ...before.env, OPENCODE_CONSOLE_HARNESS: "claude-cli/2.1.318" })
})

test("keeps an OpenTelemetry headers helper the member set, sending nothing to the workspace", async () => {
  const claude = member({ config: {}, telemetry })
  write(claude.paths.settings, { otelHeadersHelper: "vault otel-token" })

  await claude.run({ keepProvider: true })

  const settings = json(claude.paths.settings)
  expect([settings.otelHeadersHelper, settings.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT]).toEqual([
    "vault otel-token",
    undefined,
  ])
})

test("keeps an OpenTelemetry endpoint the member set in their shell, sending nothing to the workspace", async () => {
  const claude = member({ config: {}, telemetry })

  const applied = await claude.run({
    keepProvider: true,
    shell: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://localhost:4318/v1/logs" },
  })

  expect([applied?.usage, json(claude.paths.settings).otelHeadersHelper]).toEqual(["kept", undefined])
})

test("keeps sending usage metadata when a sync runs from Claude Code's hook, which passes on what setup wrote", async () => {
  const claude = member({ config: {}, telemetry })
  await claude.run({ keepProvider: true })

  const applied = await claude.sync({
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://console.test/console/api/otel/v1/logs",
  })

  expect([applied?.usage, json(claude.paths.settings).otelHeadersHelper]).toEqual([
    "shared",
    "/opt/node/bin/node /data/opencode-console/cli/index.js otel-headers",
  ])
})

test("stops sending usage metadata and restores the member's values once the workspace stops collecting it", async () => {
  const claude = member({ config: {}, telemetry })
  write(claude.paths.settings, { env: { CLAUDE_CODE_ENABLE_TELEMETRY: "0" } })
  await claude.run({ keepProvider: true })

  claude.collect(undefined)
  const applied = await claude.sync()

  expect(applied?.usage).toBeUndefined()
  expect(json(claude.paths.settings)).toEqual({
    env: { CLAUDE_CODE_ENABLE_TELEMETRY: "0", OPENCODE_CONSOLE_HARNESS: "claude-cli/2.1.318" },
    hooks: json(claude.paths.settings).hooks,
  })
})
