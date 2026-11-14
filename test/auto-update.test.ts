import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { CliInstall } from "../src/install"
import { Effect } from "effect"
import { ClaudeCodeHook } from "../src/claude-code-hook"
import { ConsoleCredentials } from "../src/credentials"
import { ConsoleStore } from "../src/store"
import { AutoUpdate } from "../src/update/auto-update"
import { removeStores, temporaryStore } from "./support/console"
import { installRelease, removeReleases, script } from "./support/release"

// Hooks decide whether an update check is due and start it in its own process; only that process start is stood in
// for here (self-update.test.ts runs the update itself). Self-tests run the stand-in binaries for real.
afterEach(() => {
  removeStores()
  removeReleases()
})

const HOUR = 3_600_000

// Hooks crash one after another, each its own process.
async function crashes<A>(count: number, crash: () => Promise<A>) {
  const results: A[] = []
  for (const _ of Array.from({ length: count })) results.push(await crash())
  return results
}

function starts() {
  const started: string[][] = []
  return { started, start: (command: readonly string[]) => void started.push([...command]) }
}

test("starts a background update from the installed binary when none has run", () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const { started, start } = starts()

  expect(AutoUpdate.start(store, { running: live, now: 10 * HOUR, env: {}, start })).toBe("started")
  expect(started).toEqual([[live, "self-update"]])
  expect(AutoUpdate.read(store).checkedAt).toBe(10 * HOUR)
})

test("checks at most hourly between session starts", () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const { started, start } = starts()
  AutoUpdate.update(store, () => ({ checkedAt: 10 * HOUR }))

  expect(AutoUpdate.start(store, { running: live, now: 11 * HOUR - 1, env: {}, start })).toBe("recent")
  expect(AutoUpdate.start(store, { running: live, now: 11 * HOUR, env: {}, start })).toBe("started")
  expect(started).toHaveLength(1)
})

test("checks again at a session start a minute after the last check", () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const { started, start } = starts()
  AutoUpdate.update(store, () => ({ checkedAt: 10 * HOUR }))

  expect(AutoUpdate.start(store, { running: live, session: true, now: 10 * HOUR + 59_999, env: {}, start })).toBe(
    "recent",
  )
  expect(AutoUpdate.start(store, { running: live, session: true, now: 10 * HOUR + 60_000, env: {}, start })).toBe(
    "started",
  )
  expect(started).toHaveLength(1)
})

test("never updates a binary setup didn't install, such as one IT put in /usr/local/bin", () => {
  const store = temporaryStore()
  installRelease(store, { version: "0.1.8" })
  const elsewhere = path.join(store.cache, "usr", "local", "bin", "opencode-console")
  mkdirSync(path.dirname(elsewhere), { recursive: true })
  writeFileSync(elsewhere, script("0.1.8"))
  const { started, start } = starts()

  expect(AutoUpdate.start(store, { running: elsewhere, env: {}, start })).toBe("unmanaged")
  expect(started).toEqual([])
})

test("never updates an install without a receipt, such as one setup made before updates", () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  writeFileSync(CliInstall.receiptFile(CliInstall.directory(store)), "")
  const { started, start } = starts()

  expect(AutoUpdate.start(store, { running: live, env: {}, start })).toBe("unmanaged")
  expect(started).toEqual([])
})

test("doesn't check with OPENCODE_CONSOLE_AUTO_UPDATE=off", () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const { started, start } = starts()

  expect(AutoUpdate.start(store, { running: live, env: { OPENCODE_CONSOLE_AUTO_UPDATE: "off" }, start })).toBe("off")
  expect(started).toEqual([])
})

test("waits for an update still running", () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  AutoUpdate.update(store, () => ({ installing: { pid: process.pid, startedAt: 10 * HOUR } }))
  const { started, start } = starts()

  expect(AutoUpdate.start(store, { running: live, now: 10 * HOUR + 1, env: {}, start })).toBe("installing")
  expect(started).toEqual([])
})

test("backs a failed install off 15 minutes, then an hour, then four", () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const failedAt = (attempts: number) =>
    AutoUpdate.update(store, () => ({ lastError: { message: "self-test failed", at: 0, attempts } }))
  const at = (now: number) => AutoUpdate.start(store, { running: live, now, env: {}, start: () => undefined })

  failedAt(1)
  expect([at(15 * 60_000 - 1), at(15 * 60_000)]).toEqual(["backoff", "started"])
  failedAt(2)
  expect([at(HOUR - 1), at(HOUR)]).toEqual(["backoff", "started"])
  failedAt(3)
  expect([at(4 * HOUR - 1), at(4 * HOUR)]).toEqual(["backoff", "started"])
})

/**
 * The installed 0.1.9, which replaced `version` (0.1.8 by default), kept in `<data>/cli.prev` with its receipt.
 */
function updated(store: ReturnType<typeof temporaryStore>, previous: "passes" | "fails" = "passes", version = "0.1.8") {
  const live = installRelease(store, { version: "0.1.9", sha256: "9".repeat(64) })
  const kept = CliInstall.previousDirectory(store)
  mkdirSync(kept, { recursive: true })
  writeFileSync(path.join(kept, "opencode-console"), script(version, previous))
  chmodSync(path.join(kept, "opencode-console"), 0o755)
  writeFileSync(
    CliInstall.receiptFile(kept),
    JSON.stringify({
      method: "direct",
      version,
      channel: CliInstall.channelOf(version),
      target: "linux-x64",
      sha256: "8".repeat(64),
    }),
  )
  return live
}

