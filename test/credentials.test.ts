import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, statSync } from "node:fs"
import path from "node:path"
import { Effect, Fiber } from "effect"
import { ConsoleClient } from "../src/console-client"
import { ConsoleCredentials } from "../src/credentials"
import { WorkspaceSnapshot } from "../src/snapshot"
import { ConsoleStore } from "../src/store"
import { against, fakeConsole, removeStores, save, server, signIn, temporaryStore, until } from "./support/console"

afterEach(removeStores)

const now = () => Date.now()

test("signs in with the device flow as its own client, scoped to a workspace", async () => {
  const store = temporaryStore()
  const console = fakeConsole()
  const shown: string[] = []

  const credential = await Effect.runPromise(
    ConsoleCredentials.login(store, {
      server,
      prompt: (device) => Effect.sync(() => shown.push(`${device.url} ${device.code}`)),
    }).pipe(against(console)),
  )

  expect(shown).toEqual([`${server}/device?user_code=ABCD-EFGH&client_id=opencode-console-cli ABCD-EFGH`])
  const start = console.state.requests.find((request) => request.url.endsWith("/auth/device/code"))
  expect(start?.body).toEqual({ client_id: "opencode-console-cli", supports_org_scope: true })
  expect(credential).toMatchObject({
    accountID: "usr_ada",
    email: "ada@example.com",
    orgID: "org_acme",
    orgName: "Acme",
  })
  expect(ConsoleCredentials.stored(store)).toEqual(credential)
  // Readable only by this user, the directory included.
  expect(statSync(ConsoleStore.credentialFile(store)).mode & 0o777).toBe(0o600)
  expect(statSync(store.data).mode & 0o777).toBe(0o700)
})

test("stops a sign-in whose approval link points at another site", async () => {
  const store = temporaryStore()
  const console = fakeConsole({ verification: "https://relay.test/console/device" })
  const shown: string[] = []

  const result = await Effect.runPromise(
    ConsoleCredentials.login(store, {
      server,
      prompt: (device) => Effect.sync(() => shown.push(device.url)),
    }).pipe(against(console), Effect.flip),
  )

  expect(result).toMatchObject({ message: expect.stringContaining("sent a sign-in link to another site") })
  expect(shown).toEqual([])
  expect(ConsoleCredentials.stored(store)).toBeUndefined()
})

test("never follows a redirect with a code or token in the request", async () => {
  const store = temporaryStore()
  const console = fakeConsole()
  save(store, signIn(console, now() + 30_000))

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* ConsoleCredentials.login(store, { server, prompt: () => Effect.void })
      yield* ConsoleCredentials.logout(store)
    }).pipe(against(console)),
  )

  const posts = console.state.requests.filter((request) => !request.url.includes("/api/"))
  expect(posts.map((request) => new URL(request.url).pathname)).toEqual([
    "/console/auth/device/code",
    "/console/auth/device/token",
    "/console/auth/oauth/revoke",
    "/console/auth/oauth/revoke",
  ])
  expect(posts.map((request) => request.redirect)).toEqual(["manual", "manual", "manual", "manual"])
})

test("creates the directories its lock lives in readable only by this user", async () => {
  const store = temporaryStore()

  await Effect.runPromise(ConsoleCredentials.logout(store).pipe(against(fakeConsole())))

  expect(statSync(store.data).mode & 0o777).toBe(0o700)
  expect(statSync(path.join(store.data, "locks")).mode & 0o777).toBe(0o700)
})

test("keeps a directory it reuses readable only by this user", () => {
  const store = temporaryStore()
  mkdirSync(store.cache, { recursive: true, mode: 0o755 })
  chmodSync(store.cache, 0o755)

  ConsoleStore.write(ConsoleStore.snapshotFile(store), "{}")

  expect(statSync(store.cache).mode & 0o777).toBe(0o700)
})

test("revokes the sign-in it replaces, keeping the config only for the same member and workspace", async () => {
  const store = temporaryStore()
  const console = fakeConsole()
  const snapshot = { owner: "acme", fetched: now(), config: {} }
  save(store, { ...signIn(console, now() + 3_600_000), refresh: "refresh-old" })
  WorkspaceSnapshot.write(store, snapshot)
  const login = () =>
    Effect.runPromise(ConsoleCredentials.login(store, { server, prompt: () => Effect.void }).pipe(against(console)))

  await login()
  expect(console.state.revoked).toEqual(["refresh-old"])
  expect(WorkspaceSnapshot.read(store)).toEqual(snapshot)

  save(store, { ...signIn(console, now() + 3_600_000), orgID: "org_other", orgName: "Other" })
  await login()
  expect(WorkspaceSnapshot.read(store)).toBeUndefined()
})

