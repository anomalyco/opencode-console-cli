export * as CodexHook from "./codex-hook"

import path from "node:path"
import { Schema } from "effect"
import type { PolicyEvaluator } from "./policy-evaluator"

/**
 * The fields of a Codex hook's stdin this reads (`codex-rs/hooks/schema/generated/*.command.input.schema.json` in
 * openai/codex): the event, the session (a subagent's hooks name its root session) and the turn, the tool call's
 * working directory, the tool, its input and what it returned, and the prompt.
 */
const Event = Schema.Struct({
  hook_event_name: Schema.String,
  session_id: Schema.optional(Schema.String),
  turn_id: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  tool_name: Schema.optional(Schema.String),
  tool_input: Schema.optional(Schema.Unknown),
  /** What the tool returned, in `PostToolUse`: a shell command's output as one string, without its exit code. */
  tool_response: Schema.optional(Schema.Unknown),
  prompt: Schema.optional(Schema.String),
})
export type Event = typeof Event.Type

export const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Event))

/** A hook input this can't turn into checks, which the hook refuses rather than let through unchecked. */
export class Unreadable extends Error {}

/** Where the hook runs: Codex starts it in the session's directory. */
export interface Where {
  /** The session's directory, which Codex starts the hook in; a tool call's own directory comes in the input. */
  readonly directory: string
  readonly platform: NodeJS.Platform
  /** The MCP servers the workspace gives Codex, by the names Codex has them under. */
  readonly servers: readonly string[]
  /** Whether setup gave Codex the `console_watch` server, whose tools are OpenCode's built-in watch tools. */
  readonly watchServer?: boolean | undefined
}

/** The local MCP server (`opencode-console mcp-watches`) that serves OpenCode's watch tools to Codex. */
export const WATCH_SERVER = "console_watch"

/**
 * The checks an event needs, in OpenCode's permission vocabulary, all of which must allow it. Codex names its tools to
 * hooks as `codex-rs/core/src/tools` does: every shell command as `Bash` with `{ command }` (`exec_command`, run in the
 * input's `cwd`), file edits as `apply_patch` with the patch as `command`, MCP tools as `mcp__<server>__<tool>` with
 * their arguments, and every other tool by its own name and arguments. `write_stdin` to a running command and Codex's
 * hosted web search reach no hook. Setup's `console_watch` tools are OpenCode's built-in `console_watch_<tool>` alone,
 * which no `mcp.use` rule covers. A prompt's `$name` mentions run skills (`codex-rs/skills/src/mentions.rs`).
 */
export function checks(event: Event, where: Where): PolicyEvaluator.Input[] {
  const check = (action: string, resources: readonly string[], extra: Partial<PolicyEvaluator.Input> = {}) => ({
    action,
    resources,
    directory: where.directory,
    ...extra,
  })
  if (event.hook_event_name === "UserPromptSubmit") {
    const named = mentions(event.prompt ?? "")
    return [
      ...(named.skills.length === 0 ? [] : [check("skill", named.skills)]),
      ...(named.servers.length === 0 ? [] : [check("mcp.use", named.servers)]),
      ...(named.plugins.length === 0 ? [] : [check("plugin.use", named.plugins)]),
    ]
  }
  if (event.hook_event_name !== "PreToolUse") return []
  const tool = event.tool_name
  if (!tool) throw new Unreadable("The hook input names no tool")
  // The tool call's own directory: a command's `workdir`, else the session's.
  const cwd = event.cwd ? path.resolve(where.directory, event.cwd) : where.directory
  if (where.watchServer && tool.startsWith(`mcp__${WATCH_SERVER}__`))
    return [check(`${WATCH_SERVER}_${tool.slice(`mcp__${WATCH_SERVER}__`.length)}`, ["*"])]
  if (tool.startsWith("mcp__"))
    return mcpChecks(tool, where.servers).map((item) => check(item.action, item.resources, item))
  const input = event.tool_input
  const optional = (name: string) => {
    const value = typeof input === "object" && input !== null && name in input ? Reflect.get(input, name) : undefined
    return typeof value === "string" && value !== "" ? value : undefined
  }
  const field = (name: string) => {
    const value = optional(name)
    if (value === undefined) throw new Unreadable(`${tool}'s input has no ${name}`)
    return value
  }
  // Codex runs commands in the member's shell, PowerShell on Windows.
  const shell = where.platform === "win32" ? { shell: "pwsh" } : {}
  switch (tool) {
    case "Bash": {
      const command = field("command")
      // A patch piped to `apply_patch` in a command edits files as the tool would.
      const edited = command.includes("*** Begin Patch") ? patchFiles(command, cwd) : []
      return [
        check("shell", [command], { ...shell, ...(cwd === where.directory ? {} : { path: cwd }) }),
        ...(edited.length === 0 ? [] : [check("edit", edited)]),
      ]
    }
    case "apply_patch": {
      const edited = patchFiles(field("command"), cwd)
      if (edited.length === 0) throw new Unreadable("The patch names no file")
      return [check("edit", edited)]
    }
    case "view_image":
      return [check("read", [path.resolve(cwd, field("path"))])]
    case "request_user_input":
    case "request_user_input_async":
      return [check("question", ["*"])]
    case "read_mcp_resource":
      return [check("mcp.use", [field("server")])]
    case "list_mcp_resources":
    case "list_mcp_resource_templates": {
      const server = optional("server")
      // A listing that names no server reads every server's resources, the member's own included.
      return [check("mcp.use", server ? [server] : [...where.servers, "*"])]
    }
    case "request_plugin_install": {
      // A connector is an app Codex reaches over MCP; anything else is a plugin.
      const id = field(optional("tool_id") === undefined ? "plugin_id" : "tool_id")
      return [check(optional("tool_type") === "connector" ? "mcp.use" : "plugin.use", [id])]
    }
    default:
      // Codex's default agent is OpenCode's `general`.
      if (tool === "spawn_agent" || tool.endsWith(".spawn_agent")) {
        const type = optional("agent_type")?.trim().toLowerCase() || undefined
        return [check("subagent", [type === undefined || type === "default" ? "general" : type])]
      }
      // Codex's other tools have no OpenCode counterpart; a rule naming one, or every tool, still applies.
      return [check(tool.toLowerCase(), ["*"])]
  }
}

