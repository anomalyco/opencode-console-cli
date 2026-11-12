import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { version } from "../package.json" with { type: "json" }
import { CliInstall } from "../src/install"
import { removeStores, temporaryStore } from "./support/console"

const roots: string[] = []
afterEach(() => {
  removeStores()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

// The npm package as npx unpacks it: the entry, its chunks and the package.json naming it.
function npxCache(files: Record<string, string>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-npx-"))
  roots.push(root)
  const directory = path.join(root, "_npx", "a1b2", "node_modules", "@opencode", "console")
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "@opencode/console", version: "0.1.0" }))
  Object.entries(files).forEach(([name, content]) => writeFileSync(path.join(directory, name), content))
  return path.join(directory, "index.js")
}

test("copies the npm package out of npx's cache and runs the copy with the same Node", () => {
  const store = temporaryStore()
  const entry = npxCache({ "index.js": "entry", "chunk-1.js": "chunk" })

  const command = CliInstall.install(store, { execPath: "/opt/node/bin/node", entry })
  rmSync(path.dirname(entry), { recursive: true })

  expect(command).toEqual(["/opt/node/bin/node", path.join(store.data, "cli", "index.js")])
  expect(readFileSync(path.join(store.data, "cli", "chunk-1.js"), "utf8")).toBe("chunk")
})

test("follows npx's bin link to the package it runs", () => {
  const store = temporaryStore()
  const entry = npxCache({ "index.js": "entry" })
  const bin = path.join(path.dirname(entry), "..", "..", ".bin")
  mkdirSync(bin, { recursive: true })
  symlinkSync(entry, path.join(bin, "opencode-console"))

  const command = CliInstall.install(store, {
    execPath: "/opt/node/bin/node",
    entry: path.join(bin, "opencode-console"),
  })

  expect(command).toEqual(["/opt/node/bin/node", path.join(store.data, "cli", "index.js")])
  expect(readFileSync(command[1]!, "utf8")).toBe("entry")
})

test("runs the copy with Node by the link on PATH that outlives Node upgrades", () => {
  const store = temporaryStore()
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-node-"))
  roots.push(root)
  const versioned = path.join(root, "Cellar", "node", "24.1.0", "bin", "node")
  mkdirSync(path.dirname(versioned), { recursive: true })
  writeFileSync(versioned, "")
  mkdirSync(path.join(root, "bin"))
  symlinkSync(versioned, path.join(root, "bin", "node"))

  const command = CliInstall.install(store, {
    execPath: versioned,
    entry: npxCache({ "index.js": "" }),
    path: ["relative/bin", "/nonexistent", path.join(root, "bin")].join(path.delimiter),
  })

  expect(command[0]).toBe(path.join(root, "bin", "node"))
})

test("replaces the copy when run again, leaving none of the old version's files", () => {
  const store = temporaryStore()
  CliInstall.install(store, {
    execPath: "/opt/node/bin/node",
    entry: npxCache({ "index.js": "1", "chunk-old.js": "" }),
  })

  CliInstall.install(store, {
    execPath: "/opt/node/bin/node",
    entry: npxCache({ "index.js": "2", "chunk-new.js": "" }),
  })

  expect(readdirSync(path.join(store.data, "cli")).toSorted()).toEqual([
    "chunk-new.js",
    "index.js",
    "install.json",
    "package.json",
  ])
  expect(readdirSync(store.data).filter((name) => name.startsWith("cli"))).toEqual(["cli"])
})

test("copies a compiled binary and runs the copy", () => {
  const store = temporaryStore()
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-bin-"))
  roots.push(root)
  writeFileSync(path.join(root, "opencode-console"), "binary")

  const command = CliInstall.install(store, { execPath: path.join(root, "opencode-console") })

  expect(command).toEqual([path.join(store.data, "cli", "opencode-console")])
  expect(readFileSync(command[0]!, "utf8")).toBe("binary")
})

test("runs a source checkout in place, where its dependencies are", () => {
  const store = temporaryStore()
  const entry = path.join(import.meta.dir, "../src/index.ts")

  expect(CliInstall.install(store, { execPath: "/usr/local/bin/bun", entry })).toEqual(["/usr/local/bin/bun", entry])
  expect(existsSync(path.join(store.data, "cli"))).toBe(false)
})

