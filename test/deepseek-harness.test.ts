import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { parse } from "yaml"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { HttpClient } from "effect/http"
import { DeepSeekHarness } from "../src/deepseek-harness"
import { InProcess } from "../src/in-process"
import { WorkspaceSnapshot } from "../src/snapshot"
import { WorkspaceSync } from "../src/workspace-sync"
import { version } from "../package.json" with { type: "json" }
import { against, fakeConsole, removeStores, save, server, signIn, temporaryStore } from "./support/console"

const homes: string[] = []
afterEach(() => {
  removeStores()
  homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true }))
})

const inference = "https://console.test/inference"
// Entries in the shape `GET /api/v1/models` serves: models.dev's v2 entry for each model, with `api` naming the Console
// URL that serves it in its protocol.
const entry = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  name: id,
  type: "chat",
  capabilities: { tools: { supported: true } },
  modalities: { input: ["text"], output: ["text"] },
  api: { messages: { base_url: `${inference}/anthropic/v1` } },
  ...fields,
})
const responses = { responses: { base_url: `${inference}/custom/conn_1` } }

test("serves a connection in its own protocol, and OpenCode's mixed models through the gateway's Anthropic endpoint", () => {
  const routes = DeepSeekHarness.routes({
    opencode: {
      name: "Acme / OpenCode",
      models: {
        "claude-sonnet-4-6": entry("claude-sonnet-4-6", { name: "Claude Sonnet 4.6" }),
        "gpt-5.4": entry("gpt-5.4", { api: { responses: { base_url: `${inference}/openai/v1` } } }),
      },
    },
    "console-acme-openai": { name: "Acme / OpenAI", models: { "gpt-5.4": entry("gpt-5.4", { api: responses }) } },
    "opencode-go": {
      models: { "glm-5": entry("glm-5", { api: { "chat-completions": { base_url: `${inference}/go/v1` } } }) },
    },
  })

  expect(
    Object.entries(routes).map(([id, route]) => [id, route.api, route.baseURL, route.models.map((item) => item.id)]),
  ).toEqual([
    ["opencode", "anthropic-messages", `${inference}/anthropic`, ["claude-sonnet-4-6", "gpt-5.4"]],
    ["opencode-go", "openai-completions", `${inference}/go/v1`, ["glm-5"]],
    ["console-acme-openai", "openai-responses", `${inference}/custom/conn_1`, ["gpt-5.4"]],
  ])
})

test("addresses a connection's mixed models by their gateway ID on the Anthropic endpoint", () => {
  const routes = DeepSeekHarness.routes({
    "console-acme": {
      models: { a: entry("a"), b: entry("b", { api: responses }) },
    },
  })

  expect(routes["console-acme"]?.models.map((item) => item.id)).toEqual(["console-acme/a", "console-acme/b"])
})

test("names the connector on every route, reads the member's token by reference, and fits Chat Completions gateways", () => {
  const route = DeepSeekHarness.routes({
    "opencode-go": {
      models: { "glm-5": entry("glm-5", { api: { "chat-completions": { base_url: `${inference}/go/v1` } } }) },
    },
  })["opencode-go"]

  expect(route).toMatchObject({
    apiKeyEnv: "OPENCODE_CONSOLE_TOKEN",
    headers: { "x-opencode-plugin": `opencode-console/${version}` },
    compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
  })
})

test("reads a model's name, limits and images from the Console's entry", () => {
  const [model] = DeepSeekHarness.routes({
    opencode: {
      models: {
        "kimi-k2.5": entry("kimi-k2.5", {
          name: "Kimi K2.5",
          limit: { context: 262_144, output: 32_768 },
          modalities: { input: ["text", "image/*"], output: ["text"] },
        }),
      },
    },
  }).opencode!.models

  expect(model).toEqual({
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    contextWindow: 262_144,
    maxTokens: 32_768,
    input: ["text", "image"],
  })
})

