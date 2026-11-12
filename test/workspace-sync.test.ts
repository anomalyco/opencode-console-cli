import { afterEach, expect, test } from "bun:test"
import type { ConfigPolicy } from "@opencode/schema/config/policy"
import { Effect, Fiber, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { ConsoleCredentials } from "../src/credentials"
import { WorkspaceSnapshot } from "../src/snapshot"
import { ConsoleStore } from "../src/store"
import { WorkspaceSync } from "../src/workspace-sync"
import {
  against,
  type FakeConsole,
  fakeConsole,
  removeStores,
  save,
  signIn,
  temporaryStore,
  until,
} from "./support/console"

afterEach(removeStores)

const policies: ConfigPolicy.Info[] = [{ action: "tool.use", resource: "shell:rm *", effect: "deny" }]

// Signed in with a token that outlives the test clock, so syncs never refresh it.
const signedIn = (console: FakeConsole) => {
  const store = temporaryStore()
  save(store, signIn(console, Number.MAX_SAFE_INTEGER))
  return store
}

const run = <A, E>(body: Effect.Effect<A, E, never>) => Effect.runPromise(body.pipe(Effect.provide(TestClock.layer())))

const sync = (console: FakeConsole, store: ConsoleStore.Info, options?: { force?: boolean }) =>
  WorkspaceSync.sync(store, options).pipe(against(console))

test("fetches the workspace config and reuses it for a minute", async () => {
  const console = fakeConsole({ config: () => Response.json({ policies }) })
  const store = signedIn(console)

  const fetches = await run(
    Effect.gen(function* () {
      const first = yield* sync(console, store)
      expect(first.snapshot?.organization).toBe("Acme")
      expect(WorkspaceSnapshot.policies(WorkspaceSnapshot.read(store))).toEqual(policies)
      yield* TestClock.adjust("59 seconds")
      yield* sync(console, store)
      const withinAMinute = console.state.configs
      yield* TestClock.adjust("1 second")
      yield* sync(console, store)
      const afterAMinute = console.state.configs
      yield* sync(console, store, { force: true })
      return [withinAMinute, afterAMinute, console.state.configs]
    }),
  )

  expect(fetches).toEqual([1, 2, 3])
})

test("records that the member may keep event watches only while the config answer carries the header", async () => {
  const header = { current: true }
  const console = fakeConsole({
    config: () => Response.json({}, { headers: header.current ? { "x-opencode-event-watches": "1" } : {} }),
  })
  const store = signedIn(console)

  const watches = await run(
    Effect.gen(function* () {
      yield* sync(console, store)
      const announced = WorkspaceSnapshot.watches(WorkspaceSnapshot.read(store))
      header.current = false
      yield* sync(console, store, { force: true })
      return [announced, WorkspaceSnapshot.watches(WorkspaceSnapshot.read(store))]
    }),
  )

  expect(watches).toEqual([true, false])
})

test("stores the instructions and skills the Console serves the member beside the config", async () => {
  const console = fakeConsole({
    instructions: () =>
      Response.json({ instructions: [{ id: "ins_1", name: "Security", content: "Never log secrets." }] }),
    skills: () => Response.json({ skills: [{ slug: "deploy", version: "skl_1:2" }] }),
  })
  const store = signedIn(console)

  await run(sync(console, store))

  const stored = WorkspaceSnapshot.read(store)
  expect([WorkspaceSnapshot.instructions(stored), WorkspaceSnapshot.skills(stored)]).toEqual([
    [{ name: "Security", content: "Never log secrets." }],
    [{ slug: "deploy", version: "skl_1:2" }],
  ])
})

test("reads instructions and skills only while the config answer says the member has them, and has none otherwise", async () => {
  const served = { current: true }
  const console = fakeConsole({
    instructionsSkills: () => served.current,
    instructions: () => Response.json({ instructions: [{ id: "ins_1", name: "Style", content: "Use tabs." }] }),
    skills: () => Response.json({ skills: [{ slug: "deploy", version: "skl_1:1" }] }),
  })
  const store = signedIn(console)
  const listReads = () =>
    console.state.requests.filter((request) => /\/api\/v2\/(instructions|skills)$/.test(new URL(request.url).pathname))
      .length

  const result = await run(
    Effect.gen(function* () {
      yield* sync(console, store)
      const readsWithHeader = listReads()
      served.current = false
      const without = yield* sync(console, store, { force: true })
      return { readsWithHeader, readsWithout: listReads() - readsWithHeader, without }
    }),
  )

  expect(result.readsWithHeader).toBe(2)
  expect(result.readsWithout).toBe(0)
  expect([result.without.snapshot?.instructions, result.without.snapshot?.skills]).toEqual([[], []])
})

test("leaves out a skill whose slug can't name a folder", async () => {
  const console = fakeConsole({
    skills: () =>
      Response.json({
        skills: [
          { slug: "../escape", version: "skl_1:1" },
          { slug: "deploy", version: "skl_2:1" },
        ],
      }),
  })
  const store = signedIn(console)

  const result = await run(sync(console, store))

  expect(WorkspaceSnapshot.skills(result.snapshot)).toEqual([{ slug: "deploy", version: "skl_2:1" }])
})

test("reads a 404 for instructions and skills as none, as a workspace without them answers", async () => {
  const missing = { current: false }
  const console = fakeConsole({
    instructions: () =>
      missing.current
        ? Response.json({ _tag: "NotFound" }, { status: 404 })
        : Response.json({ instructions: [{ id: "ins_1", name: "Style", content: "Use tabs." }] }),
    skills: () =>
      missing.current
        ? Response.json({ _tag: "NotFound" }, { status: 404 })
        : Response.json({ skills: [{ slug: "deploy", version: "skl_1:1" }] }),
  })
  const store = signedIn(console)

  const result = await run(
    Effect.gen(function* () {
      yield* sync(console, store)
      missing.current = true
      return yield* sync(console, store, { force: true })
    }),
  )

  expect(result.error).toBeUndefined()
  expect([result.snapshot?.instructions, result.snapshot?.skills]).toEqual([[], []])
})

test("keeps the last instructions and skills when they fail to load, and still takes the new config", async () => {
  const failing = { current: false }
  const console = fakeConsole({
    config: () => Response.json(failing.current ? { policies } : {}),
    instructions: () =>
      failing.current
        ? new Response("unavailable", { status: 503 })
        : Response.json({ instructions: [{ id: "ins_1", name: "Style", content: "Use tabs." }] }),
    skills: () =>
      failing.current
        ? new Response("unavailable", { status: 503 })
        : Response.json({ skills: [{ slug: "deploy", version: "skl_1:1" }] }),
  })
  const store = signedIn(console)

  const result = await run(
    Effect.gen(function* () {
      yield* sync(console, store)
      failing.current = true
      return yield* sync(console, store, { force: true })
    }),
  )

  expect(WorkspaceSnapshot.policies(result.snapshot)).toEqual(policies)
  expect([WorkspaceSnapshot.instructions(result.snapshot), WorkspaceSnapshot.skills(result.snapshot)]).toEqual([
    [{ name: "Style", content: "Use tabs." }],
    [{ slug: "deploy", version: "skl_1:1" }],
  ])
})

// Where the Console has the member send usage metadata (`GET /api/v2/stats`).
const stats = {
  otlpLogsUrl: "https://console.test/console/api/otel/v1/logs",
  headers: { authorization: "Bearer ocstats_1" },
}

test("stores where usage metadata goes, and clears it once the Console answers 404, collecting none", async () => {
  const collecting = { current: true }
  const console = fakeConsole({
    stats: () => (collecting.current ? Response.json(stats) : Response.json({ _tag: "NotFound" }, { status: 404 })),
  })
  const store = signedIn(console)

  const [first, second] = await run(
    Effect.gen(function* () {
      const first = yield* sync(console, store)
      collecting.current = false
      return [first, yield* sync(console, store, { force: true })]
    }),
  )

  expect(first.snapshot?.stats).toEqual(stats)
  expect([second.error, WorkspaceSnapshot.read(store)?.stats]).toEqual([undefined, undefined])
})

test("stores where usage metadata goes under telemetry too, and clears it there, for a 0.1.8 connector's hooks", async () => {
  const collecting = { current: true }
  const console = fakeConsole({
    stats: () => (collecting.current ? Response.json(stats) : Response.json({ _tag: "NotFound" }, { status: 404 })),
  })
  const store = signedIn(console)
  // What a 0.1.8 connector reads from the snapshot file it shares with this one.
  const stored = () => JSON.parse(ConsoleStore.read(ConsoleStore.snapshotFile(store)) ?? "{}").telemetry

  const [first, second] = await run(
    Effect.gen(function* () {
      yield* sync(console, store)
      const first = stored()
      collecting.current = false
      yield* sync(console, store, { force: true })
      return [first, stored()]
    }),
  )

  expect([first, second]).toEqual([stats, undefined])
})

test("keeps where usage metadata goes when it fails to load", async () => {
  const failing = { current: false }
  const console = fakeConsole({
    stats: () => (failing.current ? new Response("unavailable", { status: 503 }) : Response.json(stats)),
  })
  const store = signedIn(console)

  const result = await run(
    Effect.gen(function* () {
      yield* sync(console, store)
      failing.current = true
      return yield* sync(console, store, { force: true })
    }),
  )

  expect(result.snapshot?.stats).toEqual(stats)
})

test("names the CLI and the harness to the Console", async () => {
  const console = fakeConsole()
  const store = signedIn(console)

  await Effect.runPromise(
    WorkspaceSync.sync(store).pipe(
      Effect.provide(
        WorkspaceSync.identify({ version: "0.1.0", harness: "claude-cli/2.1.304" }).pipe(
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, console.fetch),
    ),
  )

  const request = console.state.requests.find((item) => item.url.endsWith("/api/v2/config"))
  expect(request?.headers.get("user-agent")).toBe("claude-cli/2.1.304 opencode-console/0.1.0")
  expect(request?.headers.get("x-opencode-plugin")).toBe("opencode-console/0.1.0")
  expect(request?.headers.get("authorization")).toBe("Bearer access-1")
  expect(request?.headers.get("x-org-id")).toBe("org_acme")
})

test("drops line breaks from the harness name before it goes into a header", () => {
  expect(WorkspaceSync.userAgent({ version: "0.1.0", harness: " claude-cli/2.1.304\r\nx-org-id: org_other " })).toBe(
    "claude-cli/2.1.304x-org-id: org_other opencode-console/0.1.0",
  )
})

test("keeps the last config when the Console is unreachable, so policies never lapse", async () => {
  const answer = { current: () => Response.json({ policies }) }
  const console = fakeConsole({ config: () => answer.current() })
  const store = signedIn(console)

  const result = await run(
    Effect.gen(function* () {
      yield* sync(console, store)
      answer.current = () => new Response("unavailable", { status: 503 })
      yield* TestClock.adjust("2 minutes")
      return yield* sync(console, store)
    }),
  )

  expect(result.error).toBeDefined()
  expect(WorkspaceSnapshot.policies(result.snapshot)).toEqual(policies)
  expect(WorkspaceSnapshot.policies(WorkspaceSnapshot.read(store))).toEqual(policies)
})

test("keeps the last config and says why when the workspace needs SSO again", async () => {
  const answer = { current: () => Response.json({ policies }) }
  const console = fakeConsole({ config: () => answer.current() })
  const store = signedIn(console)

  const result = await run(
    Effect.gen(function* () {
      yield* sync(console, store)
      answer.current = () =>
        Response.json({ _tag: "SsoRequired", orgId: "org_acme", connectionId: "conn_okta" }, { status: 403 })
      yield* TestClock.adjust("2 minutes")
      return yield* sync(console, store)
    }),
  )

  expect(WorkspaceSnapshot.policies(result.snapshot)).toEqual(policies)
  expect(result.snapshot?.status).toEqual({
    message: "Sign in with SSO again to use Acme",
    url: "https://console.test/console/auth/sso/conn_okta/start?redirectTo=%2Fconsole%2F",
  })
})

test("leaves policy unknown, with the reason, when the first fetch needs SSO", async () => {
  const console = fakeConsole({
    config: () => Response.json({ _tag: "SsoRequired", orgId: "org_acme" }, { status: 403 }),
  })
  const store = signedIn(console)

  const result = await run(sync(console, store))

  expect(WorkspaceSnapshot.policies(result.snapshot)).toBeUndefined()
  expect(result.snapshot?.status).toEqual({
    message: "Sign in with SSO again to use Acme",
    url: "https://console.test/console/login?next=%2Fconsole%2F",
  })
})

test("keeps the last config and says to sign in again when the Console ended the sign-in", async () => {
  const answer = { current: () => Response.json({ policies }) }
  const console = fakeConsole({ config: () => answer.current() })
  const store = signedIn(console)

  const result = await run(
    Effect.gen(function* () {
      yield* sync(console, store)
      answer.current = () => Response.json({ _tag: "Unauthorized" }, { status: 401 })
      return yield* sync(console, store, { force: true })
    }),
  )

  expect(WorkspaceSnapshot.policies(result.snapshot)).toEqual(policies)
  expect(result.snapshot?.status?.message).toBe(
    "Signed out of OpenCode Console. Run `npx @opencode/console login` to sign in again",
  )
})

test("leaves policy unknown when the first fetch fails", async () => {
  const console = fakeConsole({ config: () => new Response("unavailable", { status: 503 }) })
  const store = signedIn(console)

  const result = await run(sync(console, store))

  expect(result.error).toBeDefined()
  expect(WorkspaceSnapshot.policies(result.snapshot)).toBeUndefined()
})

test("drops statements whose action a newer Console added, as OpenCode does", async () => {
  const console = fakeConsole({
    config: () => Response.json({ policies: [{ action: "future.use", resource: "*", effect: "deny" }, ...policies] }),
  })
  const store = signedIn(console)

  const result = await run(sync(console, store))

  expect(WorkspaceSnapshot.policies(result.snapshot)).toEqual(policies)
})

test("treats policies it can't read as unknown rather than none", async () => {
  const console = fakeConsole({ config: () => Response.json({ policies: [{ action: "tool.use" }] }) })
  const store = signedIn(console)

  const result = await run(sync(console, store))

  expect(WorkspaceSnapshot.policies(result.snapshot)).toBeUndefined()
})

test("keeps the last config when the Console answers 404, which never means no policies", async () => {
  const answer = { current: () => Response.json({ policies }) }
  const console = fakeConsole({ config: () => answer.current() })
  const store = signedIn(console)

  const result = await run(
    Effect.gen(function* () {
      yield* sync(console, store)
      answer.current = () => new Response(null, { status: 404 })
      return yield* sync(console, store, { force: true })
    }),
  )

  expect(result.error).toBeDefined()
  expect(WorkspaceSnapshot.policies(result.snapshot)).toEqual(policies)
})

test("leaves policy unknown when the first fetch answers 404", async () => {
  const console = fakeConsole({ config: () => new Response(null, { status: 404 }) })
  const store = signedIn(console)

  const result = await run(sync(console, store))

  expect(result.error).toBeDefined()
  expect(WorkspaceSnapshot.policies(result.snapshot)).toBeUndefined()
})

test("never reuses another sign-in's config", async () => {
  const console = fakeConsole({ config: () => new Response("unavailable", { status: 503 }) })
  const store = signedIn(console)
  WorkspaceSnapshot.write(store, {
    owner: JSON.stringify(["https://console.test/console", "usr_ada", "org_other"]),
    organization: "Other",
    fetched: 0,
    config: { policies },
  })

  const result = await run(sync(console, store))

  expect(result.error).toBeDefined()
  expect(result.snapshot).toBeUndefined()
})

test("clears the config once signed out", async () => {
  const console = fakeConsole({ config: () => Response.json({ policies }) })
  const store = signedIn(console)

  const result = await run(
    Effect.gen(function* () {
      yield* sync(console, store)
      ConsoleStore.remove(ConsoleStore.credentialFile(store))
      return yield* sync(console, store)
    }),
  )

  expect(result.snapshot).toBeUndefined()
  expect(WorkspaceSnapshot.read(store)).toBeUndefined()
})

test("discards a fetch that finishes after the member signed out", async () => {
  const release = Promise.withResolvers<void>()
  const console = fakeConsole({ config: () => release.promise.then(() => Response.json({ policies })) })
  const store = signedIn(console)

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const syncing = yield* WorkspaceSync.sync(store).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.promise(() => until(() => console.state.configs === 1))
      yield* ConsoleCredentials.logout(store)
      release.resolve()
      return yield* Fiber.join(syncing)
    }).pipe(against(console)),
  )

  expect(result.snapshot).toBeUndefined()
  expect(WorkspaceSnapshot.read(store)).toBeUndefined()
})
