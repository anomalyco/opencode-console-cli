import { expect, test } from "bun:test"
import { Effect } from "effect"
import { CodexHook } from "../src/codex-hook"
import { PolicyEvaluator } from "../src/policy-evaluator"

// Codex's hook inputs, as `codex-rs/hooks/schema/generated/pre-tool-use.command.input.schema.json` and the tool
// handlers in `codex-rs/core/src/tools` write them.
const toolCall = (tool_name: string, tool_input: unknown, cwd = "/work/app") => ({
  hook_event_name: "PreToolUse",
  cwd,
  tool_name,
  tool_input,
})
const where: CodexHook.Where = { directory: "/work/app", platform: "darwin", servers: [] }

test.each([
  ["Bash", { command: "rm -rf build" }, { action: "shell", resources: ["rm -rf build"] }],
  ["view_image", { path: "shots/a.png" }, { action: "read", resources: ["/work/app/shots/a.png"] }],
  ["request_user_input", { questions: [] }, { action: "question", resources: ["*"] }],
  ["request_user_input_async", { questions: [] }, { action: "question", resources: ["*"] }],
  [
    "request_plugin_install",
    { plugin_id: "linear@openai", suggest_reason: "x" },
    { action: "plugin.use", resources: ["linear@openai"] },
  ],
  [
    "request_plugin_install",
    { tool_id: "connector_gmail", tool_type: "connector", suggest_reason: "x" },
    { action: "mcp.use", resources: ["connector_gmail"] },
  ],
  ["spawn_agent", { message: "find", agent_type: " Reviewer " }, { action: "subagent", resources: ["reviewer"] }],
  ["spawn_agent", { message: "find", agent_type: "  " }, { action: "subagent", resources: ["general"] }],
  ["spawn_agent", { message: "find", agent_type: "Explorer" }, { action: "subagent", resources: ["explorer"] }],
  ["spawn_agent", { message: "find" }, { action: "subagent", resources: ["general"] }],
  ["read_mcp_resource", { server: "github", uri: "repo://x" }, { action: "mcp.use", resources: ["github"] }],
  ["list_mcp_resources", { server: "github" }, { action: "mcp.use", resources: ["github"] }],
  ["update_plan", { plan: [] }, { action: "update_plan", resources: ["*"] }],
])("checks Codex's %s as OpenCode's matching permission", (tool, input, expected) => {
  expect(CodexHook.checks(toolCall(tool, input), where)).toEqual([{ ...expected, directory: "/work/app" }])
})

test("checks a resource listing that names no server against every server, the member's own included", () => {
  const checks = CodexHook.checks(toolCall("list_mcp_resource_templates", {}), { ...where, servers: ["github"] })

  expect(checks).toEqual([{ action: "mcp.use", resources: ["github", "*"], directory: "/work/app" }])
})

test("checks a command run in another directory from the session's, so leaving the project needs permission", () => {
  expect(CodexHook.checks(toolCall("Bash", { command: "cat passwd" }, "/etc"), where)).toEqual([
    { action: "shell", resources: ["cat passwd"], directory: "/work/app", path: "/etc" },
  ])
})

test("scans commands as PowerShell on Windows, where Codex runs them in it", () => {
  expect(CodexHook.checks(toolCall("Bash", { command: "ls" }), { ...where, platform: "win32" })[0]?.shell).toBe("pwsh")
})

test("checks every file a patch adds, updates, deletes or moves to as an edit", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: src/new.ts",
    "+export {}",
    "*** Update File: src/old.ts",
    "*** Move to: src/moved.ts",
    "@@",
    "-a",
    "+b",
    "*** Delete File: /etc/hosts",
    "*** End Patch",
  ].join("\n")

  expect(CodexHook.checks(toolCall("apply_patch", { command: patch }), where)).toEqual([
    {
      action: "edit",
      resources: ["/work/app/src/new.ts", "/work/app/src/old.ts", "/work/app/src/moved.ts", "/etc/hosts"],
      directory: "/work/app",
    },
  ])
})

test("checks a header written without its spaces, or as a move with both ends, which can only add a check", () => {
  const patch = "*** Begin Patch\n***Update File:src/a.ts\n@@\n-a\n+b\n*** Move File: b.ts -> /etc/b\n*** End Patch"

  expect(CodexHook.checks(toolCall("apply_patch", { command: patch }), where)).toEqual([
    { action: "edit", resources: ["/work/app/src/a.ts", "/work/app/b.ts", "/etc/b"], directory: "/work/app" },
  ])
})

test("checks the files a patch piped to apply_patch in a command edits, beside the command itself", () => {
  const command = "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: .env\n@@\n-A=1\n+A=2\n*** End Patch\nEOF"

  expect(CodexHook.checks(toolCall("Bash", { command }), where)).toEqual([
    { action: "shell", resources: [command], directory: "/work/app" },
    { action: "edit", resources: ["/work/app/.env"], directory: "/work/app" },
  ])
})

