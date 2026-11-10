export * as SelfUpdate from "./self-update"

// `self-update`, which a hook starts in its own process when a check is due (auto-update.ts), and `update [--check]`:
// reads the install's channel, and when the channel's current build isn't the one installed, downloads it, checks its
// size and SHA-256 (npm's SHA-512 for the Node bundle), runs its `self-test`, and only then swaps it in, keeping the
// one it replaces for a rollback. The new build then rewrites every agent's settings itself (`sync --refresh-agents`).
//
// Ported from anomalyco/browse (2b6194cf): `install`'s manifest download and verification, `runtime-update.ts`'s
// `self-update` and `update` flows, and `auto-update.ts`'s npm dist-tag check and version ordering. Browse reruns the
// install script it shipped with; here the download, verification and swap are TypeScript, because the self-test,
// last-known-good copy and receipt policy hooks need belong with the code that tests them, and work the same on
// Windows without PowerShell.
import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { CliInstall } from "../install"
import { ConsoleStore } from "../store"
import { AutoUpdate } from "./auto-update"
import { ReleaseService } from "./release-service"
import { Signature } from "./signature"
import { UpdateEnvironment } from "./environment"

export const NPM_REGISTRY = "https://registry.npmjs.org"

/**
 * Where an npm bundle install updates from: npm itself, or, in a dev build only, a stand-in on this computer. As with
 * the release service, a project's environment can't pick where the code comes from.
 */
export const npmRegistry = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  version: string = ReleaseService.buildVersion,
) => {
  const named = (env.OPENCODE_CONSOLE_NPM_REGISTRY?.trim() || NPM_REGISTRY).replace(/\/+$/, "")
  return named === NPM_REGISTRY || (ReleaseService.devBuild(version) && ReleaseService.loopback(named))
    ? named
    : NPM_REGISTRY
}

export type Outcome =
  | { readonly status: "unmanaged" }
  | { readonly status: "up-to-date"; readonly version: string; readonly detail?: string }
  | { readonly status: "available"; readonly from: string; readonly to: string }
  | { readonly status: "installed"; readonly from: string; readonly to: string; readonly refreshed: boolean }
  | { readonly status: "blocked"; readonly version: string }
  | { readonly status: "failed"; readonly message: string }

export interface Options {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly fetch?: typeof fetch
  readonly now?: () => number
  /** Only say what an update would install. */
  readonly check?: boolean
  /** Install a build even after it was rolled back for crashing, as `update` run by the member does. */
  readonly force?: boolean
  readonly selfTest?: AutoUpdate.SelfTest
  /** Runs the new build's `sync --quiet --refresh-agents`; true when it exited 0. */
  readonly refresh?: (command: readonly string[]) => boolean
  readonly platform?: NodeJS.Platform
  /** The build running this update; only a dev build follows a stand-in on this computer. */
  readonly version?: string
  /** Whether a staged binary is one Anomaly signed; throws if not. */
  readonly verify?: Signature.Verify
}

/**
 * One update of the install in `<data>/cli`: a release binary follows its channel on the release service, an npm
 * bundle the npm dist-tag. Runs under the `update` lock, so two never overlap, and records what happened in
 * `auto-update.json` for the next hook's check. A failed install leaves the installed build as it was.
 */
export async function run(store: ConsoleStore.Info, options: Options = {}): Promise<Outcome> {
  const now = options.now ?? Date.now
  const outcome = await Effect.runPromise(
    ConsoleStore.locked(
      store,
      Effect.promise(async (): Promise<Outcome> => {
        // Read under the lock: a setup or update that held it may have changed what's installed.
        const installed = CliInstall.receipt(store)
        if (!installed) return { status: "unmanaged" }
        AutoUpdate.update(store, (state) => ({ ...state, installing: { pid: process.pid, startedAt: now() } }))
        const result = await (
          installed.method === "direct" ? direct(store, installed, options) : bundle(store, installed, options)
        ).catch((error: unknown) => ({ status: "failed", message: message(error) }) as const)
        AutoUpdate.update(store, ({ installing: _installing, ...state }) => state)
        return result
      }),
      "update",
    ).pipe(Effect.catch((error) => Effect.succeed({ status: "failed", message: message(error) } as const))),
  )
  if (outcome.status !== "installed") return outcome
  const next = CliInstall.receipt(store)
  const refreshed = next ? (options.refresh ?? refreshAgents)(CliInstall.command(store, next, options.platform)) : false
  return { ...outcome, refreshed }
}

