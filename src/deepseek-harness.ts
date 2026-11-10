export * as DeepSeekHarness from "./deepseek-harness"

import { createHash } from "node:crypto"
import { existsSync, readdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { isSeq, parseDocument } from "yaml"
import { version } from "../package.json" with { type: "json" }
import { ConsoleClient } from "./console-client"
import { ConsoleCredentials } from "./credentials"
import type { PolicyEvaluator } from "./policy-evaluator"
import { SettingsFile } from "./settings-file"
import { Skill } from "./skill"
import { WorkspaceSnapshot } from "./snapshot"
import { ConsoleStore } from "./store"
import { WorkspaceModels } from "./workspace-models"
import { WorkspaceSync } from "./workspace-sync"

/**
 * Where DeepSeek Harness keeps what setup changes (github.com/deepseek-ai/deepseek-harness, `apps/cli/reference`): its
 * home, `~/.dsh` or `DSH_HOME`, whose `cordis.patch.yml` is the patch layer every profile (`dsh web`, `dsh headless`,
 * ACP, the SDK and the desktop app) applies after its own, and whose `skills` folder every profile loads.
 */
export interface Paths {
  readonly home: string
  readonly patch: string
  readonly skills: string
}

export function paths(
  env: Record<string, string | undefined> = process.env,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): Paths {
  const named = env.DSH_HOME?.trim()
  // A leading `~` is the home directory, as DeepSeek Harness expands it, with `~\` too on Windows.
  const tilde = named !== undefined && (named.startsWith("~/") || (platform === "win32" && named.startsWith("~\\")))
  const root = path.resolve(
    named ? (named === "~" ? home : tilde ? path.join(home, named.slice(2)) : named) : home,
    named ? "" : ".dsh",
  )
  return { home: root, patch: path.join(root, "cordis.patch.yml"), skills: path.join(root, "skills") }
}

/**
 * The credential reference the workspace's model routes name (`apiKeyEnv`). The plugin answers it with the member's
 * current token from its own credential store, so no token is ever written to DeepSeek Harness's files.
 */
export const TOKEN = "OPENCODE_CONSOLE_TOKEN"
/** The isolation label the plugin's credential store shares with the rows that read it. */
export const REALM = "opencode-console"
/** The service the plugin provides, which the agent loop waits for, so DeepSeek Harness never runs without it. */
export const SERVICE = "opencodeConsole"
/**
 * The service the workspace's MCP server rows read their config from when they start (`!!js`), with headers such as
 * the gateway's day-bucketed `ocgw_` token held only in memory. The plugin provides it again when they change.
 */
export const MCP_SERVICE = "opencodeConsoleMcp"

/** One model route as `@deepseek-ai/dsh-llm-pi-ai` configures it (`providers.<id>`). */
export const Route = Schema.Struct({
  displayName: Schema.String,
  api: Schema.Literals(["anthropic-messages", "openai-responses", "openai-completions"]),
  baseURL: Schema.String,
  apiKeyEnv: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  compat: Schema.optional(Schema.Struct({ supportsDeveloperRole: Schema.Boolean, maxTokensField: Schema.String })),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      contextWindow: Schema.optional(Schema.Number),
      maxTokens: Schema.optional(Schema.Number),
      input: Schema.Array(Schema.Literals(["text", "image"])),
    }),
  ),
})
export type Route = typeof Route.Type

// The protocols DeepSeek Harness speaks to a custom provider, by models.dev's name for each.
const protocols = {
  messages: "anthropic-messages",
  responses: "openai-responses",
  "chat-completions": "openai-completions",
} as const

/**
 * The workspace's chat models as DeepSeek Harness model routes, one per provider config gives them (`opencode`,
 * `opencode-go`, `console-<slug>`). A route speaks one protocol at one URL, so a provider whose models the gateway
 * serves natively in one protocol at one URL is served that way, and any other (OpenCode's own, which mixes Claude,
 * GPT and others) through the gateway's Anthropic endpoint, which serves every model by its gateway ID as it does for
 * Claude Code. Each route names the connector on every request with `x-opencode-plugin`.
 */
