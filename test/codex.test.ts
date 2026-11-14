import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { HttpClient } from "effect/http"
import { parse } from "smol-toml"
import { Codex } from "../src/codex"
import { TomlFile } from "../src/toml-file"
import { WorkspaceSync } from "../src/workspace-sync"
import { version } from "../package.json" with { type: "json" }
import { against, fakeConsole, removeStores, save, signIn, temporaryStore } from "./support/console"

const homes: string[] = []
afterEach(() => {
  removeStores()
  homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true }))
})

const command = ["/opt/node/bin/node", "/data/opencode-console/cli/index.js"]
// `GET /api/v1/models` names the gateway; `GET /api/v2/codex/models` lists what Codex runs, its default first.
const workspaceModels = {
  opencode: {
    name: "Acme / OpenCode",
    models: {
      "gpt-5.2": {
        id: "gpt-5.2",
        name: "GPT-5.2",
        api: { responses: { base_url: "https://console.test/inference/openai/v1" } },
      },
    },
  },
}
const catalog = {
  models: [{ slug: "gpt-5.2", display_name: "GPT-5.2" }, { slug: "opencode-go/kimi-k2.5" }],
}

/**
 * A member of Acme signed in, and an empty home directory for Codex. `run` is setup's sync and refresh, and `sync` a
 * later sync's, both against a Console serving `config`, the models, `instructions` and `skills`, with `bundles` as
 * the skills' files, and `stats` as where usage metadata goes. `configure` and `collect` change what it serves.
 */