test("refreshes once when many callers find the token expiring at the same time", async () => {
  const store = temporaryStore()
  const console = fakeConsole()
  save(store, signIn(console, now() + 30_000))

  const results = await Effect.runPromise(
    Effect.all(
      Array.from({ length: 10 }, () => ConsoleCredentials.fresh(store)),
      { concurrency: "unbounded" },
    ).pipe(against(console)),
  )

  expect(console.state.refreshes).toBe(1)
  expect(console.state.revokedFamily).toBe(false)
  expect(results.map((credential) => credential?.type === "oauth" && credential.access)).toEqual(
    Array(10).fill("access-2"),
  )
  expect(ConsoleCredentials.stored(store)?.refresh).toBe("refresh-2")
})

test("finishes a refresh the caller stopped waiting for, so its single-use token is never sent twice", async () => {
  const store = temporaryStore()
  const console = fakeConsole()
  save(store, signIn(console, now() + 30_000))

  // The fake Console takes 20ms to rotate, longer than this caller waits.
  await Effect.runPromise(ConsoleCredentials.fresh(store).pipe(Effect.timeoutOption("5 millis"), against(console)))
  await until(() => ConsoleCredentials.stored(store)?.refresh === "refresh-2")
  const next = await Effect.runPromise(ConsoleCredentials.fresh(store).pipe(against(console)))

  expect(next?.type === "oauth" && next.access).toBe("access-2")
  expect(console.state.refreshes).toBe(1)
  expect(console.state.revokedFamily).toBe(false)
})

test("signs out after a refresh in flight finishes, revoking the rotated sign-in", async () => {
  const answer = Promise.withResolvers<void>()
  const store = temporaryStore()
  const console = fakeConsole({ refreshing: () => answer.promise })
  save(store, signIn(console, now() + 30_000))

  await Effect.runPromise(
    Effect.gen(function* () {
      const refreshing = yield* ConsoleCredentials.fresh(store).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.promise(() =>
        until(() => console.state.requests.some((request) => request.url.endsWith("/auth/device/token"))),
      )
      const signingOut = yield* ConsoleCredentials.logout(store).pipe(Effect.forkChild({ startImmediately: true }))
      answer.resolve()
      yield* Fiber.join(refreshing)
      yield* Fiber.join(signingOut)
    }).pipe(against(console)),
  )

  expect(ConsoleCredentials.stored(store)).toBeUndefined()
  // The sign-out waited for the rotation, so it ended the live session rather than the spent token.
  expect(console.state.revoked).toEqual(["refresh-2"])
})

test("never writes a refreshed sign-in over one removed while the refresh ran", async () => {
  const answer = Promise.withResolvers<void>()
  const store = temporaryStore()
  const console = fakeConsole({ refreshing: () => answer.promise })
  save(store, signIn(console, now() + 30_000))

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const refreshing = yield* ConsoleCredentials.fresh(store).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.promise(() =>
        until(() => console.state.requests.some((request) => request.url.endsWith("/auth/device/token"))),
      )
      ConsoleStore.remove(ConsoleStore.credentialFile(store))
      answer.resolve()
      return yield* Fiber.join(refreshing)
    }).pipe(against(console)),
  )

  expect(result).toBeUndefined()
  expect(ConsoleCredentials.stored(store)).toBeUndefined()
})

test("refreshes a token that expires within five minutes", async () => {
  const store = temporaryStore()
  const console = fakeConsole()
  save(store, signIn(console, now() + 4 * 60_000))

  const credential = await Effect.runPromise(ConsoleCredentials.fresh(store).pipe(against(console)))

  expect(credential?.type === "oauth" && credential.access).toBe("access-2")
})

test("keeps a token that isn't about to expire without calling the Console", async () => {
  const store = temporaryStore()
  const console = fakeConsole()
  save(store, signIn(console, now() + 3_600_000))

  const credential = await Effect.runPromise(ConsoleCredentials.fresh(store).pipe(against(console)))

  expect(credential?.type === "oauth" && credential.access).toBe("access-1")
  expect(console.state.requests).toEqual([])
})

