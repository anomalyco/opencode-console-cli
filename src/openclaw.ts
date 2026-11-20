export * as OpenClaw from "./openclaw"

import { createHash } from "node:crypto"
import { rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { applyEdits, type FormattingOptions, modify, type ParseError, parse, printParseErrorCode } from "jsonc-parser"
import { version } from "../package.json" with { type: "json" }
import { ConsoleClient } from "./console-client"
import { ConsoleCredentials } from "./credentials"
import type { HooksCheck } from "./hooks-check"
import { Instruction } from "./instruction"
import { SettingsFile } from "./settings-file"
import { Skill } from "./skill"
import { WorkspaceSnapshot } from "./snapshot"
import { ConsoleStore } from "./store"
import { WorkspaceModels } from "./workspace-models"
import { WorkspaceSync } from "./workspace-sync"

/**
 * Where an OpenClaw install keeps what setup changes, resolved as OpenClaw 2026.11.5 resolves them
 * (`src/config/paths.ts`, `src/config/state-dir.ts`, `src/agents/workspace-default-path.ts`): its state directory, its
 * `openclaw.json`, and the default agent's workspace, whose `AGENTS.md` every session of that agent loads.
 */
export interface Paths {
  readonly state: string
  readonly config: string
  /** The workspace OpenClaw falls back to when `openclaw.json` names none. */
  readonly workspace: string
}

/** A profile name as OpenClaw accepts one (`src/cli/profile-utils.ts`). */
export const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/**
 * The install setup connects: `--profile <name>` is `~/.openclaw-<name>` with its own `openclaw.json`, as
 * `openclaw --profile <name>` switches both; otherwise `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH`, else the
 * `OPENCLAW_PROFILE` OpenClaw itself would use, else `~/.openclaw`.
 */
export function paths(
  input: {
    readonly profile?: string | undefined
    readonly env?: Record<string, string | undefined>
    readonly home?: string
  } = {},
): Paths {
  const env = input.env ?? process.env
  const user = input.home ?? (env.OPENCLAW_HOME?.trim() || os.homedir())
  const resolve = (value: string) =>
    path.resolve(value === "~" ? user : value.startsWith("~/") ? path.join(user, value.slice(2)) : value)
  if (input.profile !== undefined && !PROFILE.test(input.profile))
    throw new Error(`Not an OpenClaw profile name: ${input.profile}`)
  const named = (profile: string | undefined) =>
    profile === undefined || profile.toLowerCase() === "default" ? undefined : profile
  if (input.profile !== undefined) {
    const profile = named(input.profile)
    const state = profile ? path.join(user, `.openclaw-${profile}`) : path.join(user, ".openclaw")
    return { state, config: path.join(state, "openclaw.json"), workspace: path.join(state, "workspace") }
  }
  const inherited = named(env.OPENCLAW_PROFILE?.trim() || undefined)
  const override = env.OPENCLAW_STATE_DIR?.trim()
  const state = override
    ? resolve(override)
    : inherited && PROFILE.test(inherited)
      ? path.join(user, `.openclaw-${inherited}`)
      : path.join(user, ".openclaw")
  const config = env.OPENCLAW_CONFIG_PATH?.trim()
  const workspace = env.OPENCLAW_WORKSPACE_DIR?.trim()
  return {
    state,
    config: config ? resolve(config) : path.join(state, "openclaw.json"),
    workspace: workspace ? resolve(workspace) : path.join(state, "workspace"),
  }
}

/** The model provider setup adds under `models.providers`, which sessions use as `opencode-console/<model>`. */
export const PROVIDER = "opencode-console"
/** The plugin's id, its entry under `plugins.entries`, and the provider it registers. */
export const PLUGIN = "opencode-console"
/**
 * The non-secret `apiKey` OpenClaw needs before it asks the plugin for a request's credential: the plugin's
 * `prepareRuntimeAuthV2` replaces it with a token from `token --json` on every request.
 */
export const KEY_MARKER = "opencode-console-cli"

/** Where setup writes one install's plugin and workspace skills, keyed by its `openclaw.json`. */
export function directory(store: ConsoleStore.Info, config: string) {
  return path.join(store.data, "openclaw", createHash("sha256").update(path.resolve(config)).digest("hex").slice(0, 16))
}
export const pluginDirectory = (store: ConsoleStore.Info, config: string) =>
  path.join(directory(store, config), "plugin")
export const skillsDirectory = (store: ConsoleStore.Info, config: string) =>
  path.join(directory(store, config), "skills")

/** The OpenClaw auth profile a gateway MCP server's bearer comes from, which the plugin serves from memory. */
export const authProfile = (server: string) => `${PROVIDER}:${server}`

/** The variable `mcp-env` names a gateway MCP server's Authorization header by. */
export function headerVariable(server: string) {
  return `OPENCODE_CONSOLE_MCP_${`${server}_Authorization`.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
}

/** One model in `models.providers.opencode-console.models`, in OpenClaw's model shape. */
export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  contextWindow: Schema.optional(Schema.Number),
  maxTokens: Schema.optional(Schema.Number),
  input: Schema.optional(Schema.Array(Schema.String)),
})
export type Model = typeof Model.Type

/** The workspace's models as one OpenClaw model provider on the gateway's OpenAI Responses endpoint. */
export const Provider = Schema.Struct({ baseUrl: Schema.String, model: Schema.String, models: Schema.Array(Model) })
export type Provider = typeof Provider.Type

/**
 * The chat models the member may use, by gateway ID (OpenCode's by their own IDs, then `opencode-go/<id>`, then
 * `console-<slug>/<id>`), all on the gateway's `/openai/v1`, which routes every one, and the newest Claude Sonnet as the
 * default (else the nearest family, else the first model). Undefined without any. OpenClaw's `openai-responses`
 * adapter is the one protocol every model behind the gateway answers.
 */
export function provider(document: ConsoleClient.ModelsDocument): Provider | undefined {
  const listed = WorkspaceModels.list(document)
  const root = WorkspaceModels.inferenceRoot(listed)
  const picked = WorkspaceModels.newest(listed, "sonnet", "opus", "haiku")
  if (root === undefined || picked === undefined) return undefined
  const id = (model: WorkspaceModels.Listed) =>
    model.provider === "opencode" ? model.id : `${model.provider}/${model.id}`
  const positive = (value: unknown) => (typeof value === "number" && value > 0 ? value : undefined)
  return {
    baseUrl: `${root}/openai/v1`,
    model: id(picked),
    models: listed.map((model) => {
      const limit = SettingsFile.record(model.entry.limit)
      const input = SettingsFile.record(model.entry.modalities).input
      const name = SettingsFile.text(model.entry.name) ?? model.id
      const context = positive(limit.context)
      const output = positive(limit.output)
      // models.dev names image input by type (`image/png`); OpenClaw takes `text` and `image`.
      const listed = Array.isArray(input) ? input.filter((kind): kind is string => typeof kind === "string") : []
      const kinds = [
        ...(listed.includes("text") ? ["text"] : []),
        ...(listed.some((kind) => kind === "image" || kind.startsWith("image/")) ? ["image"] : []),
      ]
      return {
        id: id(model),
        name: model.provider === "opencode" ? name : `${name} (${model.providerName ?? model.provider})`,
        ...(context === undefined ? {} : { contextWindow: context }),
        ...(output === undefined ? {} : { maxTokens: output }),
        ...(kinds.length === 0 ? {} : { input: kinds }),
      }
    }),
  }
}

/**
 * A workspace MCP server as setup writes it. A gateway server's only header is its `Authorization: Bearer ocgw_…`,
 * which OpenClaw takes from the plugin's in-memory auth profile; a direct server signs in with OpenClaw's own MCP
 * OAuth. A server with any other header can't be written without its secret, since OpenClaw 2026.11.5's
 * `mcp.servers.*.headers` takes no SecretRef, so it's skipped.
 */
export function serverEntry(
  name: string,
  server: { readonly url: string; readonly headers?: Readonly<Record<string, string>> | undefined },
) {
  const headers = Object.keys(server.headers ?? {})
  if (headers.length > 0 && !(headers.length === 1 && headers[0]!.toLowerCase() === "authorization")) return undefined
  return {
    url: server.url,
    transport: "streamable-http",
    auth: "oauth",
    ...(headers.length === 0 ? {} : { oauth: { authProfileId: authProfile(name) } }),
  }
}

// The server name becomes an `mcp.servers` key, an auth profile id and part of tool names, so only plain names are used.
function usable(name: string) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name)
}

const Install = Schema.Struct({
  paths: Schema.Struct({ state: Schema.String, config: Schema.String, workspace: Schema.String }),
  /** The command that runs the installed CLI, and the environment it finds the sign-in by. */
  command: Schema.Array(Schema.String),
  environment: Schema.Record(Schema.String, Schema.String),
  /** OpenClaw's own product token, `openclaw/<release>`, which names it to the Console. */
  harness: Schema.optional(Schema.String),
  /** `agents.defaults.model.primary`, with the value it had before, and what setup last wrote. */
  ...SettingsFile.OwnedFields,
  /** Whether setup wrote `models.providers.opencode-console`. */
  provider: Schema.Boolean,
  servers: Schema.Array(Schema.String),
  skills: Schema.Record(Schema.String, Schema.String),
  /** The `AGENTS.md` setup wrote the workspace's instructions to. */
  instructions: Schema.String,
  /** What setup created, so removing what it added there removes the file or list too. */
  created: Schema.Struct({
    config: Schema.Boolean,
    instructions: Schema.Boolean,
    loadPaths: Schema.Boolean,
    extraDirs: Schema.Boolean,
  }),
  /** A fingerprint of the config's providers, and the provider setup made of them, reused while they're unchanged. */
  providers: Schema.optional(Schema.String),
  models: Schema.optional(Schema.NullOr(Provider)),
  keepProvider: Schema.optional(Schema.Boolean),
})
type Install = typeof Install.Type

/** What setup keeps about each OpenClaw install it set up, by its `openclaw.json`, so syncs update each. */
const Manifest = Schema.Struct({ profiles: Schema.Record(Schema.String, Install) })
export type Manifest = typeof Manifest.Type

export const manifestFile = (store: ConsoleStore.Info) => path.join(store.data, "openclaw.json")

/**
 * What setup recorded, or undefined before it ran. A record it can't read throws, so setup never takes its own values
 * for the member's.
 */
export function manifest(store: ConsoleStore.Info) {
  const file = manifestFile(store)
  const text = ConsoleStore.read(file)
  if (text === undefined) return undefined
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))(text))
  if (!decoded) throw new Error(`${file} can't be read, so OpenClaw was left as it is. Delete it and run setup again.`)
  return decoded
}

/**
 * Whether OpenClaw is keeping setup's plugin from running: plugins turned off, the plugin's entry disabled, denied or
 * left out of a `plugins.allow` list, its load path gone, or its files gone, which the next sync writes back.
 */
export function hooksOff(store: ConsoleStore.Info, input: HooksCheck.Input): HooksCheck.Off | undefined {
  const recorded = manifest(store)
  if (!recorded || Object.keys(recorded.profiles).length === 0) return undefined
  const install = recorded.profiles[paths({ env: input.env }).config]
  if (!install) return undefined
  const plugins = SettingsFile.record(readConfig(install.paths.config).value.plugins)
  const listed = (list: unknown) => Array.isArray(list) && list.some((item) => `${item}` === PLUGIN)
  const entry = SettingsFile.record(SettingsFile.record(plugins.entries)[PLUGIN])
  if (
    plugins.enabled === false ||
    entry.enabled === false ||
    listed(plugins.deny) ||
    (Array.isArray(plugins.allow) && !listed(plugins.allow)) ||
    !loaded(SettingsFile.record(plugins.load).paths, pluginDirectory(store, install.paths.config)) ||
    ConsoleStore.read(path.join(pluginDirectory(store, install.paths.config), "index.cjs")) === undefined
  )
    return { reason: `the ${PLUGIN} plugin isn't enabled in ${install.paths.config}` }
  return undefined
}

function loaded(list: unknown, folder: string) {
  return Array.isArray(list) && list.some((item) => typeof item === "string" && path.resolve(item) === folder)
}

/** What a sync made of an OpenClaw install, for setup to report. */
export interface Applied {
  readonly models: Provider | undefined
  readonly servers: readonly string[]
  readonly skills: readonly string[]
  readonly instructions: number
  /** Names setup left alone because the member already has their own server or skill there, or that can't be written. */
  readonly skipped: readonly string[]
  readonly keepProvider: boolean
  /** The `AGENTS.md` the instructions went to. */
  readonly agents: string
  /** Whether the instructions wait for OpenClaw to create that `AGENTS.md`, as it does when it first runs. */
  readonly waiting: boolean
}

/**
 * Points an OpenClaw install at the workspace: its models through the gateway, the plugin that sends every tool call to
 * `hook openclaw` and serves the gateway's tokens, the workspace's MCP servers, its instructions in the default agent's
 * `AGENTS.md` and its skills. Each run brings the install up to date with the stored workspace config and writes only
 * what changed, so `sync` runs it, without `setup`, for every install setup connected; it does nothing for a member
 * who never ran setup.
 */
export const refresh = Effect.fn("OpenClaw.refresh")(function* (
  store: ConsoleStore.Info,
  setup?: {
    readonly paths: Paths
    readonly command: readonly string[]
    readonly environment: Readonly<Record<string, string>>
    readonly harness?: string | undefined
    readonly keepProvider?: boolean | undefined
  },
  harness?: string,
) {
  const recorded = manifest(store)
  const targets = setup
    ? [{ base: { ...setup, environment: { ...setup.environment } }, previous: recorded?.profiles[setup.paths.config] }]
    : Object.values(recorded?.profiles ?? {}).map((install) => ({ base: install, previous: install }))
  if (targets.length === 0) return undefined
  const credential = yield* ConsoleCredentials.fresh(store)
  const snapshot = credential && WorkspaceSync.current(store, ConsoleCredentials.owner(credential))
  if (!credential || !snapshot?.config) return undefined
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(snapshot.config.providers ?? null))
    .digest("hex")
  const keep = (previous: Install | undefined) =>
    setup ? setup.keepProvider === true : previous?.keepProvider === true
  // A background sync reuses the models setup last made while the config's providers are unchanged.
  const fetched = targets.every(
    ({ previous }) =>
      keep(previous) || (!setup && previous?.providers === fingerprint && previous.models !== undefined),
  )
    ? undefined
    : provider(yield* ConsoleClient.fetchModels(credential))
  const skills = WorkspaceSnapshot.skills(snapshot)
  const applied: Applied[] = []
  for (const { base, previous } of targets) {
    const folder = skillsDirectory(store, base.paths.config)
    const bundles = yield* Skill.fetchChanged(credential, folder, skills, previous?.skills ?? {})
    const keepProvider = keep(previous)
    const models = keepProvider
      ? undefined
      : (fetched ?? (previous?.providers === fingerprint ? (previous.models ?? undefined) : undefined))
    applied.push(
      yield* ConsoleStore.locked(
        store,
        Effect.sync(() =>
          apply(store, {
            paths: base.paths,
            command: base.command,
            environment: base.environment,
            harness: setup?.harness ?? (harness?.startsWith("openclaw/") ? harness : previous?.harness),
            models,
            servers: WorkspaceSnapshot.servers(snapshot),
            instructions: WorkspaceSnapshot.instructions(snapshot),
            skills,
            bundles,
            providers: fingerprint,
            keepProvider,
            explicit: setup !== undefined,
          }),
        ),
      ),
    )
  }
  return applied[0]
})

