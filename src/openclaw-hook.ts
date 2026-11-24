export * as OpenClawHook from "./openclaw-hook"

import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { CodexHook } from "./codex-hook"
import { HermesHook } from "./hermes-hook"
import type { PolicyEvaluator } from "./policy-evaluator"
import { SettingsFile } from "./settings-file"

/**
 * What setup's OpenClaw plugin pipes to `hook openclaw` from `before_tool_call` (docs.openclaw.ai/plugins/hooks/tool-policy):
 * the tool and its parameters, OpenClaw's host-assigned `toolKind`, the session, the agent and its workspace, which
 * OpenClaw's file and shell tools resolve relative paths against.
 */
const Event = Schema.Struct({
  hook_event_name: Schema.Literal("before_tool_call"),
  session_id: Schema.optional(Schema.String),
  agent_id: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  tool_name: Schema.optional(Schema.String),
  tool_input: Schema.optional(Schema.Unknown),
  tool_kind: Schema.optional(Schema.String),
})
export type Event = typeof Event.Type

export const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Event))

/** A hook input this can't turn into checks, which the hook refuses rather than let through unchecked. */
export class Unreadable extends Error {}

export interface Where {
  /** The agent's workspace, which paths outside of need `external_directory`. */
  readonly directory: string
  /** The directory `~` stands for; the user's home by default. */
  readonly home?: string | undefined
  /** The workspace's MCP servers, by the names setup gave OpenClaw. */
  readonly servers: readonly string[]
  /** The folders skills live in: setup's, the workspace's and the install's. Reading a file in one loads that skill. */
  readonly skills?: readonly string[] | undefined
}

/**
 * The checks an OpenClaw tool call needs, in OpenCode's permission vocabulary, all of which must allow it. OpenClaw's
 * tools (docs.openclaw.ai/tools) map to the permission OpenCode's own tool asks for, with paths named as OpenClaw names
 * them (`~` is the home, relative paths are in the agent's workspace):
 * - `exec` → `shell` where it runs (`workdir`), plus `edit` on the files a patch in the command names; Code Mode's
 *   `exec` (`toolKind: "code_mode_exec"`) runs JavaScript no scanner reads, so it's checked as a command that can't be
 *   analyzed and as reading, editing and fetching anything; `process` writing to a running process is such a command
 *   too;
 * - `read` → `read`, except a file in a skill's folder, which is that skill's `skill` check; `write` and `edit` →
 *   `edit`; `apply_patch` → `edit` on every file its patch names; `ls` → `glob` on everything where it lists; `find` → `glob`, `grep` → `grep`,
 *   where they search;
 * - `web_search` and `x_search` → `websearch`; `web_fetch` → `webfetch`; `browser` and `computer` drive a browser or
 *   the machine, which can fetch anything (`computer` also runs anything);
 * - `skills_read` → `skill`; `sessions_spawn` → `subagent` on its agent (`general` by default); `ask_user` →
 *   `question`;
 * - `<server>__<tool>` for a workspace MCP server → its `mcp.use` and the tool's `<server>_<tool>`. Any other tool,
 *   and those above with no OpenCode counterpart, are also checked by their name. OpenClaw checks the tool a
 *   `dispatch_action` calls on its own, so the wrapper is checked only by name.
 */
