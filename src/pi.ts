export * as Pi from "./pi"

import { createHash } from "node:crypto"
import { rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Api, Model } from "@earendil-works/pi-ai"
import { Effect, Option, Schema } from "effect"
import { version } from "../package.json" with { type: "json" }
import { ConsoleClient } from "./console-client"
import { ConsoleCredentials } from "./credentials"
import { InProcess } from "./in-process"
import type { PolicyEvaluator } from "./policy-evaluator"
import { SettingsFile } from "./settings-file"
import { Skill } from "./skill"
import { WorkspaceSnapshot } from "./snapshot"
import { ConsoleStore } from "./store"
import { WorkspaceModels } from "./workspace-models"

/**
 * Where Pi keeps the settings setup changes (pi.dev/docs/latest/settings): its agent directory, `~/.pi/agent`, or
 * `PI_CODING_AGENT_DIR`.
 */
export interface Paths {
  readonly agent: string
  readonly settings: string
}

export function paths(env: Record<string, string | undefined> = process.env, home = os.homedir()): Paths {
  const named = env.PI_CODING_AGENT_DIR?.trim()
  const agent = named
    ? path.resolve(named === "~" ? home : named.startsWith("~/") ? path.join(home, named.slice(2)) : named)
    : path.join(home, ".pi", "agent")
  return { agent, settings: path.join(agent, "settings.json") }
}

/** A provider the workspace serves through the gateway, as Pi registers it. */
export interface Provider {
  readonly id: string
  readonly name: string
  readonly models: readonly Model<Api>[]
}

/** A model Pi already knows in the same protocol, such as Zen's own, whose protocol settings carry over. */
export type Builtin = (provider: string, id: string, api: Api) => Model<Api> | undefined

/**
 * The workspace's chat models as Pi providers, one per provider config gives them: `opencode`, `opencode-go` and
 * `console-<slug>`, each model at the Console URL that serves it in its own protocol. A model Pi ships for the same
 * provider keeps Pi's protocol settings (thinking levels, compatibility flags); the Console's name, limits and price
 * win over Pi's.
 */
export function providers(document: ConsoleClient.ModelsDocument, builtin: Builtin): Provider[] {
  const grouped = Map.groupBy(
    WorkspaceModels.list(document).flatMap((listed) => model(listed, builtin) ?? []),
    (item) => item.provider,
  )
  return [...grouped].map(([id, models]) => ({ id, name: document[id]?.name ?? id, models }))
}

/** The model a new Pi session starts on: the newest Claude Sonnet the member may use, else the nearest, else the first. */
export function defaultModel(document: ConsoleClient.ModelsDocument) {
  const listed = WorkspaceModels.list(document).filter((item) => route(item) !== undefined)
  const picked = WorkspaceModels.newest(listed, "sonnet", "opus", "haiku")
  return picked && { provider: picked.provider, id: picked.id }
}

// The protocols the gateway serves a chat model in, by models.dev's name, as Pi's API implementations call them.
const protocols = {
  messages: "anthropic-messages",
  responses: "openai-responses",
  "chat-completions": "openai-completions",
  "generate-content": "google-generative-ai",
} as const

// The first protocol Pi speaks that the gateway serves the model in, and where.
function route(listed: WorkspaceModels.Listed) {
  const apis = SettingsFile.record(listed.entry.api)
  const protocol = Object.keys(protocols).find((key): key is keyof typeof protocols => key in apis)
  const baseURL = protocol && SettingsFile.text(SettingsFile.record(apis[protocol]).base_url)
  return protocol && baseURL ? { api: protocols[protocol], baseURL } : undefined
}