/**
 * The files a patch adds, updates, deletes or moves, resolved against the tool call's directory. Headers are read the
 * way the most lenient of the agents that apply these patches reads them: Codex's `*** Move to:`
 * (`codex-rs/apply-patch/src/parser.rs`), and Hermes's optional spaces after `***` and `File:` and its
 * `*** Move File: <from> -> <to>`, both sides of which change (NousResearch/hermes-agent `tools/file_tools.py`,
 * `_V4A_SINGLE_HEADER_RE` and `_V4A_MOVE_HEADER_RE`). Every line that reads as a header counts, wherever it's
 * indented, so a header an agent would read as context can only add a check. `resolve` names a header's path, which
 * defaults to the directory's.
 */
export function patchFiles(patch: string, cwd: string, resolve = (file: string) => path.resolve(cwd, file)) {
  return [
    ...new Set(
      patch.split(/\r?\n/).flatMap((line) => {
        const trimmed = line.trim()
        const moved = trimmed.match(/^\*\*\*\s*Move\s+File:\s*(.+?)\s*->\s*(.+)$/)
        const named = moved ? [moved[1]!, moved[2]!] : [trimmed.match(HEADER)?.[1]].flatMap((file) => file ?? [])
        return named.map((file) => file.trim()).flatMap((file) => (file === "" ? [] : [resolve(file)]))
      }),
    ),
  ]
}

const HEADER = /^\*\*\*\s*(?:(?:Add|Update|Delete)\s+File|Move\s+to)\s*:\s*(.+)$/

/**
 * An MCP tool's checks. Codex names it `mcp__<server>__<tool>` with every character but letters, digits and `_` as `_`
 * (`codex-rs/codex-mcp/src/tools.rs`), and ends a name past 128 characters, or one two tools share, in `_` and 12 hex
 * digits. A server the workspace gave Codex is matched by its name; another is split at the first `__`, with `-` and `_`
 * alike. A shortened tool name isn't known, so it's denied while any rule could deny one of the server's tools.
 */
function mcpChecks(tool: string, servers: readonly string[]): PolicyEvaluator.Input[] {
  const named = servers
    .filter((server) => tool.startsWith(`mcp__${sanitize(server)}__`))
    .toSorted((left, right) => right.length - left.length)[0]
  const split = tool.match(/^mcp__(.+?)__(.+)$/)
  const server = named ?? split?.[1]?.replace(/_[0-9a-f]{12}$/, "")
  if (!server) throw new Unreadable(`Can't tell which MCP server ${tool} belongs to`)
  const rest = named ? tool.slice(`mcp__${sanitize(named)}__`.length) : split?.[2]
  const shortened = rest === undefined || /_[0-9a-f]{12}$/.test(tool)
  return [
    { action: "mcp.use", resources: [server], ...(named ? {} : { folded: true }) },
    shortened
      ? { action: `${server}_`, resources: ["*"], truncated: true, folded: true }
      : { action: `${server}_${rest}`, resources: ["*"], folded: true },
  ]
}

function sanitize(name: string) {
  return name.replace(/[^A-Za-z0-9_]/g, "_")
}

// Codex reads `$name` as a skill, an app or a plugin, but never a common environment variable
// (`is_common_env_var` in `codex-rs/skills/src/mentions.rs`).
const ENVIRONMENT = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TERM",
  "XDG_CONFIG_HOME",
])

/**
 * What a prompt's `$` mentions name, as Codex reads them (`codex-rs/skills/src/mentions.rs`): a link
 * `[$name](skill://…)` or `[$name](…/SKILL.md)` names a skill, `[$name](mcp://<server>)` an MCP server and
 * `[$name](plugin://<plugin>)` a plugin. A bare `$name` may be a skill, unless it's written in capitals as environment
 * variables are.
 */
export function mentions(prompt: string) {
  const found = Array.from(prompt.matchAll(/(?:\[\$([A-Za-z0-9_:-]+)\]\(([^)]*)\))|\$([A-Za-z0-9_:-]+)/g), (match) => ({
    name: match[1] ?? match[3]!,
    link: match[1] === undefined ? undefined : match[2]!.trim(),
  })).filter((item) => !ENVIRONMENT.has(item.name.toUpperCase()))
  const target = (prefix: string) =>
    found.flatMap((item) =>
      item.link?.startsWith(prefix) ? [item.link.slice(prefix.length).split(/[/?]/)[0]!].filter(Boolean) : [],
    )
  const skills = found.flatMap((item) =>
    item.link === undefined
      ? /^[A-Z0-9_]+$/.test(item.name)
        ? []
        : [item.name]
      : /(?:^skill:\/\/|SKILL\.md$)/i.test(item.link)
        ? [item.name]
        : [],
  )
  return {
    skills: [...new Set(skills)],
    servers: [...new Set(target("mcp://"))],
    plugins: [...new Set(target("plugin://"))],
  }
}