export function checks(event: Event, where: Where): PolicyEvaluator.Input[] {
  const tool = event.tool_name
  if (!tool) throw new Unreadable("The hook input names no tool")
  const input = SettingsFile.record(event.tool_input)
  const optional = (name: string) => SettingsFile.text(input[name])
  const field = (name: string) => {
    const value = optional(name)
    if (value === undefined) throw new Unreadable(`${tool}'s input has no ${name}`)
    return value
  }
  const at = (file: string) => local(where, where.directory, file)
  const named = check(where, tool.toLowerCase(), ["*"])
  const any = (action: "read" | "edit" | "webfetch") => check(where, `${action}:`, ["*"], { truncated: true })
  const opaque = (code: string | undefined) => [
    check(where, "shell", [code ?? ""], { opaque: true }),
    any("read"),
    any("edit"),
    any("webfetch"),
  ]
  const server = where.servers
    .filter((name) => tool.startsWith(`${name}__`))
    .toSorted((left, right) => right.length - left.length)[0]
  if (server)
    return [check(where, "mcp.use", [server]), check(where, `${server}_${tool.slice(server.length + 2)}`, ["*"])]
  switch (tool) {
    case "exec":
    case "bash": {
      if (event.tool_kind === "code_mode_exec") return [...opaque(optional("code") ?? optional("command")), named]
      const command = field("command")
      const workdir = optional("workdir")
      const cwd = workdir === undefined ? where.directory : at(workdir)
      const edited = command.includes("*** Begin Patch")
        ? CodexHook.patchFiles(command, cwd, (file) => local(where, cwd, file))
        : []
      return [
        check(where, "shell", [command], cwd === where.directory ? {} : { path: cwd }),
        ...(edited.length === 0 ? [] : [check(where, "edit", edited)]),
      ]
    }
    case "process": {
      const action = optional("action")
      // Writing to a background process's stdin, or typing into its terminal, runs whatever that shell reads.
      const sent = optional("data") ?? optional("text") ?? optional("literal") ?? ""
      return ["write", "submit", "paste", "send-keys"].includes(action ?? "")
        ? [check(where, "shell", [sent], { opaque: true }), named]
        : [named]
    }
    case "read":
      return [read(where, at(field("path")))]
    case "write":
    case "edit":
      return [check(where, "edit", [at(field("path"))])]
    case "apply_patch": {
      const edited = CodexHook.patchFiles(optional("input") ?? optional("patch") ?? "", where.directory, at)
      if (edited.length === 0) throw new Unreadable("The patch names no file")
      return [check(where, "edit", [...new Set(edited)])]
    }
    case "ls":
      // OpenCode lists a directory as a glob of everything in it.
      return [check(where, "glob", ["*"], { path: at(optional("path") ?? ".") }), named]
    case "find":
      return [check(where, "glob", [field("pattern")], { path: at(optional("path") ?? ".") })]
    case "grep":
      return [check(where, "grep", [field("pattern")], { path: at(optional("path") ?? ".") })]
    case "web_search":
      return [check(where, "websearch", [field("query")])]
    case "x_search":
      return [check(where, "websearch", [field("query")]), named]
    case "web_fetch":
      return [check(where, "webfetch", [field("url")])]
    case "browser": {
      const url = optional("url") ?? optional("targetUrl")
      return [url === undefined ? any("webfetch") : check(where, "webfetch", [url]), named]
    }
    case "computer":
      return [...opaque(undefined), named]
    case "skills_read":
      return [check(where, "skill", [field("name")])]
    case "sessions_spawn": {
      const agent = optional("agentId")?.trim().toLowerCase() || "general"
      return [check(where, "subagent", [agent]), named]
    }
    case "ask_user":
      return [check(where, "question", ["*"])]
    default:
      return [named]
  }
}

function check(where: Where, action: string, resources: readonly string[], extra: Partial<PolicyEvaluator.Input> = {}) {
  return { action, resources, directory: where.directory, ...extra }
}

/** A path as OpenClaw's file tools name it: `~` and `~/…` are the home, and anything relative is under `base`. */
function local(where: Where, base: string, file: string) {
  const home = where.home ?? os.homedir()
  if (file === "~") return home
  if (/^~[\\/]/.test(file)) return path.join(home, file.slice(2))
  if (file.startsWith("~")) throw new Unreadable(`Can't tell where ${file} is`)
  return path.resolve(base, file)
}

// Reading a file in a skill's folder loads that skill.
function read(where: Where, file: string) {
  const skill = HermesHook.skillOf(where.skills ?? [], file)
  return skill ? check(where, "skill", [skill]) : check(where, "read", [file])
}