function member(
  input: {
    readonly config?: Record<string, unknown>
    readonly instructions?: readonly unknown[]
    readonly skills?: readonly unknown[]
    readonly bundles?: Record<string, unknown>
    readonly codexModels?: unknown
    readonly stats?: unknown
  } = {},
) {
  const served = {
    config: input.config ?? { providers: { opencode: {} } },
    stats: input.stats,
    watches: false,
  }
  const console = fakeConsole({
    // The Console offers event watches in a header beside the config (`ConsoleClient.watchesHeader`).
    config: () => Response.json(served.config, { headers: served.watches ? { "x-opencode-event-watches": "1" } : {} }),
    stats: () =>
      served.stats === undefined ? Response.json({ _tag: "NotFound" }, { status: 404 }) : Response.json(served.stats),
    models: () => Response.json(workspaceModels),
    codexModels: () => Response.json(input.codexModels ?? catalog),
    instructions: () => Response.json({ instructions: input.instructions ?? [] }),
    skills: () => Response.json({ skills: input.skills ?? [] }),
    ...(input.bundles === undefined ? {} : { bundles: input.bundles }),
  })
  const store = temporaryStore()
  save(store, signIn(console, Number.MAX_SAFE_INTEGER))
  const home = mkdtempSync(path.join(os.tmpdir(), "opencode-console-codex-"))
  homes.push(home)
  const paths = Codex.paths({}, home)
  const synced = <A, E>(refresh: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    Effect.runPromise(WorkspaceSync.sync(store, { force: true }).pipe(Effect.andThen(refresh), against(console)))
  return {
    store,
    paths,
    configure: (config: Record<string, unknown>) => {
      served.config = config
    },
    /** Whether the Console offers the member event watches. */
    offerWatches: (watches: boolean) => {
      served.watches = watches
    },
    /** Where the Console has the member send usage metadata; undefined answers 404, collecting none. */
    collect: (stats: unknown) => {
      served.stats = stats
    },
    run: (environment: Record<string, string> = {}) =>
      synced(Codex.refresh(store, { paths, command, harness: "codex_cli_rs/0.167.0", environment })),
    /** Setup with `--keep-provider`. */
    keep: () => synced(Codex.refresh(store, { paths, command, harness: "codex_cli_rs/0.167.0", keepProvider: true })),
    sync: () => synced(Codex.refresh(store)),
    remove: () => Codex.remove(store),
  }
}

const read = (file: string) => readFileSync(file, "utf8")
// The value at a key path in a TOML file.
const toml = (file: string, ...keys: string[]) => TomlFile.get(parse(read(file)), keys)
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

const hooksDisabled = (codex: { readonly paths: Codex.Paths }) =>
  write(codex.paths.config, `${read(codex.paths.config)}\n[features]\nhooks = false # off for now\n`)

test("finds Codex's hooks running once setup has registered and approved them", async () => {
  const codex = member()
  await codex.run()

  expect(Codex.hooksOff(codex.store)).toBeUndefined()
})

test("says nothing about a Codex that was never set up", () => {
  expect(Codex.hooksOff(member().store)).toBeUndefined()
})

test("finds hooks off when config.toml sets features.hooks = false, and a sync leaves that alone", async () => {
  const codex = member()
  await codex.run()
  hooksDisabled(codex)

  await codex.sync()

  expect(toml(codex.paths.config, "features", "hooks")).toBe(false)
  expect(Codex.hooksOff(codex.store)).toEqual({ reason: `features.hooks is false in ${codex.paths.config}` })
})

test("running setup turns hooks back on, keeping the rest of the member's table and its comment", async () => {
  const codex = member()
  await codex.run()
  hooksDisabled(codex)

  const applied = await codex.run()

  expect(read(codex.paths.config)).toContain("[features]\nhooks = true # off for now")
  expect(Codex.hooksOff(codex.store)).toBeUndefined()
  expect(applied?.hooksTurnedOn).toBe(codex.paths.config)
})

test("setup says nothing about hooks when it had no switch to change", async () => {
  const applied = await member().run()

  expect(applied?.hooksTurnedOn).toBeUndefined()
})

test("leaves a features.hooks setup can't change in place, and doesn't claim it changed it", async () => {
  const codex = member()
  write(codex.paths.config, "features = { hooks = false }\n")

  const applied = await codex.run()

  expect(toml(codex.paths.config, "features", "hooks")).toBe(false)
  expect(applied?.hooksTurnedOn).toBeUndefined()
})

// The member's switch set before setup first ran, which setup then turned on.
async function hooksTurnedOn() {
  const codex = member()
  write(codex.paths.config, "[features]\nhooks = false # off for now\n")
  await codex.run()
  return codex
}

test("--remove puts back the features.hooks setup turned on, with its comment", async () => {
  const codex = await hooksTurnedOn()

  codex.remove()

  expect(read(codex.paths.config)).toContain("[features]\nhooks = false # off for now")
})

test("a background sync keeps the features.hooks setup turned on", async () => {
  const codex = await hooksTurnedOn()

  await codex.sync()

  expect(toml(codex.paths.config, "features", "hooks")).toBe(true)
})

test("--remove leaves features.hooks as the member changed it after setup", async () => {
  const codex = await hooksTurnedOn()
  write(codex.paths.config, read(codex.paths.config).replace("hooks = true # off for now\n", "other = 1\n"))

  codex.remove()

  expect(toml(codex.paths.config, "features", "hooks")).toBeUndefined()
  expect(toml(codex.paths.config, "features", "other")).toBe(1)
})

test("--remove still finishes when the member moved features.hooks out of its own line", async () => {
  const codex = await hooksTurnedOn()
  const moved = read(codex.paths.config).replace("[features]\nhooks = true # off for now\n", "")
  write(codex.paths.config, `features = { hooks = true }\n${moved}`)

  expect(codex.remove()).toBe(true)

  expect(toml(codex.paths.config, "features", "hooks")).toBe(true)
})

test("a background sync leaves features.hooks the member turned off again after setup", async () => {
  const codex = await hooksTurnedOn()
  write(codex.paths.config, read(codex.paths.config).replace("hooks = true", "hooks = false"))

  await codex.sync()

  expect(toml(codex.paths.config, "features", "hooks")).toBe(false)
})

test("finds setup's PreToolUse hook missing from hooks.json, and the next sync writes it back", async () => {
  const codex = member()
  await codex.run()
  const hooks = JSON.parse(read(codex.paths.hooks))
  write(codex.paths.hooks, JSON.stringify({ ...hooks, hooks: { ...hooks.hooks, PreToolUse: [] } }))
  expect(Codex.hooksOff(codex.store)).toEqual({
    reason: `setup's PreToolUse hook is missing from ${codex.paths.hooks}`,
  })

  await codex.sync()

  expect(Codex.hooksOff(codex.store)).toBeUndefined()
})

test("finds setup's PreToolUse hook no longer approved, which Codex then skips silently", async () => {
  const codex = member()
  await codex.run()
  const key = `${codex.paths.hooks}:pre_tool_use:0:0`
  write(
    codex.paths.config,
    TomlFile.edit(codex.paths.config, read(codex.paths.config), [{ type: "remove", path: ["hooks", "state", key] }]),
  )

  expect(Codex.hooksOff(codex.store)).toEqual({
    reason: `setup's PreToolUse hook isn't approved in ${codex.paths.config}`,
  })
})

test("names a CODEX_HOME that doesn't exist yet by the real path of the directory it will be in", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "opencode-console-codex-home-"))
  homes.push(parent)
  const link = `${parent}-link`
  symlinkSync(parent, link)
  homes.push(link)

  expect(Codex.paths({ CODEX_HOME: path.join(link, "codex") }).hooks).toBe(
    path.join(realpathSync(parent), "codex", "hooks.json"),
  )
})

