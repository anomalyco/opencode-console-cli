export * as CliInstall from "./install"

import { execFile, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { version } from "../package.json" with { type: "json" }
import { BuildInfo } from "./build-info"
import { ConsoleStore } from "./store"

/** The npm package the Node bundle publishes as (`script/build.ts`). */
export const packageName = "@opencode/console"

/** How this process was started: a compiled binary, the npm package's Node bundle, or a source checkout. */
export interface Running {
  /** The runtime binary: the compiled CLI itself, or Node or Bun. */
  readonly execPath: string
  /** The entry script the runtime runs, absent for a compiled binary. */
  readonly entry?: string | undefined
  /** `PATH`, where a link to the runtime that outlives upgrades may be. */
  readonly path?: string | undefined
  /** The release archive a compiled binary came from, which the release service names its builds by. */
  readonly sha256?: string | undefined
}

/** Where `setup` keeps the copy of the CLI that harness settings run: `<data>/cli`. */
export const directory = (store: ConsoleStore.Info) => path.join(store.data, "cli")

/** The copy of the last binary that ran, kept while a newer one proves itself (`AutoUpdate.crashed`). */
export const previousDirectory = (store: ConsoleStore.Info) => `${directory(store)}.prev`

export const binaryName = (platform = process.platform) =>
  platform === "win32" ? "opencode-console.exe" : "opencode-console"

/** The installed binary every agent's settings run. */
export const binary = (store: ConsoleStore.Info, platform = process.platform) =>
  path.join(directory(store), binaryName(platform))

export const Channel = Schema.Literals(["stable", "beta", "dev"])
export type Channel = typeof Channel.Type

/** The release channel a build was published on: `0.1.8-dev.142` is dev's, `0.1.8` stable's. */
export const channelOf = (value: string): Channel =>
  value.includes("-dev.") ? "dev" : value.includes("-beta.") ? "beta" : "stable"

/**
 * What `setup` installed in `<data>/cli`, in `install.json` beside it. Only an install with a receipt updates itself,
 * so a binary IT put in `/usr/local/bin`, an npx run, a source checkout and `pi install npm:@opencode/console` never do.
 */
export const Receipt = Schema.Struct({
  /** `direct`: a release binary; `npm-bundle`: the npm package's Node bundle, where no binary fits. */
  method: Schema.Literals(["direct", "npm-bundle"]),
  version: Schema.String,
  channel: Channel,
  /** The release service's target the binary was built for (`macos-arm64`). */
  target: Schema.optional(Schema.String),
  /**
   * The SHA-256 of the release archive the binary came from, which the release protocol compares with its channel's
   * current build; absent when it isn't known, and the version is compared instead.
   */
  sha256: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
  /** The Node that runs an npm bundle. */
  node: Schema.optional(Schema.String),
})
export type Receipt = typeof Receipt.Type

export const receiptFile = (directory: string) => path.join(directory, "install.json")

/** The receipt of what's installed, or undefined when nothing setup installed is there. */
export function receipt(store: ConsoleStore.Info, from = directory(store)) {
  const text = ConsoleStore.read(receiptFile(from))
  return text === undefined
    ? undefined
    : Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Receipt))(text))
}

/** The command that runs what a receipt says is installed. */
export const command = (store: ConsoleStore.Info, installed: Receipt, platform = process.platform) =>
  installed.method === "direct"
    ? [binary(store, platform)]
    : [installed.node ?? "node", path.join(directory(store), "index.js")]

/**
 * Copies the running CLI to a fixed place in the CLI's data directory and returns the command that runs the copy, so
 * harness settings never depend on `PATH` or on npx's cache, which it may clear at any time. A compiled binary is
 * copied with the Pi extension and DeepSeek Harness plugin it carries, and the npm package's Node bundle (an entry and
 * its chunks) is copied as a directory and run with this Node; either gets a receipt, which lets it update itself.
 * Running again replaces the copy in one step. A source checkout runs in place, since its dependencies live beside it.
 */