/**
 * Undoes setup for one install: puts back `agents.defaults.model.primary` unless the member changed it since, and
 * removes the model provider, MCP servers, plugin, skills folder and instructions setup added. When nothing else in
 * `openclaw.json` changed since setup, the file is put back byte for byte. The sign-in stays.
 */
export function remove(store: ConsoleStore.Info, config: string) {
  const recorded = manifest(store)
  const previous = recorded?.profiles[config]
  if (!recorded || !previous) return false
  // Everything is read before anything is written, so a file setup can't read leaves the rest untouched too.
  const file = readConfig(previous.paths.config)
  const agents = ConsoleStore.read(previous.instructions)
  const edit = editor(file.text ?? "")
  if (PRIMARY in previous.originals) restorePrimary(edit, previous)
  if (previous.provider) edit.delete(["models", "providers", PROVIDER])
  previous.servers.forEach((name) => edit.delete(["mcp", "servers", name]))
  edit.delete(["plugins", "entries", PLUGIN])
  edit.without(["plugins", "load", "paths"], pluginDirectory(store, config), previous.created.loadPaths)
  edit.without(["skills", "load", "extraDirs"], skillsDirectory(store, config), previous.created.extraDirs)
  const backup = ConsoleStore.read(SettingsFile.backupOf(previous.paths.config))
  // Setup's edits can leave whitespace that differs from what the member wrote; when only setup's edits are gone,
  // the file they wrote is put back as it was.
  const restored =
    backup !== undefined && same(pruned(parseConfig(backup)), pruned(parseConfig(edit.text()))) ? backup : edit.text()
  if (previous.created.config && empty(restored)) ConsoleStore.remove(previous.paths.config)
  else if (restored !== file.text) SettingsFile.writeFile(previous.paths.config, restored)
  rmSync(directory(store, config), { recursive: true, force: true })
  Instruction.write(previous.instructions, agents, [], previous.created.instructions)
  ConsoleStore.remove(SettingsFile.backupOf(previous.paths.config))
  const rest = Object.fromEntries(Object.entries(recorded.profiles).filter(([key]) => key !== config))
  if (Object.keys(rest).length === 0) ConsoleStore.remove(manifestFile(store))
  else ConsoleStore.write(manifestFile(store), JSON.stringify(Manifest.make({ profiles: rest })))
  return true
}

