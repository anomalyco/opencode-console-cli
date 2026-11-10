export * as ClaudeCode from "./claude-code"

import { createHash } from "node:crypto"
import { existsSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { version } from "../package.json" with { type: "json" }
import { ClaudeCodeHook } from "./claude-code-hook"
import { ConsoleClient } from "./console-client"
import type { HooksCheck } from "./hooks-check"
import { ConsoleCredentials } from "./credentials"
import { Instruction } from "./instruction"
import { SettingsFile } from "./settings-file"
import { Skill } from "./skill"
import { WorkspaceSnapshot } from "./snapshot"
import { ConsoleStore } from "./store"
import { WorkspaceModels } from "./workspace-models"
import { WorkspaceSync } from "./workspace-sync"

/**
 * Where Claude Code keeps what setup writes (code.claude.com/docs/en/settings): user settings and `CLAUDE.md` in its
 * config directory (`~/.claude`, or `CLAUDE_CONFIG_DIR`), personal skills under it, and user MCP servers in its global
 * config file (`~/.claude.json`, or `.claude.json` in `CLAUDE_CONFIG_DIR`).
 */
export interface Paths {
  readonly config: string
  readonly settings: string
  readonly global: string
  readonly skills: string
  readonly memory: string
}

export function paths(env: Record<string, string | undefined> = process.env, home = os.homedir()): Paths {
  const named = env.CLAUDE_CONFIG_DIR?.trim()
  const config = named ? path.resolve(named) : path.join(home, ".claude")
  return {
    config,
    settings: path.join(config, "settings.json"),
    global: named ? path.join(config, ".claude.json") : path.join(home, ".claude.json"),
    skills: path.join(config, "skills"),
    memory: path.join(config, "CLAUDE.md"),
  }
}

/** A model the `/model` picker offers, by the ID the gateway's Anthropic base URL serves it under. */
export interface Model {
  readonly model: string
  readonly label: string
  readonly description?: string | undefined
}

/** The workspace's models as Claude Code uses them through the gateway. */
export interface Models {
  /** The gateway's Anthropic base URL, for `ANTHROPIC_BASE_URL`. */
  readonly baseURL: string
  readonly options: readonly Model[]
  /** The models Claude Code's `opus`, `sonnet` and `haiku` aliases resolve to; `haiku` also runs background work. */
  readonly tiers: { readonly opus: string; readonly sonnet: string; readonly haiku: string }
}

/**
 * The chat models a member may use (`GET /api/v1/models`), as the gateway's one Anthropic base URL serves them:
 * OpenCode's models by their own IDs, and OpenCode Go's and each workspace connection's under their provider key
 * (`opencode-go/<id>`, `console-<slug>/<id>`). Undefined when there are none.
 *
 * The `opus`, `sonnet` and `haiku` aliases each take the newest Claude model of their family from the first provider
 * that has one (OpenCode's models, then Go's, then the workspace's connections), else the nearest family, else the
 * first model listed, so every alias names a model the member may use.
 */
export function models(document: ConsoleClient.ModelsDocument): Models | undefined {
  const listed = WorkspaceModels.list(document)
  const root = WorkspaceModels.inferenceRoot(listed)
  if (listed.length === 0 || root === undefined) return undefined
  const gatewayID = (model: WorkspaceModels.Listed) =>
    model.provider === "opencode" ? model.id : `${model.provider}/${model.id}`
  const tier = (...families: string[]) => gatewayID(WorkspaceModels.newest(listed, ...families)!)
  return {
    baseURL: `${root}/anthropic`,
    options: listed.map((model) => ({
      model: gatewayID(model),
      label: SettingsFile.text(model.entry.name) ?? model.id,
      ...(model.provider === "opencode" || model.providerName === undefined ? {} : { description: model.providerName }),
    })),
    tiers: {
      opus: tier("opus", "sonnet", "haiku"),
      sonnet: tier("sonnet", "opus", "haiku"),
      haiku: tier("haiku", "sonnet", "opus"),
    },
  }
}

const ModelsInfo = Schema.Struct({
  baseURL: Schema.String,
  options: Schema.Array(
    Schema.Struct({ model: Schema.String, label: Schema.String, description: Schema.optional(Schema.String) }),
  ),
  tiers: Schema.Struct({ opus: Schema.String, sonnet: Schema.String, haiku: Schema.String }),
})

/** What setup keeps about the Claude Code it set up, so later syncs update it and `--remove` undoes it. */
const Manifest = Schema.Struct({
  paths: Schema.Struct({
    config: Schema.String,
    settings: Schema.String,
    global: Schema.String,
    skills: Schema.String,
    memory: Schema.String,
  }),
  /** The command that runs the installed CLI. */
  command: Schema.Array(Schema.String),
  /** Claude Code's own product token, `claude-cli/<version>`, which names it to the Console. */
  harness: Schema.optional(Schema.String),
  /**
   * Each settings key setup set, by dotted path, with the value it had before (none when it was unset), and what setup
   * last wrote to it; a key the member changed since is left as they set it.
   */
  ...SettingsFile.OwnedFields,
  /** The MCP servers setup added to Claude Code's global config. */
  servers: Schema.Array(Schema.String),
  /** The workspace skills setup wrote to Claude Code's skills directory, by slug, with the version written. */
  skills: Schema.Record(Schema.String, Schema.String),
  /** Whether setup created `CLAUDE.md`, so removing its instructions can remove the file. */
  memoryCreated: Schema.Boolean,
  /** Whether setup created the settings file and the global config, so removing an empty one removes it. */
  created: Schema.optional(Schema.Struct({ settings: Schema.Boolean, global: Schema.Boolean })),
  /** A fingerprint of the config's providers, and the models setup made of them, reused while they're unchanged. */
  providers: Schema.optional(Schema.String),
  models: Schema.optional(Schema.NullOr(ModelsInfo)),
  /** Set by `setup --keep-provider`: Claude Code keeps its own sign-in and models, whatever the workspace serves. */
  keepProvider: Schema.optional(Schema.Boolean),
  /**
   * Whether Claude Code sends the workspace its usage metadata (`shared`), or would but already sends OpenTelemetry to
   * the member's own endpoint (`kept`). Absent when the workspace doesn't collect it or Claude Code uses the gateway.
   */
  usage: Schema.optional(Schema.Literals(["shared", "kept"])),
})
export type Manifest = typeof Manifest.Type

export const manifestFile = (store: ConsoleStore.Info) => path.join(store.data, "claude-code.json")

/**
 * What setup recorded, or undefined before it ran. A record it can't read throws: treating it as a first run would back
 * up and record setup's own values as the member's.
 */
export function manifest(store: ConsoleStore.Info) {
  const file = manifestFile(store)
  const text = ConsoleStore.read(file)
  if (text === undefined) return undefined
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))(text))
  if (!decoded)
    throw new Error(`${file} can't be read, so Claude Code was left as it is. Delete it and run setup again.`)
  return decoded
}