export function install(
  store: ConsoleStore.Info,
  running: Running,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const target = directory(store)
  const before = receipt(store)
  // The build kept for a rollback is the last that worked on this channel. Setup moving the install to another one
  // drops it, so a crashing stable build can't roll back to an unsigned dev build kept from before.
  if (before !== undefined && before.channel !== channelOf(version))
    rmSync(previousDirectory(store), { recursive: true, force: true })
  if (running.entry === undefined) {
    const built = BuildInfo.target()
    // Run again from the installed binary, setup still knows which release archive that came from.
    // Only a SHA-256: anything else in the receipt would leave it unreadable, and the install unable to update.
    const sha256 =
      (running.sha256 !== undefined && /^[0-9a-f]{64}$/.test(running.sha256) ? running.sha256 : undefined) ??
      (before?.method === "direct" && before.version === version && same(running.execPath, binary(store))
        ? before.sha256
        : undefined)
    // In place, file by file, rather than swapping the directory: Windows can't rename a directory while an
    // executable in it runs, and an agent's hooks or watch server often are running it.
    ConsoleStore.ensureDir(target)
    const live = binary(store, platform)
    if (!same(running.execPath, live)) {
      const staged = `${live}.${randomUUID()}.tmp`
      copyFileSync(running.execPath, staged)
      if (platform !== "win32") chmodSync(staged, 0o755)
      promote(staged, live, platform)
    }
    // The Node copy's entry, which agents set up before may still run, now runs the binary.
    const files = { ...BuildInfo.embedded(), "index.js": shim(live) }
    Object.entries(files).forEach(([name, text]) => {
      if (ConsoleStore.read(path.join(target, name)) !== text) ConsoleStore.write(path.join(target, name), text)
    })
    writeReceipt(target, {
      method: "direct",
      version,
      channel: channelOf(version),
      ...(built ? { target: serviceTarget(built) } : {}),
      ...(sha256 ? { sha256 } : {}),
    })
    // Whatever else is there is a Node copy's: its chunks, package.json and licenses.
    const kept = new Set([binaryName(platform), "install.json", ...Object.keys(files)])
    readdirSync(target)
      .filter((name) => !kept.has(name) && !name.startsWith(`${binaryName(platform)}.`))
      .forEach((name) => rmSync(path.join(target, name), { recursive: true, force: true }))
    return [live]
  }
  // npx runs the package through a `node_modules/.bin` link, so the bundle is wherever the link points.
  const entry = realpathSync(running.entry)
  const source = path.dirname(entry)
  if (!bundled(source)) return [running.execPath, entry]
  const node = stablePath(running.execPath, running.path)
  replace(target, (staging) => {
    cpSync(source, staging, { recursive: true })
    writeReceipt(staging, { method: "npm-bundle", version, channel: channelOf(version), node })
  })
  return [node, path.join(target, path.basename(entry))]
}

/**
 * Writes the extension and plugin this binary carries beside the installed copy, when they differ, for an update that
 * replaced only the binary. Nothing outside a compiled binary carries them.
 */
export function materialize(store: ConsoleStore.Info) {
  Object.entries(BuildInfo.embedded()).forEach(([name, text]) => {
    const file = path.join(directory(store), name)
    if (ConsoleStore.read(file) !== text) ConsoleStore.write(file, text)
  })
}

/**
 * Points the agents setup connected before at `command`, when the install it runs changed shape, such as a Node copy
 * becoming a binary: Claude Code and Codex, and each Hermes profile. Each agent's next refresh writes it into the
 * agent's own settings.
 */
