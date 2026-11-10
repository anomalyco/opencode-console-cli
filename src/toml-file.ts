export * as TomlFile from "./toml-file"

import { parse } from "smol-toml"
import { ConsoleStore } from "./store"

/**
 * A harness's TOML config file, such as Codex's `config.toml`, which setup changes in place: a top-level key's line is
 * replaced, and a table setup owns is added or removed whole, so the member's comments, order and formatting stay as
 * they wrote them. Every change is checked by reading the result back, and a change that would alter anything else in
 * the file throws instead of writing it.
 */
export type Table = Record<string, unknown>

/** The file's text and what it holds, or undefined when it's missing or empty. A file that isn't TOML throws. */
export function read(file: string): { readonly text: string; readonly value: Table } | undefined {
  const text = ConsoleStore.read(file)
  if (text === undefined || text.trim() === "") return undefined
  const value = decode(text)
  if (!value) throw new Error(`${file} isn't valid TOML, so it was left alone. Fix it and run setup again.`)
  return { text, value }
}

/** A change to the file: a top-level key set or removed, or a whole table removed or added at the end. */
export type Edit =
  | { readonly type: "key"; readonly key: string; readonly value: unknown }
  | { readonly type: "remove"; readonly path: readonly string[] }
  | { readonly type: "table"; readonly path: readonly string[]; readonly entries: Table }
  /** One key set in place, inside a table the member wrote, keeping its line's comment. `path` ends with the key. */
  | { readonly type: "entry"; readonly path: readonly string[]; readonly value: unknown }

/**
 * Applies `edits` to `text` in order, and returns the new text. Throws, naming `file`, when the result wouldn't read
 * back as exactly the old contents with those edits made, such as a key whose value spans several lines.
 */
export function edit(file: string, text: string, edits: readonly Edit[]) {
  const before = decode(text) ?? {}
  const expected = copyTable(before)
  const edited = edits.reduce((current, item) => {
    if (item.type === "key") {
      if (item.value === undefined) delete expected[item.key]
      else expected[item.key] = item.value
      return setKey(current, item.key, item.value)
    }
    if (item.type === "remove") {
      unsetPath(expected, item.path)
      return removeTable(current, item.path)
    }
    if (item.type === "entry") {
      const parent = get(expected, item.path.slice(0, -1))
      if (isTable(parent)) parent[item.path.at(-1)!] = item.value
      return setEntry(current, item.path, item.value)
    }
    setPath(expected, item.path, item.entries)
    return appendTable(current, item.path, item.entries)
  }, text)
  // Blank lines a removed key or table left at the top of the file go with it.
  const next = /^\s*\n/.test(text) ? edited : edited.replace(/^\s*\n/, "")
  const after = decode(next)
  if (!after || canonical(after) !== canonical(expected))
    throw new Error(`${file} couldn't be updated without changing settings setup doesn't own, so it was left alone.`)
  return next
}

/** Whether `path`'s key has a line of its own under its table's header, which an `entry` edit can change in place. */
export function hasEntry(text: string, path: readonly string[]) {
  return entryLine(text.split("\n"), path) !== -1
}

/** The value at a dotted path of keys, such as `["model_providers", "opencode-console"]`. */
export function get(value: Table, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, key) => (isTable(current) ? current[key] : undefined), value)
}

/** A TOML value: strings, numbers, booleans, arrays of them, and tables, which are written inline. */
export function literal(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`
  if (isTable(value))
    return `{ ${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([name, item]) => `${key(name)} = ${literal(item)}`)
      .join(", ")} }`
  throw new Error(`Can't write ${String(value)} as TOML`)
}

/** A key as TOML writes it: bare when it can be, quoted otherwise. */
export function key(name: string) {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)
}

/** Whether a value is a table, rather than an array, a date or a scalar. */
export function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
}

function decode(text: string): Table | undefined {
  try {
    return parse(text)
  } catch {
    return undefined
  }
}

// Top-level keys sit before the first table header; a key is replaced on its own line, and a new one follows the last.
function setKey(text: string, name: string, value: unknown) {
  const lines = text.split("\n")
  const end = lines.findIndex(header)
  const root = end === -1 ? lines.length : end
  const index = lines.slice(0, root).findIndex((line) => keyOf(line) === name)
  const line = value === undefined ? [] : [`${key(name)} = ${literal(value)}`]
  if (index !== -1)
    return [
      ...lines.slice(0, index),
      ...line.map((item) => `${item}${comment(lines[index]!)}`),
      ...lines.slice(index + 1),
    ].join("\n")
  if (value === undefined) return text
  const last = lines.slice(0, root).findLastIndex((item) => item.trim() !== "" && !item.trim().startsWith("#"))
  return [...lines.slice(0, last + 1), ...line, ...lines.slice(last + 1)].join("\n")
}

