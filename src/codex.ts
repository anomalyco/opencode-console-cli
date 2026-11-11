export * as Codex from "./codex"

import { createHash } from "node:crypto"
import { existsSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { version } from "../package.json" with { type: "json" }
import { ConsoleClient } from "./console-client"
import { CodexHook } from "./codex-hook"
import { ConsoleCredentials } from "./credentials"
import type { HooksCheck } from "./hooks-check"
import { Instruction } from "./instruction"
import { PolicyEvaluator } from "./policy-evaluator"
import { SettingsFile } from "./settings-file"
import { Skill } from "./skill"
import { WorkspaceSnapshot } from "./snapshot"
import { ConsoleStore } from "./store"
import { TomlFile } from "./toml-file"
import { WorkspaceModels } from "./workspace-models"
import { WorkspaceSync } from "./workspace-sync"

/**
 * Where Codex keeps what setup writes (developers.openai.com/codex/config-reference): its home, `~/.codex` or
 * `CODEX_HOME` (which Codex resolves to its real path), with `config.toml`, user hooks in `hooks.json`, command rules
 * in `rules/*.rules`, global instructions in `AGENTS.md` (`AGENTS.override.md` instead when that one has any), and
 * skills in `skills/`.
 */
export interface Paths {
  readonly home: string
  readonly config: string
  readonly hooks: string
  readonly rules: string
  readonly skills: string
  readonly memory: string
}

export function paths(env: Record<string, string | undefined> = process.env, home = os.homedir()): Paths {
  const named = env.CODEX_HOME?.trim()
  const codex = named ? real(path.resolve(named)) : path.join(home, ".codex")
  const override = path.join(codex, "AGENTS.override.md")
  return {
    home: codex,
    config: path.join(codex, "config.toml"),
    hooks: path.join(codex, "hooks.json"),
    rules: path.join(codex, "rules", "opencode-console.rules"),
    skills: path.join(codex, "skills"),
    memory: (ConsoleStore.read(override)?.trim() ?? "") === "" ? path.join(codex, "AGENTS.md") : override,
  }
}

// A path by its real location, as Codex canonicalizes `CODEX_HOME` once it exists; while it doesn't yet, its deepest
// existing directory is resolved (`/tmp` is `/private/tmp` on macOS), so the hook keys setup writes match Codex's.
function real(file: string): string {
  if (existsSync(file)) return realpathSync(file)
  const parent = path.dirname(file)
  return parent === file ? file : path.join(real(parent), path.basename(file))
}

/** The workspace's models as Codex uses them through the gateway. */
export interface Models {
  /** The gateway's OpenAI Responses base URL, which serves every model by its catalog slug. */
  readonly baseURL: string
  /** The Console's Codex model catalog, which Codex fetches with the same token. */
  readonly catalogURL: string
  /** The model new sessions start on: the catalog's first, which ranks OpenAI's models first. */
  readonly model: string
  readonly count: number
}

/**
 * The models Codex can run through the gateway, or undefined when the member has none: the catalog
 * (`GET /api/v2/codex/models`) names them, and any model's base URL from `GET /api/v1/models` names the gateway.
 */
export function models(
  document: ConsoleClient.ModelsDocument,
  catalog: ConsoleClient.CodexModels,
  server: string,
): Models | undefined {
  const root = WorkspaceModels.inferenceRoot(WorkspaceModels.list(document))
  const first = catalog.models[0]
  if (root === undefined || first === undefined) return undefined
  return {
    baseURL: `${root}/openai/v1`,
    catalogURL: `${server}${ConsoleClient.codexModelsPath}`,
    model: first.slug,
    count: catalog.models.length,
  }
}

/**
 * Literal shell denies as Codex command rules (`codex-rs/execpolicy`), which Codex enforces itself even when a hook
 * crashes or times out, since Codex lets a tool call through then. A rule forbids commands that start with its tokens,
 * so only a deny of a plain command followed by `*` (`shell:rm *`, `shell:git push --force*`) becomes one, and only
 * when no later statement allows some of those commands back; every other statement is the hook's alone.
 */
export function rules(statements: readonly PolicyEvaluator.Statement[]) {
  return statements.flatMap((policy, index) => {
    if (policy.action !== "tool.use" || policy.effect !== "deny" || !policy.resource.startsWith("shell:")) return []
    const literal = policy.resource
      .slice("shell:".length)
      .match(/^([^*?]+)\*$/)?.[1]
      ?.trim()
    const tokens = literal?.split(/\s+/) ?? []
    if (!literal || tokens.some((token) => !/^[\w@%+=:,./-]+$/.test(token))) return []
    if (
      statements
        .slice(index + 1)
        .some(
          (later) =>
            later.action === "tool.use" &&
            later.effect === "allow" &&
            PolicyEvaluator.couldMatch(later.resource, `shell:${literal}`),
        )
    )
      return []
    // Starlark reads a string's escapes differently from JSON, so the reason keeps none.
    const reason = [...policy.message].map((char) => (char < " " || char === "\u007f" ? " " : char)).join("")
    return [
      `prefix_rule(pattern = ${JSON.stringify(tokens)}, decision = "forbidden", justification = ${JSON.stringify(reason)})`,
    ]
  })
}

const ModelsInfo = Schema.Struct({
  baseURL: Schema.String,
  catalogURL: Schema.String,
  model: Schema.String,
  count: Schema.Number,
})

/** What setup keeps about the Codex it set up, so later syncs update it and `--remove` undoes it. */
const Manifest = Schema.Struct({
  paths: Schema.Struct({
    home: Schema.String,
    config: Schema.String,
    hooks: Schema.String,
    rules: Schema.String,
    skills: Schema.String,
    memory: Schema.String,
  }),
  /** The command that runs the installed CLI. */
  command: Schema.Array(Schema.String),
  /** Codex's own product token, `codex_cli_rs/<version>`, which names it to the Console. */
  harness: Schema.optional(Schema.String),
  /**
   * The environment the CLI finds its sign-in by, for the MCP header helper, which Codex runs with only `HOME`, `PATH`
   * and a few others.
   */
  environment: Schema.Record(Schema.String, Schema.String),
  /** Each top-level `config.toml` key setup set, with the value it had before, and what setup last wrote to it. */
  ...SettingsFile.OwnedFields,
  /** The `config.toml` tables setup added, by key path: its model provider, MCP servers and hook approvals. */
  tables: Schema.Array(Schema.Array(Schema.String)),
  /** The MCP servers setup added. */
  servers: Schema.Array(Schema.String),
  /** The workspace skills setup wrote to Codex's skills directory, by slug, with the version written. */
  skills: Schema.Record(Schema.String, Schema.String),
  /** Whether setup created the instructions file, so removing its instructions can remove the file. */
  memoryCreated: Schema.Boolean,
  /** Whether setup created `config.toml` and `hooks.json`, so removing an empty one removes it. */
  created: Schema.Struct({ config: Schema.Boolean, hooks: Schema.Boolean }),
  /** A fingerprint of the config's providers, and the models setup made of them, reused while they're unchanged. */
  providers: Schema.optional(Schema.String),
  models: Schema.optional(Schema.NullOr(ModelsInfo)),
  /** Set by `setup --keep-provider`: Codex keeps its own sign-in and models, whatever the workspace serves. */
  keepProvider: Schema.optional(Schema.Boolean),
  /**
   * `shared` while Codex's usage hook reports token counts to the workspace; absent when there's no stats target or
   * Codex uses the gateway.
   */
  usage: Schema.optional(Schema.Literal("shared")),
})
export type Manifest = typeof Manifest.Type

export const manifestFile = (store: ConsoleStore.Info) => path.join(store.data, "codex.json")

/**
 * What setup recorded, or undefined before it ran. A record it can't read throws: treating it as a first run would back
 * up and record setup's own values as the member's.
 */
export function manifest(store: ConsoleStore.Info) {
  const file = manifestFile(store)
  const text = ConsoleStore.read(file)
  if (text === undefined) return undefined
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))(text))
  if (!decoded) throw new Error(`${file} can't be read, so Codex was left as it is. Delete it and run setup again.`)
  return decoded
}