test("uses OPENCODE_API_KEY over a stored sign-in, on the Console OPENCODE_CONSOLE_SERVER names", async () => {
  const store = temporaryStore({ OPENCODE_API_KEY: "oc_sk_ci", OPENCODE_CONSOLE_SERVER: "https://acme.test/console/" })
  const console = fakeConsole()
  save(store, signIn(console, 0))

  const credential = await Effect.runPromise(ConsoleCredentials.fresh(store).pipe(against(console)))

  expect(credential).toEqual({ type: "key", key: "oc_sk_ci", server: "https://acme.test/console" })
  expect(console.state.requests).toEqual([])
})

test("signs out locally and ends the session on the Console", async () => {
  const store = temporaryStore()
  const console = fakeConsole()
  save(store, signIn(console, now() + 3_600_000))
  WorkspaceSnapshot.write(store, { owner: "acme", fetched: now(), config: {} })

  expect(await Effect.runPromise(ConsoleCredentials.logout(store).pipe(against(console)))).toBe(true)

  expect(console.state.revoked).toEqual(["refresh-1"])
  expect(ConsoleCredentials.stored(store)).toBeUndefined()
  expect(WorkspaceSnapshot.read(store)).toBeUndefined()
})

test("signs out locally even when the Console is unreachable", async () => {
  const store = temporaryStore()
  const console = fakeConsole({ revoke: () => new Response(null, { status: 503 }) })
  save(store, signIn(console, now() + 3_600_000))

  expect(await Effect.runPromise(ConsoleCredentials.logout(store).pipe(against(console)))).toBe(true)

  expect(ConsoleCredentials.stored(store)).toBeUndefined()
})

test("refuses to send OPENCODE_API_KEY when OPENCODE_CONSOLE_SERVER isn't a Console URL", () => {
  expect(() =>
    ConsoleCredentials.read(
      temporaryStore({ OPENCODE_API_KEY: "oc_sk_ci", OPENCODE_CONSOLE_SERVER: "console.acme.test" }),
    ),
  ).toThrow("OPENCODE_CONSOLE_SERVER isn't a Console URL")
  expect(() =>
    ConsoleCredentials.read(
      temporaryStore({ OPENCODE_API_KEY: "oc_sk_ci", OPENCODE_CONSOLE_SERVER: "http://console.acme.test" }),
    ),
  ).toThrow("OPENCODE_CONSOLE_SERVER isn't a Console URL")
})

test("accepts http only for a Console on this machine", () => {
  expect(ConsoleClient.normalizeServer("http://localhost:3000/console/")).toBe("http://localhost:3000/console")
  expect(ConsoleClient.normalizeServer("http://127.0.0.1:3000/console")).toBe("http://127.0.0.1:3000/console")
  expect(ConsoleClient.normalizeServer("http://[::1]:3000/console")).toBe("http://[::1]:3000/console")
  expect(ConsoleClient.normalizeServer("http://console.acme.test/console")).toBeUndefined()
  expect(ConsoleClient.normalizeServer("https://console.acme.test/console/")).toBe("https://console.acme.test/console")
})

test("treats a sign-in file it can't decode as an error, not as signed out", () => {
  const store = temporaryStore()
  ConsoleStore.write(ConsoleStore.credentialFile(store), "{ not json")

  expect(() => ConsoleCredentials.stored(store)).toThrow("can't be read")
})

test("treats a sign-in file it can't open as an error, not as signed out", () => {
  const store = temporaryStore()
  ConsoleStore.write(ConsoleStore.credentialFile(store), "{}")
  chmodSync(ConsoleStore.credentialFile(store), 0o000)

  expect(() => ConsoleCredentials.stored(store)).toThrow("EACCES")
})

test("replaces a sign-in file it can't decode when signing in", async () => {
  const store = temporaryStore()
  const console = fakeConsole()
  ConsoleStore.write(ConsoleStore.credentialFile(store), "{ not json")

  await Effect.runPromise(ConsoleCredentials.login(store, { server, prompt: () => Effect.void }).pipe(against(console)))

  expect(ConsoleCredentials.stored(store)?.access).toBe("access-1")
})

test("removes a sign-in file it can't decode when signing out", async () => {
  const store = temporaryStore()
  const console = fakeConsole()
  ConsoleStore.write(ConsoleStore.credentialFile(store), "{ not json")

  await Effect.runPromise(ConsoleCredentials.logout(store).pipe(against(console)))

  expect(ConsoleStore.read(ConsoleStore.credentialFile(store))).toBeUndefined()
})