interface Desired {
  readonly paths: Paths
  readonly command: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly harness: string | undefined
  readonly models: Provider | undefined
  readonly servers: Readonly<
    Record<string, { readonly url: string; readonly headers?: Readonly<Record<string, string>> | undefined }>
  >
  readonly instructions: readonly Instruction.Info[]
  readonly skills: readonly Skill.Info[]
  readonly bundles: readonly Skill.Bundle[]
  readonly providers: string
  readonly keepProvider: boolean
  /** Setup run by the member, which sets every key again; a background sync leaves keys the member changed. */
  readonly explicit: boolean
}

// The key setup owns, as SettingsFile records it (its keys go one level deep), and where it lives in `openclaw.json`.
const PRIMARY = "primary"
const PRIMARY_PATH = ["agents", "defaults", "model", "primary"]

function apply(store: ConsoleStore.Info, desired: Desired): Applied {
  // Everything is read before anything is written, so a file setup can't read leaves every file as it was.
  const recorded = manifest(store)
  const previous = recorded?.profiles[desired.paths.config]
  const config = readConfig(desired.paths.config)
  const current = config.value
  const edit = editor(config.text ?? "")
  const skipped: string[] = []
  const has = (keys: readonly string[]) => valueAt(current, keys) !== undefined
  const plugin = pluginDirectory(store, desired.paths.config)
  const skills = skillsDirectory(store, desired.paths.config)

  // The model provider: setup's own is replaced whole; one the member wrote under the same name stays theirs.
  if (desired.models && !previous?.provider && has(["models", "providers", PROVIDER]))
    throw new Error(
      `${desired.paths.config} already has a model provider named ${PROVIDER}, so OpenClaw was left as it is. Rename it and run setup again.`,
    )
  if (desired.models) edit.set(["models", "providers", PROVIDER], providerEntry(desired))
  else if (previous?.provider) edit.delete(["models", "providers", PROVIDER])

  // `agents.defaults.model.primary`, which sessions start on. A plain `model: "<ref>"` is OpenClaw's short form of it.
  const model = valueAt(current, ["agents", "defaults", "model"])
  if (typeof model === "string") edit.set(["agents", "defaults", "model"], { primary: model })
  const primary = typeof model === "string" ? model : valueAt(current, ["agents", "defaults", "model", "primary"])
  const settings: SettingsFile.Settings = primary === undefined ? {} : { [PRIMARY]: primary }
  const { originals, written } = SettingsFile.apply(
    settings,
    desired.models ? { [PRIMARY]: `${PROVIDER}/${desired.models.model}` } : {},
    previous,
    desired.explicit,
  )
  if (PRIMARY in { ...previous?.originals, ...originals }) {
    const value = settings[PRIMARY]
    if (value === undefined) edit.delete(PRIMARY_PATH)
    else edit.set(PRIMARY_PATH, value)
  }

  // MCP servers: a gateway server's bearer comes from the plugin's in-memory auth profile, a direct server signs in
  // with OpenClaw's own MCP OAuth. A server the member added under the same name stays theirs.
  const owned = new Set(previous?.servers ?? [])
  const servers = Object.entries(desired.servers).flatMap(([name, server]) => {
    if (!usable(name)) return []
    const entry = serverEntry(name, server)
    if (!entry || (!owned.has(name) && has(["mcp", "servers", name]))) {
      skipped.push(name)
      return []
    }
    edit.set(["mcp", "servers", name], entry)
    return [name]
  })
  ;[...owned].filter((name) => !servers.includes(name)).forEach((name) => edit.delete(["mcp", "servers", name]))

  // The plugin, loaded from setup's folder beside the member's own plugins, and enabled: running setup is the member's
  // consent, which a disabled entry would overrule. An allowlist the member keeps gets the plugin added to it.
  const loadPaths = edit.with(["plugins", "load", "paths"], plugin)
  edit.set(["plugins", "entries", PLUGIN], { enabled: true })
  if (Array.isArray(valueAt(current, ["plugins", "allow"]))) edit.with(["plugins", "allow"], PLUGIN)
  if (Array.isArray(valueAt(current, ["plugins", "deny"]))) edit.without(["plugins", "deny"], PLUGIN, false)
  // Workspace skills, in setup's own folder, which OpenClaw scans after the workspace's and the install's own.
  const extraDirs = edit.with(["skills", "load", "extraDirs"], skills)

  const text = edit.text()
  // The result is read back as OpenClaw reads it, so an edit that broke the file is never written.
  const reread = parseConfig(text)
  if (reread === undefined || !Array.isArray(valueAt(reread, ["plugins", "load", "paths"])))
    throw new Error(
      `${desired.paths.config} couldn't take setup's changes, so it was left alone. Fix it and run setup again.`,
    )
  if (!previous) SettingsFile.backup(desired.paths.config)
  // `openclaw.json` names the member's helper commands, so a new one is readable only by them, as OpenClaw writes it.
  if (text !== config.text) SettingsFile.writeFile(desired.paths.config, text, 0o600)

  const synced = Skill.write(skills, desired.skills, desired.bundles, previous?.skills ?? {}, { named: true })
  skipped.push(...synced.skipped)
  // Workspace instructions, between markers in the default agent's `AGENTS.md`, which every session of it loads.
  const agents = path.join(workspaceOf(reread, desired.paths), "AGENTS.md")
  if (previous && previous.instructions !== agents)
    Instruction.write(
      previous.instructions,
      ConsoleStore.read(previous.instructions),
      [],
      previous.created.instructions,
    )
  // OpenClaw writes its own AGENTS.md template when it first sets up the workspace, and skips it when the file is
  // there, so setup never creates the file: the instructions wait for OpenClaw's, which the plugin watches for.
  const createdBefore = previous?.instructions === agents ? previous.created.instructions : false
  const existing = ConsoleStore.read(agents)
  const waiting = existing === undefined && !createdBefore && desired.instructions.length > 0
  const instructionsCreated = waiting ? false : Instruction.write(agents, existing, desired.instructions, createdBefore)

  writeIfChanged(path.join(plugin, "openclaw.plugin.json"), pluginManifest())
  writeIfChanged(path.join(plugin, "index.cjs"), pluginSource(desired, servers, waiting ? agents : undefined))

  const install = Install.make({
    paths: desired.paths,
    command: [...desired.command],
    environment: { ...desired.environment },
    ...(desired.harness === undefined ? {} : { harness: desired.harness }),
    originals: { ...originals },
    written: { ...written },
    provider: desired.models !== undefined,
    servers,
    skills: synced.skills,
    instructions: agents,
    created: {
      config: previous?.created.config ?? config.text === undefined,
      instructions: instructionsCreated,
      loadPaths: previous?.created.loadPaths ?? loadPaths,
      extraDirs: previous?.created.extraDirs ?? extraDirs,
    },
    providers: desired.providers,
    models: desired.models ?? null,
    ...(desired.keepProvider ? { keepProvider: true } : {}),
  })
  ConsoleStore.write(
    manifestFile(store),
    JSON.stringify(Manifest.make({ profiles: { ...recorded?.profiles, [desired.paths.config]: install } })),
  )
  return {
    models: desired.models,
    servers,
    skills: Object.keys(synced.skills),
    instructions: waiting ? 0 : desired.instructions.length,
    waiting,
    skipped,
    keepProvider: desired.keepProvider,
    agents,
  }
}