/** What a sync made of Codex, for setup to report. */
export interface Applied {
  readonly models: Models | undefined
  readonly servers: readonly string[]
  readonly skills: readonly string[]
  readonly instructions: number
  /** The shell denies Codex also enforces itself, as command rules. */
  readonly rules: number
  /** Whether Codex's own web search is off, because a policy could deny a search. */
  readonly searchOff: boolean
  /** Names setup left alone because the member already has their own server or skill there. */
  readonly skipped: readonly string[]
  readonly keepProvider: boolean
  readonly usage: Manifest["usage"]
  /** Whether Codex's sessions watch Slack threads and GitHub work through the Console (`WorkspaceSnapshot.watches`). */
  readonly watches: boolean
  /** The config file in which this setup turned `features.hooks` on, which re-enables the member's own hooks too. */
  readonly hooksTurnedOn: string | undefined
}

/** Whether setup gave Codex the `console_watch` server, so its tools are the watch tools and not a member's own. */
export function ownsWatchServer(store: ConsoleStore.Info) {
  return (manifest(store)?.tables ?? []).some(
    (table) => table.length === 2 && table[0] === "mcp_servers" && table[1] === CodexHook.WATCH_SERVER,
  )
}

/** The name setup gives the model provider in `config.toml`. */
export const PROVIDER = "opencode-console"

