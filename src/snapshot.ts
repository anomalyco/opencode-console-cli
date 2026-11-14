export * as WorkspaceSnapshot from "./snapshot"

import { ConfigIntegration } from "@opencode/core/config/integration"
import { Option, Schema } from "effect"
import type { ConsoleClient } from "./console-client"
import { ConsoleCredentials } from "./credentials"
import type { PolicyEvaluator } from "./policy-evaluator"
import { ConsoleStore } from "./store"

/** OpenCode re-fetches its workspace config every minute; the CLI treats a snapshot that old as stale. */
export const MAX_AGE_MS = 60_000

const StatsTarget = Schema.Struct({ otlpLogsUrl: Schema.String, headers: Schema.Record(Schema.String, Schema.String) })

export const Info = Schema.Struct({
  /** `ConsoleCredentials.owner` of the sign-in the config was fetched for. */
  owner: Schema.String,
  /** The workspace's name, which policy denials show. */
  organization: Schema.optional(Schema.String),
  /** When the Console last answered, in epoch milliseconds. */
  fetched: Schema.Number,
  /** The Console's config document, absent when it serves none for this sign-in. */
  config: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  /** The workspace instructions the member loads (`GET /api/v2/instructions`). */
  instructions: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, content: Schema.String }))),
  /** The skills the member may use (`GET /api/v2/skills`), each at the version its download serves. */
  skills: Schema.optional(Schema.Array(Schema.Struct({ slug: Schema.String, version: Schema.String }))),
  /**
   * Where a harness that keeps its own sign-in sends the workspace its usage stats (token counts and model names) as
   * OpenTelemetry logs, with the headers that authenticate it (`GET /api/v2/stats`). Absent while the Console gives this
   * credential none.
   */
  stats: Schema.optional(StatsTarget),
  /** Whether the Console's last config said this member may keep event watches (`ConsoleClient.watchesHeader`). */
  watches: Schema.optional(Schema.Boolean),
  /** Why the sign-in needs the member, such as an expired SSO session, while the last config stays in force. */
  status: Schema.optional(Schema.Struct({ message: Schema.String, url: Schema.optional(Schema.String) })),
})
export type Info = typeof Info.Type
export type Stats = NonNullable<Info["stats"]>

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Info))
// Connectors 0.1.8 and earlier store and read `stats` as `telemetry`, and share this file with a newer one, such as the
// copy `setup` installed for a harness's hooks. So it's written under both names and read from either, preferring
// `stats`. Remove both with `/api/v2/telemetry`.
const decodeOld = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ telemetry: StatsTarget })))
const Providers = Schema.Record(
  Schema.String,
  Schema.Struct({ models: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }),
)
// The config's MCP servers, read leniently so a newer field can't hide the rest.
const McpConfig = Schema.Struct({
  servers: Schema.Record(
    Schema.String,
    Schema.Struct({
      type: Schema.String,
      url: Schema.optional(Schema.String),
      headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
})

export function read(store: ConsoleStore.Info) {
  const text = ConsoleStore.read(ConsoleStore.snapshotFile(store)) ?? ""
  const snapshot = Option.getOrUndefined(decode(text))
  if (!snapshot || snapshot.stats) return snapshot
  return Option.match(decodeOld(text), {
    onNone: () => snapshot,
    onSome: (old) => ({ ...snapshot, stats: old.telemetry }),
  })
}

export function write(store: ConsoleStore.Info, snapshot: Info) {
  ConsoleStore.write(
    ConsoleStore.snapshotFile(store),
    JSON.stringify(snapshot.stats === undefined ? snapshot : { ...snapshot, telemetry: snapshot.stats }),
  )
}

export function clear(store: ConsoleStore.Info) {
  ConsoleStore.remove(ConsoleStore.snapshotFile(store))
}

export function stale(snapshot: Info, now: number) {
  return now - snapshot.fetched >= MAX_AGE_MS
}

/**
 * The workspace's policy statements in order, or `undefined` while they are unknown: nothing fetched yet, a sign-in
 * that needed the member before any config arrived, or statements this version can't read. Callers enforcing policy
 * treat unknown as deny. Statements whose action or effect a newer Console added drop out, as they do in OpenCode.
 */
export function policies(snapshot: Info | undefined) {
  if (!snapshot) return undefined
  const config = snapshot.config
  if (!config) return snapshot.status ? undefined : []
  if (config.policies === undefined) return []
  return Option.getOrUndefined(Schema.decodeUnknownOption(ConfigIntegration.Policies)(config.policies))
}

/**
 * The workspace a policy check runs for: none when signed out, else the snapshot's policies, which stay unknown (and
 * deny) until a config for this sign-in arrives.
 */
export function workspace(
  credential: ConsoleClient.Credential | undefined,
  snapshot: Info | undefined,
): PolicyEvaluator.Workspace {
  if (!credential) return { policies: [] }
  return {
    organization: snapshot?.organization ?? ConsoleCredentials.organization(credential),
    policies: policies(snapshot),
    status: snapshot?.status,
  }
}

/**
 * Whether this member's sessions may watch Slack threads and GitHub work through the Console. Every harness's event
 * watches stay dormant without it: no connection, no polls, no watch tools and no watch hooks.
 */
export function watches(snapshot: Info | undefined) {
  return snapshot?.watches === true
}

/** The workspace instructions the member loads. */
export function instructions(snapshot: Info | undefined) {
  return snapshot?.instructions ?? []
}

/** The skills the member may use, without those whose slug can't name a folder. */
export function skills(snapshot: Info | undefined) {
  return (snapshot?.skills ?? []).filter(
    (skill) => /^[a-z0-9][a-z0-9._-]*$/i.test(skill.slug) && skill.slug.toLowerCase() !== "synced",
  )
}

/** The config's remote MCP servers, by name, with the headers a gateway server carries. */
export function servers(snapshot: Info | undefined) {
  const decoded = Option.getOrElse(Schema.decodeUnknownOption(McpConfig)(snapshot?.config?.mcp), () => ({
    servers: {},
  })).servers
  return Object.fromEntries(
    Object.entries(decoded).flatMap(([name, server]) =>
      server.type === "remote" && server.url !== undefined
        ? [[name, { url: server.url, headers: server.headers }] as const]
        : [],
    ),
  )
}

/** How many models the workspace serves this member through its gateway. */
export function models(snapshot: Info | undefined) {
  const providers = snapshot?.config?.providers
  if (providers === undefined) return 0
  return Object.values(Option.getOrElse(Schema.decodeUnknownOption(Providers)(providers), () => ({}))).reduce(
    (count, provider) => count + Object.keys(provider.models ?? {}).length,
    0,
  )
}