test("starts new sessions on the newest Claude Sonnet, by the ID its route serves it under", () => {
  expect(
    DeepSeekHarness.defaultModel({
      "console-acme": {
        models: {
          "claude-sonnet-4-6": entry("claude-sonnet-4-6"),
          "gpt-5.4": entry("gpt-5.4", { api: responses }),
        },
      },
    }),
  ).toEqual({ provider: "console-acme", model: "console-acme/claude-sonnet-4-6" })
})

const where = (fields: Partial<DeepSeekHarness.Where> = {}): DeepSeekHarness.Where => ({
  directory: "/work/app",
  cwd: "/work/app/src",
  resolve: async (input) => path.resolve("/work/app/src", input),
  ...fields,
})

test("checks a shell command where it runs, and a file where the tool resolves it", async () => {
  const shell = await DeepSeekHarness.checks(
    { name: "bash", input: { description: "list", command: "ls", workdir: ".." } },
    where(),
  )
  const read = await DeepSeekHarness.checks({ name: "read", input: { file_path: "../.env" } }, where())

  expect([shell, read]).toEqual([
    [{ action: "shell", resources: ["ls"], directory: "/work/app", shell: "bash", path: "/work/app" }],
    [{ action: "read", resources: ["/work/app/.env"], directory: "/work/app" }],
  ])
})

test("checks every file a patch adds, updates, moves or deletes as an edit", async () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: a.ts",
    "*** Move to: b.ts",
    "@@",
    "-old",
    "+new",
    "*** Delete File: ../c.ts",
    "*** End Patch",
  ].join("\n")

  expect(await DeepSeekHarness.checks({ name: "apply_patch", input: { input: patch } }, where())).toEqual([
    {
      action: "edit",
      resources: ["/work/app/src/a.ts", "/work/app/src/b.ts", "/work/app/c.ts"],
      directory: "/work/app",
    },
  ])
})

test("checks str_replace_editor's view as a read and its other commands as an edit", async () => {
  const view = await DeepSeekHarness.checks(
    { name: "str_replace_editor", input: { command: "view", path: "a" } },
    where(),
  )
  const insert = await DeepSeekHarness.checks(
    { name: "str_replace_editor", input: { command: "insert", path: "a" } },
    where(),
  )

  expect([view[0]?.action, insert[0]?.action]).toEqual(["read", "edit"])
})

test("splits an MCP tool at the longest server DeepSeek Harness knows, and marks a hashed name as shortened", async () => {
  const plain = await DeepSeekHarness.checks(
    { name: "mcp__my__docs__search", input: {} },
    where({ servers: ["my", "my__docs"] }),
  )
  const hashed = await DeepSeekHarness.checks(
    { name: `mcp__github__${"x".repeat(38)}_0123456789ab`, input: {} },
    where({ servers: ["github"] }),
  )

  expect([plain, hashed]).toEqual([
    [
      { action: "mcp.use", resources: ["my__docs"], directory: "/work/app" },
      { action: "my__docs_search", resources: ["*"], directory: "/work/app" },
    ],
    [
      { action: "mcp.use", resources: ["github"], directory: "/work/app" },
      { action: "github_", resources: ["*"], directory: "/work/app", truncated: true },
    ],
  ])
})