const FEATURE_HOOKS = ["features", "hooks"] as const
const FEATURE_HOOKS_KEY = FEATURE_HOOKS.join(".")

/**
 * The edit that makes an owned key in `config` read as `settings` has it, if it doesn't already: a top-level key's line,
 * or a dotted key's line under its table's header, which is left alone when the member moved it elsewhere.
 */
function keyEdit(
  key: string,
  settings: SettingsFile.Settings,
  config: { readonly text: string; readonly value: TomlFile.Table },
): TomlFile.Edit[] {
  const value = SettingsFile.get(settings, key)
  if (JSON.stringify(value) === JSON.stringify(SettingsFile.get(config.value, key))) return []
  if (!key.includes(".")) return [{ type: "key", key, value }]
  const path = key.split(".")
  return TomlFile.hasEntry(config.text, path) ? [{ type: "entry", path, value }] : []
}

/** The hook command setup registers: `<command> hook codex`. */
export const hookArgs = ["hook", "codex"] as const
/** The background hook that waits for a session's updates while its turn runs: `<command> hook codex --listen`. */
const listenArgs = [...hookArgs, "--listen"] as const

/**
 * Whether Codex's own files keep the hooks setup registered from running: `features.hooks = false`, or setup's
 * `PreToolUse` hook or its approval gone, which the next sync writes back. `codex -c features.hooks=false` is a flag and
 * isn't readable from here.
 */
export function hooksOff(store: ConsoleStore.Info): HooksCheck.Off | undefined {
  const recorded = manifest(store)
  if (!recorded) return undefined
  const config = TomlFile.read(recorded.paths.config)
  if (config && TomlFile.get(config.value, FEATURE_HOOKS) === false)
    return { reason: `features.hooks is false in ${recorded.paths.config}` }
  if (!SettingsFile.hasHook(SettingsFile.read(recorded.paths.hooks), "PreToolUse", ours))
    return { reason: `setup's PreToolUse hook is missing from ${recorded.paths.hooks}` }
  const approved = recorded.tables
    .filter((table) => table[0] === "hooks" && table[1] === "state" && table[2]?.includes(":pre_tool_use:"))
    .every((table) => TomlFile.get(config?.value ?? {}, table) !== undefined)
  return approved ? undefined : { reason: `setup's PreToolUse hook isn't approved in ${recorded.paths.config}` }
}

/**
 * Points Codex at the workspace: its models through the gateway, policy hooks on every tool call and prompt, command
 * rules for literal shell denies, the workspace's MCP servers, and its instructions and skills. Each run brings
 * everything up to date with the stored workspace config and writes only what changed, so `sync` runs it after every
 * fetch; it does nothing for a member who never ran setup.
 */
