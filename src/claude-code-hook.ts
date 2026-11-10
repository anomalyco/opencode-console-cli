export * as ClaudeCodeHook from "./claude-code-hook"

import { Option, Schema } from "effect"
import type { PolicyEvaluator } from "./policy-evaluator"

/**
 * The fields of a Claude Code hook's stdin this reads (code.claude.com/docs/en/hooks, "Hook input and output"): the
 * event, the session and its working directory, the tool call, what it returned and the MCP server it belongs to, and
 * the prompt or command.
 */
const Event = Schema.Struct({
  hook_event_name: Schema.String,
  session_id: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  tool_name: Schema.optional(Schema.String),
  tool_input: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  /** What the tool returned, in `PostToolUse`: Bash's `{ stdout, stderr, … }`, or an MCP tool's content. */
  tool_response: Schema.optional(Schema.Unknown),
  mcp_server: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
  prompt: Schema.optional(Schema.String),
  expansion_type: Schema.optional(Schema.String),
  command_name: Schema.optional(Schema.String),
})
export type Event = typeof Event.Type

export const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Event))

/** A hook input this can't turn into checks, which the hook refuses rather than let through unchecked. */
export class Unreadable extends Error {}

/** Where Claude Code runs: the shell its Bash tool uses depends on the platform and `CLAUDE_CODE_SHELL`. */
export interface Host {
  readonly platform: NodeJS.Platform
  readonly env: Record<string, string | undefined>
  /** Whether setup gave Claude Code the `console_watch` server, whose tools are OpenCode's built-in watch tools. */
  readonly watchServer?: boolean | undefined
}

/** The local MCP server (`opencode-console mcp-watches`) that serves OpenCode's watch tools to Claude Code. */
export const WATCH_SERVER = "console_watch"

const host: Host = { platform: process.platform, env: process.env }

/**
 * The checks an event needs, in OpenCode's permission vocabulary, all of which must allow it. A tool maps to the
 * permission OpenCode's own tool asks for (code.claude.com/docs/en/tools-reference): Bash, PowerShell and Monitor's
 * command to `shell`, the file tools to `edit` and `read`, Agent to `subagent`, and an MCP tool or resource to its
 * server's `mcp.use` and the tool's own `<server>_<tool>` permission; setup's `console_watch` tools are OpenCode's
 * built-in `console_watch_<tool>` alone, which no `mcp.use` rule covers. A prompt's mentions, which Claude Code resolves
 * without a tool call, are checked as what they name: a file is `read`, `@agent-<name>` a `subagent` and
 * `@server:uri` the server's `mcp.use`. A typed `/skill` is a `skill` check and an MCP prompt its server's `mcp.use`.
 */