test("sends model requests to the gateway with the member's token, starting on the catalog's default", async () => {
  const codex = member()

  await codex.run()

  expect({ provider: toml(codex.paths.config, "model_provider"), model: toml(codex.paths.config, "model") }).toEqual({
    provider: "opencode-console",
    model: "gpt-5.2",
  })
  expect(toml(codex.paths.config, "model_providers", "opencode-console")).toEqual({
    name: "OpenCode Console",
    base_url: "https://console.test/inference/openai/v1",
    wire_api: "responses",
    model_catalog_url: "https://console.test/console/api/v2/codex/models",
    http_headers: { "x-opencode-plugin": `opencode-console/${version}` },
    auth: {
      command: "/opt/node/bin/node",
      args: ["/data/opencode-console/cli/index.js", "token", "--harness", "codex_cli_rs/0.167.0"],
      refresh_interval_ms: 240000,
      timeout_ms: 15000,
    },
  })
})

test("keeps the member's own settings and comments in config.toml as they wrote them", async () => {
  const codex = member()
  write(codex.paths.config, '# my settings\nmodel = "o3"   # the one I like\n\n[tui]\nnotifications = true\n')

  await codex.run()

  const text = read(codex.paths.config)
  expect(
    text.startsWith('# my settings\nmodel = "gpt-5.2"   # the one I like\nmodel_provider = "opencode-console"\n'),
  ).toBe(true)
  expect(text).toContain("\n[tui]\nnotifications = true\n")
})

test("checks every tool call and prompt with a hook beside the member's own, approved as /hooks would", async () => {
  const codex = member()
  const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }
  write(codex.paths.hooks, JSON.stringify({ hooks: { PreToolUse: [theirs] } }))

  await codex.run()

  const policy = {
    type: "command",
    command: "/opt/node/bin/node /data/opencode-console/cli/index.js --harness codex_cli_rs/0.167.0 hook codex",
  }
  expect(JSON.parse(read(codex.paths.hooks)).hooks).toEqual({
    PreToolUse: [theirs, { matcher: "*", hooks: [{ ...policy, timeout: 30 }] }],
    UserPromptSubmit: [{ hooks: [{ ...policy, timeout: 30 }] }],
    SessionStart: [{ hooks: [{ ...policy, timeout: 10 }] }],
  })
  expect(Object.keys(Object(toml(codex.paths.config, "hooks", "state")))).toEqual([
    `${codex.paths.hooks}:pre_tool_use:1:0`,
    `${codex.paths.hooks}:user_prompt_submit:0:0`,
    `${codex.paths.hooks}:session_start:0:0`,
  ])
})

test("approves a hook by the hash Codex 0.167.0 gave the same declaration", () => {
  // `hooks/list` from Codex 0.167.0's app server reported this hash, as trusted, for this declaration.
  const hash = Codex.trustHash("PreToolUse", {
    matcher: "*",
    hooks: [{ type: "command", command: "/bin/echo hi", timeout: 30 }],
  })

  expect(hash).toBe("sha256:de09888112db38626e6ce9773e79495231b636c44c67c4e615e1cc0022eb4ef2")
})