/**
 * The servers setup gave Claude Code that its hooks treat specially: whether `console_watch` is setup's, and the
 * workspace's gateway servers, whose Slack and GitHub writes the watch hook watches.
 */
export function ownServers(store: ConsoleStore.Info) {
  const owned = new Set(manifest(store)?.servers ?? [])
  return {
    watch: owned.has(ClaudeCodeHook.WATCH_SERVER),
    gateway: new Set(
      Object.entries(WorkspaceSnapshot.servers(WorkspaceSnapshot.read(store)))
        .filter(([name, server]) => server.headers !== undefined && owned.has(name))
        .map(([name]) => name),
    ),
  }
}

/** What a sync made of Claude Code, for setup to report. */
export interface Applied {
  readonly models: Models | undefined
  readonly servers: readonly string[]
  readonly skills: readonly string[]
  readonly instructions: number
  /** Names setup left alone because the member already has their own server or skill there. */
  readonly skipped: readonly string[]
  readonly keepProvider: boolean
  readonly usage: Manifest["usage"]
  /** Whether Claude Code's sessions keep event watches, through the `console_watch` server and watch hooks. */
  readonly watches: boolean
  /** The settings file in which this setup turned `disableAllHooks` off, which re-enables the member's own hooks too. */
  readonly hooksTurnedOn: string | undefined
}

