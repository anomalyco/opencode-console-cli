import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ConfigPolicy } from "@opencode/schema/config/policy"
import { Effect, Option } from "effect"
import { HermesHook } from "../src/hermes-hook"
import { PolicyEvaluator } from "../src/policy-evaluator"

// What setup's Hermes plugin pipes to `hook hermes` for a tool call: Hermes's tool name and arguments
// (NousResearch/hermes-agent `tools/*.py` schemas) and the session's working directory.
const toolCall = (tool_name: string, tool_input: unknown) =>
  ({ hook_event_name: "pre_tool_call", tool_name, tool_input, cwd: "/work/app" }) as const
const turn = (user_message: unknown) => ({ hook_event_name: "pre_llm_call", user_message, cwd: "/work/app" }) as const
const where: HermesHook.Where = { directory: "/work/app", servers: [], home: "/home/ada" }
const at = (input: Partial<PolicyEvaluator.Input> & { action: string; resources: readonly string[] }) => ({
  directory: "/work/app",
  ...input,
})

/** Decides a tool call or turn the way `hook hermes` does, against the given policy statements. */
const decide = (event: HermesHook.Event, ...denied: string[]) =>
  Effect.runPromise(
    Effect.forEach(HermesHook.checks(event, where), (input) =>
      PolicyEvaluator.check({ organization: "Acme", policies: denied.map(deny) }, input),
    ),
  ).then((decisions) => decisions.find((decision) => decision.effect === "deny") ?? { effect: "allow" })
const deny = (resource: string): ConfigPolicy.Info => ({ action: "tool.use", effect: "deny", resource })

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
/** A skills folder holding `files` (path → content), as Hermes lays skills out. */
function skillsFolder(files: Record<string, string>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-hermes-skills-"))
  roots.push(root)
  Object.entries(files).forEach(([file, content]) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), content)
  })
  return root
}

test.each([
  ["read_file", { path: "src/a.ts" }, [at({ action: "read", resources: ["/work/app/src/a.ts"] })]],
  ["write_file", { path: "src/a.ts", content: "x" }, [at({ action: "edit", resources: ["/work/app/src/a.ts"] })]],
  [
    "patch",
    { path: "src/a.ts", old_string: "a", new_string: "b" },
    [at({ action: "edit", resources: ["/work/app/src/a.ts"] })],
  ],
  [
    "search_files",
    { pattern: "*.ts", target: "files" },
    [at({ action: "glob", resources: ["*.ts"], path: "/work/app" })],
  ],
  [
    "search_files",
    { pattern: "TODO", path: "../other" },
    [at({ action: "grep", resources: ["TODO"], path: "/work/other" })],
  ],
  ["web_search", { query: "effect schema" }, [at({ action: "websearch", resources: ["effect schema"] })]],
  [
    "web_extract",
    { urls: ["https://a.test", "https://b.test"] },
    [at({ action: "webfetch", resources: ["https://a.test", "https://b.test"] })],
  ],
  [
    "vision_analyze",
    { image_url: "https://a.test/x.png", question: "?" },
    [at({ action: "webfetch", resources: ["https://a.test/x.png"] })],
  ],
  [
    "vision_analyze",
    { image_url: "shots/x.png", question: "?" },
    [at({ action: "read", resources: ["/work/app/shots/x.png"] })],
  ],
  ["skill_view", { name: "deploy" }, [at({ action: "skill", resources: ["deploy"] })]],
  [
    "delegate_task",
    { tasks: [{ goal: "a", role: " Reviewer " }, { goal: "b" }] },
    [at({ action: "subagent", resources: ["reviewer", "general"] })],
  ],
  ["clarify", { questions: [] }, [at({ action: "question", resources: ["*"] })]],
  ["memory", { action: "add" }, [at({ action: "memory", resources: ["*"] })]],
])("checks Hermes's %s as OpenCode's matching permission", (tool, input, expected) => {
  expect(HermesHook.checks(toolCall(tool, input), where)).toEqual(expected)
})

test("checks a command run in its own workdir from there, so leaving the project needs permission", () => {
  expect(HermesHook.checks(toolCall("terminal", { command: "cat passwd", workdir: "/etc" }), where)).toEqual([
    at({ action: "shell", resources: ["cat passwd"], path: "/etc" }),
  ])
})

test("blocks a denied command, even inside a compound one", async () => {
  expect(await decide(toolCall("terminal", { command: "echo hi && rm -rf ./probe" }), "shell:rm *")).toEqual({
    effect: "deny",
    message: "Blocked by Acme's policy",
  })
  expect(await decide(toolCall("terminal", { command: "ls" }), "shell:rm *")).toEqual({ effect: "allow" })
})

test("blocks code Hermes runs where no scanner reads it while any rule could deny a command or a file", async () => {
  const code = { code: "import os; os.system('rm -rf ./probe')" }

  expect(await decide(toolCall("execute_code", code), "shell:rm *")).toEqual({
    effect: "deny",
    message: "Blocked by Acme's policy",
  })
  expect(await decide(toolCall("execute_code", code), "read:.env")).toEqual({
    effect: "deny",
    message: "Blocked by Acme's policy",
  })
  expect(await decide(toolCall("execute_code", code))).toEqual({ effect: "allow" })
})