function model(listed: WorkspaceModels.Listed, builtin: Builtin): Model<Api> | undefined {
  const served = route(listed)
  if (!served) return undefined
  const api = served.api
  const known = builtin(listed.provider, listed.id, api)
  const base = known?.api === api ? known : undefined
  const entry = listed.entry
  const limit = SettingsFile.record(entry.limit)
  // models.dev v2 prices text per million tokens: `cost.text.input.price`, its cache reads and writes, and output.
  const text = SettingsFile.record(SettingsFile.record(entry.cost).text)
  const input = SettingsFile.record(text.input)
  const cache = SettingsFile.record(input.cache)
  const inputs = SettingsFile.record(entry.modalities).input
  const reasoning = SettingsFile.record(SettingsFile.record(entry.capabilities).reasoning).supported
  return {
    ...(api === "openai-completions" ? { compat: gatewayChat } : {}),
    ...base,
    id: listed.id,
    name: SettingsFile.text(entry.name) ?? base?.name ?? listed.id,
    api,
    provider: listed.provider,
    // Pi's Anthropic client adds `/v1/messages` itself.
    baseUrl: api === "anthropic-messages" ? served.baseURL.replace(/\/v1\/?$/, "") : served.baseURL,
    reasoning: typeof reasoning === "boolean" ? reasoning : (base?.reasoning ?? false),
    input: Array.isArray(inputs)
      ? inputs.some((kind) => typeof kind === "string" && kind.startsWith("image"))
        ? ["text", "image"]
        : ["text"]
      : (base?.input ?? ["text"]),
    cost: {
      input: number(input.price) ?? base?.cost.input ?? 0,
      output: number(SettingsFile.record(text.output).price) ?? base?.cost.output ?? 0,
      cacheRead: number(cache.read) ?? base?.cost.cacheRead ?? 0,
      cacheWrite:
        number(first(cache.write)) ??
        number(first(SettingsFile.record(cache.explicit).write)) ??
        base?.cost.cacheWrite ??
        0,
    },
    contextWindow: number(limit.context) ?? base?.contextWindow ?? 128_000,
    maxTokens: number(limit.output) ?? base?.maxTokens ?? 16_384,
    // Names the extension to the Console on every request, as `x-opencode-plugin` does for Claude Code.
    headers: { ...base?.headers, "x-opencode-plugin": `opencode-console/${version}` },
  }
}

// What Pi sets for OpenCode's own Chat Completions models, which reach the same gateway.
const gatewayChat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsStrictMode: true,
  maxTokensField: "max_tokens",
} as const

