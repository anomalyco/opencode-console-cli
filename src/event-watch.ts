export * as EventWatch from "./event-watch"

import { Schema } from "effect"

// The event watch wire contract between OpenCode Console and its clients, published as `@opencode/console/event-watch`:
// what a client may ask to watch, the events Console sends it, and the protocol's limits. The Console server builds its
// own routing, storage and parsing on these; nothing here depends on how it does.

/** A watch's ID. */
export const ID = Schema.String.check(Schema.isStartingWith("ew_"), Schema.isMaxLength(64)).pipe(
  Schema.brand("EventWatch.ID"),
)
export type ID = typeof ID.Type

/**
 * What a watch's events go to: a coding session, or one of Console's own MCP Events subscriptions, whose sessions start
 * with `SUBSCRIPTION_PREFIX` and which no coding session's client ever reads.
 */
export const WatchSessionID = Schema.NonEmptyString.check(Schema.isMaxLength(64))
export type WatchSessionID = typeof WatchSessionID.Type

/** How the session of an MCP Events subscription Console serves starts. */
export const SUBSCRIPTION_PREFIX = "mcp:"

/**
 * Whether a watch's session is an MCP Events subscription's, not a coding session's: its prefix in any case, so a
 * client's `MCP:…` is never taken for a coding session's either.
 */
export const isSubscription = (sessionID: string) => sessionID.toLowerCase().startsWith(SUBSCRIPTION_PREFIX)

/**
 * The coding session a watch wakes, as its client names it, such as OpenCode's `ses_…`; never one that reads as a
 * subscription's, which only Console makes.
 */
export const SessionID = WatchSessionID.check(
  Schema.makeFilter((value: string) => !isSubscription(value), {
    title: `a session ID not starting with ${SUBSCRIPTION_PREFIX}`,
  }),
)
export type SessionID = typeof SessionID.Type

/** Where an event comes from: `slack`, `github`, or the slug of the MCP server that sent it. */
export const Source = Schema.NonEmptyString.check(Schema.isMaxLength(64))
export type Source = typeof Source.Type

/**
 * When a watch ends before it expires: `once` after its first event, `until_settled` after an event that settles what
 * it follows (a finished run, a merged pull request), and `sliding` and `fixed` never. Each event pushes a sliding
 * watch's expiry back, but a merged or closed pull request's or issue's becomes fixed for its last 30 minutes; a fixed
 * one lasts exactly as long as it was made for, as an MCP Events subscription's lease does.
 */
export const Mode = Schema.Literals(["once", "until_settled", "sliding", "fixed"])
export type Mode = typeof Mode.Type

/** An event type's name, such as `github.pull_request` or an MCP server's own `issue.updated`. */
export const EventName = Schema.NonEmptyString.check(Schema.isMaxLength(128))
export type EventName = typeof EventName.Type

/** A JSON object, such as an MCP server's event payload. */
export const JsonObject = Schema.Record(Schema.String, Schema.Json)
export type JsonObject = typeof JsonObject.Type

/**
 * What an event is about, which the watches it wakes match exactly: `slack:<team>:<channel>:<rootTs>`,
 * `slack:<team>:<channel>`, `slack:<team>:<channel>:top`, `github:<owner>/<repo>#<number>`,
 * `github:<owner>/<repo>@<sha>`, `github:<owner>/<repo>:run:<runID>` or `github:<owner>/<repo>:branch:<branch>`.
 * GitHub owners and repositories are lowercase, since GitHub ignores their case; everything else keeps its own.
 */
export const RoutingKey = Schema.String.check(Schema.isMaxLength(191)).pipe(Schema.brand("EventWatch.RoutingKey"))
export type RoutingKey = typeof RoutingKey.Type

/** A Slack workspace's team ID. */
export const SlackTeamID = Schema.NonEmptyString.check(Schema.isTrimmed()).pipe(Schema.brand("SlackTeamId"))
export type SlackTeamID = typeof SlackTeamID.Type

/** A Slack channel's, group DM's or DM's ID. */
export const SlackConversationID = Schema.NonEmptyString.pipe(Schema.brand("SlackConversationId"))
export type SlackConversationID = typeof SlackConversationID.Type

/** A Slack message timestamp. They carry microseconds; a seventh fraction digit would misorder them. */
export const SlackTimestamp = Schema.String.check(Schema.isPattern(/^[0-9]+\.[0-9]{1,6}$/)).pipe(
  Schema.brand("SlackTimestamp"),
)
export type SlackTimestamp = typeof SlackTimestamp.Type

/** A GitHub repository as lowercase `owner/repo`. */
export const Repo = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/)).pipe(
  Schema.brand("EventWatch.Repo"),
)
export type Repo = typeof Repo.Type

const Count = Schema.Int.check(Schema.isGreaterThan(0))

/**
 * What a session can watch. A Slack link names its workspace by host rather than team ID, so a Slack target read from
 * one has no `teamID` until the member's Slack connection supplies it.
 */
export const Target = Schema.Union([
  Schema.TaggedStruct("SlackThread", {
    teamID: Schema.optionalKey(SlackTeamID),
    channelID: SlackConversationID,
    threadTs: SlackTimestamp,
  }),
  Schema.TaggedStruct("SlackChannel", { teamID: Schema.optionalKey(SlackTeamID), channelID: SlackConversationID }),
  /** Only the new top-level messages people post in a channel or group DM: no replies, edits or bots' posts. */
  Schema.TaggedStruct("SlackChannelTop", {
    teamID: Schema.optionalKey(SlackTeamID),
    channelID: SlackConversationID,
  }),
  Schema.TaggedStruct("GitHubIssue", { repo: Repo, number: Count }),
  Schema.TaggedStruct("GitHubCommit", { repo: Repo, sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)) }),
  Schema.TaggedStruct("GitHubRun", { repo: Repo, runID: Count }),
  Schema.TaggedStruct("GitHubBranch", { repo: Repo, branch: Schema.NonEmptyString }),
])
export type Target = typeof Target.Type