test("checks reading a file in a skill's folder as running that skill, by the name its SKILL.md gives", () => {
  const root = skillsFolder({
    "creative/humanize-text/SKILL.md": "---\nname: humanizer\n---\nBody",
    "creative/humanize-text/x.py": "",
  })

  expect(
    HermesHook.checks(toolCall("read_file", { path: path.join(root, "creative/humanize-text/x.py") }), {
      ...where,
      skills: [root],
    }),
  ).toEqual([at({ action: "skill", resources: ["humanizer"] })])
})

test("reads a file in a skills folder that belongs to no skill as a file", () => {
  const root = skillsFolder({ "notes.md": "" })

  expect(
    HermesHook.checks(toolCall("read_file", { path: path.join(root, "notes.md") }), { ...where, skills: [root] }),
  ).toEqual([at({ action: "read", resources: [path.join(root, "notes.md")] })])
})

test("reads ~ as the home Hermes uses, so a rule on a home path holds", async () => {
  expect(HermesHook.checks(toolCall("read_file", { path: "~/.ssh/id_ed25519" }), where)).toEqual([
    at({ action: "read", resources: ["/home/ada/.ssh/id_ed25519"] }),
  ])
  expect(() => HermesHook.checks(toolCall("read_file", { path: "~bob/.ssh/id_ed25519" }), where)).toThrow(
    HermesHook.Unreadable,
  )
})

test("resolves a relative path where the task's file tools and terminal are after a cd", () => {
  const moved = { ...where, base: "/work/app/sub", shell: "/tmp/build" }

  expect(HermesHook.checks(toolCall("read_file", { path: "secret.txt" }), moved)).toEqual([
    at({ action: "read", resources: ["/work/app/sub/secret.txt"] }),
  ])
  expect(HermesHook.checks(toolCall("terminal", { command: "rm -rf out" }), moved)).toEqual([
    at({ action: "shell", resources: ["rm -rf out"], path: "/tmp/build" }),
  ])
})

test("reads a file:// image as its file, a data: image as nothing to check, and a URL as a fetch", () => {
  expect(
    HermesHook.checks(toolCall("vision_analyze", { image_url: "file:///etc/shadow", question: "?" }), where),
  ).toEqual([at({ action: "read", resources: ["/etc/shadow"] })])
  expect(
    HermesHook.checks(toolCall("video_analyze", { video_url: "data:video/mp4;base64,AA", question: "?" }), where),
  ).toEqual([])
  expect(
    HermesHook.checks(toolCall("video_analyze", { video_url: "ftp://a.test/v.mp4", question: "?" }), where),
  ).toEqual([at({ action: "webfetch", resources: ["ftp://a.test/v.mp4"] })])
})

test("checks what desktop_preview opens as Hermes completes it: a bare domain or localhost is fetched, a file URL read", () => {
  const opened = (url: string) => HermesHook.checks(toolCall("desktop_preview", { action: "open", url }), where)[0]

  expect([
    opened("www.example.com"),
    opened("localhost:3000/x"),
    opened("file:///etc/hosts"),
    opened("~/site/index.html"),
  ]).toEqual([
    at({ action: "webfetch", resources: ["https://www.example.com"] }),
    at({ action: "webfetch", resources: ["http://localhost:3000/x"] }),
    at({ action: "read", resources: ["/etc/hosts"] }),
    at({ action: "read", resources: ["/home/ada/site/index.html"] }),
  ])
})

test("checks every file a V4A patch names however Hermes spells its headers, both ends of a move, and its path", () => {
  const patch =
    "*** Begin Patch\n***Update File:src/a.ts\n@@\n-a\n+b\n*** Move File: old.ts -> /etc/moved\n*** End Patch"

  expect(HermesHook.checks(toolCall("patch", { mode: "patch", path: "src/b.ts", patch }), where)).toEqual([
    at({ action: "edit", resources: ["/work/app/src/b.ts", "/work/app/src/a.ts", "/work/app/old.ts", "/etc/moved"] }),
  ])
})

test("checks a hosted connector's tool, and every target manage_connections names, as the app's mcp.use", () => {
  expect(HermesHook.checks(toolCall("connectors__gmail__SEND_EMAIL", {}), where)).toEqual([
    at({ action: "mcp.use", resources: ["gmail"], folded: true }),
    at({ action: "gmail_SEND_EMAIL", resources: ["*"], folded: true }),
  ])
  expect(
    HermesHook.checks(
      toolCall("manage_connections", { action: "install", connectors: [{ name: "Linear", mcp: true }, "notion"] }),
      where,
    )[0],
  ).toEqual(at({ action: "mcp.use", resources: ["linear", "notion"], folded: true }))
})