export const refresh = Effect.fn("Codex.refresh")(function* (
  store: ConsoleStore.Info,
  setup?: {
    readonly paths: Paths
    readonly command: readonly string[]
    readonly harness?: string | undefined
    readonly environment?: Readonly<Record<string, string>>
    readonly keepProvider?: boolean | undefined
  },
) {
  const previous = manifest(store)
  const base = setup ?? previous
  if (!base) return undefined
  const credential = yield* ConsoleCredentials.fresh(store)
  const snapshot = credential && WorkspaceSync.current(store, ConsoleCredentials.owner(credential))
  if (!credential || !snapshot?.config) return undefined
  const config = snapshot.config
  const skills = WorkspaceSnapshot.skills(snapshot)
  // A background sync reuses the models setup last made while the config's providers are unchanged.
  const providers = createHash("sha256")
    .update(JSON.stringify(config.providers ?? null))
    .digest("hex")
  const reused = !setup && previous?.providers === providers && previous.models !== undefined
  const keepProvider = setup ? setup.keepProvider === true : previous?.keepProvider === true
  const workspaceModels = keepProvider
    ? undefined
    : reused
      ? (previous.models ?? undefined)
      : yield* Effect.all([ConsoleClient.fetchModels(credential), ConsoleClient.fetchCodexModels(credential)], {
          concurrency: 2,
        }).pipe(Effect.map(([document, catalog]) => models(document, catalog, credential.server)))
  const bundles = yield* Skill.fetchChanged(credential, base.paths.skills, skills, previous?.skills ?? {})
  const workspace = WorkspaceSnapshot.workspace(credential, snapshot)
  // Codex's own web search runs on OpenAI's side, where no hook sees it, so it's off while any rule could deny a search.
  const search = yield* Effect.forEach(
    [
      { action: "websearch:", resources: ["*"], truncated: true },
      { action: "websearch.use", resources: ["openai"] },
    ],
    (input) => PolicyEvaluator.check(workspace, input),
  )
  return yield* ConsoleStore.locked(
    store,
    Effect.sync(() =>
      apply(store, {
        paths: base.paths,
        command: base.command,
        harness: setup ? setup.harness : previous?.harness,
        environment: setup ? (setup.environment ?? {}) : (previous?.environment ?? {}),
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
        rules: rules(PolicyEvaluator.statements(workspace) ?? []),
        searchOff: search.some((decision) => decision.effect === "deny"),
        providers,
        keepProvider,
        stats: snapshot.stats,
        watches: WorkspaceSnapshot.watches(snapshot),
        explicit: setup !== undefined,
      }),
    ),
  )
})

/**
 * Undoes setup: restores the `config.toml` keys it changed unless the member changed them since, and removes its model
 * provider, hooks, hook approvals, rules, MCP servers, skills and instructions.
 */
export function remove(store: ConsoleStore.Info) {
  const previous = manifest(store)
  if (!previous) return false
  // Everything is read before anything is written, so a file setup can't read leaves the rest untouched too.
  const config = TomlFile.read(previous.paths.config)
  const hooks = SettingsFile.read(previous.paths.hooks)
  const memory = ConsoleStore.read(previous.paths.memory)
  const text =
    config &&
    TomlFile.edit(previous.paths.config, config.text, [
      ...Object.keys(previous.originals).flatMap((key) => {
        const settings = { ...config.value }
        SettingsFile.restore(settings, key, previous)
        return keyEdit(key, settings, config)
      }),
      ...previous.tables
        .filter((table) => TomlFile.get(config.value, table) !== undefined)
        .map((table) => ({ type: "remove" as const, path: table })),
    ])
  if (config && text !== undefined) {
    if (text.trim() === "" && previous.created.config) ConsoleStore.remove(previous.paths.config)
    else if (text !== config.text) SettingsFile.writeFile(previous.paths.config, text)
  }
  if (hooks) {
    stripHooks(hooks)
    if (Object.keys(hooks).length === 0 && previous.created.hooks) ConsoleStore.remove(previous.paths.hooks)
    else SettingsFile.write(previous.paths.hooks, hooks)
  }
  ConsoleStore.remove(previous.paths.rules)
  Object.keys(previous.skills).forEach((slug) =>
    rmSync(path.join(previous.paths.skills, slug), { recursive: true, force: true }),
  )
  Instruction.write(previous.paths.memory, memory, [], previous.memoryCreated)
  ;[previous.paths.config, previous.paths.hooks].forEach((file) => ConsoleStore.remove(SettingsFile.backupOf(file)))
  ConsoleStore.remove(manifestFile(store))
  return true
}

