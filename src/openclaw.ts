export * as OpenClaw from "./openclaw"

import { createHash } from "node:crypto"
import { rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Option, Schema } from "effect"
// The ESM build: the package's main is a UMD build whose lazy requires Bun's bundler can't follow into the npm bundle.
import {
  applyEdits,
  type FormattingOptions,
  modify,
  type ParseError,
  parse,
  printParseErrorCode,
} from "jsonc-parser/lib/esm/main.js"
import { version } from "../package.json" with { type: "json" }
import type { ConsoleClient } from "./console-client"
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
  const profileState = (profile: string | undefined) =>
    profile && PROFILE.test(profile) ? path.join(user, `.openclaw-${profile}`) : path.join(user, ".openclaw")
  const inherited = named(env.OPENCLAW_PROFILE?.trim() || undefined)
  const override = env.OPENCLAW_STATE_DIR?.trim()
  const workspace = env.OPENCLAW_WORKSPACE_DIR?.trim()
  const configured = env.OPENCLAW_CONFIG_PATH?.trim()
  if (input.profile !== undefined) {
    // As `openclaw --profile <name>` switches (`applyCliProfileEnv`): a state directory or config that is the inherited
    // profile's own moves to the named one, and one set anywhere else, a custom deployment's, stays.
    const from = profileState(inherited)
    const to = profileState(named(input.profile))
    const moves = override !== undefined && override !== "" && from !== to && resolve(override) === from
    const state = override && !moves ? resolve(override) : to
    const replaces =
      from !== to && (!override || moves) && configured && resolve(configured) === path.join(from, "openclaw.json")
    return {
      state,
      config: configured && !replaces ? resolve(configured) : path.join(state, "openclaw.json"),
      workspace: workspace ? resolve(workspace) : path.join(state, "workspace"),
    }
  }
  const state = override ? resolve(override) : profileState(inherited)
  return {
    state,
    config: configured ? resolve(configured) : path.join(state, "openclaw.json"),
    workspace: workspace ? resolve(workspace) : path.join(state, "workspace"),
  }
}

/** The provider the plugin registers, which owns the auth profiles the gateway MCP servers' bearers come from. */
export const PROVIDER = "opencode-console"
/** The plugin's id and its entry under `plugins.entries`. */
export const PLUGIN = "opencode-console"

/**
 * OpenClaw's own OpenCode providers, which serve the workspace's models: `opencode` Zen's, `opencode-go` Go's. Each signs
 * in to OpenCode Console in the browser on its own (`openclaw models auth login`), since a refresh token serves one
 * credential; OpenClaw keeps and refreshes the sign-in, so setup never handles its tokens.
 */
export const SIGN_IN_PROVIDERS = ["opencode", "opencode-go"] as const
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number]

/** The OpenClaw providers whose catalogs the workspace offers models from, Zen's first. */
export function signInProviders(document: ConsoleClient.ModelsDocument): SignInProvider[] {
  const offered = new Set(WorkspaceModels.list(document).map((model) => model.provider))
  return SIGN_IN_PROVIDERS.filter((provider) => offered.has(provider))
}

/**
 * The `openclaw` arguments and environment that sign this install in to one provider with OpenCode Console in the
 * browser. `--set-default` starts new sessions on the provider's starter model, so it's given only to an install that
 * names no model yet.
 */
export function signInCommand(paths: Paths, provider: SignInProvider, setDefault: boolean) {
  return {
    args: [
      "models",
      "auth",
      "login",
      "--provider",
      provider,
      "--method",
      "oauth",
      ...(setDefault ? ["--set-default"] : []),
    ],
    env: { OPENCLAW_STATE_DIR: paths.state, OPENCLAW_CONFIG_PATH: paths.config },
  }
}

/**
 * The npm package of each provider's plugin. OpenClaw ships `opencode-go` with its own release but installs `opencode`
 * (Zen) as a separate plugin, so an install without it gets it through `openclaw plugins install` before signing in.
 */
export const PROVIDER_PLUGINS: Readonly<Record<SignInProvider, string>> = {
  opencode: "@openclaw/opencode-provider",
  "opencode-go": "@openclaw/opencode-go-provider",
}

/** The `openclaw` arguments that say whether the install has a provider's plugin: they exit 0 when it does. */
export const pluginInspectCommand = (provider: SignInProvider) => ["plugins", "inspect", provider, "--json"]

/** The `openclaw` arguments that install a provider's plugin, as OpenClaw's own docs name it. */
export const pluginInstallCommand = (provider: SignInProvider) => ["plugins", "install", PROVIDER_PLUGINS[provider]]

/** The `openclaw` arguments that list this install's saved sign-ins for a provider, as JSON. */
export const signInListCommand = (provider: SignInProvider) => [
  "models",
  "auth",
  "list",
  "--provider",
  provider,
  "--json",
]

/** Whether `openclaw models auth list --json` names a sign-in. Output it can't read counts as none. */
export function signedIn(stdout: string) {
  try {
    const profiles = SettingsFile.record(JSON.parse(stdout.slice(Math.max(0, stdout.indexOf("{"))))).profiles
    return Array.isArray(profiles) && profiles.length > 0
  } catch {
    return false
  }
}

