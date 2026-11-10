export * as InProcess from "./in-process"

import { fileURLToPath } from "node:url"
import { Effect, Layer } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { version } from "../package.json" with { type: "json" }
import { ConsoleCredentials } from "./credentials"
import { PolicyEvaluator } from "./policy-evaluator"
import { WorkspaceSnapshot } from "./snapshot"
import { ConsoleStore } from "./store"
import { AutoUpdate } from "./update/auto-update"
import { WorkspaceSync } from "./workspace-sync"

/**
 * The workspace state an extension running inside a coding agent's own process reads (the Pi extension, the DeepSeek
 * Harness plugin), kept apart from the agent so it runs against a stand-in Console in tests.
 */
export interface Session {
  readonly store: ConsoleStore.Info
  /** Runs a Console request as this CLI, from the agent's process. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) => Promise<A>
}

export function session(
  input: { readonly store?: ConsoleStore.Info; readonly harness?: string; readonly fetch?: typeof fetch } = {},
): Session {
  const layer = WorkspaceSync.identify({ version, harness: input.harness }).pipe(Layer.provide(FetchHttpClient.layer))
  const stand = input.fetch
  return {
    store: input.store ?? ConsoleStore.make(),
    run: (effect) =>
      Effect.runPromise(
        stand
          ? effect.pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, stand))
          : effect.pipe(Effect.provide(layer)),
      ),
  }
}

// One refresh at a time per process, so a burst of tool calls on a stale config starts one fetch.
const refreshing = new WeakMap<Session, Promise<unknown>>()

/**
 * Fetches the workspace config, joining a fetch already running in this process, and starts a background update of the
 * installed CLI when one is due: the agent loaded this module from it, as `hook`'s agents run it.
 */
export function refresh(state: Session) {
  const running = refreshing.get(state)
  if (running) return running
  const started = state.run(WorkspaceSync.sync(state.store)).finally(() => refreshing.delete(state))
  refreshing.set(state, started)
  void Promise.resolve()
    .then(() => AutoUpdate.start(state.store, { running: fileURLToPath(import.meta.url) }))
    .catch(() => undefined)
  return started
}

/** Decides checks as `check` does, from the stored config. The first denial wins. */
export async function decide(state: Session, inputs: readonly PolicyEvaluator.Input[]) {
  return (await decisions(state, inputs)).find((decision) => decision.effect === "deny")
}

/** Each check's decision, against one read of the stored config. */
export async function decisions(state: Session, inputs: readonly PolicyEvaluator.Input[]) {
  const credential = ConsoleCredentials.read(state.store)
  const workspace = WorkspaceSnapshot.workspace(credential, credential && (await config(state)))
  return Effect.runPromise(Effect.forEach(inputs, (item) => PolicyEvaluator.check(workspace, item)))
}

/**
 * The stored config for the current sign-in. A stale one is used and refreshed in the background for the next call,
 * so the agent never waits on the Console; a sign-in with none yet waits up to 3 seconds for its first.
 */
export async function config(state: Session) {
  const credential = ConsoleCredentials.read(state.store)
  if (!credential) return undefined
  const owner = ConsoleCredentials.owner(credential)
  const cached = WorkspaceSync.current(state.store, owner)
  if (!cached)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000)
      timer.unref?.()
      refresh(state)
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(timer)
          resolve()
        })
    })
  else if (WorkspaceSnapshot.stale(cached, Date.now())) refreshStale(state)
  return WorkspaceSync.current(state.store, owner)
}

/**
 * Refreshes a stale config in the background, at most once every 30 seconds across every process using the store, as
 * `check` does, so a Console outage doesn't send a request on every tool call. Returns whether it started one.
 */
export function refreshStale(state: Session) {
  const claim = ConsoleStore.syncClaimFile(state.store)
  const claimed = ConsoleStore.modified(claim)
  if (claimed !== undefined && Date.now() - claimed < 30_000) return false
  ConsoleStore.write(claim, "")
  void refresh(state).catch(() => undefined)
  return true
}
