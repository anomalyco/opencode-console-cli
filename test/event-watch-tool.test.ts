import { describe, expect, it } from "bun:test"
import { EventWatchTool } from "../src/event-watch-tool"

/** `derive`, its targets read as plain data, as they go over the wire. */
const derive: (
  ...args: Parameters<typeof EventWatchTool.derive>
) => { readonly targets?: unknown; readonly once?: unknown; readonly echo?: unknown } | undefined =
  EventWatchTool.derive

/** A result of one text block. */
const text = (value: string) => [value]

describe("EventWatchTool.derive", () => {
  it("watches the thread a Slack reply went to, and names the reply by the permalink Slack answered with", () => {
    expect(
      derive(
        "slack",
        "slack_send_message",
        { channel_id: "C01GENERAL", thread_ts: "1762516800.000100" },
        text("Sent: https://acme.slack.com/archives/C01GENERAL/p1762516900000200?thread_ts=1762516800.000100"),
      ),
    ).toEqual({
      targets: [{ _tag: "SlackThread", channelID: "C01GENERAL", threadTs: "1762516800.000100" }],
      echo: "slack:C01GENERAL:1762516900.000200",
    })
  })

  it("watches the thread a new Slack message starts, under the message's own timestamp, and the channel's top level", () => {
    expect(
      derive(
        "slack",
        "slack_send_message",
        { channel_id: "C01GENERAL" },
        text(JSON.stringify({ ok: true, ts: "1762516900.000200" })),
      )?.targets,
    ).toEqual([
      { _tag: "SlackThread", channelID: "C01GENERAL", threadTs: "1762516900.000200" },
      { _tag: "SlackChannelTop", channelID: "C01GENERAL" },
    ])
  })

  it("watches a DM by the conversation Slack posted in, though the call named the person", () => {
    expect(
      derive(
        "slack",
        "slack_send_message",
        { channel_id: "U01ALICE" },
        text(JSON.stringify({ ok: true, channel: "D01ALICE", ts: "1762516900.000200" })),
      ),
    ).toEqual({
      targets: [{ _tag: "SlackThread", channelID: "D01ALICE", threadTs: "1762516900.000200" }],
      once: [{ _tag: "SlackChannel", channelID: "D01ALICE" }],
      echo: "slack:D01ALICE:1762516900.000200",
    })
  })

  it("watches the whole of a 1:1 DM a reply went to until its next event, besides the reply's thread", () => {
    const derived = derive(
      "slack",
      "slack_send_message",
      { channel_id: "U01BOB", thread_ts: "1762516800.000100" },
      text(JSON.stringify({ ok: true, channel: "D01BOB", ts: "1762516900.000200" })),
    )

    expect({ targets: derived?.targets, once: derived?.once }).toEqual({
      targets: [{ _tag: "SlackThread", channelID: "D01BOB", threadTs: "1762516800.000100" }],
      once: [{ _tag: "SlackChannel", channelID: "D01BOB" }],
    })
  })

  it("watches only the thread of a channel reply, never the channel's top level or the whole channel", () => {
    const derived = derive(
      "slack",
      "slack_send_message",
      { channel_id: "C01GENERAL", thread_ts: "1762516800.000100" },
      text(JSON.stringify({ ok: true, channel: "C01GENERAL", ts: "1762516900.000200" })),
    )

    expect({ targets: derived?.targets, once: derived?.once }).toEqual({
      targets: [{ _tag: "SlackThread", channelID: "C01GENERAL", threadTs: "1762516800.000100" }],
      once: undefined,
    })
  })

  it("reads a DM's conversation from the permalink Slack answered with", () => {
    expect(
      derive(
        "slack",
        "slack_send_message",
        { channel_id: "U01ALICE", thread_ts: "1762516800.000100" },
        text("Sent: https://acme.slack.com/archives/D01ALICE/p1762516900000200"),
      )?.echo,
    ).toBe("slack:D01ALICE:1762516900.000200")
  })

  it("watches a new DM from what Slack's MCP server answers, its permalink's slashes escaped", () => {
    expect(
      derive(
        "slack",
        "slack_send_message",
        { channel_id: "U01ALICE" },
        // As mcp.slack.com answered `slack_send_message` on 2026-11-08.
        text(
          '{"message_link":"https:\\/\\/acme.slack.com\\/archives\\/D01ALICE\\/p1762516900000200","message_context":{"message_ts":"1762516900.000200","channel_id":"D01ALICE"}}',
        ),
      ),
    ).toEqual({
      targets: [{ _tag: "SlackThread", channelID: "D01ALICE", threadTs: "1762516900.000200" }],
      once: [{ _tag: "SlackChannel", channelID: "D01ALICE" }],
      echo: "slack:D01ALICE:1762516900.000200",
    })
  })

  it("names a reply from the escaped permalink when the answer has no message_context", () => {
    expect(
      derive(
        "slack",
        "slack_send_message",
        { channel_id: "U01ALICE", thread_ts: "1762516800.000100" },
        text('{"message_link":"https:\\/\\/acme.slack.com\\/archives\\/D01ALICE\\/p1762516900000200"}'),
      )?.echo,
    ).toBe("slack:D01ALICE:1762516900.000200")
  })

  it("watches nothing for a Slack draft", () => {
    expect(derive("slack", "slack_send_message_draft", { channel_id: "C01GENERAL" }, text("{}"))).toBeUndefined()
  })

  it("watches a new pull request and its head commit, in lowercase", () => {
    expect(
      derive(
        "github",
        "create_pull_request",
        { owner: "Acme", repo: "Web" },
        text(
          JSON.stringify({
            id: "PR_kwDOabc",
            url: "https://github.com/acme/web/pull/12",
            head: { sha: "0123456789abcdef0123456789abcdef01234567" },
          }),
        ),
      )?.targets,
    ).toEqual([
      { _tag: "GitHubIssue", repo: "acme/web", number: 12 },
      { _tag: "GitHubCommit", repo: "acme/web", sha: "0123456789abcdef0123456789abcdef01234567" },
    ])
  })

  it("names a comment by its ID, so its own webhook doesn't wake the session that posted it", () => {
    expect(
      derive(
        "github",
        "add_issue_comment",
        { owner: "acme", repo: "web", issue_number: 12 },
        text(
          JSON.stringify({
            id: "3412345678",
            url: "https://github.com/acme/web/issues/12#issuecomment-3412345678",
          }),
        ),
      ),
    ).toEqual({
      targets: [{ _tag: "GitHubIssue", repo: "acme/web", number: 12 }],
      echo: "github:comment:3412345678",
    })
  })

  it("watches the branch a dispatched workflow runs on, before GitHub names the run", () => {
    expect(
      derive("github", "run_workflow", { owner: "acme", repo: "web", ref: "fix-cart" }, text("{}"))?.targets,
    ).toEqual([{ _tag: "GitHubBranch", repo: "acme/web", branch: "fix-cart" }])
  })

  it("watches nothing a commit write doesn't name the commit of", () => {
    expect(derive("github", "push_files", { owner: "acme", repo: "web" }, text("done"))?.targets).toEqual([])
  })
})