/**
 * Points Claude Code at the workspace: its models through the gateway, policy hooks on every tool call and prompt,
 * the workspace's MCP servers, and its instructions and skills. Each run brings everything up to date with the
 * stored workspace config and writes only what changed, so `sync` runs it after every fetch; it does nothing for a
 * member who never ran setup. `shell` is the environment Claude Code runs in, read for an OpenTelemetry endpoint the
 * member already set.
 */
export const refresh = Effect.fn("ClaudeCode.refresh")(function* (
  store: ConsoleStore.Info,
  setup?: {
    readonly paths: Paths
    readonly command: readonly string[]
    readonly harness?: string | undefined
    readonly keepProvider?: boolean | undefined
  },
  shell: Readonly<Record<string, string | undefined>> = process.env,
) {
  const previous = manifest(store)
  const base = setup ?? previous
  if (!base) return undefined
  const credential = yield* ConsoleCredentials.fresh(store)
  const snapshot = credential && WorkspaceSync.current(store, ConsoleCredentials.owner(credential))
  if (!credential || !snapshot?.config) return undefined
  const config = snapshot.config
  const skills = WorkspaceSnapshot.skills(snapshot)
  const keepProvider = setup ? setup.keepProvider === true : previous?.keepProvider === true
  // A background sync reuses the models setup last made while the config's providers are unchanged.
  const providers = createHash("sha256")
    .update(JSON.stringify(config.providers ?? null))
    .digest("hex")
  const reused = !setup && previous?.providers === providers && previous.models !== undefined
  const workspaceModels = keepProvider
    ? undefined
    : reused
      ? (previous.models ?? undefined)
      : models(yield* ConsoleClient.fetchModels(credential))
  const bundles = yield* Skill.fetchChanged(credential, base.paths.skills, skills, previous?.skills ?? {})
  return yield* ConsoleStore.locked(
    store,
    Effect.sync(() =>
      apply(store, {
        paths: base.paths,
        command: base.command,
        harness: setup ? setup.harness : previous?.harness,
        models: workspaceModels,
        servers: Object.fromEntries(
          Object.entries(WorkspaceSnapshot.servers(snapshot)).map(([name, server]) => [
            name,
            { url: server.url, gateway: server.headers !== undefined },
          ]),
        ),
        instructions: WorkspaceSnapshot.instructions(snapshot),
        skills,
        bundles,
        providers,
        keepProvider,
        telemetry: snapshot.telemetry,
        watches: WorkspaceSnapshot.watches(snapshot),
        shell,
        explicit: setup !== undefined,
      }),
    ),
  )
})

/** Undoes setup: restores the settings it changed, and removes its hooks, MCP servers, skills and instructions. */
export function remove(store: ConsoleStore.Info) {
  const previous = manifest(store)
  if (!previous) return false
  // Everything is read before anything is written, so a file setup can't read leaves the rest untouched too.
  const settings = SettingsFile.read(previous.paths.settings)
  const global = SettingsFile.read(previous.paths.global)
  const memory = ConsoleStore.read(previous.paths.memory)
  const created = previous.created ?? {
    settings: !existsSync(SettingsFile.backupOf(previous.paths.settings)),
    global: !existsSync(SettingsFile.backupOf(previous.paths.global)),
  }
  if (settings) {
    Object.keys(previous.originals).forEach((key) => SettingsFile.restore(settings, key, previous))
    setHeaders(settings, undefined)
    stripHooks(settings)
    if (Object.keys(settings).length === 0 && created.settings) ConsoleStore.remove(previous.paths.settings)
    else SettingsFile.write(previous.paths.settings, settings)
  }
  if (global) {
    const servers = SettingsFile.record(global.mcpServers)
    previous.servers.forEach((name) => delete servers[name])
    if (Object.keys(servers).length === 0) delete global.mcpServers
    else global.mcpServers = servers
    if (Object.keys(global).length === 0 && created.global) ConsoleStore.remove(previous.paths.global)
    else SettingsFile.write(previous.paths.global, global, 0o600)
  }
  Object.keys(previous.skills).forEach((slug) =>
    rmSync(path.join(previous.paths.skills, slug), { recursive: true, force: true }),
  )
  Instruction.write(previous.paths.memory, memory, [], previous.memoryCreated)
  ;[previous.paths.settings, previous.paths.global].forEach((file) => ConsoleStore.remove(SettingsFile.backupOf(file)))
  ConsoleStore.remove(manifestFile(store))
  return true
}

