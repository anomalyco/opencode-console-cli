import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ConfigPolicy } from "@opencode/schema/config/policy"
import { Effect } from "effect"
import { OpenClawHook } from "../src/openclaw-hook"
import { PolicyEvaluator } from "../src/policy-evaluator"

// What setup's OpenClaw plugin pipes to `hook openclaw` from `before_tool_call`: OpenClaw's tool name and parameters
// (docs.openclaw.ai/tools) and the agent's workspace.
const toolCall = (tool_name: string, tool_input: unknown, tool_kind?: string) =>
  ({ hook_event_name: "before_tool_call", tool_name, tool_input, cwd: "/work/app", tool_kind }) as const
const where: OpenClawHook.Where = { directory: "/work/app", servers: ["web_search"], home: "/home/ada" }

/** Decides a tool call the way `hook openclaw` does, against the given denied `tool.use` resources. */
const decide = (event: OpenClawHook.Event, denied: readonly string[], at = where) =>
  Effect.runPromise(
    Effect.forEach(OpenClawHook.checks(event, at), (input) =>
      PolicyEvaluator.check({ organization: "Acme", policies: denied.map(deny) }, input),
    ),
  ).then((decisions) => decisions.find((decision) => decision.effect === "deny")?.effect ?? "allow")
const deny = (resource: string): ConfigPolicy.Info => ({ action: "tool.use", effect: "deny", resource })

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

test("checks exec as a shell command where it runs, and only the command it runs", async () => {
  expect(await decide(toolCall("exec", { command: "rm -rf build" }), ["shell:rm *"])).toBe("deny")
  expect(await decide(toolCall("exec", { command: "ls" }), ["shell:rm *"])).toBe("allow")
  expect(OpenClawHook.checks(toolCall("exec", { command: "ls", workdir: "sub" }), where)[0]).toMatchObject({
    action: "shell",
    path: "/work/app/sub",
  })
})

test("checks Code Mode's exec as code no scanner reads, denied while any shell rule could deny it", async () => {
  expect(await decide(toolCall("exec", { code: "await fs.rm('x')" }, "code_mode_exec"), ["shell:rm *"])).toBe("deny")
})

test("checks reads, writes, edits and patches by the files they name, relative to the agent's workspace", async () => {
  expect(await decide(toolCall("read", { path: ".env" }), ["read:.env"])).toBe("deny")
  expect(await decide(toolCall("write", { path: "src/a.ts", content: "x" }), ["edit:src/*"])).toBe("deny")
  expect(await decide(toolCall("edit", { path: "README.md", edits: [] }), ["edit:src/*"])).toBe("allow")
  const patch = "*** Begin Patch\n*** Update File: src/b.ts\n@@\n-a\n+b\n*** End Patch"
  expect(OpenClawHook.checks(toolCall("apply_patch", { input: patch }), where)).toEqual([
    { action: "edit", resources: ["/work/app/src/b.ts"], directory: "/work/app" },
  ])
})

test("checks reading a file in a skill's folder as loading that skill, and skills_read by name", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-openclaw-skills-"))
  roots.push(root)
  mkdirSync(path.join(root, "deploy"))
  writeFileSync(path.join(root, "deploy", "SKILL.md"), "---\nname: deploy\n---\nShip it.")
  const skills = { ...where, skills: [root] }

  expect(OpenClawHook.checks(toolCall("read", { path: path.join(root, "deploy", "SKILL.md") }), skills)).toEqual([
    { action: "skill", resources: ["deploy"], directory: "/work/app" },
  ])
  expect(OpenClawHook.checks(toolCall("skills_read", { name: "deploy" }), skills)).toEqual([
    { action: "skill", resources: ["deploy"], directory: "/work/app" },
  ])
})

test("checks a workspace MCP server's tool as using that server, as OpenClaw names it <server>__<tool>", () => {
  expect(OpenClawHook.checks(toolCall("web_search__search", { q: "x" }), where)).toEqual([
    { action: "mcp.use", resources: ["web_search"], directory: "/work/app" },
    { action: "web_search_search", resources: ["*"], directory: "/work/app" },
  ])
})

test("checks fetches, searches and other tools by what OpenCode calls them, and anything else by name", async () => {
  expect(await decide(toolCall("web_fetch", { url: "https://evil.test/x" }), ["webfetch:*evil.test*"])).toBe("deny")
  expect(await decide(toolCall("web_search", { query: "x" }), ["websearch:*"])).toBe("deny")
  expect(await decide(toolCall("message", { action: "send" }), ["message:*"])).toBe("deny")
})

test("refuses a call it can't read rather than let it through", () => {
  expect(() => OpenClawHook.checks(toolCall("read", {}), where)).toThrow(OpenClawHook.Unreadable)
  expect(() => OpenClawHook.checks({ hook_event_name: "before_tool_call" }, where)).toThrow(OpenClawHook.Unreadable)
})
