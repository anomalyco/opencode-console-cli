export * as CodexWatches from "./codex-watches"

import { Clock, Duration, Effect, Option } from "effect"
import type { CodexHook } from "./codex-hook"
import { ConsoleCredentials } from "./credentials"
import { SettingsFile } from "./settings-file"
import { WorkspaceSnapshot } from "./snapshot"
import type { ConsoleStore } from "./store"
import { ConsoleWatches } from "./watches"
import { WorkspaceSync } from "./workspace-sync"

// Event watches in Codex (developers.openai.com/codex/hooks). Codex can't start a turn on its own: a background hook
// that finishes while no turn runs waits for the user's next one (`codex-rs/core/src/hook_runtime.rs`,
// `drain_async_hook_results`). So updates reach a session three ways, each from the hooks, which know the session:
//
// - With the prompt: `UserPromptSubmit` brings what waited while the session sat idle, and starts the turn.
// - During a turn: a background `UserPromptSubmit` hook waits for the session's next update while the turn runs, and
//   Codex hands what it prints to the next model request. A background `PostToolUse` that watched what a shell
//   command started waits the same way when nothing else does.
// - At the turn's end: `Stop` takes what arrived since and continues the turn with it, within the loop guard's limits
//   (`ConsoleWatches.recordWake`); past them, updates wait for the user's next prompt.
//
// Codex's own MCP calls name the session, so the Console's gateway and `mcp-watches` watch for it without a hook.

/** Codex hands the model hook text longer than about 2,500 tokens as a preview, so updates stay within it. */
const MAX_TEXT = 8_000
/** How long a turn's background hook waits for `UserPromptSubmit` to take what waited, longer than that hook may run. */
const PROMPT_HANDLED = Duration.seconds(40)

/**
 * `UserPromptSubmit`, once the prompt's checks pass: takes the updates that waited for the user, which the prompt waits
 * at most 10 seconds for, and starts the turn, which counts the session's wakes from zero again.
 */
export const promptSubmitted = Effect.fnUntraced(function* (store: ConsoleStore.Info, event: CodexHook.Event) {
  const sessionID = event.session_id
  if (!sessionID || !enabled(store)) return undefined
  const events = yield* ConsoleWatches.takeWaiting(store, sessionID, { maxText: MAX_TEXT }).pipe(
    Effect.timeoutOption(Duration.seconds(10)),
    Effect.option,
    Effect.map((taken) => Option.getOrUndefined(Option.flatten(taken)) ?? []),
  )
  if (event.turn_id) yield* ConsoleWatches.beginTurn(store, sessionID, event.turn_id)
  return events.length === 0 ? undefined : ConsoleWatches.wakeText(events)
})

/**
 * The background `UserPromptSubmit` hook: once the prompt's own hook took what waited, waits while the turn runs for
 * the session's next update, if it watches anything, and answers its text for the turn's next model request.
 */
export const duringTurn = Effect.fnUntraced(function* (
  store: ConsoleStore.Info,
  event: CodexHook.Event,
  host: { readonly alive: Effect.Effect<boolean>; readonly harness?: string | undefined },
) {
  const sessionID = event.session_id
  const turn = event.turn_id
  if (!sessionID || !turn || !enabled(store)) return undefined
  // Codex starts both prompt hooks at once; waiting before the prompt's hook takes would take its updates.
  if (!(yield* started(store, sessionID, turn))) return undefined
  const watching = (yield* ConsoleWatches.list(store)).some((watch) => watch.sessionID === sessionID)
  return watching ? yield* wait(store, sessionID, turn, host) : undefined
})

/**
 * `PostToolUse`, in the background: watches the pull request or branch a shell command's output names for the session,
 * then, when nothing waits for the session's updates during the turn yet, waits for them as `duringTurn` does. When
 * Console refused the watch, it answers what to tell Codex instead (`ConsoleWatches.watchStarted`).
 */