test("writes the same files when run again", async () => {
  const codex = member()
  await codex.run()
  const before = [read(codex.paths.config), read(codex.paths.hooks)]

  await codex.run()

  expect([read(codex.paths.config), read(codex.paths.hooks)]).toEqual(before)
})

// Setup's hook command as 0.1.8 and 0.1.9 wrote it on Windows, every word double-quoted, which they couldn't tell
// was their own.
const windowsHook = (timeout: number) => ({
  type: "command",
  command:
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Ada Lovelace\\AppData\\opencode-console\\cli\\index.js" "--harness" "codex_cli_rs/0.167.0" "hook" "codex"',
  timeout,
})
// The same hook as setup writes it on Windows now, for the PowerShell Codex runs hooks in.
const powershellHook =
  "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\Ada O''Brien\\opencode-console\\cli\\index.js' 'hook' 'codex'; exit $LASTEXITCODE"

test("writes Windows hook lines PowerShell runs as one program, keeping the CLI's exit code", () => {
  // PowerShell reads curly quotes as single quotes too, so each is doubled, as itself.
  expect(
    Codex.hookLine(
      ["C:\\Users\\O\u2019Brien\\bin\\opencode-console.exe", "\u2018a\u201Ab\u201B", "hook", "codex"],
      "win32",
    ),
  ).toBe(
    "& 'C:\\Users\\O\u2019\u2019Brien\\bin\\opencode-console.exe' '\u2018\u2018a\u201A\u201Ab\u201B\u201B' 'hook' 'codex'; exit $LASTEXITCODE",
  )
  expect(
    Codex.hookLine(
      [
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Users\\Ada O'Brien\\opencode-console\\cli\\index.js",
        "hook",
        "codex",
      ],
      "win32",
    ),
  ).toBe(powershellHook)
})

test("collapses the hook entries a Windows setup left repeated in hooks.json to one per event", async () => {
  const codex = member()
  const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }
  const repeated = (group: Record<string, unknown>) => [group, group, group]
  write(
    codex.paths.hooks,
    JSON.stringify({
      hooks: {
        PreToolUse: [theirs, ...repeated({ matcher: "*", hooks: [windowsHook(30)] })],
        UserPromptSubmit: repeated({ hooks: [windowsHook(30)] }),
        SessionStart: repeated({ hooks: [windowsHook(10)] }),
      },
    }),
  )

  await codex.run()

  const hooks = JSON.parse(read(codex.paths.hooks)).hooks
  expect([hooks.PreToolUse.length, hooks.UserPromptSubmit.length, hooks.SessionStart.length]).toEqual([2, 1, 1])
  expect(hooks.PreToolUse[0]).toEqual(theirs)
})

test("finds setup's hooks running when their command is a Windows PowerShell line", async () => {
  const codex = member()
  await codex.run()
  const hooks = JSON.parse(read(codex.paths.hooks))
  hooks.hooks.PreToolUse[0].hooks = [{ type: "command", command: powershellHook, timeout: 30 }]
  write(codex.paths.hooks, JSON.stringify(hooks))

  expect(Codex.hooksOff(codex.store)).toBeUndefined()
})

test("leaves config.toml as it is when nothing setup owns changed, though Codex added to it since", async () => {
  const codex = member()
  await codex.run()
  const written = `${read(codex.paths.config)}\n[projects."/work/app"]\ntrust_level = "trusted"\n`
  write(codex.paths.config, written)

  await codex.run()

  expect(read(codex.paths.config)).toBe(written)
})

test("a background sync leaves the default model the member changed since setup", async () => {
  const codex = member()
  await codex.run()
  write(codex.paths.config, read(codex.paths.config).replace('model = "gpt-5.2"', 'model = "opencode-go/kimi-k2.5"'))

  await codex.sync()

  expect(toml(codex.paths.config, "model")).toBe("opencode-go/kimi-k2.5")
})

