export * as SettingsFile from "./settings-file"

import { randomUUID } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { ConsoleStore } from "./store"

/**
 * A harness's JSON settings file, which setup changes key by key and never writes over when it can't read it. Keys are
 * dotted paths one level deep (`env.ANTHROPIC_BASE_URL`).
 */
export type Settings = Record<string, unknown>

/** Each key setup set, with the value it had before (none when it was unset), and what setup last wrote to it. */
export interface Owned {
  readonly originals: Readonly<Record<string, { readonly value?: unknown }>>
  readonly written: Readonly<Record<string, unknown>>
}

/** The schema of `Owned`, for the records setups keep. */
export const OwnedFields = {
  originals: Schema.Record(Schema.String, Schema.Struct({ value: Schema.optional(Schema.Unknown) })),
  written: Schema.Record(Schema.String, Schema.Unknown),
}

/** A settings file that exists but isn't a JSON object is the member's to fix, so this throws rather than read it. */
export function read(file: string): Settings | undefined {
  const text = ConsoleStore.read(file)
  if (text === undefined || text.trim() === "") return undefined
  const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(text))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${file} isn't valid JSON, so it was left alone. Fix it and run setup again.`)
  return { ...parsed }
}

/** Writes `value` as indented JSON, only when it changed. */
export function write(file: string, value: Settings, mode?: number) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (ConsoleStore.read(file) === text) return
  writeFile(file, text, mode)
}

/**
 * Sets each key to its value, recording what it was before. A key the member changed since setup last wrote it is
 * left as they set it unless `explicit` (setup run by the member, which sets every key again). Keys setup owned that
 * `values` no longer names are put back as they were.
 */
export function apply(
  settings: Settings,
  values: Record<string, unknown>,
  owned: Owned | undefined,
  explicit: boolean,
) {
  const originals = { ...owned?.originals }
  const written: Record<string, unknown> = { ...owned?.written }
  Object.keys(originals)
    .filter((key) => !(key in values))
    .forEach((key) => {
      restore(settings, key, { originals, written })
      delete originals[key]
      delete written[key]
    })
  Object.entries(values).forEach(([key, value]) => {
    const changed = key in written && JSON.stringify(get(settings, key)) !== JSON.stringify(written[key])
    if (changed && !explicit) return
    if (!(key in originals)) originals[key] = keyed(settings, key)
    set(settings, key, value)
    written[key] = value
  })
  return { originals, written }
}

/** Puts a key back as it was before setup, unless the member changed it since. */
export function restore(settings: Settings, key: string, state: Owned) {
  if (JSON.stringify(get(settings, key)) !== JSON.stringify(state.written[key])) return
  const original = state.originals[key]
  if (original && "value" in original && original.value !== undefined) set(settings, key, original.value)
  else unset(settings, key)
}

export function get(settings: Settings, key: string): unknown {
  const [head, tail] = split(key)
  return tail === undefined ? settings[head] : record(settings[head])[tail]
}

export function set(settings: Settings, key: string, value: unknown) {
  const [head, tail] = split(key)
  if (tail === undefined) settings[head] = value
  else settings[head] = { ...record(settings[head]), [tail]: value }
}

export function unset(settings: Settings, key: string) {
  const [head, tail] = split(key)
  if (tail === undefined) {
    delete settings[head]
    return
  }
  const parent = record(settings[head])
  delete parent[tail]
  if (Object.keys(parent).length === 0) delete settings[head]
  else settings[head] = parent
}

export const backupOf = (file: string) => `${file}.opencode-console.bak`

/** A copy of a file as it was before setup first changed it, kept once and readable only by the member. */
export function backup(file: string) {
  if (!existsSync(file) || existsSync(backupOf(file))) return
  copyFileSync(file, backupOf(file))
  chmodSync(backupOf(file), 0o600)
}

/**
 * Replaces a harness's file in one step, keeping its mode, or `mode` for a new one. Its directory is created as any
 * other would be: these are the member's own directories, which the CLI never narrows.
 */
export function writeFile(file: string, contents: string | Uint8Array, mode = 0o644) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, contents, { mode: existsSync(file) ? statSync(file).mode & 0o777 : mode, flag: "wx" })
  try {
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** Whether `hooks[event]`, in the shape Claude Code's settings and Codex's `hooks.json` share, holds a handler of `ours`. */
export function hasHook(settings: Settings | undefined, event: string, ours: (handler: unknown) => boolean) {
  const groups = record(settings?.hooks)[event]
  return (
    Array.isArray(groups) &&
    groups.some((group) => {
      const handlers = record(group).hooks
      return Array.isArray(handlers) && handlers.some(ours)
    })
  )
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {}
}

export function text(value: unknown) {
  return typeof value === "string" && value !== "" ? value : undefined
}

function keyed(settings: Settings, key: string): { value?: unknown } {
  const value = get(settings, key)
  return value === undefined ? {} : { value }
}

function split(key: string): [string, string | undefined] {
  const dot = key.indexOf(".")
  return dot === -1 ? [key, undefined] : [key.slice(0, dot), key.slice(dot + 1)]
}

/**
 * A command line for settings a harness runs through the shell (`cmd.exe` on Windows): Claude Code's `apiKeyHelper`
 * and `headersHelper`, and Codex's `http_headers_helper`. Codex's hooks run in PowerShell there (`Codex.hookLine`).
 */
export function shellCommand(argv: readonly string[]) {
  return argv
    .map((arg) =>
      process.platform === "win32"
        ? `"${arg.replaceAll('"', '""')}"`
        : /^[\w@%+=:,./-]+$/.test(arg)
          ? arg
          : `'${arg.replaceAll("'", `'"'"'`)}'`,
    )
    .join(" ")
}