/** An event's ID, by which an inbox drops the same event delivered twice. */
export const EventID = Schema.NonEmptyString.check(Schema.isMaxLength(128))
export type EventID = typeof EventID.Type

/** The most a stored event takes, as JSON; an inbox cuts a longer body to fit. */
export const MAX_EVENT_BYTES = 8192

/** One event on a watched key, as the watch's member receives it to wake the session. */
export const WatchEvent = Schema.Struct({
  id: EventID,
  watchID: ID,
  sessionID: WatchSessionID,
  source: Source,
  routingKey: RoutingKey,
  kind: Schema.Literals([
    "message",
    "edit",
    "comment",
    "review",
    "state",
    "workflow_run",
    "workflow_job",
    "check",
    "deployment",
    /**
     * A new top-level message in a channel the session posted in, which may have nothing to do with the session, even
     * when the member wrote it: never their instructions to it.
     */
    "channel_post",
    /** An MCP server's own event, which `eventName` names and `data` holds. */
    "event",
  ]),
  actor: Schema.Struct({
    id: Schema.String,
    /** Without control characters. */
    login: Schema.String,
    /** An app or bot posted it, including one of the principal's other sessions through Console's gateway. */
    bot: Schema.Boolean,
    /**
     * Whether the watch's own principal wrote it, in Slack or GitHub directly, such as a member's reply from their phone:
     * their words, not a third party's. Known for Slack, where Console has their Slack user; false for GitHub, whose
     * sign-ins don't record the account, and for anything an app or bot posted, even as them. What one of their sessions
     * posts through Console's gateway never wakes that session, and reaches their others as a bot's.
     */
    self: Schema.Boolean,
  }),
  /**
   * A short label of what it's about, such as `owner/repo#12` or `#C01GENERAL thread`, without control characters;
   * never a sentence. The client writes the sentence.
   */
  title: Schema.String,
  /**
   * What someone wrote, raw and untrusted: a comment, a review, a message, a pull request's title. Never fenced or
   * escaped here; the client fences it once. Cut to 4,000 characters, which keeps an event under 8 KiB.
   */
  body: Schema.String.check(Schema.isMaxLength(4000)),
  url: Schema.String,
  /**
   * Where what it follows now stands, such as `failure`, `merged` or `approved`, without control characters; null for
   * a message.
   */
  status: Schema.NullOr(Schema.String),
  /** Whether it settles what it follows, which ends an `until_settled` watch. */
  terminal: Schema.Boolean,
  occurredAt: Schema.Date,
  /** The event type of the watch it woke. */
  eventName: Schema.optionalKey(EventName),
  /** What it's about, as the event type's `payloadSchema` describes it: IDs and states, never what someone wrote. */
  data: Schema.optionalKey(JsonObject),
})
export type WatchEvent = typeof WatchEvent.Type

/** The most events in one `snapshot` or `events` frame, and in one poll's answer. */
export const PAGE = 200

/**
 * What Console sends a client on its event stream: every event it hasn't acknowledged when it connects, as `snapshot`
 * frames of at most `PAGE` events, then each batch as it's ready, the events of one watch together.
 */
export const ServerMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), events: Schema.Array(WatchEvent) }),
  Schema.Struct({ type: Schema.Literal("events"), events: Schema.Array(WatchEvent) }),
])
export type ServerMessage = typeof ServerMessage.Type

/**
 * Where a polling client is in its inbox, to send back as is: an answer holds at most `PAGE` events, and the next poll
 * goes on from the last of them, even partway through a batch.
 */
export const Cursor = Schema.String.check(Schema.isPattern(/^\d{1,15}\.\d{1,15}$/))
export type Cursor = typeof Cursor.Type

/**
 * A poll's answer, for a client whose WebSocket can't connect: the events it hasn't acknowledged, and the cursor to poll
 * after next, so it isn't sent the events it leaves for the member's other machines again.
 */
export const Poll = Schema.Struct({ cursor: Cursor, events: Schema.Array(WatchEvent) })
export type Poll = typeof Poll.Type

/** The most events one acknowledgement names. */
export const MAX_ACK_IDS = 1000
export const AckIDs = Schema.Array(EventID).check(Schema.isMaxLength(MAX_ACK_IDS))

/**
 * What a client sends back: the events it handed to its sessions. A client acknowledges only its own sessions' events,
 * so the member's other machines still get theirs.
 */
export const ClientMessage = Schema.Struct({ type: Schema.Literal("ack"), ids: AckIDs })
export type ClientMessage = typeof ClientMessage.Type

/**
 * The longest `ack` message a socket may send, its `MAX_ACK_IDS` IDs each 128 characters with their quotes and comma;
 * any longer is refused before it's read.
 */
export const MAX_CLIENT_MESSAGE = MAX_ACK_IDS * 131 + 64

/**
 * The close code a socket gets when its authorization lease ends: its client connects again, through Console's sign-in
 * check, and gets a new one.
 */
export const LEASE_ENDED = 4401