test("keeps Codex's own sign-in when the workspace has no model Codex can run", async () => {
  const codex = member({ codexModels: { models: [] } })

  await codex.run()

  expect([toml(codex.paths.config, "model_provider"), toml(codex.paths.config, "model_providers")]).toEqual([
    undefined,
    undefined,
  ])
})

test("adds the workspace's MCP servers, whose gateway token a helper prints, beside the member's own", async () => {
  const codex = member({
    config: {
      mcp: {
        servers: {
          github: { type: "remote", url: "https://console.test/mcp/github", headers: { authorization: "Bearer x" } },
          docs: { type: "remote", url: "https://docs.test/mcp" },
          notes: { type: "remote", url: "https://console.test/mcp/notes" },
        },
      },
    },
  })
  write(codex.paths.config, '[mcp_servers.notes]\ncommand = "notes-mcp"\n')

  const applied = await codex.run({ XDG_DATA_HOME: "/home/ada/data" })

  const servers = toml(codex.paths.config, "mcp_servers")
  expect(servers).toEqual({
    notes: { command: "notes-mcp" },
    github: {
      url: "https://console.test/mcp/github",
      http_headers_helper:
        "env XDG_DATA_HOME=/home/ada/data /opt/node/bin/node /data/opencode-console/cli/index.js --harness codex_cli_rs/0.167.0 mcp-headers github",
    },
    docs: { url: "https://docs.test/mcp" },
  })
  expect(applied?.skipped).toEqual(["notes"])
})

test("has Codex itself forbid commands a plain shell deny names, unless a later rule allows some back", async () => {
  const codex = member({
    config: {
      policies: [
        { action: "tool.use", resource: "shell:rm *", effect: "deny" },
        { action: "tool.use", resource: "shell:git push --force*", effect: "deny" },
        { action: "tool.use", resource: "shell:curl *", effect: "deny" },
        { action: "tool.use", resource: "shell:curl -I *", effect: "allow" },
        { action: "tool.use", resource: "shell:*secret*", effect: "deny" },
      ],
    },
  })

  await codex.run()

  expect(read(codex.paths.rules).split("\n").slice(1)).toEqual([
    `prefix_rule(pattern = ["rm"], decision = "forbidden", justification = "Blocked by Acme's policy")`,
    `prefix_rule(pattern = ["git","push","--force"], decision = "forbidden", justification = "Blocked by Acme's policy")`,
    "",
  ])
})

test("deletes the command rules once the workspace has no plain shell deny", async () => {
  const codex = member({ config: { policies: [{ action: "tool.use", resource: "shell:rm *", effect: "deny" }] } })
  await codex.run()
  codex.configure({ policies: [] })

  await codex.sync()

  expect(existsSync(codex.paths.rules)).toBe(false)
})

test("turns Codex's own web search off while a policy could deny a search", async () => {
  const codex = member({ config: { policies: [{ action: "tool.use", resource: "websearch:*", effect: "deny" }] } })

  await codex.run()

  expect(toml(codex.paths.config, "web_search")).toBe("disabled")
})

test("writes workspace skills to Codex's skills directory and instructions between markers in AGENTS.md", async () => {
  const codex = member({
    instructions: [{ id: "ins_1", name: "Style", content: "Use tabs." }],
    skills: [{ slug: "deploy", version: "v1" }],
    bundles: {
      deploy: {
        format: 2,
        slug: "deploy",
        version: "v1",
        files: [{ kind: "text", path: "SKILL.md", content: "---\nname: deploy\ndescription: Ship it\n---\nGo.\n" }],
      },
    },
  })
  write(codex.paths.memory, "# Mine\n")

  await codex.run()

  expect(read(path.join(codex.paths.skills, "deploy", "SKILL.md"))).toBe("---\ndescription: Ship it\n---\nGo.\n")
  expect(read(codex.paths.memory)).toContain("# Mine\n\n<!-- opencode-console:start -->")
  expect(read(codex.paths.memory)).toContain("## Style\n\nUse tabs.")
})

