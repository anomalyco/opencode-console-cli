import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hermes } from "../src/hermes"
import { AutoUpdate } from "../src/update/auto-update"
import { UpdateEnvironment } from "../src/update/environment"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((item) => rmSync(item, { recursive: true, force: true })))

// What a project could set through an agent's env settings, which hooks inherit.
const project = {
  HOME: "/home/member",
  OPENCODE_API_KEY: "key",
  CODEX_HOME: "/home/member/.codex",
  HERMES_DATA_DIR_SUFFIX: "-work",
  TAR_OPTIONS: "--exclude=*",
  BUN_OPTIONS: "--preload ./evil.ts",
  NODE_OPTIONS: "--require ./evil.js",
  LD_PRELOAD: "./evil.so",
  PATH: "/repo/bin:/usr/bin",
}

test("system tools run with a fixed environment, none of the parent's", () => {
  expect(UpdateEnvironment.tool("linux", project)).toEqual({
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
  })
  expect(UpdateEnvironment.tool("win32", { ...project, SystemRoot: "C:\\repo\\Windows" })).toMatchObject({
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
  })
})

test("the CLI an update starts keeps where its data and the agents are, and drops what changes how it runs", () => {
  expect(UpdateEnvironment.cli("linux", project)).toEqual({
    HOME: "/home/member",
    OPENCODE_API_KEY: "key",
    CODEX_HOME: "/home/member/.codex",
    HERMES_DATA_DIR_SUFFIX: "-work",
    PATH: "/repo/bin:/usr/bin",
  })
})

test("a refresh after a rollback finds the same Hermes home as the hook that started it", () => {
  const env = UpdateEnvironment.cli("linux", project)
  expect(Hermes.paths({ env, home: "/home/member", platform: "linux" }).home).toBe(
    Hermes.paths({ env: project, home: "/home/member", platform: "linux" }).home,
  )
})

test("takes Windows' directory from SystemRoot only when it is a drive's Windows", () => {
  expect(UpdateEnvironment.systemRoot({ SystemRoot: "D:\\Windows" })).toBe("D:\\Windows")
  expect(UpdateEnvironment.systemRoot({ SystemRoot: "C:\\Users\\member\\repo" })).toBe("C:\\Windows")
  expect(UpdateEnvironment.systemRoot({ SystemRoot: "C:\\Windows\\..\\repo" })).toBe("C:\\Windows")
  expect(UpdateEnvironment.systemRoot({})).toBe("C:\\Windows")
})

test("the detached updater doesn't inherit TAR_OPTIONS or BUN_OPTIONS from the hook that starts it", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "console-detached-"))
  directories.push(directory)
  const out = path.join(directory, "env")
  const saved = { TAR_OPTIONS: process.env.TAR_OPTIONS, BUN_OPTIONS: process.env.BUN_OPTIONS }
  process.env.TAR_OPTIONS = "--exclude=*"
  process.env.BUN_OPTIONS = "--preload ./evil.ts"
  try {
    AutoUpdate.detached(
      ["/bin/sh", "-c", `env > "${out}.tmp" && mv "${out}.tmp" "${out}"`],
      path.join(directory, "log"),
    )
  } finally {
    Object.entries(saved).forEach(([name, value]) =>
      value === undefined ? delete process.env[name] : (process.env[name] = value),
    )
  }
  for (const _ of Array.from({ length: 100 })) {
    if (existsSync(out)) break
    await Bun.sleep(20)
  }
  const env = readFileSync(out, "utf8")
  expect(env).not.toContain("TAR_OPTIONS")
  expect(env).not.toContain("BUN_OPTIONS")
  expect(env).toContain(`HOME=${process.env.HOME}`)
})
