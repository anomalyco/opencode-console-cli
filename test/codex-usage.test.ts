import { expect, test } from "bun:test"
import { CodexUsage } from "../src/codex-usage"

// Codex 0.167.0's `PostModelRequest` hook input (`model-request.command.input.schema.json`), with every field it sends.
const hook = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: "019a6f-session",
    turn_id: "turn-7",
    transcript_path: "/home/ada/.codex/sessions/rollout.jsonl",
    cwd: "/home/ada/secret-project",
    hook_event_name: "PostModelRequest",
    model: "gpt-5.4",
    status: "completed",
    error: null,
    token_usage: {
      input_tokens: 1200,
      cached_input_tokens: 800,
      cache_write_input_tokens: 100,
      output_tokens: 300,
      reasoning_output_tokens: 120,
      total_tokens: 1500,
    },
    ...fields,
  })
const now = Date.parse("2026-11-07T12:00:00.000Z")
const stats = {
  otlpLogsUrl: "https://console.test/console/api/otel/v1/logs",
  headers: { authorization: "Bearer ocstats_1" },
}

test("exports a completed response as the record Codex's own exporter sends, with only its counts, model, conversation and time", () => {
  expect(CodexUsage.exportRequest(hook(), { version: "0.167.0", now })).toEqual({
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.version", value: { stringValue: "0.167.0" } }] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1794052800000000000",
                attributes: [
                  { key: "event.name", value: { stringValue: "codex.sse_event" } },
                  { key: "event.kind", value: { stringValue: "response.completed" } },
                  { key: "event.timestamp", value: { stringValue: "2026-11-07T12:00:00.000Z" } },
                  { key: "conversation.id", value: { stringValue: "019a6f-session" } },
                  { key: "model", value: { stringValue: "gpt-5.4" } },
                  { key: "slug", value: { stringValue: "gpt-5.4" } },
                  { key: "input_token_count", value: { stringValue: "1200" } },
                  { key: "output_token_count", value: { stringValue: "300" } },
                  { key: "cached_token_count", value: { intValue: "800" } },
                  { key: "cache_write_token_count", value: { intValue: "100" } },
                  { key: "reasoning_token_count", value: { intValue: "120" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  })
})

test("counts no cache writes when Codex doesn't report them", () => {
  const exported = CodexUsage.exportRequest(
    hook({
      token_usage: {
        input_tokens: 10,
        cached_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 0,
        total_tokens: 12,
      },
    }),
    { now },
  )

  expect(exported?.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.attributes).toContainEqual({
    key: "cache_write_token_count",
    value: { intValue: "0" },
  })
})

test("exports nothing for a request that failed or was cancelled", () => {
  expect([
    CodexUsage.exportRequest(hook({ status: "failed", error: "stream disconnected" }), { now }),
    CodexUsage.exportRequest(hook({ status: "cancelled" }), { now }),
  ]).toEqual([undefined, undefined])
})

test("exports nothing when Codex has no token counts for the request", () => {
  expect(CodexUsage.exportRequest(hook({ token_usage: null }), { now })).toBeUndefined()
})

test("exports nothing for a gateway model, which the gateway already counts", () => {
  expect([
    CodexUsage.exportRequest(hook({ model: "opencode-go/kimi-k2.5" }), { now }),
    CodexUsage.exportRequest(hook({ model: "console-acme-openai/gpt-5.4" }), { now }),
  ]).toEqual([undefined, undefined])
})

test("posts the export's body to the workspace's receiver with its headers, following no redirect", async () => {
  const sent: Array<{ url: string; init: RequestInit }> = []
  const body = '{"resourceLogs":[]}'

  await CodexUsage.post(body, stats, {}, async (url, init) => {
    sent.push({ url, init })
    return new Response("{}")
  })

  expect(
    sent.map((item) => [item.url, item.init.method, item.init.headers, item.init.redirect, item.init.body]),
  ).toEqual([
    [
      "https://console.test/console/api/otel/v1/logs",
      "POST",
      { authorization: "Bearer ocstats_1", "content-type": "application/json" },
      "error",
      body,
    ],
  ])
})

test("posts nothing while the workspace collects no usage metadata", async () => {
  const sent: string[] = []

  await CodexUsage.post("{}", undefined, {}, async (url) => sent.push(url))

  expect(sent).toEqual([])
})

test("gives up on a receiver that doesn't answer in time", async () => {
  const ended: string[] = []

  await CodexUsage.post("{}", stats, { timeout: 20 }, (_url, init) => {
    return new Promise((_resolve, reject) =>
      init.signal?.addEventListener("abort", () => {
        ended.push("aborted")
        reject(new Error("timed out"))
      }),
    )
  })

  expect(ended).toEqual(["aborted"])
})

test("drops a report the receiver can't take rather than fail", async () => {
  const reported = CodexUsage.post("{}", stats, {}, () => Promise.reject(new Error("unreachable")))

  expect(await reported).toBeUndefined()
})

const cliCommand = ["/opt/node/bin/node", "/data/opencode-console/cli/index.js"]

test("hands the export to a report process of the CLI's own, so the hook returns at once", () => {
  const started: Array<{ readonly command: readonly string[]; readonly body: string }> = []

  CodexUsage.reportInBackground(hook(), stats, { version: "0.167.0", now, command: cliCommand }, (command, body) =>
    started.push({ command, body }),
  )

  const sent = started[0]
  expect(sent?.command).toEqual([...cliCommand, "report-codex-usage"])
  // The token reaches the report process through the stored workspace config, never on its command line.
  expect(sent?.command.join(" ")).not.toContain("ocstats_1")
  const attributes = sent && JSON.parse(sent.body).resourceLogs[0].scopeLogs[0].logRecords[0].attributes
  expect(attributes).toContainEqual({ key: "output_token_count", value: { stringValue: "300" } })
})

test("starts no report process while the workspace collects no usage metadata", () => {
  const processes: Array<readonly string[]> = []

  CodexUsage.reportInBackground(hook(), undefined, { now, command: cliCommand }, (command) =>
    processes.push([...command]),
  )

  expect(processes).toEqual([])
})

test("starts no report process for a request that doesn't count", () => {
  const processes: Array<readonly string[]> = []

  CodexUsage.reportInBackground(hook({ status: "failed" }), stats, { now, command: cliCommand }, (command) =>
    processes.push([...command]),
  )

  expect(processes).toEqual([])
})
