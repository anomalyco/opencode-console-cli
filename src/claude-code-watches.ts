export * as ClaudeCodeWatches from "./claude-code-watches"

import type { EventWatch } from "./event-watch"
import { Duration, Effect, Option } from "effect"
import { ClaudeCodeHook } from "./claude-code-hook"
import { ConsoleCredentials } from "./credentials"
import { SettingsFile } from "./settings-file"
import { WorkspaceSnapshot } from "./snapshot"
import type { ConsoleStore } from "./store"
import { ConsoleWatches } from "./watches"
import { WorkspaceSync } from "./workspace-sync"

// Event watches in Claude Code (code.claude.com/docs/en/hooks). Its MCP calls carry no session, so the hooks, which
// know it, keep the watches. `PostToolUse` watches what a Bash command or a workspace MCP tool started. `Stop` runs in
// the background (`asyncRewake`) and waits for the session's next update, then exits 2, which wakes Claude with it even
// while the session sits idle. Past the loop guard's limits (`ConsoleWatches.recordWake`), updates wait for the user's
// next prompt (`UserPromptSubmit`), which counts the session's wakes from zero again. `SessionEnd` stops the wait.

/** Claude Code cuts hook output longer than this to a preview, so a wake stays within it. */
const MAX_TEXT = 10_000

/**
 * `Stop`: waits for the session's next update and answers the text to wake Claude with, or nothing once the wait ends.
 * A session that watches nothing gets what's already waiting for it, if anything, without waiting. Past the loop
 * guard's limits the wait goes on, leaving updates for the user's next prompt, so the member's own reply or a later
 * update once the 10-minute window clears can still wake the session with them. Nothing waits for a session that never
 * kept a watch on this machine, or outside an interactive session (`interactive`).
 */
export const stop = Effect.fnUntraced(function* (
  store: ConsoleStore.Info,
  event: ClaudeCodeHook.Event,
  host: {
    readonly alive: Effect.Effect<boolean>
    /** Claude Code's `CLAUDE_CODE_ENTRYPOINT`, which it gives its hooks. */
    readonly entrypoint: string | undefined
    readonly harness?: string | undefined
  },
) {
  if (!interactive(host.entrypoint)) return undefined
  const sessionID = yield* local(store, event)
  if (sessionID === undefined) return undefined
  const watching = (yield* ConsoleWatches.list(store)).some((watch) => watch.sessionID === sessionID)
  const events = watching
    ? yield* ConsoleWatches.awaitSession({
        store,
        sessionID,
        alive: host.alive,
        harness: host.harness,
        maxText: MAX_TEXT,
        wake: true,
      })
    : yield* ConsoleWatches.takeWaiting(store, sessionID, { maxText: MAX_TEXT, wake: true })
  if (events === undefined || events.length === 0) return undefined
  return ConsoleWatches.wakeText(events, yield* ConsoleWatches.recordWake(store, sessionID, events))
})

/**
 * `UserPromptSubmit`, once the prompt's checks pass: the user is back, so the session's wakes count from zero again,
 * and the updates that waited for them come with the prompt. The prompt waits at most 10 seconds for them. Claude Code
 * runs the hook for turns it starts itself too, such as the one a wake starts, whose prompt is a `<task-notification>`
 * (seen in Claude Code 2.1.319); those leave the count and the waiting updates alone.
 */
export const promptSubmitted = Effect.fnUntraced(function* (store: ConsoleStore.Info, event: ClaudeCodeHook.Event) {
  const sessionID = yield* local(store, event)
  if (sessionID === undefined || event.prompt?.startsWith("<task-notification>")) return undefined
  yield* ConsoleWatches.resetStreak(store, sessionID)
  const events = yield* ConsoleWatches.takeWaiting(store, sessionID, { maxText: MAX_TEXT }).pipe(
    Effect.timeoutOption(Duration.seconds(10)),
  )
  return Option.isSome(events) && events.value.length > 0 ? ConsoleWatches.wakeText(events.value) : undefined
})

