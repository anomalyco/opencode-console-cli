export * as AutoUpdate from "./auto-update"

// When an install checks for updates, and what it does when the build it updated to keeps crashing. Ported from
// anomalyco/browse cli/src/update/auto-update.ts (2b6194cf): the state file, `OPENCODE_CONSOLE_AUTO_UPDATE`, the hourly
// cadence and the 15 → 60 → 240 minute backoff. Browse's relay is a long-running daemon that ticks; this CLI runs as
// short-lived hooks, so a hook only decides whether a check is due and starts `self-update` in its own process
// (self-update.ts), which checks, downloads, self-tests and swaps. Browse fails open when its binary breaks; policy
// hooks fail closed, so a build that crashes hooks three times in a row is rolled back to the last one that worked.
import { spawn } from "node:child_process"
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { CliInstall } from "../install"
import { ConsoleStore } from "../store"

export const HOUR_MS = 3_600_000
/** A session start checks right away, unless another did within this long. */
const SESSION_MS = 60_000
/** An installer that has run this long is given up on, however it's doing. */
const INSTALL_TIMEOUT_MS = 30 * 60_000
/** Hooks that crash this many times in a row, on one build, roll it back. */
export const CRASH_LIMIT = 3

const Build = Schema.Struct({ version: Schema.String, sha256: Schema.optional(Schema.String) })

/** `<data>/auto-update.json`, beside `<data>/cli` so a swap or rollback of the install keeps it. */
export const State = Schema.Struct({
  /** When a check last started, by a hook's clock. */
  checkedAt: Schema.optional(Schema.Number),
  /** The ETag of the manifest last read, for `If-None-Match`. */
  etag: Schema.optional(Schema.String),
  /** Why the last check couldn't read the release service or npm; checks go on hourly. */
  failed: Schema.optional(Schema.String),
  /** The `self-update` process running now. */
  installing: Schema.optional(Schema.Struct({ pid: Schema.Number, startedAt: Schema.Number })),
  lastUpdate: Schema.optional(Schema.Struct({ from: Schema.String, to: Schema.String, at: Schema.Number })),
  /** The last install that failed (download, verification or self-test), which backs further attempts off. */
  lastError: Schema.optional(
    Schema.Struct({
      message: Schema.String,
      at: Schema.Number,
      version: Schema.optional(Schema.String),
      attempts: Schema.Number,
    }),
  ),
  /** Hooks that crashed in a row on the installed build; a clean one clears it. */
  crashes: Schema.optional(Schema.Struct({ version: Schema.String, count: Schema.Number })),
  /** Builds rolled back after crashing, never installed again; a different build on the channel is. */
  blocked: Schema.optional(Schema.Array(Build)),
})
export type State = typeof State.Type

export const stateFile = (store: ConsoleStore.Info) => path.join(store.data, "auto-update.json")
export const logFile = (store: ConsoleStore.Info) => path.join(store.data, "logs", "auto-update.log")

export function read(store: ConsoleStore.Info): State {
  const text = ConsoleStore.read(stateFile(store))
  return (
    (text === undefined
      ? undefined
      : Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(State))(text))) ?? {}
  )
}

export function update(store: ConsoleStore.Info, change: (state: State) => State) {
  const next = change(read(store))
  ConsoleStore.write(stateFile(store), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/** `OPENCODE_CONSOLE_AUTO_UPDATE=off` (or `0`, `false`) turns checks off, as IT can set in managed settings. */
export const enabled = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  !["off", "0", "false"].includes(env.OPENCODE_CONSOLE_AUTO_UPDATE?.trim().toLowerCase() ?? "")

/**
 * The receipt of the install this process runs from, when it updates itself: setup put it in `<data>/cli` and the
 * running file is inside. `running` is the binary, the bundle's script, or the module an agent loaded.
 */
export function managed(store: ConsoleStore.Info, running: string) {
  const installed = CliInstall.receipt(store)
  return installed && inside(CliInstall.directory(store), running) ? installed : undefined
}

/** Starts `self-update` detached: the command, and the file its output goes to. */
export type Start = (command: readonly string[], log: string) => void

export type Started = "off" | "unmanaged" | "installing" | "backoff" | "recent" | "started"

/**
 * Starts a background `self-update` when a check is due: hourly, or at a session start (`session`) unless one started
 * in the last minute, and never while one runs or a failed install is backing off. Never waits on the network, so
 * hooks call it on their way out.
 */
export function start(
  store: ConsoleStore.Info,
  input: {
    readonly running: string
    readonly session?: boolean
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly now?: number
    readonly start?: Start
  },
): Started {
  const env = input.env ?? process.env
  if (!enabled(env)) return "off"
  const installed = managed(store, input.running)
  if (!installed) return "unmanaged"
  const now = input.now ?? Date.now()
  const state = read(store)
  if (state.installing && alive(state.installing.pid) && now - state.installing.startedAt < INSTALL_TIMEOUT_MS)
    return "installing"
  const failure = state.lastError
  if (failure && now >= failure.at && now - failure.at < backoff(failure.attempts)) return "backoff"
  const hourly = Math.min(Number(env.OPENCODE_CONSOLE_AUTO_UPDATE_INTERVAL_MS) || HOUR_MS, HOUR_MS)
  const interval = input.session ? Math.min(SESSION_MS, hourly) : hourly
  if (state.checkedAt !== undefined && now >= state.checkedAt && now - state.checkedAt < interval) return "recent"
  update(store, (current) => ({ ...current, checkedAt: now }))
  ;(input.start ?? detached)([...CliInstall.command(store, installed), "self-update"], logFile(store))
  return "started"
}

/** How long a failed install waits before the next attempt: 15 minutes, then an hour, then four. */
export const backoff = (attempts: number) => (attempts <= 1 ? 15 : attempts === 2 ? 60 : 240) * 60_000

/**
 * Runs a command's `self-test`; true when it exits 0 within the time, in a throwaway home so it touches nothing. It
 * doesn't block the event loop, so the update lock's heartbeat keeps going while a new binary waits on the OS's
 * malware scan.
 */
export type SelfTest = (command: readonly string[], timeoutMs?: number) => Promise<boolean>

export const selfTest: SelfTest = (command, timeoutMs = 30_000) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "opencode-console-self-test-"))
  return new Promise<boolean>((resolve) => {
    const child = spawn(command[0]!, [...command.slice(1), "self-test"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        OPENCODE_CONSOLE_AUTO_UPDATE: "off",
      },
    })
    const output: Buffer[] = []
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk))
    child.on("error", () => resolve(false))
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve(code === 0 && Buffer.concat(output).toString("utf8").includes("self-test ok"))
    })
  }).finally(() => rmSync(home, { recursive: true, force: true }))
}