test("runs in place a script whose package.json it can't read", () => {
  const store = temporaryStore()
  const entry = npxCache({ "index.js": "" })
  writeFileSync(path.join(path.dirname(entry), "package.json"), "{ broken")

  expect(CliInstall.install(store, { execPath: "/usr/local/bin/bun", entry })).toEqual([
    "/usr/local/bin/bun",
    realpathSync(entry),
  ])
})

test("deletes the copy on uninstall", () => {
  const store = temporaryStore()
  CliInstall.install(store, { execPath: "/opt/node/bin/node", entry: npxCache({ "index.js": "" }) })

  CliInstall.uninstall(store)

  expect(existsSync(path.join(store.data, "cli"))).toBe(false)
})

test("leaves a receipt for the npm copy, naming the Node that runs it, so it can update itself", () => {
  const store = temporaryStore()
  CliInstall.install(store, { execPath: "/opt/node/bin/node", entry: npxCache({ "index.js": "" }) })

  expect(CliInstall.receipt(store)).toEqual({
    method: "npm-bundle",
    version,
    channel: "stable",
    node: "/opt/node/bin/node",
  })
})

test("leaves a receipt for a binary, with the release archive it came from", () => {
  const store = temporaryStore()
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-bin-"))
  roots.push(root)
  writeFileSync(path.join(root, "opencode-console"), "binary")

  CliInstall.install(store, { execPath: path.join(root, "opencode-console"), sha256: "a".repeat(64) })

  expect(CliInstall.receipt(store)).toEqual({ method: "direct", version, channel: "stable", sha256: "a".repeat(64) })
})

test("drops the build kept for a rollback when setup moves the install to another channel", () => {
  const store = temporaryStore()
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-bin-"))
  roots.push(root)
  writeFileSync(path.join(root, "opencode-console"), "binary")
  const kept = CliInstall.previousDirectory(store)
  mkdirSync(kept, { recursive: true })
  writeFileSync(path.join(kept, "opencode-console"), "a dev build")
  const dev = { method: "direct", version: `${version}-dev.4`, channel: "dev" }
  writeFileSync(CliInstall.receiptFile(kept), JSON.stringify(dev))
  mkdirSync(CliInstall.directory(store), { recursive: true })
  writeFileSync(
    CliInstall.receiptFile(CliInstall.directory(store)),
    JSON.stringify({ ...dev, version: `${version}-dev.5` }),
  )

  CliInstall.install(store, { execPath: path.join(root, "opencode-console") })

  expect(CliInstall.receipt(store)).toMatchObject({ channel: "stable" })
  expect(existsSync(kept)).toBe(false)
})

test("keeps the build kept for a rollback when setup runs again on the same channel", () => {
  const store = temporaryStore()
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-bin-"))
  roots.push(root)
  writeFileSync(path.join(root, "opencode-console"), "binary")
  const kept = CliInstall.previousDirectory(store)
  mkdirSync(kept, { recursive: true })
  const stable = { method: "direct", version: "0.1.8", channel: "stable" }
  writeFileSync(CliInstall.receiptFile(kept), JSON.stringify(stable))
  mkdirSync(CliInstall.directory(store), { recursive: true })
  writeFileSync(CliInstall.receiptFile(CliInstall.directory(store)), JSON.stringify({ ...stable, version }))

  CliInstall.install(store, { execPath: path.join(root, "opencode-console") })

  expect(CliInstall.receipt(store, kept)).toMatchObject(stable)
})

test("names a dev build's channel dev, so it follows dev builds", () => {
  expect(CliInstall.channelOf("0.1.8-dev.142")).toBe("dev")
  expect(CliInstall.channelOf("0.1.8-beta.3")).toBe("beta")
  expect(CliInstall.channelOf("0.1.8")).toBe("stable")
})

