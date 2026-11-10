export * as WorkspaceSync from "./workspace-sync"

import { Clock, Effect, Layer, Result } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ConsoleClient } from "./console-client"
import { ConsoleCredentials } from "./credentials"
import { WorkspaceSnapshot } from "./snapshot"
import { ConsoleStore } from "./store"

/**
 * Names the CLI, and the harness it runs for, on every Console request. The Console reads the User-Agent to tell which
 * client a member runs; the harness's own product token comes first so it is the one recognized.
 */
export function identify(input: {
  readonly version: string
  readonly harness?: string | undefined
  /**
   * The agent's own settings have turned its policy hooks off. The Console records this as the client's standing, which
   * is why it rides in a request header and not in the config the Console answers with.
   */
  readonly hooksOff?: boolean | undefined
}) {
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (http) =>
      HttpClient.mapRequest(
        http,
        HttpClientRequest.setHeaders({
          "user-agent": userAgent(input),
          [ConsoleClient.pluginHeader]: `opencode-console/${input.version}${input.hooksOff ? ",hooks-off" : ""}`,
        }),
      ),
    ),
  )
}

export function userAgent(input: { readonly version: string; readonly harness?: string | undefined }) {
  // The harness name comes from a flag or the environment and goes into a header, so line breaks are dropped.
  const harness = input.harness?.replace(/[\r\n]/g, "").trim()
  return [harness, `opencode-console/${input.version}`].filter(Boolean).join(" ")
}

/**
 * Brings the stored workspace config, instructions and skills up to date, as OpenCode does every minute: a snapshot
 * younger than a minute is reused unless `force` is set.
 *
 * A failed fetch for the same sign-in keeps the last snapshot, so a Console outage never lifts the workspace's
 * policies. Signing out, or signing in as another member or workspace, never reuses one. When the sign-in itself needs
 * the member (an expired SSO session, a revoked sign-in) the last snapshot also stays, with the reason in `status`.
 */
export const sync = Effect.fn("WorkspaceSync.sync")(function* (
  store: ConsoleStore.Info,
  options: { readonly force?: boolean } = {},
) {
  const signedIn = ConsoleCredentials.read(store)
  if (!signedIn) {
    yield* ConsoleStore.locked(
      store,
      Effect.sync(() => WorkspaceSnapshot.clear(store)),
    )
    return { snapshot: undefined }
  }
  const now = yield* Clock.currentTimeMillis
  const owner = ConsoleCredentials.owner(signedIn)
  const previous = current(store, owner)
  if (previous && !options.force && !WorkspaceSnapshot.stale(previous, now)) return { snapshot: previous }

  // Instructions, skills and the usage export's target that fail to load keep the last ones, as the config does,
  // without holding up the config. A 404 for the target means the workspace collects nothing, which clears it.
  const outcome = yield* ConsoleCredentials.fresh(store).pipe(
    Effect.flatMap((credential) =>
      credential
        ? Effect.all(
            {
              config: ConsoleClient.fetchConfig(credential),
              instructions: ConsoleClient.fetchInstructions(credential).pipe(
                Effect.map((answer) => answer.instructions),
                Effect.orElseSucceed(() => previous?.instructions),
              ),
              skills: ConsoleClient.fetchSkills(credential).pipe(
                Effect.map((answer) => answer.skills),
                Effect.orElseSucceed(() => previous?.skills),
              ),
              telemetry: ConsoleClient.fetchTelemetry(credential).pipe(Effect.orElseSucceed(() => previous?.telemetry)),
            },
            { concurrency: "unbounded" },
          ).pipe(Effect.map((fetched) => ({ credential, ...fetched })))
        : Effect.succeed(undefined),
    ),
    Effect.result,
  )
  if (Result.isSuccess(outcome)) {
    if (!outcome.success) return { snapshot: undefined }
    const fetched = outcome.success
    return {
      snapshot: yield* publish(store, owner, {
        owner,
        organization: ConsoleCredentials.organization(fetched.credential),
        fetched: now,
        config: fetched.config.config,
        watches: fetched.config.watches,
        ...(fetched.instructions === undefined ? {} : { instructions: fetched.instructions }),
        ...(fetched.skills === undefined ? {} : { skills: fetched.skills }),
        ...(fetched.telemetry === undefined ? {} : { telemetry: fetched.telemetry }),
      }),
    }
  }
  const status = needsMember(outcome.failure)
  if (!status) return { snapshot: previous, error: outcome.failure }
  const fallback = previous ?? { owner, organization: ConsoleCredentials.organization(signedIn) }
  return { snapshot: yield* publish(store, owner, { ...fallback, fetched: now, status }), error: outcome.failure }
})

/** The stored snapshot, when it belongs to `owner`. */
export function current(store: ConsoleStore.Info, owner: string) {
  const snapshot = WorkspaceSnapshot.read(store)
  return snapshot?.owner === owner ? snapshot : undefined
}

/**
 * Stores a snapshot only while the sign-in it was fetched for is still current: a sign-out or switch while the fetch
 * ran makes it stale, and writing it would bring back a config the member already left.
 */
function publish(store: ConsoleStore.Info, owner: string, snapshot: WorkspaceSnapshot.Info) {
  return ConsoleStore.locked(
    store,
    Effect.sync(() => {
      const latest = ConsoleCredentials.read(store)
      if (!latest || ConsoleCredentials.owner(latest) !== owner) return undefined
      WorkspaceSnapshot.write(store, snapshot)
      return snapshot
    }),
  )
}

// Only these answers are about the sign-in; anything else may be transient.
function needsMember(cause: unknown) {
  if (cause instanceof ConsoleClient.SsoRequired) return { message: cause.message, url: cause.url }
  if (cause instanceof ConsoleClient.SignedOut) return { message: cause.message }
  return undefined
}
