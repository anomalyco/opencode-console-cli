import { expect, test } from "bun:test"
import { ClaudeCodeHook } from "../src/claude-code-hook"

// Claude Code's hook inputs, as code.claude.com/docs/en/hooks and tools-reference document them.
const toolCall = (tool_name: string, tool_input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  hook_event_name: "PreToolUse",
  cwd: "/work/app",
  tool_name,
  tool_input,
  ...extra,
})
const macOS: ClaudeCodeHook.Host = { platform: "darwin", env: {} }

test.each([
  ["Bash", { command: "rm -rf build" }, { action: "shell", resources: ["rm -rf build"] }],
  ["PowerShell", { command: "Remove-Item x" }, { action: "shell", resources: ["Remove-Item x"], shell: "pwsh" }],
  ["Edit", { file_path: "/work/app/.env" }, { action: "edit", resources: ["/work/app/.env"] }],
  ["Write", { file_path: "/work/app/a.ts" }, { action: "edit", resources: ["/work/app/a.ts"] }],
  ["MultiEdit", { file_path: "/work/app/a.ts" }, { action: "edit", resources: ["/work/app/a.ts"] }],
  ["NotebookEdit", { notebook_path: "/work/app/n.ipynb" }, { action: "edit", resources: ["/work/app/n.ipynb"] }],
  ["Read", { file_path: "/etc/hosts" }, { action: "read", resources: ["/etc/hosts"] }],
  ["LSP", { operation: "goToDefinition", filePath: "/etc/hosts" }, { action: "read", resources: ["/etc/hosts"] }],
  ["Glob", { pattern: "**/*.ts", path: "/tmp" }, { action: "glob", resources: ["**/*.ts"], path: "/tmp" }],
  ["Grep", { pattern: "TODO" }, { action: "grep", resources: ["TODO"] }],
  ["WebFetch", { url: "https://example.com" }, { action: "webfetch", resources: ["https://example.com"] }],
  ["WebSearch", { query: "effect schema" }, { action: "websearch", resources: ["effect schema"] }],
  ["Agent", { subagent_type: "Explore", prompt: "find" }, { action: "subagent", resources: ["explore"] }],
  ["Agent", { subagent_type: "general-purpose" }, { action: "subagent", resources: ["general"] }],
  ["Skill", { skill: "deploy" }, { action: "skill", resources: ["deploy"] }],
  ["AskUserQuestion", { questions: [] }, { action: "question", resources: ["*"] }],
  ["ReadMcpResourceTool", { server: "github", uri: "repo://x" }, { action: "mcp.use", resources: ["github"] }],
  ["ListMcpResourcesTool", { server: "github" }, { action: "mcp.use", resources: ["github"] }],
  ["TodoWrite", { todos: [] }, { action: "todowrite", resources: ["*"] }],
])("checks Claude Code's %s as OpenCode's matching permission", (tool, input, expected) => {
  expect(ClaudeCodeHook.checks(toolCall(tool, input), macOS)).toEqual([{ ...expected, directory: "/work/app" }])
})

test("checks a Monitor's command as a shell command and its WebSocket as a fetch", () => {
  const event = toolCall("Monitor", {
    description: "watch",
    timeout_ms: 1,
    command: "tail -f log",
    ws: { url: "wss://x.test" },
  })

  expect(ClaudeCodeHook.checks(event, macOS)).toEqual([
    { action: "shell", resources: ["tail -f log"], directory: "/work/app" },
    { action: "webfetch", resources: ["wss://x.test"], directory: "/work/app" },
  ])
})

test("scans Bash commands with the shell Claude Code runs them in, never PowerShell on Windows", () => {
  const windows = ClaudeCodeHook.checks(toolCall("Bash", { command: "ls" }), { platform: "win32", env: {} })
  const configured = ClaudeCodeHook.checks(toolCall("Monitor", { command: "ls" }), {
    platform: "darwin",
    env: { CLAUDE_CODE_SHELL: "/opt/homebrew/bin/bash" },
  })

  expect([windows[0]?.shell, configured[0]?.shell]).toEqual(["bash", "/opt/homebrew/bin/bash"])
})