export const postToolUse = Effect.fnUntraced(function* (
  store: ConsoleStore.Info,
  event: CodexHook.Event,
  host: { readonly alive: Effect.Effect<boolean>; readonly harness?: string | undefined },
) {
  const sessionID = event.session_id
  const command = SettingsFile.record(event.tool_input).command
  if (!sessionID || event.tool_name !== "Bash" || typeof command !== "string" || !enabled(store)) return undefined
  // Codex passes no exit code, but `gh pr create` prints its pull request, and `git push` its updated branch, only
  // when they succeed.
  const output = typeof event.tool_response === "string" ? event.tool_response : ""
  const target = ConsoleWatches.shellTarget(command, { exit: 0, output })
  if (target === undefined) return undefined
  const created = yield* ConsoleWatches.watchStarted(store, sessionID, target)
  if (!created.watched) return created.notice
  yield* ConsoleWatches.touchSession(store, sessionID)
  const turn = event.turn_id
  if (!turn || (yield* ConsoleWatches.awaited(store, sessionID))) return undefined
  if (!(yield* ConsoleWatches.turnRunning(store, sessionID, turn))) return undefined
  return yield* wait(store, sessionID, turn, host)
})

/**
 * `Stop`: continues the turn with the updates that arrived during it, while they may wake the session
 * (`ConsoleWatches.mayWake`); otherwise the turn ends and they wait for the user's next prompt.
 */
export const stop = Effect.fnUntraced(function* (store: ConsoleStore.Info, event: CodexHook.Event) {
  const sessionID = event.session_id
  if (!sessionID || !enabled(store)) return undefined
  const events = yield* ConsoleWatches.takeWaiting(store, sessionID, { maxText: MAX_TEXT, wake: true })
  if (events.length === 0) {
    yield* ConsoleWatches.endTurn(store, sessionID)
    yield* ConsoleWatches.releaseWaiter(store, sessionID)
    return undefined
  }
  return ConsoleWatches.wakeText(events, yield* ConsoleWatches.recordWake(store, sessionID, events))
})

/** `Interrupt`: the user stopped the turn, so nothing waits for its updates any more. */
export const interrupted = Effect.fnUntraced(function* (store: ConsoleStore.Info, event: CodexHook.Event) {
  const sessionID = event.session_id
  if (!sessionID || !enabled(store)) return
  yield* ConsoleWatches.endTurn(store, sessionID)
  yield* ConsoleWatches.releaseWaiter(store, sessionID)
})

/** Waits for the session's next update while `turn` runs and Codex does, and answers its text. */
const wait = Effect.fnUntraced(function* (
  store: ConsoleStore.Info,
  sessionID: string,
  turn: string,
  host: { readonly alive: Effect.Effect<boolean>; readonly harness?: string | undefined },
) {
  const events = yield* ConsoleWatches.awaitSession({
    store,
    sessionID,
    alive: Effect.all([host.alive, ConsoleWatches.turnRunning(store, sessionID, turn)]).pipe(
      Effect.map((checks) => checks.every(Boolean)),
    ),
    harness: host.harness,
    maxText: MAX_TEXT,
  })
  return events === undefined || events.length === 0 ? undefined : ConsoleWatches.wakeText(events)
})

/** Whether the prompt's own hook started `turn`, waiting up to `PROMPT_HANDLED` for it. */
const started = Effect.fnUntraced(function* (store: ConsoleStore.Info, sessionID: string, turn: string) {
  const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(PROMPT_HANDLED)
  while (!(yield* ConsoleWatches.turnRunning(store, sessionID, turn))) {
    if ((yield* Clock.currentTimeMillis) >= deadline) return false
    yield* Effect.sleep(Duration.millis(100))
  }
  return true
})

function enabled(store: ConsoleStore.Info) {
  const credential = ConsoleCredentials.read(store)
  return (
    credential !== undefined &&
    WorkspaceSnapshot.watches(WorkspaceSync.current(store, ConsoleCredentials.owner(credential)))
  )
}