test("refuses a patch that names no file, so it can't edit unchecked", () => {
  expect(() => CodexHook.checks(toolCall("apply_patch", { command: "rm -rf /" }), where)).toThrow(CodexHook.Unreadable)
})

test("refuses a tool call whose arguments Codex couldn't parse", () => {
  expect(() => CodexHook.checks(toolCall("Bash", "not json"), where)).toThrow(CodexHook.Unreadable)
})

test("names a workspace MCP server's tool by the server, though Codex writes its - as _", () => {
  const checks = CodexHook.checks(toolCall("mcp__linear_app__create_issue", { title: "x" }), {
    ...where,
    servers: ["linear-app"],
  })

  expect(checks).toEqual([
    { action: "mcp.use", resources: ["linear-app"], directory: "/work/app" },
    { action: "linear-app_create_issue", resources: ["*"], folded: true, directory: "/work/app" },
  ])
})

test("splits another MCP server's tool at the first __, matching - and _ alike", () => {
  expect(CodexHook.checks(toolCall("mcp__notes__search_all", {}), where)).toEqual([
    { action: "mcp.use", resources: ["notes"], folded: true, directory: "/work/app" },
    { action: "notes_search_all", resources: ["*"], folded: true, directory: "/work/app" },
  ])
})

test("checks a tool name Codex shortened with a hash against every rule on the server's tools", () => {
  const checks = CodexHook.checks(toolCall("mcp__github__create_pull_request_review_a1b2c3d4e5f6", {}), {
    ...where,
    servers: ["github"],
  })

  expect(checks[1]).toEqual({
    action: "github_",
    resources: ["*"],
    truncated: true,
    folded: true,
    directory: "/work/app",
  })
})

test("denies a shortened tool of a server Codex wrote with _ for -, by the server's rules", async () => {
  const workspace = {
    organization: "Acme",
    policies: [{ action: "tool.use" as const, resource: "my-docs_delete-page:*", effect: "deny" as const }],
  }
  const checks = CodexHook.checks(toolCall("mcp__my_docs__delete_every_page_in_space_a1b2c3d4e5f6", {}), where)

  const decisions = await Effect.runPromise(Effect.forEach(checks, (check) => PolicyEvaluator.check(workspace, check)))

  expect(decisions.map((decision) => decision.effect)).toEqual(["allow", "deny"])
})

test("checks the skills a prompt mentions, but not environment variables", () => {
  const event = {
    hook_event_name: "UserPromptSubmit",
    cwd: "/work/app",
    prompt: "use $deploy and [$review](/home/ada/.codex/skills/review/SKILL.md) with $HOME and $API_KEY",
  }

  expect(CodexHook.checks(event, where)).toEqual([
    { action: "skill", resources: ["deploy", "review"], directory: "/work/app" },
  ])
})

test("checks a skill a prompt links by path though its name is in capitals", () => {
  const event = { hook_event_name: "UserPromptSubmit", prompt: "run [$DEPLOY](skill://DEPLOY/SKILL.md)" }

  expect(CodexHook.checks(event, where)).toEqual([{ action: "skill", resources: ["DEPLOY"], directory: "/work/app" }])
})

test("checks the MCP servers and plugins a prompt links as mcp.use and plugin.use", () => {
  const event = {
    hook_event_name: "UserPromptSubmit",
    prompt: "ask [$linear](mcp://linear) and [$sheets](plugin://sheets@openai?app=x)",
  }

  expect(CodexHook.checks(event, where)).toEqual([
    { action: "mcp.use", resources: ["linear"], directory: "/work/app" },
    { action: "plugin.use", resources: ["sheets@openai"], directory: "/work/app" },
  ])
})

test("checks nothing for an environment variable Codex never reads as a skill, in any case", () => {
  expect(CodexHook.checks({ hook_event_name: "UserPromptSubmit", prompt: "echo $xdg_config_home" }, where)).toEqual([])
})

test("checks nothing for a prompt that mentions no skill", () => {
  expect(CodexHook.checks({ hook_event_name: "UserPromptSubmit", prompt: "fix $PATH" }, where)).toEqual([])
})

test("checks setup's console_watch tools as OpenCode's built-in watch tools, which no mcp.use rule covers", () => {
  expect(
    CodexHook.checks(toolCall("mcp__console_watch__watch", { target: "acme/app#7" }), { ...where, watchServer: true }),
  ).toEqual([{ action: "console_watch_watch", resources: ["*"], directory: "/work/app" }])
})

test("checks a console_watch server the member added themselves as any other MCP server", () => {
  expect(CodexHook.checks(toolCall("mcp__console_watch__watch", {}), where)).toEqual([
    { action: "mcp.use", resources: ["console_watch"], folded: true, directory: "/work/app" },
    { action: "console_watch_watch", resources: ["*"], folded: true, directory: "/work/app" },
  ])
})