test("checks an MCP tool against its server's mcp.use and the tool's own permission, named as OpenCode names it", () => {
  const event = toolCall(
    "mcp__docs__v2__search.pages",
    { q: "x" },
    { mcp_server: { name: "docs__v2", source: "user" } },
  )

  expect(ClaudeCodeHook.checks(event, macOS)).toEqual([
    { action: "mcp.use", resources: ["docs__v2"], directory: "/work/app" },
    { action: "docs__v2_search_pages", resources: ["*"], directory: "/work/app" },
  ])
})

test("checks setup's console_watch tools as OpenCode's built-in watch tools, which no mcp.use rule covers", () => {
  const event = toolCall(
    "mcp__console_watch__watch",
    { target: "acme/app#7" },
    { mcp_server: { name: "console_watch" } },
  )

  expect(ClaudeCodeHook.checks(event, { ...macOS, watchServer: true })).toEqual([
    { action: "console_watch_watch", resources: ["*"], directory: "/work/app" },
  ])
})

test("checks a console_watch server the member added themselves as any other MCP server", () => {
  const event = toolCall(
    "mcp__console_watch__watch",
    { target: "acme/app#7" },
    { mcp_server: { name: "console_watch" } },
  )

  expect(ClaudeCodeHook.checks(event, macOS)).toEqual([
    { action: "mcp.use", resources: ["console_watch"], directory: "/work/app" },
    { action: "console_watch_watch", resources: ["*"], directory: "/work/app" },
  ])
})

test("checks what a prompt mentions, which Claude Code resolves without a tool call", () => {
  const event = {
    hook_event_name: "UserPromptSubmit",
    cwd: "/work/app",
    prompt:
      'compare @src/a.ts, @"my notes.md" and @C:\\repo\\.env, ask @agent-general-purpose and read @github:repo://x',
  }

  expect(ClaudeCodeHook.checks(event, macOS)).toEqual([
    { action: "read", resources: ["src/a.ts", "my notes.md", "C:\\repo\\.env"], directory: "/work/app" },
    { action: "subagent", resources: ["general"], directory: "/work/app" },
    { action: "mcp.use", resources: ["github"], directory: "/work/app" },
  ])
})

test("checks a skill the member types, and an MCP prompt against its server", () => {
  const typed = { hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", command_name: "/deploy" }
  const prompt = {
    hook_event_name: "UserPromptExpansion",
    expansion_type: "mcp_prompt",
    command_name: "mcp__github__triage",
  }

  expect(ClaudeCodeHook.checks(typed, macOS)).toEqual([{ action: "skill", resources: ["deploy"] }])
  expect(ClaudeCodeHook.checks(prompt, macOS)).toEqual([{ action: "mcp.use", resources: ["github"] }])
})

test.each([
  ["a tool call missing the input it's checked by", toolCall("Bash", { description: "no command" })],
  ["a Monitor with neither a command nor a WebSocket", toolCall("Monitor", { description: "x", timeout_ms: 1 })],
  ["an expansion that names no command", { hook_event_name: "UserPromptExpansion", expansion_type: "slash_command" }],
])("refuses to guess at %s", (_name, event) => {
  expect(() => ClaudeCodeHook.checks(event, macOS)).toThrow(ClaudeCodeHook.Unreadable)
})

// The deny shapes are Claude Code's wire format: PreToolUse's permission decision, and the prompt events' block.
test("blocks a tool call with a deny decision and a prompt with a block, both with exit code 2", () => {
  expect(ClaudeCodeHook.denial("PreToolUse", "Blocked by Acme's policy")).toEqual({
    stdout:
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by Acme\'s policy"}}\n',
    stderr: "Blocked by Acme's policy\n",
    code: 2,
  })
  expect(ClaudeCodeHook.denial("UserPromptSubmit", "Blocked by Acme's policy").stdout).toBe(
    '{"decision":"block","reason":"Blocked by Acme\'s policy"}\n',
  )
})