test("points every agent set up by the Node copy at the binary that replaced it, keeping the rest of each record", () => {
  const store = temporaryStore()
  const node = ["/opt/node/bin/node", path.join(store.data, "cli", "index.js")]
  mkdirSync(store.data, { recursive: true })
  writeFileSync(path.join(store.data, "claude-code.json"), JSON.stringify({ command: node, servers: ["linear"] }))
  writeFileSync(path.join(store.data, "codex.json"), JSON.stringify({ command: node, rules: 2 }))
  const binary = [path.join(store.data, "cli", "opencode-console")]

  expect(CliInstall.retarget(store, binary)).toEqual(["claude-code.json", "codex.json"])
  expect(JSON.parse(readFileSync(path.join(store.data, "claude-code.json"), "utf8"))).toEqual({
    command: binary,
    servers: ["linear"],
  })
  expect(JSON.parse(readFileSync(path.join(store.data, "codex.json"), "utf8"))).toEqual({ command: binary, rules: 2 })
  expect(CliInstall.retarget(store, binary)).toEqual([])
})

// From anomalyco/browse's `install`: the same eleven builds, picked the same way.
const host = (input: Parameters<typeof CliInstall.hostTarget>[0] & { readonly answers?: Record<string, string> }) =>
  CliInstall.hostTarget({
    exists: () => false,
    read: () => "flags : fpu avx2",
    ...input,
    run: (command, args) => input.answers?.[`${command} ${args.at(-1)}`],
  })

test("runs the ARM build on an Intel Mac's Rosetta, and the baseline build on an Intel Mac without AVX2", () => {
  const rosetta = { "sysctl sysctl.proc_translated": "1", "sysctl hw.optional.avx2_0": "1" }
  expect(host({ platform: "darwin", arch: "x64", answers: rosetta })).toBe("darwin-arm64")
  expect(host({ platform: "darwin", arch: "x64", answers: { "sysctl hw.optional.avx2_0": "0" } })).toBe(
    "darwin-x64-baseline",
  )
  expect(host({ platform: "darwin", arch: "arm64" })).toBe("darwin-arm64")
})

test("runs the musl build on Alpine, and the baseline build on a CPU without AVX2", () => {
  expect(host({ platform: "linux", arch: "x64", exists: (file) => file === "/etc/alpine-release" })).toBe(
    "linux-x64-musl",
  )
  expect(host({ platform: "linux", arch: "x64", read: () => "flags : fpu sse4_2" })).toBe("linux-x64-baseline")
  expect(host({ platform: "linux", arch: "arm64" })).toBe("linux-arm64")
})

test("runs the baseline x64 build on Windows on ARM, which emulates x64", () => {
  expect(
    CliInstall.hostTarget({
      platform: "win32",
      arch: "arm64",
      run: (command) => (command === "powershell.exe" ? "True" : undefined),
    }),
  ).toBe("windows-x64-baseline")
})

test("has no build for other platforms, which keep the Node copy", () => {
  expect(host({ platform: "freebsd", arch: "x64" })).toBeUndefined()
  expect(host({ platform: "linux", arch: "riscv64" })).toBeUndefined()
})

test("points each Hermes profile set up by the Node copy at the binary that replaced it", () => {
  const store = temporaryStore()
  const node = ["/opt/node/bin/node", path.join(store.data, "cli", "index.js")]
  mkdirSync(store.data, { recursive: true })
  writeFileSync(
    path.join(store.data, "hermes.json"),
    JSON.stringify({
      profiles: { "/home/ada/.hermes": { command: node, servers: [] }, "/home/ada/work": { command: node } },
    }),
  )
  const binary = [path.join(store.data, "cli", "opencode-console")]

  expect(CliInstall.retarget(store, binary)).toEqual(["hermes.json"])
  expect(JSON.parse(readFileSync(path.join(store.data, "hermes.json"), "utf8"))).toEqual({
    profiles: { "/home/ada/.hermes": { command: binary, servers: [] }, "/home/ada/work": { command: binary } },
  })
})

test("keeps the Node copy's entry running the binary, for an agent session started before setup moved it", () => {
  const store = temporaryStore()
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-bin-"))
  roots.push(root)
  writeFileSync(path.join(root, "opencode-console"), '#!/bin/sh\necho "binary $*"\nexit 2\n', { mode: 0o755 })
  CliInstall.install(store, { execPath: path.join(root, "opencode-console") })

  const ran = Bun.spawnSync([process.execPath, path.join(store.data, "cli", "index.js"), "hook", "claude-code"])

  expect([ran.exitCode, ran.stdout.toString()]).toEqual([2, "binary hook claude-code\n"])
})