/** Whether the install's `openclaw.json` names a model new sessions start on. */
export function hasDefaultModel(paths: Paths) {
  const model = valueAt(readConfig(paths.config).value, ["agents", "defaults", "model"])
  const primary = typeof model === "string" ? model : valueAt(model, ["primary"])
  return typeof primary === "string" && primary.trim() !== ""
}

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
    /** Whether setup added the plugin to the member's `plugins.allow`. */
    allow: Schema.Boolean,
  }),
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
  readonly servers: readonly string[]
  readonly skills: readonly string[]
  readonly instructions: number
  /** Names setup left alone because the member already has their own server or skill there, or that can't be written. */
  readonly skipped: readonly string[]
  /** The `AGENTS.md` the instructions went to. */
  readonly agents: string
  /** Whether the instructions wait for OpenClaw to create that `AGENTS.md`, as it does when it first runs. */
  readonly waiting: boolean
}

/**
 * Points an OpenClaw install at the workspace: the plugin that sends every tool call to `hook openclaw` and serves the
 * gateway MCP servers' tokens, the workspace's MCP servers, its instructions in the default agent's `AGENTS.md` and its
 * skills. The models come from OpenClaw's own sign-in (`signInCommand`), which setup runs separately. Each run brings the
 * install up to date with the stored workspace config and writes only what changed, so `sync` runs it, without `setup`,
 * for every install setup connected; it does nothing for a member who never ran setup.
 */
export const refresh = Effect.fn("OpenClaw.refresh")(function* (
  store: ConsoleStore.Info,
  setup?: {
    readonly paths: Paths
    readonly command: readonly string[]
    readonly environment: Readonly<Record<string, string>>
  },
) {
  const recorded = manifest(store)
  const targets = setup
    ? [{ base: { ...setup, environment: { ...setup.environment } }, previous: recorded?.profiles[setup.paths.config] }]
    : Object.values(recorded?.profiles ?? {}).map((install) => ({ base: install, previous: install }))
  if (targets.length === 0) return undefined
  const credential = yield* ConsoleCredentials.fresh(store)
  const snapshot = credential && WorkspaceSync.current(store, ConsoleCredentials.owner(credential))
  if (!credential || !snapshot?.config) return undefined
  const skills = WorkspaceSnapshot.skills(snapshot)
  // An install setup can't update, such as one whose openclaw.json it can't read, leaves the rest to update; the first
  // failure is still the sync's.
  const applied = yield* Effect.forEach(targets, ({ base, previous }) =>
    Effect.exit(
      Effect.gen(function* () {
        const folder = skillsDirectory(store, base.paths.config)
        const bundles = yield* Skill.fetchChanged(credential, folder, skills, previous?.skills ?? {})
        return yield* ConsoleStore.locked(
          store,
          Effect.sync(() =>
            apply(store, {
              paths: base.paths,
              command: base.command,
              environment: base.environment,
              servers: WorkspaceSnapshot.servers(snapshot),
              instructions: WorkspaceSnapshot.instructions(snapshot),
              skills,
              bundles,
              explicit: setup !== undefined,
            }),
          ),
        )
      }),
    ),
  )
  const failed = applied.find(Exit.isFailure)
  if (failed) return yield* Effect.failCause(failed.cause)
  return applied.flatMap((exit) => (Exit.isSuccess(exit) ? [exit.value] : []))[0]
})

/**
 * Undoes setup for one install: removes the MCP servers, plugin, skills folder and instructions setup added. When nothing
 * else in `openclaw.json` changed since setup, the file is put back byte for byte. Both sign-ins stay: the CLI's, and
 * OpenClaw's own to OpenCode Console, which OpenClaw keeps (`openclaw models auth logout` signs it out).
 */
export function remove(store: ConsoleStore.Info, config: string) {
  const recorded = manifest(store)
  const previous = recorded?.profiles[config]
  if (!recorded || !previous) return false
  // Everything is read before anything is written, so a file setup can't read leaves the rest untouched too.
  const file = readConfig(previous.paths.config)
  const agents = ConsoleStore.read(previous.instructions)
  const edit = editor(file.text ?? "")
  previous.servers.forEach((name) => edit.delete(["mcp", "servers", name]))
  edit.delete(["plugins", "entries", PLUGIN])
  edit.without(["plugins", "load", "paths"], pluginDirectory(store, config), previous.created.loadPaths)
  edit.without(["skills", "load", "extraDirs"], skillsDirectory(store, config), previous.created.extraDirs)
  if (previous.created.allow) edit.without(["plugins", "allow"], PLUGIN, false)
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
  readonly servers: Readonly<
    Record<string, { readonly url: string; readonly headers?: Readonly<Record<string, string>> | undefined }>
  >
  readonly instructions: readonly Instruction.Info[]
  readonly skills: readonly Skill.Info[]
  readonly bundles: readonly Skill.Bundle[]
  /** Setup run by the member; a background sync only updates an install setup still records. */
  readonly explicit: boolean
}