// A cache write priced per retention (`{ "5m": 3.75, "1h": 6 }`) takes the first, as Console's own catalog does.
function first(value: unknown) {
  return typeof value === "object" && value !== null ? Object.values(value)[0] : value
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** A tool call or command that can't be turned into checks, which the extension blocks rather than let through. */
export class Unreadable extends Error {}

/** Where a Pi tool call runs, and what the extension knows about the tools around it. */
export interface Where {
  readonly cwd: string
  /** The MCP server the called tool belongs to, when Pi says (the tool's namespace). */
  readonly server?: string | undefined
  /** Every MCP server Pi knows, for a resource listing that names none. */
  readonly servers?: readonly string[] | undefined
  /** The folder the extension writes the workspace's skills to, whose files Pi reads to run a skill. */
  readonly skills?: string | undefined
  readonly home?: string | undefined
}

/**
 * The checks a Pi tool call needs, in OpenCode's permission vocabulary, all of which must allow it. Pi's built-in
 * tools (pi.dev/docs/latest/extensions, "Overriding Built-in Tools") map to the permission OpenCode's own tool asks
 * for: bash and powershell to `shell`, write and edit to `edit`, read and ls to `read`, grep to `grep` and find to
 * `glob`, with paths read as Pi reads them. Reading a workspace skill's file is running that skill. An MCP tool
 * (`mcp__<server>__<tool>`) is its server's `mcp.use` and the tool's `<server>_<tool>` permission; Pi's MCP resource
 * tools are the server's `mcp.use`. Any other tool is checked by its lowercased name.
 */
export function checks(
  call: { readonly toolName: string; readonly input: Record<string, unknown> },
  where: Where,
): PolicyEvaluator.Input[] {
  const check = (action: string, resources: readonly string[], extra: Partial<PolicyEvaluator.Input> = {}) => ({
    action,
    resources,
    directory: where.cwd,
    ...extra,
  })
  const tool = call.toolName
  const optional = (name: string) => {
    const value = call.input[name]
    return typeof value === "string" && value !== "" ? value : undefined
  }
  const field = (name: string) => {
    const value = optional(name)
    if (value === undefined) throw new Unreadable(`${tool}'s input has no ${name}`)
    return value
  }
  const home = where.home ?? os.homedir()
  const file = (name: string) => piPath(field(name), home)
  if (tool.startsWith("mcp__"))
    return mcpChecks(tool, where.server).map((item) => check(item.action, item.resources, item))
  switch (tool) {
    case "bash":
      return [check("shell", [field("command")], { shell: "bash" })]
    case "powershell":
      return [check("shell", [field("command")], { shell: "pwsh" })]
    case "read": {
      const target = file("path")
      const skill = where.skills && workspaceSkill(where.skills, path.resolve(where.cwd, target))
      return [skill ? check("skill", [skill]) : check("read", [target])]
    }
    case "write":
    case "edit":
      return [check("edit", [file("path")])]
    case "ls":
      return [check("read", [piPath(optional("path") ?? ".", home)])]
    case "grep":
    case "find": {
      const searched = optional("path")
      return [
        check(
          tool === "find" ? "glob" : "grep",
          [field("pattern")],
          searched === undefined ? {} : { path: piPath(searched, home) },
        ),
      ]
    }
    case "read_mcp_resource":
      return [check("mcp.use", [field("server")])]
    case "list_mcp_resources":
    case "list_mcp_resource_templates": {
      const server = optional("server")
      const known = where.servers ?? []
      return [check("mcp.use", server ? [server] : known.length > 0 ? known : ["*"])]
    }
    default:
      return [check(tool.toLowerCase(), ["*"])]
  }
}

/**
 * A path as Pi's file tools read it (`resolveToCwd`): Unicode spaces as plain ones, without a leading `@`, `~` as the
 * home directory, and a `file://` URL as its path. A URL that names no local file throws, which blocks the call.
 */
function piPath(input: string, home: string) {
  const spaced = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
  const bare = spaced.startsWith("@") ? spaced.slice(1) : spaced
  const expanded = bare === "~" ? home : bare.startsWith("~/") ? path.join(home, bare.slice(2)) : bare
  return expanded.startsWith("file://") ? fileURLToPath(expanded) : expanded
}

// The slug of the workspace skill a file belongs to, when it's inside the extension's skills folder.
function workspaceSkill(root: string, file: string) {
  const relative = path.relative(path.resolve(root), file)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined
  return relative.split(path.sep)[0]
}

/**
 * An MCP tool's checks. Pi names it `mcp__<server>__<tool>` with every character but letters, digits and `_` as `_`,
 * and shortens a name past 64 characters, or one two tools share, to its start and a hash. Console names a tool rule
 * `<server>_<tool>` keeping `-`, so the tool is matched with `-` and `_` alike, and a shortened one, whose name isn't
 * known, is denied while any rule could deny one of the server's tools. The server's `mcp.use` is always checked.
 */
function mcpChecks(tool: string, named: string | undefined): PolicyEvaluator.Input[] {
  const prefix = named && `mcp__${named.replace(/[^A-Za-z0-9_]/g, "_")}__`
  const split = tool.match(/^mcp__(.+?)__(.+)$/)
  const server = named ?? split?.[1]
  if (!server) throw new Unreadable(`Can't tell which MCP server ${tool} belongs to`)
  const rest = prefix && tool.startsWith(prefix) ? tool.slice(prefix.length) : named ? undefined : split?.[2]
  const exact = named !== undefined
  const shortened = rest === undefined || /_[0-9a-f]{8}$/.test(tool)
  return [
    { action: "mcp.use", resources: [server], ...(exact ? {} : { folded: true }) },
    shortened
      ? { action: `${server}_`, resources: ["*"], truncated: true, folded: true }
      : { action: `${server}_${rest}`, resources: ["*"], folded: true },
  ]
}

/** A `!cmd` or `!!cmd` the member runs in Pi, checked as OpenCode checks a shell command. */
export function userBash(event: { readonly command: string; readonly cwd: string }): PolicyEvaluator.Input {
  return { action: "shell", resources: [event.command], directory: event.cwd, shell: "bash" }
}

/** The skill a prompt runs with `/skill:<name>`, checked before Pi expands it. */
export function skillCommand(text: string) {
  return text.match(/^\/skill:([^\s]+)/)?.[1]
}

/** What setup keeps about the Pi it set up, so `--remove` undoes it. */
const Manifest = Schema.Struct({
  paths: Schema.Struct({ agent: Schema.String, settings: Schema.String }),
  /** The extension file setup listed in Pi's `extensions` setting. */
  extension: Schema.String,
  /** Whether setup created Pi's settings file, so removing an empty one removes it. */
  created: Schema.Boolean,
  ...SettingsFile.OwnedFields,
})
export type Manifest = typeof Manifest.Type

export const manifestFile = (store: ConsoleStore.Info) => path.join(store.data, "pi.json")

/** Where the extension keeps what it writes for Pi: the workspace's skills and the record of their versions. */
export const directory = (store: ConsoleStore.Info) => path.join(store.data, "pi")

/** The Console's models for Pi, cached per sign-in until the config's providers change. */
export const modelsFile = (store: ConsoleStore.Info) => path.join(store.cache, "pi-models.json")

/**
 * What setup recorded, or undefined before it ran. A record it can't read throws, so setup never records its own
 * values as the member's.
 */
export function manifest(store: ConsoleStore.Info) {
  const file = manifestFile(store)
  const text = ConsoleStore.read(file)
  if (text === undefined) return undefined
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))(text))
  if (!decoded) throw new Error(`${file} can't be read, so Pi was left as it is. Delete it and run setup again.`)
  return decoded
}