test("leaves every file alone when config.toml isn't valid TOML", async () => {
  const codex = member()
  write(codex.paths.config, "model = \n")
  write(codex.paths.hooks, '{"hooks":{}}')

  await expect(codex.run()).rejects.toThrow("isn't valid TOML")

  expect([read(codex.paths.config), read(codex.paths.hooks)]).toEqual(["model = \n", '{"hooks":{}}'])
})

test("leaves config.toml alone rather than rewrite a key whose value it can't replace on its own line", async () => {
  const codex = member()
  const text = 'model = """\ngpt-5\n"""\n'
  write(codex.paths.config, text)

  await expect(codex.run()).rejects.toThrow("left alone")

  expect(read(codex.paths.config)).toBe(text)
})

test("leaves config.toml alone rather than change a line inside a string that reads like a key", async () => {
  const codex = member()
  const text = 'developer_instructions = """\nmodel = "keep this line"\n"""\n'
  write(codex.paths.config, text)

  await expect(codex.run()).rejects.toThrow("left alone")

  expect(read(codex.paths.config)).toBe(text)
})

test("keeps a 0600 backup of hooks.json and makes a new config.toml readable only by the member", async () => {
  const codex = member()
  write(codex.paths.hooks, "{}")

  await codex.run()

  expect([
    statSync(codex.paths.config).mode & 0o777,
    statSync(`${codex.paths.hooks}.opencode-console.bak`).mode & 0o777,
  ]).toEqual([0o600, 0o600])
})

test("--remove puts config.toml and hooks.json back as the member wrote them", async () => {
  const codex = member({ config: { policies: [{ action: "tool.use", resource: "shell:rm *", effect: "deny" }] } })
  const config = '# mine\nmodel = "o3" # fast\n\n[tui]\nnotifications = true\n'
  const hooks = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }, null, 2)
  write(codex.paths.config, config)
  write(codex.paths.hooks, `${hooks}\n`)
  await codex.run()

  expect(codex.remove()).toBe(true)

  expect([read(codex.paths.config), read(codex.paths.hooks)]).toEqual([config, `${hooks}\n`])
  expect([existsSync(codex.paths.rules), existsSync(`${codex.paths.config}.opencode-console.bak`)]).toEqual([
    false,
    false,
  ])
})

test("--remove deletes the files setup created", async () => {
  const codex = member()
  await codex.run()

  codex.remove()

  expect([existsSync(codex.paths.config), existsSync(codex.paths.hooks)]).toEqual([false, false])
})

test("--remove leaves no blank lines where setup's keys were above what Codex wrote", async () => {
  const codex = member()
  await codex.run()
  write(codex.paths.config, `${read(codex.paths.config)}\n[projects."/work/app"]\ntrust_level = "trusted"\n`)

  codex.remove()

  expect(read(codex.paths.config)).toBe('[projects."/work/app"]\ntrust_level = "trusted"\n')
})

test("--remove keeps a key the member changed since setup, and what Codex wrote to config.toml since", async () => {
  const codex = member()
  await codex.run()
  write(
    codex.paths.config,
    `${read(codex.paths.config).replace('model = "gpt-5.2"', 'model = "gpt-5.1"')}\n[projects."/work/app"]\ntrust_level = "trusted"\n`,
  )

  codex.remove()

  expect(read(codex.paths.config)).toBe('model = "gpt-5.1"\n\n[projects."/work/app"]\ntrust_level = "trusted"\n')
})

test("--keep-provider keeps Codex's own sign-in while still adding hooks, rules, servers, skills and instructions", async () => {
  const codex = member({
    config: {
      providers: { opencode: {} },
      policies: [{ action: "tool.use", resource: "shell:rm *", effect: "deny" }],
      mcp: { servers: { docs: { type: "remote", url: "https://docs.test/mcp" } } },
    },
    instructions: [{ id: "ins_1", name: "Style", content: "Use tabs." }],
    skills: [{ slug: "deploy", version: "v1" }],
    bundles: {
      deploy: {
        format: 2,
        slug: "deploy",
        version: "v1",
        files: [{ kind: "text", path: "SKILL.md", content: "Go.\n" }],
      },
    },
  })

  await codex.keep()

  expect([
    toml(codex.paths.config, "model_provider"),
    toml(codex.paths.config, "model"),
    toml(codex.paths.config, "model_providers"),
  ]).toEqual([undefined, undefined, undefined])
  expect(Object.keys(JSON.parse(read(codex.paths.hooks)).hooks)).toEqual([
    "PreToolUse",
    "UserPromptSubmit",
    "SessionStart",
  ])
  expect(read(codex.paths.rules)).toContain('prefix_rule(pattern = ["rm"]')
  expect(toml(codex.paths.config, "mcp_servers")).toEqual({ docs: { url: "https://docs.test/mcp" } })
  expect(read(path.join(codex.paths.skills, "deploy", "SKILL.md"))).toBe("Go.\n")
  expect(read(codex.paths.memory)).toContain("Use tabs.")
})