function apply(store: ConsoleStore.Info, desired: Desired): Applied | undefined {
  // Everything is read before anything is written, so a file setup can't read leaves every file as it was.
  const recorded = manifest(store)
  const previous = recorded?.profiles[desired.paths.config]
  // A sync that started before `--remove` took the install out leaves it out.
  if (!previous && !desired.explicit) return undefined
  const config = readConfig(desired.paths.config)
  const current = config.value
  const edit = editor(config.text ?? "")
  const skipped: string[] = []
  const has = (keys: readonly string[]) => valueAt(current, keys) !== undefined
  const plugin = pluginDirectory(store, desired.paths.config)
  const skills = skillsDirectory(store, desired.paths.config)

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
  const allow = valueAt(current, ["plugins", "allow"])
  const allowed = Array.isArray(allow) && !allow.some((item) => `${item}` === PLUGIN)
  if (Array.isArray(allow)) edit.with(["plugins", "allow"], PLUGIN)
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
    servers,
    skills: synced.skills,
    instructions: agents,
    created: {
      config: previous?.created.config ?? config.text === undefined,
      instructions: instructionsCreated,
      loadPaths: previous?.created.loadPaths ?? loadPaths,
      extraDirs: previous?.created.extraDirs ?? extraDirs,
      allow: previous?.created.allow === true || allowed,
    },
  })
  ConsoleStore.write(
    manifestFile(store),
    JSON.stringify(Manifest.make({ profiles: { ...recorded?.profiles, [desired.paths.config]: install } })),
  )
  return {
    servers,
    skills: Object.keys(synced.skills),
    instructions: waiting ? 0 : desired.instructions.length,
    waiting,
    skipped,
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
 * The plugin's manifest (docs.openclaw.ai/plugins/manifest): it loads when the Gateway starts, and owns the
 * `opencode-console` provider, whose auth profiles carry the gateway MCP servers' bearers. It serves no models; OpenClaw's
 * own `opencode` and `opencode-go` do.
 */
function pluginManifest() {
  return `${JSON.stringify(
    {
      id: PLUGIN,
      name: "OpenCode Console",
      description:
        "Checks tool calls against your OpenCode Console workspace's policies and connects its MCP servers. Written by npx @opencode/console setup openclaw.",
      version,
      providers: [PROVIDER],
      // Its policy hook must run from the Gateway's start; nothing references its provider to load it later.
      activation: { onStartup: true },
      contracts: { externalAuthProviders: [PROVIDER] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    null,
    2,
  )}\n`
}

/**
 * The plugin, dependency-free CommonJS that hands every decision to the CLI. Each tool call goes to `hook openclaw`,
 * which answers from the stored workspace config, and anything that keeps it from answering blocks the call. The
 * gateway MCP servers' bearers come from `mcp-env` and live only in this process, as runtime-only auth profiles OpenClaw
 * neither writes to its config nor stores. The first tool call after OpenClaw has created the `AGENTS.md` the
 * workspace's instructions wait for starts a sync that writes them.
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

const mcp = { at: 0, env: {}, pending: undefined };
function mcpRead(answer) {
  mcp.at = Date.now();
  mcp.env = answer && typeof answer.env === "object" && answer.env ? answer.env : {};
}
// OpenClaw reads auth profiles synchronously, so they're kept fresh in the background and read blocking only before
// the first answer.
function mcpFetch() {
  if (mcp.pending) return mcp.pending;
  // Says whether the CLI answered, so a refresh never hands back the bearer it was asked to replace.
  mcp.pending = run(["mcp-env"], undefined, 20_000)
    .then((done) => {
      if (done.code !== 0) return false;
      mcpRead(json(done.stdout));
      return true;
    })
    .finally(() => {
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

// The CLI answers every hook with a JSON object, so anything else, even with exit code 0, blocks.
function answerOf(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function block(done) {
  const answer = answerOf(done.stdout);
  if (done.code === 0 && answer && answer.action !== "block") return undefined;
  const message =
    (answer && typeof answer.message === "string" && answer.message) ||
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
      resolveExternalAuthProfiles() {
        const values = mcpEnv();
        return Object.entries(SERVERS).flatMap(([name, variable]) => mcpProfile(name, values[variable]) || []);
      },
      async refreshOAuth(credential) {
        const name = String(credential.refresh || "").replace(/^opencode-console:/, "");
        if (!(await mcpFetch())) throw new Error("opencode-console couldn't refresh the MCP server " + name + "'s token");
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
        // A sync that can't start or fails leaves the instructions waiting, so the next tool call tries again. Node
        // reports a command it can't start as an \`error\` event, which would end the Gateway if nothing handled it.
        const retry = () => {
          waited = false;
        };
        try {
          const child = spawn(COMMAND[0], [...COMMAND.slice(1), ...harness, "sync", "--quiet", "--refresh-agents"], { env: env(), detached: true, stdio: "ignore", windowsHide: true });
          child.on("error", retry);
          child.on("exit", (code) => {
            if (code !== 0) retry();
          });
          child.unref();
        } catch {
          retry();
        }
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
