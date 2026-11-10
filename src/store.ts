export * as ConsoleStore from "./store"

import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Flock } from "@opencode/util/flock"
import { roots } from "@opencode/util/global-roots"
import { Effect } from "effect"

/**
 * Where the CLI keeps its sign-in and the workspace config it last fetched, and the key the environment supplies
 * instead of a sign-in.
 */
export interface Info {
  readonly data: string
  readonly cache: string
  readonly env: Env
}

/** `OPENCODE_API_KEY` signs CI and headless runs in; `OPENCODE_CONSOLE_SERVER` names its Console. */
export interface Env {
  readonly OPENCODE_API_KEY?: string | undefined
  readonly OPENCODE_CONSOLE_SERVER?: string | undefined
}

/** The XDG directories for `opencode-console`, or every directory under `root`. */
export function make(input: { readonly root?: string; readonly env?: Env } = {}): Info {
  const env = input.env ?? {
    OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
    OPENCODE_CONSOLE_SERVER: process.env.OPENCODE_CONSOLE_SERVER,
  }
  if (input.root) return { data: path.join(input.root, "data"), cache: path.join(input.root, "cache"), env }
  const dirs = roots("opencode-console")
  return { data: dirs.data, cache: dirs.cache, env }
}

export const credentialFile = (store: Info) => path.join(store.data, "credential.json")
export const snapshotFile = (store: Info) => path.join(store.cache, "config.json")
export const syncClaimFile = (store: Info) => path.join(store.cache, "sync.claim")
/** When the CLI last warned about, and reported, an agent's policy hooks being off. */
export const hooksNoticeFile = (store: Info, agent: string) => path.join(store.cache, `hooks-off-${agent}.json`)
export const watchesFile = (store: Info) => path.join(store.data, "watches.json")

// A lock left by a crashed process goes stale after 30 seconds without its heartbeat; the work it guards is a single
// request with a 30 second timeout.
const LOCK_STALE_MS = 30_000
const LOCK_TIMEOUT_MS = 35_000

/**
 * Runs `body` holding the lock every change to the stored sign-in or its workspace config takes, across processes.
 * Console refresh tokens are single-use and reusing one signs the member out, so two processes must never refresh at
 * once. The lock sits beside the credential, so processes with different cache directories still share it. Other
 * state names its own `lock`, so it never waits on a refresh.
 */
export function locked<A, E, R>(
  store: Info,
  body: Effect.Effect<A, E, R>,
  lock = "credential",
  timeoutMs = LOCK_TIMEOUT_MS,
) {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => {
        // Flock creates missing directories with the default mode, which would leave the sign-in's directory readable.
        ensureDir(store.data)
        ensureDir(path.join(store.data, "locks"))
        return Flock.acquire(lock, {
          dir: path.join(store.data, "locks"),
          staleMs: LOCK_STALE_MS,
          timeoutMs,
        })
      },
      catch: (cause) =>
        cause instanceof Error && cause.message.startsWith("Timed out waiting for lock")
          ? new Error(
              `Timed out after ${timeoutMs / 1000}s waiting for another opencode-console process to update the ${lock === "credential" ? "sign-in" : lock}`,
              { cause },
            )
          : cause,
    }),
    () => body,
    (lease) => Effect.tryPromise(() => lease.release()).pipe(Effect.ignore),
  )
}

/** The contents of `file`, or `undefined` when it doesn't exist. Any other failure, such as no permission, throws. */
export function read(file: string) {
  try {
    return readFileSync(file, "utf8")
  } catch (error) {
    if (code(error) === "ENOENT") return undefined
    throw error
  }
}

/** When `file` last changed, in epoch milliseconds, or `undefined` when it can't be found or read. */
export function modified(file: string) {
  try {
    return statSync(file, { throwIfNoEntry: false })?.mtimeMs
  } catch (error) {
    if (unreachable(error)) return undefined
    throw error
  }
}

/**
 * Replaces `file` in one step, readable only by this user, so a process reading it at the same time sees the old or
 * the new contents, never a partial write.
 */
export function write(file: string, contents: string) {
  ensureDir(path.dirname(file))
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" })
  try {
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

export function remove(file: string) {
  rmSync(file, { force: true })
}

/** Whether `error` says a path can't be found or read, which callers checking a path treat as absent. */
export function unreachable(error: unknown) {
  return ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code(error) ?? "")
}

/** Creates `directory` readable only by this user, narrowing it when it already existed with a wider mode. */
export function ensureDir(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") chmodSync(directory, 0o700)
}

function code(error: unknown) {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
}