// Where the Console has this connector send usage metadata (`GET /api/v2/stats`).
const stats = {
  otlpLogsUrl: "https://console.test/console/api/otel/v1/logs",
  headers: { authorization: "Bearer ocstats_1" },
}
// The usage hook, as Codex's `/hooks` lists it: synchronous, so Codex ends the session only after it has returned.
const usageHook = {
  type: "command",
  command: "/opt/node/bin/node /data/opencode-console/cli/index.js --harness codex_cli_rs/0.167.0 hook codex",
  timeout: 10,
} as const

test("reports each model response's token counts with an approved synchronous hook while Codex keeps its own sign-in", async () => {
  const codex = member({ stats })

  const applied = await codex.keep()

  expect(applied?.usage).toBe("shared")
  expect(JSON.parse(read(codex.paths.hooks)).hooks.PostModelRequest).toEqual([{ hooks: [usageHook] }])
  expect(toml(codex.paths.config, "hooks", "state", `${codex.paths.hooks}:post_model_request:0:0`)).toEqual({
    trusted_hash: Codex.trustHash("PostModelRequest", { hooks: [usageHook] }),
  })
})

test("replaces an async usage hook and its approval with the synchronous one, so Codex runs the hook and honours it", async () => {
  const codex = member({ stats })
  await codex.keep()
  // What an earlier setup wrote before the hook was synchronous.
  const asyncHook = { ...usageHook, async: true }
  write(codex.paths.hooks, JSON.stringify({ hooks: { PostModelRequest: [{ hooks: [asyncHook] }] } }))
  const approved = read(codex.paths.config).replace(
    Codex.trustHash("PostModelRequest", { hooks: [usageHook] }),
    Codex.trustHash("PostModelRequest", { hooks: [asyncHook] }),
  )
  write(codex.paths.config, approved)

  await codex.sync()

  expect(JSON.parse(read(codex.paths.hooks)).hooks.PostModelRequest).toEqual([{ hooks: [usageHook] }])
  expect(toml(codex.paths.config, "hooks", "state", `${codex.paths.hooks}:post_model_request:0:0`)).toEqual({
    trusted_hash: Codex.trustHash("PostModelRequest", { hooks: [usageHook] }),
  })
})

test("adds no usage hook to a Codex that uses the gateway, which counts its requests already", async () => {
  const codex = member({ stats })

  const applied = await codex.run()

  expect([applied?.usage, JSON.parse(read(codex.paths.hooks)).hooks.PostModelRequest]).toEqual([undefined, undefined])
})

test("adds no usage hook while the workspace collects no usage metadata", async () => {
  const codex = member({ config: {} })

  await codex.keep()

  expect(JSON.parse(read(codex.paths.hooks)).hooks.PostModelRequest).toBeUndefined()
})

test("takes the usage hook and its approval out once the workspace stops collecting usage metadata", async () => {
  const codex = member({ config: {}, stats })
  await codex.keep()

  codex.collect(undefined)
  await codex.sync()

  expect(JSON.parse(read(codex.paths.hooks)).hooks.PostModelRequest).toBeUndefined()
  expect(toml(codex.paths.config, "hooks", "state", `${codex.paths.hooks}:post_model_request:0:0`)).toBeUndefined()
})

test("writes no token to config.toml", async () => {
  const codex = member({ config: {}, stats })

  await codex.keep()

  expect([read(codex.paths.config).includes("ocstats_1"), toml(codex.paths.config, "otel")]).toEqual([false, undefined])
})

