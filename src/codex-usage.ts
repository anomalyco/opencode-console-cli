export * as CodexUsage from "./codex-usage"

import { spawn } from "node:child_process"
import { Option, Schema } from "effect"
import type { WorkspaceSnapshot } from "./snapshot"

/**
 * The fields of Codex's `PostModelRequest` hook input this reads (Codex 0.164.0+,
 * `codex-rs/hooks/schema/generated/model-request.command.input.schema.json` in openai/codex): the session, the model,
 * how the request ended and its token counts. The transcript, directory and everything else stay out.
 */
const Input = Schema.Struct({
  hook_event_name: Schema.Literal("PostModelRequest"),
  session_id: Schema.String,
  model: Schema.String,
  status: Schema.String,
  // `TokenUsage` in `codex-rs/protocol/src/protocol.rs`: `input_tokens` includes the cached ones.
  token_usage: Schema.NullOr(
    Schema.Struct({
      input_tokens: Schema.Number,
      cached_input_tokens: Schema.Number,
      cache_write_input_tokens: Schema.optional(Schema.Number),
      output_tokens: Schema.Number,
      reasoning_output_tokens: Schema.Number,
    }),
  ),
})
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Input))

/** How long the report process's post may take; nothing waits for it, so a slow receiver loses one report. */
const TIMEOUT_MS = 5_000

/** The command that posts one report the hook built. Only `hook codex` starts it, so it stays out of `--help`. */
export const REPORT_COMMAND = "report-codex-usage"

/**
 * The OTLP/HTTP JSON logs export for one completed model response, as the one record Codex's own exporter would send
 * for it (`codex.sse_event` for `response.completed`, `codex-rs/otel/src/events/session_telemetry.rs`), with only its
 * token counts, model, conversation and time. Undefined for anything else: a failed or cancelled request, one without
 * counts, or a gateway model, which the gateway already counts.
 */
export function exportRequest(text: string, options: { readonly version?: string | undefined; readonly now: number }) {
  const input = Option.getOrUndefined(decode(text))
  const usage = input?.token_usage
  if (!input || input.status !== "completed" || !usage || input.model === "") return undefined
  if (input.model.startsWith("opencode-go/") || input.model.startsWith("console-")) return undefined
  const counts = {
    input: usage.input_tokens,
    cached: usage.cached_input_tokens,
    written: usage.cache_write_input_tokens ?? 0,
    output: usage.output_tokens,
    reasoning: usage.reasoning_output_tokens,
  }
  if (Object.values(counts).some((count) => !Number.isSafeInteger(count) || count < 0)) return undefined
  // Codex writes its input and output counts as text and the others as integers, which ProtoJSON writes as text too.
  const string = (key: string, value: string) => ({ key, value: { stringValue: value } })
  const int = (key: string, value: number) => ({ key, value: { intValue: String(value) } })
  return {
    resourceLogs: [
      {
        resource: { attributes: options.version === undefined ? [] : [string("service.version", options.version)] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: `${options.now}000000`,
                attributes: [
                  string("event.name", "codex.sse_event"),
                  string("event.kind", "response.completed"),
                  string("event.timestamp", new Date(options.now).toISOString()),
                  string("conversation.id", input.session_id),
                  string("model", input.model),
                  string("slug", input.model),
                  string("input_token_count", String(counts.input)),
                  string("output_token_count", String(counts.output)),
                  int("cached_token_count", counts.cached),
                  int("cache_write_token_count", counts.written),
                  int("reasoning_token_count", counts.reasoning),
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

/**
 * Posts one OTLP/HTTP JSON logs export to the workspace's stats target, when there is one. It never fails: a
 * report that can't be sent is dropped. It doesn't follow redirects, so the token reaches only the workspace's receiver.
 */
export async function post(
  body: string,
  stats: WorkspaceSnapshot.Stats | undefined,
  options: { readonly timeout?: number } = {},
  send: (url: string, init: RequestInit) => Promise<unknown> = fetch,
) {
  if (!stats) return
  await send(stats.otlpLogsUrl, {
    method: "POST",
    headers: { ...stats.headers, "content-type": "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(options.timeout ?? TIMEOUT_MS),
  }).catch(() => undefined)
}

/**
 * Reports a `PostModelRequest` hook's token counts without making the hook wait. The hook is synchronous, so Codex waits
 * for it before dispatching tools; and Codex owns an async hook's work as a background task of the session, which it
 * ends with the session, so `codex exec` cancels the send right after the last reply. A process of its own outlives
 * both.
 */
export function reportInBackground(
  text: string,
  stats: WorkspaceSnapshot.Stats | undefined,
  options: { readonly version?: string | undefined; readonly now: number; readonly command: readonly string[] },
  start: (command: readonly string[], body: string) => void = spawnReport,
) {
  const body = exportRequest(text, options)
  if (!stats || !body) return
  start([...options.command, REPORT_COMMAND], JSON.stringify(body))
}

/**
 * Starts the report process with the export on its stdin and leaves it behind. No token goes on its command line, where
 * `ps` would show it: the process reads the stored workspace config itself, as the hook does.
 */
function spawnReport(command: readonly string[], body: string) {
  try {
    const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: ["pipe", "ignore", "ignore"] })
    child.on("error", () => undefined)
    // A process that exits before reading its stdin breaks the pipe, and that report is dropped too.
    child.stdin.on("error", () => undefined)
    child.stdin.end(body)
    child.unref()
  } catch {
    // A report that can't be sent is dropped; the hook itself never fails or prints.
  }
}
