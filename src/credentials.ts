export * as ConsoleCredentials from "./credentials"

import { createHash } from "node:crypto"
import { Clock, Duration, Effect, Fiber, Option, Schema } from "effect"
import { ConsoleClient } from "./console-client"
import { ConsoleStore } from "./store"

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(ConsoleClient.OAuth))
// Refresh five minutes early so a token handed to a harness doesn't expire during a long request.
const EXPIRY_MARGIN_MS = 5 * 60_000

/**
 * `OPENCODE_API_KEY` (CI and headless runs) wins over a stored device sign-in. A server named in
 * `OPENCODE_CONSOLE_SERVER` that isn't a valid Console URL throws, so the key is never sent anywhere unintended.
 */
/** A sign-in the member has to fix, such as a corrupt sign-in file; never a fault of the build that read it. */
export class Unusable extends Error {}

export function read(store: ConsoleStore.Info): ConsoleClient.Credential | undefined {
  const key = store.env.OPENCODE_API_KEY
  if (!key) return stored(store)
  const named = store.env.OPENCODE_CONSOLE_SERVER?.trim()
  if (!named) return { type: "key", server: ConsoleClient.defaultServer, key }
  const server = ConsoleClient.normalizeServer(named)
  if (!server)
    throw new Unusable(
      `OPENCODE_CONSOLE_SERVER isn't a Console URL: ${named}. Use an https:// URL, or http:// only for localhost.`,
    )
  return { type: "key", server, key }
}

/**
 * The stored device sign-in, ignoring `OPENCODE_API_KEY`. A sign-in file that exists but can't be read or decoded
 * throws, so a check fails closed instead of acting signed out.
 */
export function stored(store: ConsoleStore.Info) {
  const loaded = load(store)
  if (loaded.corrupt)
    throw new Unusable(
      `The sign-in in ${ConsoleStore.credentialFile(store)} can't be read. Run \`npx @opencode/console login\` to replace it or \`npx @opencode/console logout\` to remove it.`,
    )
  return loaded.credential
}

/**
 * Identifies the member and workspace a credential acts as, so a workspace config is only ever reused for the
 * sign-in it was fetched for. A key carries no member or workspace, so a fingerprint of the key stands in.
 */
export function owner(credential: ConsoleClient.Credential) {
  return JSON.stringify([
    credential.server,
    credential.type === "key"
      ? createHash("sha256").update(credential.key).digest("hex").slice(0, 16)
      : credential.accountID,
    credential.type === "oauth" ? credential.orgID : undefined,
  ])
}

/** The workspace a credential signed in to, as its members know it. */
export function organization(credential: ConsoleClient.Credential) {
  return credential.type === "oauth" ? credential.orgName : undefined
}

/**
 * Runs the Console's device sign-in, asking `prompt` to show the code, and stores the new sign-in. The one it replaces
 * is revoked, and its workspace config is kept only when both act as the same member in the same workspace.
 */
export const login = Effect.fn("ConsoleCredentials.login")(function* (
  store: ConsoleStore.Info,
  input: { readonly server: string; readonly prompt: (device: { url: string; code: string }) => Effect.Effect<void> },
) {
  const device = yield* ConsoleClient.authorize(input.server)
  yield* input.prompt(device)
  const credential = yield* device.callback
  const previous = yield* ConsoleStore.locked(
    store,
    Effect.sync(() => {
      // A sign-in that can't be decoded is replaced like any other.
      const previous = load(store).credential
      ConsoleStore.write(ConsoleStore.credentialFile(store), JSON.stringify(credential))
      if (!previous || owner(previous) !== owner(credential)) ConsoleStore.remove(ConsoleStore.snapshotFile(store))
      return previous
    }),
  )
  if (previous) yield* ConsoleClient.revoke(previous).pipe(Effect.ignore)
  return credential
})

/**
 * The current credential with an access token that won't expire for at least a minute, refreshing it when needed.
 *
 * Console refresh tokens are single-use and reusing one revokes the whole sign-in, while harnesses ask for tokens
 * from many processes at once. A refresh therefore runs under the store's lock, re-reads the sign-in another process
 * may already have rotated, and runs detached: a caller that stops waiting can't cancel a rotation the Console may
 * already have accepted before the new tokens are saved.
 */
export const fresh = Effect.fn("ConsoleCredentials.fresh")(function* (store: ConsoleStore.Info) {
  const current = read(store)
  if (!current || current.type === "key" || !(yield* expiring(current))) return current
  const rotation = yield* ConsoleStore.locked(
    store,
    Effect.gen(function* () {
      const latest = stored(store)
      if (!latest || !(yield* expiring(latest))) return latest
      const refreshed = yield* ConsoleClient.refresh(latest).pipe(Effect.timeout(Duration.seconds(30)))
      // Saved only over the sign-in it rotated: one removed or replaced while the refresh ran stays that way.
      if (load(store).credential?.refresh !== latest.refresh) return stored(store)
      ConsoleStore.write(ConsoleStore.credentialFile(store), JSON.stringify(refreshed))
      return refreshed
    }),
  ).pipe(Effect.forkDetach)
  return yield* Fiber.join(rotation)
})

/** Forgets the stored sign-in and its workspace config, and ends the session on the Console when it can. */
export const logout = Effect.fn("ConsoleCredentials.logout")(function* (store: ConsoleStore.Info) {
  const previous = yield* ConsoleStore.locked(
    store,
    Effect.sync(() => {
      // A sign-in that can't be decoded is still removed.
      const previous = load(store).credential
      ConsoleStore.remove(ConsoleStore.credentialFile(store))
      ConsoleStore.remove(ConsoleStore.snapshotFile(store))
      ConsoleStore.remove(ConsoleStore.watchesFile(store))
      return previous
    }),
  )
  if (!previous) return false
  // Signing out here must not depend on reaching the Console.
  yield* ConsoleClient.revoke(previous).pipe(Effect.ignore)
  return true
})

function expiring(credential: ConsoleClient.OAuth) {
  return Clock.currentTimeMillis.pipe(Effect.map((now) => credential.expires - EXPIRY_MARGIN_MS <= now))
}

function load(store: ConsoleStore.Info): { readonly credential?: ConsoleClient.OAuth; readonly corrupt?: true } {
  const text = ConsoleStore.read(ConsoleStore.credentialFile(store))
  if (text === undefined) return {}
  const credential = Option.getOrUndefined(decode(text))
  return credential ? { credential } : { corrupt: true }
}