/** The hook command setup registers: `<command> hook claude-code`. */
export const hookArgs = ["hook", "claude-code"] as const

/**
 * Whether what Claude Code reads keeps the hooks setup registered from running: `--bare`, `disableAllHooks` in the user's
 * settings or the project's, or setup's `PreToolUse` hook gone, which the next sync writes back. Flags like `--settings`
 * aren't readable from here, and project settings can't take a user hook away.
 */
export function hooksOff(store: ConsoleStore.Info, input: HooksCheck.Input): HooksCheck.Off | undefined {
  const recorded = manifest(store)
  if (!recorded) return undefined
  if (input.env.CLAUDE_CODE_SIMPLE === "1")
    return { reason: "claude --bare skips hooks", fix: "Run claude without --bare" }
  const file = recorded.paths.settings
  const settings = SettingsFile.read(file)
  if (settings?.disableAllHooks === true) return { reason: `disableAllHooks is set in ${file}` }
  const project = ["settings.json", "settings.local.json"]
    .map((name) => path.join(input.cwd, ".claude", name))
    .find((item) => SettingsFile.read(item)?.disableAllHooks === true)
  if (project) return { reason: `disableAllHooks is set in ${project}`, fix: `Remove it from ${project}` }
  if (!SettingsFile.hasHook(settings, "PreToolUse", ours))
    return { reason: `setup's PreToolUse hook is missing from ${file}` }
  return undefined
}

interface Desired {
  readonly paths: Paths
  readonly command: readonly string[]
  readonly harness: string | undefined
  readonly models: Models | undefined
  readonly servers: Record<string, { readonly url: string | undefined; readonly gateway: boolean }>
  readonly instructions: readonly Instruction.Info[]
  readonly skills: readonly Skill.Info[]
  readonly bundles: readonly Skill.Bundle[]
  readonly providers: string
  readonly keepProvider: boolean
  readonly telemetry: WorkspaceSnapshot.Telemetry | undefined
  readonly watches: boolean
  readonly shell: Readonly<Record<string, string | undefined>>
  /** Setup run by the member, which sets every key again; a background sync leaves keys the member changed. */
  readonly explicit: boolean
}

const PLUGIN_HEADER = ConsoleClient.pluginHeader

// Environment variables that point Claude Code's OpenTelemetry logs somewhere (code.claude.com/docs/en/monitoring-usage).
const OTEL_ENVIRONMENT = ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "OTEL_LOGS_EXPORTER"]