test("removes an [otel] table an earlier setup recorded as its own", async () => {
  const codex = member({ config: {}, stats })
  write(codex.paths.config, '# mine\nmodel = "o3"\n')
  await codex.keep()
  const manifest = JSON.parse(read(Codex.manifestFile(codex.store)))
  writeFileSync(
    Codex.manifestFile(codex.store),
    JSON.stringify({ ...manifest, tables: [...manifest.tables, ["otel"]] }),
  )
  write(codex.paths.config, `${read(codex.paths.config)}\n[otel]\nlog_user_prompt = false\n`)

  await codex.sync()

  expect(toml(codex.paths.config, "otel")).toBeUndefined()
  expect(read(codex.paths.config).startsWith('# mine\nmodel = "o3"\n')).toBe(true)
})

test("gives Codex the watch tools and the event watch hooks, approved, while the workspace offers event watches", async () => {
  const codex = member()
  codex.offerWatches(true)

  await codex.run({ XDG_DATA_HOME: "/home/ada/.local/share" })

  const line = "/opt/node/bin/node /data/opencode-console/cli/index.js --harness codex_cli_rs/0.167.0 hook codex"
  const hooks = JSON.parse(read(codex.paths.hooks)).hooks
  expect(hooks).toMatchObject({
    UserPromptSubmit: [
      { hooks: [{ command: line }] },
      { hooks: [{ type: "command", command: `${line} --listen`, timeout: 3600, async: true }] },
    ],
    PostToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: line, timeout: 3600, async: true }] }],
    Stop: [{ hooks: [{ type: "command", command: line, timeout: 30 }] }],
    Interrupt: [{ hooks: [{ type: "command", command: line, timeout: 3 }] }],
  })
  expect(Object.keys(Object(toml(codex.paths.config, "hooks", "state")))).toEqual(
    expect.arrayContaining([
      `${codex.paths.hooks}:user_prompt_submit:1:0`,
      `${codex.paths.hooks}:post_tool_use:0:0`,
      `${codex.paths.hooks}:stop:0:0`,
      `${codex.paths.hooks}:interrupt:0:0`,
    ]),
  )
  expect(toml(codex.paths.config, "mcp_servers", "console_watch")).toEqual({
    command: "/opt/node/bin/node",
    args: ["/data/opencode-console/cli/index.js", "--harness", "codex_cli_rs/0.167.0", "mcp-watches", "--next-prompt"],
    env: { XDG_DATA_HOME: "/home/ada/.local/share" },
    env_vars: ["OPENCODE_API_KEY"],
  })
})

test("takes the watch tools and hooks out once the workspace stops offering event watches", async () => {
  const codex = member()
  codex.offerWatches(true)
  await codex.run()
  codex.offerWatches(false)

  await codex.sync()

  expect(Object.keys(JSON.parse(read(codex.paths.hooks)).hooks)).toEqual([
    "PreToolUse",
    "UserPromptSubmit",
    "SessionStart",
  ])
  expect(JSON.parse(read(codex.paths.hooks)).hooks.UserPromptSubmit).toHaveLength(1)
  expect(toml(codex.paths.config, "mcp_servers", "console_watch")).toBeUndefined()
  expect(Object.keys(Object(toml(codex.paths.config, "hooks", "state")))).toHaveLength(3)
})

test("--remove takes the watch tools and hooks out with the rest", async () => {
  const codex = member()
  codex.offerWatches(true)
  await codex.run()

  codex.remove()

  expect([existsSync(codex.paths.hooks), existsSync(codex.paths.config)]).toEqual([false, false])
})

test("leaves a console_watch MCP server the member added as theirs", async () => {
  const codex = member()
  codex.offerWatches(true)
  write(codex.paths.config, '[mcp_servers.console_watch]\ncommand = "mine"\n')

  const applied = await codex.run()

  expect([toml(codex.paths.config, "mcp_servers", "console_watch"), applied?.skipped]).toEqual([
    { command: "mine" },
    ["console_watch"],
  ])
})