/**
 * The default agent's workspace as OpenClaw resolves it (`resolveAgentWorkspaceDir` for `main`): the agent's own
 * `workspace`, else `agents.defaults.workspace`, else the install's default.
 */
function workspaceOf(config: Record<string, unknown>, paths: Paths) {
  const home = os.homedir()
  const expand = (value: string) =>
    path.resolve(value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value)
  const own = valueAt(config, ["agents", "entries", "main", "workspace"])
  const defaults = valueAt(config, ["agents", "defaults", "workspace"])
  return typeof own === "string" && own.trim()
    ? expand(own.trim())
    : typeof defaults === "string" && defaults.trim()
      ? expand(defaults.trim())
      : paths.workspace
}

/**
 * The gateway as an OpenClaw model provider (docs.openclaw.ai/concepts/model-providers): the Responses API, the
 * plugin's request credential in place of `apiKey`, only the workspace's models, and `x-opencode-plugin` and OpenClaw's
 * product token naming this setup on every request. The plugin adds the conversation as `x-opencode-session`.
 */
function providerEntry(desired: Desired) {
  const models = desired.models!
  return {
    name: "OpenCode Console",
    baseUrl: models.baseUrl,
    api: "openai-responses",
    apiKey: KEY_MARKER,
    headers: {
      "x-opencode-plugin": `opencode-console/${version}`,
      ...(desired.harness === undefined ? {} : { "User-Agent": desired.harness }),
    },
    models: models.models.map((model) => ({ ...model })),
  }
}

