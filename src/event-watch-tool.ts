export * as EventWatchTool from "./event-watch-tool"

import { EventWatch } from "./event-watch"
import { Option, Schema } from "effect"

/**
 * What a Slack or GitHub tool call that just succeeded through the gateway leaves to watch, and the echo key of what it
 * posted, so the event it raises doesn't wake its poster's own sessions (`EventWatch.echo`). Reads the call's
 * arguments, and its result where only the result names what was made, such as a new pull request's number or a
 * posted message's timestamp. Calls that make nothing to watch, such as drafts and scheduled messages, leave nothing.
 *
 * Echo keys name what was posted however the event about it is keyed: `slack:<channel>:<ts>`,
 * `github:comment:<id>`, `github:review-comment:<id>` and `github:review:<id>`.
 */
export interface Derived {
  /**
   * What to watch as its event type watches it: a post's thread, and after a new top-level post in a channel or group
   * DM, that conversation's new top-level messages too, where people often answer instead of in the thread.
   */
  readonly targets: ReadonlyArray<EventWatch.Target>
  /**
   * What to watch only until its next event (`once`): the whole of a 1:1 DM the session posted in, where the other
   * person may answer outside the thread. Each post arms it again. A group DM's ID doesn't say it's one, so it gets none.
   */
  readonly once?: ReadonlyArray<EventWatch.Target> | undefined
  readonly echo?: string | undefined
}

const Id = Schema.Union([Schema.String, Schema.Number])

/** The arguments of Slack's and GitHub's write tools that name what they write to. */
export const Args = Schema.Struct({
  channel_id: Schema.optionalKey(Schema.String),
  thread_ts: Schema.optionalKey(Schema.String),
  owner: Schema.optionalKey(Schema.String),
  repo: Schema.optionalKey(Schema.String),
  pullNumber: Schema.optionalKey(Id),
  issue_number: Schema.optionalKey(Id),
  method: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
  run_id: Schema.optionalKey(Id),
})
export interface Args extends Schema.Schema.Type<typeof Args> {}

const Sha = Schema.Struct({ sha: Schema.optionalKey(Schema.String) })

/** What a write's JSON result may say it made. */
const Answer = Schema.Struct({
  /** The conversation Slack posted in, which a DM's call names only by its other member's user ID. */
  channel: Schema.optionalKey(Schema.String),
  channel_id: Schema.optionalKey(Schema.String),
  ts: Schema.optionalKey(Schema.String),
  message_ts: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.Struct({ ts: Schema.optionalKey(Schema.String) })),
  /** Where Slack's MCP server says `slack_send_message` posted. */
  message_context: Schema.optionalKey(
    Schema.Struct({ channel_id: Schema.optionalKey(Schema.String), message_ts: Schema.optionalKey(Schema.String) }),
  ),
  id: Schema.optionalKey(Id),
  number: Schema.optionalKey(Id),
  sha: Schema.optionalKey(Schema.String),
  head: Schema.optionalKey(Sha),
  commit: Schema.optionalKey(Sha),
  object: Schema.optionalKey(Sha),
})
interface Answer extends Schema.Schema.Type<typeof Answer> {}

const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Answer))

/** `texts` are the result's text blocks: JSON for most of GitHub's tools, prose with a permalink for some of Slack's. */
export const derive = (
  server: "slack" | "github",
  tool: string,
  args: Args,
  texts: ReadonlyArray<string>,
): Derived | undefined => {
  const result = {
    text: texts.join("\n"),
    answers: texts.flatMap((text) => Option.toArray(decodeAnswer(text))),
  }
  return server === "slack" ? slack(tool, args, result) : github(tool, args, result)
}

interface Result {
  readonly text: string
  readonly answers: ReadonlyArray<Answer>
}

/** The first answer `read` finds anything in. */
const first = (result: Result, read: (answer: Answer) => string | number | undefined) =>
  result.answers
    .map(read)
    .find((value) => value !== undefined)
    ?.toString()

const SLACK_TS = /^\d+\.\d{6}$/