export function routes(document: ConsoleClient.ModelsDocument): Record<string, Route> {
  const listed = WorkspaceModels.list(document)
  const root = WorkspaceModels.inferenceRoot(listed)
  const grouped = Map.groupBy(listed, (item) => item.provider)
  return Object.fromEntries(
    [...grouped].flatMap(([provider, models]) => {
      const served = models.map(native)
      const first = served[0]
      const same = first !== undefined && served.every((item) => item?.api === first.api && item.url === first.url)
      if (!same && root === undefined) return []
      const api = same ? first.api : "anthropic-messages"
      const route: Route = {
        displayName: document[provider]?.name ?? provider,
        api,
        // DeepSeek Harness's Anthropic client adds `/v1/messages` itself.
        baseURL: same
          ? api === "anthropic-messages"
            ? first.url.replace(/\/v1\/?$/, "")
            : first.url
          : `${root}/anthropic`,
        apiKeyEnv: TOKEN,
        headers: { "x-opencode-plugin": `opencode-console/${version}` },
        // What gateways that speak Chat Completions need (DeepSeek Harness's providers guide, "Request compatibility").
        ...(api === "openai-completions"
          ? { compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" } }
          : {}),
        models: models.map((item) => model(item, same || provider === "opencode" ? item.id : `${provider}/${item.id}`)),
      }
      return [[provider, route]]
    }),
  )
}

/** The model a new DeepSeek Harness session starts on: the newest Claude Sonnet the member may use, else the nearest. */
export function defaultModel(document: ConsoleClient.ModelsDocument) {
  const listed = WorkspaceModels.list(document)
  const picked = WorkspaceModels.newest(listed, "sonnet", "opus", "haiku")
  if (!picked) return undefined
  const route = routes(document)[picked.provider]
  const id = route?.models.find((item) => item.id === picked.id || item.id === `${picked.provider}/${picked.id}`)?.id
  return id === undefined ? undefined : { provider: picked.provider, model: id }
}

function native(listed: WorkspaceModels.Listed) {
  const apis = SettingsFile.record(listed.entry.api)
  const protocol = Object.keys(protocols).find((key): key is keyof typeof protocols => key in apis)
  const url = protocol && SettingsFile.text(SettingsFile.record(apis[protocol]).base_url)
  return protocol && url ? { api: protocols[protocol], url } : undefined
}

function model(listed: WorkspaceModels.Listed, id: string): Route["models"][number] {
  const limit = SettingsFile.record(listed.entry.limit)
  const inputs = SettingsFile.record(listed.entry.modalities).input
  return {
    id,
    name: SettingsFile.text(listed.entry.name) ?? listed.id,
    ...(number(limit.context) === undefined ? {} : { contextWindow: number(limit.context) }),
    ...(number(limit.output) === undefined ? {} : { maxTokens: number(limit.output) }),
    input:
      Array.isArray(inputs) && inputs.some((kind) => typeof kind === "string" && kind.startsWith("image"))
        ? ["text", "image"]
        : ["text"],
  }
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/** A workspace MCP server as `@deepseek-ai/dsh-mcp-client` connects to it, headers included. */
export function mcpConfig(
  name: string,
  server: { readonly url: string; readonly headers?: Readonly<Record<string, string>> | undefined } | undefined,
) {
  if (!server) throw new Error(`The workspace doesn't offer the MCP server ${name} anymore`)
  return {
    serverName: name,
    transport: "streamable-http",
    url: server.url,
    ...(server.headers ? { headers: { ...server.headers } } : {}),
  }
}

/** A tool call or prompt that can't be turned into checks, which the plugin blocks rather than let through. */
export class Unreadable extends Error {}

/** Where a DeepSeek Harness tool call runs, and how it names paths. */
export interface Where {
  /**
   * The session's project directory, which paths outside of need `external_directory`, as DeepSeek Harness's own
   * filesystem names it (its real path).
   */
  readonly directory: string
  /** The session's current directory, which relative paths resolve against, named the same way. */
  readonly cwd: string
  /** A path as the tool resolves it: DeepSeek Harness's own filesystem resolution from the current directory. */
  readonly resolve: (input: string) => Promise<string>
  /** The workspace's MCP servers by name, to split an MCP tool's name where the server's ends. */
  readonly servers?: readonly string[] | undefined
  /** The folder setup writes the workspace's skills to, whose files DeepSeek Harness reads to run a skill. */
  readonly skills?: string | undefined
}

/**
 * The checks a DeepSeek Harness tool call needs, in OpenCode's permission vocabulary, all of which must allow it. Its
 * tools (`docs/tool-catalog.md`) map to the permission OpenCode's own tool asks for, with every path resolved as the
 * tool resolves it:
 * - `bash` and `pwsh` → `shell` where they run; `write`, `edit` and every file an `apply_patch` names → `edit`;
 *   `read`, `read_image`, `lsp` and `str_replace_editor`'s `view` → `read` (a file in a workspace skill's folder is
 *   that skill's `skill` check instead); `str_replace_editor`'s other commands → `edit`; `glob` and `grep`;
 * - `web_fetch` → `webfetch`, and `web_search` → `websearch` on each query;
 * - `subagent`, `subagent_fork`, `spawn_teammate`, `ralph` and `subagent_oar` → `subagent` on the agent they start,
 *   with their `cwd` needing `external_directory` outside the project; `workflow` starts subagents too;
 * - `run_code`, `workflow`, `terminal_open`, `terminal_send` and `subagent_oar` (which starts another coding agent) run
 *   code no scanner can read, so they're checked as a shell command that can't be analyzed;
 * - `ask_user_question` → `question`; `working_directory`'s `cd` needs `external_directory` outside the project;
 * - `skill`; an MCP tool (`mcp__<server>__<tool>`) → its server's `mcp.use` and the tool's `<server>_<tool>`, and the
 *   MCP resource tools their server's `mcp.use`. Any other tool is checked by its name.
 */
export async function checks(
  call: { readonly name: string; readonly input: unknown },
  where: Where,
): Promise<PolicyEvaluator.Input[]> {
  const input = SettingsFile.record(call.input)
  const tool = call.name
  const check = (action: string, resources: readonly string[], extra: Partial<PolicyEvaluator.Input> = {}) => ({
    action,
    resources,
    directory: where.directory,
    ...extra,
  })
  const optional = (name: string) => {
    const value = input[name]
    return typeof value === "string" && value !== "" ? value : undefined
  }
  const field = (name: string) => {
    const value = optional(name)
    if (value === undefined) throw new Unreadable(`${tool}'s input has no ${name}`)
    return value
  }
  const file = (name: string) => where.resolve(field(name))
  // Reading a workspace skill's file is running that skill.
  const read = (target: string) => {
    const skill = where.skills && workspaceSkill(where.skills, target)
    return skill ? check("skill", [skill]) : check("read", [target])
  }
  // The directory a call names to work in, as the tool resolves it.
  const elsewhere = async (name: string) => {
    const named = optional(name)
    return named === undefined ? {} : { directories: [await where.resolve(named)] }
  }
  const opaque = (code: string | undefined, extra: Partial<PolicyEvaluator.Input> = {}) =>
    check("shell", [code ?? ""], { opaque: true, ...extra })
  const subagent = async () =>
    check(
      "subagent",
      [(optional("agent_preset") ?? optional("name") ?? optional("runtime") ?? "general").toLowerCase()],
      await elsewhere("cwd"),
    )
  if (tool.startsWith("mcp__"))
    return mcpChecks(tool, where.servers ?? []).map((item) => check(item.action, item.resources, item))
  switch (tool) {
    case "bash":
    case "pwsh": {
      const workdir = optional("workdir")
      return [
        check("shell", [field("command")], {
          shell: tool === "pwsh" ? "pwsh" : "bash",
          path: workdir === undefined ? where.cwd : await where.resolve(workdir),
        }),
      ]
    }
    case "read":
    case "read_image":
    case "lsp":
      return [read(await file("file_path"))]
    case "write":
    case "edit":
      return [check("edit", [await file("file_path")])]
    case "apply_patch": {
      const targets = patchTargets(field("input"))
      if (targets.length === 0) throw new Unreadable("apply_patch's input names no file")
      return [check("edit", await Promise.all(targets.map(where.resolve)))]
    }
    case "str_replace_editor":
      return field("command") === "view" ? [read(await file("path"))] : [check("edit", [await file("path")])]
    case "glob":
    case "grep": {
      const searched = optional("path")
      return [
        check(tool, [field("pattern")], { path: searched === undefined ? where.cwd : await where.resolve(searched) }),
      ]
    }
    case "web_fetch":
      return [check("webfetch", [field("url")])]
    case "web_search": {
      const queries = Array.isArray(input.queries)
        ? input.queries.filter((query): query is string => typeof query === "string" && query !== "")
        : []
      const named = queries.length > 0 ? queries : [optional("query")].flatMap((query) => query ?? [])
      if (named.length === 0) throw new Unreadable("web_search's input has no queries")
      return [check("websearch", named)]
    }
    case "subagent":
    case "subagent_fork":
    case "spawn_teammate":
    case "ralph":
      return [await subagent()]
    case "subagent_oar":
      return [await subagent(), opaque(optional("prompt"))]
    case "workflow":
      // A workflow's script starts subagents of its own choosing, so any rule that could deny a subagent applies.
      return [opaque(optional("script")), check("subagent:", ["*"], { truncated: true })]
    case "run_code":
      return [opaque(optional("code"))]
    case "terminal_send":
      return [opaque(optional("text"))]
    case "terminal_open": {
      const cwd = optional("cwd")
      return [opaque(optional("type"), cwd === undefined ? {} : { path: await where.resolve(cwd) })]
    }
    case "ask_user_question":
      return [check("question", ["*"])]
    case "working_directory":
      return optional("cd") === undefined ? [] : [check("working_directory", ["*"], await elsewhere("cd"))]
    case "skill":
      return [check("skill", [field("name")])]
    case "read_mcp_resource":
    case "list_mcp_resources":
    case "list_mcp_resource_templates":
      return [check("mcp.use", [field("server")])]
    default:
      return [check(tool.toLowerCase(), ["*"])]
  }
}

// The slug of the workspace skill a file belongs to, when it's inside setup's skills folder.
function workspaceSkill(root: string, file: string) {
  const relative = path.relative(root, file)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined
  return relative.split(path.sep)[0]
}

/**
 * An MCP tool's checks. DeepSeek Harness names it `mcp__<server>__<tool>` verbatim when both are plain, and otherwise
 * replaces other characters with `_`, shortens it to 64 and appends a 12-digit hash (`@deepseek-ai/dsh-mcp-client`,
 * `publicToolName`). A plain name is the rule Console writes for it; a hashed one, whose tool isn't known, is denied
 * while any rule could deny one of the server's tools. The server is the longest of the workspace's servers that the
 * name starts with, since a server's name can hold `__` itself, else the name up to its first `__`.
 */
function mcpChecks(tool: string, servers: readonly string[]): PolicyEvaluator.Input[] {
  const known = servers.filter((server) => tool.startsWith(`mcp__${server}__`)).toSorted((a, b) => b.length - a.length)
  const server = known[0] ?? tool.match(/^mcp__(.+?)__./)?.[1]
  if (!server) throw new Unreadable(`Can't tell which MCP server ${tool} belongs to`)
  const rest = tool.slice(`mcp__${server}__`.length)
  return [
    { action: "mcp.use", resources: [server] },
    /_[0-9a-f]{12}$/.test(tool)
      ? { action: `${server}_`, resources: ["*"], truncated: true }
      : { action: `${server}_${rest}`, resources: ["*"] },
  ]
}

// The files an `apply_patch` names: every Add, Update, Delete and Move header (`@deepseek-ai/dsh-fs-patch`).
function patchTargets(patch: string) {
  return patch.split(/\r?\n/).flatMap((line) => {
    const header = line
      .trim()
      .match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/)?.[1]
      ?.trim()
    return header ? [header] : []
  })
}

/**
 * The skills a prompt runs by name, as DeepSeek Harness reads them (`@deepseek-ai/dsh-tool-skill`): a `/name` token in
 * a member's own message, wherever it sits.
 */
export function invokedSkills(messages: ReadonlyArray<{ readonly source?: unknown; readonly content?: unknown }>) {
  const names = messages.flatMap((message) =>
    SettingsFile.record(message.source).kind !== "user" || !Array.isArray(message.content)
      ? []
      : message.content.flatMap((block: unknown) => {
          const text = SettingsFile.record(block)
          return text.type === "text" && typeof text.text === "string"
            ? Array.from(text.text.matchAll(/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g), (match) => match[2]!)
            : []
        }),
  )
  return [...new Set(names)]
}

const MARKER_START = "# opencode-console:start"
const MARKER_END = "# opencode-console:end"

const ModelChoice = Schema.Struct({ provider: Schema.String, model: Schema.String })

/** What setup keeps about the DeepSeek Harness it set up, so later syncs update it and `--remove` undoes it. */
const Manifest = Schema.Struct({
  paths: Schema.Struct({ home: Schema.String, patch: Schema.String, skills: Schema.String }),
  /** The plugin file the patch loads, from the installed CLI. */
  plugin: Schema.String,
  /** DeepSeek Harness's own product token, `deepseek-harness/<version>`, which names it to the Console. */
  harness: Schema.optional(Schema.String),
  /** Whether setup created the patch file, so removing its rows can remove the file. */
  created: Schema.Boolean,
  /** The workspace skills setup wrote to DeepSeek Harness's skills folder, by slug, with the version written. */
  skills: Schema.Record(Schema.String, Schema.String),
  /** A fingerprint of the config's providers, and the routes and default model setup made of them. */
  providers: Schema.optional(Schema.String),
  /** The CLI version that made the routes. */
  cli: Schema.optional(Schema.String),
  routes: Schema.optional(Schema.Record(Schema.String, Route)),
  model: Schema.optional(Schema.NullOr(ModelChoice)),
})
export type Manifest = typeof Manifest.Type

export const manifestFile = (store: ConsoleStore.Info) => path.join(store.data, "deepseek-harness.json")

/**
 * What setup recorded, or undefined before it ran. A record it can't read throws, so setup never takes its own rows
 * for the member's.
 */
export function manifest(store: ConsoleStore.Info) {
  const file = manifestFile(store)
  const text = ConsoleStore.read(file)
  if (text === undefined) return undefined
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))(text))
  if (!decoded)
    throw new Error(`${file} can't be read, so DeepSeek Harness was left as it is. Delete it and run setup again.`)
  return decoded
}

