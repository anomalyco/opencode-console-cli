export * as Contract from "./contract"

import { Schema } from "effect"

// What this CLI reads from and sends to Console's API, published as `@opencode/console/contract` so Console's own tests
// can encode their real responses and check that released CLIs still decode them. The schemas are lenient on purpose:
// a field a newer Console adds never breaks an older CLI, so only a removed or retyped field fails them.

// ---- Sign-in, config and workspace data ----

/**
 * Device sign-ins start, refresh and end as this client. The Console only accepts a refresh or revocation from the
 * client that started the sign-in, and its approval page names the client from this ID.
 */
export const clientID = "opencode-console-cli"

/**
 * The `GET /api/v2/config` response header, `1`, the Console sends while the caller may keep event watches. It never
 * rides in the config itself.
 */
export const watchesHeader = "x-opencode-event-watches"

/**
 * The `GET /api/v2/config` response header, `1`, the Console sends while the caller may read workspace instructions
 * and skills. Without it, both lists would refuse the caller, so the connector doesn't ask.
 */
export const instructionsSkillsHeader = "x-opencode-instructions-skills"

/**
 * The request header that names the session an MCP client's calls to the gateway come from, for a client that runs one
 * session per connection. The gateway watches what that session's Slack and GitHub writes start.
 */
export const watchSessionHeader = "x-opencode-watch-session"

/**
 * The request header naming this CLI to Console on every request: `opencode-console/<version>`, with `,hooks-off` when
 * the agent's hooks aren't running. Console reads it to list the member's clients and badge old or inactive ones.
 */
export const pluginHeader = "x-opencode-plugin"

/** The path of the Codex model catalog (`model_catalog_url`), which Codex fetches with the token it sends inference. */
export const codexModelsPath = "/api/v2/codex/models"

/** `POST /auth/device/code`. */
export const Device = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
})
export const Token = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
  org_id: Schema.optional(Schema.NullOr(Schema.String)),
})
export const TokenError = Schema.Struct({ error: Schema.String })
export const User = Schema.Struct({ id: Schema.String, email: Schema.String })
export const Org = Schema.Struct({ id: Schema.String, name: Schema.String })
// The Console's 403 when the workspace enforces SSO and the member's SSO proof is missing or expired.
export const SsoRequiredBody = Schema.Struct({
  _tag: Schema.Literal("SsoRequired"),
  connectionId: Schema.optional(Schema.String),
})
// The Console's 401 when the session behind the access token was revoked or expired.
export const UnauthorizedBody = Schema.Struct({ _tag: Schema.Literal("Unauthorized") })
export const ConfigDocument = Schema.Record(Schema.String, Schema.Unknown)

export const ModelsDocument = Schema.Record(
  Schema.String,
  Schema.Struct({
    name: Schema.optional(Schema.String),
    models: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
  }),
)
export type ModelsDocument = typeof ModelsDocument.Type

export const CodexModels = Schema.Struct({
  models: Schema.Array(Schema.Struct({ slug: Schema.String, display_name: Schema.optional(Schema.String) })),
})
export type CodexModels = typeof CodexModels.Type

export const Instructions = Schema.Struct({
  instructions: Schema.Array(Schema.Struct({ name: Schema.String, content: Schema.String })),
})

export const Skills = Schema.Struct({
  skills: Schema.Array(Schema.Struct({ slug: Schema.String, version: Schema.String })),
})

export const Stats = Schema.Struct({
  otlpLogsUrl: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
})

export const SkillBundle = Schema.Struct({
  slug: Schema.String,
  version: Schema.String,
  files: Schema.Array(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("text"), path: Schema.String, content: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("blob"), path: Schema.String, sha256: Schema.String }),
    ]),
  ),
})
export type SkillBundle = typeof SkillBundle.Type

// ---- Event watches ----

/** A watch as the Console lists it, read leniently so a field a newer Console adds or changes can't hide the rest. */
export const Watch = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  routingKey: Schema.String,
  mode: Schema.String,
  expiresAt: Schema.String,
  // The server and event type it follows; Consoles before event types don't send them.
  serverSlug: Schema.optional(Schema.String),
  eventType: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type Watch = typeof Watch.Type
export const WatchList = Schema.Struct({ watches: Schema.Array(Watch) })

/** One event type the member can watch on one of the workspace's servers (`EventWatch.EventType`), read leniently. */
export const EventType = Schema.Struct({
  server: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
})
export type EventType = typeof EventType.Type
export const EventTypeList = Schema.Struct({ types: Schema.Array(EventType) })

/** One event for a watching session (`EventWatch.WatchEvent`), read leniently, as `Watch` is. */
export const WatchEvent = Schema.Struct({
  id: Schema.String,
  watchID: Schema.String,
  sessionID: Schema.String,
  source: Schema.String,
  kind: Schema.String,
  // `self` marks what the watching member wrote themselves; Consoles that don't send it mean someone else.
  actor: Schema.Struct({ login: Schema.String, bot: Schema.Boolean, self: Schema.optional(Schema.Boolean) }),
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  status: Schema.NullOr(Schema.String),
})
export type WatchEvent = typeof WatchEvent.Type
// Snapshots may arrive over several frames; each frame is handled on its own, like a live batch.
export const ServerMessage = Schema.Struct({
  type: Schema.Literals(["snapshot", "events"]),
  events: Schema.Array(WatchEvent),
})
// The cursor is opaque: it is sent back exactly as it came.
export const Poll = Schema.Struct({ cursor: Schema.String, events: Schema.Array(WatchEvent) })
// `_tag` is `WatchRefused` when the member can't watch the target, which trying again won't change.
export const Problem = Schema.Struct({ _tag: Schema.optional(Schema.String), message: Schema.optional(Schema.String) })