test("rolls back to the last build that worked after three crashed hooks in a row, and refreshes every agent", async () => {
  const store = temporaryStore()
  const live = updated(store)
  const { started, start } = starts()

  const results = await crashes(3, () => AutoUpdate.crashed(store, { running: live, start, now: 5 }))

  expect(results).toEqual(["counted", "counted", "rolled-back"])
  expect(readFileSync(live, "utf8")).toBe(script("0.1.8"))
  expect(CliInstall.receipt(store)).toMatchObject({ version: "0.1.8", sha256: "8".repeat(64) })
  expect(AutoUpdate.read(store)).toMatchObject({
    blocked: [{ version: "0.1.9", sha256: "9".repeat(64) }],
    lastUpdate: { from: "0.1.9", to: "0.1.8", at: 5 },
  })
  expect(AutoUpdate.read(store).crashes).toBeUndefined()
  expect(started).toEqual([[live, "sync", "--quiet", "--refresh-agents"]])
})

test("never rolls back to, or self-tests, a build kept from another channel", async () => {
  const store = temporaryStore()
  const live = updated(store, "passes", "0.1.9-dev.4")
  const { started, start } = starts()
  const selfTests: string[][] = []
  const selfTest = async (command: readonly string[]) => {
    selfTests.push([...command])
    return true
  }

  const results = await crashes(3, () => AutoUpdate.crashed(store, { running: live, selfTest, start }))

  expect(results).toEqual(["counted", "counted", "no-previous"])
  expect(selfTests).toEqual([])
  expect(readFileSync(live, "utf8")).toBe(script("0.1.9"))
  expect(CliInstall.receipt(store)).toMatchObject({ version: "0.1.9", channel: "stable" })
  expect(started).toEqual([])
})

test("reads the channel's manifest again after a rollback, rather than trust the answer that named the bad build", async () => {
  const store = temporaryStore()
  const live = updated(store)
  AutoUpdate.update(store, (state) => ({ ...state, etag: '"names-0.1.9"' }))

  await crashes(3, () => AutoUpdate.crashed(store, { running: live, start: () => undefined }))

  expect(AutoUpdate.read(store).etag).toBeUndefined()
})

test("doesn't roll back for crashes a clean hook interrupted", async () => {
  const store = temporaryStore()
  const live = updated(store)
  const { started, start } = starts()

  await crashes(2, () => AutoUpdate.crashed(store, { running: live, start }))
  AutoUpdate.healthy(store)

  expect(await AutoUpdate.crashed(store, { running: live, start })).toBe("counted")
  expect(readFileSync(live, "utf8")).toBe(script("0.1.9"))
  expect(started).toEqual([])
})

test("keeps the crashing build when the last one fails its own self-test", async () => {
  const store = temporaryStore()
  const live = updated(store, "fails")
  const { started, start } = starts()

  const results = await crashes(3, () => AutoUpdate.crashed(store, { running: live, start }))

  expect(results.at(-1)).toBe("previous-broken")
  expect(readFileSync(live, "utf8")).toBe(script("0.1.9"))
  expect(CliInstall.receipt(store)?.version).toBe("0.1.9")
  expect(started).toEqual([])
})

test("keeps counting crashes on an install with nothing to roll back to", async () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.9" })

  const results = await crashes(3, () => AutoUpdate.crashed(store, { running: live, start: () => undefined }))

  expect(results).toEqual(["counted", "counted", "no-previous"])
  expect(readFileSync(live, "utf8")).toBe(script("0.1.9"))
})

test("never rolls back a binary setup didn't install", async () => {
  const store = temporaryStore()
  updated(store)
  const elsewhere = path.join(store.cache, "opencode-console")
  mkdirSync(store.cache, { recursive: true })
  writeFileSync(elsewhere, script("0.1.9"))

  expect(await AutoUpdate.crashed(store, { running: elsewhere, start: () => undefined })).toBe("unmanaged")
  expect(AutoUpdate.read(store).crashes).toBeUndefined()
})

test("leaves the rollback for the next crash while an update holds the install", async () => {
  const store = temporaryStore()
  const live = updated(store)
  AutoUpdate.update(store, () => ({ crashes: { version: "0.1.9", count: 2 } }))
  const release = Promise.withResolvers<void>()
  const holding = Effect.runPromise(
    ConsoleStore.locked(
      store,
      Effect.promise(() => release.promise),
      "update",
    ),
  )
  await Bun.sleep(50)

  const result = await AutoUpdate.crashed(store, { running: live, start: () => undefined })
  release.resolve()
  await holding

  expect(result).toBe("busy")
  expect(readFileSync(live, "utf8")).toBe(script("0.1.9"))
})

test("blames the build for a crash, but not for input it can't read, a broken sign-in or a system error", async () => {
  const full = Object.assign(new Error("no space left on device"), { code: "ENOSPC" })

  expect(await AutoUpdate.buildFault(new TypeError("undefined is not a function"))).toBe(true)
  expect(await AutoUpdate.buildFault(new ClaudeCodeHook.Unreadable("The hook input names no tool"))).toBe(false)
  expect(await AutoUpdate.buildFault(new ConsoleCredentials.Unusable("The sign-in can't be read"))).toBe(false)
  expect(await AutoUpdate.buildFault(full)).toBe(false)
})