/** What a sync made of DeepSeek Harness, for setup to report. */
export interface Applied {
  readonly routes: Readonly<Record<string, Route>>
  readonly model: { readonly provider: string; readonly model: string } | undefined
  readonly servers: readonly string[]
  readonly skills: readonly string[]
  readonly instructions: number
  /** Names setup left alone because the member already has their own skill, model routes or default model there. */
  readonly skipped: readonly string[]
  /** Profiles whose own model providers the workspace's routes stand in for while connected. */
  readonly shadowed: readonly string[]
}

/**
 * Points DeepSeek Harness at the workspace through its home patch layer: loads the plugin that checks policies and
 * answers the member's token, serves the workspace's models as model routes, starts new sessions on its default
 * model, connects its MCP servers, and writes its skills. Each run brings everything up to date with the
 * stored config and writes only what changed, so `sync` and the plugin run it after every fetch; it does nothing for a
 * member who never ran setup.
 */
export const refresh = Effect.fn("DeepSeekHarness.refresh")(function* (
  store: ConsoleStore.Info,
  setup?: { readonly paths: Paths; readonly plugin: string; readonly harness?: string | undefined },
) {
  const previous = manifest(store)
  const base = setup ?? previous
  if (!base) return undefined
  const credential = yield* ConsoleCredentials.fresh(store)
  const snapshot = credential && WorkspaceSync.current(store, ConsoleCredentials.owner(credential))
  if (!credential || !snapshot?.config) return undefined
  const config = snapshot.config
  const skills = WorkspaceSnapshot.skills(snapshot)
  const providers = createHash("sha256")
    .update(JSON.stringify(config.providers ?? null))
    .digest("hex")
  // A background sync reuses the routes setup last made while the config's providers are unchanged, and while this CLI
  // is the one that made them, since each route names its version in `x-opencode-plugin`.
  const reused =
    !setup && previous?.providers === providers && previous.cli === version && previous.routes !== undefined
  const document = reused ? undefined : yield* ConsoleClient.fetchModels(credential)
  const bundles = yield* Skill.fetchChanged(credential, base.paths.skills, skills, previous?.skills ?? {})
  return yield* ConsoleStore.locked(
    store,
    Effect.sync(() =>
      apply(store, {
        paths: base.paths,
        plugin: base.plugin,
        harness: setup ? setup.harness : previous?.harness,
        routes: document ? routes(document) : (previous?.routes ?? {}),
        model: document ? defaultModel(document) : (previous?.model ?? undefined),
        servers: WorkspaceSnapshot.servers(snapshot),
        instructions: WorkspaceSnapshot.instructions(snapshot).length,
        skills,
        bundles,
        providers,
      }),
    ),
  )
})