/**
 * The plugin's manifest (docs.openclaw.ai/plugins/manifest): it owns the `opencode-console` provider, whose request
 * credential it exchanges, and the auth profiles that carry the gateway MCP servers' bearers.
 */
function pluginManifest() {
  return `${JSON.stringify(
    {
      id: PLUGIN,
      name: "OpenCode Console",
      description:
        "Checks tool calls against your OpenCode Console workspace's policies and connects its models and MCP servers. Written by npx @opencode/console setup openclaw.",
      version,
      providers: [PROVIDER],
      contracts: { externalAuthProviders: [PROVIDER] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    null,
    2,
  )}\n`
}

/**
 * The plugin, dependency-free CommonJS that hands every decision to the CLI. Each tool call goes to `hook openclaw`,
 * which answers from the stored workspace config, and anything that keeps it from answering blocks the call. Each
 * model request gets a token from `token --json`, kept until shortly before it expires, and the conversation's
 * `x-opencode-session`. The gateway MCP servers' bearers come from `mcp-env` and live only in this process, as
 * runtime-only auth profiles OpenClaw neither writes to its config nor stores. The first tool call after OpenClaw has
 * created the `AGENTS.md` the workspace's instructions wait for starts a sync that writes them.
 */
function pluginSource(desired: Desired, servers: readonly string[], waiting: string | undefined) {
  const variables = Object.fromEntries(
    servers
      .filter((name) => Object.keys(desired.servers[name]?.headers ?? {}).length > 0)
      .map((name) => [name, headerVariable(name)]),
  )
  return `"use strict";
// OpenCode Console for OpenClaw. Written by \`npx @opencode/console setup openclaw\`, which rewrites it on every sync;
// \`--remove\` deletes it. The opencode-console CLI makes every decision: this file passes OpenClaw's hooks to it and
// blocks what it can't get an answer for.

const { execFile, execFileSync, spawn } = require("node:child_process");
const { existsSync } = require("node:fs");

const COMMAND = ${JSON.stringify(desired.command)};
const ENVIRONMENT = ${JSON.stringify(desired.environment)};
// The gateway MCP servers, by the variable \`mcp-env\` names their Authorization header by.
const SERVERS = ${JSON.stringify(variables)};
const PROVIDER = ${JSON.stringify(PROVIDER)};
// The AGENTS.md the workspace's instructions wait for OpenClaw to create, if they do.
const WAITING = ${JSON.stringify(waiting ?? null)};
const BLOCKED = "opencode-console couldn't check this, so it was blocked";
// The gateway's MCP token lasts days, so the plugin asks again every ten minutes.
const MCP_TTL_MS = 10 * 60 * 1000;

const env = () => ({ ...process.env, ...ENVIRONMENT });

function run(args, input, timeout, signal) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(COMMAND[0], [...COMMAND.slice(1), ...args], { env: env(), timeout, signal, maxBuffer: 1 << 20, windowsHide: true },
        (error, stdout, stderr) => resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          // A command that couldn't start, timed out or was cancelled, rather than one that answered.
          failure: error && typeof error.code !== "number" ? String(error.message || error.code || error) : undefined,
        }));
    } catch (error) {
      resolve({ code: 1, stdout: "", stderr: "", failure: String((error && error.message) || error) });
      return;
    }
    child.stdin.on("error", () => {});
    child.stdin.end(input === undefined ? "" : input);
  });
}

function json(text) {
  try {
    const value = JSON.parse(text || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

let token;
async function modelToken(harness, signal) {
  if (token && token.expiresAt - 60_000 > Date.now()) return token;
  const done = await run([...harness, "token", "--json"], undefined, 20_000, signal);
  const answer = json(done.stdout);
  if (done.code !== 0 || typeof answer.access_token !== "string" || answer.access_token === "")
    throw new Error((done.stderr || "").trim() || "opencode-console token failed; run npx @opencode/console login");
  token = {
    apiKey: answer.access_token,
    // A key has no expiry; it's asked for again hourly so a revoked one stops being used.
    expiresAt: Date.now() + (typeof answer.expires_in === "number" ? answer.expires_in * 1000 : 3_600_000),
  };
  return token;
}

const mcp = { at: 0, env: {}, pending: undefined };
function mcpRead(answer) {
  mcp.at = Date.now();
  mcp.env = answer && typeof answer.env === "object" && answer.env ? answer.env : {};
}
// OpenClaw reads auth profiles synchronously, so they're kept fresh in the background and read blocking only before
// the first answer.
function mcpFetch() {
  if (mcp.pending) return mcp.pending;
  mcp.pending = run(["mcp-env"], undefined, 20_000).then((done) => {
    if (done.code === 0) mcpRead(json(done.stdout));
    mcp.pending = undefined;
  });
  return mcp.pending;
}
function mcpEnv() {
  if (Object.keys(SERVERS).length === 0) return {};
  if (mcp.at === 0) {
    try {
      mcpRead(json(execFileSync(COMMAND[0], [...COMMAND.slice(1), "mcp-env"], { env: env(), timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true })));
    } catch {
      return {};
    }
  } else if (Date.now() - mcp.at > MCP_TTL_MS / 2) mcpFetch();
  return mcp.env;
}

function mcpProfile(name, value) {
  const bearer = /^Bearer\\s+(\\S+)$/i.exec(typeof value === "string" ? value.trim() : "");
  if (!bearer) return undefined;
  return {
    profileId: PROVIDER + ":" + name,
    persistence: "runtime-only",
    // \`refresh\` names the server, so a refresh knows which header to read again; it is no secret.
    credential: { type: "oauth", provider: PROVIDER, access: bearer[1], refresh: "opencode-console:" + name, expires: mcp.at + MCP_TTL_MS },
  };
}

function block(done) {
  const answer = json(done.stdout);
  if (done.code === 0 && answer.action !== "block") return undefined;
  const message =
    (typeof answer.message === "string" && answer.message) ||
    (done.stderr || "").trim() ||
    (done.failure ? BLOCKED + ": " + done.failure : BLOCKED);
  return { block: true, blockReason: message };
}

module.exports = {
  id: ${JSON.stringify(PLUGIN)},
  name: "OpenCode Console",
  register(api) {
    const release = api.runtime && typeof api.runtime.version === "string" ? api.runtime.version : "";
    const harness = release && release !== "unknown" ? ["--harness", "openclaw/" + release] : [];
    const workspace = (agentId) => {
      try {
        return api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId || "main") || "";
      } catch {
        return "";
      }
    };
    if (Object.keys(SERVERS).length > 0) mcpFetch();

    api.registerProvider({
      id: PROVIDER,
      label: "OpenCode Console",
      auth: [],
      async prepareRuntimeAuthV2(ctx) {
        const { apiKey, expiresAt } = await modelToken(harness, ctx.signal);
        return { apiKey, expiresAt };
      },
      resolveTransportTurnState(ctx) {
        const session = (ctx.sessionId && ctx.sessionId.trim()) || (ctx.turnId && ctx.turnId.trim());
        return session ? { headers: { "x-opencode-session": session } } : undefined;
      },
      resolveExternalAuthProfiles() {
        const values = mcpEnv();
        return Object.entries(SERVERS).flatMap(([name, variable]) => mcpProfile(name, values[variable]) || []);
      },
      async refreshOAuth(credential) {
        const name = String(credential.refresh || "").replace(/^opencode-console:/, "");
        await mcpFetch();
        const profile = SERVERS[name] && mcpProfile(name, mcp.env[SERVERS[name]]);
        if (!profile) throw new Error("OpenCode Console no longer offers the MCP server " + name);
        return profile.credential;
      },
    });

    // The hook keeps the workspace config fresh, and each fetch brings OpenClaw's settings up to date; instructions
    // waiting for OpenClaw's AGENTS.md need a sync of their own once it's there, since no new fetch may be due.
    let waited = false;
    api.on("before_tool_call", async (event, ctx) => {
      if (!waited && WAITING && existsSync(WAITING)) {
        waited = true;
        try {
          spawn(COMMAND[0], [...COMMAND.slice(1), ...harness, "sync", "--quiet", "--refresh-agents"], { env: env(), detached: true, stdio: "ignore", windowsHide: true }).unref();
        } catch {}
      }
      const agentId = ctx.agentId || "main";
      const done = await run(
        [...harness, "hook", "openclaw"],
        JSON.stringify({
          hook_event_name: "before_tool_call",
          session_id: ctx.sessionId || ctx.sessionKey || "",
          agent_id: agentId,
          cwd: workspace(agentId),
          tool_name: event.toolName,
          tool_input: event.params && typeof event.params === "object" ? event.params : {},
          tool_kind: event.toolKind || ctx.toolKind || undefined,
        }),
        20_000,
        ctx.abortSignal,
      );
      return block(done);
    });

  },
};
`
}

