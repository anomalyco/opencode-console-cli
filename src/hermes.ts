export * as Hermes from "./hermes"

import { createHash } from "node:crypto"
import { rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { Document, isCollection, isMap, isSeq, parseDocument } from "yaml"
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
 * Where a Hermes Agent profile keeps what setup changes (NousResearch/hermes-agent `hermes_constants.py`,
 * hermes-agent.nousresearch.com/docs/user-guide/profiles): its home, with `config.yaml`, `SOUL.md`, which every session
 * of the profile loads into its system prompt, and `plugins/`.
 */
export interface Paths {
  readonly home: string
  readonly config: string
  readonly soul: string
  readonly plugin: string
}

/** A profile name as Hermes accepts one (`hermes_cli/profiles.py`). */
export const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/**
 * The profile setup connects, resolved as Hermes resolves it: `--profile <name>`, else `HERMES_HOME`, else the profile
 * `hermes profile use` made active (`active_profile`), else the default home, `~/.hermes` (`%LOCALAPPDATA%\hermes` on
 * Windows), with `HERMES_DATA_DIR_SUFFIX` appended.
 */
export function paths(
  input: {
    readonly profile?: string | undefined
    readonly env?: Record<string, string | undefined>
    readonly home?: string
    readonly platform?: NodeJS.Platform
  } = {},
): Paths {
  const env = input.env ?? process.env
  const user = input.home ?? os.homedir()
  const platform = input.platform ?? process.platform
  const suffix = env.HERMES_DATA_DIR_SUFFIX ?? ""
  const root =
    platform === "win32"
      ? path.join(env.LOCALAPPDATA?.trim() || path.join(user, "AppData", "Local"), `hermes${suffix}`)
      : path.join(user, `.hermes${suffix}`)
  const named = env.HERMES_HOME?.trim()
  const active = ConsoleStore.read(path.join(root, "active_profile"))?.trim()
  const profile = input.profile ?? (named ? undefined : active && active !== "default" ? active : undefined)
  if (profile !== undefined && !PROFILE.test(profile)) throw new Error(`Not a Hermes profile name: ${profile}`)
  const home =
    profile !== undefined
      ? path.join(root, "profiles", profile)
      : named
        ? path.resolve(named === "~" ? user : named.startsWith("~/") ? path.join(user, named.slice(2)) : named)
        : root
  return {
    home,
    config: path.join(home, "config.yaml"),
    soul: path.join(home, "SOUL.md"),
    plugin: path.join(home, "plugins", PLUGIN),
  }
}

/** The name of setup's model provider in `config.yaml` (`providers.<name>`, picked as `custom:<name>`). */
export const PROVIDER = "opencode-console"
/** The name of setup's plugin, its folder under `plugins/` and its entry in `plugins.enabled`. */
export const PLUGIN = "opencode-console"
/** The plugin's secret source, enabled in `secrets.<name>`, which supplies the gateway MCP servers' headers. */
export const SECRET_SOURCE = "opencode_console"

/** Where setup writes a profile's workspace skills, which `skills.external_dirs` adds to the profile's own. */
export function skillsDirectory(store: ConsoleStore.Info, home: string) {
  return path.join(
    store.data,
    "hermes",
    createHash("sha256").update(path.resolve(home)).digest("hex").slice(0, 16),
    "skills",
  )
}

/** The workspace's models as one Hermes model provider on the gateway's OpenAI Responses endpoint. */
export const Provider = Schema.Struct({
  api: Schema.String,
  model: Schema.String,
  models: Schema.Record(Schema.String, Schema.Struct({ context_length: Schema.optional(Schema.Number) })),
})
export type Provider = typeof Provider.Type

/**
 * The chat models the member may use, by gateway ID (OpenCode's by their own IDs, then `opencode-go/<id>`, then
 * `console-<slug>/<id>`), all on the gateway's `/openai/v1`, which routes every one, and the newest Claude Sonnet as the
 * default (else the nearest family, else the first model). Undefined without any. Hermes ships the OpenAI SDK with
 * every install and Anthropic's only as an extra, so Responses is the protocol every Hermes can speak.
 */
export function provider(document: ConsoleClient.ModelsDocument): Provider | undefined {
  const listed = WorkspaceModels.list(document)
  const root = WorkspaceModels.inferenceRoot(listed)
  const picked = WorkspaceModels.newest(listed, "sonnet", "opus", "haiku")
  if (root === undefined || picked === undefined) return undefined
  const id = (model: WorkspaceModels.Listed) =>
    model.provider === "opencode" ? model.id : `${model.provider}/${model.id}`
  return {
    api: `${root}/openai/v1`,
    model: id(picked),
    models: Object.fromEntries(
      listed.map((model) => {
        const context = SettingsFile.record(model.entry.limit).context
        return [id(model), typeof context === "number" && context > 0 ? { context_length: context } : {}]
      }),
    ),
  }
}

/**
 * The environment variable that holds one header of a gateway MCP server, which `config.yaml` names as `${…}` and the
 * plugin's secret source supplies from memory, so the gateway's `ocgw_` token is never written to a file.
 */
export function headerVariable(server: string, header: string) {
  return `OPENCODE_CONSOLE_MCP_${`${server}_${header}`.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
}

/** The variables `config.yaml` names the gateway MCP servers' headers by. */
export function mcpVariables(
  servers: Readonly<Record<string, { readonly headers?: Readonly<Record<string, string>> | undefined }>>,
) {
  return Object.entries(servers).flatMap(([name, server]) =>
    usable(name) ? Object.keys(server.headers ?? {}).map((header) => headerVariable(name, header)) : [],
  )
}

/** Every gateway MCP server's headers, by the variables `config.yaml` names them by, and a fingerprint of them. */
export function mcpEnvironment(snapshot: WorkspaceSnapshot.Info | undefined) {
  const env = Object.fromEntries(
    Object.entries(WorkspaceSnapshot.servers(snapshot)).flatMap(([name, server]) =>
      usable(name)
        ? Object.entries(server.headers ?? {}).map(([header, value]) => [headerVariable(name, header), value] as const)
        : [],
    ),
  )
  return { env, version: createHash("sha256").update(JSON.stringify(env)).digest("hex").slice(0, 16) }
}

// The server name becomes a YAML key and part of a variable name, so only plain names are used.
function usable(name: string) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name)
}

const Profile = Schema.Struct({
  paths: Schema.Struct({ home: Schema.String, config: Schema.String, soul: Schema.String, plugin: Schema.String }),
  /** The command that runs the installed CLI, and the environment it finds the sign-in by. */
  command: Schema.Array(Schema.String),
  environment: Schema.Record(Schema.String, Schema.String),
  /** Hermes's own product token, `HermesAgent/<release>`, which names it to the Console. */
  harness: Schema.optional(Schema.String),
  /** `model.provider` and `model.default`, with the values they had before, and what setup last wrote. */
  ...SettingsFile.OwnedFields,
  /** Whether setup wrote `providers.opencode-console`. */
  provider: Schema.Boolean,
  servers: Schema.Array(Schema.String),
  skills: Schema.Record(Schema.String, Schema.String),
  /** What setup created, so removing what it added there removes the file or list too. */
  created: Schema.Struct({
    config: Schema.Boolean,
    soul: Schema.Boolean,
    externalDirs: Schema.Boolean,
    pluginsEnabled: Schema.Boolean,
  }),
  /** A fingerprint of the config's providers, and the provider setup made of them, reused while they're unchanged. */
  providers: Schema.optional(Schema.String),
  models: Schema.optional(Schema.NullOr(Provider)),
  keepProvider: Schema.optional(Schema.Boolean),
})
type Profile = typeof Profile.Type

/** What setup keeps about each Hermes profile it set up, by its home, so syncs update each and `--remove` undoes one. */
const Manifest = Schema.Struct({ profiles: Schema.Record(Schema.String, Profile) })
export type Manifest = typeof Manifest.Type

export const manifestFile = (store: ConsoleStore.Info) => path.join(store.data, "hermes.json")

/**
 * What setup recorded, or undefined before it ran. A record it can't read throws, so setup never takes its own values
 * for the member's.
 */
export function manifest(store: ConsoleStore.Info) {
  const file = manifestFile(store)
  const text = ConsoleStore.read(file)
  if (text === undefined) return undefined
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))(text))
  if (!decoded) throw new Error(`${file} can't be read, so Hermes was left as it is. Delete it and run setup again.`)
  return decoded
}

/**
 * Whether Hermes is keeping setup's plugin from running: `HERMES_SAFE_MODE`, or the profile's `plugins` no longer enabling
 * it, or its file gone, which the next sync writes back (`hermes_cli/plugins.py`).
 */
export function hooksOff(store: ConsoleStore.Info, input: HooksCheck.Input): HooksCheck.Off | undefined {
  const recorded = manifest(store)
  if (!recorded || Object.keys(recorded.profiles).length === 0) return undefined
  if (/^(1|true|yes|on)$/i.test(input.env.HERMES_SAFE_MODE?.trim() ?? ""))
    return { reason: "HERMES_SAFE_MODE is set", fix: "Unset HERMES_SAFE_MODE" }
  const profile = recorded.profiles[paths({ env: input.env }).home]
  if (!profile) return undefined
  const plugins = SettingsFile.record(SettingsFile.record(readConfig(profile.paths.config).document.toJS()).plugins)
  const named = (list: unknown) => Array.isArray(list) && list.some((item) => `${item}` === PLUGIN)
  if (
    !named(plugins.enabled) ||
    named(plugins.disabled) ||
    ConsoleStore.read(path.join(profile.paths.plugin, "__init__.py")) === undefined
  )
    return { reason: `the ${PLUGIN} plugin isn't enabled in ${profile.paths.config}` }
  return undefined
}

/** What a sync made of a Hermes profile, for setup to report. */
export interface Applied {
  readonly home: string
  readonly models: Provider | undefined
  readonly servers: readonly string[]
  readonly skills: readonly string[]
  readonly instructions: number
  /** Names setup left alone because the member already has their own server or skill there. */
  readonly skipped: readonly string[]
  readonly keepProvider: boolean
}

/**
 * Points a Hermes profile at the workspace: its models through the gateway, the plugin that sends every tool call and
 * turn to `hook hermes`, the workspace's MCP servers, its instructions in `SOUL.md` and its skills. Each run brings the
 * profile up to date with the stored workspace config and writes only what changed, so `sync` runs it, without
 * `setup`, for every profile setup connected; it does nothing for a member who never ran setup. `harness` is the
 * product token of the process that asked: the plugin names the Hermes it runs in, so an upgraded Hermes's syncs name
 * its new release on the next request.
 */
export const refresh = Effect.fn("Hermes.refresh")(function* (
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
    ? [{ base: { ...setup, environment: { ...setup.environment } }, previous: recorded?.profiles[setup.paths.home] }]
    : Object.values(recorded?.profiles ?? {}).map((profile) => ({ base: profile, previous: profile }))
  if (targets.length === 0) return undefined
  const credential = yield* ConsoleCredentials.fresh(store)
  const snapshot = credential && WorkspaceSync.current(store, ConsoleCredentials.owner(credential))
  if (!credential || !snapshot?.config) return undefined
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(snapshot.config.providers ?? null))
    .digest("hex")
  const keep = (previous: Profile | undefined) =>
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
    const directory = skillsDirectory(store, base.paths.home)
    const bundles = yield* Skill.fetchChanged(credential, directory, skills, previous?.skills ?? {})
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
            harness: setup?.harness ?? (harness?.startsWith("HermesAgent/") ? harness : previous?.harness),
            models,
            servers: WorkspaceSnapshot.servers(snapshot),
            instructions: WorkspaceSnapshot.instructions(snapshot),
            skills,
            bundles,
            directory,
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
 * Undoes setup for one profile: puts back `model.provider` and `model.default` unless the member changed them since,
 * and removes the model provider, MCP servers, plugin, skills folder and instructions setup added. The sign-in stays.
 */
export function remove(store: ConsoleStore.Info, home: string) {
  const recorded = manifest(store)
  const previous = recorded?.profiles[home]
  if (!recorded || !previous) return false
  // Everything is read before anything is written, so a file setup can't read leaves the rest untouched too.
  const config = readConfig(previous.paths.config)
  const soul = ConsoleStore.read(previous.paths.soul)
  const settings = SettingsFile.record(config.document.toJS())
  const document = config.document
  Object.keys(previous.originals).forEach((key) => SettingsFile.restore(settings, key, previous))
  ownedKeys(document, settings, previous)
  if (previous.provider) deleteIn(document, ["providers", PROVIDER])
  previous.servers.forEach((name) => deleteIn(document, ["mcp_servers", name]))
  deleteIn(document, ["secrets", SECRET_SOURCE])
  withoutItem(document, ["skills", "external_dirs"], skillsDirectory(store, home), previous.created.externalDirs)
  withoutItem(document, ["plugins", "enabled"], PLUGIN, previous.created.pluginsEnabled)
  const text = document.toString()
  if (empty(document) && previous.created.config) ConsoleStore.remove(previous.paths.config)
  else if (text !== config.text) SettingsFile.writeFile(previous.paths.config, text)
  rmSync(previous.paths.plugin, { recursive: true, force: true })
  rmSync(path.dirname(skillsDirectory(store, home)), { recursive: true, force: true })
  Instruction.write(previous.paths.soul, soul, [], previous.created.soul)
  ConsoleStore.remove(SettingsFile.backupOf(previous.paths.config))
  const rest = Object.fromEntries(Object.entries(recorded.profiles).filter(([key]) => key !== home))
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
  readonly directory: string
  readonly providers: string
  readonly keepProvider: boolean
  /** Setup run by the member, which sets every key again; a background sync leaves keys the member changed. */
  readonly explicit: boolean
}

function apply(store: ConsoleStore.Info, desired: Desired): Applied {
  // Everything is read before anything is written, so a file setup can't read leaves every file as it was.
  const recorded = manifest(store)
  const previous = recorded?.profiles[desired.paths.home]
  const config = readConfig(desired.paths.config)
  const soul = ConsoleStore.read(desired.paths.soul)
  const document = config.document
  const current = SettingsFile.record(document.toJS())
  const skipped: string[] = []

  // The model provider: setup's own is replaced whole; one the member wrote under the same name stays theirs.
  const theirs = (keys: readonly string[], owned: boolean) => !owned && document.getIn(keys) !== undefined
  if (desired.models && theirs(["providers", PROVIDER], previous?.provider === true))
    throw new Error(
      `${desired.paths.config} already has a model provider named ${PROVIDER}, so Hermes was left as it is. Rename it and run setup again.`,
    )
  if (desired.models) setIfChanged(document, ["providers", PROVIDER], providerEntry(desired))
  else if (previous?.provider) deleteIn(document, ["providers", PROVIDER])

  // `model.provider` and `model.default`, which new sessions start on. A plain `model: <id>` is Hermes's older form of
  // `model.default`.
  if (typeof current.model === "string") {
    document.set("model", { default: current.model })
    current.model = { default: current.model }
  }
  const settings = { ...current }
  const { originals, written } = SettingsFile.apply(
    settings,
    desired.models ? { "model.provider": `custom:${PROVIDER}`, "model.default": desired.models.model } : {},
    previous,
    desired.explicit,
  )
  ownedKeys(document, settings, { originals: { ...previous?.originals, ...originals }, written })

  // MCP servers: a gateway server's headers are named as variables the plugin's secret source holds in memory, and a
  // direct server signs in with Hermes's own MCP OAuth. A server the member added under the same name stays theirs.
  const owned = new Set(previous?.servers ?? [])
  const servers = Object.entries(desired.servers).flatMap(([name, server]) => {
    if (!usable(name)) return []
    if (theirs(["mcp_servers", name], owned.has(name))) {
      skipped.push(name)
      return []
    }
    setIfChanged(document, ["mcp_servers", name], {
      url: server.url,
      ...(server.headers === undefined
        ? { auth: "oauth" }
        : {
            headers: Object.fromEntries(
              Object.keys(server.headers).map((header) => [header, `\${${headerVariable(name, header)}}`]),
            ),
          }),
    })
    return [name]
  })
  ;[...owned].filter((name) => !servers.includes(name)).forEach((name) => deleteIn(document, ["mcp_servers", name]))

  // The plugin's secret source, which Hermes runs only while `secrets.<name>.enabled` is set (`hermes_cli/env_loader.py`
  // skips every source when the `secrets` section is empty).
  setIfChanged(document, ["secrets", SECRET_SOURCE], { enabled: true })

  // The plugin and the workspace skills' folder, each added beside the member's own.
  const pluginsEnabled = withItem(document, ["plugins", "enabled"], PLUGIN)
  const externalDirs = withItem(document, ["skills", "external_dirs"], desired.directory)
  // Running setup is the member's consent, which a `plugins.disabled` entry would overrule.
  withoutItem(document, ["plugins", "disabled"], PLUGIN, false)

  const text = document.toString()
  // The result is read back as Hermes reads it, so an edit that broke the file is never written.
  const reread = parseDocument(text)
  if (reread.errors.length > 0 || SettingsFile.record(SettingsFile.record(reread.toJS()).plugins).enabled === undefined)
    throw new Error(
      `${desired.paths.config} couldn't take setup's changes, so it was left alone. Fix it and run setup again.`,
    )
  if (!previous) SettingsFile.backup(desired.paths.config)
  // `config.yaml` holds the member's helper commands, so a new one is readable only by them.
  if (text !== config.text) SettingsFile.writeFile(desired.paths.config, text, 0o600)

  writeIfChanged(path.join(desired.paths.plugin, "plugin.yaml"), pluginManifest())
  writeIfChanged(path.join(desired.paths.plugin, "__init__.py"), pluginSource(desired))

  // Workspace skills, in setup's own folder, which Hermes reads after the profile's own skills.
  const synced = Skill.write(desired.directory, desired.skills, desired.bundles, previous?.skills ?? {}, {
    named: true,
  })
  skipped.push(...synced.skipped)
  // Workspace instructions, between markers in `SOUL.md`, which every session of the profile loads.
  const soulCreated = Instruction.write(desired.paths.soul, soul, desired.instructions, previous?.created.soul ?? false)

  const profile = Profile.make({
    paths: desired.paths,
    command: [...desired.command],
    environment: { ...desired.environment },
    ...(desired.harness === undefined ? {} : { harness: desired.harness }),
    originals: { ...originals },
    written: { ...written },
    provider: desired.models !== undefined,
    servers,
    skills: synced.skills,
    created: {
      config: previous?.created.config ?? config.text === undefined,
      soul: soulCreated,
      externalDirs: previous?.created.externalDirs ?? externalDirs,
      pluginsEnabled: previous?.created.pluginsEnabled ?? pluginsEnabled,
    },
    providers: desired.providers,
    models: desired.models ?? null,
    ...(desired.keepProvider ? { keepProvider: true } : {}),
  })
  ConsoleStore.write(
    manifestFile(store),
    JSON.stringify(Manifest.make({ profiles: { ...recorded?.profiles, [desired.paths.home]: profile } })),
  )
  return {
    home: desired.paths.home,
    models: desired.models,
    servers,
    skills: Object.keys(synced.skills),
    instructions: desired.instructions.length,
    skipped,
    keepProvider: desired.keepProvider,
  }
}

/**
 * The gateway as a Hermes model provider (hermes-agent.nousresearch.com/docs/integrations/providers, "Named Custom
 * Providers"): the Responses API, a token minted by `token --json`, whose `expires_in` Hermes caches it by (a bare
 * token it would keep for 15 minutes), only the workspace's models in `/model`, the conversation as
 * `x-opencode-session`, and Hermes's own product token and `x-opencode-plugin` naming this setup on every request.
 */
function providerEntry(desired: Desired) {
  const models = desired.models!
  return {
    name: "OpenCode Console",
    api: models.api,
    transport: "codex_responses",
    key_cmd: SettingsFile.shellCommand([
      ...environmentArgs(desired.environment),
      ...desired.command,
      "token",
      "--json",
      // Names Hermes to the Console and to the hooks check, which only `token` can run once the plugin is off.
      ...(desired.harness === undefined ? [] : ["--harness", desired.harness]),
    ]),
    discover_models: false,
    session_affinity_header: "x-opencode-session",
    extra_headers: {
      "x-opencode-plugin": `opencode-console/${version}`,
      ...(desired.harness === undefined ? {} : { "User-Agent": desired.harness }),
    },
    default_model: models.model,
    models: models.models,
  }
}

// `env NAME=value …`, so a helper Hermes runs with its own environment still finds the CLI's sign-in.
function environmentArgs(environment: Readonly<Record<string, string>>) {
  const entries = Object.entries(environment)
  if (entries.length === 0 || process.platform === "win32") return []
  return ["env", ...entries.map(([name, value]) => `${name}=${value}`)]
}

/** The plugin's manifest (hermes-agent.nousresearch.com/docs/user-guide/features/plugins): hooks only, no dependencies. */
function pluginManifest() {
  return [
    `name: ${PLUGIN}`,
    `version: "${version}"`,
    'description: "OpenCode Console: checks tool calls and /skill turns against your workspace\'s policies and connects its MCP servers. Written by npx @opencode/console setup hermes."',
    "provides_hooks:",
    "  - pre_tool_call",
    "  - pre_llm_call",
    "  - on_session_start",
    "",
  ].join("\n")
}

/**
 * The plugin, standard-library Python that hands every decision to the CLI: each tool call and each turn go to
 * `hook hermes`, which answers from the stored workspace config, and anything that keeps it from answering blocks.
 * Hermes blocks a `pre_tool_call` that raises or runs past its 30 second limit, but runs a turn whose `pre_llm_call`
 * does, so that one catches everything itself. With each tool call go the directories Hermes resolves its paths
 * against, which follow the task's `cd`, and with each turn the skills `skills.auto_load` puts in the system prompt.
 *
 * A secret source supplies the gateway MCP servers' headers from `mcp-env`, and Hermes forgets them when the CLI's
 * fingerprint changes, so the next connection takes the new day's token. Hermes puts a secret source's values in its
 * own environment, so the plugin has Hermes mask `ocgw_` tokens in logs, tool output and replies, and, on a Hermes with
 * `ctx.register_session_env`, unset the variables in each session's terminal and `execute_code` processes, which also
 * keeps them out of its shell snapshots. A new session starts a background sync.
 */
function pluginSource(desired: Desired) {
  return `"""OpenCode Console for Hermes Agent.

Written by \`npx @opencode/console setup hermes\`, which rewrites it on every sync; \`--remove\` deletes it. The
opencode-console CLI makes every decision: this file passes Hermes's hooks to it and blocks what it can't get an
answer for.
"""

import json
import os
import subprocess

COMMAND = ${JSON.stringify(desired.command)}
ENVIRONMENT = ${JSON.stringify(desired.environment)}
MCP_VARIABLES = ${JSON.stringify(mcpVariables(desired.servers))}
TOKEN_PATTERN = r"ocgw_[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"
BLOCKED = "opencode-console couldn't check this, so it was blocked"

_context = None
_secrets = {"version": None}


def _env():
    return {**os.environ, **ENVIRONMENT}


def _harness():
    try:
        from hermes_cli.version_info import get_version_info

        release = get_version_info().base_version
    except Exception:
        return []
    return ["--harness", f"HermesAgent/{release}"] if release and release != "unknown" else []


def _home():
    try:
        from hermes_constants import get_hermes_home

        return str(get_hermes_home())
    except Exception:
        return ""


def _cwd():
    try:
        return (_context.session_cwd() if _context is not None else "") or os.getcwd()
    except Exception:
        return os.getcwd()


def _dirs(task_id):
    """The session's project, and where the task's file tools and terminal resolve relative paths after any cd."""
    dirs = {"cwd": _cwd()}
    try:
        from tools.file_tools_paths import _authoritative_workspace_root

        dirs["base"] = _authoritative_workspace_root(task_id or "default") or ""
    except Exception:
        pass
    try:
        from tools.approval import get_current_session_key
        from tools.terminal_tool import get_session_cwd

        dirs["shell_cwd"] = get_session_cwd(get_current_session_key(default="") or task_id or "") or ""
    except Exception:
        pass
    try:
        from hermes_constants import get_subprocess_home

        dirs["home_dir"] = get_subprocess_home() or os.path.expanduser("~")
    except Exception:
        dirs["home_dir"] = os.path.expanduser("~")
    return dirs


def _auto_loaded():
    """The skills skills.auto_load puts in every session's system prompt, which pre_llm_call doesn't see."""
    try:
        from agent.skill_commands import resolve_auto_load_skills
        from hermes_cli.config import load_config_readonly
        from utils import is_truthy_value
    except ImportError:
        return []
    if is_truthy_value(os.environ.get("HERMES_IGNORE_RULES")):
        return []
    return [name for name in resolve_auto_load_skills(load_config_readonly()) if isinstance(name, str)]


def _ask(event, timeout):
    """The CLI's answer: (None, output) to allow, or (message, None) to block."""
    try:
        done = subprocess.run(
            [*COMMAND, *_harness(), "hook", "hermes"],
            input=json.dumps({"cwd": _cwd(), **event, "home": _home()}),
            capture_output=True, text=True, timeout=timeout, env=_env(),
        )
    except Exception as error:
        return f"{BLOCKED}: {error}", None
    try:
        answer = json.loads(done.stdout or "{}")
    except ValueError:
        answer = {}
    if done.returncode == 0 and isinstance(answer, dict) and answer.get("action") != "block":
        return None, answer
    message = answer.get("message") if isinstance(answer, dict) else None
    return (message if isinstance(message, str) and message else (done.stderr or "").strip() or BLOCKED), None


def on_pre_tool_call(tool_name="", args=None, task_id="", session_id="", conversation_id="", **kwargs):
    message, _ = _ask(
        {
            **_dirs(task_id),
            "hook_event_name": "pre_tool_call",
            "session_id": conversation_id or session_id,
            "tool_name": tool_name,
            "tool_input": args if isinstance(args, dict) else {},
        },
        20,
    )
    return {"action": "block", "message": message} if message else None


def on_pre_llm_call(session_id="", user_message="", **kwargs):
    try:
        message, answer = _ask(
            {
                "hook_event_name": "pre_llm_call",
                "session_id": session_id,
                "user_message": user_message,
                "loaded_skills": _auto_loaded(),
            },
            15,
        )
        if message:
            return {"action": "block", "message": message}
        latest = answer.get("mcp") if isinstance(answer, dict) else None
        if latest and _secrets["version"] and latest != _secrets["version"]:
            from hermes_cli.env_loader import reset_secret_source_cache

            reset_secret_source_cache(_home() or None)
            _secrets["version"] = None
        return None
    except Exception as error:
        return {"action": "block", "message": f"{BLOCKED}: {error}"}


def on_session_start(**kwargs):
    try:
        subprocess.Popen(
            [*COMMAND, *_harness(), "sync", "--quiet"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env=_env(), start_new_session=True,
        )
    except Exception:
        pass


def _secret_source():
    from agent.secret_sources.base import ErrorKind, FetchResult, SecretSource

    class OpenCodeConsoleSecrets(SecretSource):
        """The workspace's gateway MCP headers, which config.yaml names as \${OPENCODE_CONSOLE_MCP_*}."""

        name = "${SECRET_SOURCE}"
        label = "OpenCode Console"
        shape = "bulk"
        override_existing_default = True

        def fetch(self, cfg, home_path):
            result = FetchResult()
            try:
                done = subprocess.run(
                    [*COMMAND, *_harness(), "mcp-env"],
                    capture_output=True, text=True, timeout=20, env=_env(), stdin=subprocess.DEVNULL,
                )
                answer = json.loads(done.stdout or "{}") if done.returncode == 0 else {}
            except Exception as error:
                return result.fail(f"opencode-console mcp-env failed: {error}", ErrorKind.INTERNAL)
            env = answer.get("env") if isinstance(answer, dict) else None
            if not isinstance(env, dict):
                return result.fail((done.stderr or "").strip() or "Not signed in to OpenCode Console", ErrorKind.AUTH_FAILED)
            result.secrets = {key: value for key, value in env.items() if isinstance(key, str) and isinstance(value, str)}
            _secrets["version"] = answer.get("version")
            return result

    return OpenCodeConsoleSecrets()


def register(ctx):
    global _context
    _context = ctx
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    ctx.register_hook("pre_llm_call", on_pre_llm_call)
    ctx.register_hook("on_session_start", on_session_start)
    try:
        ctx.register_secret_source(_secret_source())
    except Exception:
        pass
    try:
        ctx.register_redaction_patterns([TOKEN_PATTERN])
    except Exception:
        pass
    register_session_env = getattr(ctx, "register_session_env", None)
    if register_session_env is not None and MCP_VARIABLES:
        try:
            register_session_env(MCP_VARIABLES, lambda session_id: {name: None for name in MCP_VARIABLES})
        except Exception:
            pass
`
}

function readConfig(file: string) {
  const text = ConsoleStore.read(file)
  if (text === undefined || text.trim() === "") return { text, document: new Document({}) }
  const document = parseDocument(text)
  if (document.errors.length > 0 || (document.contents !== null && !isMap(document.contents)))
    throw new Error(`${file} isn't YAML Hermes reads, so it was left alone. Fix it and run setup again.`)
  return { text, document }
}

// Writes `model.provider` and `model.default` as `settings` has them, dropping an empty `model`.
function ownedKeys(document: Document, settings: SettingsFile.Settings, owned: SettingsFile.Owned) {
  Object.keys(owned.originals).forEach((key) => {
    const keys = key.split(".")
    const value = SettingsFile.get(settings, key)
    if (value === undefined) deleteIn(document, keys)
    else setIfChanged(document, keys, value)
  })
}

// Leaves a value that already reads as `value` where it is, with its comments.
function setIfChanged(document: Document, keys: readonly string[], value: unknown) {
  const now = document.getIn(keys)
  if (JSON.stringify(isCollection(now) ? now.toJSON() : now) === JSON.stringify(value)) return
  document.setIn(keys, value)
}

// Deletes a key and any map it leaves empty.
function deleteIn(document: Document, keys: readonly string[]) {
  if (!document.hasIn(keys)) return
  document.deleteIn(keys)
  for (let depth = keys.length - 1; depth > 0; depth--) {
    const parent = document.getIn(keys.slice(0, depth))
    if (!isMap(parent) || parent.items.length > 0) return
    document.deleteIn(keys.slice(0, depth))
  }
}

/** Adds `item` to the list at `keys` beside what's there; says whether setup created the list. */
function withItem(document: Document, keys: readonly string[], item: string) {
  const list = document.getIn(keys)
  if (isSeq(list)) {
    if (!list.items.some((entry) => `${entry}` === item)) list.add(document.createNode(item))
    return false
  }
  const existing = list === undefined || list === null ? [] : [`${list}`]
  document.setIn(keys, [...existing, item])
  return existing.length === 0
}

/** Takes `item` out of the list at `keys`, and the list with it when setup created it and nothing else is left. */
function withoutItem(document: Document, keys: readonly string[], item: string, created: boolean) {
  const list = document.getIn(keys)
  if (!isSeq(list)) return
  const index = list.items.findIndex((entry) => `${entry}` === item)
  if (index !== -1) list.delete(index)
  if (list.items.length === 0 && created) deleteIn(document, keys)
}

function empty(document: Document) {
  const contents = document.contents
  return contents === null || (isMap(contents) && contents.items.length === 0)
}

function writeIfChanged(file: string, text: string) {
  if (ConsoleStore.read(file) !== text) SettingsFile.writeFile(file, text)
}