function apply(store: ConsoleStore.Info, desired: Desired): Applied {
  // Everything is read before anything is written, so a file setup can't read leaves every file as it was.
  const previous = manifest(store)
  const first = previous === undefined
  const settingsExists = existsSync(desired.paths.settings)
  const globalExists = existsSync(desired.paths.global)
  const settings = SettingsFile.read(desired.paths.settings) ?? {}
  const global = SettingsFile.read(desired.paths.global) ?? {}
  const memory = ConsoleStore.read(desired.paths.memory)
  const created = previous?.created ?? { settings: !settingsExists, global: !globalExists }
  const skipped: string[] = []
  if (first) [desired.paths.settings, desired.paths.global].forEach(SettingsFile.backup)

  // Settings: model routing, the auth helper, the model picker, the usage export and the policy hooks.
  const otel = !desired.models && desired.telemetry ? otelValues(desired, desired.telemetry) : undefined
  const usage = otel && (ownOtel(desired, settings, previous, otel) ? ("kept" as const) : ("shared" as const))
  // Running setup is the member's consent to the hooks running, which `disableAllHooks` overrules. Setup owns the key
  // from then on, so a sync doesn't undo that and `--remove` puts it back.
  const hooksTurnedOn = desired.explicit && settings.disableAllHooks === true
  const { originals, written } = SettingsFile.apply(
    settings,
    {
      ...settingsValues(desired),
      ...(usage === "shared" ? otel : {}),
      ...(hooksTurnedOn || previous?.originals.disableAllHooks !== undefined ? { disableAllHooks: false } : {}),
    },
    previous,
    desired.explicit,
  )
  setHeaders(settings, desired.models ? `${PLUGIN_HEADER}: opencode-console/${version}` : undefined)

  // MCP servers, in Claude Code's global config: the workspace's, and with event watches the local server of watch
  // tools. A server the member added under the same name stays theirs.
  const owned = new Set(previous?.servers ?? [])
  const servers = SettingsFile.record(global.mcpServers)
  const wanted: Record<string, Record<string, unknown>> = Object.fromEntries([
    // The name goes into a shell command, so only the names Console gives servers are taken.
    ...Object.entries(desired.servers).flatMap(([name, server]) =>
      server.url === undefined || !/^[a-z0-9_-]+$/i.test(name)
        ? []
        : [
            [
              name,
              {
                type: "http",
                url: server.url,
                // The gateway token in the config changes daily, so Claude Code asks for it on every connection.
                ...(server.gateway
                  ? { headersHelper: SettingsFile.shellCommand([...desired.command, "mcp-headers", name]) }
                  : {}),
              },
            ],
          ],
    ),
    // Claude Code starts stdio servers with its own environment, so the server finds the same sign-in its hooks do.
    ...(desired.watches
      ? [
          [
            ClaudeCodeHook.WATCH_SERVER,
            { type: "stdio", command: desired.command[0], args: [...desired.command.slice(1), "mcp-watches"] },
          ],
        ]
      : []),
  ])
  owned.forEach((name) => {
    if (!(name in wanted)) delete servers[name]
  })
  const added = Object.entries(wanted).flatMap(([name, server]) => {
    if (name in servers && !owned.has(name)) {
      skipped.push(name)
      return []
    }
    servers[name] = server
    return [name]
  })
  if (Object.keys(servers).length > 0) global.mcpServers = servers
  else delete global.mcpServers

  stripHooks(settings)
  const hooks = SettingsFile.record(settings.hooks)
  const watching = desired.watches && added.includes(ClaudeCodeHook.WATCH_SERVER)
  const gateway = added.filter((name) => desired.servers[name]?.gateway === true)
  hookEvents(desired.command, watching ? { gateway } : undefined).forEach(([event, group]) => {
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), group]
  })
  settings.hooks = hooks

  // A new settings file holds the member's helper commands, so it's readable only by them, as Claude Code's own
  // global config file, which holds their account, is.
  SettingsFile.write(desired.paths.settings, settings, 0o600)
  if (globalExists || added.length > 0) SettingsFile.write(desired.paths.global, global, 0o600)

  // Workspace skills, in Claude Code's personal skills directory. A skill the member wrote under the same slug stays.
  const synced = Skill.write(desired.paths.skills, desired.skills, desired.bundles, previous?.skills ?? {})
  skipped.push(...synced.skipped)
  const skills = synced.skills

  // Workspace instructions, between markers in the member's own CLAUDE.md, which Claude Code loads in every project.
  const memoryCreated = Instruction.write(
    desired.paths.memory,
    memory,
    desired.instructions,
    previous?.memoryCreated ?? false,
  )

  ConsoleStore.write(
    manifestFile(store),
    JSON.stringify(
      Manifest.make({
        paths: desired.paths,
        command: [...desired.command],
        ...(desired.harness === undefined ? {} : { harness: desired.harness }),
        originals,
        written,
        servers: added,
        skills,
        memoryCreated,
        created,
        providers: desired.providers,
        models: desired.models ?? null,
        ...(desired.keepProvider ? { keepProvider: true } : {}),
        ...(usage === undefined ? {} : { usage }),
      }),
    ),
  )
  return {
    models: desired.models,
    servers: added,
    skills: Object.keys(skills),
    instructions: desired.instructions.length,
    skipped,
    keepProvider: desired.keepProvider,
    usage,
    watches: watching,
    hooksTurnedOn: hooksTurnedOn ? desired.paths.settings : undefined,
  }
}

