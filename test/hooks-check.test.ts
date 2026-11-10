import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { HooksCheck } from "../src/hooks-check"
import { removeStores, temporaryStore } from "./support/console"

const directories: string[] = []
afterEach(() => {
  removeStores()
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

const HOUR = 3_600_000

test("warns a session once, however many tokens it asks for", () => {
  const store = temporaryStore()

  expect(HooksCheck.due(store, "claude-code", { now: 10 * HOUR, session: 41 }).warn).toBe(true)
  expect(HooksCheck.due(store, "claude-code", { now: 13 * HOUR, session: 41 }).warn).toBe(false)
})

test("warns a new session once the hour since the last warning has passed, not sooner", () => {
  const store = temporaryStore()
  HooksCheck.due(store, "codex", { now: 10 * HOUR, session: 41 })

  expect(HooksCheck.due(store, "codex", { now: 10 * HOUR + 1, session: 42 }).warn).toBe(false)
  expect(HooksCheck.due(store, "codex", { now: 11 * HOUR, session: 42 }).warn).toBe(true)
})

test("reports to the Console at most hourly, as the Console records a client at most hourly", () => {
  const store = temporaryStore()
  expect(HooksCheck.due(store, "hermes", { now: 10 * HOUR, session: 41 }).report).toBe(true)

  expect(HooksCheck.due(store, "hermes", { now: 10 * HOUR + 1, session: 41 }).report).toBe(false)
  expect(HooksCheck.due(store, "hermes", { now: 11 * HOUR, session: 41 }).report).toBe(true)
})

test("tracks each agent apart, so hooks off in one don't silence another", () => {
  const store = temporaryStore()
  HooksCheck.due(store, "claude-code", { now: 10 * HOUR, session: 41 })

  expect(HooksCheck.due(store, "codex", { now: 10 * HOUR, session: 41 })).toEqual({ warn: true, report: true })
})

const sink = (isTTY: boolean) => {
  const written: string[] = []
  return {
    written,
    stream: {
      isTTY,
      write: (text: string) => {
        written.push(text)
        return true
      },
    },
  }
}

test("also writes to the terminal when an agent has taken stderr, as they do for their helpers", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "opencode-console-tty-"))
  directories.push(directory)
  const tty = path.join(directory, "tty")
  const stderr = sink(false)

  HooksCheck.warn("hooks are off", { stderr: stderr.stream, tty })

  expect(stderr.written).toEqual(["hooks are off\n"])
  expect(readFileSync(tty, "utf8")).toBe("\r\nhooks are off\r\n")
})

test("writes once when stderr is the terminal, rather than printing the line twice", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "opencode-console-tty-"))
  directories.push(directory)
  const tty = path.join(directory, "tty")
  writeFileSync(tty, "untouched")
  const stderr = sink(true)

  HooksCheck.warn("hooks are off", { stderr: stderr.stream, tty })

  expect(stderr.written).toEqual(["hooks are off\n"])
  expect(readFileSync(tty, "utf8")).toBe("untouched")
})

test("still warns on stderr where there's no terminal to write to", () => {
  const stderr = sink(false)

  HooksCheck.warn("hooks are off", { stderr: stderr.stream, tty: "/nonexistent/tty" })

  expect(stderr.written).toEqual(["hooks are off\n"])
})

test("names an agent's fix, and setup when there's nothing more specific", () => {
  expect(HooksCheck.message({ agent: "codex", reason: "features.hooks is false in /c/config.toml" })).toBe(
    "OpenCode Console: policy hooks are off in Codex (features.hooks is false in /c/config.toml), so your workspace's rules aren't enforced and its admins can see that. Run npx @opencode/console setup codex.",
  )
  expect(
    HooksCheck.message({ agent: "hermes", reason: "HERMES_SAFE_MODE is set", fix: "Unset HERMES_SAFE_MODE" }),
  ).toBe(
    "OpenCode Console: policy hooks are off in Hermes Agent (HERMES_SAFE_MODE is set), so your workspace's rules aren't enforced and its admins can see that. Unset HERMES_SAFE_MODE.",
  )
})