interface Desired {
  readonly paths: Paths
  readonly command: readonly string[]
  readonly harness: string | undefined
  readonly environment: Readonly<Record<string, string>>
  readonly models: Models | undefined
  readonly servers: Record<string, { readonly url: string | undefined; readonly gateway: boolean }>
  readonly instructions: readonly Instruction.Info[]
  readonly skills: readonly Skill.Info[]
  readonly bundles: readonly Skill.Bundle[]
  readonly rules: readonly string[]
  readonly searchOff: boolean
  readonly providers: string
  readonly keepProvider: boolean
  readonly stats: WorkspaceSnapshot.Stats | undefined
  readonly watches: boolean
  /** Setup run by the member, which sets every key again; a background sync leaves keys the member changed. */
  readonly explicit: boolean
}

function apply(store: ConsoleStore.Info, desired: Desired): Applied {
  // Everything is read before anything is written, so a file setup can't read leaves every file as it was.
  const previous = manifest(store)
  const configExists = existsSync(desired.paths.config)
  const hooksExists = existsSync(desired.paths.hooks)
  const config = TomlFile.read(desired.paths.config) ?? { text: "", value: {} }
  const hooks = SettingsFile.read(desired.paths.hooks) ?? {}
  const memory = ConsoleStore.read(desired.paths.memory)
  const created = previous?.created ?? { config: !configExists, hooks: !hooksExists }
  const skipped: string[] = []

  // The usage report, only while Codex keeps its own sign-in, since the gateway already counts every request it serves.
  const usage = desired.models || !desired.stats ? undefined : ("shared" as const)

  // Hooks: the policy hook on every tool call and prompt, a config refresh when a session starts, and the usage report
  // after each model response.
  stripHooks(hooks)
  const events = SettingsFile.record(hooks.hooks)
  // Commands that fetch the config name Codex to the Console, as its own requests do.
  const named = [...desired.command, ...(desired.harness === undefined ? [] : ["--harness", desired.harness])]
  const registered = hookEvents(named, { usage: usage === "shared", watches: desired.watches }).map(
    ([event, group]) => {
      const groups = [...(Array.isArray(events[event]) ? events[event] : []), group]
      events[event] = groups
      return { event, group, index: groups.length - 1 }
    },
  )
  hooks.hooks = events

  // Top-level keys: the model provider and default model, and web search. Running setup is the member's consent to the
  // hooks running, which `features.hooks = false` overrules; setup owns that key from then on, so a sync doesn't undo it
  // and `--remove` puts it back. Only a key on its own line under `[features]` can be changed in place.
  const settings = { ...config.value }
  const hooksTurnedOn =
    desired.explicit &&
    TomlFile.get(config.value, FEATURE_HOOKS) === false &&
    TomlFile.hasEntry(config.text, FEATURE_HOOKS)
  const { originals, written } = SettingsFile.apply(
    settings,
    {
      ...keyValues(desired),
      ...(hooksTurnedOn || previous?.originals[FEATURE_HOOKS_KEY] !== undefined ? { [FEATURE_HOOKS_KEY]: true } : {}),
    },
    previous,
    desired.explicit,
  )
  const keys = [...new Set([...Object.keys(previous?.originals ?? {}), ...Object.keys(originals)])].flatMap((key) =>
    keyEdit(key, settings, config),
  )

  // Tables: setup's own are replaced whole; a server the member added under the same name stays theirs.
  const owned = new Map((previous?.tables ?? []).map((table) => [JSON.stringify(table), table]))
  const theirs = (table: readonly string[]) =>
    !owned.has(JSON.stringify(table)) && TomlFile.get(config.value, table) !== undefined
  const provider = ["model_providers", PROVIDER] as const
  if (desired.models && theirs(provider))
    throw new Error(
      `${desired.paths.config} already has a model provider named ${PROVIDER}, so Codex was left as it is. Rename it and run setup again.`,
    )
  const servers = Object.entries(desired.servers).flatMap(([name, server]) => {
    if (server.url === undefined || !/^[a-z0-9_-]+$/i.test(name) || name === CodexHook.WATCH_SERVER) return []
    if (theirs(["mcp_servers", name])) {
      skipped.push(name)
      return []
    }
    return [{ name, url: server.url, gateway: server.gateway }]
  })
  // The watch tools, as a local MCP server. Codex starts it with a cleared environment, so it's given where the sign-in
  // is, and passes `OPENCODE_API_KEY` through by name (developers.openai.com/codex/config-reference, `env_vars`).
  const watchServer = ["mcp_servers", CodexHook.WATCH_SERVER]
  const watches = desired.watches && !theirs(watchServer)
  if (desired.watches && !watches) skipped.push(CodexHook.WATCH_SERVER)
  const approvals = registered.map((hook) => ({
    path: ["hooks", "state", `${desired.paths.hooks}:${eventKey(hook.event)}:${hook.index}:0`],
    hash: trustHash(hook.event, hook.group),
  }))
  const tables = [
    ...(desired.models ? [{ path: [...provider], entries: providerTable(desired) }] : []),
    ...servers.map((server) => ({
      path: ["mcp_servers", server.name],
      entries: {
        url: server.url,
        // The gateway's token changes daily, so Codex asks for the headers whenever it connects.
        ...(server.gateway
          ? {
              http_headers_helper: SettingsFile.shellCommand([
                ...environmentArgs(desired.environment),
                ...named,
                "mcp-headers",
                server.name,
              ]),
            }
          : {}),
      },
    })),
    ...(watches
      ? [
          {
            path: watchServer,
            entries: {
              command: named[0]!,
              args: [...named.slice(1), "mcp-watches", "--next-prompt"],
              ...(Object.keys(desired.environment).length === 0 ? {} : { env: { ...desired.environment } }),
              env_vars: ["OPENCODE_API_KEY"],
            },
          },
        ]
      : []),
    // Approving the hooks as `/hooks` would, so Codex runs them without asking (`codex-rs/hooks/src/engine/discovery.rs`).
    ...approvals.map((approval) => ({ path: approval.path, entries: { trusted_hash: approval.hash } })),
  ]
  // A table setup wrote that still reads as it would write it stays where it is.
  const current = (table: { readonly path: readonly string[]; readonly entries: TomlFile.Table }) =>
    owned.has(JSON.stringify(table.path)) &&
    sortedJson(TomlFile.get(config.value, table.path)) === sortedJson(table.entries)
  const kept = new Set(tables.filter(current).map((table) => JSON.stringify(table.path)))
  const text = TomlFile.edit(desired.paths.config, config.text, [
    ...keys,
    ...[...owned]
      .filter(([table]) => !kept.has(table))
      .map(([, table]) => table)
      .filter((table) => TomlFile.get(config.value, table) !== undefined)
      .map((table) => ({ type: "remove" as const, path: table })),
    // A member's own approval of the same hook is replaced by setup's.
    ...approvals
      .filter((approval) => theirs(approval.path))
      .map((approval) => ({ type: "remove" as const, path: approval.path })),
    ...tables
      .filter((table) => !kept.has(JSON.stringify(table.path)))
      .map((table) => ({ type: "table" as const, path: table.path, entries: table.entries })),
  ])

  if (!previous) [desired.paths.config, desired.paths.hooks].forEach(SettingsFile.backup)
  // `config.toml` holds the member's helper commands, so a new one is readable only by them.
  if (text !== config.text) SettingsFile.writeFile(desired.paths.config, text, 0o600)
  SettingsFile.write(desired.paths.hooks, hooks, 0o600)
  if (desired.rules.length > 0)
    writeIfChanged(
      desired.paths.rules,
      `# Written by OpenCode Console from the workspace's policies; \`npx @opencode/console sync\` rewrites it.\n${desired.rules.join("\n")}\n`,
    )
  else ConsoleStore.remove(desired.paths.rules)

  // Workspace skills, in Codex's skills directory. A skill the member wrote under the same slug stays.
  const synced = Skill.write(desired.paths.skills, desired.skills, desired.bundles, previous?.skills ?? {})
  skipped.push(...synced.skipped)
  // Workspace instructions, between markers in Codex's global instructions file.
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
        environment: { ...desired.environment },
        originals,
        written,
        tables: tables.map((table) => table.path),
        servers: servers.map((server) => server.name),
        skills: synced.skills,
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
    servers: servers.map((server) => server.name),
    skills: Object.keys(synced.skills),
    instructions: desired.instructions.length,
    rules: desired.rules.length,
    searchOff: desired.searchOff,
    skipped,
    keepProvider: desired.keepProvider,
    usage,
    watches,
    hooksTurnedOn: hooksTurnedOn ? desired.paths.config : undefined,
  }
}