/** Undoes setup: takes its rows out of the patch layer, and deletes its skills. The sign-in stays. */
export function remove(store: ConsoleStore.Info) {
  const previous = manifest(store)
  if (!previous) return false
  const existing = ConsoleStore.read(previous.paths.patch)
  if (existing !== undefined) {
    const parts = sections(existing)
    // Setup put a blank line before a block it added at the end, which goes with it.
    const kept = parts.after === "" ? parts.before.replace(/\n+$/, "\n") : `${parts.before}${parts.after}`
    // A patch left with no rows gets back the empty list DeepSeek Harness writes in a patch it creates.
    const empty = kept.split("\n").every((line) => line.trim() === "" || line.trimStart().startsWith("#"))
    if (empty && previous.created) ConsoleStore.remove(previous.paths.patch)
    else if (parts.marked)
      SettingsFile.writeFile(
        previous.paths.patch,
        empty ? `${kept.trimEnd()}${kept.trim() === "" ? "" : "\n"}[]\n` : kept,
      )
  }
  Object.keys(previous.skills).forEach((slug) =>
    rmSync(path.join(previous.paths.skills, slug), { recursive: true, force: true }),
  )
  ConsoleStore.remove(SettingsFile.backupOf(previous.paths.patch))
  ConsoleStore.remove(manifestFile(store))
  return true
}