/** `SessionEnd`: stops the session's wait, so it can't wake a session that's gone or that `/clear` replaced. */
export const sessionEnded = Effect.fnUntraced(function* (store: ConsoleStore.Info, event: ClaudeCodeHook.Event) {
  const sessionID = yield* local(store, event)
  if (sessionID !== undefined) yield* ConsoleWatches.releaseWaiter(store, sessionID)
})

/**
 * `PostToolUse`: watches what a Bash command or a call to one of the workspace's gateway servers (`gateway`) just
 * started, for the session that made it, and answers what to tell Claude when Console refused a watch
 * (`ConsoleWatches.watchStarted`).
 */
export const postToolUse = Effect.fnUntraced(function* (
  store: ConsoleStore.Info,
  event: ClaudeCodeHook.Event,
  gateway: ReadonlySet<string>,
) {
  const sessionID = event.session_id
  if (!sessionID || !enabled(store)) return undefined
  const created = yield* Effect.forEach(targets(event, gateway), (item) =>
    ConsoleWatches.watchStarted(store, sessionID, item.target, item.mode),
  )
  // A session that keeps a watch here gets its updates here.
  if (created.some((item) => item.watched)) yield* ConsoleWatches.touchSession(store, sessionID)
  const notices = created.flatMap((item) => (item.notice === undefined ? [] : [item.notice]))
  return notices.length === 0 ? undefined : notices.join("\n\n")
})

/**
 * What a finished tool call started that's worth watching: the pull request or branch a Bash command's output names
 * (`git push` reports on stderr), or what a Slack or GitHub write through one of the workspace's `gateway` servers
 * made. `PostToolUse` runs only after a call succeeds, so a Bash command it sees exited 0.
 */
export function targets(
  event: ClaudeCodeHook.Event,
  gateway: ReadonlySet<string>,
): ReadonlyArray<{ readonly target: string | EventWatch.Target; readonly mode?: "once" | undefined }> {
  const tool = event.tool_name ?? ""
  if (tool === "Bash") {
    const command = event.tool_input?.command
    const response = SettingsFile.record(event.tool_response)
    const output = [response.stdout, response.stderr].filter((item) => typeof item === "string").join("\n")
    const target = typeof command === "string" ? ConsoleWatches.shellTarget(command, { exit: 0, output }) : undefined
    return target === undefined ? [] : [{ target }]
  }
  const mcp = ClaudeCodeHook.mcpTool(tool, event.mcp_server?.name)
  if (!mcp || !gateway.has(mcp.server)) return []
  return ConsoleWatches.toolTargets(mcp.tool, event.tool_input ?? {}, texts(event.tool_response))
}

/**
 * Whether Claude Code runs a session someone can come back to. `claude -p` (`sdk-cli`) and the Agent SDK (`sdk-ts`,
 * `sdk-py`) wait for a background `Stop` hook before they exit, so one there would hold the run open for hours; an
 * interactive terminal session is `cli` (both seen in Claude Code 2.1.319). The variable isn't documented, so a Claude
 * Code without it gets its updates on the next prompt instead.
 */
function interactive(entrypoint: string | undefined) {
  return entrypoint !== undefined && entrypoint !== "" && !entrypoint.startsWith("sdk")
}

/** The session the hook is for, when event watches are on and it kept a watch on this machine in the last 72 hours. */
const local = Effect.fnUntraced(function* (store: ConsoleStore.Info, event: ClaudeCodeHook.Event) {
  const sessionID = event.session_id
  if (!sessionID || !enabled(store)) return undefined
  return (yield* ConsoleWatches.localSessions(store)).has(sessionID) ? sessionID : undefined
})

function enabled(store: ConsoleStore.Info) {
  const credential = ConsoleCredentials.read(store)
  return (
    credential !== undefined &&
    WorkspaceSnapshot.watches(WorkspaceSync.current(store, ConsoleCredentials.owner(credential)))
  )
}

// An MCP tool's result as Claude Code passes it: its text, its content blocks, or a result holding them.
function texts(response: unknown): ReadonlyArray<string> {
  if (typeof response === "string") return [response]
  const blocks = Array.isArray(response) ? response : SettingsFile.record(response).content
  if (!Array.isArray(blocks)) return []
  return blocks.flatMap((block) => {
    const text = SettingsFile.record(block).text
    return typeof text === "string" ? [text] : []
  })
}