export function retarget(store: ConsoleStore.Info, next: readonly string[]) {
  const differs = (command: readonly string[]) => JSON.stringify(command) !== JSON.stringify(next)
  const agents = ["claude-code.json", "codex.json"].flatMap((name) => {
    const file = path.join(store.data, name)
    const manifest = decoded(file, Schema.fromJsonString(Commanded))
    if (!manifest || !differs(manifest.command)) return []
    ConsoleStore.write(file, JSON.stringify({ ...manifest, command: next }))
    return [name]
  })
  const hermes = path.join(store.data, "hermes.json")
  const profiles = decoded(hermes, Schema.fromJsonString(Profiles))
  if (!profiles || !Object.values(profiles.profiles).some((profile) => differs(profile.command))) return agents
  ConsoleStore.write(
    hermes,
    JSON.stringify({
      ...profiles,
      profiles: Object.fromEntries(
        Object.entries(profiles.profiles).map(([home, profile]) => [home, { ...profile, command: next }]),
      ),
    }),
  )
  return [...agents, "hermes.json"]
}

// Every agent manifest that runs the CLI records the command (Hermes's per profile); the rest is its own module's.
const Commanded = Schema.StructWithRest(Schema.Struct({ command: Schema.Array(Schema.String) }), [
  Schema.Record(Schema.String, Schema.Unknown),
])
const Profiles = Schema.StructWithRest(Schema.Struct({ profiles: Schema.Record(Schema.String, Commanded) }), [
  Schema.Record(Schema.String, Schema.Unknown),
])

function decoded<A>(file: string, schema: Schema.Decoder<A>) {
  const text = ConsoleStore.read(file)
  return text === undefined ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(schema)(text))
}

/**
 * What a Node copy's entry becomes in a binary install: a script that runs the binary, so an agent that still runs
 * `node <data>/cli/index.js`, such as a Claude Code session or Hermes gateway started before setup moved it, keeps
 * deciding rather than failing on a missing file.
 */
const shim = (
  file: string,
) => `// Runs the installed opencode-console binary for agents still set up to run this Node copy.
const { spawnSync } = require("node:child_process")
const result = spawnSync(${JSON.stringify(file)}, process.argv.slice(2), { stdio: "inherit" })
process.exit(result.status ?? 2)
`

function same(left: string, right: string) {
  return existsSync(left) && existsSync(right) && realpathSync(left) === realpathSync(right)
}

/**
 * Makes a binary that passed its self-test the installed one. The binary it replaces is kept as the last that worked,
 * for a rollback, and running processes keep the file they started from: on Unix the new one is renamed over it, and
 * on Windows, which can't replace a running executable, the old one is renamed aside first.
 */
export function activate(store: ConsoleStore.Info, staged: string, next: Receipt, platform = process.platform) {
  const live = binary(store, platform)
  const previous = path.join(previousDirectory(store), binaryName(platform))
  ConsoleStore.ensureDir(previousDirectory(store))
  if (existsSync(live)) {
    copyFileSync(live, `${previous}.tmp`)
    renameSync(`${previous}.tmp`, previous)
    const before = receipt(store)
    if (before) writeReceipt(previousDirectory(store), before)
  }
  if (platform !== "win32") chmodSync(staged, 0o755)
  promote(staged, live, platform)
  writeReceipt(directory(store), next)
}

// Windows can't replace a running executable, so the live one is renamed aside first, and put back if the new one
// can't take its place, so the agents' settings never name a missing file. Earlier ones that have since exited go.
function promote(staged: string, live: string, platform: NodeJS.Platform) {
  if (platform !== "win32" || !existsSync(live)) return renameSync(staged, live)
  readdirSync(path.dirname(live))
    .filter((name) => name.startsWith(`${path.basename(live)}.old-`))
    .forEach((name) => rmSync(path.join(path.dirname(live), name), { force: true, maxRetries: 0 }))
  const aside = `${live}.old-${randomUUID()}`
  renameSync(live, aside)
  try {
    renameSync(staged, live)
  } catch (error) {
    renameSync(aside, live)
    throw error
  }
}

/**
 * Makes an npm bundle that passed its self-test the installed one, keeping the one it replaces as the last that worked.
 * A hook starting during the swap finds the old directory or the new one.
 */