interface Desired {
  readonly paths: Paths
  readonly plugin: string
  readonly harness: string | undefined
  readonly routes: Readonly<Record<string, Route>>
  readonly model: { readonly provider: string; readonly model: string } | undefined
  readonly servers: Readonly<
    Record<string, { readonly url: string; readonly headers?: Readonly<Record<string, string>> | undefined }>
  >
  readonly instructions: number
  readonly skills: readonly Skill.Info[]
  readonly bundles: readonly Skill.Bundle[]
  readonly providers: string
}

function apply(store: ConsoleStore.Info, desired: Desired): Applied {
  // Everything is read before anything is written, so a file setup can't read leaves every file as it was.
  const previous = manifest(store)
  const existing = ConsoleStore.read(desired.paths.patch)
  const parts = sections(existing ?? "")
  const outside = listed(desired.paths.patch, parts)
  const created = previous?.created ?? existing === undefined
  const skipped: string[] = []
  // A row of the member's own that configures one of setup's rows stays theirs.
  const owns = (id: string) => {
    const theirs = outside.rows.some((row) => row.id === id && row.insert === undefined && row.config !== undefined)
    if (theirs) skipped.push(`the ${id} row in ${desired.paths.patch}`)
    return !theirs
  }
  // The server name goes into the row's config expression, so only the names DeepSeek Harness takes are used.
  const servers = Object.entries(desired.servers).filter(([name]) => /^[A-Za-z0-9_-]{1,32}$/.test(name))
  const routed = Object.keys(desired.routes).length > 0 && owns("llm-pi-ai")
  const model = routed && desired.model && owns("agent-default-model") ? desired.model : undefined
  const rows = [
    {
      insert: [
        { id: "opencode-console", name: desired.plugin, isolate: { credentials: REALM } },
        ...servers.map(([name]) => ({
          id: `opencode-console-mcp-${name}`,
          name: "@deepseek-ai/dsh-mcp-client",
          inject: [MCP_SERVICE],
          // Written as the expression that reads the server's config from the plugin when the row starts.
          config: `__opencode_console_mcp__:${name}`,
        })),
      ],
    },
    // The agent loop waits for the plugin, so DeepSeek Harness runs no agent at all when the plugin can't load. A patch
    // row's `inject` replaces the one before it, so the member's own services for the loop are kept beside it.
    { id: "agent-loop", inject: inject(outside.rows) },
    ...(routed ? [{ id: "llm-pi-ai", isolate: { credentials: REALM }, config: { providers: desired.routes } }] : []),
    ...(model ? [{ id: "agent-default-model", config: model }] : []),
  ]
  const block = [
    `${MARKER_START} (written by \`npx @opencode/console setup deepseek-harness\`, which replaces this block on every sync; --remove takes it out)`,
    ...rows.map(
      (row) =>
        `- ${JSON.stringify(row).replace(/"config":"__opencode_console_mcp__:([A-Za-z0-9_-]+)"/g, (_match, name: string) => `"config": !!js "ctx.${MCP_SERVICE}.server('${name}')"`)}`,
    ),
    MARKER_END,
  ].join("\n")
  // The block stays where it is in the patch, or goes after the member's rows the first time.
  const next = parts.marked
    ? `${outside.before}${block}\n${parts.after}`
    : `${[outside.before.trimEnd(), block].filter((part) => part !== "").join("\n\n")}\n`
  if (patchRows(desired.paths.patch, next).length !== outside.rows.length + rows.length)
    throw new Error(
      `${desired.paths.patch} couldn't take setup's rows, so it was left alone. Fix it and run setup again.`,
    )
  if (!previous) SettingsFile.backup(desired.paths.patch)
  if (next !== existing) SettingsFile.writeFile(desired.paths.patch, next, 0o600)

  // Workspace skills, in DeepSeek Harness's own skills folder. A skill the member wrote under the same slug stays.
  const synced = Skill.write(desired.paths.skills, desired.skills, desired.bundles, previous?.skills ?? {}, {
    named: true,
  })
  skipped.push(...synced.skipped)

  ConsoleStore.write(
    manifestFile(store),
    JSON.stringify(
      Manifest.make({
        paths: desired.paths,
        plugin: desired.plugin,
        ...(desired.harness === undefined ? {} : { harness: desired.harness }),
        created,
        skills: synced.skills,
        providers: desired.providers,
        cli: version,
        routes: { ...desired.routes },
        model: desired.model ?? null,
      }),
    ),
  )
  return {
    routes: routed ? desired.routes : {},
    model,
    servers: servers.map(([name]) => name),
    skills: Object.keys(synced.skills),
    instructions: desired.instructions,
    skipped,
    shadowed: routed ? shadowed(desired.paths.home) : [],
  }
}