/**
 * Loads the extension in Pi: lists `extension` in Pi's `extensions` setting beside the member's own, replacing the
 * one an earlier setup listed, and starts new sessions on `model` (Pi's `defaultProvider` and `defaultModel`). The
 * settings file is read before anything is written and never written over when it isn't JSON; the first run keeps a
 * backup of it.
 */
export function setup(
  store: ConsoleStore.Info,
  input: { readonly paths: Paths; readonly extension: string; readonly model?: { provider: string; id: string } },
) {
  const previous = manifest(store)
  const created = previous?.created ?? ConsoleStore.read(input.paths.settings) === undefined
  const settings = SettingsFile.read(input.paths.settings) ?? {}
  if (!previous) SettingsFile.backup(input.paths.settings)
  const listed = Array.isArray(settings.extensions) ? settings.extensions : []
  settings.extensions = [
    ...listed.filter((item) => item !== previous?.extension && item !== input.extension),
    input.extension,
  ]
  const owned = SettingsFile.apply(
    settings,
    input.model ? { defaultProvider: input.model.provider, defaultModel: input.model.id } : {},
    previous,
    true,
  )
  SettingsFile.write(input.paths.settings, settings, 0o600)
  ConsoleStore.write(
    manifestFile(store),
    JSON.stringify(Manifest.make({ paths: input.paths, extension: input.extension, created, ...owned })),
  )
}

/**
 * Keeps Pi loading the installed extension once an update moved it: lists `extension` in Pi's settings in place of the
 * one setup listed, leaving the member's default model and other extensions as they are. Returns whether it changed
 * anything; a Pi setup never connected, or one already listing `extension`, is left alone.
 */
export function refresh(store: ConsoleStore.Info, extension: string) {
  const previous = manifest(store)
  if (!previous || previous.extension === extension) return false
  const settings = SettingsFile.read(previous.paths.settings)
  if (!settings) return false
  const listed = Array.isArray(settings.extensions) ? settings.extensions : []
  settings.extensions = [...listed.filter((item) => item !== previous.extension && item !== extension), extension]
  SettingsFile.write(previous.paths.settings, settings, 0o600)
  ConsoleStore.write(manifestFile(store), JSON.stringify(Manifest.make({ ...previous, extension })))
  return true
}