export function activateBundle(store: ConsoleStore.Info, staged: string) {
  const live = directory(store)
  rmSync(previousDirectory(store), { recursive: true, force: true })
  if (existsSync(live)) renameSync(live, previousDirectory(store))
  try {
    renameSync(staged, live)
  } catch (error) {
    renameSync(previousDirectory(store), live)
    throw error
  }
}

/**
 * Puts the last binary or bundle that worked back, after the installed one kept crashing. Returns the receipt now
 * installed, or undefined when there's none to go back to.
 */
export function restore(store: ConsoleStore.Info, platform = process.platform) {
  const installed = receipt(store)
  const previous = previousReceipt(store)
  if (!installed || !previous || previous.method !== installed.method) return undefined
  if (installed.method === "npm-bundle") {
    const retired = `${directory(store)}.${randomUUID()}.old`
    renameSync(directory(store), retired)
    renameSync(previousDirectory(store), directory(store))
    rmSync(retired, { recursive: true, force: true })
    return previous
  }
  const live = binary(store, platform)
  const kept = path.join(previousDirectory(store), binaryName(platform))
  if (!existsSync(kept)) return undefined
  promote(kept, live, platform)
  writeReceipt(directory(store), previous)
  rmSync(previousDirectory(store), { recursive: true, force: true })
  return previous
}

/** The command that runs the last binary or bundle that worked, for its self-test before a rollback. */
export function previousCommand(store: ConsoleStore.Info, platform = process.platform) {
  const previous = previousReceipt(store)
  if (!previous) return undefined
  return previous.method === "direct"
    ? [path.join(previousDirectory(store), binaryName(platform))]
    : [previous.node ?? "node", path.join(previousDirectory(store), "index.js")]
}

/**
 * The receipt of the build kept for a rollback, when it's from the installed build's channel. One from another channel
 * is never run, not even for its self-test, whatever left it there.
 */
function previousReceipt(store: ConsoleStore.Info) {
  const installed = receipt(store)
  const previous = receipt(store, previousDirectory(store))
  return previous !== undefined && installed !== undefined && previous.channel === installed.channel
    ? previous
    : undefined
}

/** The SHA-256 of a file, in hex. */
export const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")

/** The release service's name for a target: macOS where npm says darwin, everything else already agrees. */
export const serviceTarget = (target: string) => target.replace(/^darwin-/, "macos-")

/**
 * The release binary that runs on this computer, as its npm package names it (`linux-x64-baseline-musl`), or
 * undefined where none does, such as FreeBSD or 32-bit ARM. Follows anomalyco/browse's `install`: an Intel Mac under
 * Rosetta runs the ARM build, Windows on ARM the x64 baseline one, and an x64 CPU without AVX2 the baseline build.
 */
export function hostTarget(
  input: {
    readonly platform?: NodeJS.Platform
    readonly arch?: string
    readonly run?: (command: string, args: readonly string[]) => string | undefined
    readonly exists?: (file: string) => boolean
    readonly read?: (file: string) => string | undefined
  } = {},
) {
  const platform = input.platform ?? process.platform
  const run = input.run ?? output
  const exists = input.exists ?? existsSync
  const read = input.read ?? ConsoleStore.read
  const os = platform === "win32" ? "windows" : platform
  if (os !== "darwin" && os !== "linux" && os !== "windows") return undefined
  const reported = input.arch ?? process.arch
  if (reported !== "x64" && reported !== "arm64") return undefined
  const rosetta = os === "darwin" && reported === "x64" && run("sysctl", ["-n", "sysctl.proc_translated"]) === "1"
  const arch = os === "windows" ? "x64" : rosetta ? "arm64" : reported
  const musl = os === "linux" && (exists("/etc/alpine-release") || /musl/i.test(run("ldd", ["--version"]) ?? ""))
  // Windows on ARM emulates x64, and the baseline build doesn't need AVX2.
  const baseline =
    (os === "windows" && reported === "arm64") ||
    (arch === "x64" &&
      (os === "linux"
        ? !/\bavx2\b/i.test(read("/proc/cpuinfo") ?? "")
        : os === "darwin"
          ? run("sysctl", ["-n", "hw.optional.avx2_0"]) !== "1"
          : !/^(true|1)$/i.test(
              run("powershell.exe", [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)',
              ]) ?? "",
            )))
  return [os, arch, baseline ? "baseline" : undefined, musl ? "musl" : undefined].filter(Boolean).join("-")
}