const jsTag = { tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }

// The patch around setup's block: what comes before and after it, and whether it's there.
function sections(text: string) {
  const match = text.match(new RegExp(`^${MARKER_START}[^\\n]*\\n[\\s\\S]*?^${MARKER_END}[^\\n]*(?:\\n|$)`, "m"))
  if (!match || match.index === undefined) return { before: text, after: "", marked: false }
  return { before: text.slice(0, match.index), after: text.slice(match.index + match[0].length), marked: true }
}

/**
 * A patch's rows, parsed as DeepSeek Harness's config editor parses one (`!!js` expressions read as their text). A
 * patch that isn't YAML or isn't a list is the member's to fix, so this throws rather than read it.
 */
function patchRows(file: string, text: string) {
  const document = parseDocument(text, { customTags: [jsTag] })
  // DeepSeek Harness refuses a tag it doesn't know, which `yaml` only warns about.
  if (document.errors.length > 0 || document.warnings.length > 0)
    throw new Error(`${file} isn't YAML DeepSeek Harness reads, so it was left alone. Fix it and run setup again.`)
  const contents: unknown = document.toJS()
  if (contents === null || contents === undefined) return []
  if (!Array.isArray(contents))
    throw new Error(`${file} isn't a YAML list of patch rows, so it was left alone. Fix it and run setup again.`)
  return contents.map((row: unknown) => SettingsFile.record(row))
}