/**
 * Undoes setup: takes the extension out of Pi's settings, puts back the default model unless the member changed it
 * since, and deletes what the extension wrote for Pi. The sign-in stays.
 */
export function remove(store: ConsoleStore.Info) {
  const previous = manifest(store)
  if (!previous) return false
  const settings = SettingsFile.read(previous.paths.settings)
  if (settings) {
    const listed = Array.isArray(settings.extensions) ? settings.extensions : []
    const kept = listed.filter((item) => item !== previous.extension)
    if (kept.length > 0) settings.extensions = kept
    else delete settings.extensions
    Object.keys(previous.originals).forEach((key) => SettingsFile.restore(settings, key, previous))
    if (Object.keys(settings).length === 0 && previous.created) ConsoleStore.remove(previous.paths.settings)
    else SettingsFile.write(previous.paths.settings, settings)
  }
  ConsoleStore.remove(SettingsFile.backupOf(previous.paths.settings))
  rmSync(directory(store), { recursive: true, force: true })
  ConsoleStore.remove(modelsFile(store))
  ConsoleStore.remove(manifestFile(store))
  return true
}

const ModelsCache = Schema.Struct({
  owner: Schema.String,
  providers: Schema.String,
  document: Schema.Record(Schema.String, Schema.Unknown),
})
const Document = Schema.Record(
  Schema.String,
  Schema.Struct({
    name: Schema.optional(Schema.String),
    models: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
  }),
)

/**
 * The member's models (`GET /api/v1/models`), asked for again only when the config's providers change, so Pi starts
 * without a request for them on most launches.
 */
export async function models(state: InProcess.Session): Promise<ConsoleClient.ModelsDocument | undefined> {
  const credential = ConsoleCredentials.read(state.store)
  const snapshot = await InProcess.config(state)
  if (!credential || !snapshot?.config) return undefined
  const owner = ConsoleCredentials.owner(credential)
  const providers = createHash("sha256")
    .update(JSON.stringify(snapshot.config.providers ?? null))
    .digest("hex")
  const cached = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(ModelsCache))(ConsoleStore.read(modelsFile(state.store)) ?? ""),
  )
  const reused = cached?.owner === owner && cached.providers === providers ? cached.document : undefined
  const decoded = reused && Option.getOrUndefined(Schema.decodeUnknownOption(Document)(reused))
  if (decoded) return decoded
  const document = await state.run(ConsoleClient.fetchModels(credential))
  ConsoleStore.write(modelsFile(state.store), JSON.stringify({ owner, providers, document }))
  return document
}

const Versions = Schema.Record(Schema.String, Schema.String)

/**
 * Brings the workspace's skills up to date in the extension's own skills folder, which Pi loads beside the member's
 * skills, and returns that folder.
 */
export async function skills(state: InProcess.Session) {
  const credential = ConsoleCredentials.read(state.store)
  const snapshot = await InProcess.config(state)
  const folder = path.join(directory(state.store), "skills")
  const record = path.join(directory(state.store), "skills.json")
  if (!credential || !snapshot?.config) return folder
  const wanted = WorkspaceSnapshot.skills(snapshot)
  const known = Option.getOrElse(
    Schema.decodeUnknownOption(Schema.fromJsonString(Versions))(ConsoleStore.read(record) ?? ""),
    () => ({}),
  )
  const bundles = await state.run(Skill.fetchChanged(credential, folder, wanted, known))
  await Effect.runPromise(
    ConsoleStore.locked(
      state.store,
      Effect.sync(() => {
        ConsoleStore.ensureDir(folder)
        ConsoleStore.write(record, JSON.stringify(Skill.write(folder, wanted, bundles, known).skills))
      }),
    ),
  )
  return folder
}