/**
 * The top-level keys setup owns. With workspace models, Codex sends every model request to the gateway and starts on
 * the catalog's default; without any, or with `--keep-provider`, it keeps its own sign-in. Key names:
 * developers.openai.com/codex/config-reference.
 */
function keyValues(desired: Desired): Record<string, unknown> {
  return {
    ...(desired.models ? { model_provider: PROVIDER, model: desired.models.model } : {}),
    ...(desired.searchOff ? { web_search: "disabled" } : {}),
  }
}

/**
 * The gateway as a Codex model provider (`[model_providers.<id>]`): the Responses API at the gateway, the member's
 * token from `token` (refreshed before it can expire, and after a 401), the Console's model catalog, and the
 * `x-opencode-plugin` header naming this setup on every request.
 */
function providerTable(desired: Desired) {
  const models = desired.models!
  return {
    name: "OpenCode Console",
    base_url: models.baseURL,
    wire_api: "responses",
    model_catalog_url: models.catalogURL,
    http_headers: { "x-opencode-plugin": `opencode-console/${version}` },
    auth: {
      command: desired.command[0],
      // Names Codex to the Console and to the hooks check, which only `token` can run once Codex's hooks are off.
      args: [
        ...desired.command.slice(1),
        "token",
        ...(desired.harness === undefined ? [] : ["--harness", desired.harness]),
      ],
      refresh_interval_ms: 240_000,
      timeout_ms: 15_000,
    },
  }
}