export type Crashed = "unmanaged" | "counted" | "busy" | "rolled-back" | "no-previous" | "previous-broken"

/**
 * Counts a hook that crashed, rather than deciding, on the installed build. The third in a row rolls the install back
 * to the last build that worked, once that passes its own self-test, blocks the crashing build from being installed
 * again, and has the restored build rewrite every agent's settings. The hook still fails closed either way, and waits
 * at most a few seconds: agents give hooks 15 to 60, so a rollback an update holds the lock against waits for the next
 * crash.
 */
export async function crashed(
  store: ConsoleStore.Info,
  input: { readonly running: string; readonly selfTest?: SelfTest; readonly start?: Start; readonly now?: number },
): Promise<Crashed> {
  return Effect.runPromise(
    ConsoleStore.locked(
      store,
      Effect.promise(() => rollback(store, input)),
      "update",
      2_000,
    ).pipe(Effect.catch(() => Effect.succeed("busy" as const))),
  )
}

async function rollback(
  store: ConsoleStore.Info,
  input: { readonly running: string; readonly selfTest?: SelfTest; readonly start?: Start; readonly now?: number },
): Promise<Crashed> {
  const installed = managed(store, input.running)
  if (!installed) return "unmanaged"
  const state = update(store, (current) => ({
    ...current,
    crashes: {
      version: installed.version,
      count: (current.crashes?.version === installed.version ? current.crashes.count : 0) + 1,
    },
  }))
  if ((state.crashes?.count ?? 0) < CRASH_LIMIT) return "counted"
  const previous = CliInstall.previousCommand(store)
  if (!previous) return "no-previous"
  // The last build ran here before, so it has no first-run scan to wait on.
  if (!(await (input.selfTest ?? selfTest)(previous, 8_000))) return "previous-broken"
  const restored = CliInstall.restore(store)
  if (!restored) return "no-previous"
  // The manifest last read named the build just rolled back, so the next check reads it again rather than a 304.
  update(store, ({ crashes: _crashes, etag: _etag, ...current }) => ({
    ...current,
    blocked: [
      ...(current.blocked ?? []).filter((build) => build.version !== installed.version),
      { version: installed.version, ...(installed.sha256 ? { sha256: installed.sha256 } : {}) },
    ],
    lastUpdate: { from: installed.version, to: restored.version, at: input.now ?? Date.now() },
  }))
  ;(input.start ?? detached)(
    [...CliInstall.command(store, restored), "sync", "--quiet", "--refresh-agents"],
    logFile(store),
  )
  return "rolled-back"
}

/**
 * Whether a policy check's crash could be the build's fault, so it counts toward a rollback. A tool call the hook can't
 * read, a sign-in the member has to repair, and a system error such as a full disk or a file it may not read would
 * crash any build the same way, so they don't.
 */
export async function buildFault(error: unknown) {
  const [{ ClaudeCodeHook }, { CodexHook }, { HermesHook }, { ConsoleCredentials }] = await Promise.all([
    import("../claude-code-hook"),
    import("../codex-hook"),
    import("../hermes-hook"),
    import("../credentials"),
  ])
  return !(
    error instanceof ClaudeCodeHook.Unreadable ||
    error instanceof CodexHook.Unreadable ||
    error instanceof HermesHook.Unreadable ||
    error instanceof ConsoleCredentials.Unusable ||
    (error instanceof Error && "code" in error && typeof error.code === "string")
  )
}

/** Clears the crash count once a hook on the installed build decides cleanly; reads one small file otherwise. */
export function healthy(store: ConsoleStore.Info) {
  if (read(store).crashes) update(store, ({ crashes: _crashes, ...current }) => current)
}

/** Whether a build was rolled back after crashing: the same archive, or the same version when no archive is known. */
export const isBlocked = (state: State, build: { readonly version: string; readonly sha256?: string | undefined }) =>
  (state.blocked ?? []).some((item) =>
    item.sha256 !== undefined && build.sha256 !== undefined
      ? item.sha256 === build.sha256
      : item.version === build.version,
  )

/** Starts a command detached, its output appended to `log`, so it outlives the hook that started it. */
export const detached: Start = (command, log) => {
  ConsoleStore.ensureDir(path.dirname(log))
  const descriptor = openSync(log, "a", 0o600)
  try {
    spawn(command[0]!, command.slice(1), {
      detached: true,
      stdio: ["ignore", descriptor, descriptor],
      windowsHide: true,
      env: process.env,
    })
      .on("error", () => undefined)
      .unref()
  } finally {
    closeSync(descriptor)
  }
}

/** Whether a process still runs. */
export function alive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

function inside(directory: string, file: string) {
  try {
    const relative = path.relative(realpathSync(directory), realpathSync(file))
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  } catch {
    return false
  }
}