const slack = (tool: string, args: Args, result: Result): Derived | undefined => {
  if (tool !== "slack_send_message" && tool !== "slack_complete_file_upload") return undefined
  // The conversation as Slack answered it: a DM's call names it by the other person's user ID (`U…`), and its events
  // by the DM's own (`D…`).
  // A JSON answer escapes the permalink's slashes (`archives\/D01…`).
  const permalink = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(result.text.replaceAll("\\/", "/"))
  const channel =
    first(result, (answer) => answer.channel ?? answer.channel_id ?? answer.message_context?.channel_id) ??
    permalink?.[1] ??
    args.channel_id
  if (channel === undefined) return undefined
  const posted = [
    first(
      result,
      (answer) => answer.ts ?? answer.message_ts ?? answer.message?.ts ?? answer.message_context?.message_ts,
    ),
    permalink === null ? undefined : `${permalink[2]}.${permalink[3]}`,
  ].find((ts) => ts !== undefined && SLACK_TS.test(ts))
  const root = args.thread_ts ?? posted
  return {
    targets: [
      ...(root === undefined
        ? []
        : Option.toArray(
            Schema.decodeUnknownOption(EventWatch.Target)({ _tag: "SlackThread", channelID: channel, threadTs: root }),
          )),
      ...(args.thread_ts === undefined && !channel.startsWith("D")
        ? Option.toArray(Schema.decodeUnknownOption(EventWatch.Target)({ _tag: "SlackChannelTop", channelID: channel }))
        : []),
    ],
    // A 1:1 DM's ID starts with `D`: it's watched whole, until its next event.
    ...(channel.startsWith("D")
      ? {
          once: Option.toArray(
            Schema.decodeUnknownOption(EventWatch.Target)({ _tag: "SlackChannel", channelID: channel }),
          ),
        }
      : {}),
    echo: posted === undefined ? undefined : `slack:${channel}:${posted}`,
  }
}

const github = (tool: string, args: Args, result: Result): Derived | undefined => {
  if (args.owner === undefined || args.repo === undefined) return undefined
  const repo = `${args.owner}/${args.repo}`.toLowerCase()
  const issue = (number: string | number | undefined) =>
    number === undefined
      ? []
      : Option.toArray(
          Schema.decodeUnknownOption(EventWatch.Target)({ _tag: "GitHubIssue", repo, number: Number(number) }),
        )
  const commit = (sha: string | undefined) =>
    sha === undefined
      ? []
      : Option.toArray(
          Schema.decodeUnknownOption(EventWatch.Target)({ _tag: "GitHubCommit", repo, sha: sha.toLowerCase() }),
        )
  const id = (anchor: string) =>
    first(result, (answer) => answer.id) ?? new RegExp(`#${anchor}(\\d+)`).exec(result.text)?.[1]
  switch (tool) {
    case "create_pull_request":
      return {
        targets: [
          ...issue(first(result, (answer) => answer.number) ?? /\/pull\/(\d+)/.exec(result.text)?.[1]),
          ...commit(first(result, (answer) => answer.head?.sha)),
        ],
      }
    case "update_pull_request":
    case "update_pull_request_branch":
      return { targets: issue(args.pullNumber) }
    case "add_issue_comment": {
      const comment = id("issuecomment-")
      return {
        targets: issue(args.issue_number),
        echo: comment === undefined ? undefined : `github:comment:${comment}`,
      }
    }
    case "add_reply_to_pull_request_comment": {
      const comment = id("discussion_r")
      return {
        targets: issue(args.pullNumber),
        echo: comment === undefined ? undefined : `github:review-comment:${comment}`,
      }
    }
    case "pull_request_review_write": {
      if (args.method !== "create" && args.method !== "submit_pending") return undefined
      const review = id("pullrequestreview-")
      return {
        targets: issue(args.pullNumber),
        echo: review === undefined ? undefined : `github:review:${review}`,
      }
    }
    case "push_files":
    case "create_or_update_file":
    case "delete_file":
    case "merge_pull_request":
      return { targets: commit(first(result, (answer) => answer.commit?.sha ?? answer.object?.sha ?? answer.sha)) }
    case "run_workflow":
      return {
        targets:
          args.ref === undefined
            ? []
            : Option.toArray(
                Schema.decodeUnknownOption(EventWatch.Target)({ _tag: "GitHubBranch", repo, branch: args.ref }),
              ),
      }
    case "rerun_workflow_run":
    case "rerun_failed_jobs":
      return {
        targets:
          args.run_id === undefined
            ? []
            : Option.toArray(
                Schema.decodeUnknownOption(EventWatch.Target)({ _tag: "GitHubRun", repo, runID: Number(args.run_id) }),
              ),
      }
    default:
      return undefined
  }
}