test("refuses to guess at a tool call missing the input it's checked by", async () => {
  expect(DeepSeekHarness.checks({ name: "edit", input: { new_string: "x" } }, where())).rejects.toBeInstanceOf(
    DeepSeekHarness.Unreadable,
  )
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

test("blocks a program the harness runs while any rule could deny a shell command, and only then", async () => {
  const call = await DeepSeekHarness.checks({ name: "run_code", input: { code: "const files = 1" } }, where())

  const ruled = await InProcess.decide(acme([deny("shell:rm *")]), call)
  const unruled = await InProcess.decide(acme([deny("read:.env")]), call)

  expect([ruled, unruled]).toEqual([blocked, undefined])
})

test("blocks a hashed MCP tool while a rule could deny one of its server's tools, and only then", async () => {
  const call = await DeepSeekHarness.checks(
    { name: `mcp__github__${"x".repeat(38)}_0123456789ab`, input: {} },
    where({ servers: ["github"] }),
  )

  const ruled = await InProcess.decide(acme([deny("github_delete-repo:*")]), call)
  const unruled = await InProcess.decide(acme([deny("slack_post:*")]), call)

  expect([ruled, unruled]).toEqual([blocked, undefined])
})

test("reads the skills a member's own message runs by name, and none from text that only looks like a path", () => {
  expect(
    DeepSeekHarness.invokedSkills([
      { source: { kind: "user" }, content: [{ type: "text", text: "/deploy staging, then see /usr/bin and 5/8" }] },
      { source: { kind: "tool" }, content: [{ type: "text", text: "/release" }] },
    ]),
  ).toEqual(["deploy"])
})

/**
 * A member of Acme signed in, and an empty DeepSeek Harness home. `run` is setup's sync and refresh, and `sync` a later
 * sync's, against a Console serving `config`, `models` and `skills`, with `bundles` as the skills' files.
 */
function member(
  input: {
    readonly config?: Record<string, unknown>
    readonly models?: Record<string, unknown>
    readonly skills?: readonly unknown[]
    readonly bundles?: Record<string, unknown>
  } = {},
) {
  const console = fakeConsole({
    config: () => Response.json(input.config ?? { providers: { opencode: {} } }),
    skills: () => Response.json({ skills: input.skills ?? [] }),
    ...(input.bundles === undefined ? {} : { bundles: input.bundles }),
    models: () =>
      Response.json(
        input.models ?? {
          opencode: { name: "Acme / OpenCode", models: { "claude-sonnet-4-6": entry("claude-sonnet-4-6") } },
        },
      ),
  })
  const store = temporaryStore()
  save(store, signIn(console, Number.MAX_SAFE_INTEGER))
  const home = mkdtempSync(path.join(os.tmpdir(), "opencode-console-dsh-"))
  homes.push(home)
  const paths = DeepSeekHarness.paths({}, home)
  const plugin = "/data/opencode-console/cli/dsh-plugin.js"
  const synced = <A, E>(refresh: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    Effect.runPromise(WorkspaceSync.sync(store, { force: true }).pipe(Effect.andThen(refresh), against(console)))
  return {
    console,
    store,
    paths,
    run: () => synced(DeepSeekHarness.refresh(store, { paths, plugin, harness: "deepseek-harness/0.2.2-rc.1" })),
    sync: () => synced(DeepSeekHarness.refresh(store)),
    remove: () => DeepSeekHarness.remove(store),
    patch: () => readFileSync(paths.patch, "utf8"),
  }
}

// Setup's rows, one JSON object per line; a row's `!!js` config expression is read as `{ js: <expression> }`.
function rows(patch: string) {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("- {"))
    .map((line) => JSON.parse(line.slice(2).replace(/!!js ("(?:[^"\\]|\\.)*")/g, '{"js":$1}')))
}

test("finds DeepSeek Harness's home in DSH_HOME, else ~/.dsh", () => {
  expect([
    DeepSeekHarness.paths({ DSH_HOME: "~/agents/dsh" }, "/home/ada"),
    DeepSeekHarness.paths({}, "/home/ada"),
  ]).toEqual([
    {
      home: "/home/ada/agents/dsh",
      patch: "/home/ada/agents/dsh/cordis.patch.yml",
      skills: "/home/ada/agents/dsh/skills",
    },
    { home: "/home/ada/.dsh", patch: "/home/ada/.dsh/cordis.patch.yml", skills: "/home/ada/.dsh/skills" },
  ])
})

test("loads the plugin, serves the workspace's models and starts new sessions on its default model", async () => {
  const dsh = member()

  await dsh.run()

  expect(rows(dsh.patch())).toEqual([
    {
      insert: [
        {
          id: "opencode-console",
          name: "/data/opencode-console/cli/dsh-plugin.js",
          isolate: { credentials: "opencode-console" },
        },
      ],
    },
    { id: "agent-loop", inject: ["opencodeConsole"] },
    {
      id: "llm-pi-ai",
      isolate: { credentials: "opencode-console" },
      config: {
        providers: {
          opencode: {
            displayName: "Acme / OpenCode",
            api: "anthropic-messages",
            baseURL: `${inference}/anthropic`,
            apiKeyEnv: "OPENCODE_CONSOLE_TOKEN",
            headers: { "x-opencode-plugin": `opencode-console/${version}` },
            models: [{ id: "claude-sonnet-4-6", name: "claude-sonnet-4-6", input: ["text"] }],
          },
        },
      },
    },
    { id: "agent-default-model", config: { provider: "opencode", model: "claude-sonnet-4-6" } },
  ])
})

test("connects each workspace MCP server from a config the plugin holds, never writing its token", async () => {
  const dsh = member({
    config: {
      mcp: {
        servers: {
          github: {
            type: "remote",
            url: "https://console.test/mcp/github",
            headers: { Authorization: "Bearer ocgw_secret" },
          },
          "bad name": { type: "remote", url: "https://console.test/mcp/bad" },
        },
      },
    },
  })

  const applied = await dsh.run()

  expect(rows(dsh.patch())[0].insert[1]).toEqual({
    id: "opencode-console-mcp-github",
    name: "@deepseek-ai/dsh-mcp-client",
    inject: ["opencodeConsoleMcp"],
    config: { js: "ctx.opencodeConsoleMcp.server('github')" },
  })
  expect(applied?.servers).toEqual(["github"])
  expect(dsh.patch()).not.toContain("ocgw_secret")
  expect(dsh.patch()).not.toContain(dsh.console.state.access)
})

test("adds its rows after the member's own, and writes the same patch when run again", async () => {
  const dsh = member()
  const theirs = "# my overrides\n- id: tool-web\n  disabled: true\n"
  mkdirSync(dsh.paths.home, { recursive: true })
  writeFileSync(dsh.paths.patch, theirs)

  await dsh.run()
  const first = dsh.patch()
  await dsh.sync()

  expect(first.startsWith(theirs)).toBe(true)
  expect(dsh.patch()).toBe(first)
})

test("takes the place of the empty list DeepSeek Harness writes in a new patch, and puts it back on removal", async () => {
  const dsh = member()
  const fresh = "# Your patch layer\n[]\n"
  mkdirSync(dsh.paths.home, { recursive: true })
  writeFileSync(dsh.paths.patch, fresh)

  await dsh.run()
  const written = dsh.patch()
  dsh.remove()

  expect(written).not.toContain("[]")
  expect(dsh.patch()).toBe(fresh)
})

test("puts the member's patch back exactly on removal, and deletes a patch it created", async () => {
  const theirs = member()
  const before = "- id: tool-web\n  disabled: true\n"
  mkdirSync(theirs.paths.home, { recursive: true })
  writeFileSync(theirs.paths.patch, before)
  const created = member()
  await theirs.run()
  await created.run()

  theirs.remove()
  created.remove()

  expect(theirs.patch()).toBe(before)
  expect(existsSync(created.paths.patch)).toBe(false)
  expect(existsSync(`${theirs.paths.patch}.opencode-console.bak`)).toBe(false)
})

test("keeps the member's own model routes and default model in the patch rather than add the workspace's", async () => {
  const dsh = member()
  mkdirSync(dsh.paths.home, { recursive: true })
  writeFileSync(dsh.paths.patch, "- id: llm-pi-ai\n  config:\n    providers: {}\n")

  const applied = await dsh.run()

  expect(rows(dsh.patch()).map((row) => row.id ?? "insert")).toEqual(["insert", "agent-loop"])
  expect(applied?.skipped).toEqual([`the llm-pi-ai row in ${dsh.paths.patch}`])
})

test("says which profiles' own model providers the workspace's stand in for while connected", async () => {
  const dsh = member()
  mkdirSync(path.join(dsh.paths.home, "profiles", "web"), { recursive: true })
  writeFileSync(path.join(dsh.paths.home, "profiles", "web", "cordis.patch.yml"), "- id: llm-pi-ai\n  config: {}\n")

  expect((await dsh.run())?.shadowed).toEqual(["web"])
})

test("never writes over a patch that isn't a list of rows", async () => {
  const dsh = member()
  mkdirSync(dsh.paths.home, { recursive: true })
  writeFileSync(dsh.paths.patch, "providers: {}\n")

  expect(dsh.run()).rejects.toThrow("isn't a YAML list of patch rows")
  expect(dsh.patch()).toBe("providers: {}\n")
})

test("backs up the member's patch once, readable only by them", async () => {
  const dsh = member()
  mkdirSync(dsh.paths.home, { recursive: true })
  writeFileSync(dsh.paths.patch, "- id: tool-web\n  disabled: true\n")

  await dsh.run()
  writeFileSync(dsh.paths.patch, `${dsh.patch()}- id: tool-todo\n  disabled: true\n`)
  await dsh.run()

  expect(readFileSync(`${dsh.paths.patch}.opencode-console.bak`, "utf8")).toBe("- id: tool-web\n  disabled: true\n")
  expect(statSync(`${dsh.paths.patch}.opencode-console.bak`).mode & 0o777).toBe(0o600)
})

test("asks the Console for models again only when the config's providers change", async () => {
  const dsh = member()

  await dsh.run()
  await dsh.sync()

  expect(dsh.console.state.requests.filter((item) => item.url.endsWith("/api/v1/models"))).toHaveLength(1)
})

test("makes the model routes again once the CLI that made them was updated, so they name the new version", async () => {
  const dsh = member()
  await dsh.run()
  const manifest = JSON.parse(readFileSync(DeepSeekHarness.manifestFile(dsh.store), "utf8"))
  writeFileSync(DeepSeekHarness.manifestFile(dsh.store), JSON.stringify({ ...manifest, cli: "0.1.6" }))

  await dsh.sync()

  expect(dsh.console.state.requests.filter((item) => item.url.endsWith("/api/v1/models"))).toHaveLength(2)
})

test("leaves model routes alone when the workspace serves the member no models", async () => {
  const dsh = member({ models: {} })

  const applied = await dsh.run()

  expect(rows(dsh.patch()).map((row) => row.id ?? "insert")).toEqual(["insert", "agent-loop"])
  expect(applied?.model).toBeUndefined()
})

test("expands DSH_HOME's ~\\ on Windows", () => {
  expect(DeepSeekHarness.paths({ DSH_HOME: "~\\dsh" }, "/home/ada", "win32").home).toBe("/home/ada/dsh")
})

const frontmatter = (file: string) => parse(readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---\n/)![1]!)

test("names each workspace skill by its slug, keeps its description, and marks one OpenCode runs only when asked", async () => {
  const dsh = member({
    skills: [{ slug: "deploy", version: "skl_1:1" }],
    bundles: {
      deploy: {
        format: 2,
        slug: "deploy",
        version: "skl_1:1",
        files: [
          {
            kind: "text",
            path: "SKILL.md",
            content:
              '---\nname: "Deploy"\ndescription: "Ship it"\nmetadata:\n  "opencode/autoinvoke": false\n---\n\nSteps',
          },
        ],
      },
    },
  })

  await dsh.run()

  expect(frontmatter(path.join(dsh.paths.skills, "deploy", "SKILL.md"))).toEqual({
    name: "deploy",
    description: "Ship it",
    "disable-model-invocation": true,
  })
})

test("describes a workspace skill that has no description by its title, else its slug", async () => {
  const skill = (slug: string, content: string) => ({
    format: 2,
    slug,
    version: "skl_1:1",
    files: [{ kind: "text", path: "SKILL.md", content }],
  })
  const dsh = member({
    skills: [
      { slug: "release", version: "skl_1:1" },
      { slug: "triage", version: "skl_1:1" },
    ],
    bundles: {
      release: skill("release", '---\nname: "Release train"\n---\n\nSteps'),
      triage: skill("triage", "Steps"),
    },
  })

  await dsh.run()

  expect([
    frontmatter(path.join(dsh.paths.skills, "release", "SKILL.md")),
    frontmatter(path.join(dsh.paths.skills, "triage", "SKILL.md")),
  ]).toEqual([
    { name: "release", description: "Release train" },
    { name: "triage", description: "triage" },
  ])
})

test("checks reading a workspace skill's file as running the skill, which external_directory doesn't stop", async () => {
  const skills = "/home/ada/.dsh/skills"
  const read = (file: string) => DeepSeekHarness.checks({ name: "read", input: { file_path: file } }, where({ skills }))

  const skill = await InProcess.decide(acme([deny("external_directory:*")]), await read(`${skills}/deploy/SKILL.md`))
  const outside = await InProcess.decide(acme([deny("external_directory:*")]), await read("/etc/hosts"))
  const denied = await InProcess.decide(
    acme([{ action: "skill.use", resource: "deploy", effect: "deny" }]),
    await read(`${skills}/deploy/scripts/run.sh`),
  )

  expect([skill, outside, denied]).toEqual([undefined, blocked, blocked])
})

test("checks each web search query, and refuses a search that names none", async () => {
  const search = (input: unknown) => DeepSeekHarness.checks({ name: "web_search", input }, where())

  expect((await search({ queries: ["effect v4", "dsh"] }))[0]?.resources).toEqual(["effect v4", "dsh"])
  expect((await search({ query: "effect v4" }))[0]?.resources).toEqual(["effect v4"])
  expect(search({ queries: [] })).rejects.toBeInstanceOf(DeepSeekHarness.Unreadable)
})

test("checks every way DeepSeek Harness starts an agent as a subagent, where it works outside the project too", async () => {
  const started = await Promise.all(
    [
      { name: "subagent", input: { prompt: "x", agent_preset: "Explore", cwd: "/elsewhere" } },
      { name: "subagent_fork", input: { prompt: "x" } },
      { name: "spawn_teammate", input: { name: "reviewer" } },
      { name: "ralph", input: { objective: "x" } },
    ].map((call) => DeepSeekHarness.checks(call, where())),
  )

  expect(started.map((items) => items.map((item) => [item.action, item.resources, item.directories]))).toEqual([
    [["subagent", ["explore"], ["/elsewhere"]]],
    [["subagent", ["general"], undefined]],
    [["subagent", ["reviewer"], undefined]],
    [["subagent", ["general"], undefined]],
  ])
})

test("checks programs and other coding agents DeepSeek Harness runs as unreadable shell commands", async () => {
  const run = (name: string, input: Record<string, unknown>) =>
    DeepSeekHarness.checks({ name, input }, where()).then((items) =>
      items.map((item) => [item.action, item.resources, item.opaque ?? item.truncated]),
    )

  expect(await run("workflow", { script: "run()", meta: {} })).toEqual([
    ["shell", ["run()"], true],
    ["subagent:", ["*"], true],
  ])
  expect(await run("subagent_oar", { runtime: "codex", prompt: "fix it" })).toEqual([
    ["subagent", ["codex"], undefined],
    ["shell", ["fix it"], true],
  ])
  expect(await run("terminal_open", { type: "bash", cwd: ".." })).toEqual([["shell", ["bash"], true]])
})

test("blocks a workflow while any rule could deny a subagent, and only then", async () => {
  const call = await DeepSeekHarness.checks({ name: "workflow", input: { script: "run()", meta: {} } }, where())

  const ruled = await InProcess.decide(acme([deny("subagent:explore")]), call)
  const unruled = await InProcess.decide(acme([deny("webfetch:*")]), call)

  expect([ruled, unruled]).toEqual([blocked, undefined])
})

test("checks a question to the member, and a move outside the project, as OpenCode's permissions", async () => {
  const policies = [deny("question:*"), deny("external_directory:*")]
  const decide = async (name: string, input: Record<string, unknown>) =>
    InProcess.decide(acme(policies), await DeepSeekHarness.checks({ name, input }, where()))

  expect([
    await decide("ask_user_question", { questions: [] }),
    await decide("working_directory", { cd: "/etc" }),
    await decide("working_directory", { cd: "lib" }),
    await decide("working_directory", {}),
    await decide("subagent", { prompt: "x", cwd: "/etc" }),
  ]).toEqual([blocked, blocked, undefined, undefined, blocked])
})

test("replaces its block where it is, keeping the member's rows on either side", async () => {
  const dsh = member()
  await dsh.run()
  const before = "- id: tool-web\n  disabled: true\n\n"
  const after = "\n- id: tool-todo\n  disabled: true\n"
  writeFileSync(dsh.paths.patch, `${before}${dsh.patch()}${after}`)

  await dsh.sync()

  expect(dsh.patch().startsWith(before)).toBe(true)
  expect(dsh.patch().endsWith(after)).toBe(true)
})

test("keeps the services the member's own patch has the agent loop wait for", async () => {
  const dsh = member()
  mkdirSync(dsh.paths.home, { recursive: true })
  writeFileSync(dsh.paths.patch, "- id: agent-loop\n  inject: [myGuard]\n")

  await dsh.run()

  expect(rows(dsh.patch()).find((row) => row.id === "agent-loop")).toEqual({
    id: "agent-loop",
    inject: ["myGuard", "opencodeConsole"],
  })
})

test("reads a member's patch that holds expressions, and never writes over a flow list it can't add to", async () => {
  const expressions = member()
  const flow = member()
  ;[expressions, flow].forEach((dsh) => mkdirSync(dsh.paths.home, { recursive: true }))
  writeFileSync(expressions.paths.patch, "- id: web\n  config:\n    port: !!js process.env.PORT ?? 3080\n")
  writeFileSync(flow.paths.patch, "[{ id: tool-web, disabled: true }]\n")

  await expressions.run()

  expect(expressions.patch().startsWith("- id: web\n  config:\n    port: !!js process.env.PORT ?? 3080\n")).toBe(true)
  expect(flow.run()).rejects.toThrow("flow style")
  expect(flow.patch()).toBe("[{ id: tool-web, disabled: true }]\n")
})

test("creates the patch readable only by the member", async () => {
  const dsh = member()

  await dsh.run()

  expect(statSync(dsh.paths.patch).mode & 0o777).toBe(0o600)
})

test("names only real profiles that configure their own model providers", async () => {
  const dsh = member()
  const profile = (name: string, patch: string) => {
    mkdirSync(path.join(dsh.paths.home, "profiles", name), { recursive: true })
    writeFileSync(path.join(dsh.paths.home, "profiles", name, "cordis.patch.yml"), patch)
  }
  profile("web", "- id: llm-pi-ai\n  config:\n    providers: {}\n")
  profile("headless", "- id: llm-pi-ai\n  disabled: true\n")
  profile(".web.staging-1", "- id: llm-pi-ai\n  config: {}\n")
  profile("node_modules", "- id: llm-pi-ai\n  config: {}\n")
  writeFileSync(path.join(dsh.paths.home, "profiles", "notes"), "- id: llm-pi-ai\n  config: {}\n")

  expect((await dsh.run())?.shadowed).toEqual(["web"])
})