test("keeps the release archive a binary came from when setup runs again from the installed binary", () => {
  const store = temporaryStore()
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-bin-"))
  roots.push(root)
  writeFileSync(path.join(root, "opencode-console"), "binary")
  CliInstall.install(store, { execPath: path.join(root, "opencode-console"), sha256: "a".repeat(64) })

  CliInstall.install(store, { execPath: CliInstall.binary(store) })

  expect(CliInstall.receipt(store)?.sha256).toBe("a".repeat(64))
})

// Windows can't replace a running executable; the live one is renamed aside, and put back when the new one can't move in.
test("leaves the installed binary in place on Windows when the new one can't take its place", () => {
  const store = temporaryStore()
  mkdirSync(CliInstall.directory(store), { recursive: true })
  const live = CliInstall.binary(store, "win32")
  writeFileSync(live, "old")
  writeFileSync(`${live}.old-earlier`, "exited")

  expect(() =>
    CliInstall.activate(
      store,
      path.join(store.data, "missing.exe"),
      { method: "direct", version: "0.1.9", channel: "stable" },
      "win32",
    ),
  ).toThrow()
  expect(readFileSync(live, "utf8")).toBe("old")
  expect(existsSync(`${live}.old-earlier`)).toBe(false)
})

test("moves a Node copy onto the binary in place, leaving none of its files but the entry, which runs the binary", () => {
  const store = temporaryStore()
  CliInstall.install(store, { execPath: "/opt/node/bin/node", entry: npxCache({ "index.js": "", "chunk-1.js": "" }) })
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-bin-"))
  roots.push(root)
  writeFileSync(path.join(root, "opencode-console"), "binary")

  CliInstall.install(store, { execPath: path.join(root, "opencode-console") })

  expect(readdirSync(CliInstall.directory(store)).toSorted()).toEqual(["index.js", "install.json", "opencode-console"])
  expect(readFileSync(path.join(CliInstall.directory(store), "index.js"), "utf8")).toContain("spawnSync")
})

// Windows can't overwrite or delete a running executable, but can rename it, so setup moves the one an agent may be
// running aside and puts the new one in its place.
test("replaces the installed binary on Windows by renaming it aside first", () => {
  const store = temporaryStore()
  const live = CliInstall.binary(store, "win32")
  mkdirSync(path.dirname(live), { recursive: true })
  writeFileSync(live, "old")
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-bin-"))
  roots.push(root)
  writeFileSync(path.join(root, "opencode-console.exe"), "new")

  CliInstall.install(store, { execPath: path.join(root, "opencode-console.exe") }, "win32")

  const aside = readdirSync(path.dirname(live)).filter((name) => name.startsWith("opencode-console.exe.old-"))
  expect(readFileSync(live, "utf8")).toBe("new")
  expect(aside.map((name) => readFileSync(path.join(path.dirname(live), name), "utf8"))).toEqual(["old"])
})

test("leaves out of the receipt an archive SHA-256 that isn't one, so the install still updates itself", () => {
  const store = temporaryStore()
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-bin-"))
  roots.push(root)
  writeFileSync(path.join(root, "opencode-console"), "binary")

  CliInstall.install(store, { execPath: path.join(root, "opencode-console"), sha256: "ABC " })

  expect(CliInstall.receipt(store)).toEqual({ method: "direct", version, channel: "stable" })
})

test("asks a Windows agent's npm shim its version through cmd.exe, which mustn't look in the project first", () => {
  expect(CliInstall.versionProbe("codex", "win32", { PATH: "C:\\npm" })).toEqual({
    file: "codex --version",
    args: [],
    options: { shell: true, env: { PATH: "C:\\npm", NoDefaultCurrentDirectoryInExePath: "1" } },
  })
  expect(CliInstall.versionProbe("codex", "linux", { PATH: "/usr/bin" })).toEqual({
    file: "codex",
    args: ["--version"],
    options: { env: { PATH: "/usr/bin" } },
  })
})

test("reads an agent's version without a shell, or none when it isn't installed", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-agent-"))
  roots.push(root)
  const agent = path.join(root, "codex; echo 9.9.9")
  writeFileSync(agent, "#!/bin/sh\necho 'codex-cli 0.167.0'\n", { mode: 0o755 })
  expect(await CliInstall.agentVersion(agent)).toBe("0.167.0")
  expect(await CliInstall.agentVersion(path.join(root, "missing"))).toBeUndefined()
})