// openclaw.json, edited as JSON with comments so the member's formatting and comments stay as they wrote them.

function parseConfig(text: string): Record<string, unknown> | undefined {
  if (text.trim() === "") return {}
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 || typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return SettingsFile.record(value)
}

function readConfig(file: string) {
  const text = ConsoleStore.read(file)
  if (text === undefined) return { text, value: {} as Record<string, unknown> }
  const value = parseConfig(text)
  if (value === undefined) {
    const errors: ParseError[] = []
    parse(text, errors, { allowTrailingComma: true, disallowComments: false })
    throw new Error(
      `${file} isn't JSON setup can edit${errors[0] ? ` (${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset})` : ""}, so it was left alone. Setup keeps comments and trailing commas, but not JSON5's unquoted keys or single quotes. Fix it and run setup again.`,
    )
  }
  return { text, value }
}

function valueAt(value: unknown, keys: readonly (string | number)[]): unknown {
  return keys.reduce<unknown>((node, key) => SettingsFile.record(node)[key], value)
}

/** Structural edits to a JSONC document that keep everything around them as it was. */
function editor(initial: string) {
  let text = initial.trim() === "" ? "{}\n" : initial
  const format = (): FormattingOptions => {
    const indent = text.match(/\n([ \t]+)["/]/)?.[1] ?? "  "
    return { insertSpaces: !indent.includes("\t"), tabSize: indent.includes("\t") ? 1 : indent.length, eol: "\n" }
  }
  const value = (keys: readonly (string | number)[]) => valueAt(parseConfig(text), keys)
  const write = (keys: readonly (string | number)[], next: unknown) => {
    text = applyEdits(text, modify(text, [...keys], next, { formattingOptions: format() }))
  }
  const remove = (keys: readonly (string | number)[]) => {
    if (value(keys) === undefined) return
    write(keys, undefined)
    for (let depth = keys.length - 1; depth > 0; depth--) {
      const parent = value(keys.slice(0, depth))
      if (typeof parent !== "object" || parent === null || Array.isArray(parent) || Object.keys(parent).length > 0)
        return
      write(keys.slice(0, depth), undefined)
    }
  }
  return {
    text: () => text,
    /** Leaves a value that already reads as `next` where it is, with its comments. */
    set(keys: readonly (string | number)[], next: unknown) {
      if (JSON.stringify(value(keys)) !== JSON.stringify(next)) write(keys, next)
    },
    /** Deletes a key and any object it leaves empty. */
    delete: remove,
    /** Adds `item` to the list at `keys` beside what's there; says whether setup created the list. */
    with(keys: readonly (string | number)[], item: string) {
      const list = value(keys)
      if (Array.isArray(list)) {
        if (!list.some((entry) => `${entry}` === item)) write([...keys, list.length], item)
        return false
      }
      write(keys, [item])
      return true
    },
    /** Takes `item` out of the list at `keys`, and the list with it when setup created it and nothing else is left. */
    without(keys: readonly (string | number)[], item: string, created: boolean) {
      const list = value(keys)
      if (!Array.isArray(list)) return
      const index = list.findIndex((entry) => `${entry}` === item)
      if (index !== -1) write([...keys, index], undefined)
      if (list.length - (index === -1 ? 0 : 1) === 0 && created) remove(keys)
    },
  }
}

// Puts the model new sessions start on back as it was before setup, unless the member changed it since.
function restorePrimary(edit: ReturnType<typeof editor>, owned: SettingsFile.Owned) {
  const now = valueAt(parseConfig(edit.text()), PRIMARY_PATH)
  const settings: SettingsFile.Settings = now === undefined ? {} : { [PRIMARY]: now }
  SettingsFile.restore(settings, PRIMARY, owned)
  if (settings[PRIMARY] === undefined) edit.delete(PRIMARY_PATH)
  else edit.set(PRIMARY_PATH, settings[PRIMARY])
}

// Objects left empty once setup's keys are out, which setup's edits may have dropped or the member may have written.
function pruned(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruned)
  if (typeof value !== "object" || value === null) return value
  const entries = Object.entries(SettingsFile.record(value))
    .map(([key, item]) => [key, pruned(item)] as const)
    .filter(
      ([, item]) =>
        !(typeof item === "object" && item !== null && !Array.isArray(item) && Object.keys(item).length === 0),
    )
  return Object.fromEntries(entries)
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right))
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sorted(SettingsFile.record(value)[key])]),
  )
}

function empty(text: string) {
  const value = parseConfig(text)
  return value !== undefined && Object.keys(value).length === 0
}

function writeIfChanged(file: string, text: string) {
  if (ConsoleStore.read(file) !== text) SettingsFile.writeFile(file, text)
}