// A `key = value  # note` line's comment, with the space before it.
function comment(line: string) {
  const at = [...line.matchAll(/#/g)]
    .map((match) => match.index)
    .find((index) => decode(line.slice(0, index)) !== undefined)
  return at === undefined ? "" : line.slice(line.slice(0, at).trimEnd().length)
}

// A table runs from its header to the next header. It goes with the blank lines before it; the ones after it stay.
function removeTable(text: string, path: readonly string[]) {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => header(line) && !line.trim().startsWith("[[") && same(headerPath(line), path))
  if (start === -1) return text
  const following = lines.slice(start + 1).findIndex(header)
  const end = following === -1 ? lines.length : start + 1 + following
  const content = lines.slice(0, end).findLastIndex((line) => line.trim() !== "") + 1
  const from = lines.slice(0, start).findLastIndex((line) => line.trim() !== "") + 1
  return [...lines.slice(0, from), ...lines.slice(content)].join("\n")
}

// The line that sets a table's key, between the table's header and the next one, or -1.
function entryLine(lines: readonly string[], path: readonly string[]) {
  const table = path.slice(0, -1)
  const start = lines.findIndex(
    (line) => header(line) && !line.trim().startsWith("[[") && same(headerPath(line), table),
  )
  if (start === -1) return -1
  const following = lines.slice(start + 1).findIndex(header)
  const section = lines.slice(start + 1, following === -1 ? lines.length : start + 1 + following)
  const index = section.findIndex((line) => keyOf(line) === path.at(-1))
  return index === -1 ? -1 : start + 1 + index
}

function setEntry(text: string, path: readonly string[], value: unknown) {
  const lines = text.split("\n")
  const index = entryLine(lines, path)
  if (index === -1) return text
  const name = path.at(-1)!
  return [
    ...lines.slice(0, index),
    `${key(name)} = ${literal(value)}${comment(lines[index]!)}`,
    ...lines.slice(index + 1),
  ].join("\n")
}

function appendTable(text: string, path: readonly string[], entries: Table) {
  const body = Object.entries(entries)
    .filter(([, item]) => item !== undefined)
    .map(([name, item]) => `${key(name)} = ${literal(item)}`)
  const trimmed = text.replace(/\s*$/, "")
  return `${trimmed === "" ? "" : `${trimmed}\n\n`}[${path.map(key).join(".")}]\n${body.join("\n")}\n`
}

function header(line: string) {
  return /^\s*\[/.test(line)
}

// The key a top-level `key = value` line sets, bare or quoted; a dotted key names no top-level key setup sets.
function keyOf(line: string) {
  const match = line.match(/^\s*(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)"|'([^']*)')\s*=/)
  if (!match) return undefined
  const quoted = match[2] === undefined ? undefined : decode(`k = "${match[2]}"`)?.k
  return match[1] ?? match[3] ?? (typeof quoted === "string" ? quoted : undefined)
}

// The keys a `[a."b c"]` header names, read as TOML reads them.
function headerPath(line: string) {
  const parsed = decode(`${line}\n`)
  const path: string[] = []
  let current: unknown = parsed
  while (isTable(current) && Object.keys(current).length === 1) {
    const name = Object.keys(current)[0]!
    path.push(name)
    current = current[name]
  }
  return path
}

function copyTable(value: Table): Table {
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, copy(item)]))
}

// A copy of the tables and arrays, sharing TOML's dates, which a structured clone would turn into plain dates.
function copy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copy)
  if (isTable(value)) return copyTable(value)
  return value
}

function same(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function setPath(value: Table, path: readonly string[], entries: Table) {
  const parent = path.slice(0, -1).reduce<Table>((current, name) => {
    const next = current[name]
    if (isTable(next)) return next
    const created: Table = {}
    current[name] = created
    return created
  }, value)
  parent[path.at(-1)!] = Object.fromEntries(Object.entries(entries).filter(([, item]) => item !== undefined))
}

function unsetPath(value: Table, path: readonly string[]) {
  const parent = get(value, path.slice(0, -1))
  if (isTable(parent)) delete parent[path.at(-1)!]
}

// Tables compare by content, whatever order their keys were written in. An empty table is no table: removing the
// last table under `[hooks.state]` leaves nothing of `hooks`, where the edit left an empty one.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (isTable(value))
    return `{${Object.keys(value)
      .toSorted()
      .map((name) => [name, canonical(value[name])] as const)
      .filter(([, item]) => item !== "{}")
      .map(([name, item]) => `${JSON.stringify(name)}:${item}`)
      .join(",")}}`
  return JSON.stringify(value)
}