/**
 * The hooks setup registers in `hooks.json` (developers.openai.com/codex/hooks). The policy hook runs on every tool
 * call and prompt; Codex lets a call through when a hook crashes or times out, which the command rules back up. The
 * session start hook refreshes the workspace's config in the background. With `usage`, `PostModelRequest` (Codex
 * 0.164.0+; older Codex ignores the event) reports each model response's token counts, as Codex's own OpenTelemetry
 * export can't without also sending tool arguments and output. It's synchronous: Codex ends an async hook's work with
 * the session, and `codex exec` ends the session right after the last reply, so the hook hands the post to a process of
 * its own and returns at once.
 *
 * With `watches`, the event watch hooks (`CodexWatches`): the prompt's policy hook also brings the updates that waited,
 * and in the background a second prompt hook and `PostToolUse` on shell commands wait for updates while the turn runs.
 * Codex has no limit on a hook's timeout but kills a background hook's processes when the session ends, so they wait up
 * to an hour. `Stop` continues the turn with what arrived, and `Interrupt` (whose timeout Codex caps at 3 seconds)
 * stops the wait.
 */
function hookEvents(
  command: readonly string[],
  options: { readonly usage: boolean; readonly watches: boolean },
): ReadonlyArray<readonly [string, Group]> {
  const line = hookLine([...command, ...hookArgs])
  const listen = hookLine([...command, ...listenArgs])
  return [
    ["PreToolUse", { matcher: "*", hooks: [{ type: "command", command: line, timeout: 30 }] }],
    ["UserPromptSubmit", { hooks: [{ type: "command", command: line, timeout: 30 }] }],
    ["SessionStart", { hooks: [{ type: "command", command: line, timeout: 10 }] }],
    ...(options.usage
      ? [["PostModelRequest", { hooks: [{ type: "command", command: line, timeout: 10 }] }] as const]
      : []),
    ...(options.watches
      ? ([
          ["UserPromptSubmit", { hooks: [{ type: "command", command: listen, timeout: 3600, async: true }] }],
          [
            "PostToolUse",
            { matcher: "^Bash$", hooks: [{ type: "command", command: line, timeout: 3600, async: true }] },
          ],
          ["Stop", { hooks: [{ type: "command", command: line, timeout: 30 }] }],
          ["Interrupt", { hooks: [{ type: "command", command: line, timeout: 3 }] }],
        ] as const)
      : []),
  ]
}