/** A release binary: the channel's manifest, the protocol's decision, then the build it names. */
async function direct(store: ConsoleStore.Info, installed: CliInstall.Receipt, options: Options): Promise<Outcome> {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now
  if (!installed.target) throw new Error("the install doesn't say which build it is, so run setup again")
  const service = ReleaseService.releaseService(env, options.version)
  const state = AutoUpdate.read(store)
  const answer = await ReleaseService.checkRelease({
    version: installed.version,
    channel: installed.channel,
    target: installed.target,
    stateDir: store.data,
    service,
    ...(state.etag ? { etag: state.etag } : {}),
    ...(installed.sha256 ? { sha256: installed.sha256 } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  }).catch((error: unknown) => {
    AutoUpdate.update(store, (current) => ({ ...current, failed: message(error) }))
    throw error
  })
  if (answer.status === "unchanged") {
    AutoUpdate.update(store, ({ failed: _failed, ...current }) => current)
    return { status: "up-to-date", version: installed.version }
  }
  if (answer.status === "missing") {
    AutoUpdate.update(store, ({ failed: _failed, etag: _etag, ...current }) => current)
    return { status: "up-to-date", version: installed.version, detail: `no ${installed.channel} release yet` }
  }
  const decision = answer.decision
  if (decision.action === "reject") {
    AutoUpdate.update(store, (current) => ({ ...current, failed: `manifest rejected: ${decision.reason}` }))
    return { status: "failed", message: `the ${installed.channel} manifest was rejected (${decision.reason})` }
  }
  // The ETag is kept only once the release it names is dealt with, so an install that fails is retried.
  const remember = () =>
    AutoUpdate.update(store, ({ failed: _failed, etag: _etag, ...current }) => ({
      ...current,
      ...(answer.etag ? { etag: answer.etag } : {}),
    }))
  if (decision.action !== "install") {
    remember()
    return {
      status: "up-to-date",
      version: installed.version,
      ...(decision.reason === "rollout_deferred" ? { detail: `${answer.releaseVersion} is still rolling out` } : {}),
    }
  }
  const build = { version: decision.version, sha256: decision.target.sha256 }
  if (!options.force && AutoUpdate.isBlocked(state, build)) {
    remember()
    return { status: "blocked", version: decision.version }
  }
  if (options.check) return { status: "available", from: installed.version, to: decision.version }
  const staging = path.join(CliInstall.directory(store), `.staging-${randomUUID()}`)
  try {
    await attempt(store, decision.version, now, async () => {
      const staged = await download(service, decision.target, installed, staging, options)
      if (!(await (options.selfTest ?? AutoUpdate.selfTest)([staged])))
        throw new Error(`${decision.version} failed its self-test, so ${installed.version} stays installed`)
      CliInstall.activate(store, staged, { ...installed, version: decision.version, sha256: build.sha256 })
    })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  remember()
  installedNow(store, installed.version, build, now())
  return { status: "installed", from: installed.version, to: decision.version, refreshed: false }
}

/**
 * Downloads the release archive the manifest names, checks its size and SHA-256 before anything is unpacked, and
 * unpacks it; returns the binary inside.
 */
async function download(
  service: string,
  target: ReleaseService.Target,
  installed: CliInstall.Receipt,
  staging: string,
  options: Options,
) {
  // A file on the release service itself; `//host/…` (or `/\host/…`, which URLs read the same) would leave it.
  const url = new URL(target.url, `${service}/`)
  if (url.origin !== new URL(service).origin) throw new Error(`unexpected download URL ${target.url}`)
  ConsoleStore.ensureDir(staging)
  const response = await (options.fetch ?? fetch)(url, {
    headers: { "user-agent": `opencode-console/${installed.channel}/${installed.version}/cli` },
    signal: AbortSignal.timeout(30 * 60_000),
  })
  if (!response.ok) throw new Error(`the release service answered ${response.status} for ${target.url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== target.size)
    throw new Error(`size mismatch for ${path.basename(target.url)}: expected ${target.size}, got ${bytes.length}`)
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== target.sha256)
    throw new Error(`checksum mismatch for ${path.basename(target.url)}: expected ${target.sha256}, got ${actual}`)
  const archive = path.join(staging, "release.tgz")
  writeFileSync(archive, bytes)
  const member = `package/bin/${CliInstall.binaryName(options.platform)}`
  if (unpack(archive, staging, [member]) !== undefined) throw new Error(`${path.basename(target.url)} has no ${member}`)
  // A Linux binary's signature beside it, when the archive has one.
  if ((options.platform ?? process.platform) === "linux") unpack(archive, staging, [`${member}.sig`])
  const binary = path.join(staging, member)
  if (!lstatSync(binary).isFile()) throw new Error(`${path.basename(target.url)}'s ${member} isn't a file`)
  // Before its self-test, the first time anything from the download runs.
  await (options.verify ?? Signature.check)(binary, {
    channel: installed.channel,
    platform: options.platform ?? process.platform,
  })
  return binary
}

/** The npm package's Node bundle, where no release binary fits: the dist-tag, ordered as npm orders versions. */
async function bundle(store: ConsoleStore.Info, installed: CliInstall.Receipt, options: Options): Promise<Outcome> {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now
  const registry = npmRegistry(env, options.version)
  const tag = installed.channel === "stable" ? "latest" : installed.channel
  const published = await packument(registry, options.fetch).catch((error: unknown) => {
    AutoUpdate.update(store, (current) => ({ ...current, failed: message(error) }))
    throw error
  })
  AutoUpdate.update(store, ({ failed: _failed, ...current }) => current)
  const latest = published["dist-tags"][tag]
  if (!latest || compareVersions(latest, installed.version) <= 0)
    return { status: "up-to-date", version: installed.version }
  if (!options.force && AutoUpdate.isBlocked(AutoUpdate.read(store), { version: latest }))
    return { status: "blocked", version: latest }
  const dist = published.versions[latest]?.dist
  if (!dist) throw new Error(`${CliInstall.packageName}@${latest} has no tarball`)
  if (!URL.canParse(dist.tarball) || new URL(dist.tarball).origin !== new URL(registry).origin)
    throw new Error(`${CliInstall.packageName}@${latest}'s tarball isn't on ${registry}`)
  if (options.check) return { status: "available", from: installed.version, to: latest }
  const staging = `${CliInstall.directory(store)}.${randomUUID()}.staging`
  try {
    await attempt(store, latest, now, async () => {
      const response = await (options.fetch ?? fetch)(dist.tarball, { signal: AbortSignal.timeout(10 * 60_000) })
      if (!response.ok) throw new Error(`the registry answered ${response.status} for ${dist.tarball}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
      if (actual !== dist.integrity) throw new Error(`integrity mismatch for ${CliInstall.packageName}@${latest}`)
      ConsoleStore.ensureDir(staging)
      writeFileSync(path.join(staging, "package.tgz"), bytes)
      const failed = unpack(path.join(staging, "package.tgz"), staging)
      if (failed !== undefined) throw new Error(`couldn't unpack ${CliInstall.packageName}@${latest}: ${failed}`)
      const entry = path.join(staging, "package")
      if (!(await (options.selfTest ?? AutoUpdate.selfTest)([installed.node ?? "node", path.join(entry, "index.js")])))
        throw new Error(`${latest} failed its self-test, so ${installed.version} stays installed`)
      ConsoleStore.write(
        CliInstall.receiptFile(entry),
        `${JSON.stringify({ ...installed, version: latest }, null, 2)}\n`,
      )
      CliInstall.activateBundle(store, entry)
    })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  installedNow(store, installed.version, { version: latest }, now())
  return { status: "installed", from: installed.version, to: latest, refreshed: false }
}

const Packument = Schema.Struct({
  "dist-tags": Schema.Record(Schema.String, Schema.String),
  versions: Schema.Record(
    Schema.String,
    Schema.Struct({ dist: Schema.Struct({ tarball: Schema.String, integrity: Schema.String }) }),
  ),
})

/** `@opencode/console`'s dist-tags and each version's tarball, from npm's abbreviated metadata. */
async function packument(registry: string, request: typeof fetch = fetch) {
  const response = await request(`${registry}/${CliInstall.packageName.replace("/", "%2f")}`, {
    headers: { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`the registry answered ${response.status} for ${CliInstall.packageName}`)
  const decoded = Schema.decodeUnknownOption(Packument)(await response.json())
  if (Option.isNone(decoded)) throw new Error(`the registry's ${CliInstall.packageName} metadata can't be read`)
  return decoded.value
}

/** A version npm publishes: 1.2.3, 1.2.4-dev.42 (1.2.4-dev.42.2 for a rerun), or a beta. */
const UPDATE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(dev|beta)\.(\d+)(?:\.(\d+))?)?$/

/** Orders versions as semver does for these shapes: dev below beta below the release, then by run. Anything else never compares as newer. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = UPDATE_VERSION.exec(value)
    if (!match) return undefined
    const stage = match[4] === undefined ? 2 : match[4] === "beta" ? 1 : 0
    return [Number(match[1]), Number(match[2]), Number(match[3]), stage, Number(match[5] ?? 0), Number(match[6] ?? 0)]
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return 0
  const index = a.findIndex((part, at) => part !== b[at])
  return index === -1 ? 0 : a[index]! < b[index]! ? -1 : 1
}

/**
 * For `setup` run from npm: the channel's current release binary for this computer, downloaded, verified and
 * self-tested in a directory of its own, so setup can hand over to it. Undefined where no binary fits this computer or
 * the release service has none yet, and setup copies the Node bundle instead.
 */
export async function stageForSetup(input: {
  readonly version: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly fetch?: typeof fetch
  readonly target?: string | undefined
  readonly selfTest?: AutoUpdate.SelfTest
  readonly verify?: Signature.Verify
}) {
  const host = input.target ?? CliInstall.hostTarget()
  if (!host) return undefined
  const env = input.env ?? process.env
  const service = ReleaseService.releaseService(env, input.version)
  const channel = CliInstall.channelOf(input.version)
  const response = await ReleaseService.fetchManifest({
    channel,
    version: input.version,
    service,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  })
  if (response.status !== "manifest") return undefined
  const manifest = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(response.text),
  )
  const parsed = manifest === undefined ? undefined : ReleaseService.parseManifest(manifest)
  if (!parsed || parsed.app !== "opencode-console" || parsed.artifact !== "cli" || parsed.channel !== channel)
    return undefined
  const target = parsed.release.targets[CliInstall.serviceTarget(host)]
  if (!target) return undefined
  const staging = mkdtempSync(path.join(os.tmpdir(), "opencode-console-setup-"))
  const binary = await download(service, target, { method: "direct", version: input.version, channel }, staging, {
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.verify ? { verify: input.verify } : {}),
  }).catch((error: unknown) => {
    rmSync(staging, { recursive: true, force: true })
    throw error
  })
  if (!(await (input.selfTest ?? AutoUpdate.selfTest)([binary]))) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`the ${channel} release ${parsed.release.version} failed its self-test on this computer`)
  }
  return {
    binary,
    sha256: target.sha256,
    version: parsed.release.version,
    cleanup: () => rmSync(staging, { recursive: true, force: true }),
  }
}