/**
 * The settings that send Claude Code's usage metadata to the workspace: its logs as OTLP/HTTP JSON, with the token from
 * `otel-headers`, so none is written to a file (code.claude.com/docs/en/monitoring-usage). Only a Claude Code that
 * keeps its own sign-in sends them, since the gateway already counts every request it serves. Prompt, response, tool
 * and raw API body logging are pinned off.
 */
function otelValues(desired: Desired, telemetry: WorkspaceSnapshot.Telemetry): Record<string, unknown> {
  return {
    "env.CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "env.OTEL_LOGS_EXPORTER": "otlp",
    "env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL": "http/json",
    "env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": telemetry.otlpLogsUrl,
    // Batched every 30 seconds rather than every 5, so a busy session sends the receiver two requests a minute, each
    // well under its 256 KiB body limit even with subagents running.
    "env.OTEL_LOGS_EXPORT_INTERVAL": "30000",
    // The content gates, pinned off: settings `env` overrides the shell, so a gate exported there can't add prompts,
    // responses, tool arguments or raw API bodies to what goes to the workspace.
    "env.OTEL_LOG_USER_PROMPTS": "0",
    "env.OTEL_LOG_ASSISTANT_RESPONSES": "0",
    "env.OTEL_LOG_TOOL_DETAILS": "0",
    "env.OTEL_LOG_RAW_API_BODIES": "0",
    otelHeadersHelper: SettingsFile.shellCommand([...desired.command, "otel-headers"]),
  }
}

/**
 * Whether the member already points Claude Code's OpenTelemetry somewhere, in the settings or the environment, which
 * keeps the usage export off: Claude Code has one exporter, and it stays theirs. A value setup wrote, which Claude Code
 * also passes to the hooks that run `sync`, is setup's own.
 */
function ownOtel(
  desired: Desired,
  settings: SettingsFile.Settings,
  previous: Manifest | undefined,
  ours: Record<string, unknown>,
) {
  const inSettings = [...OTEL_ENVIRONMENT.map((name) => `env.${name}`), "otelHeadersHelper"].some((key) => {
    const value = SettingsFile.get(settings, key)
    if (value === undefined) return false
    return !(previous && key in previous.written && JSON.stringify(value) === JSON.stringify(previous.written[key]))
  })
  return (
    inSettings ||
    OTEL_ENVIRONMENT.some((name) => {
      const value = desired.shell[name]
      return value !== undefined && value !== "" && value !== ours[`env.${name}`]
    })
  )
}

/**
 * The settings keys setup owns, by dotted path. With workspace models, Claude Code sends every model request to the
 * gateway with the member's token, and lists only the workspace's models; without any, or with `--keep-provider`, it
 * keeps its own sign-in.
 * Setting names: code.claude.com/docs/en/settings-reference (`apiKeyHelper`, `modelPicker`, `env`) and
 * code.claude.com/docs/en/env-vars (`ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_DEFAULT_*_MODEL`).
 */
function settingsValues(desired: Desired): Record<string, unknown> {
  const harness = desired.harness === undefined ? {} : { "env.OPENCODE_CONSOLE_HARNESS": desired.harness }
  if (!desired.models) return harness
  return {
    ...harness,
    apiKeyHelper: SettingsFile.shellCommand([...desired.command, "token"]),
    "env.ANTHROPIC_BASE_URL": desired.models.baseURL,
    "env.ANTHROPIC_DEFAULT_OPUS_MODEL": desired.models.tiers.opus,
    "env.ANTHROPIC_DEFAULT_SONNET_MODEL": desired.models.tiers.sonnet,
    "env.ANTHROPIC_DEFAULT_HAIKU_MODEL": desired.models.tiers.haiku,
    modelPicker: { options: desired.models.options, replaceBuiltInOptions: true },
  }
}