export function checks(event: Event, where: Host = host): PolicyEvaluator.Input[] {
  const directory = event.cwd
  const check = (action: string, resources: readonly string[], extra: Partial<PolicyEvaluator.Input> = {}) => ({
    action,
    resources,
    ...(directory === undefined ? {} : { directory }),
    ...extra,
  })
  if (event.hook_event_name === "UserPromptSubmit") return mentions(event.prompt ?? "").map((item) => check(...item))
  if (event.hook_event_name === "UserPromptExpansion") {
    const name = event.command_name?.replace(/^\//, "")
    if (!name) throw new Unreadable("The expanded command has no name")
    if (event.expansion_type === "mcp_prompt") {
      const server = name.match(/^mcp__(.+?)__/)?.[1] ?? name.match(/^([^:]+):/)?.[1]
      if (!server) throw new Unreadable(`Can't tell which MCP server the prompt ${name} comes from`)
      return [check("mcp.use", [server])]
    }
    return [check("skill", [name])]
  }
  if (event.hook_event_name !== "PreToolUse") return []
  const tool = event.tool_name
  if (!tool) throw new Unreadable("The hook input names no tool")
  const input = event.tool_input ?? {}
  const optional = (...names: string[]) =>
    names.map((name) => input[name]).find((item): item is string => typeof item === "string" && item !== "")
  const field = (...names: string[]) => {
    const value = optional(...names)
    if (value === undefined) throw new Unreadable(`${tool}'s input has no ${names[0]}`)
    return value
  }
  // Claude Code's Bash tool runs bash or zsh (`CLAUDE_CODE_SHELL`, else detected), Git Bash on Windows.
  const shell = where.env.CLAUDE_CODE_SHELL || (where.platform === "win32" ? "bash" : undefined)
  const posix = shell === undefined ? {} : { shell }
  const mcp = mcpTool(tool, event.mcp_server?.name)
  if (mcp && mcp.server === WATCH_SERVER && where.watchServer) return [check(mcpToolName(mcp.server, mcp.tool), ["*"])]
  if (mcp) return [check("mcp.use", [mcp.server]), check(mcpToolName(mcp.server, mcp.tool), ["*"])]
  switch (tool) {
    case "Bash":
      return [check("shell", [field("command")], posix)]
    case "PowerShell":
      return [check("shell", [field("command")], { shell: "pwsh" })]
    case "Monitor": {
      const command = optional("command")
      const socket = typeof input.ws === "object" && input.ws !== null && "url" in input.ws ? input.ws.url : undefined
      const url = typeof socket === "string" && socket !== "" ? socket : undefined
      if (command === undefined && url === undefined) throw new Unreadable("Monitor's input has no command or ws.url")
      return [
        ...(command === undefined ? [] : [check("shell", [command], posix)]),
        ...(url === undefined ? [] : [check("webfetch", [url])]),
      ]
    }
    case "Edit":
    case "Write":
    case "MultiEdit":
      return [check("edit", [field("file_path")])]
    case "NotebookEdit":
      return [check("edit", [field("notebook_path")])]
    case "Read":
      return [check("read", [field("file_path")])]
    case "LSP": {
      const file = optional("filePath", "file_path", "path")
      return [file === undefined ? check("lsp", ["*"]) : check("read", [file])]
    }
    case "Glob":
    case "Grep": {
      const searched = optional("path")
      return [check(tool.toLowerCase(), [field("pattern")], searched === undefined ? {} : { path: searched })]
    }
    case "WebFetch":
      return [check("webfetch", [field("url")])]
    case "WebSearch":
      return [check("websearch", [field("query")])]
    case "Agent":
    case "Task":
      return [check("subagent", [subagent(optional("subagent_type") ?? "general-purpose")])]
    case "Skill":
      return [check("skill", [field("skill", "command", "name").replace(/^\//, "")])]
    case "AskUserQuestion":
      return [check("question", ["*"])]
    case "ReadMcpResourceTool":
      return [check("mcp.use", [field("server")])]
    case "ListMcpResourcesTool": {
      const server = optional("server")
      return [check("mcp.use", [server ?? "*"])]
    }
    default:
      // Claude Code's other tools have no OpenCode counterpart; a rule naming one, or every tool, still applies.
      return [check(tool.toLowerCase(), ["*"])]
  }
}

/** What the hook prints and exits with to stop Claude Code, in the event's own format. */
export function denial(event: string | undefined, message: string) {
  const stdout =
    event === "PreToolUse"
      ? {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: message,
          },
        }
      : { decision: "block", reason: message }
  // Exit code 2 blocks on its own, so the call stays blocked even if Claude Code can't read the JSON.
  return { stdout: `${JSON.stringify(stdout)}\n`, stderr: `${message}\n`, code: 2 }
}

/** The event a hook input names, read without trusting the rest of it, so a refusal can still use its format. */
export function eventName(text: string) {
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ hook_event_name: Schema.String })))(text),
  )?.hook_event_name
}

/**
 * An MCP tool's server and its own name, from `mcp__<server>__<tool>`, split at the server Claude Code names when it
 * does (2.1.274+), since a server name can hold `__` itself.
 */
export function mcpTool(tool: string, server: string | undefined) {
  if (server && tool.startsWith(`mcp__${server}__`)) return { server, tool: tool.slice(`mcp__${server}__`.length) }
  const match = tool.match(/^mcp__(.+?)__(.+)$/)
  return match ? { server: match[1]!, tool: match[2]! } : undefined
}

// The permission OpenCode names an MCP tool by (`Policy.mcpToolName`).
function mcpToolName(server: string, tool: string) {
  return `${server}_${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`
}

// Claude Code's general-purpose agent is OpenCode's `general`.
function subagent(type: string) {
  const name = type.toLowerCase()
  return name === "general-purpose" ? "general" : name
}

/**
 * A prompt's `@` mentions, as checks: `@path` and `@"path with spaces"` read a file (Windows drive paths included),
 * `@agent-<name>` runs a subagent, and `@server:uri` reads an MCP resource.
 */
function mentions(prompt: string): Array<[string, string[]]> {
  const found = Array.from(prompt.matchAll(/(?:^|\s)@(?:"([^"]+)"|(\S+))/g), (match) =>
    match[1] !== undefined ? { quoted: match[1] } : { bare: match[2]!.replace(/[),.;!?]+$/, "") },
  )
  const files = found.flatMap((item) => ("quoted" in item ? [item.quoted] : isFile(item.bare) ? [item.bare] : []))
  const agents = found.flatMap((item) =>
    "bare" in item && item.bare.startsWith("agent-") && item.bare.length > 6 ? [subagent(item.bare.slice(6))] : [],
  )
  const servers = found.flatMap((item) =>
    "bare" in item && !isFile(item.bare) && !item.bare.startsWith("agent-") && item.bare.includes(":")
      ? [item.bare.slice(0, item.bare.indexOf(":"))].filter((server) => server !== "")
      : [],
  )
  return [
    ...(files.length === 0 ? [] : [["read", files] as [string, string[]]]),
    ...(agents.length === 0 ? [] : [["subagent", agents] as [string, string[]]]),
    ...(servers.length === 0 ? [] : [["mcp.use", servers] as [string, string[]]]),
  ]
}

function isFile(mention: string) {
  if (mention === "" || mention.startsWith("agent-")) return false
  return /^[A-Za-z]:[\\/]/.test(mention) || !mention.includes(":")
}