/**
 * A hook's command line. Codex runs hooks in the session's shell, which on Windows is always PowerShell
 * (`default_user_shell` in `codex-rs/shell-command/src/shell_detect.rs`, run as `-NoProfile -Command <line>`), so there
 * the program is run with `&`, every word is a literal single-quoted string, and the line exits with the CLI's own code,
 * which `-Command` would otherwise turn from 2 (a denial) into 1 (a failed hook, which Codex lets through).
 */
export function hookLine(argv: readonly string[], platform = process.platform) {
  if (platform !== "win32") return SettingsFile.shellCommand(argv)
  // PowerShell ends a single-quoted string at any of these, curly ones included, and reads one doubled as itself.
  return `& ${argv.map((arg) => `'${arg.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`).join(" ")}; exit $LASTEXITCODE`
}

interface Group {
  readonly matcher?: string
  readonly hooks: readonly [
    { readonly type: "command"; readonly command: string; readonly timeout: number; readonly async?: boolean },
  ]
}

/**
 * The hash Codex approves a hook by: SHA-256 of the hook's normalized declaration as JSON with sorted keys
 * (`hook_hash` in `codex-rs/hooks/src/engine/discovery.rs`, `version_for_toml` in `codex-rs/config/src/fingerprint.rs`).
 */
export function trustHash(event: string, group: Group) {
  const handler = group.hooks[0]
  // Codex's fingerprint carries `async` whether or not the declaration sets it, so the hash always names it.
  const identity = {
    event_name: eventKey(event),
    ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
    hooks: [{ type: handler.type, command: handler.command, timeout: handler.timeout, async: handler.async === true }],
  }
  return `sha256:${createHash("sha256").update(sortedJson(identity)).digest("hex")}`
}

// `hook_event_key_label` in `codex-rs/hooks/src/lib.rs`.
function eventKey(event: string) {
  return event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`
  if (TomlFile.isTable(value))
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value)
}

// Setup's handlers are the ones ending in `hook codex` or `hook codex --listen`, wherever the CLI they run was installed
// and however the line quotes them (`hookLine`; before 0.1.10, Windows lines read `"hook" "codex"`).
function stripHooks(hooks: Record<string, unknown>) {
  const events = SettingsFile.record(hooks.hooks)
  Object.entries(events).forEach(([event, groups]) => {
    if (!Array.isArray(groups)) return
    const kept = groups.flatMap((group) => {
      const handlers = SettingsFile.record(group).hooks
      if (!Array.isArray(handlers)) return [group]
      const others = handlers.filter((handler) => !ours(handler))
      if (others.length === handlers.length) return [group]
      return others.length === 0 ? [] : [{ ...SettingsFile.record(group), hooks: others }]
    })
    if (kept.length === 0) delete events[event]
    else events[event] = kept
  })
  if (Object.keys(events).length === 0) delete hooks.hooks
  else hooks.hooks = events
}

function ours(handler: unknown) {
  const command = SettingsFile.record(handler).command
  if (typeof command !== "string") return false
  const words = command.replaceAll(/["']/g, "").replace(/; exit \$LASTEXITCODE$/, "")
  return [hookArgs, listenArgs].some((args) => words.endsWith(` ${args.join(" ")}`))
}

// `env NAME=value …`, so a command Codex runs with a cleared environment still finds the CLI's sign-in.
function environmentArgs(environment: Readonly<Record<string, string>>) {
  const entries = Object.entries(environment)
  if (entries.length === 0 || process.platform === "win32") return []
  return ["env", ...entries.map(([name, value]) => `${name}=${value}`)]
}

function writeIfChanged(file: string, text: string) {
  if (ConsoleStore.read(file) !== text) SettingsFile.writeFile(file, text)
}
