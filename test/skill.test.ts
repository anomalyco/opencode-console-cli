import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { Skill } from "../src/skill"
import { against, fakeConsole, inbox, signIn } from "./support/console"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

/**
 * A Console offering the skill `brand` with one stored file, whose bytes go out only when the test sends them: each
 * read of the file hands the test a function that answers it with `bytes`, ending the file after them when `last`.
 */
function slowFile() {
  const reads = inbox<(bytes: Uint8Array, last?: boolean) => void>()
  const console = fakeConsole({
    bundles: {
      brand: {
        format: 2,
        slug: "brand",
        version: "skl_1:1",
        files: [{ kind: "blob", path: "logo.png", sha256: "a".repeat(64), bytes: 3, mediaType: "image/png" }],
      },
    },
    blobs: {
      ["a".repeat(64)]: new ReadableStream<Uint8Array>(
        {
          pull: (controller) =>
            new Promise<void>((resolve) =>
              reads.push((bytes, last) => {
                controller.enqueue(bytes)
                if (last) controller.close()
                resolve()
              }),
            ),
        },
        { highWaterMark: 0 },
      ),
    },
  })
  const directory = mkdtempSync(path.join(os.tmpdir(), "opencode-console-skills-"))
  directories.push(directory)
  const download = Skill.fetchChanged(
    signIn(console, Number.MAX_SAFE_INTEGER),
    directory,
    [{ slug: "brand", version: "skl_1:1" }],
    {},
  ).pipe(against(console), Effect.forkChild)
  return { reads, download }
}

test("downloads a skill file that takes longer than 10 seconds in all while its bytes keep coming", async () => {
  const { reads, download } = slowFile()

  const bundles = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* download
      const first = yield* Effect.promise(() => reads.at(0))
      yield* TestClock.adjust("6 seconds")
      first(new Uint8Array([137, 80]))
      const second = yield* Effect.promise(() => reads.at(1))
      yield* TestClock.adjust("6 seconds")
      second(new Uint8Array([78]), true)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer())),
  )

  expect(bundles[0]?.files[0]?.content).toEqual(new Uint8Array([137, 80, 78]))
})

test("fails a skill file the Console stops sending for 10 seconds", async () => {
  const { reads, download } = slowFile()

  const failure = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* download
      yield* Effect.promise(() => reads.at(0))
      yield* TestClock.adjust("10 seconds")
      return yield* Fiber.join(fiber).pipe(Effect.flip)
    }).pipe(Effect.provide(TestClock.layer())),
  )

  expect(failure.message).toBe("OpenCode Console stopped sending a skill file")
})