/** Deletes the copy `install` made, and the one kept for a rollback. */
export function uninstall(store: ConsoleStore.Info) {
  rmSync(directory(store), { recursive: true, force: true })
  rmSync(previousDirectory(store), { recursive: true, force: true })
}

function writeReceipt(directory: string, value: Receipt) {
  ConsoleStore.write(receiptFile(directory), `${JSON.stringify(value, null, 2)}\n`)
}

/** A coding agent's version, which names it to the Console, or undefined when it isn't installed. */
export function agentVersion(binary: string) {
  const probe = versionProbe(binary)
  return new Promise<string | undefined>((resolve) =>
    execFile(probe.file, probe.args, { ...probe.options, timeout: 10_000, windowsHide: true }, (error, stdout) =>
      resolve(error ? undefined : stdout.match(/\d+\.\d+\.\d+\S*/)?.[0]),
    ),
  )
}

/**
 * How `agentVersion` runs `<binary> --version`. On Windows that takes a shell, since npm installs agents as `.cmd`
 * shims, and `cmd.exe` looks for a program in the current directory before `PATH` unless
 * `NoDefaultCurrentDirectoryInExePath` is set, so setup in a project holding its own `codex.cmd` would run that.
 */
export function versionProbe(
  binary: string,
  platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (platform !== "win32") return { file: binary, args: ["--version"], options: { env } }
  const shimEnv: Record<string, string | undefined> = { ...env, NoDefaultCurrentDirectoryInExePath: "1" }
  return { file: `${binary} --version`, args: [], options: { shell: true, env: shimEnv } }
}

// What a command printed, either stream and whatever its exit code: musl's `ldd --version` says so on stderr and exits 1.
function output(command: string, args: readonly string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000, windowsHide: true })
  return result.error ? undefined : `${result.stdout}${result.stderr}`.trim()
}

/**
 * The same Node by a path that outlives upgrades. Package managers run Node from a versioned directory (Homebrew's
 * `Cellar/node/24.1.0/bin/node`) behind a link on `PATH` (`/opt/homebrew/bin/node`) that moves with each upgrade, so
 * the first `PATH` entry leading to this Node is used; failing that, the path it runs from.
 */
function stablePath(execPath: string, searchPath: string | undefined) {
  if (!existsSync(execPath)) return execPath
  const actual = realpathSync(execPath)
  return (
    (searchPath ?? "")
      .split(path.delimiter)
      .filter((directory) => path.isAbsolute(directory))
      .map((directory) => path.join(directory, path.basename(execPath)))
      .find((candidate) => existsSync(candidate) && realpathSync(candidate) === actual) ?? execPath
  )
}

/** Whether `entry` is the npm package's Node bundle, as npx or a global install runs it, rather than a checkout. */
export function fromNpm(entry: string | undefined) {
  if (entry === undefined || !existsSync(entry)) return false
  return bundled(path.dirname(realpathSync(entry)))
}

function bundled(directory: string) {
  const manifest = path.join(directory, "package.json")
  if (!existsSync(manifest)) return false
  const name = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ name: Schema.String })))(
    readFileSync(manifest, "utf8"),
  )
  return Option.getOrUndefined(name)?.name === packageName
}

// Builds the new copy beside the old one and swaps it in, so a hook running during setup finds one or the other.
function replace(target: string, fill: (staging: string) => void) {
  ConsoleStore.ensureDir(path.dirname(target))
  const staging = `${target}.${randomUUID()}.tmp`
  const retired = `${target}.${randomUUID()}.old`
  try {
    fill(staging)
    if (existsSync(target)) renameSync(target, retired)
    renameSync(staging, target)
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(retired, { recursive: true, force: true })
  }
}