/**
 * The member's part of the patch, which setup adds its rows to, and their rows. Setup's rows go in a block list, so a
 * flow list (`[...]`) can't take them, except the empty one DeepSeek Harness writes in a patch it creates, which gives
 * way to them.
 */
function listed(file: string, parts: { readonly before: string; readonly after: string }) {
  const text = `${parts.before}${parts.after}`
  const rows = patchRows(file, text)
  const contents = parseDocument(text, { customTags: [jsTag] }).contents
  if (!isSeq(contents) || !contents.flow) return { rows, before: parts.before }
  if (rows.length > 0)
    throw new Error(`${file} lists its rows in flow style ([...]), so it was left alone. Write them as a block list.`)
  return { rows, before: parts.before.replace(/^\s*\[\s*\][ \t]*\n?/m, "") }
}

// The services the agent loop waits for: the plugin's, beside any the member's own rows name.
function inject(rows: ReadonlyArray<Record<string, unknown>>) {
  const theirs = rows.filter((row) => row.id === "agent-loop" && row.insert === undefined).map((row) => row.inject)
  const named = theirs.flatMap((value) =>
    Array.isArray(value)
      ? value.filter((name): name is string => typeof name === "string")
      : Object.keys(SettingsFile.record(value)),
  )
  return [...new Set([...named, SERVICE])]
}

// The profiles that configure their own model providers (`llm-pi-ai`), which the workspace's routes replace while
// DeepSeek Harness is connected; `--remove` gives them back. Only profile folders are read, not dot folders or a
// stray `node_modules`, and a patch that can't be read is skipped.
function shadowed(home: string) {
  const profiles = path.join(home, "profiles")
  if (!existsSync(profiles)) return []
  return readdirSync(profiles, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => entry.name)
    .filter((name) => {
      const file = path.join(profiles, name, "cordis.patch.yml")
      return Effect.runSync(
        Effect.try(() =>
          patchRows(file, ConsoleStore.read(file) ?? "").some(
            (row) => row.id === "llm-pi-ai" && row.insert === undefined && row.config !== undefined,
          ),
        ).pipe(Effect.orElseSucceed(() => false)),
      )
    })
}
