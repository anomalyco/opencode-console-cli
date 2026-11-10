export * as Instruction from "./instruction"

import { SettingsFile } from "./settings-file"
import { ConsoleStore } from "./store"

export type Info = { readonly name: string; readonly content: string }

/** The workspace's instructions as one system prompt section, or undefined without any. */
export function prompt(items: readonly Info[]) {
  if (items.length === 0) return undefined
  return items.map((item) => `## ${item.name}\n\n${item.content.trim()}`).join("\n\n")
}

const MARKER_START = "<!-- opencode-console:start -->"
const MARKER_END = "<!-- opencode-console:end -->"

/**
 * Writes the instructions between setup's markers in a harness's instructions file (Claude Code's `CLAUDE.md`, Codex's
 * `AGENTS.md`) and leaves the rest of the file as the member wrote it. Returns whether setup created the file, which it
 * removes again once no instructions are left in it.
 */
export function write(file: string, existing: string | undefined, instructions: readonly Info[], created: boolean) {
  if (instructions.length === 0 && !existing?.includes(MARKER_START)) return created
  const outside = (existing ?? "").replace(new RegExp(`\\n*${MARKER_START}[\\s\\S]*?${MARKER_END}\\n?`), "\n").trim()
  // An instruction that quotes a marker would end the block early, so its markers are written as plain comments.
  const neutral = (text: string) =>
    text
      .replaceAll(MARKER_START, "<!-- opencode-console start -->")
      .replaceAll(MARKER_END, "<!-- opencode-console end -->")
  const block =
    instructions.length === 0
      ? ""
      : [
          MARKER_START,
          "# Workspace instructions from OpenCode Console",
          ...instructions.map((item) => `## ${neutral(item.name)}\n\n${neutral(item.content.trim())}`),
          MARKER_END,
        ].join("\n\n")
  const next = [outside, block].filter((part) => part !== "").join("\n\n")
  const createdNow = created || (existing === undefined && block !== "")
  if (next === "" && createdNow) {
    ConsoleStore.remove(file)
    return false
  }
  if (`${next}\n` !== existing) SettingsFile.writeFile(file, `${next}\n`)
  return createdNow
}