/** Runs the new build's own `sync --refresh-agents`, so every agent's settings are written by the code that reads them. */
export const refreshAgents = (command: readonly string[]) =>
  spawnSync(command[0]!, [...command.slice(1), "sync", "--quiet", "--refresh-agents"], {
    stdio: "ignore",
    timeout: 120_000,
    windowsHide: true,
  }).status === 0

// A failed download, verification or self-test backs the next attempt at the same version off.
async function attempt<A>(store: ConsoleStore.Info, version: string, now: () => number, body: () => Promise<A>) {
  return body().catch((error: unknown) => {
    failed(store, version, now(), error)
    throw error
  })
}

function failed(store: ConsoleStore.Info, version: string, at: number, error: unknown) {
  AutoUpdate.update(store, (state) => ({
    ...state,
    lastError: {
      message: message(error),
      at,
      version,
      attempts: 1 + (state.lastError?.version === version ? state.lastError.attempts : 0),
    },
  }))
}

// A build installed on purpose (`update`) is no longer blocked, so a later rollback can block it again.
function installedNow(
  store: ConsoleStore.Info,
  from: string,
  to: { readonly version: string; readonly sha256?: string },
  at: number,
) {
  AutoUpdate.update(store, ({ lastError: _lastError, crashes: _crashes, blocked, ...state }) => {
    const kept = (blocked ?? []).filter((build) => !AutoUpdate.isBlocked({ blocked: [build] }, to))
    return { ...state, lastUpdate: { from, to: to.version, at }, ...(kept.length > 0 ? { blocked: kept } : {}) }
  })
}

// Every platform the binaries ship for has `tar`, Windows since 10 (1803), run by its own path so neither `PATH` (which
// a project can prepend to) nor Git Bash's GNU tar, which reads `C:` as a remote host, is picked.
// `members` names what to take out, and nothing else is: a DLL beside a genuine signed executable would load into its
// self-test.
function unpack(archive: string, directory: string, members: readonly string[] = []) {
  const tar =
    process.platform === "win32"
      ? path.join(UpdateEnvironment.systemRoot(), "System32", "tar.exe")
      : ["/usr/bin/tar", "/bin/tar"].find((file) => existsSync(file))
  if (!tar || !existsSync(tar)) throw new Error("no system tar to unpack the update with")
  // A fixed environment, so a project's TAR_OPTIONS can't add to what this extracts.
  const result = spawnSync(tar, ["-xzf", archive, "-C", directory, ...members], {
    encoding: "utf8",
    windowsHide: true,
    env: UpdateEnvironment.tool(),
  })
  return result.status === 0 ? undefined : result.stderr.trim()
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