/**
 * Puts setup's line in `ANTHROPIC_CUSTOM_HEADERS`, or takes it out with `undefined`, beside whatever lines the member
 * has there now. The line names this setup on every model request, so the Console can tell which members' Claude Code
 * checks policies.
 */
function setHeaders(settings: Record<string, unknown>, line: string | undefined) {
  const current = SettingsFile.get(settings, "env.ANTHROPIC_CUSTOM_HEADERS")
  const theirs = (typeof current === "string" ? current : "")
    .split("\n")
    .filter((item) => item.trim() !== "" && !item.toLowerCase().startsWith(`${PLUGIN_HEADER}:`))
  const lines = [...theirs, ...(line === undefined ? [] : [line])]
  if (lines.length > 0) SettingsFile.set(settings, "env.ANTHROPIC_CUSTOM_HEADERS", lines.join("\n"))
  else if (current !== undefined) SettingsFile.unset(settings, "env.ANTHROPIC_CUSTOM_HEADERS")
}

/**
 * The hooks setup registers (code.claude.com/docs/en/hooks). Policy hooks run on every tool call and on prompts that
 * read files or expand a skill, and block the action if they fail (`onFailure: "block"`, Claude Code 2.1.295+). The
 * session start hook refreshes the workspace's config in the background. With event watches (`ClaudeCodeWatches`),
 * a background `PostToolUse` hook watches what Bash and the `gateway` servers' tools start, a `Stop` hook waits in the
 * background for the session's next update and wakes Claude with it (`asyncRewake`), and `SessionEnd` ends that wait.
 */
function hookEvents(command: readonly string[], watches: { readonly gateway: readonly string[] } | undefined) {
  const handler = { type: "command", command: command[0], args: [...command.slice(1), ...hookArgs] }
  const enforcing = { ...handler, timeout: 30, onFailure: "block" }
  const tools = watches?.gateway.length ? `^(Bash|mcp__(${watches.gateway.join("|")})__.+)$` : "^Bash$"
  return [
    ["PreToolUse", { matcher: "*", hooks: [enforcing] }],
    ["UserPromptSubmit", { hooks: [enforcing] }],
    ["UserPromptExpansion", { hooks: [enforcing] }],
    ["SessionStart", { hooks: [{ ...handler, timeout: 10 }] }],
    ...(watches
      ? ([
          ["PostToolUse", { matcher: tools, hooks: [{ ...handler, async: true }] }],
          // Claude Code still enforces `timeout` on an `asyncRewake` hook, so a session left open stops waiting after
          // 8 hours.
          ["Stop", { hooks: [{ ...handler, asyncRewake: true, timeout: 28_800 }] }],
          // Raises Claude Code's 1.5 second budget for `SessionEnd` hooks.
          ["SessionEnd", { hooks: [{ ...handler, timeout: 5 }] }],
        ] as const)
      : []),
  ] as const
}

// Setup's handlers are the ones ending in `hook claude-code`, wherever the CLI they run was installed.
function stripHooks(settings: Record<string, unknown>) {
  const hooks = SettingsFile.record(settings.hooks)
  Object.entries(hooks).forEach(([event, groups]) => {
    if (!Array.isArray(groups)) return
    const kept = groups.flatMap((group) => {
      const handlers = SettingsFile.record(group).hooks
      if (!Array.isArray(handlers)) return [group]
      const others = handlers.filter((handler) => !ours(handler))
      if (others.length === handlers.length) return [group]
      return others.length === 0 ? [] : [{ ...SettingsFile.record(group), hooks: others }]
    })
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  })
  if (Object.keys(hooks).length === 0) delete settings.hooks
  else settings.hooks = hooks
}

function ours(handler: unknown) {
  const args = SettingsFile.record(handler).args
  return Array.isArray(args) && args.slice(-hookArgs.length).join(" ") === hookArgs.join(" ")
}