test("checks a browser driven over CDP as a fetch of where it navigates, and a read of the files it uploads", () => {
  const navigate = HermesHook.checks(
    toolCall("browser_cdp", { method: "Page.navigate", params: { url: "https://a.test" } }),
    where,
  )
  const upload = HermesHook.checks(
    toolCall("browser_cdp", { method: "DOM.setFileInputFiles", params: { files: ["~/.aws/credentials"] } }),
    where,
  )

  expect(navigate[0]).toEqual(at({ action: "webfetch", resources: ["https://a.test"] }))
  expect(upload).toContainEqual(at({ action: "read", resources: ["/home/ada/.aws/credentials"] }))
})

test("blocks a browser that can fetch anything while any rule could deny a fetch", async () => {
  expect(await decide(toolCall("drive_preview", { action: "click", ref: "a" }), "webfetch:*evil.test*")).toEqual({
    effect: "deny",
    message: "Blocked by Acme's policy",
  })
  expect(await decide(toolCall("browser_exec", { code: "goto()" }), "webfetch:*evil.test*")).toEqual({
    effect: "deny",
    message: "Blocked by Acme's policy",
  })
})

test("checks the skills, scripts and monitors a cron job runs, and the skills a kanban task loads", () => {
  const cron = HermesHook.checks(
    toolCall("cronjob_manage", {
      action: "create",
      skill: "deploy",
      monitor: "https://status.test",
      script: "tick.sh",
    }),
    where,
  )

  expect(cron).toContainEqual(at({ action: "skill", resources: ["deploy"] }))
  expect(cron).toContainEqual(at({ action: "webfetch", resources: ["https://status.test"] }))
  expect(cron).toContainEqual(at({ action: "shell", resources: ["tick.sh"], opaque: true }))
  expect(
    HermesHook.checks(toolCall("cronjob_manage", { action: "create", monitor: "watch.py" }), where),
  ).toContainEqual(at({ action: "shell", resources: ["watch.py"], opaque: true }))
  expect(HermesHook.checks(toolCall("kanban_create", { title: "t", skills: ["review"] }), where)[0]).toEqual(
    at({ action: "skill", resources: ["review"] }),
  )
})

test("checks the skills skills.auto_load puts in the system prompt with every turn", () => {
  expect(HermesHook.checks({ ...turn("hi"), loaded_skills: ["triage"] }, where)).toEqual([
    at({ action: "skill", resources: ["triage"] }),
  ])
})

test("splits an MCP tool at the workspace server's name, though Hermes writes its - as _", () => {
  const checks = HermesHook.checks(toolCall("mcp__web_search__web_search_exa", {}), {
    ...where,
    servers: ["web-search"],
  })

  expect(checks).toEqual([
    at({ action: "mcp.use", resources: ["web-search"] }),
    at({ action: "web-search_web_search_exa", resources: ["*"], folded: true }),
  ])
})

test("blocks a clamped MCP tool name while any rule could deny one of its server's tools", async () => {
  const clamped = `mcp__linear__${"a".repeat(42)}_0123abcd`
  expect(clamped).toHaveLength(64)

  expect(await decide(toolCall(clamped, {}), "linear_delete_issue")).toEqual({
    effect: "deny",
    message: "Blocked by Acme's policy",
  })
})

test("refuses a tool call it can't read rather than let it through", () => {
  expect(() => HermesHook.checks(toolCall("terminal", {}), where)).toThrow(HermesHook.Unreadable)
  expect(() => HermesHook.checks(toolCall("web_extract", { urls: [] }), where)).toThrow(HermesHook.Unreadable)
})

test("checks every skill a /skill, stacked or auto-loaded turn loads, from the text Hermes writes into it", () => {
  const typed =
    '[IMPORTANT: The user has invoked the "deploy" skill, indicating they want you to follow its instructions.'
  const stacked =
    '[IMPORTANT: The user has invoked the "/review /ship" stacked skill bundle, loading 2 skills together.]\n\nSkills loaded: review, ship'
  const auto = '[IMPORTANT: The "triage" skill is auto-loaded. Follow its instructions for this session.]'

  expect(HermesHook.checks(turn(`${typed}\n\n${stacked}\n\n${auto}`), where)).toEqual([
    at({ action: "skill", resources: ["deploy", "triage", "review", "ship"] }),
  ])
})

test("reads the skills a multimodal turn loads from its text parts, and a skill's folder it names", () => {
  const root = skillsFolder({ "deploy/SKILL.md": "---\nname: deploy\n---\n" })
  const message = [
    { type: "image_url", image_url: { url: "data:," } },
    { type: "text", text: `[Skill directory: ${path.join(root, "deploy")}]` },
  ]

  expect(HermesHook.promptSkills(message, [root])).toEqual(["deploy"])
})

test("checks nothing for a turn that loads no skill", () => {
  expect(HermesHook.checks(turn("rm -rf everything please"), where)).toEqual([])
})

test("reads only the two hook events the plugin sends", () => {
  expect(Option.isNone(HermesHook.decode(JSON.stringify({ hook_event_name: "post_tool_call" })))).toBe(true)
})
